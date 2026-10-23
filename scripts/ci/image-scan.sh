#!/usr/bin/env bash
# SBOM and vulnerability scan of the container image – the checks of
# .github/workflows/container.yml, for .woodpecker/container.yaml:
#   Syft  → reports/sbom.cdx.json (CycloneDX), reports/sbom.spdx.json, reports/sbom.syft.json
#   Grype → on the SBOM, fails on high/critical with a fix available
#   Trivy → image scan (vulnerabilities, secrets), fails on high/critical with a fix available
#
#   scripts/ci/image-scan.sh archive <docker-archive.tar>      # image built without pushing
#   scripts/ci/image-scan.sh registry <registry>/<repo>@<digest|:tag>   # pushed image
#
# Registry credentials (optional): REGISTRY_USERNAME / REGISTRY_PASSWORD (read-only use).
# IMAGE_VERSION names the SBOM version (default: tag or branch of the pipeline).
# The scanners are installed with scripts/security/install-tools.sh (pinned, SHA-256 verified).
# Both scanners always run; exit status 1 if either found something, 2 on usage errors.
set -euo pipefail

if [ $# -ne 2 ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
kind="$1"
target="$2"
root="$(cd "$(dirname "$0")/../.." && pwd)"
tools="${TOOLS_DIR:-$(mktemp -d)}"
"$root/scripts/security/install-tools.sh" --dir "$tools" syft grype trivy >/dev/null
export PATH="$tools:$PATH"
export SYFT_CHECK_FOR_APP_UPDATE=false GRYPE_CHECK_FOR_APP_UPDATE=false

version="${IMAGE_VERSION:-${CI_COMMIT_TAG:-${CI_COMMIT_BRANCH:-local}}}"
version="${version//\//-}"
case "$kind" in
  archive)
    syft_src="docker-archive:$target"
    trivy_args=(--input "$target")
    ;;
  registry)
    syft_src="registry:$target"
    trivy_args=("$target")
    if [ -n "${REGISTRY_USERNAME:-}" ]; then
      export SYFT_REGISTRY_AUTH_AUTHORITY="${target%%/*}"
      export SYFT_REGISTRY_AUTH_USERNAME="$REGISTRY_USERNAME" SYFT_REGISTRY_AUTH_PASSWORD="${REGISTRY_PASSWORD:-}"
      export TRIVY_USERNAME="$REGISTRY_USERNAME" TRIVY_PASSWORD="${REGISTRY_PASSWORD:-}"
    fi
    ;;
  *)
    echo "error: unknown source kind '$kind' (archive or registry)" >&2
    exit 2
    ;;
esac

mkdir -p reports
echo "== Syft SBOM ($syft_src, version $version)" >&2
syft scan "$syft_src" --source-name steward --source-version "$version" \
  -o cyclonedx-json=reports/sbom.cdx.json -o spdx-json=reports/sbom.spdx.json -o syft-json=reports/sbom.syft.json

status=0
echo "== Grype (fails on high/critical with a fix available)" >&2
grype "sbom:reports/sbom.syft.json" --only-fixed --fail-on high -o table || status=1

echo "== Trivy image (fails on high/critical with a fix available, secrets)" >&2
trivy image --scanners vuln,secret --ignore-unfixed --severity HIGH,CRITICAL --exit-code 1 --format table "${trivy_args[@]}" || status=1

[ "$status" -eq 0 ] && echo "Image scan: no blocking findings" >&2 || echo "Image scan: blocking findings (see above)" >&2
exit "$status"
