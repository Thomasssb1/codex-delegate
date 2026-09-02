import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAcceptedProviders } from "./providers.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

function runCli(...arguments_: string[]) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    encoding: "utf8",
  });
}

test("loads accepted providers from JSON", () => {
  assert.deepEqual(loadAcceptedProviders(), ["muse"]);
});

test("accepts a positional task for Muse", () => {
  const result = runCli(
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

test("rejects providers other than Muse", () => {
  const result = runCli("run", "test-writer", "--provider", "other", "Write a test");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported provider: other\. Supported providers: muse\./);
});

test("requires one non-empty positional task", () => {
  const result = runCli("run", "test-writer", "--provider", "muse");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /error: missing required argument 'task'/);
});
