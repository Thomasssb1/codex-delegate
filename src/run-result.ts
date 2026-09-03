import type { DelegationResult } from "./delegate.js";

export type RunResult = {
  error?: string;
  patch?: string;
  response?: string;
  stderr: string;
};

export function createRunResult(delegation: DelegationResult): RunResult {
  return {
    patch: delegation.patch.toString("utf8"),
    response: delegation.response,
    stderr: delegation.providerStderr,
  };
}

export function createFailedRunResult(error: string, stderr = ""): RunResult {
  return { error, stderr };
}
