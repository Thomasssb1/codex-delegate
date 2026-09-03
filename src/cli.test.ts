import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
import { DEFAULT_SNAPSHOT_LIMITS, createSeededWorktree, removeWorktree } from "./worktree.js";
import { delegate } from "./delegate.js";
import type { Provider } from "./provider/provider.js";
import { ProviderRunError } from "./provider/provider.js";
import { createPrompt } from "./prompt.js";
import { listAgents, loadAgent } from "./agents/loader.js";
import {
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  createRunCancellation,
  rejectCancelledRun,
  RunCancelledError,
} from "./cancellation.js";
import { createInteractionResponder } from "./interaction.js";
import { toMuseApprovalMode } from "./approval-mode.js";
import { parseInactivityTimeout, resolveRunConfiguration } from "./config.js";
import { createFailedRunResult, createRunResult } from "./run-result.js";
import { museFailureMessage, MuseProvider } from "./provider/muse.js";
import { resolveTask } from "./task.js";
import { installCodexSkills } from "./codex-skills.js";

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

test("preserves a Muse terminal failure's details", () => {
  assert.equal(
    museFailureMessage({
      kind: "completed",
      params: {
        error: {
          kind: "modelError",
          message: "Usage limit exhausted.",
        },
        terminal: "failed",
      },
    }),
    "Muse run failed (modelError): Usage limit exhausted.",
  );
});

test("installs the bundled Codex skills", (context) => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  context.after(() => rmSync(codexHome, { force: true, recursive: true }));

  const installation = installCodexSkills({ codexHome });

  assert.deepEqual(installation, {
    installed: ["codex-delegate", "codex-delegate-review", "codex-delegate-test"],
    skillsDirectory: join(codexHome, "skills"),
  });
  assert.match(
    readFileSync(join(codexHome, "skills", "codex-delegate-test", "SKILL.md"), "utf8"),
    /Use the `codex-delegate` skill to list agents/,
  );
  assert.match(
    readFileSync(join(codexHome, "skills", "codex-delegate", "SKILL.md"), "utf8"),
    /`command -v codex-delegate`/,
  );
  assert.throws(() => installCodexSkills({ codexHome }), /Codex skills already installed/);

  writeFileSync(join(codexHome, "skills", "codex-delegate", "SKILL.md"), "outdated instructions\n");
  installCodexSkills({ codexHome, force: true });
  assert.match(
    readFileSync(join(codexHome, "skills", "codex-delegate", "SKILL.md"), "utf8"),
    /complete the task yourself/,
  );
});

test("loads the bundled test-writer agent", () => {
  const agent = loadAgent("/not-a-repository", "test-writer");

  assert.equal(agent.source, "bundled");
  assert.equal(agent.description, "Add tests for an existing implementation.");
  assert.equal(agent.provider, "muse");
  assert.equal(agent.approvalMode, "approveForMe");
  assert.match(agent.instructions, /Write tests for the behaviour described in the task\./);
  assert.match(agent.instructions, /"summary": "What you changed"/);
});

test("loads the bundled reviewer agent", () => {
  const agent = loadAgent("/not-a-repository", "reviewer");

  assert.equal(agent.source, "bundled");
  assert.equal(agent.description, "Review the current changes for correctness and regressions.");
  assert.equal(agent.provider, "muse");
  assert.equal(agent.approvalMode, "approveForMe");
  assert.match(agent.instructions, /Do not modify files or commit\./);
  assert.match(agent.instructions, /"verdict": "approved" \| "changes_requested"/);
});

test("lists bundled agents", () => {
  assert.deepEqual(
    listAgents().map(({ name, source }) => ({ name, source })),
    [
      { name: "reviewer", source: "bundled" },
      { name: "test-writer", source: "bundled" },
    ],
  );
});

test("lists available agents through the CLI", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const result = runCli(directory, "agents");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    agents: [
      {
        description: "Review the current changes for correctness and regressions.",
        name: "reviewer",
        source: "bundled",
      },
      {
        description: "Add tests for an existing implementation.",
        name: "test-writer",
        source: "bundled",
      },
    ],
  });
});

