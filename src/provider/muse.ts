import { readSessionDurability, Session, spawnMspConnection, type SpawnedMspConnection } from "@muse-code/sdk";
import { toMuseApprovalMode, type ApprovalMode } from "../approval-mode.js";
import { rejectCancelledRun, RunCancelledError } from "../cancellation.js";
import {
  ProviderRunError,
  type ApprovalRequest,
  type InteractionRequest,
  type InteractionResponse,
  type Provider,
  type ProviderRequest,
  type ProviderResult,
  type UserInputRequest,
} from "./provider.js";

export type MuseProviderOptions = {
  approvalMode: ApprovalMode;
  binary: string;
  model?: string;
};

type MuseTurnOutcome = {
  kind: string;
  params?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function museFailureMessage(outcome: MuseTurnOutcome): string {
  if (outcome.kind === "completed" && isRecord(outcome.params) && outcome.params.terminal === "failed") {
    const failure = outcome.params.error;
    if (isRecord(failure) && typeof failure.kind === "string" && typeof failure.message === "string") {
      return `Muse run failed (${failure.kind}): ${failure.message}`;
    }

    if (typeof outcome.params.reason === "string") {
      return `Muse did not complete the turn successfully: ${outcome.params.reason}`;
    }
  }

  return "Muse did not complete the turn successfully.";
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Muse run was aborted.");
}

function waitForConnection(connectionPromise: Promise<SpawnedMspConnection>, signal: AbortSignal): Promise<SpawnedMspConnection> {
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

function sessionIdFrom(result: Record<string, unknown>): string {
  const session = result.session;

  if (typeof session !== "object" || session === null || typeof (session as { sessionId?: unknown }).sessionId !== "string") {
    throw new Error("Muse returned an invalid session response.");
  }

  return (session as { sessionId: string }).sessionId;
}

function toApprovalRequest(value: {
  approvalId: string;
  availableChoices: readonly { acceptsFeedback?: boolean; choiceId: string; decision: string; label: string }[];
  currentRequirementId: { approvalId: string; sourceIndex: number };
  toolName: string;
  turnId: string;
}): ApprovalRequest {
  return {
    approvalId: value.approvalId,
    choices: value.availableChoices.map((choice) => ({
      ...(choice.acceptsFeedback === true ? { acceptsFeedback: true } : {}),
      choiceId: choice.choiceId,
      decision: choice.decision,
      label: choice.label,
    })),
    kind: "approval",
    requirementId: value.currentRequirementId,
    toolName: value.toolName,
    turnId: value.turnId,
  };
}

function toUserInputRequest(value: {
  questions: readonly {
    header: string;
    id: string;
    options: readonly { description?: string; label: string }[];
    question: string;
    selection: { maxSelections?: number; minSelections?: number; mode: "multiple" | "single" };
  }[];
  toolName: string;
  turnId: string;
  userInputId: string;
}): UserInputRequest {
  return {
    kind: "userInput",
    questions: value.questions.map((question) => ({
      header: question.header,
      id: question.id,
      options: question.options.map((option) => ({
        ...(option.description === undefined ? {} : { description: option.description }),
        label: option.label,
      })),
      question: question.question,
      selection: question.selection,
    })),
    toolName: value.toolName,
    turnId: value.turnId,
    userInputId: value.userInputId,
  };
}

function approvalResponse(request: ApprovalRequest, response: InteractionResponse): Extract<InteractionResponse, { kind: "approval" }> {
  if (response.kind !== "approval" || !request.choices.some((choice) => choice.choiceId === response.choiceId)) {
    throw new Error("The response does not match the pending Muse approval request.");
  }

  return response;
}

function userInputResponse(response: InteractionResponse): Extract<InteractionResponse, { kind: "userInput" }> {
  if (response.kind !== "userInput") {
    throw new Error("The response does not match the pending Muse input request.");
  }

  return response;
}

export class MuseProvider implements Provider {
  constructor(
    private readonly options: MuseProviderOptions = {
      approvalMode: "approveForMe",
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

      rejectCancelledRun(request.signal);
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
      handshake.initialize({ clientInfo: { name: "codex_delegate", version: "0.1.0" } }),
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
      const askCodex = async (interaction: InteractionRequest): Promise<InteractionResponse> => {
        if (request.requestInteraction === undefined) {
          throw new Error("Muse requested interaction, but the caller cannot respond.");
        }

        request.onActivity?.();
        return request.requestInteraction(interaction);
      };

      session.onApproval(async (approval) => {
        try {
          const interaction = toApprovalRequest(approval);
          const response = approvalResponse(interaction, await askCodex(interaction));
          request.onActivity?.();
          return {
            choiceId: response.choiceId,
            ...(response.feedback === undefined ? {} : { feedback: response.feedback }),
          };
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

        const input = toUserInputRequest(notification.params as Parameters<typeof toUserInputRequest>[0]);
        void askCodex(input)
          .then((response) => client.connection.command("userInput/answer", {
            answers: userInputResponse(response).answers,
            sessionId,
            userInputId: input.userInputId,
          }))
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

      const turn = await session.sendUserTurn({ input: [{ text: request.prompt, type: "text" }] });
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
      if (outcome.kind !== "completed" || outcome.params.terminal !== "completed") {
        throw new Error(museFailureMessage(outcome));
      }

      providerResult = { response: [...responses.values()].join("\n"), stderr: stderr.join("") };
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

    rejectCancelledRun(request.signal);
    if (closeError !== undefined) {
      throw closeError;
    }
    if (providerResult === undefined) {
      throw new Error("Muse did not return a result.");
    }

    return providerResult;
  }
}
