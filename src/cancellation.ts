export const DEFAULT_INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;

export class RunCancelledError extends Error {
  constructor(
    readonly cause: "inactivity" | "signal",
  ) {
    super(cause === "inactivity" ? "The provider stopped reporting activity." : "The run was interrupted.");
    this.name = "RunCancelledError";
  }
}

type SignalEmitter = {
  off(event: "SIGINT", listener: () => void): unknown;
  once(event: "SIGINT", listener: () => void): unknown;
};

export type RunCancellation = {
  dispose(): void;
  onActivity(): void;
  signal: AbortSignal;
};

export function createRunCancellation(
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
  signalEmitter: SignalEmitter = process,
): RunCancellation {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new RunCancelledError("signal"));
  let timeout: NodeJS.Timeout | undefined;
  const onActivity = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(new RunCancelledError("inactivity")), inactivityTimeoutMs);
  };

  signalEmitter.once("SIGINT", interrupt);

  return {
    dispose() {
      clearTimeout(timeout);
      signalEmitter.off("SIGINT", interrupt);
    },
    onActivity,
    signal: controller.signal,
  };
}

export function rejectCancelledRun(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new RunCancelledError("signal");
  }
}
