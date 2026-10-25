#!/usr/bin/env bash
# Installs the security scanners (and cosign) used by .github/workflows/security.yml
# and container.yml – pinned versions, downloaded from the official GitHub releases
# and verified against the SHA-256 checksums recorded below (not the ones next
# to the download, so a release asset replaced later is detected).
#
#   scripts/security/install-tools.sh [--dir <bin dir>] [tool ...]
#   tools: actionlint gitleaks hadolint osv-scanner trivy syft grype cosign (default: all)
#
# Linux x86_64; on Linux aarch64 (arm64 runners) only trivy, syft, grype and cosign.
# On macOS use Homebrew: brew install actionlint gitleaks hadolint osv-scanner trivy syft grype cosign
#
# Updating a tool: change version and checksum together. Take the checksum from the
# release's checksums file AND compare it with a second source (e.g. the binary in the
# tool's official container image, or the GitHub release page), and prefer releases that
# are at least two weeks old. Dependabot does not update these pins.
set -euo pipefail

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

BIN_DIR="${TOOLS_DIR:-$PWD/.tools/bin}"
TOOLS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --dir) BIN_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --dir=*) BIN_DIR="${1#--dir=}"; shift ;;
    -*) echo "error: unknown option '$1'" >&2; echo "Run '$0 --help' for usage." >&2; exit 2 ;;
    *) TOOLS+=("$1"); shift ;;
  esac
done

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ARCH=amd64 ;;
  Linux-aarch64 | Linux-arm64) ARCH=arm64 ;;
  *)
    echo "error: only Linux x86_64 and aarch64 are supported; install the tools with your package manager instead" >&2
    exit 2
    ;;
esac

# name|version|architecture|url|sha256|path of the binary inside the archive ("" = the download is the binary)
SPECS=(
  "actionlint|1.7.12|amd64|https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz|8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8|actionlint"
  "gitleaks|8.30.1|amd64|https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz|551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb|gitleaks"
  "hadolint|2.15.1|amd64|https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-x86_64|c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507|"
  "osv-scanner|2.6.0|amd64|https://github.com/google/osv-scanner/releases/download/v2.6.0/osv-scanner_linux_amd64|ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108|"
  "trivy|0.75.0|amd64|https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz|c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f|trivy"
  "syft|1.54.1|amd64|https://github.com/anchore/syft/releases/download/v1.54.1/syft_1.54.1_linux_amd64.tar.gz|c069905b391cc4c20a5ba65ad5c10be2a7ba074f8ea6ad203e24d14e303dad47|syft"
  "grype|0.120.1|amd64|https://github.com/anchore/grype/releases/download/v0.120.1/grype_0.120.1_linux_amd64.tar.gz|0a9ee97ef5ae2ee953b0a80098105052e846cdbe319a57d808b519c33cd1343d|grype"
  "cosign|3.1.3|amd64|https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64|4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71|"
  "trivy|0.75.0|arm64|https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-ARM64.tar.gz|a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3|trivy"
  "syft|1.54.1|arm64|https://github.com/anchore/syft/releases/download/v1.54.1/syft_1.54.1_linux_arm64.tar.gz|dfdf0537610113edbefe1f1fc6548bc957b2d77439636ec824fcf0e10d46d054|syft"
  "grype|0.120.1|arm64|https://github.com/anchore/grype/releases/download/v0.120.1/grype_0.120.1_linux_arm64.tar.gz|29f47391dc283aa79fcc38e65224cd61f64dec0ecfd0db7074128ebf8ff23514|grype"
  "cosign|3.1.3|arm64|https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-arm64|c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a|"
)

mkdir -p "$BIN_DIR"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

found=0
for spec in "${SPECS[@]}"; do
  IFS='|' read -r name version arch url sha member <<<"$spec"
  if [ "$arch" != "$ARCH" ]; then continue; fi
  if [ ${#TOOLS[@]} -gt 0 ] && [[ ! " ${TOOLS[*]} " == *" $name "* ]]; then continue; fi
  found=$((found + 1))
  file="$work/$(basename "$url")"
  echo "• $name $version" >&2
  curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$file" "$url"
  echo "$sha  $file" | sha256sum --check --quiet --strict
  if [ -n "$member" ]; then
    mkdir -p "$work/$name"
    tar -xzf "$file" -C "$work/$name" "$member"
    install -m 0755 "$work/$name/$member" "$BIN_DIR/$name"
  else
    install -m 0755 "$file" "$BIN_DIR/$name"
  fi
done
if [ ${#TOOLS[@]} -gt 0 ] && [ "$found" -ne ${#TOOLS[@]} ]; then
  echo "error: unknown tool, or not available for $ARCH, in: ${TOOLS[*]}" >&2
  exit 2
fi
echo "$BIN_DIR"