test("lists a project agent's model", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: test-writer\ndescription: Project test instructions.\nmodel: muse-spark-1.3\n---\nProject instructions\n",
  );

  const result = runCli(repository, "agents");

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { agents: { model?: string; name: string }[] };
  assert.equal(output.agents.find((agent) => agent.name === "test-writer")?.model, "muse-spark-1.3");
});

test("reports invalid project agent profiles with exit code 2", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: test-writer\ndescription: Project test instructions.\nprovider: other\n---\nProject instructions\n",
  );

  const result = runCli(repository, "agents");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid agent profile .*provider is unsupported: other/);
  const output = JSON.parse(result.stdout) as { error: string };
  assert.match(output.error, /Invalid agent profile .*provider is unsupported: other/);
});

test("uses a project agent before its bundled counterpart", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: test-writer\ndescription: Project test instructions.\n---\nProject instructions\n",
  );

  const agent = loadAgent(repository, "test-writer");

  assert.equal(agent.source, "project");
  assert.equal(agent.instructions, "Project instructions");
});

test("lists project agents and overrides", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: test-writer\ndescription: Project test instructions.\n---\nProject instructions\n",
  );
  writeFileSync(
    join(repository, ".codex-agents", "accessibility.md"),
    "---\nname: accessibility\ndescription: Review accessibility.\n---\nReview the change.\n",
  );

  assert.deepEqual(
    listAgents(repository).map(({ description, name, source }) => ({ description, name, source })),
    [
      { description: "Review accessibility.", name: "accessibility", source: "project" },
      { description: "Review the current changes for correctness and regressions.", name: "reviewer", source: "bundled" },
      { description: "Project test instructions.", name: "test-writer", source: "project" },
    ],
  );
});

test("lists symlinked project agent profiles", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  const profilePath = join(repository, "accessibility-profile.md");
  writeFileSync(
    profilePath,
    "---\nname: accessibility\ndescription: Review accessibility.\n---\nReview the change.\n",
  );
  symlinkSync("../accessibility-profile.md", join(repository, ".codex-agents", "accessibility.md"));

  assert.deepEqual(
    listAgents(repository).map(({ name, source }) => ({ name, source })),
    [
      { name: "accessibility", source: "project" },
      { name: "reviewer", source: "bundled" },
      { name: "test-writer", source: "bundled" },
    ],
  );
});

test("rejects an unknown agent profile", () => {
  assert.throws(() => loadAgent("/not-a-repository", "missing-agent"), /Agent profile not found: missing-agent/);
});

test("rejects removed output metadata", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  const profilePath = join(repository, ".codex-agents", "test-writer.md");

  writeFileSync(
    profilePath,
    "---\nname: test-writer\ndescription: Project test instructions.\noutput: change\n---\nProject instructions\n",
  );
  assert.throws(() => loadAgent(repository, "test-writer"), /unknown front matter key: output/);
});

test("rejects unknown profile metadata", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: test-writer\ndescription: Project test instructions.\nmode: write\n---\nProject instructions\n",
  );

  assert.throws(() => loadAgent(repository, "test-writer"), /unknown front matter key: mode/);
});

test("rejects agent profiles whose name does not match their filename", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: another-agent\ndescription: Project test instructions.\n---\nProject instructions\n",
  );

  assert.throws(() => loadAgent(repository, "test-writer"), /name must match the requested agent: test-writer/);
});

test("rejects agent profiles with an unsupported provider", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: test-writer\ndescription: Project test instructions.\nprovider: other\n---\nProject instructions\n",
  );

  assert.throws(() => loadAgent(repository, "test-writer"), /provider is unsupported: other/);
});

test("accepts Codex approval modes and rejects Muse mode names", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  const profilePath = join(repository, ".codex-agents", "test-writer.md");
  writeFileSync(
    profilePath,
    "---\nname: test-writer\ndescription: Project test instructions.\napprovalMode: alwaysAsk\n---\nProject instructions\n",
  );

  assert.equal(loadAgent(repository, "test-writer").approvalMode, "alwaysAsk");

  writeFileSync(
    profilePath,
    "---\nname: test-writer\ndescription: Project test instructions.\napprovalMode: denyUnmatched\n---\nProject instructions\n",
  );

  assert.equal(loadAgent(repository, "test-writer").approvalMode, "denyUnmatched");
});

