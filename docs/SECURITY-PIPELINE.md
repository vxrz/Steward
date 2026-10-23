# Security and supply-chain pipeline

What runs where, how to read the results, how to run the checks locally and
what to do with a finding. The vulnerability disclosure policy is in
[SECURITY.md](../SECURITY.md).

## Overview

| Workflow        | Job          | Tool                                                                                                                                   | When                                            | Fails the build on                                                               |
| --------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `ci.yml`        | build-test   | `npm audit --omit=dev --audit-level=moderate`                                                                                          | push, PR                                        | moderate+ advisory in a production dependency                                    |
| `security.yml`  | secrets      | [gitleaks](https://github.com/gitleaks/gitleaks) over the **full git history**                                                         | push, PR, weekly                                | any secret not allow-listed in `.gitleaks.toml`                                  |
|                 | dependencies | `npm audit --omit=dev --audit-level=high`                                                                                              | push, PR, weekly                                | high/critical advisory in a production dependency                                |
|                 |              | [OSV-Scanner](https://google.github.io/osv-scanner/) on `package-lock.json`                                                            | push, PR, weekly                                | any known vulnerability (dev dependencies too) not ignored in `osv-scanner.toml` |
|                 | semgrep      | [Semgrep](https://semgrep.dev) OSS, rule sets `p/default`, `p/typescript`, `p/nodejs`, `p/secrets`, `p/github-actions`, `p/dockerfile` | push, PR, weekly                                | `ERROR`/`HIGH`/`CRITICAL` findings (warnings are reported only)                  |
|                 | trivy-fs     | [Trivy](https://trivy.dev) `fs` (vulnerabilities, misconfiguration, secrets) and `config`                                              | push, PR, weekly                                | high/critical with a fix available; high/critical misconfiguration               |
|                 | lint         | [hadolint](https://github.com/hadolint/hadolint)                                                                                       | push, PR, weekly                                | Dockerfile warnings/errors (`.hadolint.yaml`)                                    |
|                 |              | [actionlint](https://github.com/rhysd/actionlint) (+ shellcheck)                                                                       | push, PR, weekly                                | any workflow error                                                               |
|                 |              | [zizmor](https://docs.zizmor.sh)                                                                                                       | push, PR, weekly                                | workflow security findings of medium severity or higher                          |
| `codeql.yml`    | analyze      | [CodeQL](https://codeql.github.com), `javascript-typescript` (security-extended) and `actions`                                         | push to main, PR, weekly                        | analysis errors (findings are shown in code scanning)                            |
| `container.yml` | image        | Docker Buildx build (not pushed)                                                                                                       | push, tags, PR, weekly                          | build errors                                                                     |
|                 |              | [Syft](https://github.com/anchore/syft) SBOM: CycloneDX JSON, SPDX JSON                                                                |                                                 | –                                                                                |
|                 |              | [Grype](https://github.com/anchore/grype) on the SBOM, `--only-fixed --fail-on high`                                                   |                                                 | high/critical with a fix available                                               |
|                 |              | Trivy `image`, `--ignore-unfixed`                                                                                                      |                                                 | high/critical with a fix available, secrets in the image                         |
| `scorecard.yml` | analysis     | [OpenSSF Scorecard](https://scorecard.dev)                                                                                             | push to main, weekly, branch protection changes | – (score and findings in code scanning)                                          |
| `release.yml`   | sbom         | CycloneDX npm SBOM of the production dependencies                                                                                      | tags, `[build-exe]`                             | – (attached to the release)                                                      |
| Dependabot      | –            | `.github/dependabot.yml`: npm (minor/patch grouped; Mantine and Vite as one PR each), GitHub Actions, Docker base image                | weekly, plus security updates                   | – (opens pull requests)                                                          |

The weekly runs matter: new advisories are published for code that has not
changed.

**Woodpecker CI.** A Forgejo mirror of the repository runs the same checks with
Woodpecker (`.woodpecker/security.yaml`, `container.yaml`, weekly via a cron
named `weekly`), with the same pinned tools from `scripts/security/install-tools.sh`.
There, `container.yaml` also pushes the image to Harbor (branch and version tags
only after Grype and Trivy passed), can sign it with cosign, and uploads the image
and npm SBOMs to Dependency-Track. Setup and differences:
[WOODPECKER.md](WOODPECKER.md).

## Reading the results

- **Job log**: every scanner also prints a human-readable table, so a red job
  tells you what and where without downloading anything.
- **Code scanning** (_Security → Code scanning_): all tools upload SARIF with
  their own category (`gitleaks`, `osv-scanner`, `semgrep`, `trivy-fs`,
  `hadolint`, `zizmor`, `/language:…` for CodeQL, `grype-image`, `trivy-image`,
  `scorecard`). Findings show up as alerts and as annotations on pull requests.
  This needs a public repository or GitHub Advanced Security; elsewhere the upload
  step fails _without_ failing the job (`continue-on-error` on that step only).
  Semgrep findings suppressed in the code (`nosemgrep … -- reason`) are left out
  of the upload – Semgrep keeps them in its SARIF, and code scanning would open
  alerts for them; the `semgrep-report` artifact still has the full file.
- **Artifacts** (on the workflow run page): `*-report` artifacts keep the SARIF
  files for 30 days in any case; `container-sbom` holds the image SBOMs
  (CycloneDX and SPDX, 90 days for tags), `container-scan-reports` the image scan
  results and the Syft JSON SBOM.

SARIF files can be opened with the
[SARIF viewer for VS Code](https://marketplace.visualstudio.com/items?itemName=MS-SarifVSCode.sarif-viewer).

## Running the checks locally

```bash
scripts/security/install-tools.sh            # Linux x86_64: verified binaries into .tools/bin
scripts/security/scan.sh                     # gitleaks, npm audit, OSV, Trivy, hadolint, actionlint, zizmor, Semgrep
scripts/security/scan.sh --image             # … plus build the image, SBOM with Syft, Grype and Trivy image scan
scripts/security/scan.sh --only gitleaks,osv # selected checks
```

On macOS: `brew install gitleaks osv-scanner trivy hadolint actionlint syft grype zizmor`.
Semgrep runs in its official container (Docker). Reports land in `.tools/reports/`
(ignored by git). Without access to `api.osv.dev`, set
`OSV_SCANNER_FLAGS="--offline-vulnerabilities --download-offline-databases"`.

With gitleaks installed (on `PATH` or in `.tools/bin`), the pre-commit hook also scans the
staged changes before each commit (`scripts/gitleaks-staged.sh`, see
[CONTRIBUTING.md](../CONTRIBUTING.md#pre-commit-hooks)). Without it the hook skips this step
with a notice; the full-history scan in CI still runs.

## Handling a finding

1. **Is it real?** Read the rule/advisory. For dependencies check whether the
   vulnerable code is reachable (production or dev dependency? which function?).
2. **Real → fix it.** Update the dependency (`npm update <pkg>`, or wait for /
   merge the Dependabot PR), change the code, or rebuild the image to pick up a
   fixed base image. A leaked secret must be **revoked and rotated** – deleting it
   from the code does not help, it stays in the history.
3. **Not real, or accepted risk → suppress it where it belongs, with a reason**,
   as narrowly as possible, and with an expiry where the tool supports one:

   | Tool        | How to suppress                                                                                                                          |
   | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
   | gitleaks    | exact value + path regex in `.gitleaks.toml` (never whole folders)                                                                       |
   | OSV-Scanner | `[[IgnoredVulns]]` with `reason` and `ignoreUntil` in `osv-scanner.toml`                                                                 |
   | npm audit   | no per-advisory ignore: fix it, or use an `overrides` entry in `package.json`                                                            |
   | Semgrep     | `// nosemgrep: <full rule id> -- <reason>` on the first line of the finding or the line above it (see [Semgrep triage](#semgrep-triage)) |
   | Trivy       | `.trivyignore` (`CVE-… exp:2026-12-31` plus a comment)                                                                                   |
   | Grype       | `.grype.yaml` `ignore:` entry (vulnerability + package) with a comment                                                                   |
   | hadolint    | `# hadolint ignore=DL3008` above the instruction, with a reason                                                                          |
   | zizmor      | `# zizmor: ignore[<audit>]` on the line, with a reason                                                                                   |
   | CodeQL      | dismiss the alert in code scanning with the reason ("false positive", "used in tests", "won't fix")                                      |

4. Mention the decision in the pull request, so the reviewer sees it.

## Supply-chain hardening of the workflows

- **Pinned actions**: every third-party action is pinned to a full commit SHA
  with the version as a comment (`uses: actions/checkout@<sha> # v7.0.1`), so a
  moved or hijacked tag cannot change what runs (cf. the `tj-actions/changed-files`
  incident in 2025). Dependabot updates SHA and comment together.
- **Pinned tools**: scanners are not installed through wrapper actions but as
  release binaries whose SHA-256 is recorded in `scripts/security/install-tools.sh`
  (verified against a second source when updating). Semgrep runs from an image
  pinned by digest, zizmor from PyPI with `--require-hashes`. These pins are
  updated by hand – prefer releases that are at least two weeks old.
- **Least privilege**: `permissions: {}` at the top of the new workflows, and
  each job asks only for what it needs (`contents: read`, plus
  `security-events: write` and `actions: read` for SARIF uploads – the upload
  reads the workflow run and fails with "Resource not accessible by integration"
  without it –, `id-token: write` for Scorecard publishing,
  `contents: write` only for the release job).
- **No credentials on disk**: `actions/checkout` with `persist-credentials: false`
  (nothing in these workflows pushes).
- **No `pull_request_target`**: pull requests from forks run without secrets and
  with a read-only token.
- **No dependency cache in release builds** (cache poisoning); CI and security
  jobs only read public data.
- **Concurrency groups** cancel superseded PR runs (never releases), and every
  job has a `timeout-minutes`.
- **Dependabot cooldown**: new versions are proposed after 14 days (majors 21),
  so a malicious release that is pulled quickly never reaches a PR. The cooldown
  does not delay security updates.
- **Install scripts are enforced, not just listed**: npm 11 only _warns_ about
  packages missing from `allowScripts`. CI, the release builds and the
  `Dockerfile` therefore run `npm ci --ignore-scripts` and then
  `node scripts/install-scripts.mjs --check --run`: the check fails when
  `package-lock.json` contains a package with an install script that is not
  reviewed in `package.json` → `allowScripts` (`"name@version": true` = run,
  `false` = never run), and only the allowed ones are run (`npm rebuild <name>`).
  A dependency update that brings a new install script fails the build until
  someone reviews it.
- **Signed build provenance**: release archives and `SHA256SUMS.txt` get a SLSA
  build provenance attestation and the CycloneDX SBOM an SBOM attestation
  (`actions/attest-build-provenance`, `actions/attest-sbom`, keyless via
  Sigstore – no long-lived signing key). On tags the container image is exported
  as an OCI archive and attested the same way. Verify with
  `gh attestation verify <file> --repo <owner>/<repo>`.

## Container image

`Dockerfile` builds a slim runtime image: base image pinned by digest; only the
server, its production dependencies and the built web UI; no npm/npx/yarn;
non-root numeric user (1000); app files owned by root; node as PID 1 (clean
shutdown on SIGTERM); works with a read-only root file system (`docker-compose.yml`
runs it read-only, with all capabilities dropped and `no-new-privileges`).

## Accepted findings (state of the last review)

Reviewed 2026-10-22 with the tool versions pinned in `install-tools.sh`.

| Tool                 | Finding                                                                                                                                                                                                                                                                     | Decision                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trivy/Grype image    | Debian 12 packages (before the switch to Debian 13 in 0.1.0 – re-check the results of the Container workflow): 1 critical (CVE-2023-45853, zlib minizip – `will_not_fix`, minizip is not shipped), ~56 high (util-linux, ncurses, perl-base, systemd libs, …) without a fix | not failing (`--ignore-unfixed` / `--only-fixed`); they disappear with base image updates. Option: move to `node:24-trixie-slim` or a distroless image (see below).  |
| OSV-Scanner          | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 in `vitest` / `@vitest/mocker` 3.2 (dev only, Vitest dev server)                                                                                                                                                                   | ignored until 2027-01-31 in `osv-scanner.toml`; fix = Vitest 4 upgrade                                                                                               |
| OSV-Scanner          | GHSA-mrhx-c7xc-m3w5 in `zod` 3.25 (runtime): memory exhaustion while validating very large arrays                                                                                                                                                                           | mitigated by the request body shape limits ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#request-body-limits)); ignored until 2026-12-31; fix = zod 4 upgrade (#63) |
| npm audit (all deps) | the same two moderate Vitest advisories                                                                                                                                                                                                                                     | dev only; CI audits production dependencies                                                                                                                          |
| zizmor               | `superfluous-actions` for `softprops/action-gh-release` in `release.yml`                                                                                                                                                                                                    | informational; pinned by SHA. Could be replaced with `gh release create`                                                                                             |

Fixed during the review: AES-GCM decryption without a fixed tag length
(`vault.ts`), unpinned actions and base image, persisted checkout credentials,
npm cache in release builds, unpinned `npx @cyclonedx/cyclonedx-npm@4`, npm and
the old esbuild Go binary (Go 1.23 stdlib CVEs) in the runtime image.

## Semgrep triage

Reviewed 2026-10-22 with Semgrep 1.181.1 and the rule sets of the CI job
(`p/default`, `p/typescript`, `p/nodejs`, `p/secrets`, `p/github-actions`,
`p/dockerfile`): 26 findings, 2 of them blocking. Now: 0 findings. The registry
rule sets change over time, so a later run can report new findings without a
code change – triage them the same way.

How to suppress a false positive: a comment with the **full rule id** (the
`check_id` in `semgrep.json`, e.g.
`javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp`)
and a reason, either at the end of the first line of the finding or on its own
line directly above it:

```ts
// nosemgrep: <full rule id> -- <why this is safe>
```

A bare `// nosemgrep` (no id) would hide every rule on that line; don't use it.
No rule is disabled for the whole repository.

| Rule (short id)               | Where                                                                                          | Decision    | Reason                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawn-shell-true` (ERROR)    | `scripts/dev.mjs`, `scripts/test-pg.mjs` (and the same pattern in `install-scripts.mjs`)       | fixed       | npm runs without a shell on every platform: on Windows `scripts/npm-command.mjs` starts `npm-cli.js` with `node` (Node refuses `.cmd` files without a shell) |
| `dependabot-missing-cooldown` | `.github/dependabot.yml` (Docker: 3 days)                                                      | fixed       | 14 days like the other ecosystems                                                                                                                            |
| `detect-non-literal-regexp`   | `server/src/monitors/gateways.ts` (gateway key patterns)                                       | fixed       | glob matcher without a regular expression (`globMatch`, at most pattern × key steps)                                                                         |
|                               | `web/src/components/editor/ApiOperation.tsx` (path parameters)                                 | fixed       | plain string search instead of a regular expression built from the imported OpenAPI path                                                                     |
|                               | `server/src/monitors/zabbix.ts`, `server/src/records/markdown-io.ts`, `shared/src/markdown.ts` | fixed       | constant inputs: literal regular expressions or a small loop instead                                                                                         |
|                               | `e2e/records.spec.ts`, `e2e/support/helpers.ts`                                                | fixed       | string matching instead of `new RegExp()`                                                                                                                    |
|                               | `server/src/engine/expr.ts`                                                                    | `nosemgrep` | this is the ReDoS guard for process expressions: fixed-length patterns natively, all others in a time-limited worker (`expr-guard.test.ts`)                  |
|                               | `server/src/records/signed.ts` (`stringEntry`)                                                 | `nosemgrep` | the key is a fixed PDF name; the function now rejects anything but letters                                                                                   |
| `incomplete-sanitization`     | `web/src/pages/Monitors.tsx` (example `curl` command)                                          | fixed       | replaces every `*` (`/\*/g`), not only the first; display text, not an escape                                                                                |
| `prototype-pollution-loop`    | `server/src/i18n/index.ts` (`lookup`)                                                          | fixed       | read-only, but now follows own properties only (`Object.hasOwn`)                                                                                             |
| `res-render-injection`        | `server/src/engine/runner.ts` (3 lines)                                                        | `nosemgrep` | false positive: `(step, ctx, key)` looks like Express `(req, res, next)`; `ctx.render()` evaluates expressions, it loads no template by name                 |
| `raw-html-format`             | `server/src/routes/index.ts` (SSO callback page)                                               | `nosemgrep` | values are JSON string literals with `<` escaped; `returnTo` is a validated same-origin path                                                                 |
|                               | `server/src/mock/mockOidc.ts`                                                                  | `nosemgrep` | every value is HTML-escaped; dev/demo-only mock identity provider                                                                                            |
| `bypass-tls-verification`     | `server/src/monitors/checks.ts` (`certExpiry`)                                                 | `nosemgrep` | only reads the expiry date of the presented certificate (expired or self-signed ones are what the check reports); nothing is sent over this connection       |

Tests (`server/test`) and other paths in Semgrep's default ignore list are not
scanned.

## Only on GitHub

These parts cannot be tested outside GitHub Actions: SARIF upload and code
scanning alerts, CodeQL, Scorecard publishing, Dependabot, artifact upload, and
Grype's database download in some restricted networks. Everything else runs with
`scripts/security/scan.sh`. CodeQL, Scorecard, Dependabot and code scanning have
no Woodpecker counterpart (see [WOODPECKER.md](WOODPECKER.md#differences-to-github-actions)).
