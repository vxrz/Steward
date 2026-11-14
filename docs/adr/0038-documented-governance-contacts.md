# 0038. Steward documents data governance, it doesn't run it; one contacts directory

- **Status:** Accepted
- **Date:** 2026-11-14
- **Since:** 0.25.1
- **Amends:** [0036](0036-data-products-module.md) (decision 6, access requests, port access reviews, endorsement) and [0037](0037-data-products-connectors-files-edge.md) (semantic model sign-off)

## Context

The data products module (0.22 to 0.25) quietly assumed that every governance stakeholder is a Steward user. Product owners, domain owners, data owners and stewards were Steward subjects (`user:…`, `team:…`), and naming someone gave them rights: product and domain owners got an implied Manage share. Several features had Steward **run** a governance workflow:

- access requests: request, approve, four eyes, decision notices;
- port access reviews: decided entry by entry in Steward by its users, with four eyes;
- endorsement: domain owners click _Endorse_;
- semantic model sign-off: four eyes by users.

In practice many of these people – data product owners above all – never use Steward. Steward is the **IT service surface** for data governance: it records the technical facts (elements, ports, lineage, who really reads, grants, costs) and documents what the business side decided elsewhere, in a meeting, an e-mail, a GRC tool or a ticket. It is not where access is requested or granted.

The same mix-up of a business responsibility with rights in Steward showed on the Access tab (0.25.0 added a hint for it). And the way Steward stores people who are not users had grown three times: inline service contacts (role, e-mail, name), supplier contacts (with id, phone, note and scope, ADR 0031) and plant site contacts (free-text role, e-mail, phone, URL).

## Decision

### 1. One contacts directory

`server/src/contacts/` and `shared/src/contacts.ts` keep **contacts**: a person or a group (a shared mailbox, an office), with name, e-mail, phone, organisational unit, a URL and optionally the Steward user they are. A contact is _active_ or _left_. Items link contacts with a **role** per link kind (`CONTACT_LINK_ROLES`): services (business, IT), suppliers (account manager, support, security, data protection, other – the supplier's own scope and note stay on the supplier's link), plant sites (free-text roles), data products (product owner, business contact), domains (domain owner), data objects (data owner, data steward) and consumer registrations (consumer contact).

