import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output, dependencies, the Rust side, and the agent worktrees under
    // `.claude` are not linted here.
    ignores: ["dist", "src-tauri/target", "src-tauri/gen", "node_modules", ".claude"],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // `any` defeats the type checker, so it is an error and not a warning.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    // shadcn/ui writes this directory. Do not fight the generator over style.
    files: ["src/components/ui/**"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // `public/theme-init.js` runs as a plain script before the application module. It has
    // no module scope and no type information. An ES5 `catch` must name its error, and
    // the script ignores that error on purpose.
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.browser,
    },
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      "no-unused-vars": ["error", { caughtErrors: "none" }],
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
  {
    files: ["*.config.{js,ts}", "scripts/**"],
    languageOptions: { globals: globals.node },
    extends: [tseslint.configs.disableTypeChecked],
  },
);
