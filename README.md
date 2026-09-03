# Codex Delegate

Codex Delegate lets Codex hand a bounded coding task to a Muse agent. The agent works in a temporary Git worktree, so it does not change your checkout. The CLI returns the agent's response and patch as JSON for Codex to inspect before applying anything.

It includes agents for writing tests and reviewing changes.

## Setup

You need Node.js 20 or later and a working `muse` command.

To use this checkout during development:

```sh
npm install
npm run build
npm link
codex-delegate install-skills
```

`npm link` puts `codex-delegate` on your global PATH. `install-skills` installs the bundled Codex skills under `~/.codex/skills`, so Codex can use them from any repository.

If you need to update the skills you can refresh the global copies:

```sh
codex-delegate install-skills --force
```

## Use it

From inside a Git repository, list the available agents:

```sh
codex-delegate agents
```

Run the test writer:

```sh
codex-delegate run "Add focused tests for the current changes." test-writer
```

The command prints JSON. On success it includes a `patch` and `response`. On failure it includes `error` and any provider `stderr`.

Codex can use the installed `codex-delegate-test` and `codex-delegate-review` skills to delegate test writing or review work automatically.

## Project agents

Add a file such as `.codex-agents/api-tester.md` to give a project its own agent. Project agents override bundled agents with the same name.

```md
---
name: api-tester
description: Test the API changes.
provider: muse
model: muse-spark-1.3
---

Write focused tests for the requested API behaviour. Do not change production code.
```