- **A contact never gives a right**, also when linked to a Steward user. Rights come only from roles, owning teams and shares (ADR 0033).
- **Who sees a contact:** who may see at least one item it is linked to; administrators and auditors; and its creator while it is linked to nothing. Links on items the reader may not see are counted, never named.
- **Who changes a contact:** who may change at least one item it is linked to, and administrators. Changes are audited (`contact.created`, `contact.updated`, `contact.replaced`, `contact.erased`).
- **One entry per person:** the picker offers the contacts the reader may see, matched by name and e-mail. A new contact whose e-mail address matches one the reader may not see is created as a separate contact – nothing about the hidden one is revealed – and administrators see such pairs under _Possible duplicates_.
- **Replace with…** moves every link of a contact (the reader's visible ones; administrators: all) to another contact, for example when someone leaves. Audited per item.
- **Erase** (administrators, GDPR Art. 17): the contact and its links are deleted; documented decisions keep the name frozen in their snapshot, which is evidence (Art. 17(3)(b) and (e)), and their contact id becomes null.
- **Personal data leaves the app per link kind, never per contact** (`CONTACT_EXPOSURE`):
  - suppliers: in the app only, as ADR 0029 decided (an API token gets the contact without e-mail and phone, as before);
  - services and plant sites: exactly where and in the shape they were shown before 0.25.1;
  - data products, domains, data objects and consumer registrations: names and roles in exports, `/api/v1`, MCP and reports; e-mail addresses only in the module's file format and ODPS.
- Contacts are in backups and in the personal data export of a subject (a contact's where-used page).

### 2. Owner fields document; they give no rights

In the data products module, product owners, domain owners, data owners and stewards are **contacts**. Technical custodians of a data object stay teams: that is IT. The rights table reads only roles, owning teams and shares. The implied owner shares go away.

**Upgrade, nobody loses a right:** each `user:` or `team:` subject that today gets a right only through an owner field gets an **explicit share** with exactly that right (Manage on products and domains, View on data objects for their owner and stewards), audited in the access family as part of the upgrade. Then each subject becomes a contact: a user becomes a person contact linked to that user (name and e-mail from the account); a team becomes a group contact named after the team. A test compares every user's rights on every data product item before and after the upgrade.

### 3. Documented access instead of access requests

A **consumer registration** documents access that was decided elsewhere: purpose, environment, until when, agreement, identities – and a **documented decision** (`DocumentedDecision`): decided by (contacts, frozen), on which date, the evidence (a record, a ticket reference, a URL, a document, a text), a note, and the Steward user who recorded it.

- There is no request inbox, no _Request access_ button, no approve button, no four eyes and no decision notices.
- Recording a registration is documentation in Steward (the product's edit right), not a grant; the optional fulfilment stays IT work: record the platform ticket as a ticket reference and start the platform team's process, with the run right and the process's own approvals, as before.
- **Upgrade:** approved requests are already registrations; they get a documented decision from the approval (the deciders as contacts). Pending requests become registrations marked _approval not documented_, for the IT maintainers to complete or remove. Refused and withdrawn requests stay readable as history.
- **API:** `GET` of requests stays, read-only, for one release; creating or deciding a request answers `410 DATA_ACCESS_DOCUMENTED_ONLY`. The MCP request tool goes.

### 4. Port access reviews record an outcome decided elsewhere

The **frozen evidence stays**: registered consumers, who really reads, platform grants, and the differences – this is IT's contribution. The outcome is entered by the product's IT maintainers: keep or remove per entry, and a documented decision for the review (decided by contacts, date, evidence). The seal covers the entries, the decisions and the documented decision. **Four eyes is off by default** and stays available as a module setting (a second IT person checks the transcription; nobody who entered decisions approves). Removals can still start a process or record a ticket. Person access reviews (IT access recertification across platforms) do not change.

### 5. Endorsement and semantic model sign-off are documented approvals

- **Endorsement:** endorsed by contacts (the domain owners, typically), on a date, with a review date, evidence and the recorder. A breaking contract change, an expiry or a rating below the floor asks the IT maintainers to have it looked at again. Maturity 5 reads the documented endorsement.
- **Semantic model sign-off:** a documented approval of one version: approved by contacts, date, evidence, recorded by. The SHA-256 of the version shown when it is recorded must match, so the approved text stays provable; "which version was valid on a date" still answers. Four eyes goes. As before, there is no revoke; a later approval supersedes an earlier one.
- **Upgrade:** existing endorsements and sign-offs keep their Steward users as contacts linked to those users.

### 6. Notices go to the IT maintainers

`dataproduct.deprecated`, `contract_breaking`, `endorsement_review` and `access_review_due` go to the product's **IT maintainers** – who may edit it through owning teams, roles and shares – never to contacts. Each carries a link to the affected consumers' contacts, which the page lists with copy and CSV, so the maintainers can inform them. `access_requested` and `access_decided` are retired. Steward never e-mails a contact.

## Consequences

- Data product owners and other stakeholders no longer need a Steward account to be named, and naming them changes nobody's rights. The Access tab and the rights table say the same thing.
- The evidence Steward keeps is honest: it records who decided, when and where, and that a Steward user recorded it – instead of pretending the decision was made in Steward.
- One contacts model replaces three; a person who is the product owner of 15 products is one entry, replaced in one step when they leave, and found in one place for a subject access request.
- Harder: transcribing a decision is manual work, and Steward can't tell whether the transcription is faithful – the evidence link is the check. Teams that want Steward to run approvals need a workflow tool (or Steward's processes with their approval steps).
- Released behaviour changes in a patch release (0.25.1). The upgrade notes say so, the deprecated request routes answer read-only for one release, and the upgrade keeps everyone's rights.
- Applications and systems keep their `owners` (Steward users and teams responsible). A business contacts section for them can follow on the same model.

## Alternatives considered

1. **A global address book readable by everyone signed in.** Rejected: supplier contacts and plant site contacts are personal data that today only who sees the item sees; a global directory would widen that. The picker offers what the reader may see.
2. **Match a new contact to a hidden one by e-mail and link it.** Rejected: it reveals that the address is known and what the hidden entry says. Duplicates are merged by administrators instead.
3. **Drop port access reviews from Steward and keep only "who really reads".** Rejected: the frozen comparison of registered consumers, actual readers and platform grants is the evidence auditors ask for; only who decides moves out of Steward.
4. **Let Steward e-mail external contacts.** Rejected for now: it makes Steward a mailing system for people who never agreed to it; the maintainers inform them with the list Steward prepares.
