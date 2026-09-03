import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { approvalModes, type ApprovalMode } from "../approval-mode.js";
import { loadAcceptedProviders } from "../providers.js";

const agentNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const acceptedProviders = new Set(loadAcceptedProviders());
const profileKeys = new Set([
  "approvalMode",
  "description",
  "model",
  "name",
  "provider",
]);

export type AgentProfile = {
  approvalMode?: ApprovalMode;
  description: string;
  instructions: string;
  model?: string;
  name: string;
  provider?: string;
  source: "bundled" | "project";
};

function invalidProfile(path: string | URL, message: string): Error {
  return new Error(`Invalid agent profile ${path}: ${message}`);
}

function splitProfile(source: string, path: string | URL): { frontMatter: string; instructions: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);

  if (match === null) {
    throw invalidProfile(path, "expected YAML front matter delimited by ---.");
  }

  const instructions = match[2].trim();
  if (instructions === "") {
    throw invalidProfile(path, "instructions are empty.");
  }

  return { frontMatter: match[1], instructions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(profile: Record<string, unknown>, key: string, path: string | URL): string {
  const value = profile[key];

  if (typeof value !== "string" || value.trim() === "") {
    throw invalidProfile(path, `${key} must be a non-empty string.`);
  }

  return value;
}

function optionalString(profile: Record<string, unknown>, key: string, path: string | URL): string | undefined {
  if (profile[key] === undefined) {
    return undefined;
  }

  return requiredString(profile, key, path);
}

function enumValue<Value extends string>(
  profile: Record<string, unknown>,
  key: string,
  values: readonly Value[],
  path: string | URL,
): Value {
  const value = requiredString(profile, key, path);

  if (!values.includes(value as Value)) {
    throw invalidProfile(path, `${key} must be one of: ${values.join(", ")}.`);
  }

  return value as Value;
}

function optionalEnumValue<Value extends string>(
  profile: Record<string, unknown>,
  key: string,
  values: readonly Value[],
  path: string | URL,
): Value | undefined {
  if (profile[key] === undefined) {
    return undefined;
  }

  return enumValue(profile, key, values, path);
}

function readProfile(path: string | URL, expectedName: string, source: AgentProfile["source"]): AgentProfile {
  const { frontMatter, instructions } = splitProfile(readFileSync(path, "utf8"), path);
  const document = parseDocument(frontMatter, { prettyErrors: false, uniqueKeys: true });

  if (document.errors.length > 0) {
    throw invalidProfile(path, document.errors.map((error) => error.message).join(" "));
  }

  const value: unknown = document.toJS();
  if (!isRecord(value)) {
    throw invalidProfile(path, "front matter must be a mapping.");
  }

  for (const key of Object.keys(value)) {
    if (!profileKeys.has(key)) {
      throw invalidProfile(path, `unknown front matter key: ${key}.`);
    }
  }

  const name = requiredString(value, "name", path);
  if (!agentNamePattern.test(name)) {
    throw invalidProfile(path, `name is invalid: ${name}.`);
  }

  if (name !== expectedName) {
    throw invalidProfile(path, `name must match the requested agent: ${expectedName}.`);
  }

  const provider = optionalString(value, "provider", path);
  if (provider !== undefined && !acceptedProviders.has(provider)) {
    throw invalidProfile(path, `provider is unsupported: ${provider}.`);
  }

  return {
    approvalMode: optionalEnumValue(value, "approvalMode", approvalModes, path),
    description: requiredString(value, "description", path),
    instructions,
    model: optionalString(value, "model", path),
    name,
    provider,
    source,
  };
}

export function loadAgent(repositoryRoot: string, name: string): AgentProfile {
  if (!agentNamePattern.test(name)) {
    throw new Error(`Invalid agent name: ${name}`);
  }

  const projectPath = join(repositoryRoot, ".codex-agents", `${name}.md`);

  if (existsSync(projectPath)) {
    return readProfile(projectPath, name, "project");
  }

  const bundledPath = new URL(`../../agents/${name}.md`, import.meta.url);

  try {
    return readProfile(bundledPath, name, "bundled");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Agent profile not found: ${name}`, { cause: error });
    }

    throw error;
  }
}

function agentNamesIn(path: string | URL): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.name.endsWith(".md")) {
          return false;
        }

        if (entry.isFile()) {
          return true;
        }

        if (!entry.isSymbolicLink()) {
          return false;
        }

        try {
          const entryPath = typeof path === "string" ? join(path, entry.name) : new URL(entry.name, path);
          return statSync(entryPath).isFile();
        } catch {
          return false;
        }
      })
      .map((entry) => entry.name.slice(0, -3));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export function listAgents(repositoryRoot?: string): AgentProfile[] {
  const bundledDirectory = new URL("../../agents/", import.meta.url);
  const names = new Set(agentNamesIn(bundledDirectory));

  if (repositoryRoot !== undefined) {
    for (const name of agentNamesIn(join(repositoryRoot, ".codex-agents"))) {
      names.add(name);
    }
  }

  return [...names]
    .sort()
    .map((name) => repositoryRoot === undefined
      ? readProfile(new URL(`../../agents/${name}.md`, import.meta.url), name, "bundled")
      : loadAgent(repositoryRoot, name));
}
