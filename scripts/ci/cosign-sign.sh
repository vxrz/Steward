#!/bin/sh
# Signs a pushed container image (by digest) with cosign and a key pair – optional step of
# .woodpecker/container.yaml. The signature is stored next to the image in the registry
# (classic "sha256-<digest>.sig" tag, which Harbor shows as a cosign signature and can
# enforce with its "Cosign" content-trust policy). Nothing is sent to the public Sigstore
# transparency log (the image name would become public).
#
#   scripts/ci/cosign-sign.sh <registry>/<repository>@sha256:<digest>
#
# Environment: COSIGN_KEY (private key, PEM content from "cosign generate-key-pair"),
# COSIGN_PASSWORD (its password), REGISTRY_USERNAME / REGISTRY_PASSWORD (push permission).
# cosign is downloaded from the official release and verified against the SHA-256 below.
# Verify a signature: cosign verify --key cosign.pub --insecure-ignore-tlog=true <image>@<digest>
# Exit status: 0 = signed, 1 = signing failed, 2 = usage or configuration error.
set -eu

COSIGN_VERSION=3.1.3
COSIGN_SHA256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 # cosign-linux-amd64

if [ $# -ne 1 ]; then
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
ref="$1"
case "$ref" in
  *@sha256:*) ;;
  *) echo "error: sign by digest (<image>@sha256:…), not by tag: '$ref'" >&2; exit 2 ;;
esac
[ -n "${COSIGN_KEY:-}" ] || { echo "error: COSIGN_KEY is empty (secret cosign_key)" >&2; exit 2; }
if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "error: only Linux x86_64 is supported" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$work/cosign" \
  "https://github.com/sigstore/cosign/releases/download/v$COSIGN_VERSION/cosign-linux-amd64"
echo "$COSIGN_SHA256  $work/cosign" | sha256sum --check --quiet --strict
chmod 0755 "$work/cosign"

# registry credentials through a private docker config (not as command-line flags)
if [ -n "${REGISTRY_USERNAME:-}" ]; then
  mkdir -m 700 "$work/docker"
  auth="$(printf '%s:%s' "$REGISTRY_USERNAME" "${REGISTRY_PASSWORD:-}" | base64 | tr -d '\n')"
  (umask 077 && printf '{"auths":{"%s":{"auth":"%s"}}}\n' "${ref%%/*}" "$auth" >"$work/docker/config.json")
  export DOCKER_CONFIG="$work/docker"
fi

export COSIGN_PASSWORD="${COSIGN_PASSWORD:-}"
"$work/cosign" sign --yes --key env://COSIGN_KEY \
  --tlog-upload=false --use-signing-config=false --new-bundle-format=false \
  -a "org.opencontainers.image.revision=${CI_COMMIT_SHA:-unknown}" \
  -a "ci.pipeline=${CI_PIPELINE_URL:-local}" \
  "$ref"
echo "signed $ref" >&2