test("maps the denyUnmatched approval mode to Muse", () => {
  assert.equal(toMuseApprovalMode("denyUnmatched"), "denyUnmatched");
});

test("defaults a run to approveForMe", () => {
  const configuration = resolveRunConfiguration("/not-a-repository", {
    description: "Profile instructions.",
    instructions: "Do the task.",
    name: "test-writer",
    source: "project",
  });

  assert.equal(configuration.muse.approvalMode, "approveForMe");
});

function approvalRequest() {
  return {
    approvalId: "approval",
    choices: [
      { choiceId: "allow", decision: "approved", label: "Allow" },
      { acceptsFeedback: true, choiceId: "deny", decision: "denied", label: "Deny" },
    ],
    kind: "approval" as const,
    requirementId: { approvalId: "approval", sourceIndex: 1 },
    toolName: "shell",
    turnId: "turn",
  };
}

function userInputRequest() {
  return {
    kind: "userInput" as const,
    questions: [
      {
        header: "Colour",
        id: "colour",
        options: [{ label: "Blue" }, { label: "Red" }],
        question: "Which colour?",
        selection: { mode: "single" as const },
      },
      {
        header: "Features",
        id: "features",
        options: [{ label: "Fast" }, { label: "Small" }],
        question: "Which features?",
        selection: { maxSelections: 2, minSelections: 1, mode: "multiple" as const },
      },
    ],
    toolName: "ask_user",
    turnId: "turn",
    userInputId: "input",
  };
}

function createTestResponder() {
  const input = new PassThrough();
  const output: string[] = [];
  const responder = createInteractionResponder(input, { write: (chunk) => output.push(chunk) });

  return { input, output, responder };
}

test("streams an approval request and accepts an offered choice", async () => {
  const { input, output, responder } = createTestResponder();
  const pending = responder.request(approvalRequest());

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(output[0]), { interaction: approvalRequest(), status: "interaction_required" });
  input.write('{"choiceId":"deny","feedback":"Use the safe path."}\n');

  await assert.doesNotReject(pending);
  assert.deepEqual(await pending, { choiceId: "deny", feedback: "Use the safe path.", kind: "approval" });
  responder.close();
});

test("streams multiple user-input answers", async () => {
  const { input, output, responder } = createTestResponder();
  const pending = responder.request(userInputRequest());

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(output[0]), { interaction: userInputRequest(), status: "interaction_required" });
  input.write('{"answers":[{"questionId":"colour","selectedLabel":"Blue"},{"questionId":"features","selectedLabels":["Fast","Small"]}]}\n');

  assert.deepEqual(await pending, {
    answers: [
      { questionId: "colour", selectedLabel: "Blue" },
      { questionId: "features", selectedLabels: ["Fast", "Small"] },
    ],
    kind: "userInput",
  });
  responder.close();
});

test("serializes back-to-back Muse requests", async () => {
  const { input, output, responder } = createTestResponder();
  const approval = responder.request(approvalRequest());
  const inputRequest = responder.request(userInputRequest());

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.length, 1);
  input.write('{"choiceId":"allow"}\n');
  await approval;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(output.length, 2);
  input.write('{"answers":[]}\n');

  assert.deepEqual(await inputRequest, { answers: [], kind: "userInput" });
  responder.close();
});

test("fails an interaction when Codex closes stdin", async () => {
  const { input, responder } = createTestResponder();
  const pending = responder.request(approvalRequest());

  input.end();

  await assert.rejects(pending, /closed stdin while Muse was waiting/);
  responder.close();
});

test("rejects removed change rules", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));

  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: test-writer\ndescription: Project test instructions.\nchanges:\n  allow:\n    - src/**/*.test.ts\n---\nProject instructions\n",
  );
  assert.throws(() => loadAgent(repository, "test-writer"), /unknown front matter key: changes/);
});

