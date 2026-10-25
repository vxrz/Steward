#!/usr/bin/env bash
# Downloads Trivy's vulnerability database with retries, so the scans can run with --skip-db-update.
# Trivy falls back to its second repository only when the first can't be reached at all; a mirror that
# fails in the middle of a download (404 on a layer) stopped the whole job. Three attempts, 20 s and 40 s apart.
set -euo pipefail
for attempt in 1 2 3; do
  if trivy image --download-db-only --quiet; then exit 0; fi
  if [ "$attempt" -lt 3 ]; then
    echo "trivy-db: download failed (attempt $attempt of 3), retrying in $((attempt * 20)) s" >&2
    sleep $((attempt * 20))
  fi
done
echo "trivy-db: the vulnerability database could not be downloaded" >&2
exit 1
