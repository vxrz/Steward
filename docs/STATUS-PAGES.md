# Service status pages

A status page shows how a few services are doing, for people outside the service team – for example the colleagues in a plant (#26). It is built from what Steward already knows: the **monitors** linked to the services, planned and running **maintenance windows**, open **vendor tickets** and, if you want, the **availability objectives**. It never names monitors, platforms or tickets.

- [Set one up](#set-one-up)
- [What a page shows](#what-a-page-shows)
- [Who sees it](#who-sees-it)
- [The link without sign-in](#the-link-without-sign-in)
- [API](#api)

## Set one up

_Service → Status pages → New status page_ (designers and administrators):

- **Title** and an optional **description**.
- **Services** (up to 50). The state of a service comes from the monitors linked to it: on the service page, add the monitors under _Links_.
- **Show known issues with vendors** (default on) and **Show the availability objectives** (default on).
- **Notice** (optional) with its kind – information, warning or outage – shown at the top, e.g. what you are doing about a problem.

Changes are audited (`status_page.created`, `status_page.changed`, `status_page.deleted`).

## What a page shows

Per service:

| Part                                                                   | Where it comes from                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State: _Outage_, _Degraded_, _Maintenance_, _Operational_ or _No data_ | The worst state of the monitors linked to the service (enabled, not templates). A down monitor is an outage, a degraded one degraded; a running maintenance window turns _Operational_ into _Maintenance_. Without monitors: _No data_. Only counts per state are shown, never monitor names. |
| Maintenance                                                            | Planned and running maintenance windows that reach the service in the next 14 days (also through its applications and platforms): title, start and end.                                                                                                                                       |
| Known issues with vendors                                              | Open ticket references linked to the service that wait on a vendor (or have a vendor source): the vendor and since when – never the ticket number, title or note.                                                                                                                             |
| Objectives                                                             | Each availability objective of the service: the 30-day value against its target.                                                                                                                                                                                                              |

The page as a whole shows the worst state of its services (services without data only count when no service has data). It refreshes every minute.

## Who sees it

- Everyone who can sign in can open the status pages (_Service → Status pages_).
- The role **status** (_status viewer_) sees **only** the status pages: after signing in, nothing but the pages and _Sign out_. The server refuses every other request of a user whose only role is _status_ (`STATUS_VIEWER_ONLY`), checked once for all routes – so a route that forgets a role check cannot leak to them. Give the role to colleagues who should see the state of the services and nothing else, also through single sign-on (claim mapping).
- A user with _status_ and another role has the other role's rights.

## The link without sign-in

_Link without sign-in_ makes a secret link for a page (designers and administrators):

- The link is shown **once**; Steward keeps only its hash. A new link replaces the old one, _Revoke link_ ends it. Both are audited (`status_page.link_created`, `status_page.link_revoked`).
- The secret is in the URL **fragment** (`…/status#t=…`), which browsers do not send to the server, so no server or proxy log contains it. The page sends it in a header (`X-Status-Token`) to `GET /api/public/status-page`.
- Anyone with the link sees exactly what signed-in users see on that page – think of it as public. Opening it is audited (`status_page.viewed_by_link`, with the address; at most once per page and address per hour), rate-limited per address, and answered with `Cache-Control: no-store`. A wrong or revoked link answers like a missing page.

## API

Web UI API (signed-in users):

- `GET /api/status-pages`, `GET /api/status-pages/{id}/view` – status viewers too
- `POST /api/status-pages`, `GET`/`PUT`/`DELETE /api/status-pages/{id}` – designers and administrators (GET: every role but status viewers)
- `POST`/`DELETE /api/status-pages/{id}/link` – make or revoke the link without sign-in
- `GET /api/public/status-page` with `X-Status-Token: <secret>` – no sign-in

Status pages are not moved by migration packages (they name services by id and carry the link's secret): set them up again on the target.
