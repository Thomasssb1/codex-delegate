# Codex Delegate implementation plan

## Goal

Build `codex-delegate`, a provider-neutral CLI that lets Codex hand a bounded coding task to an external agent, run that agent in an isolated Git worktree, and return a reviewable result without changing the caller's checkout.

The first release will support Muse Code through `@muse-code/sdk`. The provider contract must be stable enough to add Claude Code, Gemini CLI, OpenCode, and custom command adapters later without changing the run pipeline or the Codex skill.

## What v0.1 must prove

A useful first release needs to prove the isolation and handoff model, not the size of the provider list.

The release is done when all of these are true:

- `codex-delegate run test-writer "Write tests for the current changes" --provider muse --json` runs in a detached worktree and never edits the caller's checkout.
- The worker sees the caller's committed files, staged changes, unstaged tracked changes, and non-ignored untracked files.
- The generated patch contains only the worker's changes. It does not repeat the caller's pre-existing changes.
- `codex-delegate apply <run-id>` checks the saved patch before applying it and never stages or commits the result.
- Review profiles can return a typed verdict and findings without being allowed to change files.
- Machine output is versioned JSON on stdout. Human progress and diagnostics go to stderr.
- Every run leaves a manifest, patch, final response, verification output, and event log under `.codex-delegate/runs/<run-id>/`.
- Worktrees are removed after artifacts are captured, including on provider failure and interruption. `--keep-worktree` is an explicit debugging escape hatch.
- A bundled Codex skill teaches Codex to invoke the CLI, inspect the result, and verify a patch before applying it.
- Unit and Git integration tests pass on Node 20 and 22 on macOS and Linux.

## Scope

### Included in v0.1

- TypeScript ESM CLI for Node 20 or newer
- Muse Code provider using `@muse-code/sdk`
- Markdown agent profiles with validated YAML front matter
- Bundled `test-writer` and `reviewer` profiles
- Git worktree creation, dirty-state seeding, patch generation, and cleanup
- Positional task text, `--task <file>`, and stdin task input
- Change-policy checks based on changed paths
- Profile-owned verification commands expressed as argument arrays
- Human and JSON output modes
- `init`, `init codex`, `providers`, `run`, and `apply` commands
- Graceful cancellation on timeout, `SIGINT`, and `SIGTERM`
- A publishable npm package and basic CI

### Deferred

- Claude Code, Gemini CLI, OpenCode, and arbitrary command providers
- Parallel fanout and orchestration across several external agents
- Long-running session resume, steering, and background execution
- A general interactive approval UI
- Windows support
- Non-Git repositories and repositories without an initial commit
- Copying ignored files such as dependency directories into a worktree
- Automatic dependency installation
- Automatic merging, committing, or pushing
- A `doctor` command and stale-run garbage collection
- Native Muse subagent fanout inside a delegated run

## Product decisions

These decisions remove ambiguities in the original concept.

1. **One provider, provider-neutral core.** Muse is the only v0.1 adapter. Git handling, profiles, policy checks, verification, output, and cleanup stay outside that adapter.
2. **Worktree isolation is mandatory.** There is no shared-filesystem write mode in v0.1. Review runs use the same isolated snapshot and reject any worker-authored file change.
3. **Markdown owns the instructions.** An agent is one `.md` file with YAML front matter. This avoids separate YAML and Markdown files drifting apart.
4. **The caller's dirty state is input, not output.** The run snapshots it into the worker and records a private baseline commit there. The final patch is the difference between that baseline and the worker's final state.
5. **Ignored files stay out.** The snapshot includes non-ignored untracked files but not ignored files. This avoids copying `.env`, caches, build output, and dependency trees by surprise.
6. **Structured facts come from the wrapper.** Git supplies changed files, the process runner supplies verification results, and the provider supplies session state. The agent's final prose is parsed as an optional typed report and retained verbatim if parsing fails.
7. **Headless runs fail closed.** Muse sessions start with `denyUnmatched` unless a profile or CLI flag selects another supported Muse approval mode. `allowAll` requires an explicit CLI flag and prints a warning to stderr.
8. **Applying is a separate action.** A successful run saves a patch but does not touch the source checkout. `apply` verifies the artifact hash and runs `git apply --check` before `git apply`.
9. **No shell strings in profiles.** Verification commands are arrays such as `["npm", "test", "--", "src/foo.test.ts"]`. The process runner invokes them without a shell.
10. **Runtime data is local and ignored.** Shareable configuration lives in `.codex-delegate.yml` and `.codex-agents/`. Ephemeral worktrees and run artifacts live in `.codex-delegate/`, which the tool makes self-ignoring.

