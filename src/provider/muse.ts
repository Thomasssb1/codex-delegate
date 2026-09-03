import { readSessionDurability, Session, spawnMspConnection, type ApprovalDecisionInput, type SpawnedMspConnection } from "@muse-code/sdk";
import { toMuseApprovalMode, type ApprovalMode } from "../approval-mode.js";
import { rejectCancelledRun, RunCancelledError } from "../cancellation.js";
import { ProviderRunError, type Provider, type ProviderRequest, type ProviderResult } from "./provider.js";

export type MuseProviderOptions = {
  approvalMode: ApprovalMode;
  binary: string;
  model?: string;
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Muse run was aborted.");
}

function waitForConnection(
  connectionPromise: Promise<SpawnedMspConnection>,
  signal: AbortSignal,
): Promise<SpawnedMspConnection> {
  if (signal.aborted) {
    void connectionPromise.then((connection) => connection.close()).catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }

  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));

    signal.addEventListener("abort", abort, { once: true });
    connectionPromise.then(
      (connection) => {
        signal.removeEventListener("abort", abort);

        if (signal.aborted) {
          void connection.close().catch(() => undefined);
          reject(abortReason(signal));
          return;
        }

        resolve(connection);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function chooseDenial(choices: readonly { acceptsFeedback?: boolean; choiceId: string; decision: string }[]): ApprovalDecisionInput {
  const denial = choices.find((choice) => choice.decision === "denied" || choice.decision === "deniedPolicyAmendment");

  if (denial === undefined) {
    throw new Error("Muse requested approval without offering a denial choice.");
  }

  return {
    choiceId: denial.choiceId,
    ...(denial.acceptsFeedback === true ? { feedback: "codex-delegate runs headlessly and cannot approve this action." } : {}),
  };
}

function sessionIdFrom(result: Record<string, unknown>): string {
  const session = result.session;

  if (typeof session !== "object" || session === null || typeof (session as { sessionId?: unknown }).sessionId !== "string") {
    throw new Error("Muse returned an invalid session/start response.");
  }

  return (session as { sessionId: string }).sessionId;
}

export class MuseProvider implements Provider {
  constructor(
    private readonly options: MuseProviderOptions = {
      approvalMode: "denyUnmatched",
      binary: "muse",
    },
  ) {}

  async run(request: ProviderRequest): Promise<ProviderResult> {
    const stderr: string[] = [];

    try {
      return await this.runTurn(request, stderr);
    } catch (error) {
      if (error instanceof RunCancelledError) {
        throw error;
      }

      throw new ProviderRunError(error instanceof Error ? error.message : String(error), stderr.join(""), { cause: error });
    }
  }

  private async runTurn(request: ProviderRequest, stderr: string[]): Promise<ProviderResult> {
    rejectCancelledRun(request.signal);

    const handshake = spawnMspConnection({
      args: ["serve"],
      command: this.options.binary,
      cwd: request.workspaceRoot,
      env: process.env,
      onStderr: (chunk) => {
        stderr.push(chunk);
        request.onActivity?.();
      },
    });
    const client = await waitForConnection(
      handshake.initialize({
        clientInfo: {
          name: "codex_delegate",
          version: "0.1.0",
        },
      }),
      request.signal,
    );

    let closePromise: Promise<unknown> | undefined;
    const closeClient = () => {
      closePromise ??= client.close();
      return closePromise;
    };
    const abort = () => {
      void closeClient();
    };

    request.signal.addEventListener("abort", abort, { once: true });
    let providerResult: ProviderResult | undefined;
    let closeError: unknown;

    try {
      rejectCancelledRun(request.signal);
      const sessionId = client.connection.mintCommandId();
      const session = new Session({
        connection: client.connection,
        durability: readSessionDurability(client.initializeResult),
        sessionId,
      });
      let interactionError: Error | undefined;
      let rejectInteraction: (error: Error) => void = () => undefined;
      const interactionFailure = new Promise<never>((_resolve, reject) => {
        rejectInteraction = reject;
      });
      void interactionFailure.catch(() => undefined);
      const failInteraction = (error: Error) => {
        if (interactionError !== undefined) {
          return;
        }

        interactionError = error;
        rejectInteraction(error);
        void closeClient();
      };
      const cancelledInputs = new Set<string>();

      session.onApproval((approval) => {
        request.onActivity?.();

        try {
          return chooseDenial(approval.availableChoices);
        } catch (error) {
          const approvalError = error instanceof Error ? error : new Error(String(error));
          failInteraction(approvalError);
          throw approvalError;
        }
      });
      session.onApprovalError((failure) => {
        failInteraction(new Error(`Muse approval handling failed: ${failure.kind}.`));
      });
      client.connection.onNotification((notification) => {
        if (notification.params?.sessionId !== sessionId) {
          return;
        }

        request.onActivity?.();
        const applied = session.apply(notification);
        void applied.io.catch((error) => {
          failInteraction(error instanceof Error ? error : new Error(String(error)));
        });

        if (notification.method !== "userInput/requested") {
          return;
        }

        const userInputId = notification.params.userInputId;
        if (typeof userInputId !== "string" || cancelledInputs.has(userInputId)) {
          return;
        }

        cancelledInputs.add(userInputId);
        void client.connection
          .command("userInput/cancel", {
            commandId: client.connection.mintCommandId(),
            reason: "codex-delegate runs headlessly and cannot answer prompts.",
            sessionId,
            userInputId,
          })
          .then(() => request.onActivity?.())
          .catch((error) => {
            failInteraction(error instanceof Error ? error : new Error(String(error)));
          });
      });
      void client.connection.closed.then(() => {
        session.hostExited({ kind: "transportEof" });
      });
      const started = await client.connection.command("session/start", {
        approvalMode: toMuseApprovalMode(this.options.approvalMode),
        modelId: this.options.model,
        sessionId,
        workspaceRoot: request.workspaceRoot,
      });
      if (sessionIdFrom(started) !== sessionId) {
        throw new Error("Muse did not honour the requested session ID.");
      }
      request.onActivity?.();
      const turn = await session.sendUserTurn({
        input: [{ text: request.prompt, type: "text" }],
      });
      request.onActivity?.();
      const responses = new Map<string, string>();

      const collectResponses = async () => {
        for await (const item of turn.items()) {
          request.onActivity?.();
          if (item.kind === "agentMessage" && typeof item.text === "string") {
            responses.set(item.itemId, item.text);
          }
        }
      };

      await Promise.race([collectResponses(), interactionFailure]);
      const outcome = await Promise.race([turn.completed, interactionFailure]);
      request.onActivity?.();

      rejectCancelledRun(request.signal);

      if (outcome.kind !== "completed" || outcome.params.terminal !== "completed") {
        throw new Error("Muse did not complete the turn successfully.");
      }

      providerResult = {
        response: [...responses.values()].join("\n"),
        stderr: stderr.join(""),
      };
    } catch (error) {
      rejectCancelledRun(request.signal);
      throw error;
    } finally {
      request.signal.removeEventListener("abort", abort);

      try {
        await closeClient();
      } catch (error) {
        if (!request.signal.aborted) {
          closeError = error;
        }
      }
    }

    if (closeError !== undefined) {
      throw closeError;
    }

    if (providerResult === undefined) {
      throw new Error("Muse did not return a result.");
    }

    return providerResult;
  }
}
