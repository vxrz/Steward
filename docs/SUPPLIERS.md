# Suppliers

_Catalogue → Suppliers_ (German _Lieferanten_) is where a service team keeps the companies that run, back up, patch and recover what its services use: SaaS providers, managed platforms, software vendors, support and service providers. Each supplier has its contracts with notice dates, SLA and contractual RTO/RPO, its certificates with their validity, its contacts – and shows what links it. It is the evidence ISO/IEC 27001 asks for in A.5.19–A.5.22 (supplier relationships), decided in [ADR 0029](adr/0029-iso-27001-support.md).

Steward keeps the records and reminds you of dates. It is not a GRC tool: no supplier questionnaires, assessments or risk scores ([ROADMAP.md](ROADMAP.md#non-goals)).

- [What a supplier holds](#what-a-supplier-holds)
- [Contracts and the notice-by date](#contracts-and-the-notice-by-date)
- [Certificates and reports](#certificates-and-reports)
- [Contacts and data protection](#contacts-and-data-protection)
- [Linking a supplier](#linking-a-supplier)
- [After the update: suppliers to confirm](#after-the-update-suppliers-to-confirm)
- [The yearly supplier review](#the-yearly-supplier-review)
- [Reminders](#reminders)
- [Who may do what](#who-may-do-what)
- [Audit, API, MCP and the dataset](#audit-api-mcp-and-the-dataset)
- [Limits](#limits)

## What a supplier holds

- **Name** and **type**: SaaS, managed platform, software vendor, support or service provider, other. Names are unique (letter case aside, archived suppliers left out); when a supplier you may not see has the name, Steward says only that the name cannot be used, without naming or linking that supplier.
- **Description** and **website**.
- **Owners**: Steward users and teams (`user:dana`, `team:service desk`), like systems. They change the supplier and get its reminders.
- **Data processing**: whether the supplier processes personal data for your services and, if so, the **data processing agreement** – _in place_ (since when, and the document) or _missing_.
- **Criticality** (shown, not stored): the highest protection need per dimension of the applications that link the supplier ([APPLICATIONS.md](APPLICATIONS.md#rate-an-application-cia)).
- **Other spellings**: the free-text vendors it was made from or merged with, and its former names. The supplier picker of the forms finds a supplier by them.
- **Status**: _active_; _to confirm_ (made from free text on the update, see [below](#after-the-update-suppliers-to-confirm)); _archived_ (kept for its history and the items that still link it, no longer offered in forms).

The list shows the next notice-by date and the next certificate expiry of each supplier, in orange within 90 days and in red once passed, and how many items link it. A supplier owned by a team is seen only by its members, its owners, administrators and auditors – as for systems ([TEAMS.md](TEAMS.md)).

## Contracts and the notice-by date

A contract has a title, the contract number, start and end, the **notice period** in days and the **renewal**:

- _automatic_: it renews by the given months unless someone gives notice;
- _by agreement_: both sides agree on a renewal;
- _fixed end_: it ends.

Steward derives the **notice-by date** – the last day to give notice – from the end of the current term minus the notice period. For an automatic renewal whose notice date has passed, the next term counts: a contract ending on 31 January 2027 with 90 days' notice and a 12-month renewal has, on 10 November 2026, the notice-by date 2 November 2027 (term end 31 January 2028). Dates are calendar dates in the instance's time zone, as for cost plans.

The contract also holds its document (an http(s) link, or the number of a document in Steward such as `DOC-2026-0004`, shown as a link for readers who may open it), a note and its **SLA**: availability target (%), support hours, response times, and the contractual **RTO** and **RPO** in hours. The [responsibility matrix](COMPLIANCE.md#responsibility-matrix) of a service reads these values from the contract its area names, with the supplier's valid certificates – read, never copied.

A **cost plan line** can name the supplier and the contract it pays for ([COSTS.md](COSTS.md#planning-per-service)); the contract lists the lines that pay for it. Removing a contract keeps the lines' supplier.

## Certificates and reports

Kind (ISO/IEC 27001, 27017, 27018, ISO 22301, SOC 2 type I or II, C5, TISAX, other with a name), scope, issuer, issued, **valid until** and the document (link or document number). For a SOC 2 report, _issued_ is the end of its period and _valid until_ defaults to twelve months later; enter another date to override it. Tick _I looked at it now_ when you save, and the certificate shows who looked at it and when.

## Contacts and data protection

Contacts are people at the supplier: name, role (account manager, support, security contact, data protection officer, other), e-mail, phone and a note. They are personal data of people outside Steward:

- the app shows them to everyone who may see the supplier, in a signed-in session;
- the public API, MCP, the dataset, exports and any request with an API token leave out their e-mail and phone (name, role and note only);
- audit entries name the contact and say which fields changed, never the e-mail or phone values;
- removing a contact deletes it.

Owners, creators and who looked at a certificate are Steward users: they appear in a person's data export and stay as history after pseudonymisation ([PRIVACY.md](PRIVACY.md)).

## Linking a supplier

Applications, systems, ticket references, page watches of changedetection.io and cost plan lines each had a free-text vendor field. They now have a **supplier picker** with _New supplier_ (designers and administrators). The free text stays as a fallback: it is shown where no supplier is linked and the API keeps accepting it. Saving a form keeps a linked supplier you may not see. An archived supplier stays linked but cannot be chosen again.

The supplier page lists under _Used by_ every item that links it and that you may see – also the areas of a service's [responsibility matrix](COMPLIANCE.md#responsibility-matrix), the rows of a [statement of applicability](COMPLIANCE.md#statement-of-applicability) and the [corrective action](COMPLIANCE.md#corrective-actions) findings that name it – and a service duty can name the supplier it reviews ([below](#the-yearly-supplier-review)).

API fields: `supplierId` in the internal routes of applications, systems, ticket references, page watches (`PUT /api/changedetection/:platformId/watches/:uuid/link`), cost plan lines (with `supplierContractId`) and duties – missing keeps the link, `null` clears it. The public API shows `supplier` (id, name, status) on applications, systems, ticket references, duties and cost plan lines.

## After the update: suppliers to confirm

On the update to 0.17, Steward turns the free-text vendors into suppliers, once, when the vault is unlocked (and again after a migration package is imported):

1. Each distinct text is normalised – letters and digits, legal forms left out (`Zentrova Cloud GmbH`, `zentrova cloud` and `Zentrova-Cloud` are the same) – as the security advisories compare vendors ([ADVISORIES.md](ADVISORIES.md)).
2. Each normalised text becomes one supplier with status _to confirm_; the most frequent spelling is its name, the others are its spellings. A text that matches an existing supplier links to it.
3. The rows are linked; their text stays.
4. Each text is recorded per table with its outcome, so it is handled once. A text without letters or digits besides legal forms (`GmbH`) stays text. A text written after the update becomes a supplier to confirm the next time Steward starts.

_Suppliers → To confirm_ lists them with their spellings and how many items link them. Designers and administrators work through it once:

- **Confirm** a real supplier – it becomes active.
- **Merge into …** another supplier: its links (also in responsibility matrices, statements of applicability and corrective action findings), contacts, contracts, certificates and spellings move, and it goes.
- **Not a supplier** (`On-premises`, an AWS account name): the supplier goes, the items lose the link and keep their text, and the text is not made a supplier again. A responsibility matrix area or a statement row that named it keeps the party _supplier_ without a name.

Summaries, reminders and the dataset leave unconfirmed suppliers out. Confirming, merging, marking _not a supplier_ and archiving are decisions of people: they need a signed-in session, not an API token.

## The yearly supplier review

A service duty can name a supplier ([DUTIES.md](DUTIES.md)): _Service → Duties → New duty_, choose the supplier, interval _yearly_, level _mandatory_. The example process _Supplier review (manual procedure)_ (`examples/processes/96-supplier-review.yaml`, _Processes → From template_) walks through certificates and audit reports, SLA reports, the data processing agreement, the contract's notice date and open findings as manual steps with evidence files and a second person's verification ([MANUAL-STEPS.md](MANUAL-STEPS.md)). The supplier page shows the duty and its last periods.

**Findings.** With the Compliance module on, the supplier page lists the open [corrective action](COMPLIANCE.md#corrective-actions) findings about the supplier. _Record a finding_ (for who may record findings) opens the finding form with the supplier and the source _supplier review_ filled in; any finding can name a supplier you may see. Steward also **suggests** findings of supplier reviews (the source _Supplier reviews_, on by default): a certificate of a confirmed supplier in use that ran out, and a missed or failed period of a duty that reviews a supplier – a person confirms or dismisses each one ([COMPLIANCE.md](COMPLIANCE.md#suggestions)).

The [ISMS summary](COMPLIANCE.md#isms-summary) of scheduled reports lists the certificates and notice-by dates of confirmed suppliers and the supplier reviews done, late or missed in its period, and [scheduled exports](EXPORTS.md) can write the suppliers with their contracts and certificates as CSV – contacts without e-mail or phone.

## Reminders

The owners of an active supplier (without owners: the administrators) are reminded 90 and 30 days before a certificate runs out (event `supplier.certificate_expiring`) and before a notice-by date (`supplier.notice_due`), once per date and threshold – a renewed certificate or a contract that rolled on arms the reminders again; thresholds that passed already count as sent. The daily summary lists certificates and notice-by dates of your suppliers in the next 90 days and those passed in the last 30 (section _Supplier certificates and notice dates_). See [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Who may do what

| Action                                                           | Who                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| See suppliers, contracts, certificates and contacts              | everyone who can sign in (team scope as for systems) |
| Create suppliers; confirm, merge, mark _not a supplier_; archive | designers, administrators                            |
| Change a supplier, its contacts, contracts and certificates      | designers, administrators, the supplier's owners     |
| Link a supplier to an item                                       | whoever may change the item and may see the supplier |
| Owning teams of a supplier                                       | administrators ([TEAMS.md](TEAMS.md))                |

## Audit, API, MCP and the dataset

**Audit actions:** `supplier.created`, `.changed`, `.archived`, `.unarchived`, `.confirmed`, `.merged`, `.dismissed` (not a supplier), `.migrated` (system, the update), `.contact_added|changed|removed` (without e-mail or phone values), `.contract_added|changed|removed`, `.certificate_added|changed|removed`.

**Public API** (read-only, [API.md](API.md)): `GET /api/v1/suppliers` (paged; default unconfirmed and active, `?status=`) and `GET /api/v1/suppliers/{supplierId}` – contracts with notice-by date, SLA and RTO/RPO, certificates, contacts without e-mail or phone, what links the supplier and its review duties.

**MCP** ([MCP.md](MCP.md)): `list_suppliers` and `get_supplier`, read-only, with your rights.

**Dataset** _Suppliers: expiring_ (`suppliers.expiring`): one row per certificate and notice-by date of an active supplier in the next 90 days or passed in the last 30, with status _warning_ within 30 days and _serious_ once passed; administrators and auditors, published at most hourly ([DASHBOARDS.md](DASHBOARDS.md)).

Writes are only in the app: every changing route – also marking a certificate as looked at – needs a signed-in session and refuses API tokens (ADR 0029 decision 9). Reading one supplier through the internal route with an API token gives what the public API gives: contacts without e-mail or phone. Internal routes: `GET|POST /api/suppliers[?status=]`, `GET /api/suppliers/options`, `GET|PUT /api/suppliers/:id`, `POST /api/suppliers/:id/archive|confirm|merge|not-a-supplier`, `POST /api/suppliers/:id/contacts|contracts|certificates`, `PUT|DELETE …/:itemId`.

Suppliers and their contracts, certificates and contacts move with migration packages ([MIGRATION.md](MIGRATION.md)); the reminders sent do not.

## Limits

2,000 suppliers (not counting archived ones); per supplier 20 contacts, 50 contracts, 20 certificates and 50 spellings.