## Command contract

### Initialize a repository

```bash
codex-delegate init
```

Create these files only when they do not already exist:

```text
.codex-delegate.yml
.codex-agents/test-writer.md
.codex-agents/reviewer.md
.codex-delegate/.gitignore
```

The runtime `.gitignore` contains `*`, so run artifacts do not appear in the repository's status. `init` must never overwrite an existing profile or config unless the user passes `--force`. It must print every created, skipped, or replaced path.

### Install the Codex skill

```bash
codex-delegate init codex --scope project
codex-delegate init codex --scope user
```

- Project scope writes `.codex/skills/codex-delegate/SKILL.md` in the repository.
- User scope writes the equivalent skill under the user's Codex skills directory.
- User-scope installation happens only after the user explicitly selects it.
- The command uses an atomic temporary-file rename and refuses to replace a different file without `--force`.
- Confirm both destinations against current official Codex documentation before release. Keep the destination resolver in one module so a Codex layout change does not affect the rest of the CLI.

### List providers

```bash
codex-delegate providers
codex-delegate providers --json
```

The Muse probe checks:

- whether the configured `muse` binary resolves
- its version, when available
- whether `muse serve` can complete an SDK handshake
- the SDK schema-fingerprint warning
- whether the configured approval mode is one the installed SDK knows

The probe must not start a session or run a model turn. Authentication that can only be proven by a turn is reported as `unknown`, not `ready`.

### Run an agent

```bash
codex-delegate run test-writer \
  --provider muse \
  "Write tests for the current changes"

codex-delegate run test-writer \
  --provider muse \
  --task task.md \
  --json

codex-delegate run reviewer --review-only --json <<'TASK'
Review the current changes for correctness and regressions.
TASK
```

Accepted task sources are one positional string, one `--task <file>`, or non-TTY stdin. Supplying more than one is a usage error. An empty task is also a usage error.

`run` options in v0.1:

```text
--provider <name>          Override the profile and repository default
--task <path>              Read the task from a UTF-8 file
--review-only              Reject every worker-authored file change
--json                     Emit the result envelope as JSON on stdout
--timeout <duration>       Override the profile timeout
--approval-mode <mode>     Select a Muse-supported approval mode
--allow-all                Required in addition to approval-mode=allowAll
--keep-worktree            Retain the generated worktree for debugging
--model <name>             Ask the provider for a specific model
```

`--review-only` is a stricter runtime policy. It cannot be weakened by an agent profile.

### Apply a saved patch

```bash
codex-delegate apply <run-id> --check
codex-delegate apply <run-id>
```

`--check` performs every validation but makes no change. A real apply:

1. Resolves the run only under the current repository's runtime directory.
2. Validates the run-id format and prevents path traversal.
3. Confirms the manifest belongs to the current repository.
4. Recomputes the patch SHA-256 and compares it with the manifest.
5. Refuses patches with recorded change-policy violations.
6. Detects an already-applied patch with a reverse check.
7. Runs `git apply --check --binary`.
8. Runs `git apply --binary` only after the check passes.
9. Records `appliedAt` in the run manifest with an atomic write.

The command does not use `--index`, commit, or alter existing staging state.

## Agent profile format

Profiles resolve in this order:

1. `.codex-agents/<name>.md` in the current repository
2. bundled profiles shipped with the npm package

No user-global profile layer is needed in v0.1. Add one later only if real use shows that repository overrides and bundled defaults are insufficient.

Example:

```markdown
---
name: test-writer
description: Add tests for an existing implementation.
provider: muse
mode: write
output: change
timeoutMinutes: 20
approvalMode: denyUnmatched
changes:
  allow:
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/test/**"
    - "**/tests/**"
  deny: []
verification:
  commands: []
---

Test the implementation described in the task.

Cover observable behavior, regressions, boundary cases, and failures. Do not
change production code. Do not commit. Finish with the JSON report requested by
the run instructions.
```

