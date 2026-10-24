#!/usr/bin/env bash
# Runs the checks of .github/workflows/security.yml (and, with --image, container.yml)
# locally. Reports go to .tools/reports/. See docs/SECURITY-PIPELINE.md.
#
#   scripts/security/scan.sh [--image] [--only <check,...>]
#   checks: gitleaks audit osv trivy hadolint actionlint zizmor semgrep image
#
# Needs the scanners on PATH or in .tools/bin (scripts/security/install-tools.sh),
# Docker for Semgrep and --image, Python 3 for zizmor. Missing tools are skipped
# (reported as "skipped"). Exit status: 0 = all checks passed, 1 = findings, 2 = usage error.
set -uo pipefail

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2
REPORTS="$ROOT/.tools/reports"
export PATH="$ROOT/.tools/bin:$PATH"
SEMGREP_IMAGE="semgrep/semgrep@sha256:3db5c7af55eb1f512eac0abf0ab69a97b52c74b5e9a27314c221aee1a78d7ab2" # 1.181.1
ZIZMOR="zizmor==1.31.1 --hash=sha256:58e878eb2dbd2c6183c105e1ac28c14f7dd1eca44a783f1fe2a69647d012c410"

ALL="gitleaks audit osv trivy hadolint actionlint zizmor semgrep"
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --image) ALL="$ALL image"; shift ;;
    --only) ONLY="${2:?--only needs a list}"; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    *) echo "error: unknown option '$1'" >&2; echo "Run '$0 --help' for usage." >&2; exit 2 ;;
  esac
done
CHECKS="${ONLY//,/ }"
CHECKS="${CHECKS:-$ALL}"
mkdir -p "$REPORTS"

BOLD='' RESET=''
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then BOLD=$'\033[1m' RESET=$'\033[0m'; fi
declare -A RESULT
have() { command -v "$1" >/dev/null 2>&1; }
run() { # name, command...
  local name="$1"; shift
  printf '\n%s== %s%s\n' "$BOLD" "$name" "$RESET" >&2
  if "$@"; then RESULT[$name]=passed; else RESULT[$name]=FAILED; fi
}
skip() { RESULT[$1]="skipped ($2)"; }

for c in $CHECKS; do
  case "$c" in
    gitleaks)
      if have gitleaks; then run gitleaks gitleaks git . --config .gitleaks.toml --redact --no-banner --report-format json --report-path "$REPORTS/gitleaks.json"
      else skip gitleaks "gitleaks not installed"; fi ;;
    audit)
      if have npm; then run audit node scripts/security/npm-audit.mjs --audit-level=high; else skip audit "npm not installed"; fi ;;
    osv)
      # OSV_SCANNER_FLAGS="--offline-vulnerabilities --download-offline-databases" works without api.osv.dev
      # shellcheck disable=SC2086
      if have osv-scanner; then run osv osv-scanner scan source ${OSV_SCANNER_FLAGS:-} --lockfile package-lock.json --config osv-scanner.toml
      else skip osv "osv-scanner not installed"; fi ;;
    trivy)
      if have trivy; then
        run trivy bash -c 'trivy fs --quiet --scanners vuln,misconfig,secret --ignore-unfixed --severity HIGH,CRITICAL --skip-dirs node_modules --skip-dirs .tools --skip-dirs dist-exe --exit-code 1 . && trivy config --quiet --severity HIGH,CRITICAL --exit-code 1 .'
      else skip trivy "trivy not installed"; fi ;;
    hadolint)
      if have hadolint; then run hadolint hadolint Dockerfile; else skip hadolint "hadolint not installed"; fi ;;
    actionlint)
      if have actionlint; then run actionlint actionlint; else skip actionlint "actionlint not installed"; fi ;;
    zizmor)
      if ! have zizmor && have python3; then
        python3 -m venv "$ROOT/.tools/zizmor" >/dev/null && echo "$ZIZMOR" > "$ROOT/.tools/zizmor.txt" &&
          "$ROOT/.tools/zizmor/bin/pip" install --quiet --no-deps --require-hashes --only-binary=:all: -r "$ROOT/.tools/zizmor.txt" &&
          ln -sf "$ROOT/.tools/zizmor/bin/zizmor" "$ROOT/.tools/bin/zizmor"
      fi
      if have zizmor; then run zizmor zizmor --offline --min-severity medium .github/workflows; else skip zizmor "python3 not available"; fi ;;
    semgrep)
      if have docker && docker info >/dev/null 2>&1; then
        run semgrep docker run --rm -v "$ROOT:/src" -v "$REPORTS:/out" -w /src -e SEMGREP_SEND_METRICS=off "$SEMGREP_IMAGE" \
          semgrep scan --metrics=off --error --severity ERROR \
          --config p/default --config p/typescript --config p/nodejs --config p/secrets --config p/github-actions --config p/dockerfile \
          --exclude node_modules --exclude .tools --exclude dist-exe --exclude web/dist \
          --sarif-output=/out/semgrep.sarif
      else skip semgrep "Docker not available"; fi ;;
    image)
      if have docker && have syft && have grype && have trivy; then
        run image bash -c "docker build -t steward:scan . &&
          syft scan docker:steward:scan -q -o cyclonedx-json='$REPORTS/sbom.cdx.json' -o spdx-json='$REPORTS/sbom.spdx.json' -o syft-json='$REPORTS/sbom.syft.json' &&
          grype sbom:'$REPORTS/sbom.syft.json' --only-fixed --fail-on high -o table &&
          trivy image --quiet --scanners vuln,secret --ignore-unfixed --severity HIGH,CRITICAL --exit-code 1 steward:scan"
      else skip image "needs docker, syft, grype and trivy"; fi ;;
    *) echo "error: unknown check '$c'" >&2; exit 2 ;;
  esac
done

printf '\n%sSummary%s (reports in %s)\n' "$BOLD" "$RESET" "${REPORTS#"$ROOT"/}" >&2
status=0
for c in $CHECKS; do
  printf '  %-11s %s\n' "$c" "${RESULT[$c]}" >&2
  [ "${RESULT[$c]}" = FAILED ] && status=1
done
exit $status
