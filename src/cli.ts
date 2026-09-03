#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalModes, type ApprovalMode } from "./approval-mode.js";
import { listAgents, loadAgent } from "./agents/loader.js";
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
import { createInteractionResponder } from "./interaction.js";

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

function discoverAgentRepository(): Repository | undefined {
  try {
    return discoverRepository(process.cwd());
  } catch {
    return undefined;
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

  .command("agents")
  .description("List available agents.")
  .action(() => {
    const repository = discoverAgentRepository();
    let agents;

    try {
      agents = listAgents(repository?.root).map(({ description, model, name, source }) => ({ description, model, name, source }));
    } catch (error) {
      throw new CliError(errorMessage(error), 2);
    }

    process.stdout.write(`${JSON.stringify({ agents })}\n`);
  });

program
  .command("run [task-or-agent] [agent]")
  .description("Delegate a task to an agent. Standard input accepts JSON interaction replies.")
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
        taskPath: options.task,
      });
      interactions = createInteractionResponder(process.stdin, process.stdout);

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
            cancellation?.resume();
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
  if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
    return;
  }

  const runResult = createFailedRunResult(errorMessage(error));

  process.stderr.write(`${runResult.error}\n`);
  process.stdout.write(`${JSON.stringify(runResult)}\n`);
  process.exitCode = exitCodeFor(error);
});