Validate front matter with a strict schema. Reject unknown keys so typos do not silently disable a policy. Validate profile names against `[a-z0-9][a-z0-9-]{0,63}`. Resolve all path globs relative to the worker root.

Supported output types:

- `change` asks for `{ "summary": string, "notes": string[] }`.
- `review` asks for `{ "verdict": "approved" | "changes_requested", "summary": string, "findings": Finding[] }`.

A finding contains `severity`, `file`, optional `line`, and `message`. The orchestrator adds the expected JSON schema to the end of the prompt. If the final answer is not valid JSON, retain it in `response.txt`, set `report.parsed` to `false`, and return `success_with_warnings` if the provider and verification otherwise succeeded.

## Repository configuration

Initial `.codex-delegate.yml`:

```yaml
defaultProvider: muse
runtimeDir: .codex-delegate
snapshot:
  includeUntracked: true
  maxFiles: 10000
  maxBytes: 52428800
muse:
  binary: muse
  approvalMode: denyUnmatched
```

Precedence is CLI flag, agent profile, repository config, built-in default. Validate the fully merged configuration before creating a run directory.

The runtime directory must be inside the repository, must not be a symlink, and must not contain tracked files. Refuse to run if those checks fail. This reserves `.codex-delegate/` for local state and avoids accidentally placing a generated worktree over user content.

## Core types

Keep provider-specific SDK types at the adapter boundary.

```ts
interface AgentProvider {
  readonly name: string;
  probe(context: ProviderProbeContext): Promise<ProviderProbeResult>;
  run(context: ProviderRunContext): Promise<ProviderRunResult>;
}

interface ProviderRunContext {
  cwd: string;
  prompt: string;
  model?: string;
  approvalMode: ApprovalMode;
  timeoutMs: number;
  signal: AbortSignal;
  onEvent(event: ProviderEvent): void;
}

interface ProviderRunResult {
  status: "completed" | "cancelled" | "failed";
  finalText: string;
  sessionId?: string;
  model?: string;
  usage?: TokenUsage;
  warnings: string[];
  error?: SerializableError;
}
```

`ProviderRunResult` deliberately has no changed-file or test fields. The orchestrator derives those after the provider exits.

## Run result schema

Version every machine-readable result from the first release. JSON mode writes exactly one envelope to stdout and ends it with a newline.

```json
{
  "schemaVersion": 1,
  "runId": "20260902T235300Z-a1b2c3",
  "status": "success",
  "provider": {
    "name": "muse",
    "sessionId": "...",
    "model": "muse-spark",
    "warnings": []
  },
  "agent": {
    "name": "test-writer",
    "mode": "write"
  },
  "source": {
    "head": "<commit>",
    "baseline": "<private worker commit>",
    "includedDirtyState": true
  },
  "report": {
    "parsed": true,
    "summary": "Added duplicate and disconnect handling tests.",
    "notes": []
  },
  "changes": {
    "files": [
      { "path": "src/foo.test.ts", "status": "added" }
    ],
    "patch": ".codex-delegate/runs/<run-id>/changes.patch",
    "sha256": "..."
  },
  "policy": {
    "status": "passed",
    "violations": []
  },
  "verification": [
    {
      "argv": ["npm", "test"],
      "status": "passed",
      "exitCode": 0,
      "durationMs": 1234,
      "stdoutPath": "verification/01.stdout.log",
      "stderrPath": "verification/01.stderr.log"
    }
  ],
  "artifacts": {
    "manifest": ".codex-delegate/runs/<run-id>/manifest.json",
    "events": ".codex-delegate/runs/<run-id>/events.jsonl",
    "response": ".codex-delegate/runs/<run-id>/response.txt",
    "providerStderr": ".codex-delegate/runs/<run-id>/provider.stderr.log"
  },
  "cleanup": {
    "worktreeRemoved": true
  },
  "timing": {
    "startedAt": "2026-09-02T23:53:00.000Z",
    "finishedAt": "2026-09-02T23:53:05.000Z",
    "durationMs": 5000
  }
}
```

