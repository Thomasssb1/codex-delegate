#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalModes, type ApprovalMode } from "./approval-mode.js";
import { loadAgent } from "./agents/loader.js";
import { createRunCancellation, RunCancelledError } from "./cancellation.js";
import { ConfigurationError, parseInactivityTimeout, resolveRunConfiguration } from "./config.js";
import { delegate } from "./delegate.js";
import { loadAcceptedProviders } from "./providers.js";
import { MuseProvider } from "./provider/muse.js";
import { ProviderRunError } from "./provider/provider.js";
import { createPrompt } from "./prompt.js";
import { discoverRepository, type Repository } from "./repository.js";
import { createFailedRunResult, createRunResult } from "./run-result.js";
import { resolveTask, TaskSourceError } from "./task.js";
import type { InteractionRequest, InteractionResponse } from "./provider/provider.js";

type Provider = string;

const acceptedProviders = loadAcceptedProviders();

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

function parseProvider(value: string): Provider {
  if (!acceptedProviders.includes(value)) {
    throw new InvalidArgumentError(
      `Unsupported provider: ${value}. Supported providers: ${acceptedProviders.join(", ")}.`,
    );
  }

  return value;
}

function parseApprovalMode(value: string): ApprovalMode {
  if (!approvalModes.includes(value as ApprovalMode)) {
    throw new InvalidArgumentError(`Unsupported approval mode: ${value}. Supported modes: ${approvalModes.join(", ")}.`);
  }

  return value as ApprovalMode;
}

function parseTimeout(value: string): number {
  try {
    return parseInactivityTimeout(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function discoverRunRepository(): Repository {
  try {
    return discoverRepository(process.cwd());
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 5);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function createInteractionResponder() {
  const reader = createInterface({ crlfDelay: Infinity, input: process.stdin });
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
        process.stdout.write(`${JSON.stringify({ interaction, status: "interaction_required" })}\n`);
        return parseInteractionResponse(await nextLine(), interaction);
      } finally {
        finishRequest();
      }
    },
  };
}

function exitCodeFor(error: unknown): number {
  if (error instanceof CliError) {
    return error.exitCode;
  }

  if (error instanceof TaskSourceError) {
    return 2;
  }

  if (error instanceof CommanderError) {
    return error.exitCode;
  }

  return error instanceof RunCancelledError && error.cause === "signal" ? 130 : 4;
}

const program = new Command();
program.exitOverride();

program
  .name("codex-delegate")
  .description("Delegate bounded coding tasks to external agents.")
  .showSuggestionAfterError()
  .showHelpAfterError()
  .command("run [task-or-agent] [agent]")
  .description("Delegate a task to an agent.")
  .option("--provider <provider>", "Override the profile and repository provider.", parseProvider)
  .option("--task <path>", "Read the task from a UTF-8 file.")
  .option("--timeout <duration>", "Abort after this much provider inactivity.", parseTimeout)
  .option("--approval-mode <mode>", "Select alwaysAsk, approveForMe, denyUnmatched, or fullAccess.", parseApprovalMode)
  .option("--allow-all", "Required with approval mode fullAccess.")
  .option("--model <name>", "Ask the provider for a specific model.")
  .allowExcessArguments(false)
  .action(
    async (
      taskOrAgent: string | undefined,
      positionalAgent: string | undefined,
      options: {
        allowAll?: boolean;
        approvalMode?: ApprovalMode;
        model?: string;
        provider?: Provider;
        task?: string;
        timeout?: number;
    },
  ) => {
    let cancellation: ReturnType<typeof createRunCancellation> | undefined;
    let interactions: ReturnType<typeof createInteractionResponder> | undefined;

    try {
      const { agent, task } = resolveTask({
        agent: positionalAgent,
        positional: taskOrAgent,
        stdin: {
          isTTY: process.stdin.isTTY,
          read: () => readFileSync(0),
        },
        taskPath: options.task,
      });
      interactions = createInteractionResponder();

      const repository = discoverRunRepository();
      let profile;

      try {
        profile = loadAgent(repository.root, agent);
      } catch (error) {
        throw new CliError(errorMessage(error), 2);
      }

      let configuration;
      try {
        configuration = resolveRunConfiguration(repository.root, profile, {
          allowAll: options.allowAll,
          approvalMode: options.approvalMode,
          model: options.model,
          provider: options.provider,
          timeoutMs: options.timeout,
        });
      } catch (error) {
        throw new CliError(errorMessage(error), error instanceof ConfigurationError ? 2 : 1);
      }

      const worktree = join(tmpdir(), `codex-delegate-${randomUUID()}`);
      cancellation = createRunCancellation(configuration.inactivityTimeoutMs);
      const result = await delegate({
        onActivity: cancellation.onActivity,
        prompt: createPrompt(profile.instructions, task),
        provider: new MuseProvider(configuration.muse),
        requestInteraction: async (interaction) => {
          cancellation?.pause();
          try {
            if (interactions === undefined) {
              throw new Error("Codex interaction support is unavailable.");
            }

            return await interactions.request(interaction);
          } finally {
            cancellation?.onActivity();
          }
        },
        repository,
        signal: cancellation.signal,
        snapshotLimits: configuration.snapshotLimits,
        worktree,
      });

      process.stderr.write(`Muse completed with ${result.changedFiles.length} changed file(s).\n`);
      const runResult = createRunResult(result);

      process.stdout.write(`${JSON.stringify(runResult)}\n`);
    } catch (error) {
      const runResult = createFailedRunResult(
        errorMessage(error),
        error instanceof ProviderRunError ? error.stderr : undefined,
      );

      process.stderr.write(`${runResult.error}\n`);
      process.stdout.write(`${JSON.stringify(runResult)}\n`);
      process.exitCode = exitCodeFor(error);
    } finally {
      cancellation?.dispose();
      interactions?.close();
    }
    },
  );

program.parseAsync().catch((error: unknown) => {
  const runResult = createFailedRunResult(errorMessage(error));

  process.stderr.write(`${runResult.error}\n`);
  process.stdout.write(`${JSON.stringify(runResult)}\n`);
  process.exitCode = exitCodeFor(error);
});
