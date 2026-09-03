import { MuseClient } from "@muse-code/sdk";
import type { Provider, ProviderRequest, ProviderResult } from "./provider.js";

export class MuseProvider implements Provider {
  async run(request: ProviderRequest): Promise<ProviderResult> {
    const stderr: string[] = [];
    const client = await MuseClient.spawn({
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

    try {
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

      if (outcome.kind !== "completed" || outcome.params.terminal !== "completed") {
        throw new Error("Muse did not complete the turn successfully.");
      }

      return {
        response: [...responses.values()].join("\n"),
        stderr: stderr.join(""),
      };
    } finally {
      await client.close();
    }
  }
}
