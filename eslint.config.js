// ESLint flat config (https://eslint.org/docs/latest/use/configure/). Run: npm run lint
// Formatting is Prettier's job (.prettierrc.json); eslint-config-prettier turns off the rules that would overlap.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    'dist-exe/',
    'coverage/',
    'playwright-report/',
    'blob-report/',
    'test-results/',
    'data/',
    '.tools/',
    'e2e/.auth/',
    'e2e/.explore/',
  ]),

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // Unused code is an error, but `_name` marks a deliberately unused parameter or destructured value
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      // The code base uses comma sequences as compact statements on purpose: `if (f.x) (where.push('x = ?'), params.push(f.x));`
      '@typescript-eslint/no-unused-expressions': 'off',
      // Errors are re-thrown with a curated message on purpose (e.g. only the first line of a browser error):
      // attaching `cause` would change what is logged, journaled and sent to error reporting.
      'preserve-caught-error': 'off',
    },
  },

  // Node.js: server, CLIs, scripts, tests, tool configs
  {
    files: ['server/**', 'scripts/**', 'e2e/**', '*.config.{js,ts}', 'web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  // Browser: the web UI; Playwright tests also run code in the page (page.evaluate)
  {
    files: ['web/**', 'e2e/**'],
    languageOptions: { globals: globals.browser },
  },
  { files: ['web/public/sw.js'], languageOptions: { globals: globals.serviceworker } },
  // shared/ runs in both, but must not depend on either environment's globals
  { files: ['shared/**'], languageOptions: { globals: globals['shared-node-browser'] } },

  // Tests: `any` for loosely typed API responses and test doubles is fine (CONTRIBUTING.md: "No `any`" applies to app code)
  {
    files: ['server/test/**', 'e2e/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  // React: the rules of hooks. The React Compiler diagnostics below are off: the app does not use the compiler, and they flag
  // deliberate patterns (resetting form state from loaded data in an effect, Date.now() for relative times, refs read in render
  // for undo/redo state). exhaustive-deps stays on.
  {
    files: ['web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },

  prettier,
);
