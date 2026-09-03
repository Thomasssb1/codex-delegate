import { readFileSync } from "node:fs";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class TaskSourceError extends Error {}

export type TaskResolution = {
  agent: string;
  task: string;
};

export type TaskSourceInput = {
  agent?: string;
  positional?: string;
  stdin: {
    isTTY?: boolean;
    read(): Buffer;
  };
  taskPath?: string;
};

function decodeTask(bytes: Buffer, source: string): string {
  let task: string;

  try {
    task = textDecoder.decode(bytes);
  } catch {
    throw new TaskSourceError(`The task from ${source} is not valid UTF-8.`);
  }

  if (task.trim() === "") {
    throw new TaskSourceError(`The task from ${source} must be non-empty.`);
  }

  return task;
}

function readTaskFile(path: string): string {
  try {
    return decodeTask(readFileSync(path), `file ${path}`);
  } catch (error) {
    if (error instanceof TaskSourceError) {
      throw error;
    }

    throw new TaskSourceError(`Could not read task file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertAgentName(agent: string): string {
  if (agent.trim() === "") {
    throw new TaskSourceError("The agent name must be non-empty.");
  }

  return agent;
}

export function resolveTask(input: TaskSourceInput): TaskResolution {
  const stdin = input.stdin.isTTY === true ? undefined : input.stdin.read();
  const hasStdinTask = stdin !== undefined && stdin.length > 0;
  const hasTaskFile = input.taskPath !== undefined;

  if (hasTaskFile || hasStdinTask) {
    if (input.agent !== undefined) {
      throw new TaskSourceError("Use only one positional agent name with --task or stdin task input.");
    }

    if (hasTaskFile && hasStdinTask) {
      throw new TaskSourceError("Supply a task from either --task or stdin, not both.");
    }

    const agent = assertAgentName(input.positional ?? "test-writer");
    const task = hasTaskFile
      ? readTaskFile(input.taskPath as string)
      : decodeTask(stdin as Buffer, "stdin");

    return { agent, task };
  }

  if (input.positional === undefined) {
    throw new TaskSourceError("Supply a task as a positional argument, --task file, or stdin.");
  }

  return {
    agent: assertAgentName(input.agent ?? "test-writer"),
    task: decodeTask(Buffer.from(input.positional), "the positional argument"),
  };
}
