export const DEFAULT_RUN_TIMEOUT_MS = 20 * 60 * 1000;

export class RunCancelledError extends Error {
  constructor(
    readonly cause: "signal" | "timeout",
  ) {
    super(cause === "timeout" ? "The run timed out." : "The run was interrupted.");
    this.name = "RunCancelledError";
  }
}

type SignalEmitter = {
  off(event: "SIGINT", listener: () => void): unknown;
  once(event: "SIGINT", listener: () => void): unknown;
};

export type RunCancellation = {
  dispose(): void;
  signal: AbortSignal;
};

export function createRunCancellation(
  timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  signalEmitter: SignalEmitter = process,
): RunCancellation {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new RunCancelledError("signal"));
  const timeout = setTimeout(() => controller.abort(new RunCancelledError("timeout")), timeoutMs);

  signalEmitter.once("SIGINT", interrupt);

  return {
    dispose() {
      clearTimeout(timeout);
      signalEmitter.off("SIGINT", interrupt);
    },
    signal: controller.signal,
  };
}

export function rejectCancelledRun(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new RunCancelledError("signal");
  }
}
