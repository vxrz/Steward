# Help and support: channels, support levels and guides

Since 0.26.0 ([ADR 0039](adr/0039-contact-roles-and-support.md) parts 4–8) data products, services and applications say **where their users ask, report a problem and find documentation, and what support is promised**. Steward documents this – for the IT maintainers, for audits, and for the catalogues and portals it exports to (ODPS, `/api/v1`, Git sync). It is not a help desk: it measures nothing and routes no tickets.

Every data product, service and application page has a **Help and support** section: its channels first, then its support level with what the level promises, then – for data products – its guides.

## Channels

A channel is a shared place to go:

| Field       | What                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| **Purpose** | _Questions_, _Issues and incidents_, _Announcements_, _Access and onboarding_                          |
| **Tool**    | _Ticket system_, _E-mail_, _Microsoft Teams_, _Slack_, _Web page_, _Phone_, _Other_ (shown as an icon) |
| **Name**    | What people call it: _#orders-data_, _Data desk_                                                       |
| **Address** | `https://…` (also `http://` for internal pages), `mailto:…` or `tel:…` – shown as a link               |
| **Hours**   | When it is staffed: the incident queue may run 24×7, the mailbox business hours                        |
| **Note**    | The queue, category or assignment group to use                                                         |

A channel needs a name or an address (the upgrade's channel of a product that had only support hours has only its hours: the editor asks for a name when it is changed). An item has at most 20, in the order you give them – put the one people should try first at the top.

**Channels name shared addresses, not people.** A team mailbox, a ticket queue, a Teams channel – never someone's own address: people change jobs and go on holiday. People are [contacts](CONTACTS.md); the editor says so.

## Support levels

Administrators keep a short list under **Settings → Support levels**: a name in English and German, the **hours**, **one first-response time** (as text: _4 hours within the hours_, _next business day_), a note and optionally a link to the **SLA document**. A data product, service or application picks one; its page shows what the level promises.

- A level documents what the providing team offers. Steward does not measure it.
- Response times per priority belong to the ticket system and the SLA document, not here.
- **Criticality is separate**: it says how bad an outage is; the support level says what support is promised. A critical product may still be supported only in business hours – and the page then shows exactly that.
- Administrators add, change, order and remove levels (audited `support.level_created`, `…_updated`, `…_reordered`, `…_deleted`). A level in use is removed only after saying which level its items get instead (merging two levels) or that they get none.
- Every signed-in reader sees the list (the pickers need it); the number of items that use each level is shown to administrators.

A new installation starts with three example levels – _Business hours_, _Extended_, _24×7_ – for administrators to change or remove. They are made once: removed, they do not come back.

## Guides (data products)

Guides and documentation for the consumers of a data product are recorded as **where the consumers find them** – a wiki, SharePoint or portal page: a title and an external `https://` address (`http://` is taken for internal pages), at most 30. Steward's own living documents can still be linked to a product as internal IT documentation; they are not consumer guides, because consumers usually cannot open Steward.

## A data product supported by a service

A data product can name the **service that supports it** (_Supported by service_ in the editor). Its page then shows that service's channels and support level, marked _From the service …_, wherever the product names none of its own – a product with its own channels shows those, one with its own level shows that.

This works only for readers who may see the service. For anyone else the service is neither shown nor named – not on the page, not in `/api/v1`, MCP, the file export or ODPS – and an editor who may not see it keeps it when changing the product's other support (to choose a new one, pick it). Naming a service you may not see is refused like a missing one (`SERVICE_NOT_FOUND`).

## Who may do what

- Channels, the level, guides and the supporting service change with the **item's edit right** and are seen with its **view right** – team scope as everywhere: a reader never sees, counts or is told about items they may not see.
- A change is audited like other field changes of the item (`dataproduct.updated`, `service.updated`, `application.updated`, with the fields `supportChannels`, `supportLevel`, `guides`, `supportedByService` and their before and after).
- The level catalogue is the administrators'.

## Exchange

- **`/api/v1` and MCP:** data products carry `supportChannels`, `supportLevel` (name, German name, hours, first response, note, SLA document), `guides` and `supportedBy` (the service with its channels and level, or null); services and applications `supportChannels` and `supportLevel` (`/api/v1` only – MCP has no tools for services and applications). Lists show the level.
- **File format and Git sync:** `support_channels`, `support_level` (by name – English or German; the export also writes its hours and first response), `guides` and `supported_by_service` (by name). A level the instance does not have is a problem of the preview (`SUPPORT_LEVEL_NOT_FOUND`): an administrator adds it first.
- **ODPS v1.0.0** (export and import, checked against the vendored schema):

  | Steward                                    | ODPS                                                                                                         |
  | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
  | each channel with an address               | an entry of `support[]`: `channel` = name, `url` = address (a `tel:` number with hyphens for spaces), `tool` |
  | purpose questions / issues / announcements | `scope`: `interactive` / `issues` / `announcements`                                                          |
  | purpose access and onboarding              | no scope; `customProperties: [{ property: purpose, value: access }]` on the entry                            |
  | hours and note                             | `description`: `Hours: …` on its first line, then the note                                                   |
  | the support level                          | `customProperties` of the product: `supportLevel` with `name`, `hours`, `firstResponse`                      |
  | guides                                     | `authoritativeDefinitions` with `type: userGuide` (`description` = title)                                    |
  | the supporting service                     | `customProperties` of the product: `supportedByService` = its name                                           |

  The export carries what the page shows – a product's own channels and level, else those of its supporting service the reader may see. Channels and a level taken from the supporting service are **marked** with it (`supportedByService` in the entry's `customProperties`, and in the value of `supportLevel`), so catalogues see what applies and an import does not make them the product's own: it leaves the product without own channels or level and names the supporting service instead – when exactly one service of that name is one the importer may see; otherwise the preview says so and the service is not changed. The deprecated `supportTier` is still written (0.26 only) for a product's own level made from a tier. The import reads the rest back; a level whose name the instance does not have, and an address that is not `https://`, `http://`, `mailto:` or `tel:`, are hints of the preview and left out.

