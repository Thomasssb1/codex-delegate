#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { loadAcceptedProviders } from "./providers.js";

type Provider = string;

const acceptedProviders = loadAcceptedProviders();

function parseProvider(value: string): Provider {
  if (!acceptedProviders.includes(value)) {
    throw new InvalidArgumentError(
      `Unsupported provider: ${value}. Supported providers: ${acceptedProviders.join(", ")}.`,
    );
  }

  return value;
}

const program = new Command();

program
  .name("codex-delegate")
  .description("Delegate bounded coding tasks to external agents.")
  .showSuggestionAfterError()
  .showHelpAfterError()
  .command("run <agent> <task>")
  .description("Delegate a task to an agent.")
  .requiredOption("--provider <provider>", "Provider to use.", parseProvider)
  .allowExcessArguments(false)
  .action((agent: string, task: string, options: { provider: Provider }) => {
    if (agent.trim() === "" || task.trim() === "") {
      program.error("The agent name and task must be non-empty.");
    }

    console.log(`Run requested for ${agent} with provider ${options.provider}.`);
    console.log(`Task: ${task}`);
  });

program.parse();
