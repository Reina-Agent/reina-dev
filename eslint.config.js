// Minimal, intentionally-lenient ESLint flat config. The repo had no linter,
// so this starts as a low-friction safety net rather than a strict gate: all
// rules are `warn` (visible in CI logs, non-blocking) so a brand-new lint pass
// can't turn the build red on day one. Tighten over time. (The original hard
// rule — banning per-module HTML escapers in the legacy plain-JS renderer —
// left with that renderer's deletion in 2026-06.)
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/vendor/**",
      "**/*.d.ts",
      ".tmp/**",
      ".codegraph/**",
      ".claude/**",
      "release/**",
      "img/**",
      "mockups/**",
      "参考/**",
    ],
  },
  // Shared, framework-agnostic rules for every source file.
  {
    files: ["**/*.{ts,js,mjs,cjs}"],
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["warn", "smart"],
      "no-var": "warn",
      "prefer-const": "warn",
    },
  },
  // TypeScript: parse TS syntax and surface (non-type-aware) hygiene warnings.
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Disable stylistic rules that would conflict with Prettier.
  prettier,
);
