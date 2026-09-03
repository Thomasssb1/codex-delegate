---
name: codex-delegate
description: Delegate focused test writing to Muse after implementing a coding change, then inspect and apply an acceptable test patch.
---

# Delegate test writing to Muse

Use this skill after making an implementation change that would benefit from
tests. Skip it for a request that is only an explanation, a documentation edit,
or where the user asks not to add tests.

Run the bundled test writer from the project root. The command writes one JSON
object to stdout.

```bash
codex-delegate run "Write focused tests for the change I just made. Cover the observable behavior and likely regressions." test-writer --provider muse
```

Inspect the returned JSON before changing the source checkout.

- If it has `error`, do not apply a patch. Explain the failed delegation and
  continue the user's task without pretending Muse supplied tests.
- If `patch` is empty, inspect `response` and decide whether the change needs
  tests. Do not manufacture a patch from the response.
- If `patch` is present, read it. Apply it with normal patch tooling only when
  it adds focused tests for the current change and does not include unrelated
  edits.

After applying a patch, run the project checks that cover the changed code in
the source checkout. Report the result of those checks separately from Muse's
response.

Do not commit, push, or apply a Muse patch merely because the response says the
tests passed.
