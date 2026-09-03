import type { Provider } from "./provider/provider.js";
import type { Repository } from "./repository.js";
import { collectWorktreeChanges, createSeededWorktree, removeWorktree } from "./worktree.js";

export type DelegationResult = {
  changedFiles: string[];
  patch: Buffer;
  providerStderr: string;
  response: string;
};

export async function delegate(
  repository: Repository,
  worktree: string,
  prompt: string,
  provider: Provider,
): Promise<DelegationResult> {
  const snapshot = createSeededWorktree(repository, worktree);

  try {
    const providerResult = await provider.run({
      prompt,
      workspaceRoot: snapshot.worktree,
    });
    const changes = collectWorktreeChanges(snapshot.worktree, snapshot.baseline);

    return {
      ...changes,
      providerStderr: providerResult.stderr,
      response: providerResult.response,
    };
  } finally {
    removeWorktree(repository, snapshot.worktree);
  }
}
