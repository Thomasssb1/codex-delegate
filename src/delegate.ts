import { rejectCancelledRun } from "./cancellation.js";
import type { Provider } from "./provider/provider.js";
import type { Repository } from "./repository.js";
import { collectWorktreeChanges, createSeededWorktree, removeWorktree, type SnapshotOptions } from "./worktree.js";

export type DelegationResult = {
  changedFiles: string[];
  patch: Buffer;
  providerStderr: string;
  response: string;
};

export type DelegationRequest = {
  onActivity?(): void;
  prompt: string;
  provider: Provider;
  repository: Repository;
  signal: AbortSignal;
  snapshotLimits?: SnapshotOptions;
  worktree: string;
};

export async function delegate(request: DelegationRequest): Promise<DelegationResult> {
  rejectCancelledRun(request.signal);
  const snapshot = createSeededWorktree(request.repository, request.worktree, request.snapshotLimits);

  try {
    request.onActivity?.();
    const providerResult = await request.provider.run({
      onActivity: request.onActivity,
      prompt: request.prompt,
      signal: request.signal,
      workspaceRoot: snapshot.worktree,
    });
    const changes = collectWorktreeChanges(snapshot.worktree, snapshot.baseline);

    return {
      ...changes,
      providerStderr: providerResult.stderr,
      response: providerResult.response,
    };
  } finally {
    removeWorktree(request.repository, snapshot.worktree);
  }
}
