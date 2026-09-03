import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadAcceptedProviders } from "./providers.js";
import { discoverRepository } from "./repository.js";
import { createSeededWorktree, removeWorktree } from "./worktree.js";
import { delegate } from "./delegate.js";
import type { Provider } from "./provider/provider.js";
import { createPrompt } from "./prompt.js";
import { loadAgent } from "./agents/loader.js";
import { createRunCancellation, RunCancelledError } from "./cancellation.js";
import { createFailedRunResult, createRunResult } from "./run-result.js";

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

type RepositoryState = {
  head: string;
  indexDiff: Buffer;
  status: string;
  worktreeDiff: Buffer;
};

function captureRepositoryState(repository: string): RepositoryState {
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }),
    indexDiff: execFileSync("git", ["diff", "--cached", "--binary"], { cwd: repository }),
    status: execFileSync("git", ["status", "--porcelain=v1"], { cwd: repository, encoding: "utf8" }),
    worktreeDiff: execFileSync("git", ["diff", "--binary"], { cwd: repository }),
  };
}

function assertRepositoryState(repository: string, expected: RepositoryState): void {
  assert.deepEqual(captureRepositoryState(repository), expected);
}

function createDirtyRepository(): string {
  const repository = createRepository();

  writeFileSync(join(repository, "README.md"), "Staged change\n");
  runGit(repository, ["add", "README.md"]);
  writeFileSync(join(repository, "README.md"), "Staged and unstaged change\n");
  writeFileSync(join(repository, "untracked.txt"), "Caller change\n");

  return repository;
}

function createRepositoryWithTrackedChanges(): string {
  const repository = createRepository();

  writeFileSync(join(repository, "delete.txt"), "Delete me\n");
  writeFileSync(join(repository, "rename-me.txt"), "Rename me\n");
  writeFileSync(join(repository, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]));
  writeFileSync(join(repository, "script.sh"), "#!/bin/sh\necho initial\n");
  runGit(repository, ["add", "delete.txt", "rename-me.txt", "binary.bin", "script.sh"]);
  runGit(repository, ["commit", "--quiet", "-m", "Tracked fixture files"]);

  writeFileSync(join(repository, "README.md"), "Staged change\n");
  runGit(repository, ["add", "README.md"]);
  writeFileSync(join(repository, "README.md"), "Staged and unstaged change\n");
  runGit(repository, ["mv", "rename-me.txt", "renamed.txt"]);
  rmSync(join(repository, "delete.txt"));
  writeFileSync(join(repository, "binary.bin"), Buffer.from([0x00, 0xff, 0x02]));
  chmodSync(join(repository, "script.sh"), 0o755);

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

test("creates a prompt from loaded instructions", () => {
  const prompt = createPrompt("Review changes for regressions.", "Review the current changes.");

  assert.match(prompt, /Review changes for regressions\./);
  assert.match(prompt, /Task:\nReview the current changes\./);
});

test("returns raw worker output in the JSON result", () => {
  const result = createRunResult({
    changedFiles: ["src/cli.test.ts"],
    patch: Buffer.from("diff --git a/src/cli.test.ts b/src/cli.test.ts\n"),
    providerStderr: "provider diagnostic\n",
    response: "Added a test.",
  });

  assert.deepEqual(result, {
    patch: "diff --git a/src/cli.test.ts b/src/cli.test.ts\n",
    response: "Added a test.",
    stderr: "provider diagnostic\n",
  });
});

test("returns raw diagnostics with a failed JSON result", () => {
  const result = createFailedRunResult("Muse did not complete the turn successfully.", "host warning\n");

  assert.deepEqual(result, {
    error: "Muse did not complete the turn successfully.",
    stderr: "host warning\n",
  });
});

test("loads the bundled test-writer agent", () => {
  const agent = loadAgent("/not-a-repository", "test-writer");

  assert.equal(agent.source, "bundled");
  assert.match(agent.instructions, /Write tests for the behaviour described in the task\./);
});

test("uses a project agent before its bundled counterpart", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(join(repository, ".codex-agents", "test-writer.md"), "Project instructions\n");

  const agent = loadAgent(repository, "test-writer");

  assert.equal(agent.source, "project");
  assert.equal(agent.instructions, "Project instructions");
});

