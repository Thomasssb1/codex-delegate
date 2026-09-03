---
name: codex-delegate-review
description: Review an implementation change by delegating review work to an available subagent.
---

Use this skill when a change is ready for an independent review.

Use the `codex-delegate` skill to list agents, choose one suited to reviewing the current change, and run it. Give the subagent the context it needs to inspect the implementation and any related test changes.

Read the returned JSON. Address a concrete finding, or explain why it does not require a change. If the delegation returns `error`, report that the change was not reviewed.
