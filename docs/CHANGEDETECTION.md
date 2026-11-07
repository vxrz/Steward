# changedetection.io and Steward

[changedetection.io](https://github.com/dgtlmoon/changedetection.io) (Apache-2.0) watches web pages for changes: it fetches a page on a schedule – with its own browser for pages that need JavaScript –, keeps the snapshots and shows the diff. It is the right tool for pages **without an API**: a vendor's changelog and release notes, terms of service and data processing agreements, pricing pages, status pages, documentation.

changedetection.io runs **separately**, in its own container. Steward does not bundle it, does not run it and never fetches the watched pages itself; it only connects to changedetection.io's REST API:

| What                                         | How                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform** _changedetection.io_            | The instance's base URL and its API key (header `x-api-key`, kept in Steward's vault); read-only                                                                          |
| **Watches as components of the platform**    | _Platforms → your changedetection.io → Watches_: title, page, tags, last check, last change, errors, snapshot times; each linked to an application, a service or a vendor |
| **Monitor check _Page watch_**               | A page changed within N hours (information or degraded), a watch whose last check failed or that was not checked for too long                                             |
| **Notification → webhook trigger → process** | changedetection.io's notification (an Apprise JSON POST) starts _changedetection.io – Review a changed page_: a review task with the link to the diff                     |

Steward stores **metadata only** – never a page's content, a snapshot or a diff. The link to the diff points into changedetection.io, where the content stays.