test("resolves repository configuration with CLI and profile precedence", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  writeFileSync(
    join(repository, ".codex-delegate.yml"),
    [
      "defaultProvider: muse",
      "inactivityTimeout: 45s",
      "snapshot:",
      "  includeUntracked: false",
      "  maxFiles: 7",
      "  maxBytes: 4096",
      "muse:",
      "  binary: configured-muse",
      "  model: configured-model",
      "  approvalMode: denyUnmatched",
      "",
    ].join("\n"),
  );

  const profile = {
    approvalMode: "denyUnmatched" as const,
    description: "Profile instructions.",
    instructions: "Do the task.",
    model: "profile-model",
    name: "test-writer",
    provider: "muse",
    source: "project" as const,
  };
  const configured = resolveRunConfiguration(repository, profile);
  const overridden = resolveRunConfiguration(repository, profile, {
    allowAll: true,
    approvalMode: "fullAccess",
    model: "cli-model",
    provider: "muse",
    timeoutMs: parseInactivityTimeout("2m"),
  });

  assert.deepEqual(configured, {
    inactivityTimeoutMs: 45_000,
    muse: {
      approvalMode: "denyUnmatched",
      binary: "configured-muse",
      model: "profile-model",
    },
    provider: "muse",
    snapshotLimits: {
      includeUntracked: false,
      maxBytes: 4096,
      maxFiles: 7,
    },
  });
  assert.equal(overridden.inactivityTimeoutMs, 120_000);
  assert.equal(overridden.muse.approvalMode, "fullAccess");
  assert.equal(overridden.muse.model, "cli-model");
});

test("rejects invalid configuration and unguarded full access", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  const profile = {
    description: "Profile instructions.",
    instructions: "Do the task.",
    name: "test-writer",
    source: "project" as const,
  };

  assert.throws(
    () => resolveRunConfiguration(repository, profile, { approvalMode: "fullAccess" }),
    /approvalMode=fullAccess requires --allow-all/,
  );
  assert.throws(() => parseInactivityTimeout("20"), /positive duration/);

  writeFileSync(join(repository, ".codex-delegate.yml"), "unknown: value\n");

  assert.throws(() => resolveRunConfiguration(repository, profile), /unknown root key: unknown/);
});

test("cancels a run after its inactivity deadline elapses", async () => {
  const cancellation = createRunCancellation(1, new EventEmitter());
  cancellation.onActivity();

  await new Promise<void>((resolve) => cancellation.signal.addEventListener("abort", () => resolve(), { once: true }));

  assert.equal(cancellation.signal.reason instanceof RunCancelledError, true);
  assert.equal(cancellation.signal.reason.cause, "inactivity");
  cancellation.dispose();
});

test("resets the inactivity deadline when the provider reports activity", async () => {
  const cancellation = createRunCancellation(100, new EventEmitter());
  await new Promise((resolve) => setTimeout(resolve, 60));
  cancellation.onActivity();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(cancellation.signal.aborted, false);
  cancellation.dispose();
});

test("pauses the inactivity deadline while Codex answers Muse", async () => {
  const cancellation = createRunCancellation(10, new EventEmitter());
  cancellation.onActivity();
  cancellation.pause();

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(cancellation.signal.aborted, false);
  cancellation.dispose();
});

test("waits for every pending Muse interaction before resuming the inactivity deadline", async () => {
  const cancellation = createRunCancellation(10, new EventEmitter());
  cancellation.onActivity();
  cancellation.pause();
  cancellation.pause();
  cancellation.resume();

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(cancellation.signal.aborted, false);
  cancellation.resume();
  await new Promise<void>((resolve) => cancellation.signal.addEventListener("abort", () => resolve(), { once: true }));
  assert.equal(cancellation.signal.reason instanceof RunCancelledError, true);
  assert.equal(cancellation.signal.reason.cause, "inactivity");
  cancellation.dispose();
});

test("preserves cancellation when closing Muse makes a session operation fail", async () => {
  for (const cause of ["inactivity", "signal"] as const) {
    const controller = new AbortController();
    const provider = new MuseProvider();
    const unsafeProvider = provider as unknown as { runTurn(): Promise<never> };
    unsafeProvider.runTurn = async () => {
      controller.abort(new RunCancelledError(cause));
      throw new Error("Muse transport closed.");
    };

    await assert.rejects(
      provider.run({
        prompt: "Do the task.",
        signal: controller.signal,
        workspaceRoot: process.cwd(),
      }),
      (error: unknown) => error instanceof RunCancelledError && error.cause === cause,
    );
  }
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

test("shows run help without a JSON error result", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const result = runCli(repository, "run", "--help");

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: codex-delegate run/);
  assert.doesNotMatch(result.stdout, /"error"/);
  assert.equal(result.stderr, "");
});

