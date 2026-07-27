import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrors: "none",
        ignoreRestSiblings: true,
      }],
    },
  },
  // A device learns about another device from the frames it receives, never
  // from a walk of the global equipment graph. The registry stays reachable
  // from the code that owns it and from read-only inspection tooling; every
  // other file under src/network has to go through the wire.
  // See docs/PRD-Frame-Only-Refactor.md.
  {
    files: ["src/network/**/*.{ts,tsx}"],
    ignores: [
      "src/network/equipment/**",
      "src/network/devices/inspection/**",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["**/equipment/EquipmentRegistry", "**/EquipmentRegistry"],
            message:
              "A device must discover its peers from real frames, not from the global registry. " +
              "See docs/PRD-Frame-Only-Refactor.md.",
          },
        ],
      }],
    },
  },
);
