---
name: codex-delegate-test
description: Add focused tests for an implementation change by delegating test work to an available subagent. (Codex orchestrator only; delegated workers must not use this skill.)
---

Use this skill after an implementation change that needs test coverage. Skip it for explanation-only or documentation-only requests, or when the user asks not to add tests.

If you are a delegated worker (your task arrived via a `codex-delegate run`), do not use this skill: do the work directly instead of delegating again.

Use the `codex-delegate` skill to list agents, choose one suited to testing the current change, and run it. Give the subagent the context it needs to test the observable behaviour and likely regressions.

Apply a returned patch only when it adds focused tests for the current change and contains no unrelated edits. After applying it, run the project checks that cover the changed code. Report those check results separately from the subagent's response.
