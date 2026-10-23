# Records and services

Records are documents the service team writes, reviews and approves in Steward: **change requests**, **decision records** and **living documents** (service documentation, concepts, manuals). A record has a number, a workflow, versions, comments, links, attachments and an audit trail. When the content is final, Steward generates a PDF/A document with empty signature fields, so people outside Steward (business owners, requesters) can sign it. The signed PDF goes back to the record.

The **service catalogue** is a deliberately small list of the services the team runs: owners, criticality, a link to the entry in your real CMDB, and links to platforms, monitors, processes, dashboards and records. It is not a CMDB.

- [Record types](#record-types)
- [Numbers](#numbers)
- [Workflows](#workflows)
- [Content, versions and the content hash](#content-versions-and-the-content-hash)
- [Who may do what](#who-may-do-what)
- [Writing a record](#writing-a-record)
- [Links](#links)
- [Attachments](#attachments)
- [Living documents](#living-documents)
- [Import and export (Markdown)](#import-and-export-markdown)
- [PDF and signatures](#pdf-and-signatures)
- [Audit log](#audit-log)
- [API](#api)
- [Service catalogue](#service-catalogue)

## Record types

Steward creates six types on first start (`DOC` is added to existing installations on the first start after the update). Administrators change them under _Records → Record types_: key (number prefix), name, description, workflow, Markdown template and fields.

| Key   | Name                         | Workflow | Fields                                                                                                              |
| ----- | ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `CR`  | Change request               | change   | reason\*, risk\* (low/medium/high), impact, rollback plan\*, planned start, planned end                             |
| `ADR` | Architecture decision record | decision | decision date, deciders, consulted, informed                                                                        |
| `DR`  | Decision record              | decision | as ADR                                                                                                              |
| `SDR` | Security decision record     | decision | as ADR; template with _Risk assessment_ and _Review date_                                                           |
| `AC`  | Access change                | access   | platform\*, subject\*, change\*, rights before/after, reason\*, request, approver, performed by\*, performed at\*   |
| `DOC` | Service documentation        | document | none; template with _Purpose and scope_, _Responsibilities_, _Content_, _Related documents_; review every 12 months |

\* required before the record can be submitted.

_SDR_ is read as "security decision record". If your team uses the abbreviation for something else, change the type's name, description and template (all editable), or archive it and create your own type. The key can change only while no records of the type exist. The built-in types are stored in English. Each person sees their names, descriptions, templates, field labels and select options in their own language, as long as an administrator has not changed the text; a changed text is shown to everyone as entered. A new record starts with the template in the language of the person who creates it. See [I18N.md](I18N.md#record-types).

Notes:

- Field kinds: text (one line), text (several lines), date, date and time, choice. Field keys are camelCase (`rollbackPlan`).
- The key and the workflow of a type cannot change once it has records: the key is part of their numbers and of the content hash they were approved with. Change the name instead, or create a new type.
- Fields can change at any time. Frozen records keep the field labels, kinds and choices they had when they were frozen (the PDF and the record page show those); values without a definition are shown by their key.
- Archived types keep their records but accept no new ones.
- Types with the workflow _document_ have a **review interval** in months (default 12; 0 = no periodic reviews). If an installation already used the key `DOC` for its own type, the built-in type gets the key `SDOC`.
- The context, decision, consequences and alternatives of a decision record are sections of the Markdown text (the template has the headings), not fields.

## Numbers

Every record gets a number when it is created: `<KEY>-<YEAR>-<NNNN>`, for example `CR-2026-0001` or `ADR-2026-0007`. The counter runs per key and calendar year (UTC) and never repeats. You can open a record by its number: `/records/CR-2026-0001` and `GET /api/v1/records/CR-2026-0001` both work.

Imported files get a new number. The number from the file (`# 7. …`, `number:` in the frontmatter) is kept in the import notes.

## Workflows

**Change** (change requests):

```
Draft ──submit──▶ Submitted ──approve──▶ Approved ──implement──▶ Implemented ──close──▶ Closed
  │                  │  └──reject──▶ Rejected
  └──cancel──▶ Cancelled ◀──cancel──┘
```

**Access** (access change entries, see [COMPLIANCE.md](COMPLIANCE.md)): Draft ──document──▶ Documented ──verify──▶ Verified; Draft ──cancel──▶ Cancelled. _Verify_ is an approval (four-eyes; the person who performed the change cannot verify it either). The fields of the access change type cannot be removed: the reconciliation and the evidence packs read them.

**Decision** (ADR, DR, SDR):

```
Draft ──propose──▶ Proposed ──accept──▶ Accepted ──supersede──▶ Superseded
                      └──reject──▶ Rejected   └──deprecate──▶ Deprecated
```

- **Approve, accept and reject** are approvals: only approvers and administrators, and never someone who wrote the record (four-eyes, see below). Rejecting needs a comment.
- **Supersede** names the record that replaces the decision – another decision record. Steward adds a link "superseded by", so the new record shows the old one under _Linked from_.
- **New revision** (_Rework_ on a rejected record): from _Submitted_, _Rejected_ (change) or _Proposed_, _Rejected_ (decision) the record goes back to _Draft_ as revision 2, 3, …. It needs a reason. Approved, accepted and closed records cannot be revised: approved content is immutable. Write a new record instead (and supersede the old decision).
- Closed, cancelled, superseded and deprecated are final.

**Document** (living documents, e.g. `DOC`; see [Living documents](#living-documents)):

```
Draft ──submit──▶ In review ──approve──▶ Published (edition n) ──new edition──▶ Revising ──submit──▶ In review ──approve──▶ Published (edition n+1) …
                     └──reject──▶ Draft / Revising                                               any of Draft, Published, Revising ──withdraw──▶ Withdrawn
```

- **Approve** freezes the content as an **edition** (1.0, 1.1, 2.0). Rejecting needs a comment and goes back to _Draft_ (no edition yet) or _Revising_.
- **Withdraw** needs a reason and may name the replacing document – another living document (link "replaced by"). Withdrawing while the next edition is drafted drops the draft; every approved edition stays readable.
- The content can change in _Draft_ and _Revising_. A new edition starts from the current one, which stays valid until the next one is approved.

## Content, versions and the content hash

The **content** of a record is its title, Markdown text, fields and attached files. It can only change while the record is a draft.

- Every save that changes title, text or fields creates a **version** (v1, v2, …) with author, change note and a hash. _Versions_ shows the history and a line diff between any two versions.
- **Leaving the draft status freezes the content.** Steward computes the **content hash** – SHA-256 over the canonical JSON of record id, number, type key, revision, title, text, fields and the name, size and SHA-256 of every attached file – and stores it as the record's _frozen hash_. The transition, and every later one, is audited with this hash.
- An approval always approves exactly the frozen content – the content the approver saw: the web app sends the hash it shows in the approval dialog (`contentHash`), and if the content changed in the meantime (reworked and submitted again), Steward refuses the decision (`RECORD_CHANGED`, reload and check again). The field is optional in the API; clients that decide should send it. Before every transition Steward recomputes the hash and compares it with the frozen hash **and** with the hash in the authentic (HMAC-chained) audit entry that froze the revision. If the content no longer matches (changed in the database, outside Steward – even with the frozen hash recomputed), the record is marked as tampered and cannot move on.
- Tags, the owner and links are not content. They can change after approval; every change is in the audit log.

## Who may do what

Everyone who can sign in reads records and services (auditors included) – except access change entries (type AC), which only administrators, auditors, approvers, their owner and who has a right on their platform read, and only people who may use that platform write (see [COMPLIANCE.md](COMPLIANCE.md#access-change-entries)). The server checks every action.

| Action                                                                                                         | Who                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create records, import Markdown                                                                                | designer, operator, admin                                                                                                                                                                                                                   |
| Edit a draft, attachments, links, submit/propose, implement, close, cancel, supersede, deprecate, new revision | designer, operator, admin, and the record's owner                                                                                                                                                                                           |
| Approve, accept, reject                                                                                        | approver, admin – **four-eyes**: not the owner, not the creator, not the person who submitted it, not anyone who wrote content (a version of any revision – a new revision starts with the earlier content – or attached or removed a file) |
| Review a living document (_Reviewed – no change_, _Needs update_)                                              | the document's owner and review owner, approver, admin                                                                                                                                                                                      |
| Review settings of a living document: an earlier next review date                                              | designer, operator, approver, admin, and the document's owner                                                                                                                                                                               |
| Review settings: review owner, the document's own interval, dropping or postponing an earlier date             | approver, admin – an approver who owns or wrote the document cannot make themselves its review owner                                                                                                                                        |
| Review settings: no periodic reviews (0) or an interval longer than the type's                                 | admin                                                                                                                                                                                                                                       |
| Comment                                                                                                        | everyone who may edit or approve                                                                                                                                                                                                            |
| Generate PDFs, upload signed PDFs                                                                              | everyone who may edit or approve                                                                                                                                                                                                            |
| Attach a PDF without the signature check                                                                       | admin                                                                                                                                                                                                                                       |
| Hand a record over to another owner                                                                            | the owner, admin – not while the record waits for an approval (submitted, proposed, documented, in review): four-eyes is checked against the owner                                                                                          |
| Manage record types                                                                                            | admin                                                                                                                                                                                                                                       |
| Create services                                                                                                | designer, admin                                                                                                                                                                                                                             |
| Edit and archive a service, change its links                                                                   | designer, admin, and the users and teams named as responsible on the service                                                                                                                                                                |

## Writing a record

1. _Records → New record_: choose the type and a title. Steward creates a draft with the type's template and opens the editor.
2. Fill in the fields and the text. The text is Markdown: headings (`##`), lists, numbered lists, task lists (`- [ ]`), `**bold**`, `*italic*`, `` `code` ``, code blocks, quotes, tables and links. The preview shows the result.
3. _Save_. Add a change note if it helps reviewers.
4. Add links and attachments, then _Submit_ (or _Propose_).

Markdown is rendered without HTML: `<script>` or `<b>` in the text is shown as text. Links work for `http`, `https` and `mailto` only and open in a new tab without a referrer. The same parser feeds the PDF. It works in linear time, so no text can make the page or the PDF hang; tables have at most 50 columns and 20 000 cells per text (longer tables continue as plain text).

## Links

A record or service links to:

- internal items: processes, runs, monitors, platforms, dashboards, other records, services, credentials register entries;
- external pages: the entry in your CMDB, a ticket, a wiki page (`http` and `https` only).

Every link has an optional note, e.g. _affected_, _implements_, _ServiceNow ticket_. Both sides show the link: the target lists it under _Linked from_ (records and services), and `GET /api/backlinks?kind=platform&id=…` returns the records and services that link to any item. Credentials register entries that name the item under _Used by_ (e.g. a technical user used by a service) are listed there too, for people who may read the entry.

You can only link items you can see. If a reader may not see a linked process, platform or credential, the link shows as "not visible" without its name or id (in the API, `targetId` is `null`), and `GET /api/backlinks` answers 404 for items the reader may not see. The same holds for _superseded by_ and _replaced by_: if the reader may not read that record (an access change entry, say), the record page, the PDF and the API only say that it is not visible (`supersededBy: { visible: false, id: null, number: null, title: null }`). Credentials follow the register's read rules ([CREDENTIALS.md](CREDENTIALS.md#who-may-do-what)): viewers only see entries they own. Links of closed records (_closed_, _cancelled_, _superseded_, _deprecated_) cannot change any more.

Links are stored generically as `{ kind, id }`. A new kind needs an entry in `LINK_KINDS` (`shared/src/records.ts`) and a resolver registered with `registerLinkKind()` (`server/src/records/links.ts`).

## Attachments

Drafts take documents and e-mails, up to 20 MB each and 50 per record:

| Kind    | Extensions                                                                |
| ------- | ------------------------------------------------------------------------- |
| PDF     | `.pdf`                                                                    |
| Images  | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`                                  |
| E-mails | `.eml`, `.msg`                                                            |
| Office  | `.docx`, `.xlsx`, `.pptx`, `.doc`, `.xls`, `.ppt`, `.odt`, `.ods`, `.odp` |
| Text    | `.txt`, `.md`, `.csv`                                                     |

Steward checks that the content matches the extension (PDF header, image signatures, OLE and ZIP containers, e-mail headers, UTF-8 text without NUL bytes) and rejects everything else. File names are cleaned. Files are written once, read-only, to `data/records/<record id>/`, and their SHA-256 is recorded and checked on every download. Downloads are always attachments with a sandbox content security policy, never shown inline.

Attached files are part of the content hash. Once the record is frozen they cannot change. Back up `data/records/` together with the database.

## Living documents

Service documentation – an operations manual, an identity and access management concept, an authorization concept – keeps its identity and changes over time. Use a type with the workflow _document_ (the built-in `DOC – Service documentation`, or your own). This follows ISO/IEC 27001 clause 7.5.3 (versions, approval, old versions kept) and A.5.1 (review at planned intervals).

**Edition, not version.** A _version_ is every save inside a draft (as for all records). An _edition_ (Fassung) is an approved state: 1.0, 1.1, 2.0. Each edition is frozen with its own content hash, like approved records.

### Publish the first edition

1. _Records → New record_, type `DOC`. Write the text from the template and save.
2. _Submit_. Summarise what the edition contains (required). The first edition is always 1.0.
3. An approver opens the document and chooses _Approve_ (four-eyes, see below). The document is _Published_, edition 1.0.

### Change a published document

1. _New edition_ (with a reason). The document goes to _Revising_ with a copy of the current edition. **The current edition stays valid** – links, the list and evidence show it – until the next one is approved.
2. Edit and save as often as needed, then _Submit_ and choose:
   - **Minor** – editorial (1.0 → 1.1),
   - **Major** – substantive (1.x → 2.0),
     and write the change summary (required).
3. An approver approves it. It becomes the current edition; the old one stays readable.

Four-eyes for editions: approvers and administrators approve; never the owner, the creator, the person who submitted the edition or anyone who wrote content **of this edition** (a save of its draft, an attached or removed file). The copy a new edition starts with does not count, so a living document can still be approved after years of changes by many people. Every approval is audited as `record.edition_approved` with the edition, its kind and content hash.

### Document changelog

The tab _Changelog_ lists every edition (edition, kind, date, authors, approver, change summary) and every review. Per edition: _Open_ shows the frozen edition, _Diff_ shows the changes from the previous edition, _PDF_ generates the PDF of exactly that edition. The record PDF of a document has a _Document control_ section with the same table, the last review and the next review (English and German, PDF/A, your branding). Steward also checks each stored edition against its hash and the authentic audit entry of its approval – the content and the metadata (change summary, authors, submitter, approver, dates) – and each review against the audit entry that recorded it. A changed edition or review is marked in the changelog, the API (`intact: false`) and the PDF. The database itself refuses to change or delete stored editions and reviews (triggers on SQLite and PostgreSQL; `db:copy --force` lifts them only while it replaces the data).

### Periodic reviews

- **Next review** = approval of the current edition, or the last review, plus the interval (the document's own, else its type's). It can be set earlier.
- Status: **current**, **due soon** or **overdue**. _Due soon_ uses the same setting as the credentials register (Settings → Credentials: due soon within N days).
- **Reviewed – no change**: the owner, the review owner, approvers and administrators record it with a comment. The edition stays, and the next review is planned from today.
- **Needs update** (comment required): starts the next edition (_Revising_). The review stays due until that edition is approved: _Reviewed – no change_ is refused until then, also when the new edition is rejected.
- _Review settings_: review owner (default: the owner), interval (0 = none), an earlier date for the next review. Reviews are a control, so the people who write a document cannot weaken them: editors and the owner may only set an earlier date (or move it earlier). Approvers and administrators choose the review owner and a shorter interval, and may drop or postpone an earlier date; an approver who owns or wrote the document cannot make themselves its review owner. Only administrators turn the reviews off or make the interval longer than the type's. Changes are audited (`record.review_settings_changed`).
- **Reminders** go to the review owner (in-app, and e-mail or Teams as routed for the event _Document review due_ under Settings → Notifications) with the schedule of the credentials reminders: the reminder of the smallest threshold reached before the date (e.g. 30, 14, 7, 1 days), then every N days while overdue. Each reminder is sent once (also across restarts). E-mail goes only to Steward users and follows the allowed e-mail domains.

### Where documents show up

- **Records list**: filters _Workflow_ and _Review_ (e.g. "Due soon or overdue"); documents show their edition and a due review.
- **Start page**: the tile _Reviews due_ (editors, approvers and auditors see all documents; others the documents they own or review; zero: "All quiet").
- **Daily summary**: the section _Document reviews due_ for the reviews you own. Documents in review count as waiting for your approval.
- **Scheduled reports**: the records section lists living documents with the edition and the review status at the end of the period, and the editions and reviews in it.
- **Links** to a document show its current edition.
- **Compliance**: map a document type or a document to a control (e.g. ISO 27001 5.1, 5.37). A document counts as evidence while an edition is valid in the period, even without changes; the evidence shows the edition, its content hash, its approval and the last review. Evidence packs hold the PDF of that edition and its `record.json`.

## Import and export (Markdown)

_Records → Import Markdown_: drop up to 20 `.md` files (256 KB each, 2 MB together). Steward shows a preview (title, type, fields, status, warnings, errors per file), then _Import_ creates one **draft** per file. A broken file does not stop the others.

What Steward reads:

| In the file                                                                                         | Becomes                                                                                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| YAML frontmatter `title`, or the first `# heading`                                                  | title (`# 1. Title` and `# ADR-0007: Title`: the number goes to the import notes)                  |
| `type: CR` (frontmatter)                                                                            | the record type; else the type chosen in the dialog; MADR and Nygard files without one become ADRs |
| `status` (frontmatter, `## Status` section, `* Status:` bullet)                                     | see below                                                                                          |
| `date`, `Date: 2024-02-01` line                                                                     | the _decision date_ field                                                                          |
| `deciders`, `consulted`, `informed` (string or list)                                                | the fields of the same name                                                                        |
| `tags` / `keywords`                                                                                 | tags                                                                                               |
| other keys that match a field key or label (`reason`, `rollbackPlan`, `Risk` …), or a `fields:` map | those fields (dates and choices are normalised: `High` → `high`)                                   |
| anything else                                                                                       | kept in the import notes of the record                                                             |
| the rest of the text                                                                                | the Markdown text                                                                                  |

**Status.** Imported records always start as drafts: a decision needs an approval in Steward before it counts. A status that means "still being written" (draft, wip, in progress, open, new) is dropped. Any other status (accepted, proposed, superseded …) is kept in the import notes and as a tag such as `status:accepted`, and the record page shows it.

**Safety.** The frontmatter is parsed with the YAML core schema: no custom tags (`!!js/function` is rejected), at most 20 aliases, 16 KB. Files that are not `.md`, `.markdown` or `.txt`, contain NUL bytes or are too large are rejected.

MADR example (MADR 3/4):

```markdown
---
status: accepted
date: 2024-05-14
deciders: [Dana Designer, Olivia Operator]
consulted: Security team
---

# Use PostgreSQL for the shared instance

## Context and Problem Statement

Several instances share one database.

## Decision Outcome

Chosen option: "PostgreSQL", because it supports concurrent writers.
```

Nygard example:

```markdown
# 1. Record architecture decisions

Date: 2024-02-01

## Status

Accepted

## Context

We need to record the architectural decisions made on this project.

## Decision

We will use Architecture Decision Records.

## Consequences

See Michael Nygard's article.
```

MADR 2 files with `* Status: proposed`, `* Deciders: …`, `* Date: …` bullets under the title are understood too.

**Export.** _More actions (…) → Export as Markdown_ (`GET /api/records/:id/export`) downloads `CR-2026-0001.md`: frontmatter with title, type, status, number, owner, tags, fields and a `steward:` block (id, revision, version, content hash), then `# Title` and the text. Importing the file again gives a new draft with the same title, text, fields and tags (plus the `status:` tag).

## PDF and signatures

### Generating

_More actions (…) → Generate PDF_ (or the _PDF & signatures_ tab): choose the language (English or German; without a choice, through the API: the language in your profile) and add up to 8 **signers** – name, role (e.g. _Business owner_, _Requester_) and optionally an e-mail address. Each generation is stored with the record (`data/records/<id>/`), never overwritten, and audited as `record.pdf_generated` with the file's SHA-256 and size.

The PDF contains:

- a header with your logo and company name (_Settings → Report branding_), classification and status;
- number, type, status, revision and version, owner, dates and the **content hash**;
- the fields and the Markdown text (headings, paragraphs, lists, code, quotes, tables; links as "text (URL)");
- the attached files with their SHA-256, the links;
- the approval history and comments, and an excerpt of the audit log;
- one **signature block per signer**: role, name, e-mail, a date line, a box for a handwritten signature and an empty digital signature field.

A draft can be printed too, but the PDF says _DRAFT_ in large letters: sign the PDF of a submitted or approved record.

Very long words (more than 40 characters without a space, 100 in code) get invisible break opportunities, so that they wrap and the PDF stays quick to make – this holds for run and scheduled reports too. A PDF draws at most 1 000 000 characters; a record with more content gets no PDF (shorten it).

### PDF/A and the signature fields

The PDF is **PDF/A-2b**: embedded fonts (Inter, JetBrains Mono), sRGB output intent, XMP metadata with the PDF/A identification and Steward's own properties (`stw:recordNumber`, `stw:contentHash`, …, described by a PDF/A extension schema).

The signature fields are real AcroForm signature fields. PDFKit has no API for them, so Steward builds them with PDFKit's low-level object API (`server/src/reports/pdf/engine.ts`, shared with the run reports):

- each field is a merged field/widget annotation with `/FT /Sig`, a unique name (`/T (Signature_1_Business_owner)`), a tooltip, the print flag and an appearance stream (PDF/A requires one for every widget; an empty form XObject draws nothing);
- the document's `/AcroForm` lists the fields with `/SigFlags 1` and **no** `/NeedAppearances` (forbidden in PDF/A).

Unsigned signature fields are allowed in PDF/A-2b, and signing appends an incremental update, so the signed file stays PDF/A as long as the signing tool behaves. (The tests sign a generated PDF with poppler's `pdfsig`; the signed file still passes veraPDF.) The generated files pass veraPDF (PDF/A-2b); the test suite runs veraPDF on them when `SM_VERAPDF` names the veraPDF command line.

### Signing in Adobe Acrobat (Reader)

1. Open the PDF. Acrobat shows the signature fields as blue boxes in the _Signatures_ section.
2. Click the field with your name (or _Tools → Certificates → Digitally Sign_ and draw a box over the field).
3. Choose your digital ID (a certificate from your company PKI, a smart card, or a self-signed ID if your process allows that) and, if you like, an appearance.
4. Click _Sign_ and **save under a new name**. Acrobat adds the signature as an incremental update and does not change the original bytes.
5. The next signer opens the signed file and signs their field the same way.

Other tools that sign existing fields with an incremental update (Foxit, Okular, LibreOffice, `pdfsig`/`pyHanko`) work the same way. Do not "print to PDF", flatten or re-save the file with _Save as_ options that rewrite it: then it no longer starts with the generated bytes.

### Uploading the signed PDF

_PDF & signatures → Upload signed PDF_. Steward accepts the file when:

1. it starts, byte for byte, with a PDF Steward generated **for this record**: the SHA-256 of the first _n_ bytes (n = size of a generated PDF, ending with `%%EOF`) equals the stored hash of that PDF, **and** the matching `record.pdf_generated` entry in the audit log is authentic (HMAC and chain position checked) – a row added to the database by hand does not count;
2. that PDF shows the **current revision with frozen content**: it was generated after the record left the draft status, for the current revision and with the current frozen hash (as its audit entry says). PDFs of drafts and of earlier revisions are refused;
3. the appended part contains at least one signature dictionary, and **every** signature has a signature value (`/Contents`) and a `/ByteRange` that covers its revision of the file except the `/Contents` placeholder.

From each signature dictionary Steward reads the signer name (`/Name` – what the signing tool claims, shown as "claimed signer (not verified)"), the signing time (`/M`), reason, location, the sub-filter and the field name. The signed file is stored with its SHA-256, listed with these details, and audited as `record.signed_pdf_uploaded`.

Rejected with a clear message:

- the unsigned PDF itself ("sign it first");
- a PDF generated for another record, a modified copy, or any other PDF ("not derived from a PDF Steward generated for this record");
- a copy with an update but without a signature, or with a signature without value or with an odd byte range;
- a PDF of a draft or of an earlier revision ("generate the PDF of the current revision").

A record keeps at most 100 generated and 30 signed PDFs, 300 MB together.

Administrators can attach such a file anyway – for example a scan of a paper signature – with _Attach without check_. It is marked _Not checked_ and audited as `record.unverified_pdf_attached`.

**Limits – read this.** Steward checks the **structure**, not the cryptography. It does **not** verify the signature values, the certificates, their chain of trust, revocation or time stamps (no PAdES validation), and it does not analyse whether later incremental updates change what the document shows. The UI and the audit entry say so: "structure checked, signatures not cryptographically validated". Validate signatures in Acrobat or with a validation service when it matters.

## Audit log

Every change is in the tamper-evident audit log (entity type `record`, `record_type` or `service`):

`record.created`, `record.imported`, `record.updated` (with the version hash), `record.submit` (documents: with edition kind and change summary), `record.approve`, `record.edition_approved` (documents: edition, kind, content hash, authors, approver and a hash of the edition's metadata), `record.withdraw`, `record.reviewed` (edition, outcome, content hash, next review and a hash of the stored review), `record.review_settings_changed`, `record.review_reminder_sent`, `record.reject`, `record.implement`, `record.close`, `record.cancel`, `record.propose`, `record.accept`, `record.supersede`, `record.deprecate` (all with from/to status and the content hash), `record.revised` (with the previous frozen hash), `record.commented`, `record.link_added`, `record.link_removed`, `record.attachment_added`, `record.attachment_removed`, `record.pdf_generated`, `record.signed_pdf_uploaded`, `record.unverified_pdf_attached`, `record_type.created`, `record_type.updated`, `service.created`, `service.updated`, `service.archived`, `service.restored`, `service.link_added`, `service.link_removed`.

## API

Web UI API (session; changes need the `x-sm-client` header like every other route):

| Route                                                                                                                                                   | What                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/records?type=&status=&tag=&q=&owner=&workflow=&review=`                                                                                       | list (status, review: comma-separated)                                                                          |
| `POST /api/records` `{ type, title, body?, fields?, tags? }`                                                                                            | create a draft (body defaults to the template)                                                                  |
| `GET/PUT /api/records/:idOrNumber`                                                                                                                      | read; change `{ title, body, fields, tags, owner, comment, baseVersion }`                                       |
| `GET /api/records/:id/versions[/:version]`                                                                                                              | versions                                                                                                        |
| `POST /api/records/:id/transition` `{ action, comment?, supersededBy?, editionKind?, changeSummary?, contentHash? }`                                    | workflow (documents: kind and summary on submit; `contentHash`: refused if the content no longer has this hash) |
| `GET /api/records/:id/editions[/:edition]`, `POST …/editions/:edition/pdf`                                                                              | editions of a document, PDF of an edition                                                                       |
| `GET /api/records/:id/changelog`, `GET /api/records/:id/reviews`                                                                                        | document changelog, reviews                                                                                     |
| `POST /api/records/:id/review` `{ outcome: no_change \| needs_update, comment }`                                                                        | periodic review                                                                                                 |
| `PUT /api/records/:id/review-settings` `{ reviewOwner?, intervalMonths?, nextReviewAt? }`                                                               | review owner, interval, earlier date                                                                            |
| `POST /api/records/:id/revise` `{ comment }`                                                                                                            | new revision                                                                                                    |
| `POST /api/records/:id/comments` `{ text }`                                                                                                             | comment                                                                                                         |
| `POST/DELETE /api/records/:id/links[/:linkId]` `{ kind, id, note }` or `{ url, label, note }`                                                           | links                                                                                                           |
| `POST /api/records/:id/attachments` (multipart `file`), `DELETE …/:attId`, `GET …/:attId/download`                                                      | attachments                                                                                                     |
| `POST /api/records/:id/pdf` `{ lang, timeZone, signers: [{ name, role, email? }] }`                                                                     | generate a PDF                                                                                                  |
| `POST /api/records/:id/signed[?plain=1]` (multipart `file`)                                                                                             | upload a signed PDF                                                                                             |
| `GET /api/records/:id/export`                                                                                                                           | Markdown                                                                                                        |
| `POST /api/records/import` `{ files: [{ filename, content }], type?, dryRun? }`                                                                         | import (preview with `dryRun`)                                                                                  |
| `GET /api/record-types`, `POST`, `PUT /api/record-types/:id`                                                                                            | types (admin for changes)                                                                                       |
| `GET /api/link-targets?kind=&q=`, `GET /api/backlinks?kind=&id=`                                                                                        | link picker, backlinks                                                                                          |
| `GET/POST /api/services`, `GET/PUT /api/services/:id`, `POST /api/services/:id/archive` `{ archived }`, `POST/DELETE /api/services/:id/links[/:linkId]` | service catalogue                                                                                               |

Public read-only API (`/api/v1`, API token, see [API.md](API.md)): `GET /records` (filters `type`, `status`, `tag`, `q`, `workflow`, `reviewStatus`; documents carry `edition`, `reviewStatus`, `nextReviewAt`), `GET /records/{recordId}` (id or number; content, fields, hashes, attachments, links, history; documents: `document` with the current edition and the review status), `GET /records/{recordId}/versions`, `GET /records/{recordId}/editions`, `GET /records/{recordId}/editions/{edition}`, `GET /records/{recordId}/reviews`.

## Service catalogue

_Services_ lists the services your team runs. A service has:

- a name and a description (Markdown);
- contacts: e-mail addresses of the **business owner** and **IT operations** (and more if needed);
- **responsible in Steward**: users and teams (`user:dana`, `team:service desk`) who may edit it in addition to designers and administrators;
- an optional **criticality**: low, medium, high, critical;
- the **CMDB entry**: system (e.g. _ServiceNow_), ID and a link that opens the entry;
- tags and links to platforms, monitors, processes, dashboards, runs and records.

Keep the real configuration data in your CMDB and link to it. Steward only keeps what it needs to connect its own items to a service.

To create one: _Services → New service_ (designers and administrators), fill in the form, _Save_. On the service page, _Add link_ connects platforms, monitors and so on; records that name the service (e.g. a change request with the note _affected_) appear under _Linked from_, and the record shows the service the same way.

Services are archived, not deleted (_Archive_ on the service page). Archived services disappear from the list and the link picker; their links and history stay. _Show archived services_ lists them, and _Restore_ brings one back.
