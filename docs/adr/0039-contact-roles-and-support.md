# 0039. Contact roles, inherited contacts, support channels and support levels

- **Status:** Accepted
- **Date:** 2026-11-15
- **Since:** 0.26.0
- **Builds on:** [0038](0038-documented-governance-contacts.md) (one contacts directory)

## Context

0.25.1 gave Steward one contacts directory (ADR 0038). Three things were still too rigid or unclear:

1. **Roles were a fixed list per kind** (`CONTACT_LINK_ROLES` in `shared/src/contacts.ts`): a domain had only a _domain owner_. Real organisations name a domain manager, a domain architect, a data protection coordinator, a product manager, a technical lead. Plant sites had free-text roles that nobody could report on.
2. **Contacts were typed again and again.** A product sits in a domain whose owner, manager and architect are the same for every product in it; sub-domains repeat their parent's people. Owners go on leave and hand over, and nothing said who stands in or until when.
3. **Support was a single free-text "Channel", a web address and "Hours", plus a bare _support tier_ 1–3.** It said nothing about what the channel is for, a product could have only one, and nobody could tell what tier 2 promises – it was easily confused with the product's criticality. Services and applications had nothing at all, although "where do I report a problem" is first asked of a service.

The consumers of a data product and the users of a service usually do not use Steward. What Steward records here is documentation – for the IT maintainers, for audits, and for the catalogues and portals Steward exports to (ODPS, `/api/v1`, Git sync) – not a help desk.

## Decision

### 1. A role catalogue

Contact roles become **data** (`contact_roles`), kept under _Settings → Contacts → Roles_ by administrators – like the technology list of 0.25 (ADR 0037).

- A role has a key, English and German labels, a short description, the **kinds it applies to** (services, suppliers, plant sites, data products, domains, data objects, consumer registrations, and now **applications** and **systems**), **one or many** contacts per item, and optionally **expected**: an item without a contact in that role gets a hint (and, for data products, the scorecard notes it).
- **Built-in roles keep their meaning**, because Steward relies on them: product owner (the "needs an owner" hint, ODPS `productOwner`), domain owner (suggested as who endorsed a product), data owner and data steward (the records of processing), consumer contact (the consumers' contacts list for notices), the service roles _business_ and _IT_, and the supplier roles. Their labels can be changed and they can be switched off for a kind, never deleted or re-keyed.
- **Own roles** are documentation only – domain manager, domain architect, product manager, technical lead, subject-matter expert, deputy owner, … They show on the item, on the contact's where-used page, in exports, `/api/v1` and MCP (by name and role, under the exposure rules of ADR 0038), and in reports.
- **New built-in roles** for the new kinds: applications _business owner_ and _application manager_; systems _business owner_ and _system manager_. Applications and systems keep their `owners` (the Steward users and teams that maintain them, with rights); business contacts sit beside them and give no right (ADR 0038).
- **Plant sites' free-text roles** become catalogue roles at the upgrade, one per distinct text (case-insensitive), so the site form gets a picker and nothing is lost.
- A role in use can be switched off (no new links, existing ones stay and are marked) but not deleted; an unused own role can be deleted. Changes are audited (`contact.role_*`).

### 2. Inherited contacts along the domain hierarchy

- A **sub-domain** shows its parent domain's contacts per role, marked _from domain Finance_, unless it names its own contact in that role.
- A **data product** shows its domain's contacts (the domain's roles, e.g. domain owner, domain architect), marked as inherited.
- Inherited contacts are **never copied**: changing the domain changes every product and sub-domain at once. They count for _expected_ roles of the inheriting item. They follow the domain's visibility: a reader who may not see the domain sees no inherited contacts and is not told there are any.
- No inheritance between services and applications (an application can serve several services); an application shows the contacts of the services it belongs to in a read-only panel.

### 3. Deputy and until

A contact link may name **deputy for** another contact in the same role on the same item, and an **until** date. After the date the link is marked _ended_ and no longer counts for an expected role. History is the audit log; documented decisions keep their frozen names (ADR 0038).

### 4. Support channels

Support becomes **a list of channels** on data products, services and applications (`support_channels`), as ODPS models it (`support[]`):

- **Purpose:** questions, issues and incidents, announcements, access and onboarding.
- **Tool:** ticket system, e-mail, Microsoft Teams, Slack, web page, phone, other.
- **Name, address** (`https://` – also `http://`, for internal pages –, `mailto:`, `tel:`), **hours** (per channel – the incident queue may run 24×7, the mailbox business hours) and a **note** (the queue, category or assignment group to use).
- Channels name shared addresses, not people; the form says so. People are contacts.
- A **data product can name the service that supports it**: it then shows that service's channels and support level, marked as such, unless it names its own.

### 5. Support levels instead of a tier

Administrators keep a short list of **support levels** (_Settings → Support levels_): name (en/de), hours, **one first-response time**, a note, and optionally a link to the SLA document. A data product, service or application picks one; its page shows what the level promises. A level documents what the providing team offers; Steward does not measure it. Response times per priority belong to the ticket system and its SLA document. Criticality stays separate: it says how bad an outage is, the level what support is promised.

### 6. Guides for consumers

Guides and documentation for the consumers of a data product are recorded as **where the consumers find them** – a wiki, SharePoint or portal page – as external addresses with a title (`guides`). Steward's own living documents can still be linked, as internal IT documentation; they are not consumer guides, because consumers usually cannot open Steward.

### 7. Exchange

- **ODPS:** each channel → `support[]` (`channel` = name, `url` = address, `tool`, `scope`: questions → `interactive`, issues and incidents → `issues`, announcements → `announcements`; access and onboarding → no scope, with Steward's purpose in `customProperties`; hours and note → `description`); the level → `customProperties` (`supportLevel` with name, hours and first response); guides → `authoritativeDefinitions` with type `userGuide`. The import reads them back.
- The file format, Git sync, `/api/v1` and MCP carry channels, the level, guides and contact roles (by key and label).

### 8. Upgrade

- Today's single support channel becomes one channel with purpose _questions_ (tool _e-mail_ for a `mailto:` address, else _other_), with its hours.
- Products with tier 1, 2 or 3 get the levels _Tier 1_, _Tier 2_ and _Tier 3_ (German _Stufe 1_ to _Stufe 3_; only those in use), for administrators to rename or merge – nothing is guessed. A new installation starts with three example levels (business hours, extended, 24×7).
- The built-in roles are seeded with their keys unchanged, so every existing link keeps its role; plant site free-text roles become own roles (part 1).
- `tier` and `support` in the API stay readable for one release, deprecated, derived from the level and the first _questions_ channel.

## Consequences

- Organisations name the people they really have, in their own words, and can report on it; Steward's own logic keeps working on the built-in roles.
- Contacts are entered once per domain; holidays and handovers are visible.
- "Where do I ask, where do I report an incident, what is promised" has one answer per product, service and application, and it reaches consumers through ODPS and the catalogues.
- Harder: two more settings lists to keep tidy; inherited contacts must be explained on the page (marked, with the source).
- Not done, on purpose: rules that act on roles (notify architects, require two roles for a decision, give a role rights) – that would be governance workflow again (ADR 0038). Response-time matrices per priority, and measuring support against levels.
