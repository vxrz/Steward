#!/bin/sh
# Resolves an image tag to its manifest digest and, optionally, adds more tags to the
# same manifest – without pulling or rebuilding the image (registry API v2, works with
# Harbor and any OCI registry). Used by .woodpecker/container.yaml to give an image its
# branch/version tags only after it passed the vulnerability scans.
#
#   scripts/ci/registry-tag.sh <registry>/<repository> <existing tag> [<new tag> ...]
#   e.g. scripts/ci/registry-tag.sh harbor.example.com/steward/steward "$CI_COMMIT_SHA" main
#
# Prints the digest (sha256:…) to stdout. Credentials: REGISTRY_USERNAME and
# REGISTRY_PASSWORD (optional for anonymous pulls; adding tags needs push permission).
# They are passed to curl in a config file, never on the command line.
# REGISTRY_SCHEME=http only for a local test registry.
# Exit status: 0 = done, 1 = registry error, 2 = usage error.
set -eu

if [ $# -lt 2 ] || [ "$1" = -h ] || [ "$1" = --help ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2
  [ $# -lt 2 ] && exit 2
  exit 0
fi
image="$1"
src="$2"
shift 2
host="${image%%/*}"
repo="${image#*/}"
if [ "$host" = "$image" ] || [ -z "$repo" ]; then
  echo "error: expected <registry>/<repository>, got '$image'" >&2
  exit 2
fi
scheme="${REGISTRY_SCHEME:-https}"
base="$scheme://$host/v2/$repo"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
cfg="$work/curl.cfg"
: >"$cfg"
quote() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
curl_() { curl -sS --proto '=https,http' --retry 3 -K "$cfg" "$@"; }

# Authentication: follow the registry's challenge (Bearer token service, e.g. Harbor; or Basic)
challenge="$(curl -sS --retry 3 -o /dev/null -D - "$scheme://$host/v2/" | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: *//p' | head -1)"
user_cfg=""
if [ -n "${REGISTRY_USERNAME:-}" ]; then
  user_cfg="user = \"$(quote "$REGISTRY_USERNAME"):$(quote "${REGISTRY_PASSWORD:-}")\""
fi
case "$challenge" in
  Bearer*|bearer*)
    param() { printf '%s\n' "$challenge" | sed -n "s/.*$1=\"\\([^\"]*\\)\".*/\\1/p"; }
    realm="$(param realm)"
    service="$(param service)"
    scope="repository:$repo:pull"
    [ $# -gt 0 ] && scope="$scope,push"
    tokcfg="$work/token.cfg"
    printf '%s\n' "$user_cfg" >"$tokcfg"
    resp="$(curl -fsS --retry 3 -K "$tokcfg" -G "$realm" --data-urlencode "service=$service" --data-urlencode "scope=$scope")" || {
      echo "error: could not get a registry token from $realm" >&2
      exit 1
    }
    token="$(printf '%s' "$resp" | sed -n 's/.*"\(access_\)\{0,1\}token" *: *"\([^"]*\)".*/\2/p' | head -1)"
    [ -n "$token" ] || { echo "error: no token in the response of $realm" >&2; exit 1; }
    printf 'header = "Authorization: Bearer %s"\n' "$token" >"$cfg"
    ;;
  Basic*|basic*)
    printf '%s\n' "$user_cfg" >"$cfg"
    ;;
esac

accept='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
status="$(curl_ -o "$work/manifest" -D "$work/headers" -w '%{http_code}' -H "Accept: $accept" "$base/manifests/$src")"
if [ "$status" != 200 ]; then
  echo "error: GET $base/manifests/$src answered HTTP $status" >&2
  exit 1
fi
ctype="$(tr -d '\r' <"$work/headers" | sed -n 's/^[Cc]ontent-[Tt]ype: *//p' | tail -1)"
digest="sha256:$(sha256sum "$work/manifest" | cut -d' ' -f1)"

for tag in "$@"; do
  status="$(curl_ -o "$work/put" -w '%{http_code}' -X PUT -H "Content-Type: $ctype" --data-binary "@$work/manifest" "$base/manifests/$tag")"
  case "$status" in
    200 | 201) echo "tagged $image:$tag → $digest" >&2 ;;
    *)
      echo "error: PUT $base/manifests/$tag answered HTTP $status: $(head -c 500 "$work/put")" >&2
      exit 1
      ;;
  esac
done
echo "$digest"
