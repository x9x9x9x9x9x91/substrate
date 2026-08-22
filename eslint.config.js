import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

// Substrate's ESLint gate. Posture: correctness rules are errors and must stay
// at zero; rules that would demand a mass rewrite of working UI are `warn` (a
// visible backlog) or `off` (a decision we've made), each with the reason.
// `npm run lint` fails on errors only, so warnings can accumulate honestly
// without blocking a merge.
export default tseslint.config(
  {
    // build output, deps, generated reports, and the Rust tree
    ignores: ["dist/", "node_modules/", "src-tauri/", "test-results/", "playwright-report/"],
  },
  { files: ["**/*.{ts,tsx,js,mjs}"], ...js.configs.recommended },
  ...tseslint.configs.recommended.map((c) => ({ files: ["**/*.{ts,tsx}"], ...c })),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // --- correctness: errors, keep at zero -----------------------------
      // rules-of-hooks and the js/ts recommended sets stay at their default
      // `error` from the spreads above.

      // `case "a": case "b":` chains that only carry a comment between them
      // (the mirror-script strip markers) are grouped labels, not fallthrough.
      "no-fallthrough": ["error", { allowEmptyCase: true }],

      // `let x; … x = v` where a closure reads `x` before the assignment line
      // cannot become `const` — collapsing it would leave the earlier read in
      // the TDZ. (The CLI-arg `--help` handlers and serve.test's server handle.)
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],

      // `_`-prefixed bindings are the codebase's existing "deliberately
      // unused" convention (destructuring a field out to drop it).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // --- React Compiler lint family: warn ------------------------------
      // eslint-plugin-react-hooks 7 ships the React Compiler's diagnostics as
      // errors. They are aspirational for this codebase, not bugs: ~35 hits
      // each for effect-driven state and render-time ref reads, in components
      // (App, DatabasePane, Editor, NotePane) whose data flow would need
      // redesigning, not patching. Warn = a real backlog we can burn down per
      // component, without a 200-site rewrite gating every merge.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/use-memo": "warn",
      "react-hooks/static-components": "warn",
      // exhaustive-deps is already `warn` upstream; 13 hits, each needing a
      // per-site judgement call (some deps are deliberately omitted).

      // --- a11y ----------------------------------------------------------
      // Substrate is a keyboard-first desktop app: menus, the command palette,
      // and inline editors autofocus on open because that IS the interaction —
      // a picker that opens unfocused is broken here. 23 deliberate sites.
      "jsx-a11y/no-autofocus": "off",
      // ~60 hits across list rows, grid cells, and calendar days: divs that
      // carry click handlers alongside the app's own roving-tabindex keyboard
      // model. Fixing them means an accessibility pass (real roles + key
      // handlers), which is its own piece of work, not a lint autofix.
      "jsx-a11y/no-static-element-interactions": "warn",
      // same family, reached once the calendar's day cells got a real
      // `role="group"`: naming a region and making its click affordance
      // keyboard-reachable are separate pieces of work.
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/interactive-supports-focus": "warn",
      "jsx-a11y/no-noninteractive-tabindex": "warn",
    },
  },
  {
    // Vault-resident kind bundles: plain browser ES modules the app imports
    // from the vault at runtime, not part of the TypeScript program. They see
    // the DOM and nothing else. Both the private ones under `vault-kinds/` and
    // the worked copies that ship inside a vault (`examples/vault`, `cookbook/`).
    files: ["vault-kinds/**/*.js", "**/.vault/kinds/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Node-side scripts and the sync server: no DOM, no React.
    files: ["scripts/**/*.ts", "e2e/**/*.ts", "*.config.ts", "*.config.js"],
    languageOptions: { globals: globals.node },
  },
);
