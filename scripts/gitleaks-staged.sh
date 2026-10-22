#!/bin/sh
# Pre-commit hook step (.husky/pre-commit): scans the staged changes for secrets with gitleaks and the
# project's .gitleaks.toml. Skips with a notice when gitleaks is not installed (PATH or .tools/bin, see
# scripts/security/install-tools.sh); CI scans the full history on every push (docs/SECURITY-PIPELINE.md).
#
# Exit status: 0 = no secrets found (or skipped), 1 = secrets found.
cd "$(git rev-parse --show-toplevel)" || exit 2
PATH="$(pwd)/.tools/bin:$PATH"
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not installed - skipping the secret scan of the staged changes (CI still runs it)" >&2
  exit 0
fi
# gitleaks 8.19+ replaced "protect --staged" with "git --pre-commit --staged"
if gitleaks git --help >/dev/null 2>&1; then
  exec gitleaks git --pre-commit --staged --redact --no-banner --config .gitleaks.toml
fi
exec gitleaks protect --staged --redact --no-banner --config .gitleaks.toml
