// Pre-commit (.husky/pre-commit): fix and check only the staged files. The globs must not overlap,
// because lint-staged runs them in parallel. Files in .prettierignore / the ESLint ignores are skipped.
export default {
  '*.{js,mjs,cjs,ts,mts,cts,tsx}': ['prettier --write', 'eslint --fix --max-warnings 0 --no-warn-ignored'],
  '*.{json,md,yml,yaml,css,html}': 'prettier --write',
};
