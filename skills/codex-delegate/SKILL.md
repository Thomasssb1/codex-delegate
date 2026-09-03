---
name: codex-delegate
description: Delegate a bounded coding task to an available subagent.
---

Use this skill when another workflow needs an isolated subagent run.

`codex-delegate agents` lists the available agents. Choose one suited to the current task. `codex-delegate run` spawns a subagent. Use `--help` for command syntax.

Inspect the returned JSON before changing the source checkout.

- If it has `error`, do not apply a patch. Report the failed delegation and continue the calling workflow without pretending it succeeded.
- If `patch` is absent or empty, inspect `response` and continue the calling workflow.
- If `patch` is present, read it. Apply it with normal patch tooling only when it is appropriate for the calling workflow and does not include unrelated edits.

Do not commit, push, or apply a patch merely because the response says it is correct.
