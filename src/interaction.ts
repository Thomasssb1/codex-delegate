import { createInterface } from "node:readline";
import type { InteractionRequest, InteractionResponse } from "./provider/provider.js";

type Output = {
  write(chunk: string): unknown;
};

function parseInteractionResponse(value: string, interaction: InteractionRequest): InteractionResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Codex must reply with a JSON object.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Codex must reply with a JSON object.");
  }

  if (interaction.kind === "approval") {
    const answer = parsed as { choiceId?: unknown; feedback?: unknown };
    if (typeof answer.choiceId !== "string" || !interaction.choices.some((choice) => choice.choiceId === answer.choiceId)) {
      throw new Error("Codex selected an approval choice Muse did not offer.");
    }
    if (answer.feedback !== undefined && typeof answer.feedback !== "string") {
      throw new Error("Codex approval feedback must be a string.");
    }

    return { ...(answer.feedback === undefined ? {} : { feedback: answer.feedback }), choiceId: answer.choiceId, kind: "approval" };
  }

  const answer = parsed as { answers?: unknown };
  if (!Array.isArray(answer.answers)) {
    throw new Error("Codex input answers must be an array.");
  }

  return {
    answers: answer.answers as Extract<InteractionResponse, { kind: "userInput" }>["answers"],
    kind: "userInput",
  };
}

export function createInteractionResponder(input: NodeJS.ReadableStream, output: Output) {
  const reader = createInterface({ crlfDelay: Infinity, input });
  const lines: string[] = [];
  let inputClosed = false;
  let previousRequest = Promise.resolve();
  let rejectNextLine: ((error: Error) => void) | undefined;
  let resolveNextLine: ((line: string) => void) | undefined;

  reader.on("line", (line) => {
    if (resolveNextLine !== undefined) {
      const resolve = resolveNextLine;
      rejectNextLine = undefined;
      resolveNextLine = undefined;
      resolve(line);
      return;
    }

    lines.push(line);
  });
  reader.on("close", () => {
    inputClosed = true;
    rejectNextLine?.(new Error("Codex closed stdin while Muse was waiting for input."));
    rejectNextLine = undefined;
    resolveNextLine = undefined;
  });

  const nextLine = () => {
    const line = lines.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    if (inputClosed) {
      return Promise.reject(new Error("Codex closed stdin while Muse was waiting for input."));
    }

    return new Promise<string>((resolve, reject) => {
      resolveNextLine = resolve;
      rejectNextLine = reject;
    });
  };

  return {
    close() {
      reader.close();
    },
    async request(interaction: InteractionRequest): Promise<InteractionResponse> {
      const previous = previousRequest;
      let finishRequest: () => void = () => undefined;
      previousRequest = new Promise<void>((resolve) => {
        finishRequest = resolve;
      });
      await previous;

      try {
        output.write(`${JSON.stringify({ interaction, status: "interaction_required" })}\n`);
        return parseInteractionResponse(await nextLine(), interaction);
      } finally {
        finishRequest();
      }
    },
  };
}
