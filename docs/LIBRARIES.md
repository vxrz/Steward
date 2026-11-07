# Shared procedure libraries

A **library** is a named, versioned set of Steward items from one **publisher**: processes, dashboards, monitors and monitor templates, record types (document types) and connector types. One version of it is a **release**. A release is signed by its publisher; Steward checks the signature itself against the keys an administrator trusts, shows the whole release for review, and installs it in one transaction. Nothing in a library runs by itself.

Decision record: [ADR 0014](adr/0014-shared-procedure-libraries.md). Manifest schema: [libraries/steward-library-1.schema.json](libraries/steward-library-1.schema.json) (JSON Schema 2020-12).

Use a library to share tested procedures between installations – a central platform team and its sites, a vendor's or a community's set of access reviews. For your own repository of single files, [Git sync](GIT-SYNC.md) in item mode stays the simpler choice: every file is reviewed on its own, without a version or a signature.

## Contents

- [What a library holds](#what-a-library-holds)
- [Writing a library](#writing-a-library)
- [Building and signing a release](#building-and-signing-a-release)
- [Trusted publishers](#trusted-publishers)
- [Getting a release into Steward](#getting-a-release-into-steward)
- [Install, update, rollback](#install-update-rollback)
- [Hold: when a key is stolen](#hold-when-a-key-is-stolen)
- [Provenance](#provenance)
- [Steward's own key](#stewards-own-key)
- [The example library](#the-example-library)
- [Limits and error codes](#limits-and-error-codes)

## What a library holds

| Kind                        | Format                                     | Installed as                                                             |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Process                     | Process YAML/JSON, as _Export YAML_ writes | a new process version                                                    |
| Dashboard                   | Dashboard YAML                             | a dashboard                                                              |
| Monitor, monitor template   | `kind: monitor` / `kind: monitorTemplate`  | a monitor, **switched off**                                              |
| Record type (document type) | `kind: recordType`                         | a record type                                                            |
| Connector type              | `steward-connector` (no credentials)       | a connector type (administrators only); platforms made earlier unchanged |

One item per file, in the formats Git sync and the importers already read. **Never in a library:** platforms, identities, credentials, access lists, schedules, webhook triggers, report schedules, datasets or settings. A library cannot bind a platform, schedule a run or turn on a monitor. Template bundles are not a library item yet (see the ADR's _Changed while building_); a library's description recommends schedules instead.

Item ids are the ids the files give (`id:` of a process or dashboard, `key:` of a monitor or record type). An id that exists in Steward and did not come from this library is a **conflict** in the review – never overwritten silently.

## Writing a library

A folder with `steward-library.yaml` and the item files:

```yaml
format: steward-library
version: 1
library: example-access-reviews # stable id, lower case, unique per publisher
name: Access reviews
publisher: example-ops # the publisher id the signing key belongs to
release: 1.4.0 # SemVer 2.0.0
steward_min_version: 0.10.0
licence: Apache-2.0 # SPDX identifier
description: Quarterly access reviews for the identity providers we use.
items:
  - processes/guest-review.yaml
  - monitors/app-credentials.yaml
  - record-types/access-exception.yaml
references:
  platforms:
    - { ref: idp, kind: microsoft-graph, description: The Entra ID tenant to review }
  processes:
    - { ref: ticketing, description: Opens a ticket for each removal (a local process) }
changelog:
  - { release: 1.4.0, notes: Guest review also lists disabled guests. }
```

- **References** are what the items need from the installation. A monitor names its platform by `ref` (`platform: idp`); a sub-process step may name a local process by `ref` (`process: ticketing`). The reviewer maps each reference when installing; the mapping is kept and reused by updates – only new references are asked. A platform reference that only one platform the reviewer may use can stand for is proposed (as for monitors from Git).
- **Process connection slots stay slots.** They are bound when a run starts, with the identity rules of [ADR 0009](adr/0009-platform-identities.md).
- **Sub-processes inside a library** name the other item by its id. Version pins are refused in library files (version numbers are local): at install Steward pins the child to the version this install created, so the release runs as it was tested.
- Hidden files and folders (`.git`, `.DS_Store`) are never part of a release.

## Building and signing a release

```sh
npm run library -- build my-library                  # checks every item, writes my-library/release.json
npm run library -- sign my-library -f ~/.ssh/id_ed25519_sk   # ssh-keygen -Y sign -n steward-library
npm run library -- verify my-library --key publisher.pub     # the same checks an installation makes
npm run library -- pack my-library -o my-library-1.4.0.zip   # for installations without access to the Git host
```

In the desktop app the same commands are `steward library build|sign|verify|pack`.

- `build` refuses a file that looks like it holds a credential (the [secret check](CREDENTIALS.md) of the register) and every item the importers would refuse, then writes **`release.json`**: canonical JSON with `format: steward-library-release`, `library`, `publisher`, `release`, `steward_min_version` and every file of the folder with its path, size and SHA-256 (the manifest included). A new build removes an old `release.json.sig`.
- `sign` only calls OpenSSH (8.1 or newer): `ssh-keygen -Y sign -n steward-library -f <key> release.json` writes **`release.json.sig`** in the [SSHSIG format](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig). The namespace `steward-library` separates these signatures from Git commit signatures made with the same key. Steward never holds a publisher's private key.
- **Keys:** `ssh-ed25519` and `sk-ssh-ed25519@openssh.com` – a FIDO hardware key ([PROTOCOL.u2f](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.u2f)); a hardware key's signature must carry the user-presence flag (the key was touched). **Hardware keys are recommended:** a key that cannot be copied cannot be stolen from a laptop or a CI secret.
- Formatters must not touch a built release: every byte is signed. Format the files first, then build and sign.

Publish the folder in a Git repository and tag the release (`v1.4.0`), or hand out the `.zip`.

## Trusted publishers

_Settings → Integrations → Libraries → Trusted publishers_ (administrators, in a signed-in session; API tokens cannot change trust).

- **Add a publisher** with its id (as in the manifest), a name, a contact and optionally the library ids it may publish (empty: any).
- **Add a key**: the publisher's OpenSSH public key line. Steward shows the fingerprint as `ssh-keygen -l` prints it (`SHA256:…`) – compare it with the publisher on a second channel before you trust it. Optional: a date until which the key is valid. **After that date no release signed with the key is installed or updated any more** – staged or not; only a rollback to the release installed before stays possible.
- **Rotate**: add the new key, let the publisher release with it, then **retire** the old key – releases staged or installed before stay valid, new releases signed with it are refused.
- **Revoke** a stolen or lost key (with a reason): new releases are refused at once and every installed release signed with it is flagged; see [Hold](#hold-when-a-key-is-stolen). A revoked key that signed an installed release cannot be removed (that would drop the flag).
- **A library belongs to its publisher:** the first release staged or installed binds the library id to its publisher; a release of the same id signed by another publisher's key is refused (`LIBRARY_PUBLISHER_CHANGED`).
- Keys and the publisher's library list are **sealed** with the vault's integrity key: a key written into the database directly is not trusted.
- Adding a publisher or a key, removing one, widening the library list and lifting an expiry need a **step-up** (control point `library.publishers`, [ASSURANCE.md](ASSURANCE.md)); retiring and revoking do not – stopping a stolen key must be quick. Everything is audited (`library.publisher_added|changed|removed`, `library.key_added|retired|revoked|changed|removed`).

## Getting a release into Steward

**From Git:** _Settings → Git sync_, a new source with **What the source brings in: Library releases (signed)**. The tag pattern holds `{version}` once – here it stands for the release (`v{version}` follows `v1.4.0`, `v1.5.0` …), not for Steward's version as in item mode. A fetch lists the repository's tags (Forgejo/Gitea, GitHub, GitLab), takes the newest release (pre-releases such as `1.5.0-rc.1` only when the source allows them), reads the folder at that tag's commit with Git sync's checks (path confinement, Git object ids, size caps, no redirects) and verifies the release. The tag must name the version in `release.json`. _Require signed commits_ stays a second, separate check of the tag's commit. _Accept new items automatically_ is not offered for library sources. A source in item mode leaves library folders alone (a folder with a `steward-library.yaml` is never synced file by file).

**As a file:** _Automate → Libraries → Upload release (.zip)_ (designers and administrators), at most 8 MB. A zip of the folder itself (one top folder) works as well.

A release is **verified** before it is staged: `release.json.sig` is an SSHSIG signature in the namespace `steward-library` by a trusted, active key of the release's publisher (not revoked, retired or expired, allowed for this library id); every file of the folder is listed in `release.json` with the same size and SHA-256 and every listed file is there; the manifest agrees with `release.json`; every item parses and holds no secret. A release that fails is not staged; the source or the upload shows why and the audit log has `library.release_refused`. A release whose `steward_min_version` is newer than this installation is listed as _Needs Steward x.y.z_.

Only releases above the installed one are staged (replays and downgrades are refused), and a version is never staged twice with different content. The newest staged release waits; older staged ones are superseded.

## Install, update, rollback

_Automate → Libraries_ lists the installed libraries and the releases waiting for review. A release page shows:

- the publisher, the key fingerprint and its state, the SHA-256 of `release.json`, the source (tag and commit, or the uploaded file), the licence and the changelog;
- every item: _new_, _changed_ (with the diff against the installed item), _unchanged_, _no longer in the library_, or a **conflict** – _changed locally_, _exists but not from this library_, or _from another library or Git source_;
- **what it can do**, computed by Steward from each process's steps – not from the publisher's words: the platform kind per connection slot, steps that write, access changes, browser and AI steps, database queries, sub-processes, checks that notify, tasks for people, datasets it publishes. What is new since the installed release is marked;
  - **writes are counted by the HTTP method**: every method but GET, HEAD and OPTIONS is a possible write, whatever the step's `mutating` flag says (a GET marked `mutating: true` counts too). A write step marked `mutating: false` is shown separately as **marked as not changing anything**: the engine treats such a step as a read, so it **also runs in a dry run** – a dry run is no protection against it;
- every monitor's **outputs** in full – webhooks and Gatus/Zabbix pushes (monitor data leaves Steward), processes it starts (by id, with dry run or real run), notifications – counted under _What happens when its state changes_;
- connector types with their **base URL, token URL and trusted origins in full**, and their **HTTP settings in full** (`config.http`: certificate verification off, an own CA certificate, a proxy, default headers, …) – credentials of platforms made from them go there;
- the **references** to map.

**Install** applies everything in **one transaction** through the normal services, with the reviewer's rights for each item: processes get a new version with the comment `From library <library> <release> (<publisher>, <fingerprint>)`, monitors start switched off, record types and dashboards are created or updated, connector types need an administrator (a newer type never changes platforms made from an older one). A failed item rolls back the whole install. New items can be skipped (until the next release). Every conflict needs a decision: keep the local item or take the library's (the other stays in the version history).

- **Pinned:** an installed library stays on its release. A newer one is staged and waits; nothing installs by itself.
- **Local edits** are allowed: the item shows _changed locally_, and the next update shows a conflict.
- **Rollback** to the release installed before uses Steward's stored copy of it, verified again (a revoked key stops it). It is an install like any other; the release rolled back from waits again. Anything older is a downgrade and refused.
- **Uninstall** detaches the items: they stay as local items, their versions keep the library origin. Archiving them is a separate action.
- **Four-eyes** on install, update and rollback: control point `library.install` (off by default). When the assurance policy requires it, _Install_ records a request with all its decisions (reference mapping, skipped items, keep or take for each conflict, comment). The second designer or administrator – never the requester – sees exactly these decisions and the review computed for them (what happens to each item), and approves exactly these: the approval names a hash of the request it was shown, so a request changed in between is refused (`LIBRARY_REQUEST_CHANGED`). The install runs with the approver's own rights – every item, platform and process is checked for the approver as for an install of their own. The requester or an administrator can withdraw the request.

Audit entries carry the release SHA-256 and the key fingerprint: `library.release_staged|release_refused|release_discarded|install_requested|install_withdrawn|installed|updated|rolled_back|uninstalled|skipped_item|held|hold_lifted`.

## Hold: when a key is stolen

Steward cannot know when a key was stolen, so a person decides. After a key is revoked, every installed release it signed is marked **signed by a revoked key** – on the library, its items (_From library_ badge), its runs and run reports – and its updates are refused. An administrator can put the library **on hold** with one action: the schedules, webhook triggers and monitors of its items are paused, and new runs of its processes are refused (`LIBRARY_HELD`). **Lift hold** turns on again exactly what the hold paused. Install a release signed with a good key first, then lift the hold.

While the hold lasts, only lifting it ends it: a held library cannot be uninstalled (not even by an administrator – lift the hold first, which is audited), and its schedules, webhook triggers and monitors cannot be switched on again by hand (`LIBRARY_HELD`).

## Provenance

- `sync_items.release_id`: an item comes from exactly one place – a Git sync source or a library release – and the conflict logic is shared.
- `process_versions.origin`: library, release, publisher, key fingerprint and release SHA-256 (empty for local versions). The version history shows it.
- **Runs** (`libraryOrigin` in the run details), the **run protocol (PDF/A)** and therefore **evidence packs** name the library release of the process version that ran, with the signing key and whether it was revoked since.
- The **From library** badge on processes, monitors, dashboards and record types links to the library.

## Steward's own key

Steward's own publisher (`steward`) is meant to be part of the build: its key lives on a maintainer's hardware key (`sk-ssh-ed25519`), the release checklist signs the example library with it, and CI only verifies. **This version ships no built-in key** (`BUILT_IN_PUBLISHER_KEYS` in `shared/src/libraries.ts` is empty), so no installation trusts any publisher it was not told to trust. The maintainer steps are listed in [SECURITY.md](../SECURITY.md#library-publisher-key). Built-in keys are shown as _Built in_ and an administrator can remove them.

## The example library

`examples/libraries/example-access-reviews/` is a small library (two processes – the second a sub-process of the first –, a monitor and a record type). It is signed with a **test key**, `examples/libraries/TEST-PUBLISHER-KEY.pub`, whose private key was thrown away; **no installation trusts it by default**. `npm run validate` checks the items, that `release.json` is up to date and that the signature verifies with the test key (reported as a warning).

To try it on a test installation, trust the publisher `example-publisher` with the test key, then upload `npm run library -- pack examples/libraries/example-access-reviews -o example.zip`. After changing the example, build it again and sign it with a new throwaway key:

```sh
ssh-keygen -t ed25519 -N '' -C 'example-publisher TEST KEY' -f /tmp/test-key
npm run library -- build examples/libraries/example-access-reviews
npm run library -- sign examples/libraries/example-access-reviews -f /tmp/test-key
# replace the key line in examples/libraries/TEST-PUBLISHER-KEY.pub with /tmp/test-key.pub, then delete /tmp/test-key*
```

## Limits and error codes

200 files, 256 KB per file, 4 MB together (as Git sync), `release.json` at most 512 KB, an uploaded `.zip` at most 8 MB, 20 keys per publisher, 1,000 tags per fetch.

| Code                        | Meaning                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `LIBRARY_SIGNATURE_INVALID` | No signature, another namespace, or the signature does not match `release.json`                         |
| `LIBRARY_KEY_UNKNOWN`       | The signing key is not trusted here, or belongs to another publisher                                    |
| `LIBRARY_KEY_REVOKED`       | The signing key was revoked                                                                             |
| `LIBRARY_KEY_RETIRED`       | A new release signed with a retired key                                                                 |
| `LIBRARY_KEY_EXPIRED`       | The signing key's validity ended                                                                        |
| `LIBRARY_NOT_ALLOWED`       | The publisher is trusted for other library ids only                                                     |
| `LIBRARY_FILE_MISMATCH`     | A file differs from `release.json`, is not listed, or is missing; or a known version with other content |
| `LIBRARY_DOWNGRADE`         | Not newer than the installed release                                                                    |
| `LIBRARY_PUBLISHER_CHANGED` | The library id belongs to another publisher                                                             |
| `LIBRARY_TAG_MISMATCH`      | The Git tag names another version than `release.json`                                                   |
| `LIBRARY_INVALID`           | The manifest, `release.json` or an item is not valid, or an item holds a secret                         |
| `LIBRARY_HELD`              | A run of a process whose library is on hold                                                             |
