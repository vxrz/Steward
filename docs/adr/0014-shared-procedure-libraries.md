# 0014. Shared procedure libraries: signed releases through Git

- **Status:** Accepted
- **Date:** 2026-11-07
- **Since:** 0.10.0 (#238)

## Context

Teams want to share tested procedures, monitors, document types and dashboards between installations: inside a company (a central platform team and its sites), and between companies (a vendor's or a community's set of access reviews). They want to install a set after a review, update it on purpose, and see who published what they run.

What Steward has today:

- **Git sync** (`server/src/sync/`, [GIT-SYNC.md](../GIT-SYNC.md)) reads one item per file from a folder of a Git repository: processes, dashboards, monitors and record types (`SYNC_KINDS` in `shared/src/gitsync.ts`). A source follows a branch or a tag (`v{version}` resolves to the running version, `resolveRefName`). Every new or changed file becomes a pending update in `sync_updates`; a reviewer accepts it through the normal services and their own rights (`acceptUpdate` in `sync/updates.ts`); `sync_items` remembers which source an item came from and its hash, so a local edit is a conflict (`conflictOf`: `notFromGit`, `changedLocally`). Files are parsed as data only (`parseData`: YAML core schema, bounded aliases), checked against their Git blob id (`gitBlobSha`), refused when they look like they hold a secret (`findSecret`), and limited by `SYNC_LIMITS`. `# steward-min-version:` keeps a file away from older versions (`minVersionOf`, `newerThan`).
- **Signed commits** in Git sync are verified by the Git host, not by Steward. Steward trusts the host's _Verified_ flag and compares the signer with an optional list. A file upload has no signature at all.
- **Steward's example library** is a disabled Git sync source on every installation (`STEWARD_EXAMPLES_SOURCE` in `sync/service.ts`: GitHub, tag `v{version}`, folder `examples`).
- **Monitors name platforms by name.** When a name does not match exactly one platform, the reviewer picks the platform per reference on accept (#102).
- **Process versions** (`process_versions`) are numbered per installation. A sub-process step names a process id and may pin a version (`SubprocessConfig` in `shared/src/process.ts`; `execSubprocess` in `engine/runner.ts`). A run stores `process_version` and `definition_hash`.
- **Process steps are data, not code.** There is no script step. An http step goes to the platform bound to its slot (`HttpConfig.connection`); every request passes the outbound policy (`platforms/outbound.ts`). Bindings and identities are chosen at run start ([0009](0009-platform-identities.md)).
- **Connector types** (`platforms/connectors.ts`, `platform_types`, format `steward-connector`) carry auth settings, variables, specs and identity templates, never credentials. Only administrators import them.
- **Signed artefacts.** The vault holds an Ed25519 key that signs audit checkpoints ([0003](0003-hmac-chained-audit-log.md)), evidence packs, audit archives and migration packages. Each signs a manifest of SHA-256 sums with a domain prefix (`MANIFEST_SIGNATURE_DOMAIN` in `compliance/evidence-verify.ts`, `ARCHIVE_SIGNATURE_DOMAIN` in `audit-archive-verify.ts`); `verifySignature` and `publicKeyFingerprint` live in `vault.ts`. Settings that must not change behind Steward's back are sealed with the vault's integrity key (`checkMac` in `integrity.ts`). Release archives and the container image are signed keyless with Sigstore in CI ([SECURITY-PIPELINE.md](../ci/SECURITY-PIPELINE.md)); that is for people checking a download, not for Steward checking content at run time.
- **"Bundle" is taken three times.** The export package of processes and dashboards has the format `steward-bundle` (`BUNDLE_FORMATS`, `/api/bundle/…`); template bundles (`examples/bundles/*.yaml`, `onboarding/bundles.ts`) set up processes, a dashboard, schedules and monitors together; and Git sync refuses `steward-bundle` files.
- **ZIP.** `compliance/zip.ts` reads and writes ZIP files with limits (no ZIP64, bounded inflation, `safeEntryName`). There is no tar reader.

What is missing: a unit larger than one file with a version, a signature that Steward checks itself against keys it trusts, an install that shows the whole change at once, a pinned version with a planned update and a rollback, and provenance on the items and in the evidence.

## Decision

### Names

- A **library** is a named, versioned set of Steward items from one **publisher**. One version of it is a **release**.
- We do not call it a bundle. Files are `steward-library.yaml` (written by the publisher), `release.json` (written by the build) and `release.json.sig` (the signature). Template bundles can be items of a library.

### What a library holds

| Kind                        | Format                                           | Installed as                                               |
| --------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Process                     | Process YAML/JSON, as _Export YAML_ writes       | a new process version                                      |
| Dashboard                   | Dashboard YAML                                   | a dashboard                                                |
| Monitor, monitor template   | `kind: monitor` / `kind: monitorTemplate`        | a monitor, **disabled**                                    |
| Record type (document type) | `kind: recordType`                               | a record type                                              |
| Template bundle             | `examples/bundles` format, items of this library | a _Set up together_ entry; nothing is set up               |
| Connector type              | `steward-connector`, no credentials (as today)   | a connector type; platforms made from it earlier unchanged |

- Item files use the formats Git sync and the importers already read, with the same validators (`parseFile` in `sync/items.ts`, `npm run validate`). One item per file.
- **Not in a library:** platforms, identities, credentials, access lists, schedules, webhook triggers, report schedules, datasets (they are data a run publishes), settings. A library never makes anything run by itself.
- The issue's "report templates" and "datasets" are not item kinds in Steward today. A library can carry the process that publishes a dataset and the dashboard that shows it; a template bundle recommends the schedule.

### Manifest

`steward-library.yaml` at the top of the library folder. Its JSON Schema 2020-12 document (`docs/libraries/steward-library-1.schema.json`) is generated from the zod schema, like the plant registry's.

```yaml
format: steward-library
version: 1
library: example-access-reviews # stable id, lower case, unique per publisher
name: Access reviews
publisher: example-ops # the publisher id the signing key belongs to
release: 1.4.0 # SemVer
steward_min_version: 0.10.0
licence: Apache-2.0
description: Quarterly access reviews for the identity providers we use.
items:
  - processes/entra-guest-review.yaml
  - monitors/entra-app-credentials.yaml
  - record-types/access-exception.yaml
references:
  platforms:
    - { ref: idp, kind: entra, description: The Entra ID tenant to review }
  processes:
    - { ref: ticketing, description: Opens a ticket for each removal (a local process) }
changelog:
  - { release: 1.4.0, notes: Guest review also lists disabled guests. }
```

- **References** are what the items need from the installation. A monitor or a template bundle names a platform by `ref`; a sub-process step may name a local process by `ref`. At install the reviewer maps each reference to a local platform or process, as for #102. The mapping is kept per installed library and reused by updates; only new references are asked.
- **Process connection slots stay slots.** They are bound at run start, as today, with the identity rules of [0009](0009-platform-identities.md).
- **Item ids** are the ids the files give (as in Git sync and the example library). An id that exists locally and did not come from this library is a conflict in the review (decided: never overwritten silently).
- **Sub-processes inside a library** name the other item by its id. Version pins in library files are refused: version numbers are local. At install, Steward pins the child to the version this install created, so a release runs as it was tested. A local edit of the child shows a hint on the parent.

### Release and signature

- `steward library build <folder>` (CLI `server/src/cli/library.ts`; `npm run library -- build`) checks every item, refuses secrets with `findSecret`, and writes `release.json`: canonical JSON with `format: steward-library-release`, `library`, `publisher`, `release`, `steward_min_version`, and every file with path, size and SHA-256 (the manifest included).
- **Signing uses OpenSSH:** `ssh-keygen -Y sign -n steward-library -f <key> release.json` writes `release.json.sig` (the SSHSIG format, OpenSSH 8.1 or newer). The namespace `steward-library` separates these signatures from Git commit signatures made with the same key. Keys: `ssh-ed25519` and `sk-ssh-ed25519@openssh.com` (a hardware key; the signature must have the user-presence flag). `steward library sign` only calls `ssh-keygen`; Steward never holds a publisher's private key.
- **Verification** (`server/src/libraries/sshsig.ts`) uses Node's crypto, no new dependency: parse the armoured signature, check magic, version, namespace and hash algorithm (`sha512` or `sha256`), rebuild the signed data, check that the public key in the signature is a **trusted key of the release's publisher**, and verify Ed25519 with `crypto.verify`. Then every file: listed, present, same size and SHA-256. A file in the folder that `release.json` does not list, or a listed file that is missing, refuses the release.
- Keys are shown with the OpenSSH fingerprint (`SHA256:…`, what `ssh-keygen -l` prints), so publishers and administrators compare the same text.
- Limits as in Git sync (`SYNC_LIMITS`: 200 files, 256 KB per file, 4 MB together); `release.json` at most 512 KB.

### Trusted publishers

- _Settings → Libraries → Trusted publishers_: an administrator adds a **publisher** (id, name, contact) with one or more public keys (an `ssh-ed25519 AAAA…` line). Optional: the library ids it may publish (empty: any), and an expiry date per key.
- A key is **active**, **retired** (rotated out: releases already staged or installed stay valid; new releases signed with it are refused) or **revoked** (compromised: also flags what is installed and offers _Hold_). Revoking needs a reason.
- **Rotation:** add the new key, publish with it, retire the old key. A release is never signed by two keys; the publisher's list of keys is the local truth.
- **A library belongs to its publisher.** The first install binds the library id to the publisher. A release of the same library id signed by another publisher's key is refused.
- Trusted keys are sealed with the vault's integrity key (`checkMac('library_key', …)`): a key written into the database directly is not trusted.
- Adding a publisher or key, removing one, and lifting an expiry are step-up actions: new action `changeTrustedPublishers`, control point `library.publishers` (group `processes`, step-up baseline, four-eyes `optional`). Signed-in session only; API tokens cannot change trust.
- **Steward's own publisher** (`steward`) is part of the build (`shared/src/libraries.ts`), shown as _Built in_, and can be removed.

### Distribution

- **Git: a Git sync source in library mode.** `sync_sources.mode` is `items` (today) or `library`. A library source follows tags that look like versions (`v1.4.0`; a pattern, `{version}` allowed). The fetch lists the tags (new `GitApi.tags()` in `sync/providers.ts` for Forgejo/Gitea, GitHub and GitLab), takes the newest release above the installed one, reads the folder at that tag's commit with the existing checks (path confinement, blob ids, size caps), and verifies the release. The tag must match `release.json`'s version. Pre-releases (`-rc.1`) only when the source allows them. _Require signed commits_ stays a second, separate check.
- **File:** upload a `.zip` of the library folder (at most 8 MB), for installations that cannot reach the Git host. It is read with `ZipReader` and `safeEntryName`; ZIP instead of the issue's `.tar.gz` because Steward reads ZIP already and has no tar reader.
- A verified release becomes a **staged release** (`library_releases`). A release that fails verification is not staged; the source shows why (`LIBRARY_SIGNATURE_INVALID`, `LIBRARY_KEY_UNKNOWN`, `LIBRARY_KEY_REVOKED`, `LIBRARY_FILE_MISMATCH`, `LIBRARY_DOWNGRADE`, `LIBRARY_PUBLISHER_CHANGED`) and the audit log has `library.release_refused`.
- A release whose `steward_min_version` is newer than the running version is listed as _Needs Steward x.y.z_, as in Git sync.

### Install, update, rollback

- **Review first.** _Automate → Libraries_ lists installed libraries and staged releases. A release page shows publisher, key fingerprint and its state, release, changelog, licence, source (tag and commit, or the uploaded file and its SHA-256), and per item: _new_, _changed_ (a diff against the installed item), _unchanged_, _no longer in the library_, or a conflict (_changed locally_, _exists but not from this library_).
- **What it can do.** Steward computes, from the items and not from the publisher's words, per process: platform kinds per slot, steps that write (`isMutating`), access changes, browser and AI steps, sub-processes, notifications, datasets it publishes. What is new since the installed release is marked.
- **References** are mapped on the same page. New items can be skipped; a skipped item stays skipped until the next release.
- **Accept installs all of it in one transaction** through the normal services, with the reviewer's rights for each item (as `acceptUpdate`): processes get a new version with the comment `From library <library> <release> (<publisher>, <fingerprint>)`, monitors start disabled, record types and dashboards are created or updated. Connector types need an administrator. A failed item rolls back the whole install.
- **Pinned.** An installed library stays on its release. A newer one is staged and waits. Nothing installs by itself, and Git sync's _Accept new items automatically_ is not offered for library sources.
- **Local edits are allowed.** The item shows _changed locally_; the next update shows a conflict and the reviewer keeps the local version or takes the library's (the other stays in the version history), as in Git sync.
- **Rollback** to the previous installed release uses Steward's stored copy, verified again. It is an install like any other (new process versions; the history keeps everything). A release older than that is a downgrade and refused.
- **Uninstall** detaches the items: they stay as local items with a note _was from <library> <release>_. Archiving or deleting them is a separate action.
- Four-eyes on install, update and rollback is available through the assurance policy: control point `library.install` (four-eyes `optional`, off by default).

### Provenance and evidence

- `sync_items` gains `release_id`: an item comes from exactly one place, a Git sync source or a library release, and the conflict logic is shared. `process_versions` gains `origin` (JSON: library, release, publisher, key fingerprint, release SHA-256; NULL for local versions).
- A badge _From library_ on every installed item links to the release page.
- Run protocols, run reports and evidence packs name the library release of the process version that ran.
- Audit entries carry the release SHA-256 and the key fingerprint: `library.publisher_added|changed|removed`, `library.key_added|retired|revoked`, `library.release_staged|release_refused|installed|updated|rolled_back|uninstalled|skipped_item`.

### Steward's example library

- The examples folder becomes the library `steward-examples` of the publisher `steward`; its release is the Steward version. `release.json` and its signature are committed before the release tag; the release workflow fails when the signature does not verify against the built-in key.
- The built-in source moves to library mode on the first fetch after the upgrade. Items linked to it before keep their link and become items of the installed release when it is accepted.

### Code and data

- New module `server/src/libraries/`: `manifest.ts` (zod schema, JSON Schema export), `sshsig.ts`, `trust.ts`, `releases.ts` (stage, verify, store), `install.ts` (review, apply, rollback), `routes.ts`. CLI `server/src/cli/library.ts` (`build`, `sign`, `verify`).
- Migrations, additive: `libraries-001-publishers-releases` (`library_publishers`, `library_keys`, `library_releases` with the verified files, `library_installs` with the reference mapping and previous release) and `gitsync-004-library-mode` (`sync_sources.mode`, `sync_items.release_id`, `process_versions.origin`).
- Every new route is classified in `route-matrix.test.ts` ([0005](0005-route-access-declared-on-routes.md)); the new tables are classified in `migration/tables.ts` (moved with an instance; keys keep their seals through the import's re-seal step).
- Web: `web/src/pages/Libraries.tsx`, `LibraryRelease.tsx`, the publisher settings page; the badge in the existing item headers.
- Docs: `docs/LIBRARIES.md`.

## Security

- **What a signature proves:** the release's files are the ones a trusted publisher's key signed, for this library id. It does not prove the items are good. The review page and the reviewer's rights are still the gate.
- **No code from a library.** Items are data, parsed with the Git sync parser. Steward has no script step; expressions run in Steward's own evaluator. Nothing runs while fetching, verifying or reviewing.
- **No credentials in a library.** `findSecret` refuses a file that looks like a key, token or password, at build and again at fetch. References name platforms; credentials stay in the vault.
- **Same rules as local procedures.** An installed process is an ordinary process: its access list, the run dialog, identities and their read-only flags and filters ([0009](0009-platform-identities.md)), dry runs, four-eyes steps and the outbound policy apply unchanged. A library cannot bind a platform, schedule a run or turn on a monitor.
- **Replay and downgrade:** the version is inside the signed `release.json` and must match the tag; Steward only stages releases above the installed one; rollback uses Steward's own stored copy.
- **Mix and match:** one signature covers the list of all files and their hashes; an extra or missing file refuses the release.
- **Impersonation:** a library id is bound to its publisher on first install; a publisher may be limited to named library ids; keys are sealed in the database; trust changes need a step-up and are audited.
- **A stolen key** is the main risk. Revocation stops new releases at once and flags what is installed; an administrator can _Hold_ the release. Hardware keys (`sk-ssh-ed25519`) are supported and recommended in the docs.
- **Freeze:** Steward cannot tell that a publisher stopped publishing or that a Git host hides a newer release. The library page shows when the source was last checked and the newest release seen.
- **Transport:** fetches use Git sync's outbound rules (no redirects, address pinning, size caps). The Git host is not trusted for integrity: a host that serves other files fails the signature check.

## Alternatives considered

- **Git signed commits or tags only.** They depend on the Git host's verification and on its user accounts, and an uploaded file has nothing. They stay a second check.
- **Sigstore keyless (cosign, gitsign).** No long-lived key, a transparency log, and the identity is a CI workflow. But Steward would need a Sigstore client and its dependency tree, a trust root that rotates (TUF updates), and the public-good instance for verification or a bundled root. Air-gapped and OT installations would struggle. It fits Steward's own release downloads, where a person verifies. It can come later as a second kind of publisher (issuer and workflow identity instead of a key).
- **minisign or a raw Ed25519 key.** Same cryptography, but another tool. Many publishers already sign Git commits with SSH keys, Git hosts show them, and hardware keys work with OpenSSH.
- **Steward's own key format and signer.** The signer would hold a private key format of ours and its passphrase handling. `ssh-keygen -Y sign` already does this well.
- **One item per file (Git sync as it is).** No version, no unit to review, no publisher. Libraries build on it instead of replacing it.

## Consequences

**Positive**

- Teams share procedures with a version, a publisher and a signature that Steward checks itself, also offline.
- One review shows a whole release, what it can do, and what changed since the installed one.
- Runs and evidence name the release; rollback is one action.
- No new runtime dependency.

**Negative**

- Two ways to bring items from Git: item mode (one file, for an own repository) and library mode (a release, for sharing). The docs explain when to use which.
- Publishers manage keys. A lost key means a new key and a new trust entry on every installation.
- More tables and states (staged, installed, previous, refused).

**Risks**

- A trusted but careless publisher ships a harmful procedure. Mitigation: the computed _What it can do_ summary, dry runs, read-only identities, four-eyes if the policy asks.
- A wrong SSHSIG parser accepts a bad signature. Mitigation: test vectors made with `ssh-keygen` (good, tampered file, wrong namespace, wrong key, revoked key, sk keys with and without user presence, truncated armour), on SQLite and PostgreSQL.

**Revisit** when publishers ask for keyless signing, when a library needs code (it does not today), or when Git sync learns to push (#20).

## Decided after review

1. **Steward's own publisher key: trusted by default, and where does it live?** Decided: built in, on a maintainer's hardware key. The `steward` key is part of the build (a list in `shared/src/libraries.ts`) and shown as _Built in_; the release checklist signs `examples/release.json` with an `sk-ssh-ed25519` key, and CI only verifies.
2. **What happens to installed releases when their key is revoked?** Decided: flag, block updates, let the administrator hold. Releases signed by the key are marked _signed by a revoked key_; updates are refused; one action _Hold_ pauses the schedules, triggers and monitors of the release's items and refuses new runs until a release with a good key replaces it.
3. **May a library carry connector types?** Decided: yes, installed by administrators only. The review shows the base URL, token URL and trusted origins of each type in full; an update never changes platforms made from an existing type.
4. **Item ids from different libraries: keep them or prefix them?** Decided: keep the ids the files give. A clash with an item that did not come from this library is a conflict in the review and is never overwritten silently.

## Changed while building

1. **No built-in key yet.** The mechanism is there (`BUILT_IN_PUBLISHER_KEYS` in `shared/src/libraries.ts`, shown as _Built in_, removable), but the list is empty: the key lives on a maintainer's hardware key and is added by hand ([SECURITY.md](../../SECURITY.md#library-publisher-key)). Until then the examples folder is not the library `steward-examples`: Steward's example source stays in item mode, the release workflow has nothing to verify against, and the example library is a separate folder (`examples/libraries/example-access-reviews`) signed with a test key that is never trusted by default. An item source leaves every folder with a `steward-library.yaml` alone.
2. **Template bundles are not a library item yet.** They name example templates by file and set up schedules; a library item would need bundles stored in the database. A library's description recommends schedules instead.
3. **`library.publishers` is a step-up point without four-eyes** (baseline step-up). A second person for trust changes would need a store of pending changes like the assurance policy's; revoking and retiring stay without step-up so a stolen key can be stopped at once.
4. **`library.install` offers four-eyes _off_ or _required_** (default off): there is no per-item switch that _optional_ would stand for. A required install is a request on the release that a second designer or administrator approves; it runs with the approver's rights.
5. **The library tables are not moved with an instance** (`migration/tables.ts`): trust is pinned per installation and sealed with its vault; releases are staged again on the target. The installed items move as ordinary items, and their process versions keep `origin`.
6. **Additive extras in the migrations:** `sync_sources.allow_prereleases` and `newest_seen` (the freeze hint), `library_releases.install_request` (four-eyes). A library item's `sync_items.source_id` is `lib:<library>`; the Git source of a release is part of the release's source.
7. **Scorecard:** a release signed by a revoked key is flagged on the library, its items, runs and run reports, not yet on the scorecard. A local edit of a library's sub-process shows on the child (_changed locally_), not as a hint on the parent.
8. **The hold is lifted by a person**, also after a release with a good key is installed: the administrator decides when its schedules, triggers and monitors run again.
9. **A rollback** stages the release rolled back from again (unless a newer one waits), so it can be installed once the problem is understood.
10. **After the security review of 0.10.0** (owner decisions): an **expired key** stops installs and updates of every release it signed, staged or not – only a rollback to the release installed before stays possible; a **held** library cannot be uninstalled and what the hold paused cannot be switched on by hand – only lifting the hold ends it; with four-eyes the approver sees the stored decisions and approves exactly those (a hash of the request), with their own rights; _what it can do_ counts writes by HTTP method and shows steps marked `mutating: false` separately (the engine still runs them in dry runs); the review shows connector types' HTTP settings and monitors' outputs in full.