Use repository-relative artifact paths in output. Never treat a model-reported test count as verified. A count may be added later only when a verification adapter can parse a known test format.

Run statuses:

```text
success
success_with_warnings
invalid_task
provider_unavailable
provider_failed
timed_out
cancelled
snapshot_failed
policy_failed
verification_failed
internal_error
```

Suggested process exit codes:

```text
0  success or success_with_warnings
2  usage, task, profile, or configuration error
3  provider unavailable or authentication failure
4  provider failed, timed out, or was cancelled
5  Git snapshot, patch, policy, or verification failure
6  apply check failed or patch already applied
1  unexpected internal error
```

## Worktree and patch algorithm

This is the highest-risk part of the project and should be built before the real provider adapter.

### Preconditions

- Resolve the repository root with `git rev-parse --show-toplevel`.
- Require a non-bare repository with a valid `HEAD` commit.
- Refuse to run from inside the reserved runtime directory.
- Record the source repository identity from its absolute common Git directory and initial `HEAD`.
- Check snapshot file and byte limits before copying anything.
- Exclude ignored files and the runtime directory.

### Create the worker baseline

1. Create `.codex-delegate/runs/<run-id>/` with owner-only permissions where the platform supports them.
2. Record the initial run manifest using an atomic write and rename.
3. Capture tracked staged and unstaged changes with a binary diff against `HEAD`.
4. List non-ignored untracked files with a NUL-delimited Git command.
5. Create `.codex-delegate/worktrees/<run-id>/` with:

   ```bash
   git worktree add --detach --lock --reason codex-delegate:<run-id> <path> HEAD
   ```

6. Apply the tracked diff inside the worker.
7. Copy each approved untracked file without following directory symlinks. Preserve regular-file mode and symlink targets.
8. Stage the seeded state and create a private baseline commit in the detached worktree. Disable signing and hooks and supply a tool-owned author identity for this commit.
9. Record both the source `HEAD` and the private baseline commit.

The private commit changes only the worker's detached `HEAD`. It does not create a branch or move any source ref. Its objects may remain unreachable in the shared object database until Git prunes them.

The worker is now clean. A reviewer can inspect the caller's original dirty state with `git diff <source-head>..HEAD`, while final patch generation can cleanly exclude that state.

### Finalize the worker

1. Stop the provider and close its SDK connection.
2. Run configured verification commands in the worker, recording output and duration.
3. Stage the worker's complete final state. This is safe because the checkout is disposable and it also captures agents that committed their own changes.
4. Generate `changes.patch` with a binary diff from the private baseline commit to the staged final tree.
5. Generate the changed-file list from the same two states with NUL-delimited output.
6. Validate each changed path against the profile policy. In review-only mode, any changed path is a violation.
7. Compute the patch SHA-256 and finish the manifest.
8. Unlock and remove the exact registered worktree with `git worktree remove --force`.

Cleanup must resolve and compare the registered worktree path before using `--force`. Never build a deletion target from an unchecked run id, glob, or environment variable.

### Failure behavior

- If seeding fails, remove the incomplete worktree and return `snapshot_failed`.
- If the provider fails, still capture any worker changes and logs, then return `provider_failed`.
- If verification fails, retain the patch and return `verification_failed`. Applying it remains blocked by the manifest.
- If policy fails, retain the patch for inspection and return `policy_failed`. `apply` refuses it.
- If cleanup fails, preserve the worktree path in the manifest, return a warning, and print the exact recovery command. Do not silently report successful cleanup.
- If the process receives `SIGINT` or `SIGTERM`, abort the provider, wait for its terminal event up to a short deadline, finalize artifacts, and clean the worktree before exiting.

## Muse provider

Pin the Developer Preview SDK to an exact version in `package.json`. The current repository reports `@muse-code/sdk` 0.1.1, but the implementation phase must confirm the published version before installing it. Do not use a caret range until the SDK has a compatibility promise that covers minor releases.

Implementation flow:

