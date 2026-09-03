import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const agentNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type Agent = {
  instructions: string;
  name: string;
  source: "bundled" | "generic" | "project";
};

function readInstructions(path: string | URL): string {
  const instructions = readFileSync(path, "utf8").trim();

  if (instructions === "") {
    throw new Error(`Agent instructions are empty: ${path}`);
  }

  return instructions;
}

export function loadAgent(repositoryRoot: string, name: string): Agent {
  if (!agentNamePattern.test(name)) {
    throw new Error(`Invalid agent name: ${name}`);
  }

  const projectPath = join(repositoryRoot, ".codex-agents", `${name}.md`);

  if (existsSync(projectPath)) {
    return {
      instructions: readInstructions(projectPath),
      name,
      source: "project",
    };
  }

  const bundledPath = new URL(`../../agents/${name}.md`, import.meta.url);

  try {
    return {
      instructions: readInstructions(bundledPath),
      name,
      source: "bundled",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        instructions: `You are acting as the ${name} agent. Complete the task carefully.`,
        name,
        source: "generic",
      };
    }

    throw error;
  }
}
