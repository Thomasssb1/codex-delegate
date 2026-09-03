import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadAcceptedProviders } from "./providers.js";
import { discoverRepository } from "./repository.js";
import { createSeededWorktree, removeWorktree } from "./worktree.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

function runGit(cwd: string, arguments_: string[]): void {
  execFileSync("git", arguments_, { cwd, encoding: "utf8" });
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "codex-delegate-"));

  runGit(repository, ["init", "--quiet"]);
  runGit(repository, ["config", "user.email", "test@example.com"]);
  runGit(repository, ["config", "user.name", "Codex Delegate Test"]);
  writeFileSync(join(repository, "README.md"), "Initial commit\n");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, ["commit", "--quiet", "-m", "Initial commit"]);

  return repository;
}

function runCli(cwd: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd,
    encoding: "utf8",
  });
}

test("loads accepted providers from JSON", () => {
  assert.deepEqual(loadAcceptedProviders(), ["muse"]);
});

test("accepts a positional task in a Git repository", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const result = runCli(
    repository,
    "run",
    "test-writer",
    "--provider",
    "muse",
    "Add a test for the empty input case",
  );

  assert.equal(result.status, 0);
  assert.equal(
    result.stdout,
    "Run requested for test-writer with provider muse.\nTask: Add a test for the empty input case\n",
  );
  assert.equal(result.stderr, "");
});

test("rejects providers other than Muse", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const result = runCli(repository, "run", "test-writer", "--provider", "other", "Write a test");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported provider: other\. Supported providers: muse\./);
});

test("requires one non-empty positional task", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const result = runCli(repository, "run", "test-writer", "--provider", "muse");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /error: missing required argument 'task'/);
});

test("discovers the Git root from a nested directory", (context) => {
  const repository = createRepository();
  const nestedDirectory = join(repository, "nested");
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(nestedDirectory);

  const result = runCli(
    nestedDirectory,
    "run",
    "test-writer",
    "--provider",
    "muse",
    "Write a test",
  );

  assert.equal(result.status, 0);
});

test("rejects a Git repository without a HEAD commit", (context) => {
  const repository = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  runGit(repository, ["init", "--quiet"]);

  const result = runCli(repository, "run", "test-writer", "--provider", "muse", "Write a test");

  assert.equal(result.status, 5);
  assert.match(result.stderr, /The Git repository must have a valid HEAD commit\./);
});

test("accepts uncommitted changes for a later worker snapshot", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  writeFileSync(join(repository, "untracked.txt"), "dirty\n");

  const result = runCli(repository, "run", "test-writer", "--provider", "muse", "Write a test");

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("seeds a worker with caller changes without changing the caller", (context) => {
  const repositoryRoot = createRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  writeFileSync(join(repositoryRoot, "README.md"), "Staged change\n");
  runGit(repositoryRoot, ["add", "README.md"]);
  writeFileSync(join(repositoryRoot, "README.md"), "Staged and unstaged change\n");
  writeFileSync(join(repositoryRoot, "untracked.txt"), "Caller change\n");
  const sourceStatus = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  const snapshot = createSeededWorktree(repository, worktree);

  assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "Staged and unstaged change\n");
  assert.equal(readFileSync(join(worktree, "untracked.txt"), "utf8"), "Caller change\n");
  assert.notEqual(snapshot.baseline, repository.head);
  assert.equal(
    execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
    sourceStatus,
  );

  writeFileSync(join(worktree, "agent.test.ts"), "export {};\n");
  runGit(worktree, ["add", "agent.test.ts"]);
  const workerPatch = execFileSync("git", ["diff", "--binary", snapshot.baseline], {
    cwd: worktree,
    encoding: "utf8",
  });

  assert.match(workerPatch, /agent\.test\.ts/);
  assert.doesNotMatch(workerPatch, /Staged and unstaged change/);
  assert.doesNotMatch(workerPatch, /untracked\.txt/);
});

test("rejects a directory outside a Git repository", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const result = runCli(directory, "run", "test-writer", "--provider", "muse", "Write a test");

  assert.equal(result.status, 5);
  assert.match(result.stderr, /Run codex-delegate from inside a non-bare Git worktree\./);
});
