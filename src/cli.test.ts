import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

test("codex-delegate prints a greeting", () => {
  const output = execFileSync(process.execPath, [cliPath], { encoding: "utf8" });

  assert.equal(output, "Hello, world!\n");
});