test("uses a generic role prompt for an unknown agent", () => {
  const agent = loadAgent("/not-a-repository", "reviewer");

  assert.equal(agent.source, "generic");
  assert.equal(agent.instructions, "You are acting as the reviewer agent. Complete the task carefully.");
});

test("cancels a run when its timeout elapses", async () => {
  const cancellation = createRunCancellation(1, new EventEmitter());

  await new Promise<void>((resolve) => cancellation.signal.addEventListener("abort", () => resolve(), { once: true }));

  assert.equal(cancellation.signal.reason instanceof RunCancelledError, true);
  assert.equal(cancellation.signal.reason.cause, "timeout");
  cancellation.dispose();
});

test("cancels a run when it receives SIGINT", () => {
  const signals = new EventEmitter();
  const cancellation = createRunCancellation(60_000, signals);

  signals.emit("SIGINT");

  assert.equal(cancellation.signal.reason instanceof RunCancelledError, true);
  assert.equal(cancellation.signal.reason.cause, "signal");
  cancellation.dispose();
});

test("rejects unsafe agent names", () => {
  assert.throws(() => loadAgent("/not-a-repository", "../outside"), /Invalid agent name: \.\.\/outside/);
});

test("rejects providers other than Muse", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const result = runCli(repository, "run", "Write a test", "--provider", "other");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported provider: other\. Supported providers: muse\./);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.match(output.error as string, /Unsupported provider: other\. Supported providers: muse\./);
  assert.equal(output.stderr, "");
});

test("requires one non-empty positional task", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const result = runCli(repository, "run", "--provider", "muse");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /error: missing required argument 'task'/);
});

test("discovers the Git root from a nested directory", (context) => {
  const repository = createRepository();
  const nestedDirectory = join(repository, "nested");
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(nestedDirectory);

  assert.equal(discoverRepository(nestedDirectory).root, realpathSync(repository));
});

test("rejects a Git repository without a HEAD commit", (context) => {
  const repository = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  runGit(repository, ["init", "--quiet"]);

  const result = runCli(repository, "run", "Write a test", "--provider", "muse");

  assert.equal(result.status, 5);
  assert.match(result.stderr, /The Git repository must have a valid HEAD commit\./);
});

test("returns a JSON failure result by default when repository discovery fails", (context) => {
  const repository = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  runGit(repository, ["init", "--quiet"]);

  const result = runCli(repository, "run", "Write a test", "--provider", "muse");

  assert.equal(result.status, 5);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(output.error, "The Git repository must have a valid HEAD commit.");
  assert.equal(output.stderr, "");
  assert.match(result.stderr, /The Git repository must have a valid HEAD commit\./);
});

test(
  "returns a real Muse patch without changing the caller checkout",
  { skip: process.env.MUSE_E2E !== "1" },
  (context) => {
    const repository = createRepository();
    context.after(() => rmSync(repository, { force: true, recursive: true }));
    const initialStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: repository, encoding: "utf8" });

    const result = runCli(
      repository,
      "run",
      "Add a file named muse-e2e.test.ts containing exactly export {}; followed by a newline.",
      "e2e",
      "--provider",
      "muse",
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.error, undefined);
    assert.equal(typeof output.response, "string");
    assert.equal(typeof output.stderr, "string");
    assert.match(output.patch as string, /muse-e2e\.test\.ts/);
    assert.equal(
      execFileSync("git", ["status", "--porcelain=v1"], { cwd: repository, encoding: "utf8" }),
      initialStatus,
    );
    assert.equal(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repository, encoding: "utf8" })
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
    );
  },
);

test("accepts uncommitted changes for a later worker snapshot", (context) => {
  const repository = createDirtyRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  assert.equal(discoverRepository(repository).root, realpathSync(repository));
});

