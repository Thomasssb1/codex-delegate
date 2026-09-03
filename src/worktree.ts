import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Repository } from "./repository.js";

export type WorkerSnapshot = {
  baseline: string;
  worktree: string;
};

function runGit(cwd: string, arguments_: string[], input?: Buffer): Buffer {
  const result = spawnSync("git", arguments_, { cwd, input });

  if (result.error !== undefined) {
    throw new Error(`Could not run Git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Git command failed: git ${arguments_.join(" ")}`);
  }

  return result.stdout;
}

function listUntrackedFiles(repository: Repository): string[] {
  const output = runGit(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"]);

  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
}

function resolveRepositoryPath(root: string, path: string): string {
  const absolutePath = resolve(root, path);
  const pathFromRoot = relative(root, absolutePath);

  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Git returned an unsafe untracked path: ${path}`);
  }

  return absolutePath;
}

function copyUntrackedFile(repository: Repository, worktree: string, path: string): void {
  const sourcePath = resolveRepositoryPath(repository.root, path);
  const destinationPath = resolveRepositoryPath(worktree, path);
  const sourceStat = lstatSync(sourcePath);

  mkdirSync(dirname(destinationPath), { recursive: true });

  if (sourceStat.isSymbolicLink()) {
    symlinkSync(readlinkSync(sourcePath), destinationPath);
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported untracked file type: ${path}`);
  }

  copyFileSync(sourcePath, destinationPath);
  chmodSync(destinationPath, sourceStat.mode);
}

function removeFailedWorktree(repository: Repository, worktree: string): void {
  spawnSync("git", ["worktree", "unlock", worktree], { cwd: repository.root });
  spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repository.root });
}

export function collectWorktreeChanges(worktree: string, baseline: string): {
  changedFiles: string[];
  patch: Buffer;
} {
  runGit(worktree, ["add", "--all"]);

  const changedFiles = runGit(worktree, ["diff", "--cached", "--name-only", "-z", baseline])
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "");
  const patch = runGit(worktree, ["diff", "--cached", "--binary", baseline]);

  return { changedFiles, patch };
}

export function createSeededWorktree(repository: Repository, worktree: string): WorkerSnapshot {
  if (existsSync(worktree)) {
    throw new Error(`The worktree path already exists: ${worktree}`);
  }

  const trackedChanges = runGit(repository.root, ["diff", "--binary", repository.head]);
  const untrackedFiles = listUntrackedFiles(repository);
  runGit(repository.root, [
    "worktree",
    "add",
    "--detach",
    "--lock",
    "--reason",
    "codex-delegate run",
    worktree,
    repository.head,
  ]);

  try {
    if (trackedChanges.length > 0) {
      runGit(worktree, ["apply", "--binary"], trackedChanges);
    }

    for (const path of untrackedFiles) {
      copyUntrackedFile(repository, worktree, path);
    }

    runGit(worktree, ["add", "--all"]);
    const hooksPath = mkdtempSync(join(worktree, ".codex-delegate-hooks-"));

    try {
      runGit(worktree, [
        "-c",
        "user.name=codex-delegate",
        "-c",
        "user.email=codex-delegate@localhost",
        "-c",
        "commit.gpgSign=false",
        "-c",
        `core.hooksPath=${hooksPath}`,
        "commit",
        "--allow-empty",
        "--no-verify",
        "-m",
        "codex-delegate baseline",
      ]);
    } finally {
      rmSync(hooksPath, { force: true, recursive: true });
    }

    const baseline = runGit(worktree, ["rev-parse", "--verify", "HEAD^{commit}"])
      .toString("utf8")
      .trim();

    return { baseline, worktree };
  } catch (error) {
    removeFailedWorktree(repository, worktree);
    throw error;
  }
}

export function removeWorktree(repository: Repository, worktree: string): void {
  runGit(repository.root, ["worktree", "unlock", worktree]);
  runGit(repository.root, ["worktree", "remove", "--force", worktree]);
}