**Software versions are not a job for this.** The newest version of a product in your tech stack is better covered by the version watch of the tech stack ([#241](https://github.com/vxrz/Steward/issues/241)), which reads release data from endoflife.date, Dependency-Track, package and container registries and Git releases. Use changedetection.io for what has no machine-readable source.

Everything below was written against changedetection.io's API description [`docs/api-spec.yaml`](https://github.com/dgtlmoon/changedetection.io/blob/master/docs/api-spec.yaml) (API version 0.1.9), `changedetectionio/api/Watch.py` and the notification code (`changedetectionio/notification/`) on `master`, checked on 2026-11-06. The official reference is at [changedetection.io/docs/api_v1](https://changedetection.io/docs/api_v1/).

In demo mode (`npm run demo` → _Load demo data_) a simulated changedetection.io with six watches of invented vendor pages is available as the platform **changedetection.io (demo)**: terms, pricing, release notes, a failing status page and a paused watch, three of them linked to the sample applications.

## Run changedetection.io next to Steward

A compose file with both, on one Docker network. changedetection.io's own browser (for JavaScript pages) is a separate container; leave it out if your pages are plain HTML.

```yaml
# docker-compose.yml (excerpt) – Steward as in the repository's docker-compose.yml, plus:
services:
  steward:
    # … as before …
    environment:
      # changedetection.io calls Steward's webhook by this name (see "Notifications" below)
      SM_ALLOWED_HOSTS: 'steward'

  changedetection:
    image: ghcr.io/dgtlmoon/changedetection.io # pin the release you tested
    restart: unless-stopped
    volumes:
      - changedetection-data:/datastore
    environment:
      # the address people open changedetection.io at: notifications build their diff links from it
      BASE_URL: 'https://changes.example.com'
      # changedetection.io's own browser for pages that need JavaScript (optional); plain ws only on the internal Docker network
      # nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- container-to-container on the compose network; the browser container serves no TLS and has no published port
      PLAYWRIGHT_DRIVER_URL: 'ws://browser:3000'
      # needed only if notifications go to Steward on the Docker network (a private address); see below
      # ALLOW_IANA_RESTRICTED_ADDRESSES: 'true'
    ports:
      - '127.0.0.1:5000:5000' # its UI; put it behind your reverse proxy with sign-in

  browser:
    image: dgtlmoon/sockpuppetbrowser # pin the release you tested
    restart: unless-stopped
    cap_add: [SYS_ADMIN]

volumes:
  changedetection-data:
```

- **Protect changedetection.io's UI** (_Settings → General → Password_, or sign-in at your reverse proxy): it shows page contents and holds the notification URLs.
- **Turn on the API key**: _Settings → API_, _Require API key_ on; the key is shown there. changedetection.io has one key with full rights – there is no read-only key. Steward therefore enforces read-only use on its side (below).

## Add the platform

_Platforms → Add platform → changedetection.io (page watches, read-only)_ (group _Monitoring_):

| Field                | Value                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL             | The instance's root, without `/api`: `http://changedetection:5000` on the same Docker network, or `https://changes.example.com`                                                  |
| Variable `uiUrl`     | The address people open in the browser, when it differs from the base URL (e.g. `https://changes.example.com` while Steward reads `http://changedetection:5000`); used for links |
| API key (credential) | The key from _Settings → API_; sent as `x-api-key`, only to the platform's own origin, redacted from protocols and logs                                                          |

_Test connection_ calls `GET /api/v1/systeminfo`. The platform comes with an OpenAPI description of the read endpoints below, so _Pick from API spec_ and the API explorer offer them.

### Outbound policy

Steward's requests to changedetection.io go through the **outbound policy** (_Settings → Security & sign-in → Outbound access_) like process steps:

- Policy `platforms` (default): the platform's base URL is allowed without an entry.
- Policy `allowList`: add the instance's host, e.g. `changedetection:5000` or `changes.example.com`.
- Address safety applies always: cloud-metadata and link-local addresses and Steward's own API are never reachable.

### The endpoints Steward reads

| Route                              | Used for                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/watch`                | All watches: `title`, `page_title`, `url`, `link` (rendered URL), `tags` (tag UUIDs), `paused`, `last_checked`, `last_changed` (unix seconds, 0: never), `last_error` (`false` or a text) |
| `GET /api/v1/tags`                 | Tag UUID → name, so watches carry their tag names                                                                                                                                         |
| `GET /api/v1/watch/{uuid}/history` | Snapshot times of one watch (only the times are kept; the answer's file paths are dropped)                                                                                                |
| `GET /api/v1/systeminfo`           | Connection test                                                                                                                                                                           |
| `GET /api/v1/watch/{uuid}`         | Only the example process, to check that a notification names a real watch                                                                                                                 |

`last_changed` is 0 while a watch has only its first snapshot: it has not changed since it was added.

### Read-only, and no page contents

The platform kind refuses, for every caller – processes, the API explorer, the MCP gateway, monitors and Steward's own reads – and for every redirect hop:

- every method but `GET` and `HEAD` (no creating, changing or deleting watches, tags, notifications or history; `PLATFORM_METHOD_DENIED`, as for Kafka Connect);

and, with `PLATFORM_PATH_DENIED`:

- the GET parameters that change state: `recheck`, `recheck_all`, `paused`, `muted`;
- page contents: a snapshot (`/watch/{uuid}/history/{timestamp}`), a diff (`/watch/{uuid}/difference/…`) and `/changes`;
- `/notifications` (its URLs carry credentials) and every path outside `/api/v1` (changedetection.io's own pages show contents);
- anything below `/api/v1` that is not one of the read endpoints above, `/search` or the API description.

Since 0.9.0 these rules also apply when **another platform** sends a request to the instance (an absolute URL in a step, a check or an ad-hoc request, or a redirect hop that ends there), and a browser step never opens it ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#which-rule-checks-which-call)). The API key may only be used in a process step on the changedetection.io connection itself. A watch's URL is kept and shown without user info (`user:password@`), fragment and the values of secret-looking query parameters (`token`, `key`, `sig` …, or a long random value): they become `***`.

A watch's settings returned by `GET /api/v1/watch/{uuid}` lose `notification_urls`, `headers`, `body`, `browser_steps`, `webdriver_js_execute_code` and `llm_evaluation_cache` before Steward uses, stores or logs the answer: they can hold credentials of the watched site or of a notification target – such as Steward's own webhook secret.

## Watches as components

_Platforms → your changedetection.io → Watches_ (the platform opens on it) lists the watches with their state – _OK_, _Failing_, _Paused_, _Not checked yet_, _Removed_ –, last change, last check and error, tags and links. Search by title, page, vendor or application; filter by tag and state; on a phone the list becomes cards and the filters fold behind a button.

- **Read now** (people who may _use_ the platform) reads the list. Afterwards Steward reads it again **every hour** in the background (job `changedetection`), with the rights of the person who read it last; if they lose the use right, the next read fails and says so on the tab.
- **Diff** opens the watch's diff page in changedetection.io (`<uiUrl>/diff/<uuid>`). **History** reads the snapshot times now: the count, the newest 50 times, which one is the first fetch.
- **Link** (people who may _manage_ the platform) links a watch to an **application**, a **service** and a **vendor** (free text, like the vendor of a ticket reference). Only applications and services you may see can be chosen; one you may not see stays linked and shows as _not visible to you_. Changes are audited (`changedetection.watch_linked`).
- A linked watch shows up on the application's or service's page under **Linked from** (_Page watch: …_), for people who may see the platform; it opens the watch on the platform.
- A watch deleted in changedetection.io disappears at the next read – unless it is linked: then it stays as _Removed_, so the link is not lost silently; removing its links forgets it.
- **Tags** are carried over by name. At most 5,000 watches per platform are kept (the tab says when there are more). Deleting the platform deletes its watches and their links.

## Monitor check _Page watch_

_Monitors → New → Page watch (changedetection.io)_, or in YAML:

```yaml
checks:
  - id: vendor-terms
    name: Vendor terms
    type: page-watch
    platform: changedetection.io # name (or its beginning) or id of the platform
    tag: vendor-terms # one tag; or "watch: <uuid>" for one watch; neither: all watches
    changedWithinHours: 24 # a change within this window …
    changedAs: degraded # … is information (up, the default) or degraded
    failingAs: degraded # a failing watch: degraded (default) or down
    maxCheckAgeHours: 48 # not checked for this long counts as failing (optional)
    pausedAs: ignore # paused watches: left out (default) or degraded
```

- **Changed**: `last_changed` within the window. With `changedAs: up` the check stays OK and names the change in its message – useful on a dashboard; with `degraded` someone is asked to read the diff (the monitor's notifications fire).
- **Failing**: the watch's last check ended in an error – a fetch error, an HTTP error, a filter that no longer matches – or, with `maxCheckAgeHours`, it was not checked in time (a stuck queue, a stopped instance). Failing wins over changed.
- **Paused** watches notice nothing; leave them out, or let them count as degraded.
- No watch (an unknown UUID, a tag without watches) and an instance that cannot be read are **unknown**, not down.
- The check reads the watch list at most once a minute per platform (several checks share it) and keeps only counts and names in its message; its value has `watches`, `failing`, `stale`, `changed`, `paused` for trends.

The example monitor _Vendor page watches_ (`examples/monitors/64-vendor-page-watches.yaml`) has two checks: _Vendor terms_ (tag `vendor-terms`, a change is degraded for a day) and _Watches working_ (all watches, failing or not checked for two days).

## Notifications start a review

changedetection.io sends notifications through [Apprise](https://github.com/caronc/apprise). Its own `post://` / `posts://` URL sends a POST with **the body you write** (Apprise's `json://` would wrap it in its own envelope), and `?+Name=value` adds a request header. Steward's **webhook trigger** takes it and starts _changedetection.io – Review a changed page (from a notification)_ (`examples/processes/76-changedetection-review-change.yaml`). The process

1. checks the payload: the watch UUID must be a UUID; the diff link is built from the platform's own address (`uiUrl`, else the base URL) – a link in the payload is used only when it is that same diff page (with the compared versions);
2. looks the watch up in the bound changedetection.io (`GET /api/v1/watch/{uuid}`, settings with credentials removed); an unknown watch fails the run without a task, so a forged call creates nothing;
3. gives a person (operators, administrators) the task **"<watch> changed"** with the page, the tags, the last check and error and the diff link: read the diff, assess the impact, note a vendor ticket or change and a follow-up record.

The protocol keeps the link, never the page content.

### Set up Steward

1. Import the process (_Processes → From template_).
2. _Triggers → New webhook trigger_: process _changedetection.io – Review a changed page_, connection `changedetection` = your platform, then **Map: changedetection.io notification**. It fills the mapping and the example's settings from `examples/triggers/10-changedetection-review.yaml`:

   | Process input | Mapping            | changedetection.io token |
   | ------------- | ------------------ | ------------------------ |
   | `watchUuid`   | `body.watch_uuid`  | `{{ watch_uuid }}`       |
   | `watchTitle`  | `body.watch_title` | `{{ watch_title }}`      |
   | `watchUrl`    | `body.watch_url`   | `{{ watch_url }}`        |
   | `diffUrl`     | `body.diff_url`    | `{{ diff_url }}`         |
   | `tags`        | `body.watch_tag`   | `{{ watch_tag }}`        |

   Authentication _static token_, identical payloads ignored for 900 s, _skip while running_ off (several pages may change at once). Restrict the source address to changedetection.io's host.

3. **Save → copy.** The secret dialog shows, besides the secret, the **notification URL** and **body** to paste, with the real address and secret filled in.

### Configure changedetection.io

On a watch or on a tag (_Edit → Notifications_; a tag's notifications apply to all its watches), or under _Settings → Notifications_ for all:

- **Notification URL** (one line):

  ```text
  posts://steward.example.com/api/hooks/wht_XXXXXXXXXXXX?+X-Steward-Token=whs_XXXXXXXXXXXXXXXX
  ```

  `posts://` is HTTPS, `post://` plain HTTP (for `http://steward:4310` on the Docker network: `post://steward:4310/api/hooks/…`). The secret travels in the header `X-Steward-Token`; it is part of the URL in changedetection.io's settings, so protect changedetection.io's UI and its backups.

- **Notification body**:

  ```jinja
  {"watch_uuid": {{ watch_uuid|tojson }}, "watch_title": {{ watch_title|tojson }}, "watch_url": {{ watch_url|tojson }}, "diff_url": {{ diff_url|tojson }}, "watch_tag": {{ watch_tag|tojson }}}
  ```

  `|tojson` quotes every value, so a title with quotes still gives valid JSON. changedetection.io then sends `Content-Type: application/json` itself.

- **Notification format**: _Plain text_ (other formats may rewrite the body).
- **Title**: anything; `posts://` does not send it.

Use _Send test notification_ in changedetection.io: Steward answers 202 and starts a run (turn on _Dry run_ on the trigger while trying). Then check _Triggers → Recent calls_.

- **Steward on the Docker network**: changedetection.io refuses notification targets at private addresses unless `ALLOW_IANA_RESTRICTED_ADDRESSES=true` is set – which also lets its watches reach private addresses. Prefer Steward's public HTTPS name through your reverse proxy; set the variable only when changedetection.io's watches are under your control.
- The host name in the URL must be in Steward's `SM_ALLOWED_HOSTS` (e.g. `steward` on the Docker network).

### Security of the webhook

The trigger is Steward's general webhook trigger ([reference in GATUS.md](GATUS.md#webhook-trigger-reference)):

- JSON only, at most **64 KB** (`413` above), the secret compared in constant time before the body is used, a rate limit per trigger, identical payloads ignored for the de-duplication window, source addresses restricted per trigger.
- The payload is untrusted: the mapping only picks fields, the process validates the UUID, builds the diff link itself and looks the watch up before a person sees anything; it never calls a URL from the payload.
- The run's protocol holds the payload's fields (title, page URL, tags, the diff link) and the watch's metadata – no page content. changedetection.io's `{{ diff }}`, `{{ current_snapshot }}` and `{{ triggered_text }}` tokens would send page contents: leave them out of the body.

## Security summary

- The API key is a platform credential: encrypted in the vault, sent only to the platform's origin, redacted from protocols, never returned by the API or written to logs.
- Read-only and contents-free by rule of the platform kind (above), not only by Steward's own code.
- Requests go through the outbound policy and address safety; the background read runs with the rights of the person who read the platform last.
- Watches are visible to people who may see the platform; linking needs the platform's _manage_ right and is audited; applications and services you may not see are neither offered nor named.

## Limitations

- The watch list is read every hour (and by _Read now_); the monitor check reads it at most once a minute. A change between reads shows at the next one; for an immediate reaction use the notification and the webhook trigger.
- changedetection.io's API has no read-only key: protect the key like an administrator password.
- Notification URLs and bodies are set in changedetection.io; Steward cannot set them for you (that would need writing).