1. Resolve the `muse` binary from the configured command or absolute path.
2. Spawn the host through `MuseClient.spawn` or the lower-level `spawnMspConnection`, with the worker as `cwd` and a copied process environment.
3. Complete the handshake and record server info, durability, and schema-fingerprint warnings.
4. Subscribe to notifications before starting the session so early events are not lost.
5. Start a session rooted at the worker with the chosen approval mode.
6. Start one turn with the assembled prompt.
7. Fold streamed items into a final response and persist normalized provider events to `events.jsonl` as they arrive.
8. Treat the turn's terminal value as authoritative. Unknown terminal values are terminal failures, not success.
9. On `AbortSignal`, issue `turn/cancel`, wait for `turn/completed` for a bounded period, then close the host.
10. Always drain raw host stderr into its artifact file. Do not parse stderr as protocol data.

Approval handling:

- The default `denyUnmatched` mode prevents a headless run from parking forever on an approval request.
- If an approval request still arrives, record it and deny it. Never invent a choice id or auto-approve an unknown subject kind.
- Support only the SDK's named modes: `allowAll`, `promptUnmatched`, `onRequest`, and `denyUnmatched`.
- `promptUnmatched` and `onRequest` are unsuitable for a non-interactive v0.1 run unless the adapter has an explicit deterministic denial handler.
- Never pass `--yolo` or `--disable-sandbox` on the user's behalf.

The worktree prevents file collisions. It is not a security sandbox. Muse's own containment should remain enabled, and the README must state the difference clearly.

## Prompt assembly

Build the provider prompt from fixed sections in this order:

1. Agent profile instructions
2. User task, fenced with explicit begin and end markers
3. Repository facts, including source commit and whether dirty state was included
4. Execution rules: work only in the current checkout, do not commit, and do not modify `.git` or `.codex-delegate`
5. Review context, when applicable, with the command needed to inspect the original changes
6. Required final JSON schema

Store the exact assembled prompt in the run directory. Mark it as sensitive in the documentation because tasks and repository context may contain private information.

Do not claim prompt instructions enforce permissions. The worktree boundary, Muse sandbox, post-run path policy, and separate apply step are the controls.

## Project layout

```text
codex-delegate/
├── src/
│   ├── cli.ts
│   ├── commands/
│   │   ├── apply.ts
│   │   ├── init.ts
│   │   ├── providers.ts
│   │   └── run.ts
│   ├── core/
│   │   ├── delegate.ts
│   │   ├── prompt.ts
│   │   ├── result.ts
│   │   └── errors.ts
│   ├── agents/
│   │   ├── loader.ts
│   │   ├── policy.ts
│   │   └── schema.ts
│   ├── providers/
│   │   ├── provider.ts
│   │   ├── registry.ts
│   │   └── muse.ts
│   ├── git/
│   │   ├── repository.ts
│   │   ├── snapshot.ts
│   │   ├── worktree.ts
│   │   ├── patch.ts
│   │   └── apply.ts
│   ├── runs/
│   │   ├── ids.ts
│   │   ├── manifest.ts
│   │   └── store.ts
│   └── process/
│       └── runner.ts
├── agents/
│   ├── reviewer.md
│   └── test-writer.md
├── skills/
│   └── codex-delegate/
│       └── SKILL.md
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── .github/workflows/ci.yml
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

Use npm, TypeScript strict mode, ESM, a small CLI parser, YAML parsing, runtime schema validation, and a glob matcher. Wrap `child_process.spawn` once instead of letting Git and verification code invent separate process behavior.

## Implementation sequence

Build this as a series of usable slices. A slice adds the code and structure needed for its acceptance example. It should not add a registry, schema, command, or directory merely because a later slice may want one. Keep a type beside its first consumer and extract it only when another consumer appears.

Tests arrive with the behavior they protect. Do not create a complete fixture system before the first test needs it.

### Slice 1: delegate one change from a clean repository

Start with the shortest complete path through the product:

```bash
codex-delegate run test-writer \
  --provider muse \
  "Add a test for the empty input case" \
  --json
