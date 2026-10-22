#!/bin/sh
# Prints the container image tags for the current Woodpecker pipeline, one per line
# (used by .woodpecker/container.yaml to tag an image after it passed the scans).
#
#   scripts/ci/image-tags.sh
#
#   tag v1.2.3          → 1.2.3, 1.2, 1, latest
#   tag v1.2.3-beta.1   → 1.2.3-beta.1           (pre-release: no shortcuts, no latest)
#   push to a branch    → the branch name, "/" replaced by "-" (main → main)
#
# Reads CI_PIPELINE_EVENT, CI_COMMIT_TAG and CI_COMMIT_BRANCH (set by Woodpecker).
# The commit SHA tag is pushed by the build step itself.
# Exit status: 0 = tags printed, 2 = nothing to tag (unknown event or invalid tag).
set -eu

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
      echo "$major.$minor"
      echo "$major"
      echo latest
      ;;
  esac
elif [ -n "${CI_COMMIT_BRANCH:-}" ]; then
  # image tags: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}
  printf '%s\n' "$CI_COMMIT_BRANCH" | sed -e 's#[^A-Za-z0-9_.-]#-#g' -e 's#^[.-]#_#' | cut -c1-128
else
  echo "error: no tag or branch for event '$event'" >&2
  exit 2
fi
