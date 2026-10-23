#!/bin/sh
# Smoke test of the single-file executable (same checks as .github/workflows/release.yml):
# --version works, the server starts, /api/health answers and the web UI is served.
# Uses node for the HTTP checks, so it also runs in images without curl (node:*-slim).
#
#   scripts/ci/smoke-exe.sh [dist-exe/<executable>]     (default: the first file in dist-exe/)
#
# Exit status: 0 = passed, 1 = failed, 2 = no executable found.
set -eu

exe="${1:-$(find dist-exe -maxdepth 1 -type f | head -1)}"
if [ -z "$exe" ] || [ ! -x "$exe" ]; then
  echo "error: no executable in dist-exe/ – run 'npm run build && npm run build:exe' first" >&2
  exit 2
fi
port="${SMOKE_PORT:-4399}"
data="$(mktemp -d)"
log="$data/server.log"

"$exe" --version
"$exe" --no-open --port "$port" --data-dir "$data/sm-data" >"$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$data"' EXIT

# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
PORT="$port" node --input-type=module -e '
const base = `http://127.0.0.1:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let health;
for (let i = 0; i < 30 && !health?.ok; i++) {
  health = await fetch(`${base}/api/health`).catch(() => undefined);
  if (!health?.ok) await sleep(1000);
}
if (!health?.ok) { console.error(`/api/health did not answer: ${health?.status ?? "no connection"}`); process.exit(1); }
console.log("/api/health:", await health.text());
const html = await (await fetch(`${base}/`)).text();
if (!html.includes("<div id=\"root\">")) { console.error("the web UI is not served at /"); process.exit(1); }
console.log("web UI served");
' || {
  echo "--- server log" >&2
  cat "$log" >&2
  exit 1
}
echo "smoke test passed: $exe" >&2
