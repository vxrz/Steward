#!/bin/sh
# Prints the container image tags for the current pipeline, one per line (used by
# .woodpecker/container.yaml and .github/workflows/container.yml to tag an image after
# it passed the scans).
#
#   scripts/ci/image-tags.sh [--no-major] [--releases <file>]
#
#   tag v1.2.3          → 1.2.3, 1.2, 1, latest
#   tag v1.2.3-beta.1   → 1.2.3-beta.1           (pre-release: no shortcuts, no latest)
#   push to a branch    → the branch name, "/" replaced by "-" (main → main)
#
#   --no-major          leave out the major version tag ("1")
#   --releases <file>   all release tags (v1.2.3, one per line, e.g. from "git tag"): the
#                       shortcuts only move forward – "latest" only for the newest release,
#                       "1.2" only for the newest 1.2.x, "1" only for the newest 1.x.y
#                       (so a fix release for an older line does not take over "latest")
#
# Reads CI_PIPELINE_EVENT, CI_COMMIT_TAG and CI_COMMIT_BRANCH (set by Woodpecker; the GitHub
# workflow sets them from its own variables). The commit SHA tag is pushed by the build step itself.
# Exit status: 0 = tags printed, 2 = nothing to tag (unknown event or invalid tag) or usage error.
set -eu

major_tag=1
releases=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-major) major_tag=0; shift ;;
    --releases) releases="${2:?--releases needs a file}"; shift 2 ;;
    -h | --help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if [ -n "$releases" ] && [ ! -r "$releases" ]; then
  echo "error: cannot read '$releases'" >&2
  exit 2
fi

# newest <version> <prefix>: is <version> the newest stable release starting with <prefix>?
newest() {
  [ -z "$releases" ] && return 0
  top="$( {
    sed -n 's/^v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' "$releases"
    echo "$1"
  } | awk -v p="$2" 'index($0, p) == 1' | sort -V | tail -1)"
  [ "$top" = "$1" ]
}

event="${CI_PIPELINE_EVENT:-}"
if [ "$event" = tag ]; then
  tag="${CI_COMMIT_TAG:?CI_COMMIT_TAG is not set}"
  version="${tag#v}"
  # semver: MAJOR.MINOR.PATCH with an optional -pre-release (no build metadata: "+" is not allowed in image tags)
  if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
    echo "error: tag '$tag' is not a version like v1.2.3 or v1.2.3-beta.1" >&2
    exit 2
  fi
  echo "$version"
  case "$version" in
    *-*) ;; # pre-release
    *)
      major="${version%%.*}"
      minor="${version#*.}"
      minor="${minor%%.*}"
      if newest "$version" "$major.$minor."; then echo "$major.$minor"; fi
      if [ "$major_tag" = 1 ] && newest "$version" "$major."; then echo "$major"; fi
      if newest "$version" ""; then echo latest; fi
      ;;
  esac
elif [ -n "${CI_COMMIT_BRANCH:-}" ]; then
  # image tags: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}
  printf '%s\n' "$CI_COMMIT_BRANCH" | sed -e 's#[^A-Za-z0-9_.-]#-#g' -e 's#^[.-]#_#' | cut -c1-128
else
  echo "error: no tag or branch for event '$event'" >&2
  exit 2
fi
