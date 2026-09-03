export const NESTING_ENV_VAR = "CODEX_DELEGATE_ACTIVE";

export function isNestedRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NESTING_ENV_VAR] === "1";
}

export function nestedWorkerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [NESTING_ENV_VAR]: "1" };
}

export function nestedRunRefusal(): string {
  return (
    `codex-delegate run refused: nested delegation is blocked inside a delegated worker ` +
    `(${NESTING_ENV_VAR}=1). Re-run with --allow-nested to override.`
  );
}
