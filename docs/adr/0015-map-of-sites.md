# 0015. A map of sites, with tiles served through Steward

- **Status:** Accepted
- **Date:** 2026-11-07
- **Since:** 0.10.0 (#234); extends [0007](0007-plant-registry.md)

## Context

Installations with the plant registry want to see all their sites on a map, with their status, and jump from a pin into the site and its views (#230). Sites already have a position: `geo` (lat, lon, zoom) in `plant_sites`, checked by `geoInput` in `server/src/plant/model.ts`, set by hand or by the import. Today the site page shows it as text with a link that opens openstreetmap.org in a new tab (`web/src/components/plant/common.tsx`). No map library is loaded.

The owner's direction: OpenStreetMap by default, maybe with styles; an own tile source or a self-hosted PMTiles file for networks without internet access; or off.

What constrains the design:

- **Content security policy** (`contentSecurityPolicy()` in `server/src/app.ts`): `default-src 'self'`, `script-src 'self'`, `img-src 'self' data: blob:`, `connect-src 'self'` plus the error reporting host, `worker-src 'self'`. The policy is built once at start-up; it does not change with settings.
- **Referrer policy** is `no-referrer` on every response. OpenStreetMap's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) asks web pages to send a valid `Referer`, apps to send a `User-Agent` that names them, everyone to cache tiles, to show the attribution, and not to bulk-download. It is meant for light use, has no service level, and blocks without notice.
- **The outbound policy** (`platforms/outbound.ts`) governs what the _server_ sends: address safety always (no cloud metadata, no link-local, not Steward's own port, the address pinned against DNS rebinding), and the origin policy (`platforms`, `allowList`, `open`). What the _browser_ fetches is limited only by the CSP.
- **Privacy** ([PRIVACY.md](../PRIVACY.md)): Steward keeps personal data in, and error reporting is off by default and sends no IP addresses. A browser that loads tiles from a provider gives it the user's IP address and the area they look at.
- **Rights** ([0007](0007-plant-registry.md)): a site follows `decide()` with its access list; assets follow their site; the _Plant viewer_ role sees only the registry; status viewers never reach it; status pages never show it; a hidden site is never named or counted.
- **Pictures have a table twin** ([PLANT.md](../PLANT.md), visualizations of 0.8.0): _Picture_ or _Table_ above each view, phones start with the table, status as icon and word, keyboard focus, light and dark, axe clean, `prefers-reduced-motion` respected.
- **Dependencies** are taken at least two weeks after their release ([SECURITY-PIPELINE.md](../SECURITY-PIPELINE.md); Dependabot cooldown 14 days).
- **OT networks** often have no internet access, neither for the server nor for the browser.

## Decision

### The map library

- **MapLibre GL JS 6.15.0** (BSD-3-Clause, released 2026-10-18; 6.16.0 of 2026-10-25 is younger than two weeks), pinned `~6.15.0` like the other web dependencies. Its own dependencies are ISC, MIT or MIT-or-Apache-2.0; `NOTICE` lists them.
- Checked in the 6.15.0 package: it is an ES module, its worker is a separate module (`maplibre-gl-worker.mjs`) started from the same origin without a `blob:` URL, and it uses no `eval` or `new Function`. Sprite images are decoded from `blob:` URLs, which `img-src` already allows. So **the CSP stays as it is**: Vite emits the worker as an asset and `setWorkerUrl()` points at it.
- It draws raster and vector tiles, light and dark, and needs WebGL 2. Without WebGL 2 the page shows the list and says why.
- It is loaded only on the map page, the dashboard widget and the position picker (`lazy()`, own chunk), as the Vega charts are.
- **Not Leaflet:** it draws raster tiles only. Vector styles that follow the theme and self-hosted vector tiles would need plugins.

### Tiles come through Steward

The browser never talks to a tile provider. It loads a style, tiles, glyphs and sprites from Steward, and Steward fetches what it does not have (decided after review, question 1):

- `GET /api/plant/map/style.json` – a MapLibre style that Steward builds for the chosen source, with every URL pointing back to Steward.
- `GET /api/plant/map/tiles/:layer/:z/:x/:y`, `…/glyphs/:fontstack/:range.pbf`, `…/sprite/:name` – served from the cache, from the PMTiles file, or fetched from the source.

What this gives:

- **The CSP does not change** with the setting, and no third-party origin is ever in it.
- **No user's IP address reaches the provider**; it sees Steward's address and the tiles requested.
- **An API key stays on the server.** It is added by Steward to the upstream request; the browser never sees it.
- **The tile policy is met:** Steward sends `User-Agent: Steward/<version> (+https://github.com/vxrz/Steward)`, caches tiles as their caching headers allow, and never prefetches. The `no-referrer` policy can stay.
- **One path for every source**, a PMTiles file included.

How the server fetches (`server/src/plant/mapTiles.ts`):

- Only `GET`, no cookies, no body, no redirects to another origin. Address safety always applies (`guardedLookup`).
- **The source's origins are allowed for the map fetcher only**, as a platform's origins are for that platform. They are not added to the allow-list, so processes cannot use them. _Settings → Outbound access_ lists them under _Map tiles_.
- Answers are checked: content type (PNG, JPEG, WebP, vector tile, JSON), at most 2 MB per tile and 1 MB per style or sprite file, 10 seconds. Served with `X-Content-Type-Options: nosniff`.
- At most 4 parallel upstream requests per source, 2 for `tile.openstreetmap.org`.
- **Cache** in `<data>/cache/map/`, least recently used out, at most `SM_MAP_CACHE_MB` (default 256). Tiles up to zoom 12 are shared between users. Above zoom 12 the cache key includes the user, and responses are `Cache-Control: private`. Otherwise someone could time tile responses to learn where others have looked closely – near sites they may not see.
- **Who may load tiles:** signed-in users who see the plant registry, in a browser session. API tokens and status viewers get 404. A rate limit per user (600 tiles a minute, `rateLimits.ts`) stops bulk downloads through Steward.
- A source that fails shows the list with _The map could not be loaded_ and, for administrators, the reason.

### Map styles

_Settings → Plant registry → Map_ (internal setting `plant.map`, administrators):

| Style              | Tiles                                                                                 | Attribution, always shown                      |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| _OpenStreetMap_    | raster, `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, zoom 0–19                   | © OpenStreetMap contributors                   |
| _Light_ and _Dark_ | vector, OpenFreeMap (no key, OSM data), following the theme (decided, question 3)     | OpenFreeMap © OpenMapTiles, © OSM contributors |
| _Own tile source_  | a raster URL template (`{z}`, `{x}`, `{y}`) or a MapLibre style URL; optional API key | text the administrator enters (required)       |
| _Self-hosted file_ | a PMTiles file in `<data>/maps/`, raster or vector                                    | from the file's metadata, else entered         |
| _Off_              | none: the list only                                                                   | –                                              |

- **OpenStreetMap in the dark theme** is dimmed with MapLibre's raster paint settings, not inverted (inverted maps mislead).
- **The light and dark styles are Steward's own**, generated at build time and following the theme's colours: for OpenMapTiles-schema sources (OpenFreeMap, many own servers) and for the Protomaps schema of PMTiles files (generated with `@protomaps/basemaps` 5.7.2, BSD-3-Clause, released 2026-03-10, a development dependency only).
- **An own style URL** is fetched by the server when saved (and on _Reload style_). Steward keeps its sources and layers and rewrites every tile, sprite and glyph URL to its own paths. The origins in it become the source's origins, shown before saving.
- **The API key** is stored in the vault, sent as a query parameter or header the administrator names, and never shown again.
- **The self-hosted file** is placed in `<data>/maps/` by whoever runs Steward. It is not uploaded: regional extracts are hundreds of megabytes (`pmtiles extract` from a Protomaps build). Steward lists the files it finds there. The server reads tiles from the file with **pmtiles 4.5.0** (BSD-3-Clause, released 2026-08-10, one dependency: fflate, MIT) through a small file source with byte ranges. The browser never downloads the whole file. Steward ships the glyphs and sprites its styles need, so the self-hosted file works with nothing else; their licences are checked before they are added (the fonts are under the SIL Open Font License).
- **The map is off until an administrator turns it on** (decided, question 2): _OpenStreetMap_ is preselected, so it is one click with the privacy note in view; nothing leaves Steward before that.
- **Changing where tiles come from** (a new style, URL, key or file) is a step-up action, like changing the outbound policy (`changeSignInSettings`, control point `signIn.settings`), in a signed-in session. Every change is audited (`plant.map_settings_changed`, with the old and new origins, never the key).
- The settings page says what each style sends where: _OpenStreetMap_ and _Light/Dark_ send tile requests from Steward's server to the provider; _Self-hosted file_ and _Off_ send nothing outside.

### The map page

- **Plant → Map**: the list of sites and the map side by side. Phones start with the list (_Picture_ / _Table_ as in the other views). Every filter of the site list applies to both.
- **Pins** are HTML buttons in list order, so Tab moves through them and Enter opens the card. Each has an icon and a word for its state and an accessible name (_Riverside Works, RVS, 2 checks failing_). Never colour alone.
- **A site's state** is the worst of its assets' live status and its failing plant checks, by [0007 part 3](0007-plant-registry.md#part-3-ot-network-080)'s rules: offline wins, unknown is never shown as online, a site nothing watches is drawn neutral.
- **Clusters** when zoomed out, also buttons (_12 sites – zoom in_), counting only sites the reader sees. At most 2,000 sites are drawn; the list names all.
- **The card** on a pin: name, code, assets by status, KPI coverage, open checks, and a link to the site and its views.
- **Show on map** on the site page uses the site's own zoom.
- `prefers-reduced-motion` and _Animation off_ turn off fly-to animations. Light and dark themes; axe clean on desktop and phone.
- **Position picker** on the site page: click on the map, or type latitude and longitude (always possible, also with the map off). Same validation as today (`geoInput`).
- **Dashboard widget _Sites map_**: the same component, small, for readers of the plant registry. Others see _not visible_, as for other hidden widget content. Never on status pages.

### Data and rights

- `GET /api/plant/map/sites` returns the sites the reader may see, with position, state and counts. Clusters are made in the browser from that answer only, so a hidden site gives no pin, no count and no tile request from the browser.
- Who sees a site sees its position, as on the site page today (decided, question 4).
- No new table. The setting is one row in `settings`; the API key a vault-encrypted setting. The cache is a folder that backups and migration packages leave out.
- Code: `server/src/plant/map.ts` (settings, style building), `server/src/plant/mapTiles.ts` (fetcher, cache, PMTiles reader), routes in `server/src/plant/routes.ts` (404 `PLANT_MODULE_OFF` while the module is off, classified in `route-matrix.test.ts`), `web/src/pages/PlantMap.tsx`, `web/src/components/plant/SitesMap.tsx`, the widget in `web/src/components/dashboard/widgets.tsx`, `SM_MAP_CACHE_MB` in `config-schema.ts`.
- Docs: a section in `docs/PLANT.md` with the tile policy, the privacy note per style and a PMTiles example.

## Security

- **CSP unchanged:** no third-party origin for scripts, styles, images, fonts or connections; MapLibre needs no `eval` and its worker runs from `'self'`.
- **No open proxy:** the fetcher builds URLs only from the saved source's templates; the browser passes a layer name and `z/x/y` (integers in range), a font stack and range from the style, or a sprite name. Nothing else reaches the upstream URL. Signed-in users with plant rights only; rate-limited; no API tokens.
- **SSRF:** address safety always; only the source's origins; no redirects to other origins; content type and size checked; tiles are served inert (`nosniff`) and only drawn by MapLibre.
- **Secrets:** an API key is in the vault, added server-side, masked in logs and error reports, never sent to the browser.
- **Hidden sites** stay hidden: the sites answer is filtered by `decide()`; the shared cache stops at zoom 12, so timing cannot reveal where others looked closely.
- **Untrusted style files:** an own style URL is reduced to sources and layers; Steward rewrites its URLs and drops anything else (no scripts exist in MapLibre styles, but no extra origins either).
- **Changes need a step-up** and are audited, like other changes of where Steward sends data.

## Alternatives considered

- **The browser fetches tiles directly** (the issue's sketch, CSP per style): less load on Steward, but the user's IP address goes to the provider, an API key would be visible in the browser, the CSP would change with a setting (built once today), and `no-referrer` conflicts with OSM's policy for web pages. Not chosen (question 1).
- **Leaflet:** simpler, raster only. Vector light and dark styles and vector PMTiles would need plugins with their own CSP needs.
- **Serving the PMTiles file to the browser** (MapLibre's pmtiles protocol, byte ranges): no server-side reading, but the whole file becomes downloadable, and it is a second path next to the proxy. Reading it on the server keeps one path.
- **A Steward-hosted tile service for all installations:** an operation we cannot promise.
- **Only the list, links to openstreetmap.org** (today): no map at a glance, which is the request.

## Consequences

**Positive**

- A map of sites at a glance, with the same rights, states and table twin as the other plant views.
- Works offline with a self-hosted file, and with nothing outside at all when off.
- No change to the CSP; no personal data to tile providers.

**Negative**

- Steward serves tiles: more requests, a disk cache, a fetcher to maintain. One installation with a few people looking at a map fits; the docs say when to switch to an own source.
- Steward maintains two pairs of light and dark styles (OpenMapTiles and Protomaps schemas).
- The web build grows by MapLibre (about 1.6 MB of JavaScript, loaded only with the map).

**Risks**

- OpenStreetMap or OpenFreeMap block or change their service. Mitigation: the source is a setting; the page falls back to the list; the docs name alternatives.
- A browser without WebGL 2 (some virtual desktops in OT networks). Mitigation: the list, with the reason.

**Revisit** when installations need much more map traffic than a few people, or when someone needs layers beyond sites (assets inside a site, OT network overlays).

## Decided after review

1. **How do tiles reach the browser?** Decided: only through Steward. The CSP stays as it is, no user's IP address or API key goes outside, and the tile policy is met by caching and Steward's own `User-Agent`; the cost is server load and a disk cache.
2. **Is the map on by default?** Decided: off until an administrator turns it on, with _OpenStreetMap_ preselected – one click with the privacy note in front of them. A new installation sends nothing it was not told to.
3. **Which provider for the built-in light and dark vector styles?** Decided: OpenFreeMap (free, no key, OSM data, OpenMapTiles schema). It has no service level, so it is offered as a choice, not the default.
4. **Who may see exact site positions?** Decided: whoever sees the site, as on the site page today; the map adds no new right. Sites that must not be located are restricted with the site's access list, and the server filters the sites it returns.
