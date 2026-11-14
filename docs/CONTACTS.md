# Contacts

Steward keeps one **contacts directory** (0.25.1, [ADR 0038](adr/0038-documented-governance-contacts.md)): the people and groups items name for their business side – the business and IT contacts of a [service](RECORDS.md#service-catalogue), the people at a [supplier](SUPPLIERS.md#contacts-and-data-protection), the contacts of a [plant site](PLANT.md), and the owners, stewards and consumer contacts of [data products](DATA-PRODUCTS.md). A person who is the business contact of 15 items is one entry, found in one place and replaced in one step when they leave.

A contact is a **person** or a **group** (a shared mailbox, a board, an office) with a name, e-mail address, phone, organisational unit, a web address and – optionally – the Steward account they are. A contact is _active_ or _left_: a contact who has left stays where it is named and in documented decisions, but is offered nowhere new.

**A contact never gives a right in Steward**, also when it is linked to a Steward account. Rights come only from roles, owning teams and shares ([ADR 0033](adr/0033-one-access-model.md)).

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

Contacts are in backups (the database) and in migration packages; a contact's Steward account is mapped to the target's account on import. The where-used page of a contact is the overview of that person's data for a subject access request.

## For developers

The directory is core (`server/src/contacts/`, `shared/src/contacts.ts`), not a module. A module names contacts on its items through:

- `registerContactKind(kind, def)` – or `contactKinds` in its feature manifest – with `visibleIds(u, itemIds)`, `canChange(u, itemId)`, `names(itemIds)`, `href(itemId)` and optionally `onLinksErased(itemIds)`. A kind nobody registered is seen by administrators and auditors only.
- `linksOf(kind, itemIds, { surface })` – the contacts of many items in one statement, in the shape `CONTACT_EXPOSURE` allows on the surface (`app`, `api`, `export`, `file`).
- `setLinks(kind, itemId, links, { roles })` – replaces an item's contacts (of those roles) in the caller's transaction; `removeItemLinks(kind, itemId)` when an item is deleted.
- `snapshotsOf([{ contactId, role }])` – the frozen `ContactSnapshot`s of a documented decision (visible, active contacts only).
- `contactForUser(name)`, `contactForGroup(name)`, `importContact(input)` – find or make a contact (upgrades, imports).
- `registerContactHooks({ countDecisions, onErased })` – the documented decisions that name a contact (counted on its page) and nulling an erased contact's id in frozen snapshots.

In the web app, `web/src/components/contacts/` has the `ContactPicker` (an item's contacts with their roles), the `ContactSnapshotPicker` (who decided), the `ContactForm` and `ContactLinksView`.