test("seeds a worker with caller changes without changing the caller", (context) => {
  const repositoryRoot = createDirtyRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  const sourceState = captureRepositoryState(repositoryRoot);

  const snapshot = createSeededWorktree(repository, worktree);

  assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "Staged and unstaged change\n");
  assert.equal(readFileSync(join(worktree, "untracked.txt"), "utf8"), "Caller change\n");
  assert.notEqual(snapshot.baseline, repository.head);
  assertRepositoryState(repositoryRoot, sourceState);

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

test("seeds staged and unstaged tracked changes into the worker", (context) => {
  const repositoryRoot = createRepositoryWithTrackedChanges();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  const sourceState = captureRepositoryState(repositoryRoot);

  createSeededWorktree(repository, worktree);

  assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "Staged and unstaged change\n");
  assert.equal(existsSync(join(worktree, "delete.txt")), false);
  assert.equal(existsSync(join(worktree, "rename-me.txt")), false);
  assert.equal(readFileSync(join(worktree, "renamed.txt"), "utf8"), "Rename me\n");
  assert.deepEqual(readFileSync(join(worktree, "binary.bin")), Buffer.from([0x00, 0xff, 0x02]));
  assert.equal(statSync(join(worktree, "script.sh")).mode & 0o111, 0o111);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("copies non-ignored untracked files and safe symlinks into the worker", (context) => {
  const repositoryRoot = createRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  writeFileSync(join(repositoryRoot, ".gitignore"), "ignored.txt\n");
  runGit(repositoryRoot, ["add", ".gitignore"]);
  runGit(repositoryRoot, ["commit", "--quiet", "-m", "Ignore fixture file"]);
  mkdirSync(join(repositoryRoot, "nested"));
  writeFileSync(join(repositoryRoot, "nested", "included.txt"), "Included\n");
  writeFileSync(join(repositoryRoot, "ignored.txt"), "Ignored\n");
  symlinkSync("nested/included.txt", join(repositoryRoot, "included-link"));
  const sourceState = captureRepositoryState(repositoryRoot);

  createSeededWorktree(repository, worktree);

  assert.equal(readFileSync(join(worktree, "nested", "included.txt"), "utf8"), "Included\n");
  assert.equal(readlinkSync(join(worktree, "included-link")), "nested/included.txt");
  assert.equal(existsSync(join(worktree, "ignored.txt")), false);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("copies an untracked symlink to a tracked file whose name starts with two dots", (context) => {
  const repositoryRoot = createRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  writeFileSync(join(repositoryRoot, "..config"), "Configuration\n");
  runGit(repositoryRoot, ["add", "..config"]);
  runGit(repositoryRoot, ["commit", "--quiet", "-m", "Add configuration fixture"]);
  symlinkSync("..config", join(repositoryRoot, "config-link"));
  const sourceState = captureRepositoryState(repositoryRoot);

  createSeededWorktree(repository, worktree);

  assert.equal(readlinkSync(join(worktree, "config-link")), "..config");
  assert.equal(readFileSync(join(worktree, "config-link"), "utf8"), "Configuration\n");
  assertRepositoryState(repositoryRoot, sourceState);
});

test("rejects untracked snapshots that exceed a file or byte limit", (context) => {
  const repositoryRoot = createRepository();
  const fileLimitWorktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const byteLimitWorktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(fileLimitWorktree)) {
      removeWorktree(repository, fileLimitWorktree);
    }

    if (existsSync(byteLimitWorktree)) {
      removeWorktree(repository, byteLimitWorktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  writeFileSync(join(repositoryRoot, "one.txt"), "one\n");
  writeFileSync(join(repositoryRoot, "two.txt"), "two\n");
  const sourceState = captureRepositoryState(repositoryRoot);

  assert.throws(
    () => createSeededWorktree(repository, fileLimitWorktree, { maxBytes: 10, maxFiles: 1 }),
    /Untracked snapshot has 2 files, exceeding the limit of 1\./,
  );
  assert.equal(existsSync(fileLimitWorktree), false);

  assert.throws(
    () => createSeededWorktree(repository, byteLimitWorktree, { maxBytes: 7, maxFiles: 2 }),
    /Untracked snapshot has 8 bytes, exceeding the limit of 7\./,
  );
  assert.equal(existsSync(byteLimitWorktree), false);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("rejects an untracked symlink that escapes the repository", (context) => {
  const repositoryRoot = createRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const outsideFile = join(tmpdir(), `codex-delegate-outside-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(outsideFile, { force: true });
    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  writeFileSync(outsideFile, "Outside\n");
  symlinkSync(`../${basename(outsideFile)}`, join(repositoryRoot, "outside-link"));
  const sourceState = captureRepositoryState(repositoryRoot);

  assert.throws(() => createSeededWorktree(repository, worktree), /Unsafe untracked symlink target/);
  assert.equal(existsSync(worktree), false);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("does not run repository hooks for the baseline commit", (context) => {
  const repositoryRoot = createRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const prepareCommitMsgMarker = join(tmpdir(), `codex-delegate-prepare-commit-msg-${randomUUID()}`);
  const postCommitMarker = join(tmpdir(), `codex-delegate-post-commit-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(prepareCommitMsgMarker, { force: true });
    rmSync(postCommitMarker, { force: true });
    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  const hooksDirectory = join(repositoryRoot, ".git", "hooks");
  writeFileSync(
    join(hooksDirectory, "prepare-commit-msg"),
    `#!/bin/sh\ntouch ${JSON.stringify(prepareCommitMsgMarker)}\nexit 1\n`,
  );
  writeFileSync(join(hooksDirectory, "post-commit"), `#!/bin/sh\ntouch ${JSON.stringify(postCommitMarker)}\nexit 1\n`);
  chmodSync(join(hooksDirectory, "prepare-commit-msg"), 0o755);
  chmodSync(join(hooksDirectory, "post-commit"), 0o755);

  const snapshot = createSeededWorktree(repository, worktree);

  assert.notEqual(snapshot.baseline, repository.head);
  assert.equal(existsSync(prepareCommitMsgMarker), false);
  assert.equal(existsSync(postCommitMarker), false);
});

test("returns only worker changes from a dirty caller checkout", async (context) => {
  const repositoryRoot = createDirtyRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => rmSync(repositoryRoot, { force: true, recursive: true }));
  const sourceState = captureRepositoryState(repositoryRoot);
  const provider: Provider = {
    async run({ workspaceRoot }) {
      writeFileSync(join(workspaceRoot, "agent.test.ts"), "export {};\n");

      return {
        response: "Added a test.",
        stderr: "provider diagnostic\n",
      };
    },
  };

  const result = await delegate({
    prompt: "Write a test",
    provider,
    repository,
    signal: new AbortController().signal,
    worktree,
  });

  assert.deepEqual(result.changedFiles, ["agent.test.ts"]);
  assert.match(result.patch.toString("utf8"), /agent\.test\.ts/);
  assert.doesNotMatch(result.patch.toString("utf8"), /Staged and unstaged change/);
  assert.doesNotMatch(result.patch.toString("utf8"), /untracked\.txt/);
  assert.equal(result.response, "Added a test.");
  assert.equal(result.providerStderr, "provider diagnostic\n");
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(join(repositoryRoot, "agent.test.ts")), false);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("removes the worker after a provider is cancelled", async (context) => {
  const repositoryRoot = createDirtyRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  const controller = new AbortController();
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });
  const sourceState = captureRepositoryState(repositoryRoot);
  const provider: Provider = {
    async run({ signal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw signal.reason;
    },
  };

  const run = delegate({
    prompt: "Write a test",
    provider,
    repository,
    signal: controller.signal,
    worktree,
  });
  controller.abort(new RunCancelledError("signal"));

  await assert.rejects(run, RunCancelledError);
  assert.equal(existsSync(worktree), false);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("removes the worker after a provider failure without changing the caller", async (context) => {
  const repositoryRoot = createDirtyRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });
  const sourceState = captureRepositoryState(repositoryRoot);
  const provider: Provider = {
    async run() {
      throw new Error("The provider failed.");
    },
  };

  await assert.rejects(
    delegate({
      prompt: "Write a test",
      provider,
      repository,
      signal: new AbortController().signal,
      worktree,
    }),
    /The provider failed\./,
  );

  assert.equal(existsSync(worktree), false);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("rejects a directory outside a Git repository", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const result = runCli(directory, "run", "Write a test", "--provider", "muse");

  assert.equal(result.status, 5);
  assert.match(result.stderr, /Run codex-delegate from inside a non-bare Git worktree\./);
});
