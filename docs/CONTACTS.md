# Contacts

Steward keeps one **contacts directory** (0.25.1, [ADR 0038](adr/0038-documented-governance-contacts.md)): the people and groups items name for their business side – the business and IT contacts of a [service](RECORDS.md#service-catalogue), the people at a [supplier](SUPPLIERS.md#contacts-and-data-protection), the contacts of a [plant site](PLANT.md), and the owners, stewards and consumer contacts of [data products](DATA-PRODUCTS.md). A person who is the business contact of 15 items is one entry, found in one place and replaced in one step when they leave.

A contact is a **person** or a **group** (a shared mailbox, a board, an office) with a name, e-mail address, phone, organisational unit, a web address and – optionally – the Steward account they are. A contact is _active_ or _left_: a contact who has left stays where it is named and in documented decisions, but is offered nowhere new.

**A contact never gives a right in Steward**, also when it is linked to a Steward account. Rights come only from roles, owning teams and shares ([ADR 0033](adr/0033-one-access-model.md)).

Since 0.26.0 ([ADR 0039](adr/0039-contact-roles-and-support.md)) the roles items name their contacts in are a [catalogue](#roles) administrators keep, [applications and systems](#applications-and-systems) name business contacts too, sub-domains and data products show their [domain's contacts](#inherited-contacts), and a link can name a [deputy and an end date](#deputy-and-until).

## Roles

_Settings → Contacts → Roles_ (administrators) keeps the **role catalogue**: the roles each kind of item names its contacts in. Everyone signed in reads it – the pickers offer its roles; only administrators change it, and only they see how often a role is used.

A role has a **key** (letters and digits, e.g. `domainArchitect` – made from the English label when none is given; it never changes), an **English and a German label**, a short **description**, the **kinds of item it applies to** (services, suppliers, plant sites, data products, data domains, data objects, consumer registrations, applications, systems), **one or several** contacts per item and whether it is **expected**.

- **Built-in roles** are Steward's own, with the keys of before – so no link changed at the upgrade: services _business owner_ and _IT operations_ (`business`, `it`); suppliers _account manager_, _support_, _security_, _data protection_, _other_; data products _product owner_ and _business contact_; data domains _domain owner_; data objects _data owner_ and _data steward_; consumer registrations _consumer contact_; and, new, applications _business owner_ and _application manager_, systems _business owner_ and _system manager_. Steward relies on them – the product owner for "needs an owner" and ODPS, the domain owner as who endorsed, data owner and steward in the records of processing, the consumer contact for the consumers' contacts list – so they can be **relabelled and switched off** (altogether, or for one of their kinds), never deleted, re-keyed or given other kinds.
- **Own roles** – domain manager, domain architect, technical lead, subject-matter expert, … – are documentation only: they show on the item, on the contact's where-used page, in exports, `/api/v1` and MCP (by name and role, under the exposure rules [below](#what-leaves-the-app)) and in reports. Two roles of one kind never share a label (a file's role text would be ambiguous). They apply to any kind but suppliers, whose contact entries keep the supplier roles with their scope and note ([ADR 0031](adr/0031-supplier-contracts-and-contacts-scope.md)). At most 300.
- **Switched off**, a role takes no new links; contacts already named in it stay and are marked _Role switched off_. A role in use can't be deleted – switch it off; an own role nobody is named in can be deleted.
- **One contact per item** (cardinality _one_): an item names one current contact in the role – [deputies](#deputy-and-until) and ended links aside. The picker adds a second contact as deputy of the first.
- **Expected**: an item of the role's kinds without a current contact in it – its own, or one it [inherits](#inherited-contacts) – gets a hint on its page; for data products the scorecard notes it under _Documented_ ("Expected contact roles without a contact"), without counting it. The "needs an owner" check of data products keeps reading the product owner.

Every check reads the catalogue – the pickers, the item forms and APIs, the imports: a role that does not apply to the kind is refused (`CONTACT_ROLE_UNKNOWN`, with the hint where roles are added); imports never make a role on their own. Changes are audited: `contact.role_created`, `contact.role_updated` (with what changed), `contact.role_deleted`.

## Inherited contacts

Contacts are entered once per domain ([ADR 0039](adr/0039-contact-roles-and-support.md) part 2):

- A **sub-domain** shows its parent domain's contacts **per role**, marked _from domain Finance_, unless it names its own contact in that role.
- A **data product** shows its domain's contacts the same way – the domain's own and, in the roles the domain names none of, its parent's.
- Inherited contacts are **never copied**: changing the domain changes every sub-domain and product at once. They count for the item's [expected roles](#roles).
- They follow the **domain's visibility**: who may not see the domain a contact comes from sees no inherited contact from it and is not told there is one (a product whose domain they may not see inherits nothing). The product page and the scorecard read them in bulk with the product's own contacts.
- They are shown in the app – the product and domain pages and their API (`inheritedContacts`). `/api/v1`, MCP, ODPS and the data products file format carry an item's **own** contacts only: inherited ones are the domain's, and the file format gives them with the domain (`domains:` of an export).
- There is no inheritance between services and applications: an application can serve several services. Its page shows the contacts of the services it belongs to (those the reader may see) read only, in its _Contacts_ section.

## Deputy and until

A link may name **deputy for** – another contact named in the same role on the same item, not a deputy itself – and an **until** date. After that day the link is marked _ended_ and no longer counts for an expected role; it stays until it is removed (history is the audit log; documented decisions keep their frozen names). The picker edits both per row (_Deputy and end date_); a client or a file that leaves them out keeps what the link had. _Replace with…_ moves them with the link (and a deputy of the replaced contact stands in for its replacement); _Erase_ leaves the deputies of the erased contact standing in for nobody.

In exports, `/api/v1` and MCP a link carries its role's key and English label (`role`, `roleLabel`), whom a deputy stands in for by name (`deputyOf`) and `until`; the data products file format carries `role_label`, `deputy_of` (the name or e-mail address of the contact in the same role) and `until`; ODPS gives every role as a team member with its key as `role`, the label (and the deputy) as `description` and `until` as `dateOut`.

## Applications and systems

Applications and systems name **business contacts** (0.26.0): _business owner_, _application manager_ or _system manager_ and own roles, in the _Contacts_ section of their pages. Who sees the application or system sees them; who may change it changes them (`PUT /api/applications/{id}/contacts`, `PUT /api/systems/{id}/contacts`, audited as `application.updated` and `system.changed`). Their **owners** – the Steward users and teams who maintain them, with rights – are unchanged: a contact gives no right. `/api/v1` and the CSV exports give the contacts by name and role (exposure `names`, like data products).

## Who sees a contact

- who may see at least one item it is linked to;
- administrators and auditors;
- its creator, while it is linked to nothing.

Everyone else gets _not found_, exactly as for a contact that does not exist: the search, the list and the picker never show, count or hint at a contact the reader may not see. The where-used page of a contact lists the items the reader may see and only **counts** the links on items they may not see – it never names them.

A module-only user (a plant viewer, [MODULES.md](MODULES.md)) sees the contacts of the module's items only: never those of services or suppliers, which they cannot reach.

## Who changes a contact

Who may change at least one item it is linked to, its creator while it is linked to nothing, and administrators. Auditors read only. Changes are audited: `contact.created`, `contact.updated` (with the names of the fields that changed), `contact.replaced` (once per item) and `contact.erased`. Audit entries name the contact, never its e-mail address or phone number.

## One entry per person

The picker on an item offers the contacts the reader may see, matched by name and e-mail address, and creates a new one on the way. When a new contact's e-mail address matches a contact the reader may see, the form offers that one instead. A new contact whose address matches one the reader may **not** see is made as a separate contact – nothing about the hidden one is revealed. Administrators see such pairs under _Contacts → Possible duplicates_ and merge them with _Replace with…_ and _Erase_.

File imports (services, plant sites) match a contact by e-mail address among the contacts the importer may see, and make a new one otherwise.

## Replace with…

_Contacts → a contact → Replace with…_ moves the contact's links to another contact, for example when someone leaves: the links on items the person may change move (administrators: all links); visible links on items they may not change stay and are counted. A link the other contact already has on the same item and role is merged. Each item's change is audited (`contact.replaced`). Optionally the replaced contact is marked as left.

## Erase

Administrators erase a contact (GDPR Art. 17) with a step-up confirmation (control point `contact.erase`, [ASSURANCE.md](ASSURANCE.md)): the contact and every link to it are deleted. A supplier's contact entry (its scope and note) goes with it. **Documented decisions keep the name** in their frozen snapshot – that is evidence (Art. 17(3)(b) and (e)) – and their contact id becomes empty. The audit entry `contact.erased` names the contact's id and the number of links, not the name.

The audit log keeps earlier entries that name the contact; [PRIVACY.md](PRIVACY.md#the-audit-log-is-immutable--how-erasure-works) explains how erasure and the immutable audit log fit together.

## What leaves the app

Personal data leaves the app **per link kind, never per contact**:

| Link kind                                                    | In the app                      | `/api/v1`, MCP, datasets, reports, exports          | The module's own file format, ODPS |
| ------------------------------------------------------------ | ------------------------------- | --------------------------------------------------- | ---------------------------------- |
| Suppliers                                                    | name, role, e-mail, phone, note | name, role and note – no e-mail or phone (ADR 0029) | –                                  |
| Services                                                     | name, role, e-mail, phone       | as before 0.25.1: role, e-mail address and name     | –                                  |
| Plant sites                                                  | name, role, e-mail, phone, URL  | as before 0.25.1: name, role, e-mail, phone, URL    | the same (YAML import and export)  |
| Data products, domains, data objects, consumer registrations | name, role, e-mail, phone       | names and roles                                     | names, roles and e-mail addresses  |
| Applications, systems (0.26.0)                               | name, role, e-mail, phone       | names and roles                                     | –                                  |

The app's internal API called with an API token counts as an API: a data product's, domain's, data object's and registration's contacts come by name and role, as on `/api/v1`; the consumers' contacts CSV needs a signed-in session. Where an old subject field (`owners: [user:…]`) or a file's `user` names a Steward account, a new contact gets the account's e-mail address only when an administrator (or the account itself) names it – only administrators see accounts' addresses.

Contacts are in backups (the database) and in migration packages; a contact's Steward account is mapped to the target's account on import. The where-used page of a contact is the overview of that person's data for a subject access request.

## For developers

The directory is core (`server/src/contacts/`, `shared/src/contacts.ts`), not a module. A module names contacts on its items through:

- `registerContactKind(kind, def)` – or `contactKinds` in its feature manifest – with `visibleIds(u, itemIds)`, `canChange(u, itemId)`, `names(itemIds)`, `href(itemId)` and optionally `onLinksErased(itemIds)` and `createsContacts(u)` (a module-only user who may change the module's items creates contacts on the Contacts page and in the pickers; core roles admin, designer, operator and approver may anyway; contacts made inline by `setLinks` need only the right to change the item). A kind nobody registered is seen by administrators and auditors only.
- `linksOf(kind, itemIds, { surface })` – the contacts of many items in one statement, in the shape `CONTACT_EXPOSURE` allows on the surface (`app`, `api`, `export`, `file`).
- `writeLegacyLinks(kind, itemId, entries, fields)` – an item's contacts in its kind's own pre-0.25.1 shape (services, plant sites, suppliers); `writeItemLinks` writes checked links as they are.
- `setLinks(kind, itemId, links, { roles })` – replaces an item's contacts (of those roles) in the caller's transaction, by the role catalogue's rules (`checkLinkRoles`: switched on for the kind, or kept on the item; cardinality; deputies); `removeItemLinks(kind, itemId)` when an item is deleted.
- `contacts/roles.ts` – the catalogue (`roleCatalogue()`, kept in memory until it changes), `roleKeyFor(kind, text)` (a key or label of a file or import), `roleLabelOf(key, lang)`.
- `namesOfLinks(links)` – names and roles for the surfaces of exposure `names`; `linksOfKinds([{ kind, ids }])` – several kinds in one statement (a product and its domains).
- `snapshotsOf([{ contactId, role }])` – the frozen `ContactSnapshot`s of a documented decision (visible, active contacts only).
- `contactForUser(name)`, `contactForGroup(name)`, `importContact(input)` – find or make a contact (upgrades, imports).
- `registerContactHooks({ countDecisions, onErased })` – the documented decisions that name a contact (counted on its page) and nulling an erased contact's id in frozen snapshots.

In the web app, `web/src/components/contacts/` has the `ContactPicker` (an item's contacts with their roles), the `ContactSnapshotPicker` (who decided), the `ContactForm` and `ContactLinksView`.

## How services, suppliers and plant sites use it

- **Services**: business and IT contacts. The form uses the picker; `POST/PUT /api/services` still take `contacts` (role, e-mail, name) – each becomes the contact the service names already with that address, else the one with that address you may see, else a new one – or `contactLinks` (the picker's links). `/api/v1`, MCP, exports and reports show `contacts` exactly as before.
- **Suppliers**: the supplier keeps one entry per contact – role, note and scope ([ADR 0031](adr/0031-supplier-contracts-and-contacts-scope.md)) – and the entry is the item the directory links: who sees and changes the person through a supplier is who sees and changes that entry, so the supplier rules and the scopes are unchanged. Name, e-mail and phone are the directory contact's. In the app only, as before.
- **Plant sites**: contacts with roles of the catalogue – since 0.26.0 own roles made from the free-text roles of before ([upgrade](#upgrade-to-0260)); a contact may have no role. The site form uses the picker; the API, the import and export files, MCP, change sets and history keep the shape of before (name, role, e-mail, phone, URL), with the role's English label where the text was – and take the text back: a role's key or label (letter case aside) is that role, a text that is neither is refused with a hint (the import's preview names it), unless the site names it already. An import matches a contact by e-mail address among those the importer may see, without one by name within the site.

Correcting a name or phone number through an item's API or import changes the contact – wherever it is named: the directory has one entry per person.

## Upgrade

The upgrade to 0.25.1 moves the contacts services, suppliers and plant sites kept themselves into the directory, once, when the vault is first opened (and again after a migration package of an older version is imported):

- each item is converted in a transaction of its own; its own list is emptied in the same transaction, so a second run finds nothing to do. Until the conversion, the items show their own lists;
- within one kind, the same e-mail address (letter case aside) **with the same name and details** (phone, web address) is one contact; entries that differ stay apart and show under _Possible duplicates_. Kinds are never merged: a person who is a service's business contact and a supplier's account manager is two contacts – administrators may merge them with _Replace with…_;
- without an e-mail address, the same name (and details) is one contact only within the same item (a site, a supplier);
- one audit entry per kind (`contact.created` by _system_) counts the contacts, items and links.

Nobody gains sight of a contact: a contact holds only what the entries it was made from showed, and is seen by who saw one of those items. `server/test/contacts-upgrade.test.ts` checks that every service, supplier and plant site shows the same contacts through its read paths after the upgrade of the newest upgrade fixture, and that no user sees a contact they could not see before.

## Upgrade to 0.26.0

- The built-in roles are part of the catalogue from the start, with their keys and kinds: no link changes.
- Each distinct **free-text role of plant sites** (letter case and spaces aside) becomes an own role for plant sites – an own role of that label an administrator made already is used – with the text as its English and German label, and the links name its key. Once, when the vault is first opened (and after a migration package of an older version is imported); a second run finds nothing to do. Audited once as `contact.role_created` by _system_ with the roles and links. The plant registry's page, files, `/api/v1`, MCP and change sets show the same texts as before; variants that differed only in letter case show as the most used one, and a contact named twice in two such variants is named once. A contact without a role stays without.
- A role made from a site's text was seen only by who saw the site: until an administrator saves it, the catalogue lists it only for who may see a site that names it. `server/test/contact-roles-upgrade.test.ts` checks the texts every user sees before and after on the newest upgrade fixture.
