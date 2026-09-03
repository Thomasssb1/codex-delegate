import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const skillNames = ["codex-delegate", "codex-delegate-review", "codex-delegate-test"] as const;

export type CodexSkillInstallation = {
  installed: readonly string[];
  skillsDirectory: string;
};

export function installCodexSkills(options: { codexHome?: string; force?: boolean } = {}): CodexSkillInstallation {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const skillsDirectory = join(codexHome, "skills");
  const existing = skillNames.filter((name) => existsSync(join(skillsDirectory, name)));

  if (existing.length > 0 && options.force !== true) {
    throw new Error(`Codex skills already installed: ${existing.join(", ")}. Re-run with --force to update them.`);
  }

  mkdirSync(skillsDirectory, { recursive: true });

  for (const name of skillNames) {
    cpSync(new URL(`../skills/${name}/`, import.meta.url), join(skillsDirectory, name), {
      force: true,
      recursive: true,
    });
  }

  return { installed: skillNames, skillsDirectory };
}
