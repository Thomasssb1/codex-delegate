import { readFileSync } from "node:fs";

const providersFile = new URL("../providers.json", import.meta.url);

function isProviderList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((provider) => typeof provider === "string" && provider.trim() !== "") &&
    new Set(value).size === value.length
  );
}

export function loadAcceptedProviders(): readonly string[] {
  const providers: unknown = JSON.parse(readFileSync(providersFile, "utf8"));

  if (!isProviderList(providers)) {
    throw new Error("providers.json must contain a non-empty array of unique provider names.");
  }

  return providers;
}