## Upgrade

Until 0.25 a data product had one free-text _Channel_, a web address and _Hours_, plus a bare _support tier_ 1–3. At the upgrade to 0.26.0 – once, when an administrator unlocks the vault (and after a migration package is imported), as the system:

- each product's single support channel becomes **one channel** with the purpose _questions_ – tool _e-mail_ for a `mailto:` address, else _other_ – with its hours;
- the tiers in use become the levels **Tier 1**, **Tier 2** and **Tier 3** – in German **Stufe 1** to **Stufe 3** – (only those in use), picked by their products – for administrators to rename or merge (_Settings → Support levels_, remove with _Replace with_). Nothing is guessed;
- each product converted is audited (`dataproduct.support_converted`), each level made as `support.level_created`; a second start changes nothing;
- an installation without any tier gets the three example levels instead.

`tier` and `support` stay readable on the API for one more release, **deprecated and derived**: `tier` from the level (the tier a level was made from, else null), `support` from the first channel with the purpose _questions_. A client that still sends them is understood as the upgrade does: `support` sets (or, empty, removes) the first channel for questions, `tier` picks the level _Tier n_ (_Stufe n_, made when missing); sending back what was read changes nothing, and leaving them out keeps the channels and the level. The same holds for `support:` and `tier:` in files.

## Storage

`support_levels` (the catalogue), `support_channels` and `guides` (polymorphic: kind and item, with their position), `support_level_id` on data products, services and applications, and `supported_by_service_id` on data products – migration `support-001-channels-levels`. They are part of backups and migration packages – a new instance's untouched example levels give way to the package's levels, and a package from before 0.26.0 is upgraded after the import as described above; a deleted data product's channels and guides go with it (services and applications are archived, never deleted).
