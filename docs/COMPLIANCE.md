# Compliance: access governance evidence

Steward helps a service team keep evidence of how access to its platforms is managed: who got which rights, why, who approved it, and whether what is documented matches what is really configured. The evidence supports audits against ISO/IEC 27001, IEC 62443-2-1 and similar frameworks.

> **Steward provides evidence. It does not make you compliant.** Whether your controls are effective is for your organisation and its auditors to decide. The built-in catalogues contain control identifiers and short topic names written for Steward – not the text of the standards, which is copyrighted.

Recurring tasks such as the quarterly access review are tracked as **service duties**: each period is done, late, failed, missed or skipped with a four-eyes exception, and the result is stored for good – see [DUTIES.md](DUTIES.md). The **service scorecard** shows per service whether duties are met, availability objectives are on target, documentation is current (including documents expected by rules on the CIA rating, such as an authorization concept for confidentiality _high_) and the protection need is rated, with a daily snapshot for the trend – see [SCORECARD.md](SCORECARD.md).

The _Compliance_ section of the sidebar has five pages:

| Page                      | What it does                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Controls**              | Control catalogues, the Steward items mapped to each control, and the evidence in a period. Gaps are highlighted.  |
| **Access changes**        | Every documented grant, revocation and change of access rights – by hand, from runs, or documented after the fact. |
| **Access reconciliation** | Snapshots of who has which access, compared with the documented access changes. Undocumented changes show up here. |
| **Person reviews**        | Everything one person may do on several platforms, decided right by right, approved by a second person and sealed. |
| **Evidence packs**        | Signed ZIP exports for auditors: the evidence of some controls (or a platform or service) in a period.             |

