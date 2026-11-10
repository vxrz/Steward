# 0024. Signed releases: build provenance, offline verification and an update notice

- **Status:** Accepted (owner decision 2026-11-10) – every _Recommendation_ below was taken as recommended (see _Decided (November 2026)_); not built yet
- **Date:** 2026-11-09
- **Since:** planned for 0.14 (#30) – releases ([RELEASES.md](../RELEASES.md)), updating ([INSTALL.md](../INSTALL.md#6-updating))

## Context

Plants install Steward on hosts that are often air-gapped or behind strict egress rules, and they update when a maintenance window allows – never on their own. The owner's position for OT: **no silent auto-update**. People still need to learn that an update exists, what it asks of them before updating, and to prove that what they install is what this repository built.

What the release pipeline does today:

- **Desktop executables** (`.github/workflows/release.yml`): five targets built on native runners, each smoke-tested, packed (`.zip` / `.tar.gz`); a CycloneDX SBOM of the npm production dependencies (`npm sbom --omit=dev`); `SHA256SUMS.txt`. For a `v*` tag the release job creates **SLSA build provenance** for every archive and `SHA256SUMS.txt` with `actions/attest-build-provenance` (`4d101475…`, v4.2.2) and an **SBOM attestation** with `actions/attest-sbom` (`c6043329…`, v4.1.0) – keyless, Sigstore public-good instance, stored in GitHub's attestations API – and attaches the files with `softprops/action-gh-release` (`generate_release_notes: true`).
- **Container image** (`.github/workflows/container.yml`): built and scanned once per platform and variant, pushed with digests preserved, then **cosign** signs the index and every platform image keylessly (`cosign sign --recursive`); build provenance for the index and each platform digest and an SBOM attestation (Syft, CycloneDX) per platform are pushed to the registry (`push-to-registry: true`).
- **SLSA level claimed: Build L2** ([ci/SECURITY-PIPELINE.md](../ci/SECURITY-PIPELINE.md#supply-chain-hardening-of-the-workflows)) – not L3, because the provenance is made by a step of the building workflow.
- **Pinning policy**: actions pinned by commit SHA with the version as comment; Dependabot cooldown 14 days (majors 21); hand-pinned tools "at least two weeks old".
- **Woodpecker** (`.woodpecker/`, a self-hosted Forgejo mirror): Linux executable and image; an **optional** cosign signature with a key pair, not in the public transparency log (`scripts/ci/cosign-sign.sh`).
- **Verification docs** ([SECURITY-HARDENING.md](../SECURITY-HARDENING.md#verifying-downloads)): `gh attestation verify <archive> --repo vxrz/Steward`, `sha256sum -c`, `cosign verify` with the workflow identity, `gh attestation verify oci://…` with `--signer-workflow` and `--source-ref`. All of them fetch attestations online.
- **Executables are not code-signed** (Authenticode, Apple notarisation); INSTALL.md says so. The desktop executable re-checks its unpacked files against hashes embedded at build time at every start.
- **After an update** Steward copies the database first (SQLite copy or `pg_dump`, `SM_UPGRADE_BACKUP_*`), audits `system.upgraded` and shows administrators a notice (`server/src/system/update-notice.ts`). Nothing tells anyone **before** an update. "Nothing in it calls home" ([ARCHITECTURE.md](../ARCHITECTURE.md#context-c4-level-1)).
- **The changelog** marks changes to act on with **Check before updating** in its entries ([CHANGELOG.md](../../CHANGELOG.md)); the GitHub release notes are generated from pull requests and do not carry them.

What the action documentation says (checked on the repositories, November 2026):

- `actions/attest-build-provenance` **v4 is a wrapper** around `actions/attest`: "new implementations should use `actions/attest` instead" (README, <https://github.com/actions/attest-build-provenance>). Its tag v4.2.2 is the SHA pinned today (commit of 2026-08-21).
- `actions/attest-sbom` is **being deprecated** in favour of `actions/attest`, "all of the existing action inputs are compatible" (README, <https://github.com/actions/attest-sbom>).
- `actions/attest` v4.2.2 (`1e69f48a…`, 2026-08-04 – older than two weeks) produces provenance (no predicate input), SBOM (`sbom-path`) or custom attestations; one attestation covers all subjects given at once; it writes each attestation as a **Sigstore bundle** (JSON) and returns its path (`bundle-path`). Its README lists the permissions `id-token: write`, `attestations: write` and `artifact-metadata: write` (the last for storage records, which `create-storage-record: false` already turns off for this user-owned repository – to confirm on the first run). Artifact attestations are not supported on GitHub Enterprise Server (<https://github.com/actions/attest>).
- `gh attestation verify` takes `--bundle <file>` ("for offline verification using attestations stored on disk") and `--custom-trusted-root <trusted_root.jsonl>`; `gh attestation trusted-root` writes that file and `gh attestation download` saves bundles (source of the GitHub CLI, `pkg/cmd/attestation/` in <https://github.com/cli/cli>).
- docs.github.com was not reachable from where this was written; statements about the REST API below (the releases endpoints, the unauthenticated rate limit of 60 requests per hour) are from memory and marked _assumption_.

## Decision

### 1. Provenance and SBOM attestations

| Option                                                                                                                    | For                                                                                    | Against                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Keep as is**                                                                                                         | nothing to change                                                                      | `attest-sbom` is being deprecated; attestations are only online; air-gapped plants cannot verify                                                                       |
| **B. Move to `actions/attest` (v4.2.2, pinned by SHA) and publish the Sigstore bundles as release assets**; keep Build L2 | one action instead of two; the same claims; bundles make offline verification possible | a workflow change in a security-relevant job; a few more release files                                                                                                 |
| **C. SLSA Build L3** with an isolated reusable provenance workflow (for example the SLSA GitHub generator)                | provenance the build cannot influence                                                  | another third-party dependency in the release path; the generic generator attests hashes the build job hands over; more moving parts for a project with one maintainer |

_Recommendation:_ **B**, and C only when a user asks for L3.

- `release.yml`: one `actions/attest` step for provenance over `steward-*`, `SHA256SUMS.txt`, `release-index.json` (section 4) and the SBOM; one for the SBOM attestation. The `bundle-path` outputs are attached to the release as `provenance.sigstore.json` and `sbom.sigstore.json`.
- `container.yml`: `actions/attest` in place of both actions, inputs unchanged; bundles stay in the registry (`push-to-registry: true`). cosign stays for the image signature.
- **The exe SBOM** stays the npm production dependencies; the release notes and SECURITY-HARDENING.md say it does not list the embedded Node.js runtime, whose version the About page shows. (Syft over the unpacked archive was the alternative; see _Decided_, question 7.)
- Workflow permissions grow by `artifact-metadata: write` only if the first run shows it is needed.

### 2. Verification for operators

SECURITY-HARDENING.md gets one table per artifact, **online and offline**, with the full identity – the workflow file and the tag – instead of a repository alone:

```bash
# online – desktop archive
gh attestation verify steward-linux-x64.tar.gz --repo vxrz/Steward \
  --signer-workflow vxrz/Steward/.github/workflows/release.yml --source-ref refs/tags/v<version>
sha256sum -c SHA256SUMS.txt --ignore-missing

# offline – on a connected machine once: gh attestation trusted-root > trusted_root.jsonl
gh attestation verify steward-linux-x64.tar.gz --repo vxrz/Steward \
  --bundle provenance.sigstore.json --custom-trusted-root trusted_root.jsonl \
  --signer-workflow vxrz/Steward/.github/workflows/release.yml --source-ref refs/tags/v<version>
# the SBOM attestation: the same with --bundle sbom.sigstore.json --predicate-type https://cyclonedx.org/bom

# container image: signature (cosign) and provenance (registry)
cosign verify ghcr.io/vxrz/steward:<version> \
  --certificate-identity https://github.com/vxrz/Steward/.github/workflows/container.yml@refs/tags/v<version> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/vxrz/steward:<version> --repo vxrz/Steward --bundle-from-oci \
  --signer-workflow vxrz/Steward/.github/workflows/container.yml --source-ref refs/tags/v<version>
```

`cosign verify-attestation` (images) and `cosign verify-blob-attestation --bundle …` (archives) are documented as an alternative for sites that standardise on cosign – _assumption, to be confirmed with cosign 3_: whether they read the bundles GitHub's action writes and stores as OCI referrers. Only commands that a CI job has run go into the docs.

**Verify what we publish:** a new job at the end of both release workflows runs exactly the documented commands – online, and offline with `--bundle` and a trusted root fetched in the job – against the just-published files and image. A release whose documented verification fails is marked as such in its notes before anyone downloads it.

### 3. Operating-system code signing of the executables

| Option                                                             | For                                                  | Against                                                                                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **A. None; Sigstore provenance is the proof** (today)              | no certificate costs, no long-lived signing identity | SmartScreen and Gatekeeper warnings; company rollouts sign themselves                                      |
| **B. Authenticode and Apple notarisation in the release workflow** | no warnings; companies can allow by publisher        | yearly certificates and an Apple developer account; a long-lived secret (or a cloud signing service) in CI |

_Recommendation:_ **A** for now. The warnings are documented, and companies that roll out the executable sign it with their own certificate (INSTALL.md). Revisit when installations outside a managed software centre become common.

### 4. Where "update available" comes from

| Option                                                                                                                                                                                | For                                                                                                | Against                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Off** – an administrator can still read a release index from a file                                                                                                              | nothing leaves the installation; works air-gapped                                                  | people must remember to look                                                                                                                                        |
| **B. GitHub, opt-in**: at most once a day, the releases of `vxrz/Steward` and the newest `release-index.json`                                                                         | no infrastructure; current                                                                         | GitHub sees the installation's egress address; needs `api.github.com` and GitHub's asset host on the egress path (_assumption_: assets redirect to a separate host) |
| **C. A mirror, opt-in**: a URL inside the company (Forgejo release, Artifactory or Nexus raw repository, an internal web server) serving the same `release-index.json` and its bundle | nothing leaves the company; works for plants that mirror releases anyway; one place to vet updates | someone keeps the mirror current; a stale mirror hides updates                                                                                                      |

_Recommendation:_ **A by default, B and C as opt-in settings** (_Settings → Updates_, administrators, new control point `updates.source`, step-up, audited). Whatever the source, Steward reads **one file format** and **verifies it** before showing anything:

- **`release-index.json`**, a new release asset made by the release workflow (`scripts/release-index.mjs`) from CHANGELOG.md and the build: `schema`, `version`, `date`, `commit`, `prerelease`, `security` (`none`, `fixes`, `critical` – from the _Security_ section of the entry and the advisory), `checkBeforeUpdating` (the texts of the version's _Check before updating_ items), `changelogUrl`, `assets` (name, size, SHA-256), `images` (reference and index digest per variant), and the indexes of earlier versions folded in, so one file tells everything since any older version.
- **Verification** with the `sigstore` npm package against an embedded trusted root (updatable from a file) and a fixed policy: subject digest of the file, issuer `https://token.actions.githubusercontent.com`, certificate identity `https://github.com/vxrz/Steward/.github/workflows/release.yml@refs/tags/v<version of the index>`. A mirror is untrusted transport: the same check applies. An index that does not verify is not shown; the failure is audited (`system.update_check_failed`, reason) and shown on the settings page. _New dependency – to be added after the 14-day cooldown and the install-script review like every other._
- **What the request carries:** a plain `GET` with `User-Agent: Steward` – no version, no installation id, no cookies, no query parameters. It goes through the outbound policy like a monitor HTTP check (address safety; a host that is not a platform needs an allow-list entry) and through `HTTPS_PROXY`. The settings page shows the exact hosts to allow.
- **Air-gapped:** _Settings → Updates → Read release index from a file_ takes `release-index.json` and `provenance.sigstore.json` from the offline bundle (section 7); verification is the same.

### 5. The notice

- **Administrators only** (as the existing update notice; it names versions and upgrade steps). Shown at the top of the web app when a verified index names a newer release than the running one: version and date, _Security release_ when `security` is not `none`, and **all _Check before updating_ items of every version between the running one and the newest**, each with its version, then links to the changelog and the verification commands. Pre-releases only when the installation runs one.
- **It never installs anything.** Dismissed per version and administrator (as `system.update_notice_dismissed` today); a newer release brings it back.
- **Support status** from [RELEASES.md](../RELEASES.md): "0.13 gets security fixes until …", "this version gets no more fixes".
- Optional notification event `system.update_available` to administrators, held by quiet hours and digests ([ADR 0012](0012-quiet-hours-and-digests.md)); off by default.
- `/api/v1` gains `GET /system/updates` (tokens of administrators only): `running`, `latestKnown`, `security`, `checkedAt` – so monitoring can alert on "security release not installed". Additive, as the API's versioning rules require ([API.md](../API.md#versioning-and-deprecation)).

### 6. Desktop app: download and verify in one click

| Option                                                                                                                             | For                                                              | Against                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A. A link to the release page**                                                                                                  | nothing to build                                                 | the person verifies by hand – or not at all                                                                                |
| **B. Download and verify in the app**, unpack **next to** the running executable; the person stops this one and starts the new one | the verification happens every time; the person stays in control | a download path in the server; disk space                                                                                  |
| **C. Replace and restart by itself**                                                                                               | the most convenient                                              | a silent update in all but name; on Windows a running file cannot be replaced; a failing new version leaves no working app |

_Recommendation:_ **B.** _Download and verify_ (desktop installation only, administrator, the source of section 4 or a file chosen by the person): Steward fetches the archive for its own platform, checks its SHA-256 against the verified index **and** its provenance bundle with the same policy, unpacks it into `<data folder>/updates/<version>/` and shows the path, the identity it verified ("built by release.yml for v0.15.0 of vxrz/Steward, commit …") and the steps: preflight (section 8), stop, start the new file. With `--autostart on` it says that the autostart entry must point to the new file. A failed check deletes the download and says why.

### 7. Air-gapped plants: the offline bundle

| Option                                                                                                                                                                                                                                                                                                              | For                                                                | Against                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **A. A script that builds the bundle on a connected machine**: `scripts/offline-bundle.sh <version>` – archives, `SHA256SUMS.txt`, `release-index.json`, the Sigstore bundles, `trusted_root.jsonl`, the images as OCI layouts with their signatures and attestations, and a `VERIFY.txt` with the offline commands | the operator chooses targets and variants; no large release assets | needs `gh`, cosign and skopeo on that machine                                                    |
| **B. A ready-made bundle as release asset**                                                                                                                                                                                                                                                                         | one download                                                       | several hundred MB per release, mostly unused; the image part still needs the registry's tooling |

_Recommendation:_ **A.** The script is itself in the signed source and verifies everything it downloads before it packs it, so the bundle is checked twice: on the connected side and again offline. On the plant side: verify with the offline commands, load the image into the plant's registry (`skopeo copy --all oci:… docker://registry.plant/steward:<version>`) or unpack the archive, and feed `release-index.json` to the notice.

### 8. The notice and the update flow

The notice links to a **preflight** on the same page, computed from what Steward already knows, before anyone stops it:

- **The automatic copy will work:** `SM_UPGRADE_BACKUPS` is not `0`, `SM_UPGRADE_BACKUP_REQUIRED` is not `0`; free space in `SM_UPGRADE_BACKUP_DIR` (or the data folder) is at least the database size; on PostgreSQL, `SM_PG_DUMP` is found and not older than the server (the copy fails otherwise, and the update stops, [INSTALL.md](../INSTALL.md#6-updating)); a large dump needs a Kubernetes `startupProbe` that waits.
- **Your own backup:** the last successful backup ([BACKUPS.md](../BACKUPS.md)) and its age.
- **What a stop interrupts:** runs running now (they become _interrupted_), runs waiting for a decision (they keep waiting), schedules due in the next hour.
- **What to do:** the _Check before updating_ items, each with a checkbox for the administrator's own tracking (not enforced).
- **After the update** the existing notice (`system.upgraded`) also says whether the running build's commit is the one the verified index named for that version ("Build verified against the release index" / "Unknown build").

## Privacy

Default off: no request leaves the installation. With GitHub as the source, GitHub learns that an address checks the releases of `vxrz/Steward` once a day – no version, no identifier. With a mirror, nothing leaves the company. No telemetry of any kind is added. [PRIVACY.md](../PRIVACY.md) and the settings page say this in these words.

## Failure modes

- **Source unreachable or rate-limited** (GitHub's limit for unauthenticated calls, 60 per hour per address – _assumption_ – is far above one a day): the settings page shows _Last check failed at …_; no notice, no retry storm (next try the next day or with _Check now_).
- **Verification fails** (another workflow, another repository, a changed file, an unknown trusted root): nothing is shown for that version; audited with the reason, as possible tampering.
- **Rollback and freeze:** Steward never offers a version older than itself and remembers the highest version verified; a mirror that stops updating shows its index date ("newest release known: 0.15.0, index from …") – a freeze cannot be detected, only made visible (as for libraries).
- **Trusted root rotation:** each release embeds the current trusted root; a newer one can be loaded from a file (`gh attestation trusted-root` output).
- **Wrong clock:** verification uses the transparency log's signed time in the bundle, not the local clock (_assumption, to test_); the index's own `date` is shown as given.

## Migration and rollout

1. **0.14 – pipeline and docs:** `actions/attest` in both workflows, bundles and `release-index.json` as release assets, the verification job, the offline commands and the offline bundle script, SECURITY-HARDENING.md and RELEASES.md.
2. **0.15 – the notice:** settings (off by default), file import, mirror, GitHub; verification with `sigstore`; the notice with _Check before updating_ items and the preflight; `GET /api/v1/system/updates`.
3. **Then – desktop:** download and verify; the "build verified" line after an update.
4. Woodpecker/Forgejo builds: a mirror may serve releases built and signed there; Steward then also accepts a **company key** configured by an administrator (cosign public key, step-up) – only if the owner wants it later (_Decided_, question 6: not for now).

## Test strategy

- **Index:** the generator extracts _Check before updating_ items and security flags from a CHANGELOG fixture with several versions; a round trip through the schema; folding of earlier versions.
- **Verification:** fixture bundles – valid; another workflow (`container.yml`); another repository; another tag than the index version; a changed byte in the file; an unknown trusted root – only the first passes.
- **No call by default:** with the setting off, a test asserts that no outbound request is made and no job is scheduled; with GitHub or a mirror, exactly one request a day, without version or identifier, through the outbound policy.
- **Notice:** administrators only; items of every version in between; dismissal per version; a pre-release only for pre-release installations; never a downgrade.
- **Preflight:** no `pg_dump`, too old a `pg_dump`, too little space, backups off – each shown.
- **Desktop download:** checksum mismatch and bundle mismatch delete the download; success unpacks next to the executable and never replaces it.
- **Workflows:** `actionlint` and `zizmor` as today; the verification job runs the documented commands on every release; the upgrade tests from every minor stay as they are.

## Consequences

- Every release can be verified online and offline with commands the CI proves on each release.
- Administrators learn about updates and what to check before them – only when they turn it on, and only from a source they choose; Steward still never installs anything by itself.
- A new dependency (`sigstore`) and a new release asset format to keep stable (`release-index.json`, versioned by `schema`).
- The changelog's _Check before updating_ items become data that the app shows, so they must be written for administrators – short and actionable.
- Revisit for SLSA Build L3 or OS code signing when users ask, and for a company signing key when releases are rebuilt inside plants.

## Decided (November 2026)

The owner took the recommended answer to every open question ("go with your recommendation if it fits Steward's purpose, architecture, UI/UX and best practices"), decided on 2026-11-10:

1. **Attestation action:** both workflows move to `actions/attest` v4.2.2, and the bundles are published as release assets.
2. **SLSA level:** Build L2; an isolated provenance workflow for L3 is not planned.
3. **Code signing of the executables:** no operating-system code signing; the Sigstore provenance is the proof.
4. **Default source of the update notice:** off; GitHub and a mirror are opt-in.
5. **Desktop update:** download and verify, unpack next to the executable; the person restarts.
6. **Releases rebuilt in the company (Woodpecker/Forgejo):** not accepted by the notice for now – only this repository's releases. A company cosign key stays a later option.
7. **SBOM of the executables:** the npm production dependencies, documented as not listing Node.js itself.
8. **Offline bundle:** a script that builds it on a connected machine; no ready-made bundle as a release asset.
