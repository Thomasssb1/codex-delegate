#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "./agents/loader.js";
import { createRunCancellation, RunCancelledError } from "./cancellation.js";
import { delegate } from "./delegate.js";
import { loadAcceptedProviders } from "./providers.js";
import { MuseProvider } from "./provider/muse.js";
import { createPrompt } from "./prompt.js";
import { discoverRepository, type Repository } from "./repository.js";

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

const program = new Command();

program
  .name("codex-delegate")
  .description("Delegate bounded coding tasks to external agents.")
  .showSuggestionAfterError()
  .showHelpAfterError()
  .command("run <task> [agent]")
  .description("Delegate a task to an agent.")
  .requiredOption("--provider <provider>", "Provider to use.", parseProvider)
  .allowExcessArguments(false)
  .action((task: string, agent = "test-writer") => {
    if (agent.trim() === "" || task.trim() === "") {
      program.error("The agent name and task must be non-empty.");
    }

    const repository = discoverRunRepository();
    let profile;

    try {
      profile = loadAgent(repository.root, agent);
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : String(error), 2);
    }

    const worktree = join(tmpdir(), `codex-delegate-${randomUUID()}`);
    const cancellation = createRunCancellation();

    return delegate({
      prompt: createPrompt(profile.instructions, task),
      provider: new MuseProvider(),
      repository,
      signal: cancellation.signal,
      worktree,
    })
      .then((result) => {
        process.stderr.write(`Muse completed with ${result.changedFiles.length} changed file(s).\n`);
        process.stdout.write(result.response);
        if (result.response !== "" && !result.response.endsWith("\n")) {
          process.stdout.write("\n");
        }
      })
      .finally(() => cancellation.dispose());
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof CliError ? error.exitCode : error instanceof RunCancelledError && error.cause === "signal" ? 130 : 4;
});