test("requires one non-empty task source", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const result = runCli(repository, "run", "--provider", "muse");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Supply a task as a positional argument or --task file/);
});

test("resolves positional and file task input", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  const taskPath = join(directory, "task.md");
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  writeFileSync(taskPath, "A task from a file.\n");

  assert.deepEqual(
    resolveTask({
      agent: "custom-agent",
      positional: "A positional task.",
    }),
    { agent: "custom-agent", task: "A positional task." },
  );
  assert.deepEqual(
    resolveTask({
      positional: "custom-agent",
      taskPath,
    }),
    { agent: "custom-agent", task: "A task from a file.\n" },
  );
});

test("rejects ambiguous, empty, and invalid task sources", () => {
  assert.throws(
    () => resolveTask({ positional: "task", agent: "agent", taskPath: "task.md" }),
    /only one positional agent name/,
  );
  assert.throws(
    () => resolveTask({}),
    /positional argument or --task file/,
  );
  assert.throws(
    () => resolveTask({ positional: "   " }),
    /must be non-empty/,
  );
});

test("accepts file task input before repository discovery", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  const taskPath = join(directory, "task.md");
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  writeFileSync(taskPath, "A task from a file.\n");

  const fileResult = runCli(directory, "run", "test-writer", "--task", taskPath, "--provider", "muse");

  assert.equal(fileResult.status, 5);
  assert.match(fileResult.stderr, /Run codex-delegate from inside a non-bare Git worktree/);
});

test("does not drain stdin when a task is supplied outside stdin", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  for (const arguments_ of [
    ["run", "A positional task.", "--provider", "muse"],
    ["run", "test-writer", "--task", join(directory, "task.md"), "--provider", "muse"],
  ]) {
    writeFileSync(join(directory, "task.md"), "A task from a file.\n");
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("CLI waited for EOF on stdin."));
      }, 1_000);
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.equal(exitCode, 5);
    assert.match(stderr, /Run codex-delegate from inside a non-bare Git worktree/);
  }
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

test("can exclude untracked files from a worker snapshot", (context) => {
  const repositoryRoot = createDirtyRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }

    rmSync(repositoryRoot, { force: true, recursive: true });
  });

  createSeededWorktree(repository, worktree, { includeUntracked: false, maxBytes: 52_428_800, maxFiles: 10_000 });

  assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "Staged and unstaged change\n");
  assert.equal(existsSync(join(worktree, "untracked.txt")), false);
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

test("maps every Codex approval mode to its Muse counterpart", () => {
  assert.equal(toMuseApprovalMode("alwaysAsk"), "onRequest");
  assert.equal(toMuseApprovalMode("approveForMe"), "promptUnmatched");
  assert.equal(toMuseApprovalMode("denyUnmatched"), "denyUnmatched");
  assert.equal(toMuseApprovalMode("fullAccess"), "allowAll");
});

test("parses millisecond, second, minute and hour inactivity timeouts", () => {
  assert.equal(parseInactivityTimeout("500ms"), 500);
  assert.equal(parseInactivityTimeout("30s"), 30_000);
  assert.equal(parseInactivityTimeout("20m"), 1_200_000);
  assert.equal(parseInactivityTimeout("1h"), 3_600_000);
  assert.throws(() => parseInactivityTimeout("0s"), /positive safe duration/);
  assert.throws(() => parseInactivityTimeout("20"), /positive duration/);
  assert.throws(() => parseInactivityTimeout("10d"), /positive duration/);
});

test("falls back to default run configuration without a repository config file", () => {
  const configuration = resolveRunConfiguration("/not-a-repository", {
    description: "Profile instructions.",
    instructions: "Do the task.",
    name: "test-writer",
    source: "project",
  });

  assert.deepEqual(configuration, {
    inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS,
    muse: {
      approvalMode: "approveForMe",
      binary: "muse",
      model: undefined,
    },
    provider: "muse",
    snapshotLimits: {
      includeUntracked: undefined,
      maxBytes: DEFAULT_SNAPSHOT_LIMITS.maxBytes,
      maxFiles: DEFAULT_SNAPSHOT_LIMITS.maxFiles,
    },
  });
});

