# Suppliers

_Catalogue → Suppliers_ (German _Lieferanten_) is where a service team keeps the companies that run, back up, patch and recover what its services use: SaaS providers, managed platforms, software vendors, support and service providers. Each supplier has its contracts with notice dates, SLA and contractual RTO/RPO, its certificates with their validity, its contacts – and shows what links it. It is the evidence ISO/IEC 27001 asks for in A.5.19–A.5.22 (supplier relationships), decided in [ADR 0029](adr/0029-iso-27001-support.md).

Steward keeps the records and reminds you of dates. It is not a GRC tool: no supplier questionnaires, assessments or risk scores ([ROADMAP.md](ROADMAP.md#non-goals)).

- [What a supplier holds](#what-a-supplier-holds)
- [Contracts and the notice-by date](#contracts-and-the-notice-by-date)
- [Contracts and the services they cover](#contracts-and-the-services-they-cover)
- [Master agreements and order forms](#master-agreements-and-order-forms)
- [Data protection per contract](#data-protection-per-contract)
- [Certificates and reports](#certificates-and-reports)
- [Contacts and data protection](#contacts-and-data-protection)
- [Linking a supplier](#linking-a-supplier)
- [After the update: suppliers to confirm](#after-the-update-suppliers-to-confirm)
- [After the update to 0.18: contracts with owners](#after-the-update-to-018-contracts-with-owners)
- [Shared suppliers: merging and opening](#shared-suppliers-merging-and-opening)
- [The yearly supplier review](#the-yearly-supplier-review)
- [Reminders](#reminders)
- [Who may do what](#who-may-do-what)
- [Audit, API, MCP and the dataset](#audit-api-mcp-and-the-dataset)
- [Try it in the demo](#try-it-in-the-demo)
- [Limits](#limits)

## What a supplier holds

- **Name** and **type**: SaaS, managed platform, software vendor, support or service provider, other. Names are unique (letter case aside, archived suppliers left out); when a supplier you may not see has the name, Steward says only that the name cannot be used, without naming or linking that supplier.
- **Description** and **website**.
- **Owners**: Steward users and teams (`user:dana`, `team:service desk`), like systems. They maintain the company record – the supplier, its certificates and company-wide contacts – may add contracts and get the certificate reminders. Since 0.18.0 owning a supplier does **not** show its contracts: those belong to the teams that hold them ([below](#contracts-and-the-services-they-cover)). An owner from outside the supplier's owning teams – and a contract owner from outside the teams among the contract's owners (else the supplier's) – sees and changes it: the form says so, and saving asks for the step-up ([TEAMS.md](TEAMS.md#named-owners-and-responsibles)).
- **Data processing**: whether the supplier processes personal data for your services and, if so, the **data processing agreement** – _in place_ (since when, and the document) or _missing_. Since 0.18.0 these are the **default for contracts** (_Default for contracts_ in the form): a DPA signed for the whole company is entered once, and each contract can answer for itself ([below](#data-protection-per-contract)).
- **Criticality** (shown, not stored): the highest protection need per dimension of the applications that link the supplier ([APPLICATIONS.md](APPLICATIONS.md#rate-an-application-cia)) and – since 0.18.0 – of the services covered by the contracts you may see ([APPLICATIONS.md](APPLICATIONS.md#the-protection-need-of-a-service)).
- **Other spellings**: the free-text vendors it was made from or merged with, and its former names. The supplier picker of the forms finds a supplier by them.
- **Status**: _active_; _to confirm_ (made from free text on the update, see [below](#after-the-update-suppliers-to-confirm)); _archived_ (kept for its history and the items that still link it, no longer offered in forms).

**New suppliers belong to the whole instance** (0.18.0): they get no owning team, whoever creates them – the company record is shared, while each team holds its own contracts ([TEAMS.md](TEAMS.md#new-resources)). Suppliers made by the 0.17 update keep their team scope; an administrator can open one to the whole instance or merge it into a shared supplier ([below](#shared-suppliers-merging-and-opening)).

The list shows the next notice-by date (over the contracts you may see) and the next certificate expiry of each supplier, in orange within 90 days and in red once passed, and how many items link it. A supplier owned by a team is seen only by its members, its owners, administrators and auditors – as for systems ([TEAMS.md](TEAMS.md)).

**The supplier page** (0.18.0) has the tabs **Overview** (company data, owners, owning teams, personal data and DPA as the default for contracts, criticality, review duties, open findings), **Contracts** (master agreements with their order forms indented; per contract the services it covers with their purposes, owners, term end, notice-by date, DPA state and _To confirm_ on proposed services; filters _Mine_ and _Covering services I edit_; the payments and what they owe, with the Costs module), **Services** (the services covered by contracts you may see, with purposes, and those that use the supplier through applications or systems without a contract – _No contract for this service_), **Contacts** (company-wide first, then the scoped ones with what they apply to), **Certificates** and **Used by**. Each contract has **its own page** (`/suppliers/:id/contracts/:contractId`, 404 for who may not see it): services and purpose, owners and visibility (who sees it and why), term and notice, SLA (inherited values in grey), data protection, payments (Costs module), contacts, reviews and findings.

**The service page** lists under **Suppliers** the contracts covering the service – supplier, contract, purpose, owners, term end, notice-by date, SLA with RTO/RPO, DPA state – with _Confirm_ and _Not this service_ on proposed ones and _Leave contract_; _Add contract_ (choose a supplier – the new contract covers the service) and _Add to a contract_ (contracts you may change); and the suppliers its applications and systems link without a contract covering the service. The _Supplier_ panel of an application or system lists the contacts scoped to it.

## Contracts and the notice-by date

A contract has a title, the contract number, start and end, the **notice period** in days and the **renewal**:

- _automatic_: it renews by the given months unless someone gives notice;
- _by agreement_: both sides agree on a renewal;
- _fixed end_: it ends.

Steward derives the **notice-by date** – the last day to give notice – from the end of the current term minus the notice period. For an automatic renewal whose notice date has passed, the next term counts: a contract ending on 31 January 2027 with 90 days' notice and a 12-month renewal has, on 10 November 2026, the notice-by date 2 November 2027 (term end 31 January 2028). Dates are calendar dates in the instance's time zone, as for cost plans.

The contract also holds its document (an http(s) link, or the number of a document in Steward such as `DOC-2026-0004`, shown as a link for readers who may open it), a note and its **SLA**: availability target (%), support hours, response times, and the contractual **RTO** and **RPO** in hours. The [responsibility matrix](COMPLIANCE.md#responsibility-matrix) of a service reads these values from the contract its area names, with the supplier's valid certificates – read, never copied.

A **cost plan line** and, since 0.18.0, a **cost entry** can name the supplier and the contract it pays for ([COSTS.md](COSTS.md#planning-per-service)); the contract lists the lines that pay for it. Removing a contract keeps the lines' and entries' supplier.

**Payments** (0.18.0, Costs module, [ADR 0030](adr/0030-contract-payments-and-recorded-costs.md)): a contract can carry **payment schedules** – per paying service the billing (monthly, quarterly, yearly, once or dated payments), the amount per payment with amounts per contract year, start and end (default: the contract's; an automatic renewal runs on term by term). Steward proposes each fiscal year's plan lines from them, a person confirms them, and the plan shows _Contract changed_ when the contract changes later ([COSTS.md](COSTS.md#contract-payments-and-commitments)). Who may change the contract adds and changes them, and so may who edits the paying service and sees the supplier. The supplier page shows per contract its schedules (services you may see) and what they still owe – to contract end and to the earliest exit – the supplier's total per currency, and what was incurred per fiscal year from entries that name it. Removing a contract removes its schedules (the dialog names the paying services); merging suppliers moves them with their contracts; archiving keeps them – the money is still owed. `GET /api/v1/suppliers/{supplierId}` lists them per contract as `paymentSchedules`.

## Contracts and the services they cover

Since 0.18.0 a contract has a scope of its own ([ADR 0031](adr/0031-supplier-contracts-and-contacts-scope.md)): one company can be shared by several services, each under its own contract held by its own team. The invented example: _Invented Shared Platform AG_ hosts the online shop's clusters under a contract of the shop team, and sells 40 agent licences to customer care under a contract of the care team – one supplier, two contracts, and each team sees only its own.

- **Services covered**: one or more services, each with a short **purpose** (_Hosting of the shop's clusters_, _Licences for 40 agents_; up to 200 characters). A contract without services is allowed – a company-wide agreement.
- **What it is for** (0.19.0, [ADR 0032](adr/0032-cost-attribution-platform-plans.md)): per covered service, optionally the **applications of that service and the systems they run on** that the contract is for (_Applications and systems_ in the purpose dialog; at most 50). None: the service as a whole. Only what you may see can be chosen; items you may not see stay when you save. The application's and the system's page show the contract under _Costs and contracts_ ([COSTS.md](COSTS.md#costs-and-contracts-of-an-application-or-system)).
- **Platforms covered** (0.19.0): a platform team's own contract – a data platform's capacity, a cloud spend commitment, a streaming subscription – covers one or more **platforms**, each with a purpose (at most 20). Its payment schedules can be paid by the platform; the platform's own cost plan gets the lines ([COSTS.md](COSTS.md#planning-per-platform)). The platform's _Cost plan_ tab lists the contracts covering it.
- **Owners**: users and teams (`user:dana`, `team:orders`) who manage the contract and get its notice reminders. A new contract's owners default to the person who adds it and their teams for new resources ([TEAMS.md](TEAMS.md#new-resources)).

**Who sees a contract.** Only who may see its supplier, and of them:

- if **a team is among its owners** (a team-owned contract): the members of those teams, its user owners, whoever may see a service it covers, **who manages a platform it covers or is a member of that platform's owning teams** (0.19.0 – not everyone who may use the platform: platforms are shared by many teams, and the platform team's contract is the platform team's), administrators and auditors. Others see the supplier, but not the contract, its amounts or that it exists;
- otherwise (only user owners, or none): everyone who may see the supplier – as every contract was in 0.17.

The contract's page (_Suppliers → the supplier → a contract_, `/suppliers/:id/contracts/:contractId`) says under _Owners and visibility_ who sees it and why. Covered services you may not see are left out; the contract's owners and whoever may change it see _and 2 services you may not see_ – no names, no purposes, no amounts.

**Who may do what with a contract:**

| Action                                                                     | Who                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a contract                                                             | designers, administrators and the supplier's owners; whoever may edit a service the new contract covers – or manages a platform it covers – and may see the supplier                                                                                          |
| Change it (terms, SLA, owners, remove it)                                  | administrators; its owners; designers and the supplier's owners who may see it; editors of a covered service, or managers of a covered platform, who may see **every** service and platform it covers – otherwise read-only                                   |
| Add a covered platform (0.19.0)                                            | who may change the contract and may see that platform                                                                                                                                                                                                         |
| Change the purpose of a covered platform, _Take off the contract_          | who may change the contract, or who manages that platform (or is a member of its owning teams)                                                                                                                                                                |
| Add a covered service                                                      | who may change the contract and may see that service                                                                                                                                                                                                          |
| Change the purpose of a covered service, _Leave contract_                  | who may change the contract, or who may edit that service                                                                                                                                                                                                     |
| Confirm a proposed service, _Not this service_                             | who may change the contract, or who may edit that service                                                                                                                                                                                                     |
| Payment schedules ([COSTS.md](COSTS.md#contract-payments-and-commitments)) | who may change the contract, or who may edit the paying service (a paying platform: who may change its plan) and may see the contract; the payer must be covered – a schedule for another service or platform adds it when the person may change the contract |

- A change that leaves **no team among the owners** opens the contract to everyone who sees the supplier: the form says so and asks to confirm (`confirmOpen`). Owners need no step-up; the change is audited with before and after.
- **A deleted team stays among the owners** as an entry that matches nobody, like an entry of an access list: the contract stays restricted to administrators, auditors and the readers of the services it covers, and never opens because a team was deleted. Remove the entry on the contract to open it (asked first).
- **Adding a covered service is a decision of a person in a session.** Choosing a contract that does not cover the service on a plan line, an entry, a duty or a matrix row adds the service to it – with an API token that is refused (`SUPPLIER_CONTRACT_COVER_SESSION`); a contract covering the service can be linked with a token as before.
- **Covering a platform** lets its managers and the members of its owning teams see a team-owned contract: a decision of a person in a session, audited on the supplier (`supplier.contract_platform_added`, `…_changed`, `…_removed`). Covered platforms you may not see are counted for the owners and who may change the contract (_and 1 platform you may not see_), never named. The contract's page lists them under _Platforms covered_ and _Owners and visibility_ names them.
- A covered service – or platform – that pays a payment schedule of the contract cannot leave it until the schedule is moved or removed. Plan lines, matrix rows, duties and findings of the service that name the contract keep it and show _This contract no longer covers the service_.
- An archived service stays listed as covered (_archived_) and gives no rights.
- **Proposed services** (the update to 0.18, [below](#after-the-update-to-018-contracts-with-owners)) count for reading, not for changing, until a person confirms them or chooses _Not this service_.

**A contract you may not see**, named on a plan line, a cost entry or a responsibility matrix row you may see, shows as _a contract you may not see_ – no title, number, dates, SLA, RTO/RPO or amounts; the supplier as its own rule allows. Saving such a form keeps the link. The contract pickers offer the contracts covering the service first; choosing another contract of the supplier adds the service to it when you may change that contract, and is refused otherwise. _Used by_ lists such an item by its own rule, with the same neutral text.

## Master agreements and order forms

A contract can name one contract of the same supplier as its **master agreement** (German _Rahmenvertrag_; the contract is then an _order form_, _Einzelvertrag_) – **one level only**: a master has no master, an order form has no order forms. The supplier page lists each master with its order forms indented.

- An order form **inherits** the SLA (availability, support hours, response times), the contractual RTO and RPO, personal data and the data processing agreement while its own are empty; it does not inherit the term, notice period, renewal or document – order forms have their own. The contract shows inherited values in grey with _from the master agreement_; the matrix and the API read the values that apply (`inherited` names them).
- The order form's visibility is its own. Who sees the order form but not the master sees the inherited values (they are the order form's terms) and _part of a master agreement you may not see_ – not the master's title, number, services or amounts.
- **Removing a master** asks first: its order forms become standalone, with the values they inherited copied into them, so their terms do not change (`DELETE …/contracts/:contractId?orderForms=standalone`; audited with what was copied).
- An order form that ends after its master shows _Ends after the master agreement_ – a hint, not a block.

## Data protection per contract

Steward marks personal data on suppliers only – services and applications have no such mark (the CIA rating is a protection need, not a data category). Since 0.18.0 each contract says whether it **processes personal data for the services it covers** (_yes_, _no_, or _as the supplier_ – the default) and has its own **data processing agreement** (_in place_ since a date with the document, or _missing_), defaulting to its master's for an order form and then to the supplier's (order form → master → supplier).

**_DPA missing_** is flagged only for contracts whose answer that applies is _processes personal data_ and whose agreement that applies is _missing_ – on the contract, in the supplier list (_1 contract without a DPA_, over the contracts you may see) and on the service page. A supplier without contracts keeps the flag of its own fields, as in 0.17. Contracts of 0.17 start with _as the supplier_, so nothing changes meaning on the update.

## Certificates and reports

Kind (ISO/IEC 27001, 27017, 27018, ISO 22301, SOC 2 type I or II, C5, TISAX, other with a name), scope, issuer, issued, **valid until** and the document (link or document number). For a SOC 2 report, _issued_ is the end of its period and _valid until_ defaults to twelve months later; enter another date to override it. Tick _I looked at it now_ when you save, and the certificate shows who looked at it and when.

## Contacts and data protection

Contacts are people at the supplier: name, role (account manager, support, security contact, data protection officer, other), e-mail, phone and a note.

**Company-wide or scoped** (0.18.0, [ADR 0031](adr/0031-supplier-contracts-and-contacts-scope.md)): a contact is **company-wide** (the default, as in 0.17) or **scoped** to one or more contracts, applications or systems (_Applies to_, German _Gilt für_; at most 20 items) – the account manager of the hosting contract, the support line of one product, the security contact of one platform.

- A scoped contact is seen by who may see **one** of its items (and the supplier), administrators and auditors; others neither see it nor that it exists. It shows on the pages of its items – the contract, the application's and the system's _Suppliers_ panel – besides the supplier's _Contacts_ tab (company-wide first).
- **Who may change it:** a company-wide contact – who may change the supplier. A scoped contact – who may change the supplier, or who may change **every** item it is scoped to (a contract's owners add their account manager). Who may change only some of its items may take their own items off its scope (_Remove from my contract_) and nothing else. Items the person may not see are kept on save and shown as _and 1 item you may not see_ to who may change the contact.
- **A contact never becomes company-wide by losing its scope.** Taking off its last item is refused – remove the contact instead (asked first). When all its items are gone (a contract removed, a system deleted), it is shown only to the supplier's owners, administrators and auditors, marked _No longer in use_. A merge does not make one company-wide either ([below](#shared-suppliers-merging-and-opening)).

Contacts are personal data of people outside Steward:

- the app shows e-mail and phone in a signed-in session to who may see the contact;
- the public API, MCP, the dataset, exports and any request with an API token – every supplier and contract route, also the contract page – leave out their e-mail and phone (name, role and note only; since 0.18 the scope as the items the reader may see, and contacts none of whose items the reader may see are left out);
- audit entries name the contact, the fields that changed and its scope (kinds and ids), never the e-mail or phone values;
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
   - **Team scope:** a supplier is seen by no more people than the texts it is made from. A text of items owned by teams (an application or system, the service of a cost plan line, the platform of a page watch, a ticket reference – [TEAMS.md](TEAMS.md)) becomes a supplier owned by the same teams, seen by their members, administrators and auditors; texts of items of the whole instance become suppliers without owning teams. The same text in items of different teams becomes one supplier per set of teams – an administrator merges them. A text that matches an existing supplier takes its spellings there only from items of the whole instance.
3. The rows are linked; their text stays.
4. Each text is recorded per table with its outcome, so it is handled once. A text without letters or digits besides legal forms (`GmbH`) stays text. A text written after the update becomes a supplier to confirm the next time Steward starts.

_Suppliers → To confirm_ lists them with their spellings and how many items link them. Designers and administrators work through it once:

- **Confirm** a real supplier – it becomes active.
- **Merge into …** another supplier: its links (also in responsibility matrices, statements of applicability and corrective action findings), contacts, contracts, certificates and spellings move, and it goes. Since 0.18 by the rules of [shared suppliers](#shared-suppliers-merging-and-opening): a merge that would show anything to more people is for administrators, with a preview.
- **Not a supplier** (`On-premises`, an AWS account name): the supplier goes, the items lose the link and keep their text, and the text is not made a supplier again. A responsibility matrix area or a statement row that named it keeps the party _supplier_ without a name.

Summaries, reminders and the dataset leave unconfirmed suppliers out. Confirming, merging, marking _not a supplier_ and archiving are decisions of people: they need a signed-in session, not an API token.

## After the update to 0.18: contracts with owners

The update to 0.18.0 gives every contract a scope, in the migration itself (SQLite and PostgreSQL, no vault needed):

1. Every contract gets **its supplier's owners as its owners**.
2. **Covered services are proposed** from what already names the contract: the services of cost plan lines, cost entries and responsibility matrix rows that name it – each as _proposed_, with where it came from. The paying services of payment schedules are added as _confirmed_.
3. Contacts stay company-wide; personal data and the data processing agreement of contracts stay _as the supplier_.
4. Suppliers keep their owning teams.

Proposed services are confirmed or dismissed by a person – on the contract and on the service page's _Suppliers_ section. Dismissing one leaves the plan lines and matrix rows as they are, with the hint _This contract no longer covers the service_.

**What can narrow:** a contract whose supplier had a team among its owners becomes team-owned. Who saw it in 0.17 only through the supplier – and neither owns it nor sees a service it is proposed for – no longer sees it. The supplier list shows administrators _Contracts now seen only by their owners and services_ once (audited as `supplier.contracts_scoped`, system); removing the team owner reopens a contract. Nothing becomes visible to more people.

## Shared suppliers: merging and opening

The 0.17 update made one supplier per vendor text **and** set of owning teams, so as not to widen anyone's view – the same company used by two teams became two suppliers. Since 0.18.0 Steward suggests merging them into one shared supplier without showing anyone's contracts to another team.

**Same supplier in several teams** (_Suppliers → To confirm_, administrators): groups of active or unconfirmed suppliers with the same normalised name (or a spelling of one matching the other's name) and different owning teams. Each group proposes one shared supplier – the instance-wide one if there is one, else the confirmed one, else the oldest. _Merge…_ opens the preview; _Keep separate_ dismisses the group until another supplier joins it (audited as `supplier.merge_kept_separate`).

**The preview** – for any merge, and for opening a team-scoped supplier by changing its owning teams – lists before anything changes, and only what the person may see: contracts they may not read, contacts they may not see and scope items they may not see are neither named nor counted (as on the supplier page):

- who **gains sight of the company record** – name, certificates, company-wide contacts;
- who **loses sight** of a source – an instance-wide supplier, or one of other teams, merged into a team's supplier – and with it of the contracts they saw through it; a notice-by reminder whose owners can no longer see the contract goes to the administrators ([Reminders](#reminders));
- each **contract** with the owners it will have: a contract without a team owner gets the source's owning teams as owners, so it stays seen by exactly those teams (plus the readers of the services it covers, administrators and auditors); a contract with a team owner keeps its owners. Contracts with the same contract number are flagged – contracts are never merged automatically;
- each **company-wide contact** of the source with the scope it will get: the source's contracts; without contracts, the applications and systems that link the source; without those, the administrator chooses – _make it company-wide_ (a widening) or _remove it_;
- the source's **personal data and DPA**, written onto its moved contracts where they differ from the target's defaults, so no contract's answer changes;
- **certificates** that are the same (kind, scope and valid until) become one, keeping the latest _looked at_; **contacts** that are the same (name and e-mail, letter case aside) become one – two company-wide ones stay company-wide, two scoped ones get both scopes. A company-wide contact of a source is never combined into a scoped contact of the target (that would show the scoped contact's e-mail and phone to everyone): it stays a contact of its own;
- the **owners** of the shared supplier: the union of all owners, editable; and what moves – links, spellings, contracts with their payment schedules, the free-text migrations.

**Who:** a merge or an opening that changes who sees anything – to more people or to fewer – is for **administrators**; merging suppliers with the same owning teams stays with designers and administrators. A merge that shows a supplier to more people, and an opening that adds a team or removes every team, **grant access** and ask for the step-up (`grantAccess`, the control point _access.grant_ that cannot be switched off – [SECURITY-HARDENING.md](SECURITY-HARDENING.md#step-up-re-authentication)). One merge combines up to ten suppliers in one transaction, audited as `supplier.merged` with the contracts and the owners they got, the contacts and their scope, what was combined and the owning teams of the result; an opening is audited as `access.owning_teams_changed` with what was protected. Routes: `POST /api/suppliers/merge/preview` and `POST /api/suppliers/merge` (`{ intoId, ids, owners, contacts: { [id]: 'scope' | 'companyWide' | 'remove' } }`), `GET /api/suppliers/shared-suggestions`, `POST /api/suppliers/shared-suggestions/:key/keep-separate`, `POST /api/suppliers/:id/open/preview` and `…/open`. The supplier's _Owning teams_ panel opens the same preview, with the choice for contacts that cannot be scoped, and saves through `…/open`; `PUT /api/owning-teams/supplier/:id` and the bulk change `POST /api/owning-teams/bulk` apply the same protections (a contact that needs the choice stops a bulk change – the supplier's own panel asks for it).

**Replaced by …** To combine two contracts afterwards: _Remove contract_ → _Replaced by…_ another contract of the same supplier that you may change (`DELETE …/contracts/:contractId?replacedBy=`). Its covered services, payment schedules, plan lines, entries, matrix rows, duties, findings and scoped contacts move to it; covered services join only where you may add them (a schedule whose paying service cannot join is refused), and its order forms follow it. The removal is audited with `replacedBy` and what moved.

## The yearly supplier review

A service duty can name a supplier ([DUTIES.md](DUTIES.md)): _Service → Duties → New duty_, choose the supplier, interval _yearly_, level _mandatory_. Since 0.18.0 it can name **one of the supplier's contracts** that covers the duty's service instead (the form's _Contract_ picker) – a team reviews what it holds (`supplierContractId`; the contract page lists it under _Reviews and findings_). The example process _Supplier review (manual procedure)_ (`examples/processes/96-supplier-review.yaml`, _Processes → From template_) walks through certificates and audit reports, SLA reports, the data processing agreement, the contract's notice date and open findings as manual steps with evidence files and a second person's verification ([MANUAL-STEPS.md](MANUAL-STEPS.md)). The supplier page shows the duty and its last periods.

**Findings.** With the Compliance module on, the supplier page lists the open [corrective action](COMPLIANCE.md#corrective-actions) findings about the supplier. _Record a finding_ (for who may record findings) opens the finding form with the supplier and the source _supplier review_ filled in; any finding can name a supplier you may see, and since 0.18.0 one of its contracts – the contract's owners then read the finding and are proposed as owners of its first action. Steward also **suggests** findings of supplier reviews (the source _Supplier reviews_, on by default): a certificate of a confirmed supplier in use that ran out, and a missed or failed period of a duty that reviews a supplier – a person confirms or dismisses each one ([COMPLIANCE.md](COMPLIANCE.md#suggestions)).

The [ISMS summary](COMPLIANCE.md#isms-summary) of scheduled reports lists the certificates and notice-by dates of confirmed suppliers (contracts the schedule's owner may see), the contracts processing personal data without a DPA and the supplier reviews done, late or missed in its period, and [scheduled exports](EXPORTS.md) can write the suppliers with their contracts and certificates as CSV – contacts without e-mail or phone.

## Reminders

Steward reminds 90 and 30 days before a date, once per date and threshold – a renewed certificate or a contract that rolled on arms the reminders again; thresholds that passed already count as sent. Since 0.18.0 each date reaches who acts on it, each person once and only who may see what it is about:

- **Notice-by dates** (`supplier.notice_due`): the **contract's owners**; a contract without owners – the supplier's owners; without those, or when none of them may see the contract (a deleted team, a merge into another team's supplier) – the administrators.
- **Expiring certificates** (`supplier.certificate_expiring`): the supplier's owners **and the owners of every active contract** of the supplier (its term has not ended, it renews automatically, or it has no end); without any – the administrators.

The daily summary (section _Supplier certificates and notice dates_) lists, in the next 90 days and passed in the last 30, the notice-by dates of contracts you own (administrators also those whose reminders fall back to them) and the certificates of suppliers you own or hold an active contract with. See [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Who may do what

| Action                                                           | Who                                                                                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See suppliers, certificates and contacts                         | everyone who can sign in (team scope as for systems)                                                                                                                 |
| See a contract                                                   | who sees the supplier; a team-owned contract only its owners, readers of its services, administrators and auditors ([above](#contracts-and-the-services-they-cover)) |
| Create suppliers; confirm, merge, mark _not a supplier_; archive | designers, administrators (a merge of suppliers with other owning teams: administrators)                                                                             |
| Change a supplier, its contacts and certificates                 | designers, administrators, the supplier's owners                                                                                                                     |
| Add and change contracts                                         | see [the rights table](#contracts-and-the-services-they-cover)                                                                                                       |
| Link a supplier to an item                                       | whoever may change the item and may see the supplier                                                                                                                 |
| Owning teams of a supplier, _Same supplier in several teams_     | administrators ([TEAMS.md](TEAMS.md))                                                                                                                                |

## Audit, API, MCP and the dataset

**Audit actions:** `supplier.created`, `.changed`, `.archived`, `.unarchived`, `.confirmed`, `.merged` (since 0.18 with what was protected), `.merge_kept_separate`, `.dismissed` (not a supplier), `.migrated` (system, the update), `.contact_added|changed|removed` (with the scope since 0.18, without e-mail or phone values), `.contract_added|changed|removed` (since 0.18 with the owners, the master, personal data and the DPA before and after, and the order forms made standalone), `.contract_service_added|changed|removed|confirmed|dismissed` (on the supplier, naming the contract and the service; _removed_ is also _Leave contract_), `.contracts_scoped` (system, once, the update to 0.18), `.certificate_added|changed|removed`; since 0.19 `.contract_platform_added|changed|removed` (a covered platform) and `.contract_service_changed` also for the applications and systems a covered service names.

**Public API** (read-only, [API.md](API.md)): `GET /api/v1/suppliers` (paged; default unconfirmed and active, `?status=`) and `GET /api/v1/suppliers/{supplierId}` – the contracts the token owner may see with notice-by date, SLA and RTO/RPO (the values that apply, `inherited` naming those of the master), `owners`, `services` (id, name, purpose, status – the services the token owner may see, no count of others), `parentId`, `personalData` and `dpa` (as it applies, with `inheritedFrom`: `contract`, `master`, `supplier`), certificates, contacts without e-mail or phone, what links the supplier and its review duties. `GET /api/v1/services/{serviceId}/contracts` lists the contracts covering a service (0.18). Since 0.19 each contract also has `platforms` (id, name, purpose – those the token owner may see, no count) and each covered service its `items` (the applications and systems it is for).

**MCP** ([MCP.md](MCP.md)): `list_suppliers`, `get_supplier` and `list_service_contracts` (0.18), read-only, with your rights.

**Dataset** _Suppliers: expiring_ (`suppliers.expiring`): one row per certificate and notice-by date of an active supplier in the next 90 days or passed in the last 30, with status _warning_ within 30 days and _serious_ once passed; a notice-by date also names the contract's owners and the services it covers (0.18). Administrators and auditors, published at most hourly ([DASHBOARDS.md](DASHBOARDS.md)).

Writes are only in the app: every changing route – also marking a certificate as looked at – needs a signed-in session and refuses API tokens (ADR 0029 decision 9). Reading one supplier through the internal route with an API token gives what the public API gives: contacts without e-mail or phone. Internal routes: `GET|POST /api/suppliers[?status=]`, `GET /api/suppliers/options`, `GET|PUT /api/suppliers/:id`, `POST /api/suppliers/:id/archive|confirm|merge|not-a-supplier`, `POST /api/suppliers/:id/contacts|contracts|certificates`, `PUT|DELETE …/:itemId`; since 0.18 `GET /api/suppliers/:id/contracts/:contractId` (the contract page), contracts take `owners`, `services` (`[{ serviceId, purpose }]`, on create), `confirmOpen`, `parentId`, `personalData`, `dpaStatus`, `dpaSince` and `dpaLink` (null: inherited), `DELETE …/contracts/:contractId?orderForms=standalone` removes a master, `PUT|DELETE /api/suppliers/:id/contracts/:contractId/services/:serviceId` (`purpose`, `confirm: true`; leave or dismiss), contacts take `scope` (`[{ kind, id }]`), `GET /api/suppliers/scoped-contacts?kind=application|system&id=`, `GET /api/services/:id/contracts` and `GET|DELETE /api/suppliers/scope-notice` (the administrators' notice after the update); since 0.19 contracts take `platforms` (`[{ platformId, purpose }]`, on create) and `services[].items`, `PUT|DELETE /api/suppliers/:id/contracts/:contractId/platforms/:platformId` (`purpose`; take off), a covered service takes `items` (`[{ kind, id }]`), `GET /api/platforms/:id/contracts` (the contracts covering a platform) and `GET /api/services/:id/contract-items` (what a contract can name for the service).

Suppliers and their contracts, certificates and contacts move with migration packages ([MIGRATION.md](MIGRATION.md)); the reminders sent do not.

## Try it in the demo

With the demo services, _Catalogue → Suppliers_ holds the invented managed platform _Example Cloud GmbH_, shared by two services: its contract _Managed Kubernetes_ hosts the online shop's clusters and is held by the service desk team (open it: _Owners and visibility_ says who sees it and why), and customer care's agent licences are an order form of the _Platform framework agreement_ – its SLA and DPA come from the master agreement, shown in grey. The hosting contract's account manager is a contact scoped to that contract. Under _To confirm_, administrators find _Invented Relay Mail_ twice – once for the demo team _Mail relay team_ (set to take no new resources of its members), once for the whole instance – under _Same supplier in several teams_: open _Merge…_ to see the preview.

## Limits

2,000 suppliers (not counting archived ones); per supplier 100 contacts (20 before 0.18; a contact applies to at most 20 items), 200 contracts (50 before 0.18), 20 certificates and 50 spellings; per contract 50 covered services, 20 owners and a purpose of 200 characters.
