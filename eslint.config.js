import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-web/**",
      "**/node_modules/**",
      "src-tauri/target/**",
      "docs/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.es2022 },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "smart"],
      "no-console": "error",
    },
  },
  {
    // packages/core must stay environment agnostic: every outside capability
    // arrives through an injected port, never through a host import.
    files: ["packages/core/**/*.ts", "packages/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*"], message: "core/shared must not import Node built-ins; use an injected port." },
            { group: ["@tauri-apps/*"], message: "core/shared must not import Tauri APIs; use an injected port." },
            { group: ["fs", "path", "os", "child_process", "crypto", "http", "https"], message: "core/shared must not import Node built-ins; use an injected port." },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/cli/**/*.ts", "tests/**/*.ts", "*.config.ts", "*.config.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["apps/cli/src/bin.ts", "apps/cli/src/render.ts"],
    rules: { "no-console": "off" },
  },
);