test("rejects --allow-all unless approval mode is fullAccess", () => {
  const repository = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  try {
    assert.throws(
      () =>
        resolveRunConfiguration(
          repository,
          { description: "d", instructions: "i", name: "test-writer", source: "project" },
          { allowAll: true, approvalMode: "approveForMe" },
        ),
      /--allow-all can only be used with approvalMode=fullAccess/,
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("rejects invalid repository configuration values", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  const profile = { description: "d", instructions: "i", name: "test-writer", source: "project" as const };

  writeFileSync(join(repository, ".codex-delegate.yml"), "snapshot:\n  unknownKey: 1\n");
  assert.throws(() => resolveRunConfiguration(repository, profile), /unknown snapshot key: unknownKey/);

  writeFileSync(join(repository, ".codex-delegate.yml"), "snapshot:\n  maxFiles: -1\n");
  assert.throws(() => resolveRunConfiguration(repository, profile), /snapshot\.maxFiles must be a non-negative safe integer/);

  writeFileSync(join(repository, ".codex-delegate.yml"), "muse:\n  approvalMode: sometimes\n");
  assert.throws(() => resolveRunConfiguration(repository, profile), /muse\.approvalMode must be one of/);

  writeFileSync(join(repository, ".codex-delegate.yml"), "defaultProvider: other\n");
  assert.throws(() => resolveRunConfiguration(repository, profile), /defaultProvider is unsupported: other/);

  writeFileSync(join(repository, ".codex-delegate.yml"), "inactivityTimeout: 10d\n");
  assert.throws(() => resolveRunConfiguration(repository, profile), /Timeout must be a positive duration/);
});

test("rejects repository configuration that is not a mapping", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  const profile = { description: "d", instructions: "i", name: "test-writer", source: "project" as const };

  writeFileSync(join(repository, ".codex-delegate.yml"), "- just\n- a\n- list\n");
  assert.throws(() => resolveRunConfiguration(repository, profile), /root must be a mapping/);
});

test("throws when discovering a repository outside Git", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  assert.throws(() => discoverRepository(directory), /Run codex-delegate from inside a non-bare Git worktree/);
});

test("defaults to the test-writer agent for file task input without a positional name", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const taskPath = join(directory, "task.md");
  writeFileSync(taskPath, "A task from a file.\n");

  assert.deepEqual(resolveTask({ taskPath }), { agent: "test-writer", task: "A task from a file.\n" });
});

test("rejects missing, empty and non-UTF8 task files", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  assert.throws(
    () => resolveTask({ positional: "test-writer", taskPath: join(directory, "missing.md") }),
    /Could not read task file/,
  );

  const emptyPath = join(directory, "empty.md");
  writeFileSync(emptyPath, "   \n");
  assert.throws(() => resolveTask({ positional: "test-writer", taskPath: emptyPath }), /must be non-empty/);

  const binaryPath = join(directory, "binary.md");
  writeFileSync(binaryPath, Buffer.from([0xff, 0xfe, 0x00]));
  assert.throws(() => resolveTask({ positional: "test-writer", taskPath: binaryPath }), /not valid UTF-8/);
});

test("rejects an empty agent name for positional and file tasks", () => {
  assert.throws(() => resolveTask({ positional: "   " }), /must be non-empty/);
  assert.throws(() => resolveTask({ agent: "  ", positional: "A task." }), /agent name must be non-empty/);
});

test("keeps the checkout guard in every delegated prompt", () => {
  const prompt = createPrompt("Do the thing.", "The task.");

  assert.match(prompt, /Work only in the current checkout\. Do not commit or modify \.git\./);
});

test("explains Muse terminal failures with reason and fallback messages", () => {
  assert.equal(
    museFailureMessage({ kind: "completed", params: { reason: "turn ended early", terminal: "failed" } }),
    "Muse did not complete the turn successfully: turn ended early",
  );
  assert.equal(museFailureMessage({ kind: "completed", params: { terminal: "completed" } }), "Muse did not complete the turn successfully.");
  assert.equal(museFailureMessage({ kind: "aborted" }), "Muse did not complete the turn successfully.");
});

