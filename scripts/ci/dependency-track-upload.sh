#!/bin/sh
# Uploads a CycloneDX SBOM to Dependency-Track (multipart POST /api/v1/bom). The project
# (name + version) is created on the first upload (autoCreate); a later upload for the
# same version replaces its components. Used by .woodpecker/container.yaml.
#
#   scripts/ci/dependency-track-upload.sh <sbom.cdx.json> <project name> <project version> [--latest]
#
# Environment: DEPENDENCY_TRACK_URL (base URL, e.g. https://dtrack.example.com – the API
# server, not the front end if they run on different hosts) and DEPENDENCY_TRACK_API_KEY
# (team API key with BOM_UPLOAD and PROJECT_CREATION_UPLOAD). The key is passed to curl in
# a config file, never on the command line. --latest marks this version as the project's
# latest (Dependency-Track 4.12+, ignored by older versions).
# Exit status: 0 = uploaded, 1 = upload failed, 2 = usage or configuration error.
set -eu

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
bom="$1"
name="$2"
version="$3"
latest="${4:-}"
url="${DEPENDENCY_TRACK_URL:-}"
url="${url%/}"
case "$url" in
  "" | *example.com* | *example.org*)
    echo "error: set DEPENDENCY_TRACK_URL to your Dependency-Track API server (now: '${url:-unset}')" >&2
    echo "       see docs/WOODPECKER.md, \"Set these two values\"" >&2
    exit 2
    ;;
  https://* | http://*) ;;
  *) echo "error: DEPENDENCY_TRACK_URL must start with https:// (got '$url')" >&2; exit 2 ;;
esac
[ -n "${DEPENDENCY_TRACK_API_KEY:-}" ] || { echo "error: DEPENDENCY_TRACK_API_KEY is empty (secret dependency_track_api_key)" >&2; exit 2; }
[ -s "$bom" ] || { echo "error: SBOM '$bom' is missing or empty" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
printf 'header = "X-Api-Key: %s"\n' "$(printf '%s' "$DEPENDENCY_TRACK_API_KEY" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')" >"$work/curl.cfg"

set -- -F autoCreate=true -F "projectName=$name" -F "projectVersion=$version" -F "bom=@$bom;type=application/json"
[ "$latest" = --latest ] && set -- "$@" -F isLatest=true

status="$(curl -sS --proto '=https,http' --retry 3 --retry-all-errors -K "$work/curl.cfg" -o "$work/response" -w '%{http_code}' \
  -X POST "$url/api/v1/bom" "$@")" || status="000"
case "$status" in
  200 | 201)
    echo "Dependency-Track: uploaded $(basename "$bom") to project '$name' version '$version' (processing token: $(sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p' "$work/response"))" >&2
    ;;
  401 | 403)
    echo "error: Dependency-Track answered HTTP $status – check the API key and its permissions (BOM_UPLOAD, PROJECT_CREATION_UPLOAD)" >&2
    exit 1
    ;;
  *)
    echo "error: Dependency-Track answered HTTP $status: $(head -c 500 "$work/response" 2>/dev/null)" >&2
    exit 1
    ;;
esac
