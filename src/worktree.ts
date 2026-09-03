import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Repository } from "./repository.js";

export type WorkerSnapshot = {
  baseline: string;
  worktree: string;
};

export type SnapshotLimits = {
  maxBytes: number;
  maxFiles: number;
};

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxBytes: 52_428_800,
  maxFiles: 10_000,
};

type UntrackedFile = {
  path: string;
  size: number;
  symlinkTarget?: string;
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

function assertRepositoryPath(root: string, absolutePath: string, description: string): void {
  const pathFromRoot = relative(root, absolutePath);

  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Unsafe untracked ${description}: ${absolutePath}`);
  }
}

function resolveRepositoryPath(root: string, path: string): string {
  const absolutePath = resolve(root, path);
  assertRepositoryPath(root, absolutePath, "path");

  return absolutePath;
}

function validateSnapshotLimits(limits: SnapshotLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Snapshot limit ${name} must be a non-negative safe integer.`);
    }
  }
}

function collectUntrackedFiles(repository: Repository, limits: SnapshotLimits): UntrackedFile[] {
  validateSnapshotLimits(limits);
  const paths = listUntrackedFiles(repository);

  if (paths.length > limits.maxFiles) {
    throw new Error(`Untracked snapshot has ${paths.length} files, exceeding the limit of ${limits.maxFiles}.`);
  }

  let totalBytes = 0;
  const files = paths.map((path) => {
    const sourcePath = resolveRepositoryPath(repository.root, path);
    const sourceStat = lstatSync(sourcePath);
    const file: UntrackedFile = { path, size: sourceStat.size };

    if (sourceStat.isSymbolicLink()) {
      const symlinkTarget = readlinkSync(sourcePath);

      if (isAbsolute(symlinkTarget)) {
        throw new Error(`Unsafe untracked symlink target: ${path}`);
      }

      assertRepositoryPath(repository.root, resolve(dirname(sourcePath), symlinkTarget), "symlink target");
      file.symlinkTarget = symlinkTarget;
    } else if (!sourceStat.isFile()) {
      throw new Error(`Unsupported untracked file type: ${path}`);
    }

    totalBytes += file.size;
    if (totalBytes > limits.maxBytes) {
      throw new Error(`Untracked snapshot has ${totalBytes} bytes, exceeding the limit of ${limits.maxBytes}.`);
    }

    return file;
  });

  return files;
}

function assertSafeDestinationParent(worktree: string, path: string): void {
  const destinationPath = resolveRepositoryPath(worktree, path);
  let currentPath = worktree;

  for (const segment of relative(worktree, dirname(destinationPath)).split("/")) {
    if (segment === "") {
      continue;
    }

    currentPath = join(currentPath, segment);
    if (existsSync(currentPath) && lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`Unsafe symlink in untracked destination path: ${path}`);
    }
  }
}

function copyUntrackedFile(repository: Repository, worktree: string, file: UntrackedFile): void {
  const sourcePath = resolveRepositoryPath(repository.root, file.path);
  const destinationPath = resolveRepositoryPath(worktree, file.path);
  const sourceStat = lstatSync(sourcePath);

  assertSafeDestinationParent(worktree, file.path);
  mkdirSync(dirname(destinationPath), { recursive: true });

  if (file.symlinkTarget !== undefined && sourceStat.isSymbolicLink()) {
    symlinkSync(file.symlinkTarget, destinationPath);
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported untracked file type: ${file.path}`);
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

export function createSeededWorktree(
  repository: Repository,
  worktree: string,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): WorkerSnapshot {
  if (existsSync(worktree)) {
    throw new Error(`The worktree path already exists: ${worktree}`);
  }

  const trackedChanges = runGit(repository.root, ["diff", "--binary", repository.head]);
  const untrackedFiles = collectUntrackedFiles(repository, limits);
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

    for (const file of untrackedFiles) {
      copyUntrackedFile(repository, worktree, file);
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