test("wraps unexpected Muse failures in ProviderRunError while preserving cancellation", async () => {
  const controller = new AbortController();
  const provider = new MuseProvider();
  const unsafeProvider = provider as unknown as { runTurn(): Promise<never> };
  unsafeProvider.runTurn = async () => {
    throw new Error("Transport boom.");
  };

  await assert.rejects(
    provider.run({ prompt: "Do the task.", signal: controller.signal, workspaceRoot: process.cwd() }),
    (error: unknown) => error instanceof ProviderRunError && error.message === "Transport boom." && error.stderr === "",
  );
});

test("throws from rejectCancelledRun only after the signal aborts", () => {
  const controller = new AbortController();

  assert.doesNotThrow(() => rejectCancelledRun(controller.signal));

  const expected = new RunCancelledError("signal");
  controller.abort(expected);
  assert.throws(() => rejectCancelledRun(controller.signal), (error: unknown) => error === expected);

  const genericController = new AbortController();
  genericController.abort(new Error("generic"));
  assert.throws(() => rejectCancelledRun(genericController.signal), /generic/);
});

test("reports distinct messages for inactivity and interruption cancellations", () => {
  assert.equal(new RunCancelledError("inactivity").message, "The provider stopped reporting activity.");
  assert.equal(new RunCancelledError("signal").message, "The run was interrupted.");
});

test("rejects malformed Codex approval replies", async () => {
  const approval = {
    approvalId: "approval",
    choices: [{ choiceId: "allow", decision: "approved", label: "Allow" }],
    kind: "approval" as const,
    requirementId: { approvalId: "approval", sourceIndex: 1 },
    toolName: "shell",
    turnId: "turn",
  };

  for (const [line, pattern] of [
    ["not-json\n", /Codex must reply with a JSON object/],
    ['"just-a-string"\n', /Codex must reply with a JSON object/],
    ['{"choiceId":"unknown"}\n', /Codex selected an approval choice Muse did not offer/],
    ['{"choiceId":"allow","feedback":42}\n', /Codex approval feedback must be a string/],
  ] as const) {
    const input = new PassThrough();
    const responder = createInteractionResponder(input, { write: () => undefined });
    const pending = responder.request(approval);
    await new Promise((resolve) => setImmediate(resolve));
    input.write(line);
    await assert.rejects(pending, pattern);
    responder.close();
  }
});

test("rejects Codex input replies without an answers array", async () => {
  const request = {
    kind: "userInput" as const,
    questions: [],
    toolName: "ask_user",
    turnId: "turn",
    userInputId: "input",
  };

  for (const line of ['{"answers":"nope"}\n', '{}\n']) {
    const input = new PassThrough();
    const responder = createInteractionResponder(input, { write: () => undefined });
    const pending = responder.request(request);
    await new Promise((resolve) => setImmediate(resolve));
    input.write(line);
    await assert.rejects(pending, /Codex input answers must be an array/);
    responder.close();
  }
});

test("rejects agent profiles without front matter or instructions", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));

  writeFileSync(join(repository, ".codex-agents", "test-writer.md"), "No front matter here.\n");
  assert.throws(() => loadAgent(repository, "test-writer"), /expected YAML front matter delimited by ---/);

  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: test-writer\ndescription: Project test instructions.\n---\n   \n",
  );
  assert.throws(() => loadAgent(repository, "test-writer"), /instructions are empty/);
});

test("rejects agent profiles with invalid names", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));

  writeFileSync(
    join(repository, ".codex-agents", "test-writer.md"),
    "---\nname: Bad_Name\ndescription: Project test instructions.\n---\nProject instructions\n",
  );
  assert.throws(() => loadAgent(repository, "test-writer"), /name is invalid: Bad_Name/);
});

test("ignores non-profile files and broken symlinks when listing agents", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));
  mkdirSync(join(repository, ".codex-agents"));
  writeFileSync(join(repository, ".codex-agents", "notes.txt"), "not an agent\n");
  mkdirSync(join(repository, ".codex-agents", "directory.md"));
  symlinkSync(join(repository, "missing-target.md"), join(repository, ".codex-agents", "broken.md"));

  assert.deepEqual(
    listAgents(repository).map(({ name }) => name),
    ["reviewer", "test-writer"],
  );
});

