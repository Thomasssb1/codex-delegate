import js from "@eslint/js";
import globals from "globals";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: ["dist", "**/node_modules/**"],
  },
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      sourceType: "module",
    },
  },
);
