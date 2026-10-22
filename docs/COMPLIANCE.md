# Compliance: access governance evidence

Steward helps a service team keep evidence of how access to its platforms is managed: who got which rights, why, who approved it, and whether what is documented matches what is really configured. The evidence supports audits against ISO/IEC 27001, IEC 62443-2-1 and similar frameworks.

> **Steward provides evidence. It does not make you compliant.** Whether your controls are effective is for your organisation and its auditors to decide. The built-in catalogues contain control identifiers and short topic names written for Steward – not the text of the standards, which is copyrighted.

The _Compliance_ section of the sidebar has four pages:

| Page                      | What it does                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Controls**              | Control catalogues, the Steward items mapped to each control, and the evidence in a period. Gaps are highlighted.  |
| **Access changes**        | Every documented grant, revocation and change of access rights – by hand, from runs, or documented after the fact. |
| **Access reconciliation** | Snapshots of who has which access, compared with the documented access changes. Undocumented changes show up here. |
| **Evidence packs**        | Signed ZIP exports for auditors: the evidence of some controls (or a platform or service) in a period.             |

- [How it maps to the standards](#how-it-maps-to-the-standards)
- [Access change entries](#access-change-entries)
- [Automatic entries from runs](#automatic-entries-from-runs)
- [Access reconciliation](#access-reconciliation)
- [Controls and coverage](#controls-and-coverage)
- [Evidence packs](#evidence-packs)
- [Who may do what](#who-may-do-what)
- [API](#api)
- [Try it in the demo](#try-it-in-the-demo)

## How it maps to the standards

The table shows which Steward evidence is typically relevant to which requirement. Map your own processes, record types, monitors, report schedules and checks under _Controls_.

| Requirement                                                             | Steward evidence                                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ISO/IEC 27001 A.5.15 (access control), A.5.18 (access rights)           | Access change entries with reason, request, approval and performer; access reviews (example processes 10–12) with their sealed PDF protocols     |
| ISO/IEC 27001 A.5.16 (identity management)                              | Onboarding and offboarding runs (examples 13, 20) and their automatic access change entries; the reconciliation reports new and removed accounts |
| ISO/IEC 27001 A.8.2 (privileged access rights)                          | Privileged access review (example 12, four-eyes removal); the reconciliation reports an administrator role granted outside Steward               |
| ISO/IEC 27001 A.8.15 (logging)                                          | The HMAC-chained audit log with signed checkpoints; the audit log excerpt in every evidence pack                                                 |
| IEC 62443-2-1 4.3.3.5 (account administration), 4.3.3.7 (authorization) | As for A.5.16 and A.5.18; snapshots prove who had access when                                                                                    |
| NIS2 Art. 21(2)(i) (access control policies, asset management)          | As above                                                                                                                                         |

By default, the access change record type and the demo reconciliation check are mapped to ISO/IEC 27001 5.15, 5.16, 5.18 and 8.2, IEC 62443-2-1 4.3.3.5 and 4.3.3.7 and NIS2 21(2)(i).

## Access change entries

An access change entry is a record of the built-in type **Access change** (key `AC`, numbers like `AC-2026-0001`). Like all records it has versions, a content hash when it is frozen, a PDF, links and attachments (see [RECORDS.md](RECORDS.md)).

Fields: platform, subject (user name, user id or technical user id, and a display name), change (grant, revoke, change, onboarding, offboarding), rights before and after (one role, group or scope per line), reason, requested by, request reference (e.g. a ServiceNow ticket), approved by, performed by, performed at, origin (manual, run, after the fact). Steward computes the granted and removed rights from _before_ and _after_.

Workflow:

```
Draft ──document──▶ Documented ──verify──▶ Verified
  └──cancel──▶ Cancelled
```

- **Document** freezes the entry and records its content hash in the audit log.
- **Verify** is optional: a second person (approver or administrator) confirms the entry. Four-eyes: the author, the owner and the person who performed the change cannot verify it.
- A documented entry can go back to draft as a new revision (with a reason) – for example to attach an e-mail. Until it is documented again it does not count for the reconciliation.

To document a change: _Compliance → Access changes → Document access change_. Fill in the fields; add the request link if you have one. Leave _Document now_ off if you want to attach files (screenshots, e-mails) first, then document the entry on its record page.

## Automatic entries from runs

A process documents the access changes it makes with the step **Document access change** (`type: accessChange`, category _Evidence_). Put it after the steps that change access:

```yaml
- id: documentRemoval
  type: accessChange
  when: 'vars.removal.approved = true'
  connection: hub # the platform whose access changed
  kind: revoke # grant | revoke | modify | onboarding | offboarding
  items: vars.attestation.unselected # optional: one entry per item
  subjectId: id # expression (per item)
  subjectName: userName
  rights: '[role]' # the changed rights
  reason: 'Privileged access review: assignment not attested'
  approvedBy: '{{ vars.removal.decidedBy }}'
```

Optional: `rightsBefore` and `rightsAfter` (all rights of the subject) and `requestRef`. Without `items`, the expressions are evaluated once in the run scope (for example inside a loop).

When the run has ended, Steward creates **one documented entry per platform and subject** (changes of the same subject within one run are merged), links it to the run and the platform, and attaches the run's PDF protocol (the automatic report, or one generated for the purpose). The entry is created by `system` on behalf of the person who started the run; _approved by_ defaults to whoever approved the run's approval tasks. Dry runs document nothing.

The example processes use the step: privileged access review (12), access review 2 (11, revoked users), offboarding (13) and onboarding (20).

## Access reconciliation

A **check** takes a snapshot of who has which access on a platform, on a schedule (at most every 15 minutes; daily is typical) or with _Take snapshot now_:

- **Insights Hub** (source _Insights Hub identity management_): Steward reads every user with its groups and roles from the identity management API (`{idmPath}/Users`, SCIM), with the rights of the check's owner. Credentials go only to the platform's own origins; the outbound policy applies.
- **Any platform** (source _Dataset_): a process publishes a dataset in the access snapshot shape. Recommended: one row per assignment with the columns `subjectId`, `subjectName`, `subjectType` and `right` (a row without `right` is a subject without rights). One row per subject with `rights` (a list or comma-separated text) works too. Example 16 publishes `ih.access-snapshot` this way. Data from dry runs is not used.

Each snapshot is compared with the previous one. Every granted or removed right needs a documented (or verified) access change entry for the same platform and subject (matched by subject id or name, case-insensitive) with a _performed at_ time between the two snapshots (with one hour of tolerance on each side):

- a granted right is explained by an entry that grants it (it is in _rights after_ but not in _rights before_),
- a removed right by an entry that removes it, or by an offboarding entry for a subject that is gone,
- a new subject needs an onboarding entry or one that grants its rights.

What is left becomes a **finding**: _grant_, _revoke_, _change_ (both), _onboarding_ (new subject) or _offboarding_ (subject gone). The owner of the check, the users and teams to notify, and the administrators are notified (_Undocumented access_ notification, in the app and by e-mail by default).

On a finding:

- **Document this change** creates a pre-filled access change entry marked _documented after the fact_ (origin _reconciliation_), documents it and closes the finding. Give the reason and, if you know them, the request, the approver and who made the change.
- An entry documented later that covers the finding closes it as well.
- **Dismiss** (owner of the check or administrator) closes a finding that needs no entry, with a reason in the audit log – for example a test account.

_Ignored rights_ leaves rights out of the snapshots, for example the marker group the access reviews use (`mdsp_usergroup:AccessReview` in the demo).

**Proof of history.** Snapshots are never changed (a database trigger refuses updates). Each has the SHA-256 of its data and a chain hash over the previous snapshot of the check (`sha256(prevChainHash | check | seq | takenAt | hash)`), and is recorded with both hashes in the HMAC-chained audit log. Unchanged snapshots store no second copy of the data. _Verify history_ (tab _Snapshots_) recomputes all hashes and compares them with the authentic audit entries. A check that has snapshots cannot be deleted – disable it instead.

## Controls and coverage

_Compliance → Controls_ shows a catalogue with the coverage of each control in a period:

- **Covered** – mapped items produced evidence in the period,
- **Gap** – items are mapped, but there is no evidence in the period,
- **Not mapped** – no Steward item is mapped to the control.

Evidence per kind of mapped item:

| Mapped item           | Evidence in the period                                          |
| --------------------- | --------------------------------------------------------------- |
| Process               | Runs (not dry runs) and whether they have a PDF protocol        |
| Record type           | Records with activity (created, changed, transitions, comments) |
| Record                | The record, when it had activity                                |
| Monitor               | Results and status changes (with the availability)              |
| Report schedule       | Scheduled reports generated                                     |
| Access reconciliation | Snapshots and findings                                          |

Designers and administrators map items to controls in the control's panel. Administrators edit control texts and import catalogues.

**Built-in catalogues** (identifiers and Steward's own short topic names only): ISO/IEC 27001:2022 Annex A (93 controls), IEC 62443-2-1:2010 (CSMS elements; edition 2 of 2024 reorganised the requirements into security program elements – import your own catalogue if you work with it) and NIS2 Art. 21(2) (a)–(j).

**Import** (_Import catalogue_, administrators): JSON or YAML

```yaml
key: ISMS
name: Our ISMS controls
version: '2026'
controls:
  - ref: A.1
    title: Quarterly access reviews
    description: Owners confirm every user's access once a quarter.
```

or CSV with the columns `ref`, `title` and optionally `description` (header row required; comma or semicolon). Importing into an existing catalogue replaces the texts of existing controls and adds new ones; nothing is removed. Up to 1 MB and 2000 controls. Use it to add the wording your organisation licensed to the built-in controls.

## Evidence packs

_Compliance → Evidence packs → New evidence pack_: choose controls, a platform or a service, a period (at most three years) and the language of the PDFs. From the _Controls_ page, select controls and click _Evidence pack for … controls_.

The pack is built in the background and kept for download for 7 days (`SM_EVIDENCE_RETENTION_DAYS`). It holds:

| Path                                              | Content                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.pdf`, `index.json`                         | Summary (PDF/A): scope, controls with coverage, contents; the machine-readable index                                                                                                           |
| `runs/<run>/…pdf`                                 | The run protocols (an archived report, or a new one; up to 100 are generated per pack)                                                                                                         |
| `records/<number>/`                               | Record PDF, `record.json` (content, hashes, history) and the attached files                                                                                                                    |
| `access-changes/`                                 | All access change entries of the pack as JSON and CSV                                                                                                                                          |
| `reconciliation/<check>/`                         | Check, snapshots (list and data), findings and the verification of the snapshot chain                                                                                                          |
| `reports/`                                        | Scheduled report PDFs of mapped report schedules                                                                                                                                               |
| `monitors/monitors.json`                          | Monitor evidence                                                                                                                                                                               |
| `audit/`                                          | Audit log excerpt from the start of the period up to a signed checkpoint created for the pack, the checkpoint and the result of the full chain verification (auditors and administrators only) |
| `manifest.json`, `manifest.sig`, `public-key.pem` | SHA-256 and size of every file, signed with the installation's Ed25519 key (the key of the audit checkpoints)                                                                                  |

The pack contains only what the requester may see: auditors and administrators get everything, others only items they may read (and no audit log). Requesting, building and downloading a pack are audited. Limits: 512 MB per pack (`SM_EVIDENCE_MAX_MB`), 5000 files, 1000 records, one pack in progress per user, 20 stored packs per user. Files are written to `data/evidence-packs/` as they are added, never held in memory as a whole.

**Verify a pack offline** (no server, vault or database needed):

```bash
npm run evidence:verify -- steward-evidence-2026-10-22-abc123.zip
steward evidence verify steward-evidence-2026-10-22-abc123.zip      # desktop app
npm run evidence:verify -- pack.zip --public-key steward-audit-public-key.pem --json
```

The check fails when the manifest signature is wrong, a file was changed, added or removed, or the audit log excerpt does not reach its signed checkpoint. Without `--public-key` the key in the pack is used: compare its fingerprint with the one under _Audit log → Anchoring outside the database_ of your installation. Exit status: 0 intact, 1 a check failed, 2 usage error.

## Who may do what

| Action                                            | Who                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| Read access change entries, controls and coverage | everyone who can sign in (items they may not see are left out)        |
| Document access changes, document findings        | operator, designer, admin (findings: who may read the check)          |
| Verify an access change entry                     | approver, admin – four-eyes                                           |
| Read checks, snapshots and findings               | admin, auditor, the owner of the check, and who may use the platform  |
| Set up checks                                     | designer, admin (with the right to use the platform)                  |
| Change, run, disable a check; dismiss findings    | the owner of the check, admin                                         |
| Map items to controls                             | designer, admin                                                       |
| Edit and import catalogues                        | admin                                                                 |
| Create evidence packs                             | everyone but viewers; download: the creator, auditors, administrators |

## API

Web UI API under `/api/compliance/…`. Public, read-only API (API tokens):

- `GET /api/v1/access-changes` – access change entries (filters: platform, subject, status, kind, period),
- `GET /api/v1/access-findings` – reconciliation findings (filters: check, platform, status, period),
- `GET /api/v1/control-catalogues`, `GET /api/v1/controls` – catalogues and controls with their mapped items,
- `GET /api/v1/control-coverage?from=…&to=…` – coverage per control.

See the OpenAPI document (`/api/v1/openapi.json`).

## Try it in the demo

`npm run demo`, load the demo data, then open _Compliance → Access reconciliation_. The check _Insights Hub (demo) – user access_ has a baseline snapshot. Click **Simulate a change outside Steward**: the simulated tenant grants the tenant administrator role to a user, as if someone did it in the Insights Hub UI, and the check reports it as an undocumented grant. Click **Document this change**, give a reason – the finding is closed and the entry appears under _Access changes_ as _documented after the fact_. Then export an evidence pack for ISO/IEC 27001 5.18 from _Controls_ and check it with `npm run evidence:verify`.
