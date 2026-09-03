#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "./agents/loader.js";
import { createRunCancellation, RunCancelledError } from "./cancellation.js";
import { delegate } from "./delegate.js";
import { loadAcceptedProviders } from "./providers.js";
import { MuseProvider } from "./provider/muse.js";
import { ProviderRunError } from "./provider/provider.js";
import { createPrompt } from "./prompt.js";
import { discoverRepository, type Repository } from "./repository.js";
import { createFailedRunResult, createRunResult } from "./run-result.js";
import { resolveTask, TaskSourceError } from "./task.js";

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
  .requiredOption("--provider <provider>", "Provider to use.", parseProvider)
  .option("--task <path>", "Read the task from a UTF-8 file.")
  .allowExcessArguments(false)
  .action(async (taskOrAgent: string | undefined, positionalAgent: string | undefined, options: { task?: string }) => {
    let cancellation: ReturnType<typeof createRunCancellation> | undefined;

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

      const repository = discoverRunRepository();
      let profile;

      try {
        profile = loadAgent(repository.root, agent);
      } catch (error) {
        throw new CliError(errorMessage(error), 2);
      }

      const worktree = join(tmpdir(), `codex-delegate-${randomUUID()}`);
      cancellation = createRunCancellation();
      const result = await delegate({
        onActivity: cancellation.onActivity,
        prompt: createPrompt(profile.instructions, task),
        provider: new MuseProvider(),
        repository,
        signal: cancellation.signal,
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
    }
  });

program.parseAsync().catch((error: unknown) => {
  const runResult = createFailedRunResult(errorMessage(error));

  process.stderr.write(`${runResult.error}\n`);
  process.stdout.write(`${JSON.stringify(runResult)}\n`);
  process.exitCode = exitCodeFor(error);
});
