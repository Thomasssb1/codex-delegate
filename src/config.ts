import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { approvalModes, type ApprovalMode } from "./approval-mode.js";
import { DEFAULT_INACTIVITY_TIMEOUT_MS } from "./cancellation.js";
import type { AgentProfile } from "./agents/loader.js";
import { loadAcceptedProviders } from "./providers.js";
import { DEFAULT_SNAPSHOT_LIMITS, type SnapshotOptions } from "./worktree.js";

const configurationFile = ".codex-delegate.yml";
const rootKeys = new Set(["defaultProvider", "inactivityTimeout", "muse", "snapshot"]);
const museKeys = new Set(["approvalMode", "binary", "model"]);
const snapshotKeys = new Set(["includeUntracked", "maxBytes", "maxFiles"]);
const acceptedProviders = new Set(loadAcceptedProviders());

export class ConfigurationError extends Error {}

type RepositoryConfiguration = {
  defaultProvider?: string;
  inactivityTimeoutMs?: number;
  muse?: {
    approvalMode?: ApprovalMode;
    binary?: string;
    model?: string;
  };
  snapshot?: Partial<SnapshotOptions>;
};

export type RunConfiguration = {
  inactivityTimeoutMs: number;
  muse: {
    approvalMode: ApprovalMode;
    binary: string;
    model?: string;
  };
  provider: string;
  snapshotLimits: SnapshotOptions;
};

export type RunConfigurationOverrides = {
  allowAll?: boolean;
  approvalMode?: ApprovalMode;
  model?: string;
  provider?: string;
  timeoutMs?: number;
};

function invalidConfiguration(message: string): ConfigurationError {
  return new ConfigurationError(`Invalid ${configurationFile}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, keys: Set<string>, location: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw invalidConfiguration(`unknown ${location} key: ${key}.`);
    }
  }
}

function optionalString(value: Record<string, unknown>, key: string, location: string): string | undefined {
  const item = value[key];

  if (item === undefined) {
    return undefined;
  }

  if (typeof item !== "string" || item.trim() === "") {
    throw invalidConfiguration(`${location}.${key} must be a non-empty string.`);
  }

  return item;
}

function optionalNonNegativeInteger(value: Record<string, unknown>, key: string, location: string): number | undefined {
  const item = value[key];

  if (item === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(item) || (item as number) < 0) {
    throw invalidConfiguration(`${location}.${key} must be a non-negative safe integer.`);
  }

  return item as number;
}

function optionalBoolean(value: Record<string, unknown>, key: string, location: string): boolean | undefined {
  const item = value[key];

  if (item === undefined) {
    return undefined;
  }

  if (typeof item !== "boolean") {
    throw invalidConfiguration(`${location}.${key} must be a boolean.`);
  }

  return item;
}

function optionalApprovalMode(value: Record<string, unknown>, key: string, location: string): ApprovalMode | undefined {
  const mode = optionalString(value, key, location);

  if (mode !== undefined && !approvalModes.includes(mode as ApprovalMode)) {
    throw invalidConfiguration(`${location}.${key} must be one of: ${approvalModes.join(", ")}.`);
  }

  return mode as ApprovalMode | undefined;
}

export function parseInactivityTimeout(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);

  if (match === null) {
    throw new ConfigurationError("Timeout must be a positive duration such as 30s, 20m, or 1h.");
  }

  const quantity = Number(match[1]);
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, ms: 1, s: 1_000 };
  const timeoutMs = quantity * units[match[2]];

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigurationError("Timeout must be a positive safe duration.");
  }

  return timeoutMs;
}

function optionalObject(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const item = value[key];

  if (item === undefined) {
    return undefined;
  }

  if (!isRecord(item)) {
    throw invalidConfiguration(`${key} must be a mapping.`);
  }

  return item;
}

function loadRepositoryConfiguration(repositoryRoot: string): RepositoryConfiguration {
  const path = join(repositoryRoot, configurationFile);
  if (!existsSync(path)) {
    return {};
  }

  let document;
  try {
    document = parseDocument(readFileSync(path, "utf8"), { prettyErrors: false, uniqueKeys: true });
  } catch (error) {
    throw invalidConfiguration(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (document.errors.length > 0) {
    throw invalidConfiguration(document.errors.map((error) => error.message).join(" "));
  }

  const value: unknown = document.toJS();
  if (!isRecord(value)) {
    throw invalidConfiguration("root must be a mapping.");
  }

  assertKnownKeys(value, rootKeys, "root");
  const defaultProvider = optionalString(value, "defaultProvider", "root");
  if (defaultProvider !== undefined && !acceptedProviders.has(defaultProvider)) {
    throw invalidConfiguration(`defaultProvider is unsupported: ${defaultProvider}.`);
  }

  const snapshotValue = optionalObject(value, "snapshot");
  let snapshot: RepositoryConfiguration["snapshot"];
  if (snapshotValue !== undefined) {
    assertKnownKeys(snapshotValue, snapshotKeys, "snapshot");
    snapshot = {
      includeUntracked: optionalBoolean(snapshotValue, "includeUntracked", "snapshot"),
      maxBytes: optionalNonNegativeInteger(snapshotValue, "maxBytes", "snapshot"),
      maxFiles: optionalNonNegativeInteger(snapshotValue, "maxFiles", "snapshot"),
    };
  }

  const museValue = optionalObject(value, "muse");
  let muse: RepositoryConfiguration["muse"];
  if (museValue !== undefined) {
    assertKnownKeys(museValue, museKeys, "muse");
    muse = {
      approvalMode: optionalApprovalMode(museValue, "approvalMode", "muse"),
      binary: optionalString(museValue, "binary", "muse"),
      model: optionalString(museValue, "model", "muse"),
    };
  }

  const inactivityTimeout = optionalString(value, "inactivityTimeout", "root");
  return {
    defaultProvider,
    inactivityTimeoutMs: inactivityTimeout === undefined ? undefined : parseInactivityTimeout(inactivityTimeout),
    muse,
    snapshot,
  };
}

export function resolveRunConfiguration(
  repositoryRoot: string,
  profile: AgentProfile,
  overrides: RunConfigurationOverrides = {},
): RunConfiguration {
  const repository = loadRepositoryConfiguration(repositoryRoot);
  const provider = overrides.provider ?? profile.provider ?? repository.defaultProvider ?? "muse";
  if (!acceptedProviders.has(provider)) {
    throw new ConfigurationError(`Unsupported provider: ${provider}.`);
  }

  const approvalMode = overrides.approvalMode ?? profile.approvalMode ?? repository.muse?.approvalMode ?? "denyUnmatched";
  if (approvalMode === "fullAccess" && overrides.allowAll !== true) {
    throw new ConfigurationError("approvalMode=fullAccess requires --allow-all.");
  }
  if (overrides.allowAll === true && approvalMode !== "fullAccess") {
    throw new ConfigurationError("--allow-all can only be used with approvalMode=fullAccess.");
  }

  return {
    inactivityTimeoutMs: overrides.timeoutMs ?? repository.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
    muse: {
      approvalMode,
      binary: repository.muse?.binary ?? "muse",
      model: overrides.model ?? profile.model ?? repository.muse?.model,
    },
    provider,
    snapshotLimits: {
      includeUntracked: repository.snapshot?.includeUntracked,
      maxBytes: repository.snapshot?.maxBytes ?? DEFAULT_SNAPSHOT_LIMITS.maxBytes,
      maxFiles: repository.snapshot?.maxFiles ?? DEFAULT_SNAPSHOT_LIMITS.maxFiles,
    },
  };
}
