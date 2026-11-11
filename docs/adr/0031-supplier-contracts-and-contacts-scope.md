# 0031. Suppliers shared by services: contracts and contacts with their own scope

- **Status:** Accepted (owner decision 2026-11-11) and built in 0.18.0, after the parts of [ADR 0030](0030-contract-payments-and-recorded-costs.md) – the model and the answers to the open questions were set by the owner, each as recommended; the further questions are settled below (see _Decided (November 2026)_). What the build added or settled differently is listed under _Built in 0.18.0_
- **Date:** 2026-11-11
- **Since:** 0.18.0 ([ROADMAP.md](../ROADMAP.md#next))

## Context

Since 0.17.0 a supplier is one record ([ADR 0029](0029-iso-27001-support.md), [SUPPLIERS.md](../SUPPLIERS.md)): type, owners, owning teams, the data processing agreement, certificates, contacts and contracts. Everything hangs off the supplier:

- **Contracts have no scope of their own.** A contract has a term, a notice period, a renewal, SLA and contractual RTO/RPO – but no service, no owners and no visibility. Whoever sees the supplier sees every contract; whoever may change the supplier changes every contract; the notice-by reminders of every contract go to the supplier's owners.
- **One company, several purposes.** Real suppliers are shared: one vendor hosts service A and sells licences to service B, each under its own contract, held by a different team. Today the two teams either share one record and see (and change) each other's contracts, or keep two records of the same company with the certificates entered twice.
- **The upgrade made duplicates.** The 0.17 migration made one supplier per normalised vendor text _and_ set of owning teams, so as not to widen anyone's view ([ADR 0029](0029-iso-27001-support.md#changed-after-the-security-review-of-0170-november-2026), decision 4). The same company used by two teams is now two suppliers, waiting for an administrator to merge them – and merging today would show each team's contracts and contacts to the other.
- **Contacts are supplier-wide.** The account manager for the hosting contract, the support line of one product, the security contact for one platform: contacts are often about one contract, application or system, not the whole company.
- **Since ADR 0030** a contract carries payment schedules with a paying service each, and commitments are shown per service and supplier. The contract is becoming the thing teams manage, while the supplier stays the company.

The owner's boundaries are those of ADR 0029: Steward keeps the records and reminds of dates; it is not a GRC or procurement tool. No product catalogue, no supplier portal, no questionnaires.

## Decision

**The supplier is the shared company record – certificates, company-wide contacts, the company's data – and is seen by the whole instance unless an administrator restricts it. A contract gets its own scope: the services it covers (each with a purpose), its owners, and a visibility of its own. Data protection is decided per contract, a contract can belong to one master agreement, and a contact can be scoped to contracts, applications or systems.** Suppliers stay core (_Catalogue_); payment schedules and commitments stay in the Costs module.

Code: `shared/src/suppliers.ts` (contract inputs, the inheritance of SLA and data protection, the pure visibility rule `contractReaders`), `server/src/suppliers/service.ts` (contracts, contacts, rights), new `server/src/suppliers/contract-scope.ts` (covered services, proposals, the visibility of contracts and contacts in bulk – one query per table, like `detailsOf`), new `server/src/suppliers/shared.ts` (merge suggestions, the merge and opening preview), `server/src/suppliers/jobs.ts` (recipients), `server/src/suppliers/migrate.ts`; `server/src/compliance/responsibilities.ts` and `corrective.ts` (the contract named), `server/src/costs/schedules.ts` and `commitments.ts` of ADR 0030 (the paying service is a covered service; contracts read through `contractVisible`); web `web/src/pages/SupplierDetail.tsx` (tabs), new `SupplierContract.tsx`, `web/src/components/suppliers/ContractServices.tsx`, `ScopedContacts.tsx`, `SharedSuppliers.tsx`, and the service page's section `ServiceSuppliers.tsx`.

### 1. The supplier: one shared company record

- The supplier holds what is true of the company: name, type, description, website, other spellings, owners, certificates, company-wide contacts, the **default** for personal data and the data processing agreement, the derived criticality.
- **New suppliers are instance-wide.** They get no owning team, whoever creates them – suppliers are an exception to the rule for new resources of [TEAMS.md](../TEAMS.md#new-resources), and the team setting _New resources_ does not apply to them. An administrator can still restrict a supplier to teams on its _Owning teams_ panel.
- **Suppliers made by the 0.17 migration keep their team scope.** An administrator can open one to the whole instance or merge it into a shared supplier (part 8); both protect its contracts and contacts.
- The supplier's **owners** maintain the company record: they change it, its certificates and its company-wide contacts, may add contracts, and get the certificate reminders. Owning a supplier does **not** show its contracts – those belong to the teams that hold them (part 2).
- The derived **criticality** also takes the protection need of the services covered by the contracts the reader may see ([APPLICATIONS.md](../APPLICATIONS.md#the-protection-need-of-a-service)), besides the applications that link the supplier.

### 2. Contracts with their own scope

A contract gets, besides its 0.17 fields:

| Field              | What                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Services covered   | One or more services, each with a short **purpose** (_Hosting of the shop's clusters_, _Licences for 40 agents_; up to 200 characters). A contract without services is allowed – a company-wide agreement, or a master whose order forms cover services |
| Owners             | Users and teams (`user:dana`, `team:orders`) who manage the contract and get its notice reminders. Default for a new contract: the creator and the creator's teams for new resources ([TEAMS.md](../TEAMS.md#new-resources))                            |
| Master agreement   | Optionally one contract of the same supplier it belongs to (part 3)                                                                                                                                                                                     |
| Personal data, DPA | Whether the contract processes personal data for the services it covers, and its data processing agreement – default: the supplier's (part 5)                                                                                                           |

**Who sees a contract.** Only who may see its supplier, and of them:

- if **a team is among its owners** (a team-owned contract): the members of those teams, its user owners, whoever may see a service it covers (readers and editors), administrators and auditors – others see the supplier but not the contract, its amounts or that it exists;
- otherwise (only user owners, or none): everyone who may see the supplier – as every contract was in 0.17, and as a resource without owning teams behaves ([TEAMS.md](../TEAMS.md)).

A covered service whose coverage is still **proposed** (the upgrade, part 9) counts for reading, so nobody loses sight of a contract their service pays for before a person decides.

**Covered services the reader may not see** are left out. The contract's owners and whoever may change it see _and 2 services you may not see_ – no names, no purposes, no amounts – because managing a shared contract needs to know that it is shared; other readers see nothing of them.

**Who may do what:**

| Action                                                                                  | Who                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a contract for a supplier                                                        | designers, administrators and the supplier's owners; whoever may edit a service the new contract covers and may see the supplier                                                    |
| Change a contract (terms, SLA, data protection, document, master, owners, remove it)    | administrators; its owners; designers and the supplier's owners who may see it; editors of a covered service who may see **every** service it covers – otherwise read-only          |
| Add a covered service                                                                   | who may change the contract and may see that service (the picker offers only those)                                                                                                 |
| Change the purpose of a covered service, remove it from the contract (_Leave contract_) | who may change the contract, or who may edit that service                                                                                                                           |
| Confirm or dismiss a proposed service                                                   | who may change the contract, or who may edit that service                                                                                                                           |
| Payment schedules ([ADR 0030](0030-contract-payments-and-recorded-costs.md))            | who may change the contract, or who may edit the paying service and may see the contract; the paying service must be covered – a schedule for another service adds it, when allowed |

- A change that leaves **no team among the owners** opens the contract to everyone who sees the supplier; the form says so and asks to confirm. Changing owners needs no step-up (it widens nothing beyond the supplier's readers), and is audited with before and after.
- Removing a covered service that is the paying service of a schedule is refused until the schedule is moved or removed (the dialog lists them). Plan lines, matrix rows, duties and findings of that service that name the contract keep it and show _This contract no longer covers the service_.
- An archived service stays listed as covered (_archived_) and gives no rights.
- All writes need a signed-in session (ADR 0029 decision 9).

### 3. Shared and framework contracts

- **A contract shared by several services lists all of them**, each with its purpose. Its costs are split by ADR 0030's payment schedules – one paying service per schedule, each with its own amount; no shares, no splitting rules.
- **Amounts follow both visibilities.** In a service's cost plan, its schedules and their amounts show as ADR 0030 decided (the service's _Hide amounts from viewers_). On the supplier page, on the contract and in _Costs → Commitments_ grouped by supplier, a schedule shows only when the reader may see the contract **and** its paying service – schedules of services the reader may not see are neither named nor counted, also for the contract's owners.
- **Master agreement and order forms** (German _Rahmenvertrag_, _Einzelvertrag_): a contract can name one contract of the same supplier as its master – **one level only**: a master has no master, an order form has no order forms. An order form **inherits** the SLA (availability, support hours, response times), the contractual RTO and RPO, personal data and the data processing agreement when its own are empty; it does not inherit the term, notice period, renewal or document – order forms have their own. The contract shows inherited values in grey with _from the master agreement_.
- The order form's visibility is its own. A reader who sees the order form but not the master sees the inherited values (they are the order form's terms) and _part of a master agreement you may not see_, not the master's title, number, services or amounts.
- **Removing a master** asks first: its order forms become standalone, with the values they inherited copied into them, so their terms do not change.
- An order form that ends after its master shows _Ends after the master agreement_ – a hint, not a block.

### 4. Who sees a hidden contract named elsewhere

A contract is named in several places. Wherever the reader may see the place but not the contract, it shows **_a contract you may not see_** (_ein Vertrag, den Sie nicht sehen dürfen_) – no title, number, dates, SLA, RTO/RPO or amounts; the supplier is shown as the supplier's own rule allows. Saving such a form keeps the link (like a supplier you may not see, ADR 0029).

- **Responsibility matrix** ([COMPLIANCE.md](../COMPLIANCE.md#responsibility-matrix)): the contract picker of a service's area offers the contracts covering that service; choosing another visible contract of the supplier adds the service to it when the person may (else it is refused). A row naming a contract the reader may not see shows the neutral text without its values; the supplier's valid certificates stay.
- **Cost plan lines and cost entries** naming a contract: the same; the contract picker offers contracts covering the service.
- **Duties and corrective action findings** naming a contract (part 7): the same.
- **Statement of applicability**: rows name a supplier, not a contract – the statement is the organisation's; contract detail lives in the matrix. Versions and their signed files are unchanged.
- **_Used by_** on the supplier page: an item that names a hidden contract is listed by its own rule and says _a contract you may not see_.
- **Search, backlinks, start page, daily summary, reports** list a contract only for who may see it.

### 5. Data protection per contract

- Steward marks personal data on **suppliers** only (`suppliers.personal_data`); services and applications have no such mark – the CIA rating is a protection need, not a data category. So the question moves to where it is true: each contract says whether it **processes personal data for the services it covers** (_yes_, _no_, or _as the supplier_ – the default), and has its own **data processing agreement** (_in place_ since a date with the document, or _missing_), defaulting to the supplier's, then to its master's for an order form (order form → master → supplier).
- The supplier's own fields become the **company-wide default** (_Default for contracts_ in the form): a DPA signed for the whole company is entered once.
- **_DPA missing_** is flagged only for contracts whose effective answer is _processes personal data_ and whose effective DPA is _missing_ – on the contract, in the supplier list (_1 contract without a DPA_, counted over the contracts the reader may see), on the service page and in the supplier review. A supplier with no contracts keeps the 0.17 flag of its own fields.

### 6. Contacts with a scope

- A contact is **company-wide** (the default, as in 0.17) or **scoped** to one or more contracts, applications or systems (_Applies to_; German _Gilt für_), at most 20 items. A scoped contact is seen by who may see **one** of its items (and the supplier), administrators and auditors; others do not see it or that it exists.
- **Who may change it:** a company-wide contact – who may change the supplier (as in 0.17). A scoped contact – who may change the supplier, or who may change **every** item it is scoped to; who may change only some of its items may remove their own items from its scope (_Remove from my contract_) and nothing else. Scope items the person may not see are shown as _and 1 item you may not see_ to who may change the contact.
- **A contact never becomes company-wide by losing its scope.** Removing its last item removes the contact (asked first). When all its items are gone (a contract removed, a system deleted), it is shown only to the supplier's owners, administrators and auditors, marked _No longer in use_.
- **Personal data, unchanged:** the app shows e-mail and phone in a signed-in session to who may see the contact; `/api/v1`, MCP, datasets, exports and API tokens get **name and role only** (and the note as in 0.17) – the scope as the items the reader may see; audit entries name the contact and its scope, never the e-mail or phone values; removing a contact deletes it.
- A scoped contact shows on the pages of its items – the contract, the application's and the system's _Suppliers_ panel – besides the supplier's _Contacts_ tab.

### 7. Reminders, reviews and findings

- **Notice-by dates** (`supplier.notice_due`, 90 and 30 days before): to the **contract's owners**; a contract without owners – the supplier's owners; without those – the administrators (as in 0.17). Only recipients who may see the contract.
- **Expiring certificates** (`supplier.certificate_expiring`): to the supplier's owners **and the owners of every active contract** of the supplier (one whose term has not ended, or that renews automatically or has no end), each person once per certificate and threshold, only who may see the supplier; without any – the administrators.
- **Daily summary** (_Supplier certificates and notice dates_): notice-by dates of contracts you own (administrators also those whose reminders fall back to them), and certificates of suppliers you own or hold an active contract with.
- **Supplier review:** a service duty names the supplier, or **one of its contracts** that covers the duty's service (`service_duties.supplier_contract_id`) – a team reviews what it holds. A missed or failed period of such a duty is suggested with the contract ([COMPLIANCE.md](../COMPLIANCE.md#corrective-actions)).
- **Findings go to the contract owners:** a corrective action finding can name a contract of its supplier (`ca_findings.supplier_contract_id`). The contract's owners may read findings that name it (added to who sees findings), and the form proposes them as owners of the first action – so the action reminders (`corrective.action_due`) reach them. The finding's owner stays one user (proposed: the first user owner of the contract, else the person recording it).
- No new notification event.

### 8. Merging, opening and the 0.17 duplicates

**Merge suggestions.** _Suppliers → To confirm_ gets a section **_Same supplier in several teams_** (administrators): groups of active or unconfirmed suppliers with the same normalised name (or a spelling of one matching the other's name) and different owning teams – what the 0.17 migration left. Each group proposes **one shared supplier**: the instance-wide one if there is one, else the confirmed one, else the oldest, with no owning teams. _Merge…_ opens the preview; _Keep separate_ dismisses the group until another supplier joins it.

**The preview** (also for any merge in which the source is seen by fewer people than the target, and for opening a team-scoped supplier by removing or adding owning teams) lists before anything changes:

- who **gains sight of the company record** (the target's or the opened supplier's readers) – name, certificates, company-wide contacts;
- each **contract** with the owners it will have: a contract without a team owner gets the source's owning teams as owners, so it stays seen by exactly those teams (plus the readers of the services it covers, administrators and auditors); a contract with a team owner keeps its owners;
- each **company-wide contact** of the source with the scope it will get: the source's contracts; without contracts, the applications and systems that link the source; without those, the administrator chooses – _make it company-wide_ (named in the preview as a widening) or _remove it_;
- the supplier-level **DPA and personal data** of the source, written onto its moved contracts where they differ from the target's defaults, so no contract's answer changes;
- **certificates** that are the same (kind, scope and valid until) become one, keeping the latest _looked at_; **contacts** that are the same (name and e-mail, letter case aside) become one with the wider of their scopes – a scope that the preview names;
- the **owners** of the shared supplier: the union of all owners, editable;
- what moves: links, spellings, contracts with their schedules (ADR 0030), and the free-text migrations.

**Who:** a merge or an opening that widens who sees anything is for **administrators** (it changes a team scope); merging suppliers with the same owning teams stays with designers and administrators, as in 0.17. One merge combines up to ten suppliers in one transaction.

**Contracts are never merged automatically** – two teams' contracts with the same company are separate agreements. Contracts with the same contract number are flagged in the preview. To combine two contracts afterwards: _Remove contract_ → _Replaced by…_ another contract of the same supplier that the person may change – its covered services, schedules, plan lines, entries, matrix rows, duties, findings and scoped contacts move to it; covered services and contacts join only where the person may add them.

### 9. Upgrade from 0.17

In the migration itself (SQL, no vault needed; on SQLite and PostgreSQL):

1. Every contract gets **its supplier's owners as its owners**.
2. **Covered services are proposed** from what already points to the contract: the services of cost plan lines that name it (`cost_plan_lines.supplier_contract_id`) and of responsibility-matrix rows that name it (`service_responsibilities.contract_id`) – each as _proposed_, with where it came from. Paying services of ADR 0030 payment schedules are added as _confirmed_ (a schedule already says the service pays).
3. **Contacts stay company-wide.** Personal data and DPA of contracts stay empty – _as the supplier_ – so nothing changes meaning.
4. Suppliers keep their owning teams.

Proposed services are confirmed or dismissed by a person – on the contract (_Services to confirm_), on the service page's _Suppliers_ section, and listed under _Suppliers → To confirm_ (_Contracts with services to confirm_). Dismissing one leaves the plan lines and matrix rows as they are, with the hint of part 2. Until decided, a proposed service counts for reading, not for changing.

**What can narrow:** a contract whose supplier had a team among its owners becomes team-owned. Readers who saw it in 0.17 only through the supplier, and neither own it nor see a service it is proposed for, no longer see it. The release notes say so, the supplier list shows administrators _Contracts now seen only by their owners and services_ once, and removing the team owner reopens a contract. Nothing becomes visible to more people.

### UI

- **Supplier page** – tabs **Overview** (company data, owners, owning teams, personal data and DPA as the default for contracts, criticality, review duties, open findings), **Contracts** (master agreements with their order forms indented; per contract the services covered with their purposes, owners, term end, notice-by date with its state, the DPA state, _To confirm_ on proposed services; filters _Mine_ and _Covering services I edit_; on a phone, cards), **Services** (each service covered by a contract the reader may see, with its purposes and contracts; and the services that use the supplier through applications or systems with no contract covering them – _No contract for this service_), **Contacts** (company-wide first, then scoped ones with their _Applies to_ chips), **Certificates** (unchanged), **Used by** (as in 0.17).
- **A contract has its own page** (`/suppliers/:id/contracts/:contractId`, 404 for who may not see it), so services, matrix rows, findings and reminders can link to it: _General_, _Services and purpose_, _Owners and visibility_ (who sees it and why, like _Why do I have access?_), _Term and notice_, _SLA_ (inherited values in grey), _Data protection_, _Payments_ (ADR 0030, Costs module), _Contacts_, _Reviews and findings_.
- **Service page** – section **_Suppliers_**: the contracts covering the service – supplier, contract, purpose, owners, term end, notice-by date, SLA with RTO/RPO, DPA state – proposed ones with _Confirm_ and _Not this service_; _Add contract_ (choose a supplier – _New supplier_ for designers and administrators – and the contract covers this service), _Add to a contract_ (contracts the person may change); _Leave contract_ on each; and the suppliers its applications and systems link without a contract covering the service.
- **Application and system pages**: their _Supplier_ panel lists the contacts scoped to them.
- **German** in formal _Sie_; terms: _Gemeinsamer Lieferant_, _Abgedeckte Services_, _Zweck_, _Eigentümer des Vertrags_, _Rahmenvertrag_, _Einzelvertrag_, _aus dem Rahmenvertrag_, _Gilt für_, _Unternehmensweit_, _Ein Vertrag, den Sie nicht sehen dürfen_, _Vertrag verlassen_, _Getrennt lassen_, _Ersetzt durch …_, _Kein Vertrag für diesen Service_.

### Data model (additive migrations)

`server/src/migrations/suppliers.ts`, on SQLite and PostgreSQL:

- `suppliers-003-contract-scope`:
  - `supplier_contracts`: `owners` (JSON subjects, filled from the supplier), `parent_id` (null: none), `personal_data` (null: as the master or supplier; 0 or 1), `dpa_status`, `dpa_since`, `dpa_link` (null: inherited), `created_by`, `updated_by`. Empty SLA, RTO and RPO of an order form mean _inherited_; no column is needed. Index on `parent_id`.
  - `supplier_contract_services`: `contract_id`, `service_id`, `purpose`, `status` (`confirmed`, `proposed`), `proposed_from` (JSON: plan lines, matrix rows), added by and at, confirmed by and at; primary key `(contract_id, service_id)`, index on `service_id`. Filled by the upgrade (part 9).
  - `supplier_contact_scopes`: `contact_id`, `kind` (`contract`, `application`, `system`), `item_id`; primary key over all three, index on `(kind, item_id)`. None: company-wide.
- `suppliers-004-contract-links`: `service_duties.supplier_contract_id`, `ca_findings.supplier_contract_id`; `supplier_merge_dismissals` (group key – the normalised name and the suppliers' ids – dismissed by and at).

Person columns are history (`HISTORY_COLUMNS`); the new tables move with migration packages and backups. Contract owners and contact scopes move through the identity mapping like owners. Removing a service removes its coverage rows (a contract it was the only service of keeps no services); removing an application or system removes it from contact scopes (part 6).

### Audit

- `supplier.contract_added|changed|removed` (existing) gain the owners, the master, personal data and DPA (before and after) and, on removal, `replacedBy` with what moved.
- New: `supplier.contract_service_added`, `.contract_service_changed` (the purpose), `.contract_service_removed` (also _Leave contract_), `.contract_service_confirmed`, `.contract_service_dismissed` – on the supplier, naming the contract and the service; the service's audit view lists them too.
- `supplier.contact_added|changed|removed` gain the scope (kinds and ids), still without e-mail or phone values.
- `supplier.merged` gains the contracts with the owners they got, the contacts with their scope, the certificates and contacts combined, the owning teams of the result; new `supplier.merge_kept_separate`. Opening a supplier is `access.owning_teams_changed` with the same details of what was protected.
- `supplier.contracts_scoped` (system, once, the upgrade): how many contracts got owners and how many services were proposed or confirmed.

### Interfaces

- **Internal**: `POST|PUT /api/suppliers/:id/contracts[/:contractId]` take `owners`, `parentId`, `personalData`, `dpaStatus`, `dpaSince`, `dpaLink` and `services` (`[{ serviceId, purpose }]`, on create); `PUT|DELETE /api/suppliers/:id/contracts/:contractId/services/:serviceId` (purpose, `confirm: true`; leave or dismiss); `DELETE …/contracts/:contractId?replacedBy=`; contacts take `scope` (`[{ kind, id }]`); `GET /api/services/:id/contracts`; `GET /api/suppliers/shared-suggestions`, `POST /api/suppliers/merge/preview`, `POST /api/suppliers/merge` (`{ intoId, ids[], owners, contacts: { [id]: 'scope' | 'companyWide' | 'remove' } }`), `POST /api/suppliers/shared-suggestions/:key/keep-separate`. Duties and findings take `supplierContractId`.
- **Public, read-only**: `GET /api/v1/suppliers/{supplierId}` lists **only the contracts the token owner may see**; each gains `services` (`[{ id, name, purpose, status }]`, the services the token owner may see, no count of others), `owners`, `parentId`, `personalData` and `dpa` (effective, with `inheritedFrom`: `contract`, `master`, `supplier`), SLA values with `inherited`. Contacts gain `scope` (`[{ kind, id, name }]`, visible items; empty: company-wide) and are left out when none of their items is visible – still name, role and note only. The list's next notice-by date and _DPA missing_ count over visible contracts. New `GET /api/v1/services/{serviceId}/contracts` (the contracts covering the service, with supplier, purpose, term, notice-by date, SLA, RTO/RPO, DPA state). Duties, findings, plan lines and responsibilities gain `supplierContract` (id, title – or `{ hidden: true }`).
- **MCP**, read-only: `get_supplier` with the same filter and fields, a new `list_service_contracts`; `get_service_responsibilities` and `get_service_cost_plan` say _a contract you may not see_ as the app does.
- **Dataset** `suppliers.expiring` (administrators and auditors): rows per contract gain `contractOwners` and `services`; certificate rows unchanged.
- **Scheduled exports** ([ADR 0027](0027-backup-contents-and-exports.md)): the part _Suppliers_ writes every contract (exports are instance-wide, as before) with `services` (name and purpose), `owners`, `master`, `personal_data`, `dpa` and their source; contacts as before – name and role only, never e-mail or phone – now with their scope by name.
- **ISMS summary**: notice-by dates of contracts the schedule's owner may see; a line _contracts processing personal data without a DPA_.

### Limits

Per supplier 200 contracts (was 50 – a shared supplier holds several teams' contracts) and 100 contacts (was 20); per contract 50 covered services, 20 owners, a purpose of 200 characters; one master level; per contact 20 scope items; one merge combines up to ten suppliers. Other limits as in ADR 0029.

### Delivery

After the parts of ADR 0030 – payment schedules hang off contracts and commitments read them. ADR 0030 reads contracts through one function (`contractVisible`, every contract visible to who sees its supplier) from its first part, so this record fills it in rather than rewriting each read.

1. **Contract scope**: `suppliers-003`, the upgrade (owners, proposed services), covered services with purposes, owners, the visibility of contracts everywhere they are read – supplier page and list, cost plans, schedules and commitments, the matrix, plan lines and entries, _Used by_, search –, the rights table, the paying service as a covered service, _Services to confirm_; `/api/v1`, MCP, the dataset, the export part.
2. **Masters and data protection**: the master agreement with inheritance, personal data and DPA per contract, _DPA missing_.
3. **Scoped contacts**: scopes, rights, the item pages, the API shape.
4. **Reviews and reminders**: `suppliers-004`, duties and findings naming a contract, recipients of both reminders, the daily summary, the ISMS summary line.
5. **Shared suppliers**: new suppliers instance-wide, _Same supplier in several teams_, the merge and opening preview with its protections, _Replaced by…_.
6. **UI and docs**: the supplier page's tabs, the contract page, the service page's _Suppliers_ section; docs ([SUPPLIERS.md](../SUPPLIERS.md), [TEAMS.md](../TEAMS.md), [COMPLIANCE.md](../COMPLIANCE.md), [COSTS.md](../COSTS.md), [API.md](../API.md), [MCP.md](../MCP.md), [EXPORTS.md](../EXPORTS.md), [NOTIFICATIONS.md](../NOTIFICATIONS.md), [PRIVACY.md](../PRIVACY.md)) and demo data – the invented managed platform supplier shared by the online shop (hosting, team-owned) and customer care (licences), a master agreement with two order forms, a contact scoped to the hosting contract, and one pair of 0.17-style duplicates to merge.

### Tests

- `shared/test/suppliers.test.ts`: inheritance (order form → master → supplier) of SLA, RTO/RPO, personal data and DPA; _DPA missing_; `contractReaders` for team-owned, user-owned and unowned contracts, covered and proposed services, administrators and auditors.
- `server/test/supplier-contract-scope.test.ts`: visibility for each kind of reader, also with a team-scoped supplier; every row of the rights table (a service editor who sees every covered service, one who does not, _Leave contract_, adding a service needs sight of it, removing the last team owner); one master level and the same supplier; removing a master copies inherited values; a schedule's paying service must be covered and its removal is refused; amounts on the supplier page, the contract and commitments with a hidden service, a hidden contract and _Hide amounts_; _a contract you may not see_ in the matrix, plan lines, entries, duties, findings and _Used by_, and links kept on save; the list's notice-by date over visible contracts; reminder recipients and their fallbacks, each person once; findings readable by contract owners; `/api/v1` and MCP leave hidden contracts, services and contacts out without counts; the dataset and export part; audit; session-only writes; limits.
- `server/test/supplier-contacts-scope.test.ts`: who sees a scoped contact, who changes it, removing one's own item, the last item removes the contact, items gone, the public shape without e-mail and phone.
- `server/test/supplier-shared.test.ts`: suggestions from the v0.17.0 upgrade fixture (one text in two teams), _Keep separate_ and a new member reviving the group, the preview's lists, the merge protecting contracts and contacts, combined certificates and contacts, DPA written onto moved contracts, designers refused for a widening merge, opening a team-scoped supplier, _Replaced by…_.
- Upgrade from the v0.17.0 fixture: owners copied, services proposed from plan lines and matrix rows, contacts company-wide, and for every user the contracts visible after are a subset of those visible before (nothing widened); the new columns and tables on PostgreSQL.
- `e2e/supplier-shared.spec.ts`: two teams add their contracts to one shared supplier and each sees only its own; confirm a proposed service; a scoped contact; merge a suggested pair as an administrator – on a desktop and a phone with axe; the German texts in the locale tests.

### Considered and not chosen

- **A product catalogue per supplier** (products or offerings, with contracts and contacts per product): a second catalogue beside applications, systems and platforms, which already stand for what is bought; the contract's purpose says what it covers. Revisit if teams need one product across many contracts.
- **One supplier per team** (keeping the 0.17 split): certificates, company data and company-wide contacts entered and reviewed once per team, and no view of a company across teams – the opposite of what a supplier review needs.
- **Per-service copies of a shared supplier** (one shared record, a copy per service that overrides fields): two sources of truth for the same fields and a merge problem on every change; the contract already is the per-service part.
- **Contacts always supplier-wide**: shows a team's account manager and product contacts to every team that uses the company, and forces teams to keep such contacts outside Steward.
- **An access list per contract** instead of owners and covered services: one more place to manage access; the owners and the services already say who holds the contract and who depends on it.
- **Supplier owners see every contract**: a shared supplier's owner is often one team among many, and would see the others' contracts and amounts; they keep the company record and its certificate reminders.
- **Order forms inheriting the term and notice period**: order forms have their own; inheriting dates would make the notice-by date of one depend silently on another.

## Decided (November 2026)

The owner set the model – the supplier as the shared company record, contracts with their own scope, DPA per contract, shared and framework contracts, scoped contacts – and took the recommended answer to every open question on 2026-11-11:

1. **No product entity** – applications, systems and platforms stand for products; the contract's purpose says what it covers.
2. **New suppliers are instance-wide**; suppliers made by the 0.17 migration keep their team scope; administrators can open them – the company record is shared, without widening what the upgrade protected.
3. **The 0.17 duplicates**: Steward suggests merges into one shared supplier, contracts move with their teams as owners, an administrator confirms – the duplicates go without anyone's contracts being shown to another team.
4. **Adding a contract to a shared supplier**: whoever may edit a service the contract covers, plus the supplier's owners, designers and administrators – the team that holds a contract enters it.
5. **Reminders**: notice-by dates to the contract owners; expiring certificates to the supplier's owners and the owners of every active contract – each date reaches who acts on it.
6. **Supplier review**: a duty names a contract or the supplier; findings go to the contract owners – a team reviews what it holds.
7. **Master agreements**: one level only – master and order forms are the common case; deeper trees are rare and hard to show.
8. **DPA per contract**, the supplier's as the default – a company-wide DPA is entered once, a contract-specific one where it exists.
9. **Contacts in exports and the API**: name and role only – unchanged from ADR 0029.
10. **Upgrade**: contracts get the supplier's owners; covered services are proposed from plan lines and matrix rows and confirmed by a person; contacts stay company-wide – nothing is guessed silently.

Settled with this record, following those answers:

11. **Service editors on a shared contract** change it only when it covers a service they edit and they see every service it covers; otherwise read-only, but they may always change their own service's purpose or leave the contract – no team changes terms that bind services it cannot see.
12. **A contract is restricted once a team owns it**; contracts with only user owners or none stay visible to the supplier's readers – what has no owning team behaves as before ([TEAMS.md](../TEAMS.md)).
13. **New contracts' owners default to the creator and their teams for new resources** – a team's contract is the team's from the start.
14. **Owning a supplier does not show its contracts** – a shared supplier's owner would otherwise see every team's contracts and amounts.
15. **Hidden covered services**: the contract's owners and editors see how many, nobody sees which – managing a shared contract needs to know it is shared, not with whom.
16. **A schedule's paying service must be a covered service**, and amounts show only where the reader may see the contract and the paying service (the service's _Hide amounts_ applies) – ADR 0030's rule, extended to the contract.
17. **A hidden contract named elsewhere** – matrix, plan lines, entries, duties, findings, _Used by_ – shows _a contract you may not see_ without its values, and saving keeps the link – the same rule as a hidden supplier in ADR 0029.
18. **SoA rows stay supplier-level** – the statement is the organisation's; contract detail lives in the matrix.
19. **Personal data per contract**, default the supplier's; _DPA missing_ only where the effective answer is yes – Steward has no personal-data mark on services or applications, and the CIA rating is not one.
20. **Order forms inherit SLA, RTO/RPO, personal data and DPA**, not dates or the document; **their visibility is their own**, and inherited values are shown to their readers – they are the order form's own terms.
21. **Removing a master** copies inherited values into its order forms – their terms must not change by someone else's removal.
22. **A scoped contact** is changed by the supplier's editors or who may change every item it is scoped to; others remove their own items; **it never becomes company-wide by losing its scope** – removing scope must not widen.
23. **Merges and openings that widen** anything are for administrators and show a preview of what each team gains; contracts get the source's teams, contacts are scoped to the source's contracts, DPA answers are written onto moved contracts – nothing becomes visible or changes meaning silently.
24. **Contracts are never merged automatically**; _Replaced by…_ moves everything that names a contract to another – two contracts with one company are two agreements until a person says otherwise.
25. **API and MCP** list only contracts, services and contacts the token owner may see, with no counts of hidden ones, and add `services`, `owners`, `parentId`, `personalData`, `dpa`; a new `/api/v1/services/{serviceId}/contracts` and `list_service_contracts` – the service-side view the service page has.
26. **Datasets and export parts stay instance-wide** (administrators and auditors; the export target) with the new columns – they never were filtered.
27. **Migrations are additive** (`suppliers-003`, `suppliers-004`); the upgrade may narrow who sees a contract, never widen, and says so.
28. **Limits** as above – a shared supplier holds many teams' contracts and contacts.

## Built in 0.18.0

Built as decided, in the six parts of the delivery order. Settled while building:

- **Proposals also from cost entries.** The upgrade proposes covered services from cost plan lines, matrix rows **and cost entries** that name a contract (`proposed_from` names each source) – an entry names the contract its service paid for, so it counts like a plan line for "nobody loses sight of a contract their service pays for".
- **Gone scope items stay as marks.** A contact's scope row whose contract was removed or whose system was deleted stays in `supplier_contact_scopes` as a mark and no longer counts as an item: that is how a contact whose items are all gone is told apart from a company-wide one (_No longer in use_) without a column of its own. Taking off the last item by hand is refused (`SUPPLIER_CONTACT_LAST_ITEM`) – remove the contact instead.
- **Hidden contracts in the API** are a flag beside the existing field (`supplierContractHidden` on plan lines and entries, `contractHidden` on matrix rows, `supplierContract` with `supplierContractHidden` on duties and findings) rather than `{ hidden: true }` in place of the contract, so the shape of the 0.17 fields does not change.
- **Opening a supplier** goes through the _Owning teams_ panel as before (`PUT /api/owning-teams/supplier/:id`, with the protections and an optional `contacts` choice) and through `POST /api/suppliers/:id/open[/preview]`.
- **"Replaced by …"** refuses when a payment schedule's paying service may not join the replacement – a schedule needs its service covered, and adding a service the person may not see would widen the replacement.
- **No shared-package test runner**: the pure rules (`contractReaders`, `effectiveTerms`) are tested in `server/test/supplier-contract-scope.test.ts`.
- **The service's audit view**: services have no audit view of their own; the `supplier.contract_service_*` entries name the service in their details.

## Consequences

- One company is one record: certificates, the company-wide DPA and company contacts are kept and reviewed once, while each team manages its own contracts, terms, reminders and contacts without seeing the others'.
- A service shows which contracts it depends on and for what; the responsibility matrix, the cost plan and the supplier review all name the contract that applies.
- The 0.17 duplicates can be merged without exposing anything, and the merge preview says exactly who gains what.
- Data protection is answered where it is true – per contract – and _DPA missing_ stops flagging contracts that process no personal data.
- More rules to learn: contract visibility, editing rights on shared contracts, inherited values and scoped contacts. The contract page's _Owners and visibility_ says who sees it and why; the docs explain the rules with the shared demo supplier.
- **Risks**: the upgrade narrows visibility for contracts whose supplier had a team owner – said in the release notes and once on the list, reversible by removing the team owner; proposed services forgotten – listed under _To confirm_ until decided, and they count for reading meanwhile; counts of hidden services visible to contract owners – existence only, no names or amounts; certificate reminders reaching many contract owners – once per person, only active contracts; computing visibility on every read – in bulk per page, bounded by the limits; a merge that widens by mistake – administrators only, with a preview, audited.
- Revisit if teams need products across many contracts, deeper contract trees, contract-level certificates, or access to a contract granted without owning it or depending on it.