- [How it maps to the standards](#how-it-maps-to-the-standards)
- [Access change entries](#access-change-entries)
- [Automatic entries from runs](#automatic-entries-from-runs)
- [Access reconciliation](#access-reconciliation)
- [Person access reviews](#person-access-reviews)
- [Controls and coverage](#controls-and-coverage)
- [Evidence packs](#evidence-packs)
- [Protection needs (CIA)](#protection-needs-cia)
- [Who may do what](#who-may-do-what)
- [API](#api)
- [Try it in the demo](#try-it-in-the-demo)

## How it maps to the standards

The table shows which Steward evidence is typically relevant to which requirement. Map your own processes, record types, monitors, report schedules and checks under _Controls_.

| Requirement                                                                        | Steward evidence                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ISO/IEC 27001 A.5.15 (access control), A.5.18 (access rights)                      | Access change entries with reason, request, approval and performer; access reviews (example processes 10–12) with their sealed PDF protocols                            |
| ISO/IEC 27001 A.5.16 (identity management)                                         | Onboarding and offboarding runs (examples 13, 20) and their automatic access change entries; the reconciliation reports new and removed accounts                        |
| ISO/IEC 27001 A.8.2 (privileged access rights)                                     | Privileged access review (example 12, four-eyes removal); the reconciliation reports an administrator role granted outside Steward                                      |
| ISO/IEC 27001 A.8.15 (logging)                                                     | The HMAC-chained audit log with signed checkpoints; the audit log excerpt in every evidence pack                                                                        |
| IEC 62443-2-1 4.3.3.5 (account administration), 4.3.3.7 (authorization)            | As for A.5.16 and A.5.18; snapshots prove who had access when                                                                                                           |
| NIS2 Art. 21(2)(i) (access control policies, asset management)                     | As above                                                                                                                                                                |
| ISO/IEC 27001 A.5.37 (documented operating procedures), A.8.32 (change management) | Manual procedures: checklists, fields and evidence files per step, second-person verification (maker–checker), sealed PDF protocol ([MANUAL-STEPS.md](MANUAL-STEPS.md)) |

By default, the access change record type and the demo reconciliation check are mapped to ISO/IEC 27001 5.15, 5.16, 5.18 and 8.2, IEC 62443-2-1 4.3.3.5 and 4.3.3.7 and NIS2 21(2)(i).

## Access change entries

An access change entry is a record of the built-in type **Access change** (key `AC`, numbers like `AC-2026-0001`). Like all records it has versions, a content hash when it is frozen, a PDF, links and attachments (see [RECORDS.md](RECORDS.md)).

Fields: platform, subject (user name, user id or technical user id, and a display name), change (grant, revoke, change, onboarding, offboarding), rights before and after (one role, group or scope per line), reason, requested by, request reference (e.g. a ServiceNow ticket), approved by, performed by, performed at, origin (manual, run, after the fact). Steward computes the granted and removed rights from _before_ and _after_.

Only Steward sets the origin (other than _manual_), the run and the finding of an entry: entries a person writes – on the _Access changes_ page or through the records API – are manual entries, and these fields never change afterwards. Every entry also shows who documented it (_documented by_, `system` for automatic entries) and who wrote its newest version (_last edited by_).

**Who may write and read entries.** Entries name people and their rights, so they are not open to everyone like other records:

- Write, change and document an entry: operators, designers and administrators who may **use the platform** of the entry.
- Read an entry (lists, record page, search, links, backlinks, coverage, packs, public API): administrators, auditors, approvers (they verify entries), the owner of the entry and everyone with a right on its platform. Others do not see that the entry exists.

Workflow:

```
Draft ──document──▶ Documented ──verify──▶ Verified
  └──cancel──▶ Cancelled
```

- **Document** freezes the entry and records its content hash in the audit log.
- **Verify** is optional: a second person (approver or administrator) confirms the entry. Four-eyes: the author, the owner, everyone who wrote content of the entry, the person who performed the change and the **subject** of the change (matched by user name or e-mail address) cannot verify it. For an entry of a run, neither can the person who started the run or approved it.
- A documented entry can go back to draft as a new revision (with a reason) – for example to attach an e-mail. Until it is documented again it does not count for the reconciliation. Entries created by runs cannot be revised: document a correction as a new entry.
- An entry whose documented content was changed outside Steward (it no longer matches the hash in the authentic audit entry that froze it) is marked _Changed outside Steward_ and does not count as documentation.

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

When the run has ended, Steward creates **one documented entry per platform and subject** (changes of the same subject within one run are merged), links it to the run and the platform, and attaches the run's PDF protocol (the automatic report, or one generated for the purpose). The entry is created by `system` on behalf of the person who started the run: _performed by_ is that person's user name, the run is in the field _Run_. _Approved by_ defaults to whoever approved the run's approval tasks. Dry runs document nothing. Nobody can change or revise these entries.

The example processes use the step: privileged access review (12), access review 2 (11, revoked users), offboarding (13) and onboarding (20).

## Access reconciliation

A **check** takes a snapshot of who has which access on a platform, on a schedule (at most every 15 minutes; daily is typical) or with _Take snapshot now_:

- **Insights Hub** (source _Insights Hub identity management_): Steward reads every user with its groups and roles from the identity management API (`{idmPath}/Users`, SCIM), with the rights of the check's owner. Credentials go only to the platform's own origins; the outbound policy applies.
- **Any platform** (source _Dataset_): a process publishes a dataset in the access snapshot shape. The owner of the check must be allowed to view that process – checked when the check is set up and on every run (the check runs as its owner). Once a check has snapshots, its platform, source and dataset key cannot change. Recommended: one row per assignment with the columns `subjectId`, `subjectName`, `subjectType` and `right` (a row without `right` is a subject without rights). One row per subject with `rights` (a list or comma-separated text) works too. Example 16 publishes `ih.access-snapshot` this way. Data from dry runs is not used.
- **GitHub, GitLab, Forgejo/Gitea** (source _Git_, #107): the members of an organisation or group with their role, or the collaborators of a repository (outside collaborators marked), read with the platform's token as the check's owner. The **scope** – `acme` or `acme/shop-web` (GitLab `group/project`) – cannot change once the check has snapshots ([GIT-PLATFORMS.md](GIT-PLATFORMS.md#access-reviews)).
- **AWS IAM** (source _AWS IAM_, #118): every IAM user of the account with `group:NAME`, `policy:NAME` (attached managed policies) and `inline:NAME`; a user who never signed in to the console but has access keys is marked technical. Needs `iam:ListUsers`, `iam:ListGroupsForUser`, `iam:ListAttachedUserPolicies`, `iam:ListUserPolicies` and `iam:ListAccessKeys` ([AWS.md](AWS.md)).
- **Snowflake** (source _Snowflake_, #115): with an empty scope every user with their roles; with `SHOP`, `SHOP.SALES` or `SHOP.SALES.ORDERS` every user who reaches objects there through their roles and the roles granted to those, with the privilege; technical users (`TYPE = SERVICE`) marked ([SNOWFLAKE.md](SNOWFLAKE.md#access-reviews)).

Each snapshot is compared with the previous one. Every granted or removed right needs a documented (or verified) access change entry that counts – intact, and not documented by the subject of the change themselves (for an entry of a run: not started by the subject) – for the same platform and subject (matched by subject id or name, case-insensitive) with a _performed at_ time between the two snapshots (with one hour of tolerance on each side):

- a granted right is explained by an entry that grants it (it is in _rights after_ but not in _rights before_),
- a removed right by an entry that removes it, or by an offboarding entry for a subject that is gone,
- a new subject needs an onboarding entry or one that grants its rights.

What is left becomes a **finding**: _grant_, _revoke_, _change_ (both), _onboarding_ (new subject) or _offboarding_ (subject gone). The owner of the check, the users and teams to notify, and the administrators are notified (_Undocumented access_ notification, in the app and by e-mail by default).

On a finding:

- **Document this change** creates a pre-filled access change entry marked _documented after the fact_ (origin _reconciliation_), documents it and closes the finding. Give the reason and, if you know them, the request, the approver and who made the change. Who may do it: operators, designers and administrators who may read the check and use its platform.
- An entry documented later that covers the finding closes it as well – when the person who documents it may document the findings of the check.
- **Dismiss** (owner of the check or administrator) closes a finding that needs no entry, with a reason in the audit log – for example a test account.
- Nobody documents or dismisses a change of their **own** access: the subject of a finding (matched by user name or e-mail address) cannot do either, and an entry they document does not close it.
- **Four-eyes dismissals** (_Settings → Access reconciliation_, administrators): a dismissal then needs two people. The first one gives the reason (the finding stays open, marked _asked to dismiss_), a second person who may dismiss confirms it. Both steps are in the audit log.

_Ignored rights_ leaves rights out of the snapshots, for example the marker group the access reviews use (`mdsp_usergroup:AccessReview` in the demo). A grant of an ignored right is never reported, so only administrators set or change them; the audit log records the old and new list (as it does for the users and teams to notify).

**Proof of history.** Snapshots are never changed (a database trigger refuses updates), and snapshots and findings are never deleted (another trigger). Each snapshot has the SHA-256 of its data and a chain hash over the previous snapshot of the check (`sha256(prevChainHash | check | seq | takenAt | hash)`), and is recorded with both hashes in the HMAC-chained audit log; so is every finding and every change of its status. Unchanged snapshots store no second copy of the data. _Verify history_ (tab _Snapshots_) recomputes all hashes and compares the snapshots and findings with the authentic audit entries: a snapshot or finding that was deleted in the database (also the newest one), or a finding whose status was changed there, shows up as a problem. Evidence packs contain the result. A check that has snapshots cannot be deleted – disable it instead.

## Person access reviews

A **person review** (#118) answers "what may this one person do, and should they?" across platforms – for a leaver, a mover, or a periodic review of a privileged person. _Compliance → Person reviews → New person review_ (designers, administrators):

- **Person**: a name, and the names the person goes by on the platforms – user names and e-mail addresses, compared without regard to case. _Fill in_ takes the user name and e-mail address of a Steward user; naming the Steward user also keeps them from reviewing themselves.
- **Access checks**: the [reconciliation checks](#access-reconciliation) to read – any source: Insights Hub, datasets, Git platforms, Snowflake, AWS IAM. Each is read **live** when the review starts, with the rights of the person starting it; if that fails, the check's latest snapshot is used and the review says so per source.
- **Four-eyes approval** (on by default).

What was found is **frozen**: one line per account and right, and a subject without rights as _(no rights)_. Later changes on the platforms do not change the review.

1. The reviewer decides each right: **keep** or **remove**. A removal needs a reason. Nobody decides about their own access (matched by the Steward user and by their user name and e-mail address).
2. **Submit**: with every right decided. Without four-eyes the review is sealed at once.
3. With four-eyes, an **approver or administrator** who is not the reviewer and not the person reviewed **approves** (sealed) or **sends it back** with a comment (it is open again).
4. Sealed: the SHA-256 over the review and all decisions (`sealHash`, canonical JSON) is stored and recorded in the audit log. _Verify_ recomputes it – a change in the database shows up.
5. **Check removals** (reviewer, approver, administrator): Steward reads the platforms again, marks each right to remove as _removed_ or _still there_, and closes the review when every one of them is gone. Kept rights are not checked again. Each check is in the audit log.

Approved and closed reviews are **evidence** of the access checks they read: mapped to a control through the check, they count in _Controls_ and land in evidence packs as `person-reviews/<id>.json` (with the seal verification at the time of the export).

Who reads a review: administrators, auditors, approvers and the person who started it. Limits: 20 names, 30 checks and 2000 rights per review.

## Controls and coverage

_Compliance → Controls_ shows a catalogue with the coverage of each control in a period:

- **Covered** – mapped items produced evidence in the period,
- **Gap** – items are mapped, but there is no evidence in the period,
- **Not visible** – there is evidence in the period, but none you may see; the badge says how many items are hidden. Auditors and administrators see all evidence. A covered control also says how many more items you may not see.
- **Not mapped** – no Steward item is mapped to the control.

The Controls page, the read API (`GET /api/v1/control-coverage`, fields `status` and `hidden`) and evidence packs use the same rule, so a person with limited rights never sees a gap where there is evidence.

Evidence per kind of mapped item:

| Mapped item           | Evidence in the period                                          |
| --------------------- | --------------------------------------------------------------- |
| Process               | Runs (not dry runs) and whether they have a PDF protocol        |
| Record type           | Records with activity (created, changed, transitions, comments) |
| Record                | The record, when it had activity                                |
| Monitor               | Results and status changes (with the availability)              |
| Report schedule       | Scheduled reports generated                                     |
| Access reconciliation | Snapshots and findings                                          |

Designers and administrators map items to controls in the control's panel; they see (and can remove) only items they may see – a mapped item someone may not see is shown as _not visible_, without its id. Administrators edit control texts and import catalogues.

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

or CSV with the columns `ref`, `title` and optionally `description` (header row required; comma or semicolon). Importing into an existing catalogue replaces the texts of existing controls and adds new ones; nothing is removed. Up to 1 MB (YAML: 256 KB) and 2000 controls. Use it to add the wording your organisation licensed to the built-in controls.

## Evidence packs

_Compliance → Evidence packs → New evidence pack_: choose controls, a platform or a service, a period (at most three years) and the language of the PDFs. From the _Controls_ page, select controls and click _Evidence pack for … controls_.

The pack is built in the background and kept for download for 7 days (`SM_EVIDENCE_RETENTION_DAYS`). It holds:

| Path                                              | Content                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.pdf`, `index.json`                         | Summary (PDF/A): scope, controls with coverage, the protection need (service and platform packs, see below), contents; the machine-readable index                                              |
| `runs/<run>/…pdf`                                 | The run protocols (an archived report, or a new one; up to 100 are generated per pack)                                                                                                         |
| `records/<number>/`                               | Record PDF, `record.json` (content, hashes, history) and the attached files                                                                                                                    |
| `access-changes/`                                 | All access change entries of the pack as JSON and CSV                                                                                                                                          |
| `reconciliation/<check>/`                         | Check, snapshots (list and data), findings and the verification of the snapshot chain                                                                                                          |
| `reports/`                                        | Scheduled report PDFs of mapped report schedules                                                                                                                                               |
| `monitors/monitors.json`                          | Monitor evidence                                                                                                                                                                               |
| `audit/`                                          | Audit log excerpt from the start of the period up to a signed checkpoint created for the pack, the checkpoint and the result of the full chain verification (auditors and administrators only) |
| `manifest.json`, `manifest.sig`, `public-key.pem` | SHA-256 and size of every file, signed with the installation's Ed25519 key (the key of the audit checkpoints)                                                                                  |

The pack contains only what the requester may see: auditors and administrators get everything, others only items they may read (and no audit log). A pack of someone who cannot see everything says so: `index.json` has `filtered.complete: false`, the manifest `pack.filtered: true`, and the summary PDF a note. Each control lists how many evidence items were left out (`hidden`); a control with evidence the creator may not see is _not visible_ instead of a gap. For an audit, have an auditor or administrator create the pack. Requesting, building and downloading a pack are audited. Limits: 512 MB per pack (`SM_EVIDENCE_MAX_MB`), 5000 files, 1000 records, one pack in progress per user, 20 stored packs per user. Files are written to `data/evidence-packs/` as they are added, never held in memory as a whole.

**Verify a pack offline** (no server, vault or database needed):

```bash
npm run evidence:verify -- steward-evidence-2026-10-22-abc123.zip
steward evidence verify steward-evidence-2026-10-22-abc123.zip      # desktop app
npm run evidence:verify -- pack.zip --public-key steward-audit-public-key.pem --json
```

The check fails when the manifest signature is wrong, a file was changed, added or removed, the ZIP file holds bytes outside its listed entries (or its headers disagree), or the audit log excerpt does not reach its signed checkpoint.

**Which key to trust.** Anyone can build a pack, sign it with a key of their own and put that key into `public-key.pem`. So the check needs to know your installation's key:

1. Get it from the installation: _Audit log → Anchoring outside the database_ shows the public key (PEM) and its fingerprint to auditors and administrators. Keep a copy with your audit records.
2. Pass it: `--public-key <file>` (the PEM) or `--fingerprint <fp>` (the key in the pack must have this fingerprint). `--trust-pack-key` accepts the key in the pack – only when you compared its fingerprint some other way.

Without one of them the check still verifies the pack against the key inside it and prints the fingerprint, but reports _signature valid for an UNTRUSTED key_ (also with `--quiet` and `--json`, where `trusted` is `false`).

Exit status: 0 the pack is intact and signed with the trusted key, 1 a check failed (also: signed with another key than the trusted one), 2 usage error or unreadable file, 3 the pack is intact, but its key was not confirmed.

Manifest signatures are domain-separated from the audit checkpoints signed with the same key (version 2 manifests sign `steward-evidence-manifest-v2` plus the manifest); packs built before this change (version 1) still verify.

## Manual work and second-person verification

Work people do outside Steward – on site, by phone, in another tool – is documented with **manual steps** ([MANUAL-STEPS.md](MANUAL-STEPS.md)): a checklist, fields, evidence files with their SHA-256 and, where the step asks for it, the verification by a second person (maker–checker) before the run continues.

- The verifier is never the person who completed the step (also not under a former name from a moved instance) and, if the step says so, not the run starter. A list of verifiers is strict.
- _Not available, because …_ (required evidence or a required field) and entries made **after the fact** (a stated _done at_ time, never in the future, not before the run unless the step allows up to 30 days) are always verified, and both reasons are in the audit log.
- The run protocol PDF shows each step with its ticks, values, evidence, who completed and verified it and when; the protocol seal covers all of it. The audit log has `task.completed`, `task.backdated`, `task.evidence_added`, `task.verified` and `task.verification_rejected`.

Map such processes to your controls under _Controls_ like any other process.

## Protection needs (CIA)

Applications of the service catalogue have a CIA rating – confidentiality, integrity and availability, each with a justification, who rated it and when – and services derive their protection need from them ([APPLICATIONS.md](APPLICATIONS.md)).

**The maximum principle.** BSI-Standard 200-2 (IT-Grundschutz methodology) determines the protection need of a business process or service from the systems it uses: per basic value, the highest protection need of those systems applies. Steward does this per dimension across the applications of a service that are not archived. Two effects can change the result, and the standard asks you to document them:

- the **cumulation effect** – several damages of normal need add up, or one failure hits many processes: the need is higher than the maximum;
- the **distribution effect** – the system only carries a part of the data, or a redundant setup spreads the risk: the need is lower than the maximum.

In Steward you record both as an **override** of a dimension with a reason. The service page shows the derived level, the override and the effective level side by side, and every rating, override and change of the scale is in the audit log.

**Evidence packs.** A pack of a service has a section _Protection need (CIA)_ in `index.pdf`: per dimension the effective level and its basis (derived from how many rated applications, or set by whom with which reason), and the rating of each application. `index.json` holds the same data under `catalogue` (`service.protectionNeed`, `service.applications[].rating`, the scale mode), as it was when the pack was built. A pack of a platform names the application the platform belongs to and its rating.

The default scale is the BSI one (normal, high, very high). Administrators can define their own levels; a scale change maps or flags ratings for re-rating and never deletes one. Ratings that need re-rating do not count for the derived level, and the pack says how many there are.

## Who may do what

| Action                                         | Who                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Read controls and coverage                     | everyone who can sign in (items they may not see are left out)                                         |
| Read access change entries                     | admin, auditor, approver, the owner of the entry, and who has a right on its platform                  |
| Document access changes, document findings     | operator, designer, admin who may use the platform (findings: and read the check) – never their own    |
| Verify an access change entry                  | approver, admin – four-eyes (not the subject, performer, author, owner, run starter or run approver)   |
| Complete a manual step                         | the step's assignees, otherwise who may run or approve the process (four-eyes: not the run starter)    |
| Verify a manual step                           | the step's verifiers, otherwise who may run or approve the process – never the person who completed it |
| Read checks, snapshots and findings            | admin, auditor, the owner of the check, and who may use the platform                                   |
| Set up checks                                  | designer, admin (with the right to use the platform; dataset: and to view the publishing process)      |
| Change, run, disable a check; dismiss findings | the owner of the check, admin (dismiss: never the subject; four-eyes dismissals: a second person)      |
| Set or change ignored rights                   | admin                                                                                                  |
| Map items to controls                          | designer, admin (remove: only items they may see)                                                      |
| Edit and import catalogues                     | admin                                                                                                  |
| Start person reviews, decide, submit           | designer, admin (decide and submit: the reviewer or an admin) – never about their own access           |
| Approve or send back a person review           | approver, admin – not the reviewer, not the person reviewed                                            |
| Create evidence packs                          | everyone but viewers; download: the creator, auditors, administrators                                  |

## API

Web UI API under `/api/compliance/…`. Public, read-only API (API tokens):

- `GET /api/v1/access-changes` – access change entries the token owner may read (filters: platform, subject, status, kind, period),
- `GET /api/v1/access-findings` – reconciliation findings (filters: check, platform, status, period),
- `GET /api/v1/control-catalogues`, `GET /api/v1/controls` – catalogues and controls with their mapped items,
- `GET /api/v1/control-coverage?from=…&to=…` – coverage per control.

See the OpenAPI document (`/api/v1/openapi.json`).

## Try it in the demo

`npm run demo`, load the demo data, then open _Compliance → Access reconciliation_. The check _Insights Hub (demo) – user access_ has a baseline snapshot. Click **Simulate a change outside Steward**: the simulated tenant grants the tenant administrator role to a user, as if someone did it in the Insights Hub UI, and the check reports it as an undocumented grant. Click **Document this change**, give a reason – the finding is closed and the entry appears under _Access changes_ as _documented after the fact_. Then export an evidence pack for ISO/IEC 27001 5.18 from _Controls_ and check it with `npm run evidence:verify`.
