#!/usr/bin/env bash
# Combines single-platform OCI image archives (docker buildx --output type=oci) into one
# OCI image layout with a multi-platform image index – without changing the images, so
# every platform keeps the manifest digest it had when it was scanned. Used by
# .github/workflows/container.yml: each platform is built and scanned on its own runner,
# then the same bytes are pushed (skopeo copy --all --preserve-digests oci:<dir>:steward …).
#
#   scripts/ci/oci-index.sh [--revision <commit>] [--annotation key=value ...] <out dir> <archive.tar> ...
#
#   --revision     fail unless every image has the label org.opencontainers.image.revision=<commit>
#   --annotation   annotation of the index (e.g. org.opencontainers.image.source=…), repeatable
#
# Checks: every archive holds exactly one image (attestation manifests are not expected:
# build with provenance=false), all blobs match their digests, no platform appears twice.
# Prints one line per image, "<os>/<arch>[/<variant>] sha256:…", and last "index sha256:…".
# The layout's reference name is "steward". Needs jq, tar and sha256sum.
# Exit status: 0 = done, 1 = an archive failed a check, 2 = usage error.
set -euo pipefail

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2; }

revision=""
annotations='{}'
while [ $# -gt 0 ]; do
  case "$1" in
    --revision) revision="${2:?--revision needs a commit}"; shift 2 ;;
    --annotation)
      kv="${2:?--annotation needs key=value}"
      [[ "$kv" == *=* ]] || { echo "error: --annotation needs key=value, got '$kv'" >&2; exit 2; }
      annotations="$(jq -c --arg k "${kv%%=*}" --arg v "${kv#*=}" '. + {($k): $v}' <<<"$annotations")"
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "error: unknown option '$1'" >&2; usage; exit 2 ;;
    *) break ;;
  esac
done
if [ $# -lt 2 ]; then
  usage
  exit 2
fi
out="$1"
shift
if [ -e "$out" ]; then
  echo "error: '$out' already exists" >&2
  exit 2
fi

OCI_INDEX=application/vnd.oci.image.index.v1+json
OCI_MANIFEST=application/vnd.oci.image.manifest.v1+json
fail() { echo "error: $*" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out/blobs/sha256"
printf '{"imageLayoutVersion":"1.0.0"}\n' >"$out/oci-layout"

blob() { printf '%s/blobs/sha256/%s' "$1" "${2#sha256:}"; }
descriptors="$work/descriptors.jsonl"
: >"$descriptors"
seen=" "
n=0
for archive in "$@"; do
  n=$((n + 1))
  dir="$work/$n"
  mkdir -p "$dir"
  tar -xf "$archive" -C "$dir"
  [ -f "$dir/index.json" ] || fail "$archive: no index.json (not an OCI archive)"
  # every blob must match its name (content addressed)
  for f in "$dir"/blobs/sha256/*; do
    [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$(basename "$f")" ] || fail "$archive: blob $(basename "$f") does not match its digest"
  done
  # index.json → one image manifest (buildx may wrap it in an index of its own)
  desc="$(jq -c '.manifests' "$dir/index.json")"
  [ "$(jq length <<<"$desc")" = 1 ] || fail "$archive: expected one image, found $(jq length <<<"$desc")"
  desc="$(jq -c '.[0]' <<<"$desc")"
  if [ "$(jq -r .mediaType <<<"$desc")" = "$OCI_INDEX" ]; then
    inner="$(jq -c '[.manifests[] | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")]' "$(blob "$dir" "$(jq -r .digest <<<"$desc")")")"
    [ "$(jq length <<<"$inner")" = 1 ] || fail "$archive: expected one image in the nested index"
    desc="$(jq -c '.[0]' <<<"$inner")"
  fi
  [ "$(jq -r .mediaType <<<"$desc")" = "$OCI_MANIFEST" ] || fail "$archive: not an OCI image manifest: $(jq -r .mediaType <<<"$desc")"
  digest="$(jq -r .digest <<<"$desc")"
  manifest="$(blob "$dir" "$digest")"
  [ -f "$manifest" ] || fail "$archive: manifest $digest is missing"
  config="$(blob "$dir" "$(jq -r .config.digest "$manifest")")"
  [ -f "$config" ] || fail "$archive: image config is missing"
  for layer in $(jq -r '.layers[].digest' "$manifest"); do
    [ -f "$(blob "$dir" "$layer")" ] || fail "$archive: layer $layer is missing"
  done
  if [ -n "$revision" ]; then
    got="$(jq -r '.config.Labels["org.opencontainers.image.revision"] // ""' "$config")"
    [ "$got" = "$revision" ] || fail "$archive: built from '$got', expected revision $revision"
  fi
  platform="$(jq -c '{architecture, os} + (if .variant then {variant} else {} end)' "$config")"
  name="$(jq -r '[.os, .architecture, .variant // empty] | join("/")' <<<"$platform")"
  [[ "$seen" != *" $name "* ]] || fail "$archive: platform $name appears twice"
  seen="$seen$name "
  for f in "$dir"/blobs/sha256/*; do
    [ -e "$out/blobs/sha256/$(basename "$f")" ] || cp "$f" "$out/blobs/sha256/"
  done
  jq -c --argjson p "$platform" '{mediaType, digest, size, platform: $p}' <<<"$desc" >>"$descriptors"
  echo "$name $digest"
  rm -rf "$dir"
done

index="$work/index"
jq -cs --argjson a "$annotations" \
  '{schemaVersion: 2, mediaType: "'"$OCI_INDEX"'", manifests: .} + (if $a == {} then {} else {annotations: $a} end)' \
  "$descriptors" | tr -d '\n' >"$index"
index_digest="sha256:$(sha256sum "$index" | cut -d' ' -f1)"
cp "$index" "$(blob "$out" "$index_digest")"
jq -cn --arg d "$index_digest" --argjson s "$(wc -c <"$index")" '{schemaVersion: 2, mediaType: "'"$OCI_INDEX"'",
  manifests: [{mediaType: "'"$OCI_INDEX"'", digest: $d, size: $s, annotations: {"org.opencontainers.image.ref.name": "steward"}}]}' >"$out/index.json"
echo "index $index_digest"
