import { MuseClient } from "@muse-code/sdk";
import { rejectCancelledRun, RunCancelledError } from "../cancellation.js";
import { ProviderRunError, type Provider, type ProviderRequest, type ProviderResult } from "./provider.js";

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Muse run was aborted.");
}

function waitForClient(clientPromise: Promise<MuseClient>, signal: AbortSignal): Promise<MuseClient> {
  if (signal.aborted) {
    void clientPromise.then((client) => client.close()).catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }

  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));

    signal.addEventListener("abort", abort, { once: true });
    clientPromise.then(
      (client) => {
        signal.removeEventListener("abort", abort);

        if (signal.aborted) {
          void client.close().catch(() => undefined);
          reject(abortReason(signal));
          return;
        }

        resolve(client);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export class MuseProvider implements Provider {
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

    const clientPromise = MuseClient.spawn({
      args: ["serve"],
      clientInfo: {
        name: "codex_delegate",
        version: "0.1.0",
      },
      cwd: request.workspaceRoot,
      env: process.env,
      museBin: "muse",
      onStderr: (chunk) => stderr.push(chunk),
    });
    const client = await waitForClient(clientPromise, request.signal);

    let closePromise: Promise<void> | undefined;
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
      const session = await client.startSession({
        approvalMode: "denyUnmatched",
        workspaceRoot: request.workspaceRoot,
      });
      const turn = await session.sendUserTurn({
        input: [{ text: request.prompt, type: "text" }],
      });
      const responses = new Map<string, string>();

      for await (const item of turn.items()) {
        if (item.kind === "agentMessage" && typeof item.text === "string") {
          responses.set(item.itemId, item.text);
        }
      }

      const outcome = await turn.completed;

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
