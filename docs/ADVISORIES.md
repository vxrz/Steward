# Security advisories for OT devices

Since 0.14 the [plant registry](PLANT.md) reads **security advisories** of device vendors and CISA in the OASIS **CSAF 2.0** format (Common Security Advisory Framework) and matches them to the assets of your sites by **manufacturer, model and firmware**: which assets of which sites and zones are affected, how badly, and which firmware fixes it. Matching is **conservative and explained** – only an exact match counts; anything weaker is shown apart as a _possible match_ for a person to confirm or dismiss. Per affected asset people record the **remediation** (planned, mitigated, accepted risk …), and new high or critical matches notify the managers of the site.

It is part of the plant registry (preview): only while the module is on, with the registry's rights. Advisories come from **sources** an administrator sets up – **none by default**, Steward reads nothing from the internet until someone adds one – or are **uploaded** as files, which is how plants without internet access work.

- [Sources](#sources)
- [Uploading files (offline plants)](#uploading-files-offline-plants)
- [What Steward reads from a document](#what-steward-reads-from-a-document)
- [Matching](#matching)
- [Statuses: matches, remediation, sites](#statuses-matches-remediation-sites)
- [Pages](#pages)
- [Notifications](#notifications)
- [Rights](#rights)
- [API and assistants](#api-and-assistants)
- [Limits](#limits)
- [Demo and examples](#demo-and-examples)
- [What CSAF facts this relies on](#what-csaf-facts-this-relies-on)

## Sources

_Plant → Advisories → Sources_ (administrators): a source is one address, and its kind follows from it. **Adding, changing or removing a source asks you to confirm it is you** (step-up, control point `plant.advisorySources` of the [assurance policy](ASSURANCE.md), on by default) – as other administrator settings that make Steward fetch from the internet; it needs a signed-in session (an API token cannot), and the audit entry (`plant.advisory_source_added`, `…_changed`, `…_removed`) names the control point. _Read now_ and uploading files ask for nothing.

| Address                                                                                                    | Kind       | What Steward reads                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a provider's `provider-metadata.json` (usually `https://<vendor>/.well-known/csaf/provider-metadata.json`) | provider   | the **ROLIE feeds** it lists with TLP:WHITE, GREEN or unlabelled (CSAF 2.0 requirement 15); a provider without ROLIE feeds: its **directory** distribution, through `changes.csv` (requirements 11–13), newest first |
| an aggregator's `aggregator.json` (usually under `/.well-known/csaf-aggregator/`)                          | aggregator | the `provider-metadata.json` of the providers and publishers it lists – at most 20 per run; _Only publishers_ narrows it to those whose name contains one of the given words                                         |
| anything else (a `.json` file)                                                                             | ROLIE feed | the documents of one feed                                                                                                                                                                                            |

Each source is read on its own schedule (_Read on a schedule_, every 1–168 hours, default 24) by the job `plant-advisories`, or with _Read now_. A run reads the documents that are **new or changed** since the last run (the feed's `updated`, or the date in `changes.csv`) – at most 200 per run, newest first; _Only documents released since_ leaves older ones out. A failed document is tried again on the next run; the source shows the last error.

**Integrity.** Where the feed lists a hash file (`rel: hash`), or the directory has `<file>.sha512` or `<file>.sha256`, Steward fetches it and keeps the document **only if the hash matches** (requirement 18: the file starts with the hexadecimal hash). The advisory page says which hash was checked, or that the provider publishes none. An OpenPGP signature (`.asc`, requirement 19) is noted and linked but **not checked yet** – Steward has no OpenPGP library; checking it is planned.

**Outbound policy.** Every request – the metadata, the feed, `changes.csv`, each document and hash file, and every redirect hop (at most 3) – goes through the [outbound policy](SECURITY-HARDENING.md#outbound-connections) like a process step: address safety always, and under the default policy `platforms` a provider's host needs an **allow-list entry** (_Settings → Security & sign-in → Outbound access_) unless it is a configured platform's origin. Only `GET`, no credentials, 30 seconds and a size limit per answer. A refused request says so on the source (_Blocked by the outbound policy: …_). Typical entries: the vendor PSIRT hosts you read, and for CISA's advisories the host of its provider metadata.

**TLP.** Documents marked TLP:AMBER or RED are not kept (everyone who sees the registry would read them); feeds of those labels are skipped.

Which feeds to use is your decision – for example the PSIRTs of the vendors whose devices you run, or CISA's advisories (its CSAF provider metadata is linked from [github.com/cisagov/CSAF](https://github.com/cisagov/CSAF); CISA also republishes vendors' documents). Steward ships with none turned on.

## Uploading files (offline plants)

_Plant → Advisories → Upload CSAF file_ (designers and administrators): a CSAF 2.0 document as JSON, up to 4 MB. The same document again changes nothing; a **newer release** (a later `current_release_date`) replaces the stored one and keeps the decisions; an older release does not replace a newer one. `POST /api/plant/advisories/upload` takes `{ content, fileName, sha256 }` – with `sha256` (the hash the vendor published) the upload is refused when the file differs (`PLANT_ADVISORY_HASH`). Every upload is audited (`plant.advisory_added`, `plant.advisory_updated` with the SHA-256 of the file).

For an air-gapped plant: download the advisories and their `.sha256` files on a connected machine, carry them over, and upload each with its hash.

## What Steward reads from a document

The document is checked against the part of the CSAF 2.0 JSON schema Steward needs (zod, bounded): `document` with `category`, `csaf_version: "2.0"`, `publisher` (category, name, namespace), `title` and `tracking` (id, version, status, initial and current release date, revision history); the **product tree** (branches, `full_product_names`, `relationships`); and the **vulnerabilities** (CVE, CWE, notes, product status, remediations, scores, threats). Unknown properties are left out, not kept. A document is identified by its publisher's namespace and tracking id. Steward keeps the file as received (download it from the advisory page) and what it read from it.

- **Products**: the branches give vendor › product family › product name › version (`product_version`) or range (`product_version_range`); `model_numbers` of the identification helper count as model names (with `*` and `?` as wildcards); a full product name outside the tree is read through its CPE (vendor, product, version); a relationship (_firmware installed on a device_) is the device's model with the firmware's version or range.
- **Product status**: `known_affected`, `first_affected` and `last_affected` are affected; `under_investigation` can only give a possible match; `fixed`, `first_fixed` and `recommended` give the fixed firmware; `known_not_affected` and `fixed` versions of the same model never match.
- **Severity**: the highest CVSS base score of its vulnerabilities (v3, else v2) with the CVSS v3 rating (critical ≥ 9.0, high ≥ 7.0, medium ≥ 4.0, low > 0); without scores the document's `aggregate_severity` (Critical, Important → high, Moderate → medium, Low), else _unrated_.
- **Remediations**: their category (vendor fix, mitigation, workaround, none available, no fix planned), details and link (only `http` and `https` links are kept).

## Matching

Every asset that is not decommissioned is compared twice: with **its own manufacturer and model**, and with those of **its device profile** (the controller; a derived profile without them takes its base's). The **firmware** is the asset's assignment's _controller firmware_ – it belongs to the profile's device when the asset has a profile, else to the asset; a profile's own version (the firmware it describes) stands in when the assignment names none and is a single version (`3.x` is not).

| Part     | Exact                                                                                                                                                                                          | Possible only                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Vendor   | the same (case and spaces ignored), or the same once **normalised**: letters and digits only, legal forms (GmbH, AG, KG, SE, Inc., Ltd., LLC, Corp., Co., S.A., B.V. …) and "&"/"and" left out | one contains the other (at least 4 characters)                           |
| Model    | the product name (or family + name), the same or normalised – letters and digits only: `PM 200` = `PM-200` = `pm200` – or one of its model numbers                                             | one contains the other (`ZX 100 Pro` and `ZX-100`)                       |
| Firmware | equal to the product's version, inside its range, or the product has no version (all versions)                                                                                                 | not recorded; a range Steward does not read; product under investigation |

**Version ranges.** `vers` in its canonical form (CSAF 2.0 §3.1.2.3.2, option 1): `vers:<scheme>/<constraints>` with `<`, `<=`, `>`, `>=`, `=`, `!=` separated by `|`, evaluated by the vers specification's algorithm, `vers:all/*` for all versions. The scheme picks the comparison: `npm`, `cargo`, `golang`, `nuget`, `semver` → SemVer; `pypi` → PEP 440; `maven` → Maven; anything else (`generic`) → numbers separated by dots, a leading `V` ignored, a pre-release word (`beta`, `rc` …) before its release. Vers-like constraints (option 2, "best effort"): `<V3.0.29`, `>=8.1.5`, `<=2`. And the free text advisories still use: _All versions_, _All versions < V3.0_, _prior to 4.2_, _before 4.2_, _4.2 and later_, _1.0 - 2.0_, a constraint followed by words (`<V4.00_Utilizes_…`). Anything else is _not understood_ and can only give a possible match.

**Exact** – vendor, model and firmware all exact, for an affected product – is a match that **counts**. Everything else is a **possible match**, listed apart and **never counted** until someone confirms it. Each match says why, in one line: _matched on vendor Example Controls, model C80, firmware 3.2.0 in vers:generic/>=3.0.0|<3.4.0 via device profile example-controls-c80_. The advisory page also lists the **device profiles** whose manufacturer and model it names.

**Fixed firmware**: the versions of fixed (or recommended) products of the same vendor and model in the same vulnerability, above the asset's firmware; without them the upper end of the affected range (`<3.4.0` → 3.4.0, marked _end of the affected range_).

**When matches change.** An advisory is matched when it arrives, and all advisories again whenever an asset, an assignment or a device profile changed – so updating an asset's firmware past the fix ends its match. That rematching runs in **bounded batches**, newest advisories first: a page that is read matches at most 100 advisories (about a second) first, and the job `plant-advisories` goes on for up to 20 seconds per run, every 5 minutes, and resumes where it stopped (each advisory remembers the plant data it was matched against). With a few hundred advisories the pages follow at once; after a large feed's first read (thousands of documents) the matches complete over the next job runs. Advisories that name no vendor any asset has are skipped without reading them. A match that no longer holds keeps its decisions and remediation (they are back if it matches again) but no longer counts.

## Statuses: matches, remediation, sites

- **A match**: _confirm_ (a possible match then counts) or _dismiss_ (with a reason; an exact match then no longer counts), and take a decision back – audited on the asset (`asset.advisory_confirmed`, `asset.advisory_dismissed`, `asset.advisory_decision_reset`).
- **Remediation** of each affected asset: _open_ (the default), _planned_ (link a maintenance window or a plant change set), _mitigated_, _accepted risk_ (with a reason and the day it ends – at most three years; past that day it counts as open again) and _not affected_ (with a reason). The fixed firmware the advisory names is suggested. Audited as `asset.advisory_remediation_set` with the values before and after.
- **A site**: _Not applicable at <site>_ with a reason (for example: the devices are on a network the vulnerability cannot reach) – its matches no longer count for that site and it gets no notifications for it; _Applies again_ takes it back. Audited on the site (`site.advisory_not_applicable`, `site.advisory_applicable`).
- **The advisory**, for the reader's sites: **open** (an affected asset is open, planned or its accepted risk ran out), **mitigated** (every affected asset is mitigated, accepted or not affected), **not applicable** (the sites with matches marked it so) or **no asset affected** (possible matches may still wait).

## Pages

- **Plant → Advisories**: the advisories (by default those affecting your sites; switch it off for all) with severity and CVSS, the affected assets (still open; possible matches apart), sites, zones (with their SL-T), first released, updated and status. The list is **filtered, sorted and paged by the server** – 50 at a time with _Load more_ –, so thousands of advisories stay quick: filters by site (the counts are then that site's), severity, status, vendor (compared normalised) and a text (title, tracking id, publisher, CVE), sorting by severity (the default, with CVSS), updated, first released, affected assets and title; filters and order are in the address; cards on phones.
- **The advisory page**: the summary; the **affected assets by site and zone** – each zone with its target security level (IEC 62443-3-2 SL-T, _SL-T open_ without one; an asset is in the zones of its devices' VLANs) – with the reason, the fixed firmware and the remediation; **possible matches** to confirm or dismiss; dismissed ones; the vulnerabilities with CVSS vector, CWE, exploitation and remediations; the matching device profiles; the products; where the document came from, how it was checked, its links and the file itself. A site's managers mark it _not applicable_ there.
- **The asset page**: the section **Advisories** – every advisory that matches the asset (counted, possible and dismissed) with the reason and the remediation; open while one of them is open.
- **The start page**: the tile _Advisories affecting your sites_ – open advisories, critical and high ones, the assets to deal with per site and the possible matches to confirm – when there is any.

## Notifications

A new **exact** match of an advisory rated **high or critical** notifies the **managers of the asset's site** – event **`plant.advisory_matched`** ([NOTIFICATIONS.md](NOTIFICATIONS.md)), one message per advisory and site with the affected assets, through the event's routes (in the app and by e-mail by default) and the site's owning teams' channels. Quiet hours and digests apply (digest group _reminders_). Each match notifies once; possible matches (also when someone confirms one – they know), lower severities and sites that marked the advisory _not applicable_ never do.

## Rights

| Who                                                                                                | May                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| everyone who sees the plant registry (plant viewers included)                                      | read advisories (published documents); see matches, decisions and remediation of the **sites they may see** |
| who manages a site (designers and administrators by default, the site's access list, owning teams) | confirm and dismiss its matches, record their remediation, mark an advisory not applicable there            |
| designers and administrators (who manage the catalogues)                                           | upload and remove advisories                                                                                |
| administrators                                                                                     | add, change, read and remove sources                                                                        |

Matches at sites someone may not see are counted (_2 more matching assets are at sites you may not see_), never named – in the pages, `/api/v1` and the MCP tools alike. Status viewers never reach advisories.

## API and assistants

- Internal API (the web app): `GET /api/plant/advisories` (`site`, `status`, `severity`, `vendor`, `q`, `affecting`, `sort` – `severity`, `updated`, `published`, `affected`, `title` –, `order`, `offset`, `limit` up to 200; answers `items`, `total`, `nextOffset`), `GET /api/plant/advisories/summary`, `POST /api/plant/advisories/upload`, `GET|DELETE /api/plant/advisories/:advisoryId`, `GET …/:advisoryId/document`, `PUT …/:advisoryId/assets/:assetId/decision` (`{ decision: confirmed | dismissed | null, reason }`), `PUT …/:advisoryId/assets/:assetId/remediation` (`{ status, reason, until, windowId, changeSetId, note }`), `PUT …/:advisoryId/sites/:siteId` (`{ notApplicable, reason }`), `GET /api/plant/assets/:assetId/advisories`, and `GET|POST /api/plant/advisory-sources`, `PUT|DELETE …/:advisorySourceId`, `POST …/:advisorySourceId/fetch` (administrators; `POST`, `PUT` and `DELETE` of a source ask for a step-up).
- Public API (read, [API.md](API.md)): `GET /api/v1/plant/advisories` (paged with a cursor; `site`, `status`, `severity`, `vendor`, `all`, `sort`, `order`), `GET /api/v1/plant/advisories/{advisoryId}` (the matches with their reasons, fixed firmware and remediation) and `GET /api/v1/plant/assets/{assetId}/advisories`.
- MCP ([MCP.md](MCP.md#plant-registry)): `list_plant_advisories` (the advisories affecting a site, most severe first) and `get_plant_advisory` (one advisory with its affected assets and possible matches).

## Limits

| What                                                                    | Limit                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| A document                                                              | 4 MB                                                           |
| Products of a document (tree leaves, full product names, relationships) | 5,000                                                          |
| Branches of the product tree, and their depth                           | 20,000, 30 levels                                              |
| Vulnerabilities                                                         | 500, each with up to 200 remediations and scores               |
| Product ids in one list                                                 | 10,000                                                         |
| Notes, references                                                       | 200, 500; each text is cut at 20,000 characters                |
| Sources                                                                 | 50; each run at most 200 documents; an aggregator 20 providers |
| Answers of providers (metadata, feeds, `changes.csv`)                   | 8 MB; hash files 4 KB; 30 seconds each                         |
| Reasons and notes people write                                          | 2,000 characters                                               |
| A page of the list                                                      | 50 in the web app; up to 200 in the API                        |
| Matching after plant changes                                            | a read: up to 100 advisories (1 s); the job: 20 s per run      |

## Demo and examples

`examples/plant/advisories/` holds three **invented** CSAF documents for the demo enterprise's invented devices (upload them to try it out):

- `exctl-sa-2026-001.json` – _Example Controls C80_ controllers, firmware 3.0 up to 3.4 (vers range), high: an exact match for milling centre 2 (firmware 3.2.0, through its device profile), none for milling centre 1 (3.4.2);
- `exmet-sa-2026-003.json` – _Example Meters Ltd._ _PM-200_, critical: the meter of milling centre 1 matches after normalising vendor and model;
- `expm-sa-2026-007.json` – _Example Plastics Machinery GmbH_ _MC 6 Controller_ and the _IM 250_ under investigation: possible matches only, to confirm or dismiss.

In the demo (`npm run demo`) turning the plant registry on also adds the source _Example PSIRTs (demo)_ – a simulated provider at `/mock/csaf/.well-known/csaf/provider-metadata.json` with a ROLIE feed, SHA-256 files and a directory distribution – and reads it once.

## What CSAF facts this relies on

Checked against the CSAF 2.0 JSON schemas (`csaf_json_schema.json`, `provider_json_schema.json`, `aggregator_json_schema.json`) and the CSAF 2.0 prose in the OASIS repository [oasis-tcs/csaf](https://github.com/oasis-tcs/csaf), and a CISA advisory from [cisagov/CSAF](https://github.com/cisagov/CSAF): the required properties and enumerations above, `product_version_range` with vers or vers-like constraints (and that CISA documents write free text such as `<V4.00_…`), the provider metadata's `distributions` with `directory_url` and `rolie.feeds` (`tlp_label`, `url`), the aggregator's `csaf_providers` and `csaf_publishers` with `metadata.url`, the ROLIE feed's `entry` with `content.src` and `link` (`self`, `hash`, `signature`), the hash file format, `changes.csv` and `/.well-known/csaf/provider-metadata.json`. Not checked against a live provider from here: the current addresses of vendor PSIRTs and of CISA's provider metadata – check them in the provider's own documentation before adding a source.
