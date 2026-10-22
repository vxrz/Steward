# Woodpecker CI (Forgejo, Harbor, Dependency-Track)

The repository can be built by two CI systems from the same files:

- **GitHub Actions** (`.github/workflows/`) on GitHub – unchanged.
- **Woodpecker CI** (`.woodpecker/`) on a self-hosted Forgejo that mirrors the GitHub
  repository, with **Harbor** as the container registry and **Dependency-Track** for SBOMs.

Neither system reads the other's files, so both run side by side. This page covers the
Woodpecker side: what runs, how to set it up, and how it differs from GitHub Actions.
What each scanner checks and how to handle a finding is in
[SECURITY-PIPELINE.md](SECURITY-PIPELINE.md).

Written for Woodpecker 3.x. The files were checked with `woodpecker-cli` 3.19.0
(see [Testing pipeline changes](#testing-pipeline-changes)).

## Overview

| Workflow | What it does | Runs on | GitHub counterpart |
| --- | --- | --- | --- |
| [`ci.yaml`](../.woodpecker/ci.yaml) | `npm ci`, then in parallel: typecheck, `validate`, `i18n:check`, `openapi -- --check`, `npm test` (with Chromium), web build, `npm audit --omit=dev --audit-level=moderate` | push to `main` / `claude/**`, pull requests (not for documentation-only changes), `v*` tags, manual | `ci.yml` (build-test) |
| [`postgres.yaml`](../.woodpecker/postgres.yaml) | the server test suite against a `postgres:16` service (`npm run test:pg`) | push to `main` / `claude/**`, pull requests, manual | `ci.yml` (test-postgres) |
| [`ui-tests.yaml`](../.woodpecker/ui-tests.yaml) | build, then Playwright UI tests (`npm run test:ui`); on failure the server log and failed tests are printed | push to `main` / `claude/**`, pull requests, manual | `ui-tests.yml` |
| [`security.yaml`](../.woodpecker/security.yaml) | gitleaks (full history), npm audit (high), OSV-Scanner, Semgrep, Trivy fs + config, hadolint, actionlint, zizmor, `woodpecker-cli lint` | push to `main` / `claude/**`, pull requests, manual, **cron `weekly`** | `security.yml` |
| [`container.yaml`](../.woodpecker/container.yaml) | build the image; SBOM (Syft), Grype and Trivy scan. On `main` and `v*` tags: push to **Harbor**, scan the pushed image, add the branch/version tags only after the scans passed, optional **cosign** signature, SBOMs to **Dependency-Track** | push to `main` / `claude/**`, pull requests, `v*` tags, manual, **cron `weekly`** | `container.yml` (which never pushes) |
| [`release.yaml`](../.woodpecker/release.yaml) | after `ci` passed: Linux executable (`build` + `build:exe`), smoke test, `.tar.gz`, npm SBOM, SHA-256 checksums; optional **Forgejo release** | `v*` tags, manual (build only) | `release.yml` |

Helper scripts used by the workflows are in `scripts/ci/` (each has `--help` or a usage
header). The scanners are installed with `scripts/security/install-tools.sh` (pinned versions,
SHA-256 verified), the same as on GitHub, so one place pins the tool versions for both.

**Not ported** (GitHub-only): CodeQL, OpenSSF Scorecard, Dependabot, SARIF upload / code
scanning, artifacts – see [Differences to GitHub Actions](#differences-to-github-actions).

## Setup

### 1. Mirror the GitHub repository to Forgejo

**Pull mirror (simplest).** In Forgejo: *+ → New migration → GitHub*, enter the repository
URL, tick **This repository will be a mirror**, and for a private GitHub repository give a
GitHub token with read access (fine-grained: *Contents: read*). Then in the mirror's
*Settings → Repository → Mirror settings*:

- **Mirror interval**: the default is 8h – set it to e.g. `10m` (the instance minimum is
  `[mirror] MIN_INTERVAL`, default 10 minutes). *Synchronize now* forces a sync.
- Forgejo sends **push and tag webhooks for mirror syncs**, which start Woodpecker
  pipelines. After the first sync check *Settings → Webhooks → (the Woodpecker hook) →
  Recent deliveries*.

Limits of a pull mirror: it is read-only, so pull requests are opened on GitHub and only
GitHub Actions test them (Woodpecker sees branches and tags, not GitHub pull requests).
Forgejo may also refuse to create releases in a mirror (the optional Forgejo release in
`release.yaml`); if it does, use a push mirror.

**Push mirror (alternative).** Keep a normal (non-mirror) repository on Forgejo and push
into it: from your machine (`git remote add forgejo … && git push forgejo --mirror`), from a
scheduled job, or from a GitHub repository's *push mirror* equivalent. Pushes arrive
immediately and pull requests opened on Forgejo run the `pull_request` pipelines. The
other direction works too – Forgejo as the primary repository with a *push mirror* to
GitHub (Forgejo: *Settings → Repository → Mirror settings → Push mirror*), so GitHub Actions
keep running there.

### 2. Activate the repository in Woodpecker

Woodpecker connected to Forgejo (`WOODPECKER_FORGEJO=true`, `WOODPECKER_FORGEJO_URL=…`).
*Repositories → Add repository → steward → Enable*. In the repository settings:

| Setting | Recommended | Why |
| --- | --- | --- |
| Pipeline path | empty (default) | uses `.woodpecker/*.yaml` |
| Require approval for | **forks** (default), or **pull requests** for a public instance | a pipeline from someone without write access waits for approval before it runs |
| Allow pull requests | on | PR pipelines run without secrets (see below) |
| Allow deployments | off | not used |
| Trusted (network / volumes / security) | **off** | nothing here needs it (see step 3) |
| Timeout | 60 minutes | the UI tests and the image build take 5–15 minutes each |
| Cancel previous pipelines | pull request, push | like the concurrency groups on GitHub (never cancels tag pipelines) |
| Project visibility | private or internal | logs show dependency and scan details |

The agent(s) need the Docker backend on **linux/amd64** (`security.yaml`, `container.yaml`
and the default `release.yaml` target say so with `labels: platform: linux/amd64`, because
the pinned tool binaries are x86_64). Outbound access is needed to registry.npmjs.org,
Docker Hub, github.com (tool downloads), the scanner databases (Trivy: `mirror.gcr.io` /
`ghcr.io`; Grype: `grype.anchore.io`; OSV: `api.osv.dev`; Semgrep rules: `semgrep.dev`) and
the Playwright CDN (`cdn.playwright.dev`, `playwright.download.prss.microsoft.com`).

### 3. Allow the buildx plugin to run privileged (server admin)

`container.yaml` builds the image with
[`woodpeckerci/plugin-docker-buildx`](https://woodpecker-ci.org/plugins/docker-buildx), which
starts its own Docker daemon and therefore needs privileged mode. Since Woodpecker 3 no plugin
is privileged by default. On the **Woodpecker server**:

```ini
WOODPECKER_PLUGINS_PRIVILEGED=woodpeckerci/plugin-docker-buildx
```

An entry without a tag matches every tag and digest; to allow only the pinned version, give
the exact reference instead
(`woodpeckerci/plugin-docker-buildx:6.1.2@sha256:d26b69cb…`, update it with the pin).

Why this and not *Trusted*: with `WOODPECKER_PLUGINS_PRIVILEGED` only that plugin image runs
privileged, and a plugin step cannot run arbitrary commands (Dockerfile `RUN` instructions run
in unprivileged build containers). Marking the repository *trusted (security)* and writing
`privileged: true` would let **any** step of any pipeline of this repository – including a
pull request – run privileged commands on the agent. Keep *trusted* off.

Alternatives without privileged mode, with their trade-offs:

| Option | Privileged | Trade-offs |
| --- | --- | --- |
| buildx plugin (used) | yes, plugin only | official, multi-arch, caches; needs the server setting above |
| buildx plugin with `remote_builders` + `daemon_off: true` against a separate BuildKit host | no | an extra BuildKit service to run and secure (mTLS) |
| kaniko (`gcr.io/kaniko-project/executor`) | no | upstream archived in 2025 (community forks exist), slower, no multi-arch in one step, runs as root in the step container |
| Docker-in-Docker service (`docker:dind`) | yes, and the repository must be trusted | every step can talk to a privileged daemon – not recommended |

### 4. Set these two values

The Harbor host and the Dependency-Track URL are not secret; they are set at the top of
[`.woodpecker/container.yaml`](../.woodpecker/container.yaml) (`variables:`):

```yaml
  # 1. Harbor host (registry and image; the Harbor project is "steward")
  - &harbor_registry harbor.example.com
  - &harbor_image harbor.example.com/steward/steward
  # 2. Dependency-Track API server base URL
  - &dependency_track_url https://dtrack.example.com
```

| Value | Example | Notes |
| --- | --- | --- |
| **`HARBOR_REGISTRY`** – Harbor host | `harbor.example.com` | appears twice: `harbor_registry` and `harbor_image` (`<host>/steward/steward`) |
| **`DEPENDENCY_TRACK_URL`** – Dependency-Track API base URL | `https://dtrack.example.com` | the API server (where `/api/v1/…` is), which is not the front end when they run on separate hosts; the upload script refuses the placeholder |

Woodpecker has no repository-level (non-secret) variables, which is why the values live in the
file. Instance-wide values could come from `WOODPECKER_ENVIRONMENT` on the server instead.

### 5. Create the secrets

*Repository settings → Secrets → Add secret*, or with the CLI
(`woodpecker-cli repo secret add --repository <owner>/steward --name … --value @file --event push --event tag`).
Secrets are **never available to pull request pipelines** unless you tick the
`pull_request` event – don't. Values are masked in the logs.

| Secret | Required | Used by (step) | Events | Image filter |
| --- | --- | --- | --- | --- |
| `harbor_username` | yes | `container.yaml`: publish, scan-pushed, promote, sign | push, tag | **none** – the scan, promote and sign steps are command steps, and Woodpecker only hands image-filtered secrets to plugins |
| `harbor_password` | yes | same | push, tag | none (as above) |
| `dependency_track_api_key` | yes | `container.yaml`: dependency-track | push, tag | none (command step) |
| `forgejo_token` | optional | `release.yaml`: forgejo-release, forgejo-prerelease | tag | **`woodpeckerci/plugin-release`** (only the plugin gets it) |
| `cosign_key` | optional | `container.yaml`: sign | push, tag | none (command step) |
| `cosign_password` | optional (with `cosign_key`) | same | push, tag | none |

Who can read these secrets: anyone who can make a push or tag pipeline run with a modified
workflow file – with a pull mirror, everyone with write access to the GitHub repository (on
any branch: Woodpecker cannot limit secrets to branches). Keep the credentials narrow:
a Harbor robot account for one project without delete rights, a Dependency-Track team with
upload rights only. If you want the Harbor credentials to reach the buildx plugin only, set the
image filter `woodpeckerci/plugin-docker-buildx` and make the Harbor project's images readable
for the scanners another way (public project, or a second read-only robot) – the scan,
promote and sign steps then need changing.

**Optional steps.** Woodpecker fails a pipeline that references a secret which does not
exist, so the optional steps are switched on in the file, not by creating the secret:

- image signing: `&cosign_enabled 'true'` in `container.yaml` (after creating `cosign_key`
  and `cosign_password`);
- Forgejo release: `&forgejo_release_enabled 'true'` in `release.yaml` (after creating
  `forgejo_token`).

### 6. Harbor

1. *Projects → New project* `steward` (private). Storage quota as you like.
2. *Project → Configuration*:
   - **Automatically scan images on push** – Harbor scans with its built-in Trivy as well
     (independent of the pipeline's scans; it also rescans when you trigger it or on the
     *Interrogation Services → Vulnerability* schedule – set a daily schedule there).
   - **Prevent vulnerable images from running** – careful: Harbor's threshold ignores whether
     a fix exists, and the Debian base image has unfixed high and one unfixed critical finding
     (see SECURITY-PIPELINE.md, "Accepted findings"). With this option on, Harbor would also
     refuse the pipeline's own scanners (`scan-pushed` pulls the image) and your deployments.
     Turn it on only together with the project's **CVE allowlist** for the accepted, unfixed
     CVEs (with an expiry date), or leave it off and rely on the pipeline gate (release tags
     only after a passed scan) plus Dependency-Track.
   - **Cosign** under *Enforce content trust* (optional, with image signing): only signed
     images can be pulled.
   - SBOM generation on push (Harbor 2.11+) is optional; the pipeline already sends the SBOM
     to Dependency-Track.
3. *Project → Robot accounts → New robot account* `woodpecker`: expiration as your policy
   requires, permissions **Repository: Pull, Push** and **Artifact: Read** (cosign signatures
   are pushed as artifacts too). No delete, no tag-retention or project admin rights. The robot
   name is `robot$steward+woodpecker` (the prefix depends on the Harbor setting) – that is
   `harbor_username`; the generated secret is `harbor_password`.
4. Optional: *Tag immutability* for `[0-9]*.[0-9]*.[0-9]*` (release tags never move) and a
   *Tag retention* rule that keeps release tags and e.g. the last 20 commit-SHA tags.

Tags the pipeline creates: `<commit sha>` (every published build), `main`, and for a tag
`v1.2.3`: `1.2.3`, `1.2`, `1`, `latest` (a pre-release `v1.2.3-beta.1` only gets
`1.2.3-beta.1`). The extra tags are added with `scripts/ci/registry-tag.sh` after Grype and
Trivy passed, so `main`/`latest` never point at an image that failed the scan.

### 7. Dependency-Track

1. *Administration → Access Management → Teams → Create team* `woodpecker`, permissions
   **BOM_UPLOAD** and **PROJECT_CREATION_UPLOAD** (with portfolio access control enabled also
   give the team access to the projects, or **VIEW_PORTFOLIO**). Generate an **API key** –
   that is `dependency_track_api_key`.
2. Projects are created on the first upload (`autoCreate=true`):

   | Project | SBOM | Version |
   | --- | --- | --- |
   | **Steward** | the container image (Syft, CycloneDX): Debian packages, Node.js, the npm production dependencies | tag without `v` (`1.2.3`) or the branch (`main`) |
   | **Steward npm** | the npm production dependencies (`@cyclonedx/cyclonedx-npm --omit dev`): what the desktop executable and `npm start` installations contain | same |

   A separate project for the npm SBOM because Dependency-Track keeps one SBOM per project
   version – a second upload to *Steward* would replace the image SBOM. Release versions are
   marked as the project's latest version (Dependency-Track 4.12+).
3. **Policies** (*Policy Management*): e.g. a *Security* policy "severity is CRITICAL" →
   fail, and a *License* policy for licence groups you don't accept (copyleft in a
   distributed binary).
4. **Notifications** (*Administration → Notifications → Alerts*): *NEW_VULNERABILITY*,
   *NEW_VULNERABLE_DEPENDENCY* and *POLICY_VIOLATION* for the two projects, to e-mail, a
   webhook or a chat channel. Dependency-Track re-analyses stored SBOMs against new
   advisories by itself (daily by default), so a release keeps being watched after the build.

### 8. Weekly security scans (cron)

`security.yaml` and `container.yaml` (build + scan, no push) also run for the cron named
**`weekly`** – new advisories appear without code changes. Create it once:

- UI: *Repository settings → Crons → Add cron*: name `weekly`, branch `main`, schedule
  `17 5 * * 1` (Mondays 05:17 UTC);
- or CLI: `woodpecker-cli repo cron add --repository <owner>/steward --name weekly --branch main --schedule "17 5 * * 1"`.

Only workflows whose `when` lists `event: cron` (with `cron: weekly`) run for it. Cron
pipelines get the secrets of the `cron` event – none of the cron steps needs one.

### 9. Releases

`release.yaml` runs for `v*` tags after `ci.yaml` passed. It builds the Linux x64 executable,
smoke-tests it (`scripts/ci/smoke-exe.sh`, the same checks as `release.yml`), and writes
`out/steward-linux-x64.tar.gz`, `out/sbom.cdx.json` and `out/SHA256SUMS-linux-x64.txt`. With
`&forgejo_release_enabled 'true'` and the secret `forgejo_token` (Forgejo: *Settings →
Applications → Access token*, scope **repository: read and write**) the files are attached to
a Forgejo release named after the tag; `v1.2.3-beta.1` and similar become pre-releases.

- **Linux arm64**: uncomment the `linux-arm64` entry of the `matrix` in `release.yaml` once an
  arm64 agent is connected – a matrix entry without a matching agent waits forever.
- **Windows and macOS** executables come from GitHub Actions only (Woodpecker agents are
  usually Linux; the macOS build needs a Mac). Add them to the Forgejo release after the
  GitHub release is published, e.g.:

  ```bash
  gh release download v1.2.3 --repo <owner>/steward --dir out --pattern 'steward-*'
  # Forgejo API (or the tea CLI: tea releases assets create v1.2.3 out/*)
  rel=$(curl -fsS -H "Authorization: token $FORGEJO_TOKEN" https://forgejo.example.com/api/v1/repos/<owner>/steward/releases/tags/v1.2.3 | jq .id)
  for f in out/steward-windows-* out/steward-macos-*; do
    curl -fsS -H "Authorization: token $FORGEJO_TOKEN" -F "attachment=@$f" \
      "https://forgejo.example.com/api/v1/repos/<owner>/steward/releases/$rel/assets?name=$(basename "$f")"
  done
  ```

  Or simply link the GitHub release in the release notes.
- "Run pipeline" (manual event) on a branch builds and smoke-tests the executable without a
  release – the counterpart of `workflow_dispatch` / `[build-exe]` on GitHub. The files are
  not kept (no artifact store).

### 10. Test reports

Woodpecker has no artifact store. Each scanner prints a readable table in the step log, and a
failed UI test run prints the demo server log and the paths of traces and screenshots
(`report` step in `ui-tests.yaml`). To keep `playwright-report/` and `test-results/`, enable
the commented `upload-report` step in `ui-tests.yaml`: it uploads them to an S3-compatible
bucket (MinIO, Garage, …) with `woodpeckerci/plugin-s3`, using the secrets `s3_access_key` /
`s3_secret_key` (image filter `woodpeckerci/plugin-s3`, events push and manual). Then open a
trace with `npx playwright show-trace <url or file>`.

## Differences to GitHub Actions

| GitHub Actions | Woodpecker |
| --- | --- |
| CodeQL (`codeql.yml`) | not available (GitHub product). Semgrep (`security.yaml`) covers SAST on both systems. |
| OpenSSF Scorecard (`scorecard.yml`) | not available (it evaluates GitHub settings). |
| Dependabot (`dependabot.yml`) | not available. Use **Renovate** on Forgejo (Renovate has a Forgejo/Gitea platform and a `woodpecker` manager that also updates the image pins in `.woodpecker/`), or keep relying on the Dependabot PRs on GitHub that reach Forgejo through the mirror. |
| SARIF upload, code scanning alerts, PR annotations | not available: results are in the step logs (tables). Harbor and Dependency-Track show image vulnerabilities. |
| Artifacts (reports, SBOMs, executables) | no artifact store: SBOMs go to Dependency-Track, executables to the Forgejo release; reports optionally to S3 (see above). |
| `concurrency` groups | project setting *Cancel previous pipelines* (pull request, push). Woodpecker's workflow-level `concurrency` (newer 3.x releases) is not used, so older 3.x servers accept the files. |
| `[build-exe]` in a commit message | manual pipeline ("Run pipeline") instead. |
| Container image (`container.yml`): built and scanned, never pushed | pushed to Harbor (main, tags), scanned, tagged, optionally signed, SBOMs to Dependency-Track |
| Windows and macOS executables (`release.yml`) | not built (Linux agents) – see [Releases](#9-releases) |

## Pipeline security

- **Pinned images**: every image and plugin is pinned by digest, with the tag as a comment
  (`node:24-bookworm-slim` uses the same digest as the `Dockerfile`). Tools come from
  `scripts/security/install-tools.sh` (SHA-256 per release asset), cosign from
  `scripts/ci/cosign-sign.sh` (same), zizmor with `--require-hashes`, Semgrep from its image
  digest. `npx @cyclonedx/cyclonedx-npm@4.2.1` is pinned by version (npm verifies the
  registry integrity hash).
- **Least privilege**: no step sets `privileged`; only the buildx plugin runs privileged, via
  the server allow-list (step 3). The repository is not trusted, so steps cannot mount host
  volumes or the Docker socket.
- **Secrets**: only via `from_secret`, only on push/tag events (never pull requests, never
  fork PRs), plugin-only where the consumer is a plugin (`forgejo_token`). Scripts pass
  credentials to curl in a temporary config file (not on the command line) and never print
  them.
- **Pull requests** run without secrets, and fork PRs wait for approval (step 2). PR builds of
  the image are not pushed.
- **No volumes and no cache** between pipelines (cache poisoning; release builds also run
  `npm ci` from scratch). An npm cache could be added with a cache plugin backed by S3, but it
  is not worth the risk for a ~30 s install.
- **Clone**: the default clone step (`woodpeckerci/plugin-git`) everywhere; `security.yaml`
  pins it and clones the full history for gitleaks. Clone credentials only go to the trusted
  clone plugins (`WOODPECKER_PLUGINS_TRUSTED_CLONE` – the default entry matches the pinned
  digest). `skip_clone` is not used: every workflow needs the sources or the `scripts/ci/`
  helpers.
- **Scan before tag**: the branch and release tags are added only to an image that passed
  Grype and Trivy. The commit-SHA tag exists before the scan – deploy by branch/version tag
  (or by a digest you checked), not by commit-SHA tags.

## Testing pipeline changes

```bash
# lint (download woodpecker-cli from https://github.com/woodpecker-ci/woodpecker/releases, check
# it against checksums.txt of the release)
woodpecker-cli lint --strict --plugins-privileged woodpeckerci/plugin-docker-buildx .woodpecker/

# run a workflow locally in Docker (the repository is mounted as the workspace)
woodpecker-cli exec --repo <owner>/steward --pipeline-event push --commit-branch main \
  --commit-sha "$(git rev-parse HEAD)" .woodpecker/ci.yaml
woodpecker-cli exec --pipeline-event pull_request --plugins-privileged woodpeckerci/plugin-docker-buildx \
  .woodpecker/container.yaml                                     # build + scan, no push
woodpecker-cli exec --pipeline-event push --commit-branch main \
  --secrets-file .woodpecker-secrets.yaml .woodpecker/container.yaml   # keep that file out of git
```

`security.yaml` runs `woodpecker-cli lint` on every push as well. The scripts in `scripts/ci/`
run on their own too (e.g. `scripts/ci/image-scan.sh archive steward.tar` after
`docker save`).

## Updating pinned images

Resolve the current digest of a tag and replace the digest *and* the tag comment:

```bash
docker buildx imagetools inspect node:24-bookworm-slim --format '{{json .Manifest.Digest}}'
# or: crane digest node:24-bookworm-slim / regctl image digest node:24-bookworm-slim
```

| Pin | Where | Keep in sync with |
| --- | --- | --- |
| `node:24-bookworm-slim` | all workflows except `security.yaml`'s tool steps | `Dockerfile` (Dependabot updates it there) |
| `postgres:16.15-bookworm` | `postgres.yaml` | – |
| `buildpack-deps:bookworm-scm` | `security.yaml`, `container.yaml` | – |
| `python:3.13-slim-bookworm` | `security.yaml` (zizmor) | – |
| `semgrep/semgrep:1.181.1` | `security.yaml` | `security.yml`, `scripts/security/scan.sh` |
| `woodpeckerci/plugin-docker-buildx:6.1.2` | `container.yaml` | `WOODPECKER_PLUGINS_PRIVILEGED` if it names the digest |
| `woodpeckerci/plugin-git:2.10.1` | `security.yaml` | – |
| `woodpeckerci/plugin-release:0.3.2` | `release.yaml` | secret image filter (no tag needed) |
| `woodpeckerci/woodpecker-cli:v3.19.0-alpine` | `security.yaml` | your server version |
| cosign 3.1.3 (binary + SHA-256) | `scripts/ci/cosign-sign.sh` | – |
| scanners (Syft, Grype, Trivy, …) | `scripts/security/install-tools.sh` | both CI systems use it |

Prefer releases that are at least two weeks old. Renovate's `woodpecker` manager can open the
update PRs for the image pins.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No pipelines after a GitHub push | the mirror has not synced yet (interval) or the webhook failed: *Synchronize now*, then *Settings → Webhooks → Recent deliveries*. Woodpecker must be able to reach Forgejo and the other way round. |
| Linter: *"The formerly privileged plugin … is no longer privileged by default"* / buildx fails with *"Cannot connect to the Docker daemon"* | `WOODPECKER_PLUGINS_PRIVILEGED` is missing on the server (setup step 3). |
| *secret "harbor_username" not found* / *… not allowed to be used with pipeline event* | create the secret, or add the event (push, tag) to it. |
| *secret … is only allowed to be used by plugins* | remove the image filter from that secret – the step is a command step (table in step 5). |
| publish fails with `unauthorized` | robot account name (incl. `robot$…` prefix) or secret wrong, or the robot lacks *Push* on project `steward`. |
| `scan-pushed` fails, image tags missing | expected when Grype/Trivy find high/critical vulnerabilities with a fix: the image keeps only its commit-SHA tag. Rebuild with a fixed base image or dependency, or suppress with a reason (SECURITY-PIPELINE.md). |
| dependency-track: *set DEPENDENCY_TRACK_URL* | the placeholder in `container.yaml` (setup step 4). |
| dependency-track: HTTP 401/403 | API key wrong, or the team lacks BOM_UPLOAD / PROJECT_CREATION_UPLOAD (or portfolio access). |
| dependency-track: HTTP 413 | the reverse proxy in front of Dependency-Track limits the request size (e.g. nginx `client_max_body_size 20m`). |
| `npx playwright install --with-deps` fails | the agent cannot reach the Playwright CDN or the Debian mirrors; allow them or use a proxy (`HTTPS_PROXY` via `WOODPECKER_ENVIRONMENT`). |
| Grype: *failed to load vulnerability db* | the agent cannot reach `grype.anchore.io`; Trivy needs `mirror.gcr.io` / `ghcr.io`. |
| `release.yaml` waits forever | a `linux-arm64` matrix entry without an arm64 agent. |
| `release.yaml` does not run for a tag | it depends on `ci.yaml`; a workflow whose dependency is not part of the pipeline is left out too. |
| Forgejo release: *repo is a mirror* / 404 | Forgejo does not allow releases in a pull mirror; use a push mirror (step 1) or attach the files by hand. |
| gitleaks scans only one commit | the full-history clone settings in `security.yaml` were changed (`partial: false`, `depth: 0`); the step prints the number of commits first. |