```

- Create only the package files needed to build and run the CLI: `package.json`, `tsconfig.json`, the bin entry, and a test command.
- Implement positional task input and the `run` command for the single accepted provider name, `muse`.
- Add a small bundled `test-writer` prompt. It does not need a general profile loader yet.
- Discover the Git root and require a clean repository with a valid `HEAD`.
- Create one detached worktree at `HEAD`, run Muse there, capture the final response, create a binary patch against `HEAD`, and remove the worktree.
- Pin `@muse-code/sdk` exactly. Implement the handshake, session, turn, terminal-event handling, cancellation, and clean shutdown needed by this path.
- Add a fixed default timeout and handle `SIGINT` so the first real run cannot leave Muse or a worktree running indefinitely.
- Introduce the narrow provider interface when the orchestrator needs a test double. Do not add a provider registry or capability system yet.
- Assign a run id and save the response, patch, and provider stderr under `.codex-delegate/runs/<run-id>/`.
- Emit `schemaVersion`, run status, provider, agent, changed files, patch path, cleanup result, and timing as JSON. Send progress to stderr.
- Test the path with a fake provider and a temporary clean Git repository. Keep the test helper local until a second test needs it.

Exit criteria: the command completes a real opt-in Muse run in a clean temporary repository, returns a patch, leaves the source checkout unchanged, and removes its worktree after success or cancellation.

### Slice 2: apply the returned change

The first slice returns a patch. The next requirement is a safe way to use it.

- Add the run manifest fields that `apply` needs: repository identity, source commit, patch hash, run status, and artifact paths.
- Write manifests atomically because `apply` must never read half-written state.
- Implement `codex-delegate apply <run-id> --check` and `codex-delegate apply <run-id>`.
- Validate the run id, repository identity, run status, and patch SHA-256.
- Detect an already-applied patch, run `git apply --check --binary`, and apply only after that succeeds.
- Keep the caller's index and branch untouched.
- Add integration tests for successful apply, check-only, conflicts, a changed hash, the wrong repository, and an already-applied patch.

Exit criteria: a user can delegate a change, inspect the patch, apply it through the CLI, and see only unstaged working-tree changes in the source checkout.

### Slice 3: include the caller's current work

The clean-repository restriction now becomes the next concrete limitation to remove.

- Capture staged and unstaged tracked changes as a binary diff from `HEAD`.
- List non-ignored untracked files with NUL-delimited Git output.
- Seed the worktree with those changes and create the private baseline commit described in the worktree algorithm.
- Generate the worker patch from that baseline instead of from the source `HEAD`.
- Add the file-count and byte limits when untracked files first make unbounded copying possible.
- Add the runtime-directory and symlink checks needed before copying files.
- Generalize the Git test helper only now, when the cases need shared setup.
- Cover staged, unstaged, renamed, deleted, binary, executable, symlink, ignored, and non-ignored untracked files.
- Prove that the source `HEAD`, index, files, and `git status` stay unchanged and that the saved patch excludes the seeded changes.
- Extend `apply` tests to cover a dirty source checkout and a conflict caused by source drift after the run.

Exit criteria: the original example works on an in-progress repository, and the patch contains only work performed by the external agent.

### Slice 4: make tasks reusable and automation-friendly

Once one hard-coded test writer works, repositories need to describe their own workers and Codex needs safer input than a quoted argument.

- Replace the bundled prompt lookup with the Markdown profile loader and strict YAML front-matter schema.
- Keep the existing bundled `test-writer` behavior as the default profile.
- Add `.codex-agents/<name>.md` overrides.
- Add `--task <file>` and non-TTY stdin. Reject multiple or empty task sources.
- Add `.codex-delegate.yml` only for values now configurable by profiles or flags, including the default provider, runtime path, snapshot limits, Muse binary, timeout, model, and approval mode.
- Implement configuration precedence when the repository config exists: CLI, profile, repository, built-in default.
- Add `codex-delegate init` because users now have configuration and profile files worth generating.
- Make initialization idempotent and refuse overwrites without `--force`.
- Add only the runtime validation used by these fields. Reject unknown profile and config keys.

Exit criteria: a repository can define a custom agent, initialize the required files, and supply a multiline task through a file or stdin without changing the run behavior from the earlier slices.

### Slice 5: support review and enforce change boundaries

Profiles now exist, so a second behavior can require the general policy and output machinery.

- Add the bundled `reviewer` profile and the `review` output type.
- Add `--review-only` and reject every worker-authored file change in that mode.
- Add profile `changes.allow` and `changes.deny` rules because the test-writer now needs a checkable file boundary.
- Build the full prompt assembler when it has to handle profile instructions, task delimiters, repository facts, review context, execution rules, and the selected output schema.
- Parse `change` and `review` reports. Preserve malformed output in `response.txt` and return `success_with_warnings` rather than inventing structured fields.
- Add `policy` and `report` to the result and manifest now that runs can populate them.
- Block `apply` when a run has policy violations.
- Test approved review, requested changes, malformed reports, a review that edits files, allowed test edits, and denied production edits.

Exit criteria: the reviewer returns a typed verdict without changing files, and the test writer cannot produce an applicable patch outside its configured path rules.

### Slice 6: run verification and retain useful failure evidence

With change and review flows working, add the evidence needed to trust and debug them.

- Add profile-owned verification command arrays and execute them without a shell.
- Record each command's arguments, exit code, duration, stdout, and stderr. Populate `verification` only from these runs.
- Add the remaining result statuses and stable process exit-code mapping as their failure paths become possible.
- Expand the manifest into the crash-tolerant states `created`, `snapshotted`, `running`, `finalizing`, and `finished`.
- Write provider events to `events.jsonl` as they arrive. Add fingerprint, host-exit, approval, usage, and terminal records when those records become useful for a failed run.
- Capture a partial worker patch after provider failure, timeout, or cancellation when Git remains usable.
- Add `--keep-worktree` for debugging and record the retained path.
- Set owner-only permissions on run directories and document that their contents may be sensitive.
- Report exact manual recovery instructions when cleanup fails.
- Test verification failure, malformed agent output, provider failure, timeout, cancellation, an agent-created commit, an empty patch, and cleanup failure.

Exit criteria: every run either succeeds with independently recorded verification or fails with enough local evidence to explain what happened. No failure is reported as success merely because the agent said its tests passed.

### Slice 7: expose the finished workflow to Codex

The CLI behavior is now stable enough to teach another agent to use it.

- Add `codex-delegate providers` and the provider registry it now requires.
- Implement the non-mutating Muse probe for the binary, version, SDK handshake, fingerprint warning, and locally recognized approval mode.
- Add `codex-delegate init codex --scope project` and `--scope user` after verifying the current official install destinations.
- Write the Codex skill so it requests JSON, checks `status`, `policy`, and `verification`, inspects the patch, applies only an acceptable run, and reruns relevant checks in the source checkout.
- Write README examples for positional, file, stdin, review-only, apply, and retained-worktree workflows.
- Document the worktree and sandbox distinction, ignored files, approval modes, artifact sensitivity, SDK preview risk, and unsupported repositories.

Exit criteria: a fresh user can install the package, initialize a repository, delegate through Codex, inspect the result, and apply an acceptable patch using only the README and bundled skill.

### Slice 8: prepare the package for release

- Run the full suite on Node 20 and 22 on Ubuntu and macOS.
- Add the remaining hostile-path cases: spaces, Unicode, newlines, and leading dashes.
- Verify behavior with Git hooks, commit signing enabled, Git LFS pointers, and invocation from a subdirectory.
- Verify normal JSON output does not expose absolute home paths or secrets unless an error itself contains them.
- Add the license, security policy, changelog, package provenance, and release checklist when the package is ready to publish.
- Pack the tarball and test its executable, bundled profiles, bundled skill, type declarations, and source maps from a clean temporary install.

Exit criteria: `npm pack` produces a self-contained package, every required check passes, and the v0.1 limitations are explicit.

## Test matrix

### Unit tests

- task-source exclusivity and UTF-8 handling
- configuration precedence and unknown-key rejection
- profile lookup, schema validation, and output-schema selection
- prompt construction and delimiter escaping
- provider registry and error mapping
- result status and process exit-code mapping
- final-response JSON parsing with raw fallback
- path-policy matching and review-only behavior
- run-id validation and path traversal rejection
- atomic manifest updates

### Git integration tests

Create a fresh temporary repository for every case and compare source state before and after:

- clean checkout
- staged edit
- unstaged edit
- staged plus unstaged edits to the same file
- added, deleted, and renamed tracked files
- non-ignored untracked file
- ignored file that must not be copied
- binary file
- executable-bit change
- symlink without following its target
- filename with spaces, Unicode, leading dash, and newline
- snapshot over file-count and byte limits
- provider edits a seeded file
- provider adds and deletes files
- provider commits before returning
- empty worker change
- change-policy violation
- verification failure
- interrupted run
- forced cleanup failure
- apply success, conflict, tampered hash, wrong repository, and already-applied patch

### Muse tests

- adapter unit tests against recorded SDK events
- missing binary
- host exits during handshake
- schema-fingerprint warning
- turn completed, failed, cancelled, and unknown terminal value
- approval request denied without hanging
- malformed final report
- opt-in live test behind `MUSE_E2E=1`

Live Muse tests must never run in ordinary CI or require maintainer credentials for pull requests.

## Risks and mitigations

### Muse SDK preview churn

The SDK is pre-1.0 and currently makes no minor-version stability promise. Pin it exactly, isolate imports in `providers/muse.ts`, test against recorded events, and upgrade only through a dedicated compatibility pull request.

### Dirty snapshot correctness

This is easy to get almost right and still lose modes, binaries, symlinks, or unusual filenames. Use NUL-delimited Git output, binary patches, temporary-repository integration tests, and a private baseline commit. Do not parse human Git output.

### Worktree cleanup

An interrupted process can leave linked-worktree metadata. Lock the worktree during the run, store its exact path immediately, remove it through Git, and report a precise recovery command if cleanup fails. Add stale-run cleanup only after the manifest format has settled.

### False confidence from isolation

A Git worktree prevents normal file collisions but does not contain processes, network access, credential reads, or writes outside the checkout. Keep Muse's sandbox enabled, default approvals to deny, and state this plainly in the README and skill.

### Unavailable dependencies in a new worktree

Ignored dependency directories do not appear in the worker. The provider may use an existing package-manager cache, but v0.1 will not copy dependencies or enable network access automatically. Verification failures must explain this likely cause and preserve logs.

### Agent output is not reliable telemetry

An agent may claim tests passed or return malformed JSON. Treat the final response as a report, not proof. Only wrapper-run commands populate `verification`, and invalid reports remain inspectable without being silently normalized.

### Sensitive artifacts

Prompts, model responses, command output, and diffs can contain secrets. Keep the runtime ignored, set restrictive permissions, avoid sending artifacts to telemetry, and provide a documented manual removal command. Automatic content redaction is out of scope because a partial redactor would give false confidence.

## Follow-up releases

### v0.2

- `doctor`
- Claude Code, Gemini CLI, OpenCode, and command adapters
- provider capability reporting
- stale-run and orphaned-worktree cleanup
- optional user-global agent profiles
- profile-specific verification result parsers
- explicit copy or setup hooks for ignored dependency artifacts

### v0.3

- bounded parallel delegation
- run inspection and resume commands
- interactive approval forwarding
- provider conformance tests that third-party adapters can reuse
- Windows support if provider and Git behavior can meet the same guarantees

## Reference checks made for this plan

- The [Muse Code SDK repository](https://github.com/meta-models/muse-code-sdk) documents Node 20+, the `muse` host requirement, the Developer Preview status, and the current package layout.
- The [Muse SDK quickstart](https://meta-models.github.io/muse-code-sdk/guides/quickstart/) documents host spawning, early notification subscription, sessions, turns, terminal events, cancellation, and clean shutdown.
- The [Muse approvals guide](https://meta-models.github.io/muse-code-sdk/guides/msp-concepts/approvals/) documents the named approval modes and recommends a default-deny mode for non-interactive runs.
- Meta's [contained execution recipe](https://github.com/meta-models/meta-model-cookbook/blob/main/04_muse_code/04_contained_execution/README.md) distinguishes workspace permissions from OS-level sandbox enforcement.
- The [Git worktree documentation](https://git-scm.com/docs/git-worktree) documents detached worktrees, locking, stable porcelain output, and removal behavior.

Recheck these integration points when implementation begins and again before publishing. Both the Muse SDK and Codex skill conventions can change independently of this repository.