test("rejects untracked snapshots with negative limits or an existing worktree path", (context) => {
  const repositoryRoot = createRepository();
  context.after(() => rmSync(repositoryRoot, { force: true, recursive: true }));
  const repository = discoverRepository(repositoryRoot);
  const existingWorktree = mkdtempSync(join(tmpdir(), "codex-delegate-"));
  context.after(() => rmSync(existingWorktree, { force: true, recursive: true }));

  assert.throws(
    () => createSeededWorktree(repository, existingWorktree),
    /The worktree path already exists/,
  );
  assert.throws(
    () =>
      createSeededWorktree(repository, join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`), {
        maxBytes: 10,
        maxFiles: -1,
      }),
    /Snapshot limit maxFiles must be a non-negative safe integer/,
  );
});

test("rejects absolute untracked symlink targets", (context) => {
  const repositoryRoot = createRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => {
    if (existsSync(worktree)) {
      removeWorktree(repository, worktree);
    }
    rmSync(repositoryRoot, { force: true, recursive: true });
  });
  symlinkSync("/etc/passwd", join(repositoryRoot, "absolute-link"));
  const sourceState = captureRepositoryState(repositoryRoot);

  assert.throws(() => createSeededWorktree(repository, worktree), /Unsafe untracked symlink target/);
  assert.equal(existsSync(worktree), false);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("returns no worker changes when the provider leaves the checkout untouched", async (context) => {
  const repositoryRoot = createRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => rmSync(repositoryRoot, { force: true, recursive: true }));
  const provider: Provider = {
    async run() {
      return { response: "No changes needed.", stderr: "" };
    },
  };

  const result = await delegate({
    prompt: "Write a test",
    provider,
    repository,
    signal: new AbortController().signal,
    worktree,
  });

  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.patch.length, 0);
  assert.equal(result.response, "No changes needed.");
  assert.equal(existsSync(worktree), false);
});

test("refuses to seed a worker after cancellation without touching Git", async (context) => {
  const repositoryRoot = createRepository();
  const worktree = join(tmpdir(), `codex-delegate-worktree-${randomUUID()}`);
  const repository = discoverRepository(repositoryRoot);
  context.after(() => rmSync(repositoryRoot, { force: true, recursive: true }));
  const sourceState = captureRepositoryState(repositoryRoot);
  const controller = new AbortController();
  controller.abort(new RunCancelledError("signal"));
  const provider: Provider = {
    async run() {
      throw new Error("Provider must not run after cancellation.");
    },
  };

  await assert.rejects(
    delegate({ prompt: "Write a test", provider, repository, signal: controller.signal, worktree }),
    RunCancelledError,
  );
  assert.equal(existsSync(worktree), false);
  assertRepositoryState(repositoryRoot, sourceState);
});

test("installs Codex skills through the CLI and refuses without --force", (context) => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  const repository = createRepository();
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  context.after(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    rmSync(codexHome, { force: true, recursive: true });
    rmSync(repository, { force: true, recursive: true });
  });

  const first = runCli(repository, "install-skills");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /"installed":\["codex-delegate"/);

  const second = runCli(repository, "install-skills");
  assert.equal(second.status, 2);
  assert.match(JSON.parse(second.stdout).error as string, /already installed/);

  const forced = runCli(repository, "install-skills", "--force");
  assert.equal(forced.status, 0, forced.stderr);
});

test("rejects unknown agents through the run command", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const result = runCli(repository, "run", "Do the task.", "missing-agent", "--provider", "muse");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Agent profile not found: missing-agent/);
  assert.match(JSON.parse(result.stdout).error as string, /Agent profile not found: missing-agent/);
});

test("rejects invalid timeout and approval-mode flags through the run command", (context) => {
  const repository = createRepository();
  context.after(() => rmSync(repository, { force: true, recursive: true }));

  const timeoutResult = runCli(repository, "run", "Do the task.", "--timeout", "bogus");
  assert.notEqual(timeoutResult.status, 0);
  assert.match(timeoutResult.stderr, /Timeout must be a positive duration/);

  const approvalResult = runCli(repository, "run", "Do the task.", "--approval-mode", "sometimes");
  assert.notEqual(approvalResult.status, 0);
  assert.match(approvalResult.stderr, /Unsupported approval mode/);
});
