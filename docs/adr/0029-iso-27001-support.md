# 0029. ISO/IEC 27001 support: suppliers, statement of applicability, corrective actions

- **Status:** Accepted (owner decision 2026-11-10) – the scope was agreed with the owner and every open question was taken as recommended (see _Decided (November 2026)_). Built in 0.17.0: all four parts – suppliers, the statement of applicability with the responsibility matrix, corrective actions and the ISMS summary (with the notification `soa.approval_waiting`, the supplier review as a suggestion source, the supplier on findings, the `soa/` folder of evidence packs and the export parts)
- **Date:** 2026-11-10
- **Since:** 0.17.0 ([ROADMAP.md](../ROADMAP.md#next))

## Context

Teams that run their services with Steward are audited against ISO/IEC 27001. Steward already keeps much of the evidence ([COMPLIANCE.md](../COMPLIANCE.md)): control catalogues (ISO/IEC 27001:2022 Annex A built in, identifiers and Steward's own topic names only), mappings of processes, document types, documents, monitors, report schedules and access checks to controls (`control_tags`), coverage per period, signed evidence packs, access changes, reconciliation and person reviews; service duties with stored periods ([DUTIES.md](../DUTIES.md)); incident reviews with tracked measures (`record_measures`, [RECORDS.md](../RECORDS.md#incident-reviews)); documents with review intervals; report schedules with sections ([REPORTS.md](../REPORTS.md)); applications with a CIA rating and the derived protection need of services; platforms; cost plans per fiscal year ([ADR 0026](0026-service-cost-planning.md)); ticket references to vendors ([TICKETS.md](../TICKETS.md)).

What an auditor asks next is not covered:

- **Suppliers** (A.5.19–A.5.23). Most end-user solutions a service team runs are SaaS or managed platforms: the supplier runs the system, backs it up, patches it and recovers it. Steward knows suppliers only as **free text in five places**: `applications.vendor`, `systems.vendor` ("vendor or provider"), `ticket_refs.vendor`, `cd_watches.vendor` (changedetection.io page watches) and `cost_plan_lines.vendor` ("vendor or contract"). Platforms have no vendor field; a platform's supplier comes through the system that names it (`systems.platform_id`). The plant registry's `manufacturer` (and the advisories' `vendors`) names who built a device, not who is contracted – it is a product identity used to match advisories, not a supplier. No contract, notice period, SLA, data processing agreement or certificate is recorded anywhere.
- **The statement of applicability** (clause 6.1.3 d): per control, whether it applies and why, whether it is implemented, how, and who is responsible – for a SaaS-heavy service mostly _the supplier_. The Controls page shows coverage, not applicability.
- **Nonconformities and corrective actions** (clause 10.2): one register, from audits and from what Steward itself notices (missed duties, access review findings, undocumented access, incidents, supplier reviews), with a check that the fix worked. Today only incident measures are tracked, and only per review.
- **A summary for the management review** (9.3) from figures Steward already has.

The owner's boundaries: **Steward provides evidence; it does not make an organisation compliant.** Risk registers, policy management, vendor questionnaires and audit planning stay in GRC tools ([ROADMAP.md](../ROADMAP.md#non-goals), unchanged). The owner dropped three ideas (see _Considered and not chosen_).

## Decision

Four parts, built in this order, each additive and on top of what exists. Suppliers are core (catalogue); the statement of applicability, the responsibility matrix, corrective actions and the ISMS summary belong to the **Compliance module** (`compliance`, [MODULES.md](../MODULES.md)). New areas start as _preview_.

### 1. Suppliers (A.5.19–A.5.22)

A supplier is a record (`server/src/suppliers/`, `shared/src/suppliers.ts`, sidebar _Catalogue → Suppliers_, `/suppliers`):

- **Type**: SaaS, managed platform, software vendor, support or service provider, other. **Owners** (users and teams, like systems), description, website, a **criticality derived** from the highest protection need of the applications linked to it (shown, not stored).
- **Contacts**: name, role (account manager, support, security contact, data protection officer, other), e-mail, phone, note.
- **Contracts**: title, reference (contract number), start, end, notice period (days), renewal (automatic by _n_ months, by agreement, fixed end), the **notice-by date** derived from end and notice period, a link to the document (a record or a URL), and its **SLA**: availability target (%), support hours, response times (text), contractual **RTO** and **RPO** (hours). A contract links the **cost plan lines** that pay for it (`cost_plan_lines.supplier_contract_id`).
- **Data processing**: whether the supplier processes personal data for the service and, if so, the data processing agreement (in place since, linked document, or _missing_).
- **Certificates and reports**: kind (ISO/IEC 27001, 27017, 27018, 22301, SOC 2 type I/II, C5, TISAX, other), scope, issuer, issued, **valid until** (for a SOC 2 report: the end of its period plus twelve months, editable), link, and who looked at it and when.
- **Annual supplier review as a service duty**: a duty can name a supplier (`duties.supplier_id`, like `application_id`); the shipped example process _Supplier review_ walks through certificates, SLA reports, the data processing agreement, notice dates and open findings as manual steps with evidence files and a second person's verification. The supplier page shows the duty and its last periods; a finding of the review is recorded from there (part 3).
- **Used by**: the applications, systems, cost plan lines, ticket references, page watches and responsibility matrix rows that link it.
- Reminders (notification events `supplier.certificate_expiring`, `supplier.notice_due`): to the supplier's owners 90 and 30 days before a certificate runs out and before a notice-by date; the daily summary lists them.

**Free-text vendors become links.** `applications`, `systems`, `ticket_refs`, `cd_watches` and `cost_plan_lines` get a nullable `supplier_id`; the text column stays as a fallback and is shown where no supplier is linked. Forms offer a supplier picker with _New supplier_; the API keeps accepting the text. On upgrade, `migrateVendorTexts()` (the pattern of `migrateMonitorWindows`, [ADR 0018](0018-one-maintenance-window-concept.md)) runs once the vault is open and after a migration package is imported: it normalises each distinct text (`normVendor` of the advisories: letters and digits, legal forms left out), creates one supplier per normalised text with status **unconfirmed** and the original spellings as aliases, links the rows and records the text with its outcome in `supplier_text_migrations`, so a text is handled once. _Suppliers → To confirm_ lets a designer or administrator **confirm**, **merge** into another supplier (links move) or mark **not a supplier** (`On-premises`, an AWS account name – the supplier goes, links are cleared, the text stays). Unconfirmed suppliers do not count in summaries.

### 2. Statement of applicability with a responsibility matrix (6.1.3 d)

**The responsibility matrix per service** (`server/src/compliance/responsibilities.ts`, service page → tab _Responsibilities_). For six fixed **areas** – backup; recovery and continuity; patching and vulnerabilities; access management; logging and monitoring; security incidents – each service says who does it: **our team**, **a supplier** (one supplier, optionally one of its contracts), **central IT or group** (a name), **shared** (with a note on who does what) or **not applicable**. For a supplier the row shows the values of the supplier record – SLA, contractual RTO/RPO, valid certificates – read, not copied. Only where the team does recovery itself (our team or shared, for backup and for recovery and continuity) the row asks for a **recovery-test duty** of the service and shows _no recovery test_ until one is linked; Steward does not create duties. Each area carries a default list of ISO/IEC 27001:2022 Annex A refs (backup 8.13; recovery 5.29, 5.30, 8.14; patching 8.8; access 5.15–5.18, 8.2, 8.5; logging 8.15, 8.16; incidents 5.24–5.27); for another catalogue an administrator names the controls per area in the SoA settings.

**The statement of applicability** (`server/src/compliance/soa.ts`, _Compliance → Statement of applicability_, `/compliance/soa`): one per control catalogue, with an optional scope name and services in scope (none: all services). Per control:

- **applicable** yes or no, with a **justification** (required either way – 6.1.3 d asks for both inclusions and exclusions);
- **implementation status**: implemented, partly, planned, not started;
- **how it is met** (short text);
- **responsible party**: our team, a supplier, central IT or group, shared – and next to it the **derived suggestion** from the matrix of the services in scope (_supplier: 7 services · our team: 2_), with _Take suggestion_; the suggestion never overwrites the stored value;
- **owner** (a user or team), **last review** (who, when), a **GRC reference** (text and URL) and up to ten **external evidence links** (title and URL – a scanner's report, a supplier's trust centre);
- **evidence already in Steward**: the mapped items and the coverage of the last twelve months, by the coverage rule of the Controls page (a reader with fewer rights sees _not visible_, never a gap). An applicable, implemented control with no mapped item and no link is marked _no evidence_.

**Versions.** _Submit for approval_ (all controls decided, every applicable one with a status) freezes the rows, the control texts as they are, the coverage and the suggestions into a version (`soa_versions.content`, its SHA-256). An approver or administrator **approves** or **returns** it with a comment (control point `soa.approve`, below). An approved version is exported as a **signed file** in the evidence-pack format: `soa.pdf` (PDF/A), `soa.csv` (formulas defused), `soa.json`, `manifest.json` and `manifest.sig` with the installation's Ed25519 key (domain `steward-soa-manifest-v1`), `public-key.pem`; `steward evidence verify` checks it offline. The PDF is archived like reports (SHA-256 in the audit log). The page shows how many rows changed since the latest approved version.

### 3. Corrective actions (10.2)

One register (`server/src/compliance/corrective.ts`, _Compliance → Corrective actions_, `/compliance/corrective-actions`, tabs _Findings_, _Suggestions_, _Settings_):

- **A finding** (nonconformity or observation, numbered `CA-2026-0001`): title and description, **source** (internal audit, external audit, duty, access review, reconciliation, incident review, supplier review, other) with a link to what it came from, affected **controls** and **service** (and supplier), **severity** (major, minor, observation), **owner**, **due date**, **cause**, GRC reference, and **status**: open → in progress → implemented → closed, or cancelled (administrators, with a reason).
- **Actions**: title, owners, due date, note, done by and when; reminders before, on and weekly after the due date (event `corrective.action_due`, the mechanism of `measure.due`).
- **Effectiveness check**: who confirmed the fix worked, when, how (method) and the result. _Effective_ closes the finding; _not effective_ sends it back to in progress for a new action. The checker is a second person (control point `correctiveAction.verify`).
- Audit findings are entered by hand. **Steward suggests** findings from its own events; **a person confirms** each one (pre-filled finding) or dismisses it with a reason – nothing becomes a finding without a person. A suggestion has a source key (a duty period, a person review, a check and week, a record, a certificate), so the same event is suggested once. Sources: missed or failed duty periods, person review removals still there, reconciliation findings, accepted incident reviews, supplier review findings (expired certificate, missed supplier review, a finding recorded from the supplier page).
- **Incident review measures stay where they are** (`record_measures`, their reminders, the service page, `GET /api/v1/measures`). A confirmed finding of source _incident review_ links the review; its actions **are** the review's measures, read through, not copied – adding an action there adds a measure to the review. The register counts them with its own actions.
- The control's panel on _Controls_ shows its open findings; the SoA row shows them too.

### 4. ISMS summary (report section)

A section **ISMS summary** for the existing report schedules (`server/src/compliance/isms-report-section.ts` and its draw half, listed in `features/compliance.ts`), run with the schedule owner's rights like every section. Options: the catalogue, services (optional), days ahead (default 90). Contents: SoA counts (applicable, not applicable, undecided; implemented, partly, planned, not started; rows not reviewed for twelve months; the latest approved version and rows changed since); corrective actions (open by severity, **overdue**, closed and checked in the period, suggestions waiting); mandatory duty periods of the period **on time**, late, missed, failed, skipped; **reviews done** (documents reviewed within their interval, person reviews sealed, supplier reviews); suppliers with **certificates or notice-by dates** in the next days or past, unconfirmed suppliers; services with gaps in the matrix (undecided areas, recovery by our team without a recovery-test duty). It is not a new feature: no page, no state of its own.

### Data model (additive migrations)

`server/src/migrations/suppliers.ts`:

- `suppliers-001-suppliers`: `suppliers` (id, name, `norm_name`, type, description, website, owners, `personal_data`, `dpa_status`, `dpa_since`, `dpa_link`, `status` unconfirmed/active/archived, `aliases`, created and updated by and at), `supplier_contacts` (supplier, name, role, email, phone, note), `supplier_contracts` (supplier, title, reference, `starts_on`, `ends_on`, `notice_days`, `renewal`, `renewal_months`, `sla_availability`, `sla_support_hours`, `sla_response`, `rto_hours`, `rpo_hours`, link, note), `supplier_certificates` (supplier, kind, scope, issuer, `issued_on`, `valid_until`, link, `checked_by`, `checked_at`), `supplier_reminders` (sent once per item and key), `supplier_text_migrations` (table, normalised text, spellings, outcome, supplier, at).
- `suppliers-002-links`: `supplier_id` on `applications`, `systems`, `ticket_refs`, `cd_watches`, `cost_plan_lines` (and `supplier_contract_id` on `cost_plan_lines`), `duties.supplier_id`.

`server/src/migrations/compliance.ts`:

- `compliance-004-soa`: `soas` (catalogue unique, scope name, `scope_service_ids`, `four_eyes`, area controls for other catalogues), `soa_entries` (soa, control, applicable, justification, status, `how_met`, party, supplier, `central_name`, owner, `reviewed_at`, `reviewed_by`, `grc_ref`, `grc_url`, `evidence_links`, version, updated by and at), `soa_versions` (soa, number, status submitted/approved/returned/superseded, content, `content_sha256`, submitted and decided by and at, comment, files), `service_responsibilities` (service, area, party, supplier, contract, `central_name`, note, `duty_id`, updated by and at).
- `compliance-005-corrective-actions`: `ca_findings` (number, title, description, source, `source_kind`, `source_id`, service, supplier, `control_ids`, `record_id`, severity, owner, `due_date`, cause, status, `eff_method`, `eff_result`, `eff_note`, `eff_checked_by`, `eff_checked_at`, `grc_ref`, `grc_url`, `suggestion_id`, created, updated and closed by and at), `ca_actions` (finding, title, owners, `due_date`, note, `done_at`, `done_by`), `ca_action_reminders`, `ca_suggestions` (source, `source_key` unique, service, `control_ids`, title, details, status pending/confirmed/dismissed, decided by and at, reason, finding).

Person columns are history (`HISTORY_COLUMNS`); all tables move with migration packages. Dates are calendar dates in the instance's time zone, as for cost plans.

### Interfaces

Internal: `/api/suppliers` (list, create; `?status=unconfirmed`), `/api/suppliers/:id` (read, change, `…/archive`, `…/merge`, `…/confirm`, `…/not-a-supplier`), `…/contacts`, `…/contracts`, `…/certificates` (CRUD); `/api/services/:id/responsibilities` (read, `PUT`); `/api/compliance/soa`, `/api/compliance/soa/:catalogueId` (rows with coverage and suggestions), `PUT …/entries/:controlId`, `PUT …/settings`, `POST …/versions`, `POST …/versions/:n/decision`, `GET …/versions/:n/export?format=zip|pdf|csv`; `/api/compliance/corrective-actions` (list, create), `/:id` (read, change, `…/actions`, `…/effectiveness`, `…/cancel`), `/api/compliance/corrective-suggestions` (`…/:id/confirm`, `…/:id/dismiss`), `/api/compliance/corrective-settings`.

Public, read-only: `GET /api/v1/suppliers`, `/api/v1/suppliers/{supplierId}`, `/api/v1/services/{serviceId}/responsibilities`, `/api/v1/statements-of-applicability`, `/api/v1/statements-of-applicability/{catalogueKey}` (current rows, versions), `/api/v1/corrective-actions` (filters `status`, `source`, `severity`, `serviceId`, `overdue`), `/api/v1/corrective-actions/{findingId}`. MCP tools `list_suppliers`, `get_supplier`, `get_service_responsibilities`, `get_statement_of_applicability`, `list_corrective_actions`. Built-in datasets `suppliers.expiring` (certificates and notice dates), `compliance.soa`, `compliance.correctiveActions` (administrators and auditors, like `costs.plans`). Scheduled export parts ([ADR 0027](0027-backup-contents-and-exports.md)): suppliers (without contacts), the latest approved SoA, corrective actions (CSV). Evidence packs gain `soa/` (the latest approved version of the pack's catalogue) and `corrective-actions/` (the findings naming the pack's controls).

### Permissions and audit

| Action                                                                  | Who                                                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| See suppliers, contracts, certificates, contacts                        | everyone who can sign in (like systems)                                                                              |
| Create suppliers; confirm, merge, mark _not a supplier_; archive        | designers, administrators                                                                                            |
| Change a supplier, its contacts, contracts and certificates             | designers, administrators, the supplier's owners                                                                     |
| Change a service's responsibility matrix                                | whoever may edit the service                                                                                         |
| See the SoA                                                             | everyone who can sign in (evidence by the coverage rule)                                                             |
| Change SoA rows and settings; submit a version                          | designers, administrators; a row's owner changes its status, _how it is met_ and _last review_                       |
| Switch an SoA's second person off                                       | administrators, with the confirmation of `soa.approve`; never while the policy requires a second person              |
| Approve or return an SoA version                                        | approvers, administrators – control point `soa.approve`                                                              |
| See findings and suggestions                                            | administrators, auditors, designers, approvers, owners of a finding or action, whoever may edit the affected service |
| Record findings; confirm or dismiss suggestions; change findings        | designers, administrators, whoever may edit the affected service; owners mark their actions done                     |
| Check effectiveness                                                     | approvers, designers, administrators – not anyone who took part in the fix (`correctiveAction.verify`, see below)    |
| Cancel a finding; suggestion sources; area controls of other catalogues | administrators                                                                                                       |

New control points ([ASSURANCE.md](../ASSURANCE.md)): `soa.approve` (group _audit_; step-up on; four-eyes _optional_ – the SoA's switch _A second person approves_, on by default; the policy may make it required) and `correctiveAction.verify` (group _audit_; four-eyes `required` by default, may be set off). Audit actions: `supplier.created`, `.changed`, `.archived`, `.confirmed`, `.merged`, `.dismissed`, `.migrated` (system), `.contact_added|changed|removed` (without e-mail or phone values), `.contract_added|changed|removed`, `.certificate_added|changed|removed`; `responsibility.changed`; `soa.entry_changed` (before and after), `soa.settings_changed`, `soa.version_submitted`, `.version_approved` (with the content and PDF SHA-256), `.version_returned`, `.exported`; `corrective.finding_created`, `.finding_changed`, `.action_added|changed|removed|done`, `.effectiveness_checked`, `.finding_closed`, `.finding_cancelled`, `.suggestion_confirmed`, `.suggestion_dismissed`, `.settings_changed`.

### Delivery

1. **Suppliers**: tables, pages, contracts and certificates with reminders, the links and the picker in five forms, `migrateVendorTexts()` with the _To confirm_ list, the duty's supplier and the example process, API and MCP.
2. **Responsibility matrix**, then **the SoA**: rows, the derived suggestion, coverage, versions, approval, the signed export and its verification.
3. **Corrective actions**: register, actions and reminders, effectiveness, the suggestion sources one by one, incident reviews read through.
4. **ISMS summary** section; evidence pack folders, export parts, datasets; docs ([COMPLIANCE.md](../COMPLIANCE.md) sections, a supplier page, [PRIVACY.md](../PRIVACY.md), [MODULES.md](../MODULES.md), [ASSURANCE.md](../ASSURANCE.md)) and demo data (a SaaS supplier with a certificate about to expire, an SoA of the Annex A catalogue with one approved version, two findings).

Tests: `server/test/suppliers.test.ts` (CRUD, limits, notice-by date, reminders once, permissions, audit, API, MCP); `supplier-migration.test.ts` (normalisation, one supplier per text, idempotent runs, merge, _not a supplier_, after a package import, against the v0.16.0 upgrade fixture); `responsibilities.test.ts` (parties, supplier values read through, recovery-test duty flag); `soa.test.ts` (rows, justification required, suggestion never overwrites, coverage with hidden items, submit, approve with four-eyes and step-up, return, signed export verified offline, a changed file fails, rows changed since); `corrective-actions.test.ts` (register, actions, reminders, effectiveness and its four-eyes, each suggestion source with its key and default, dismiss, incident measures read through and `/api/v1/measures` unchanged, visibility); `isms-report-section.test.ts`; the new tables on PostgreSQL; the module switch. End to end: `e2e/suppliers.spec.ts` (confirm and merge migrated suppliers, a contract with a cost plan line), `e2e/soa.spec.ts` (matrix, take a suggestion, submit and approve on a desktop and a phone), `e2e/corrective-actions.spec.ts` (confirm a suggestion, add an action, check effectiveness).

Limits: 2,000 suppliers; per supplier 20 contacts, 50 contracts, 20 certificates, 50 aliases; one SoA per catalogue (up to the catalogue's 2,000 controls), justification 2,000 and _how it is met_ 1,000 characters, ten evidence links per row; 20,000 findings, 50 actions per finding; 1,000 pending suggestions (further ones wait, and the page says so).

### Considered and not chosen

- **Vulnerability fix deadlines** per finding and severity – enterprise scanners (Wiz and the like) do this well. Dropped by the owner; a scanner's report can be an external evidence link of an SoA row.
- **RTO and RPO for every service** – replaced by the responsibility matrix: for a supplier the contract's values, for what the team runs itself a recovery-test duty. Dropped by the owner.
- **A risk register** – stays in the GRC tool. Only a plain reference (text and URL) on SoA rows and findings, like a ticket reference.
- **Supplier questionnaires and assessments** – a GRC tool's job ([non-goals](../ROADMAP.md#non-goals)).
- **The SoA as a document type** (records): records have versions, approval and PDFs, but an SoA is a table of controls linked to coverage, suppliers and the matrix; its versions reuse the ideas (frozen content, hash, approval, PDF), not the storage.
- **Findings created automatically** – noise would bury the real ones; a person confirms each.
- **A separate ISMS module** – it would split controls, evidence and the SoA; suppliers would vanish with it although applications and cost plans link them.

## Decided (November 2026)

The owner took the recommended answer to every open question ("go with the recommendations"), decided on 2026-11-10:

1. **One SoA per installation or per scope:** one per control catalogue per installation, with an optional scope name and services in scope – an organisation states one SoA; service-level detail lives in the responsibility matrix.
2. **Who approves an SoA version:** an approver or administrator through the new control point `soa.approve` (step-up on); a second person through the SoA's switch, on by default, or required by the policy – the existing four-eyes machinery, no new mechanism.
3. **Who edits:** suppliers like systems (designers, administrators, the supplier's owners); SoA rows designers and administrators, a row's owner its status and review; the matrix whoever may edit the service; findings designers, administrators and the service's editors, with the effectiveness checked by a second person – the existing roles, no new role.
4. **Free-text vendors:** one **unconfirmed** supplier per normalised text, linked, the text kept as a fallback; people confirm, merge or mark _not a supplier_ – texts such as `On-premises` must not become suppliers silently.
5. **Incident review measures:** surfaced, not moved – they stay in `record_measures`; a confirmed incident finding reads them as its actions. Not every incident is a nonconformity, and `/api/v1/measures` and the reminders keep working without a data migration.
6. **Suggestion sources on by default:** missed or failed periods of **mandatory** duties, accepted incident reviews of severity major or critical, person review removals still there 30 days after approval, and supplier review findings (expired certificate, missed review). Off by default: reconciliation findings (when on: findings still open after seven days, one suggestion per check and week), recommended duties, minor incidents – few, clear signals first.
7. **GRC risk reference:** yes, a plain text and URL on SoA rows and findings – a link to where the risk lives, no risk model in Steward.
8. **Data protection:** supplier contacts are personal data of people outside Steward. The app shows them to who may sign in; `/api/v1`, MCP, datasets and export parts leave out e-mail and phone; audit entries name the contact, never the e-mail or phone values; removing a contact deletes it; [PRIVACY.md](../PRIVACY.md) gets a row. Owners, approvers and checkers are Steward users and follow pseudonymisation as history columns.
9. **API, MCP, datasets:** read through `/api/v1`, MCP and datasets; **writes only in the app** – approvals, confirmations and effectiveness checks are decisions of people in a session.
10. **Modules:** suppliers are core (_Catalogue_), because core records link them; the SoA, the matrix, corrective actions and the ISMS section belong to the Compliance module.
11. **Responsibility areas:** six fixed areas (backup; recovery and continuity; patching and vulnerabilities; access management; logging and monitoring; security incidents) with default Annex A refs – fixed so that suggestions and summaries compare across services; configurable areas can come later.
12. **The SoA export:** the evidence-pack format and key with a separate signature domain – one verifier, one key to trust.
13. **The supplier review:** a service duty that names the supplier, done by the example process with manual steps – duties already store periods, remind and judge.
14. **Limits** as above – generous for one installation, bounded for the pages and exports.

### Changed after the security review of 0.17.0 (November 2026)

Before the release, a security review found ways around the decisions above; the fixes change them as follows.

- **Decision 2, the SoA's second person:** whether a second person approves is fixed into each version when it is submitted (`soa_versions.four_eyes`, migration `compliance-006-soa-version-four-eyes`); approving reads that value, or the policy now if it is stricter, never the switch as it is now. Designers switch it on; only administrators switch it off (also when creating a statement), after the confirmation of `soa.approve` (step-up action `changeSoaApproval`), and not at all while the policy requires a second person.
- **Suggestions and findings (part 3):** a suggestion stores what it came from by id, never by name; the title of an incident review and the names of duties, suppliers, certificates, person reviews and access checks are read when it is read, with the reader's rights (the ISMS summary with the schedule owner's, evidence packs with the creator's). A reader who may see the register but not the source gets a neutral title and _… you may not see_ instead of the name. A confirmed finding starts with the neutral title.
- **The effectiveness check (part 3):** who took part in the fix is kept on the finding for good (`ca_findings.fix_participants`, migration `compliance-007-corrective-participants`): every owner the finding has had, every owner of its actions and of its incident review's measures – a team with its members of then, and its members at the time of the check –, who marked one done, and who removed or changed one, or the owner, after the finding was implemented. None of them checks the effectiveness. Removing, reassigning, reopening or adding an open action, or changing the owner, sends an implemented finding back to _in progress_ – the simpler rule than refusing, and the one that also works for measures changed on the incident review's page.

## Consequences

- An auditor gets the SoA as a signed file with its evidence, the suppliers with contracts, SLAs and certificates, and one register of nonconformities with checked fixes – from the place where the evidence already is.
- For SaaS-heavy services the SoA says honestly that the supplier is responsible, and why – with the contract's values and a certificate, not a claim of our own.
- Five forms change from free text to a picker, and the upgrade leaves a list _To confirm_ that someone has to work through once; until then summaries leave the unconfirmed suppliers out.
- Steward takes on more of what a GRC tool does. The line stays where the non-goals draw it: no risk register, no questionnaires, no policy management, no audit planning. Revisit if teams ask for configurable responsibility areas, several SoAs per catalogue (separate certificates per business unit), MCP proposals for SoA rows, or a supplier portal.
