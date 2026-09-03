import { spawnSync } from "node:child_process";

export type Repository = {
  head: string;
  root: string;
};

type GitResult = {
  status: number;
  stdout: string;
};

function runGit(cwd: string, arguments_: string[]): GitResult {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
  });

  if (result.error !== undefined) {
    throw new Error(`Could not run Git: ${result.error.message}`);
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout.trim(),
  };
}

export function discoverRepository(cwd: string): Repository {
  const rootResult = runGit(cwd, ["rev-parse", "--show-toplevel"]);

  if (rootResult.status !== 0 || rootResult.stdout === "") {
    throw new Error("Run codex-delegate from inside a non-bare Git worktree.");
  }

  const headResult = runGit(rootResult.stdout, ["rev-parse", "--verify", "HEAD^{commit}"]);

  if (headResult.status !== 0 || headResult.stdout === "") {
    throw new Error("The Git repository must have a valid HEAD commit.");
  }

  return {
    head: headResult.stdout,
    root: rootResult.stdout,
  };
}
