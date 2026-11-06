# Applications and protection needs

_Applications_ are what your services consist of. People call some of them platforms – _Insights Hub_, _Industrial Edge_ – and some are smaller applications without any interface. Each application can have a **CIA rating**: how much protection it needs for confidentiality, integrity and availability. A service derives its **protection need** from its applications.

- [Applications and platforms](#applications-and-platforms)
- [Create an application](#create-an-application)
- [Map platforms (integrations)](#map-platforms-integrations)
- [Components and tech stack](#components-and-tech-stack)
- [Systems and environments](#systems-and-environments)
- [Example: a Snowflake project](#example-a-snowflake-project)
- [Example: an AWS account shared by applications](#example-an-aws-account-shared-by-applications)
- [Example: a Confluent environment](#example-a-confluent-environment)
- [Add applications to a service](#add-applications-to-a-service)
- [Rate an application (CIA)](#rate-an-application-cia)
- [The protection need of a service](#the-protection-need-of-a-service)
- [The CIA scale](#the-cia-scale)
- [Documents that apply to an application](#documents-that-apply-to-an-application)
- [Who may do what](#who-may-do-what)
- [Audit, API, evidence packs, migration](#audit-api-evidence-packs-migration)

## Applications and platforms

A **platform** in Steward is an integration: an interface with a base URL, credentials and a connector type, which processes and monitors use. It has no catalogue data and no rating.

An **application** is the catalogue entry: name, description (Markdown), vendor, version, URL, the users and teams responsible for it (`user:dana`, `team:service desk`), criticality (low, medium, high, critical), tags, the CMDB entry (system, ID, link) and links – the same links as on services, both ways.

One application can have several platforms, for example _Insights Hub_ ← _IH tenant prod_ and _IH tenant test_. A platform belongs to one application at most.

## Create an application

1. _Catalogue → Applications → New application_ (designers and administrators).
2. Enter the name and, if you like, vendor, version, URL, description, criticality, the responsible users and teams, the CMDB entry and tags. A tag is a key with an optional value: type the key, **Tab** to the value, **Enter** to add it – `env: prod`, or just `pci`. A key with a value uses letters, digits, `.` `_` `-` `/`; tags from before stay as they are. Clicking a tag in a list or on a page filters the list by it (`?tag=env=prod`), and _any env_ widens the filter to every value of the key. The same tags work on services, processes, monitors, records and credentials.
3. _Save_. The application page opens.

Applications are archived, not deleted (_Archive_ on the application page). An archived application no longer counts for the protection need of its services and disappears from the list and the pickers. Its rating, links and history stay. _Show archived applications_ lists them; _Restore_ brings one back.

The list has a search (name, vendor, tag) and filters by service, criticality and protection need (applications with that level in at least one dimension, or _Not rated_).

## Map platforms (integrations)

On the application page, _Integrations → Map platform_, choose the platform and _Save_.

- Mapping a platform – and removing it – needs the **manage** right on the platform (administrators have it on every platform), on top of the right to edit the application. The mapping decides which application, and whose CIA rating, the platform's evidence names; using a platform is not enough.
- You can only choose platforms you may manage.
- A platform that belongs to another application is refused with the name of that application. Remove it there first.
- Readers who may not see a mapped platform see _A platform you may not see_ – no name, no link.
- The platform page names its application next to the base URL.
- When a platform is deleted, it leaves its application.

## Components and tech stack

An application lists what it consists of once – its **components** – and processes read them from there instead of repeating the same names as inputs everywhere.

On the application page, _Components → Add component_: a **type** and a **name** are all it needs; a link and a note are optional. The types are a short fixed list, so processes can ask for "all Kafka topics of this application":

| Type                 | Name, for example                                       |
| -------------------- | ------------------------------------------------------- |
| Repository           | `acme/orders` (link: the repository)                    |
| Container image      | `ghcr.io/acme/orders` (without a tag)                   |
| Kafka topic          | `orders.v1`                                             |
| Snowflake database   | `ORDERS_PROD`                                           |
| Cloud account        | `123456789012` or the subscription name                 |
| Kubernetes namespace | `orders-prod`                                           |
| Platform             | what the application runs on, e.g. `Insights Hub (eu1)` |
| Other                | anything else, with a link                              |

An application without components works as before. Within an application, a name is used once per type and environment.

A component of type **Kubernetes namespace** names its **cluster** (a platform of kind Kubernetes): Steward reads its deployments, the images (into the tech stack, source _read from the cluster_), pods that are not well and cert-manager certificates every 6 hours or on _Read now_ ([KUBERNETES.md](KUBERNETES.md)).

A component of type **Repository** can name its **Git platform** (GitHub, GitLab or Forgejo/Gitea) with the repository path as name (`acme/shop-web`): Steward reads the default branch and its pipeline, the latest release, open security alerts, packages, deploy keys and tokens (each can be added to the credentials register) and the tech stack from the repository's files (source _read from the repository files_) every 6 hours or on _Read now_ ([GIT-PLATFORMS.md](GIT-PLATFORMS.md)).

A component of type **Kafka topic** can name its **Kafka platform**, with the topic name as name: Steward reads its settings, partitions, the newest message's time, the consumer groups with their lag and the schema version every 6 hours or on _Read now_; platform managers can read a few recent messages where the platform allows it ([KAFKA.md](KAFKA.md)).

A component of type **Cloud account** can name an **AWS platform**, with the value of the application tag as name (`shop` for `application=shop`): Steward lists the resources with the tag, their costs per month and the IAM users with the tag and the age and last use of their access keys (each key can be added to the credentials register) ([AWS.md](AWS.md)).

A component of type **Snowflake database** can name a **Snowflake platform**, with the database as name: Steward reads its tables (size, last change), the tasks that failed in the last day and the credits of the warehouses used ([SNOWFLAKE.md](SNOWFLAKE.md)).

A component can have an **environment** (see [Systems and environments](#systems-and-environments)): one Snowflake database per stage (`ORDERS_DEV`, `ORDERS_TEST`, `ORDERS_PROD`), one Kafka topic or namespace per stage, separate cloud accounts for prod and non-prod. Leave it empty when the component serves all environments – the repository, for example; every component from before 0.2.5 is such a component. Once components have environments, the table shows them and filters by environment (a filter keeps the components of all environments).

### Tech stack

Each component can have a **tech stack**: products from the [endoflife.date](https://endoflife.date) list with the version in use – operating systems, runtimes, databases, major frameworks (_Node.js 24_, _PostgreSQL 16_, _Alpine Linux 3.20_). The product field offers the list, the version field its release cycles; any version text is accepted. The application page shows the stack of all components together (_Tech stack_), with the components that use each product and version, coloured by the [end of life](#end-of-life) of each version.

The product list ships with Steward (`server/assets/endoflife/products.json`, MIT licensed by the endoflife.date contributors), so nothing is fetched at run time. `node scripts/endoflife-products.mjs` refreshes it.

### Import from an SBOM

_Import SBOM_ (the import icon of a component) reads a **CycloneDX** or **SPDX** document in JSON – for example from `syft <image> -o cyclonedx-json` or `trivy image --format cyclonedx` – from a file or from a URL:

- Only products endoflife.date knows are kept. A component counts by its package URL (`pkg:generic/node`, `pkg:npm/react`, `pkg:docker/library/postgres` …), then its CPE, and an operating system also by its name. Libraries stay out – also one named like a product (the npm client `redis` is not the Redis database).
- _Show changes_ lists what the import would do before anything is stored: add, change, remove (an entry of an earlier SBOM that the new one no longer has), and entries kept because they were **entered by hand – these always win**. Change an SBOM entry by hand and it counts as entered by hand from then on.
- A URL must be http(s), is fetched without following redirects, at most 10 MB, and the [outbound policy](SECURITY-HARDENING.md#outbound-connections) applies – allow the host under _Settings → Outbound access_ if needed. An SBOM lists at most 50,000 components.
- The component shows the last import (format, name, who, when).

Libraries and their vulnerabilities belong in Dependency-Track: any component can name its Dependency-Track project, and Steward shows its open findings and policy violations ([DEPENDENCY-TRACK.md](DEPENDENCY-TRACK.md)).

### End of life

Steward reads the release cycles of every product in a tech stack from [endoflife.date](https://endoflife.date) once a day and keeps them, so pages, the API and processes never wait for it. The badges of the tech stack show the state of each version:

| Colour | State       | Meaning                                                                 |
| ------ | ----------- | ----------------------------------------------------------------------- |
| Green  | supported   | The release cycle's end of life is further away than the warning period |
| Yellow | ends soon   | The end of life is within the warning period (default 90 days)          |
| Red    | end of life | The end of life has passed                                              |
| Grey   | no data     | No version given, or endoflife.date has no matching release cycle       |

The tooltip names the release cycle (_Release cycle 24 (LTS) · end of life on 30 Apr 2028, in 547 days · latest 24.11.1_). A version belongs to the longest cycle it starts with: `24.11.0` and `v24` to `24`, `3.12.4` to `3.12`, `16.4-alpine` to `16`.

**Set up:** add a platform with the connector type **endoflife.date** (_Platforms → New_; base URL `https://endoflife.date`, no credentials, the API description comes along) and allow it in the [outbound policy](SECURITY-HARDENING.md#outbound-connections) if needed. The demo has one against the simulated platform.

_Applications → End of life_ shows how many products have data, when they were read last, and products that could not be read. Administrators change the settings:

| Setting                          | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform                         | empty   | The endoflife.date platform to read; empty: the first platform of that type                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Warn days before the end of life | 90      | From then on a version counts as _ends soon_ (1–730)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Message the application owners   | on      | Event **Tech stack end of life** (`stack.eol`, [NOTIFICATIONS.md](NOTIFICATIONS.md)): once per application, product and cycle when it starts ending, once when it reached its end of life – to the owners, else the administrators. The same once per system, product and cycle to the people responsible for the system – also for systems no application runs on yet (a system without responsible people that applications run on is covered by their messages; one no application uses goes to the administrators) |
| Count on the scorecard           | off     | Adds the part **Tech stack** to the [scorecard](SCORECARD.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

_Refresh now_ (designers and administrators, `POST /api/catalogue/lifecycle/refresh`) reads the data right away, e.g. after adding a product. A newly entered product is read within a few minutes (when a refresh fails as a whole, e.g. because the outbound policy refuses endoflife.date, the next try is an hour later). The settings are audited as `catalogue.lifecycle_settings_changed`, a refresh as `catalogue.lifecycle_refreshed`, a message as `application.eol_notice_sent` or `system.eol_notice_sent`. The settings move with migration packages; the data itself does not (it is read again).

The stack entries carry the state in the API (`lifecycle`: `state`, `cycle`, `eolFrom`, `eoasFrom`, `isLts`, `latest`, `daysLeft`; `null` before the first refresh), in `GET /api/v1/applications/{id}` and in process inputs; `$systems()` in expressions returns every system with its stack and end of life, also systems no application runs on. The example **End of life – Tech stack overview** (process 77) and the dashboard **End of life** list every component and system past or near its end of life: the systems of each application per environment, and systems no application runs on yet (application `–`).

### Version watch

For every tech stack entry – from an SBOM, a cluster's images, a repository's files or entered by hand – Steward reads the **newest version** from structured sources once a day and shows how far behind the installed one is. It only reads and reminds: no upgrades, no pull requests – [Renovate](https://docs.renovatebot.com/) or Dependabot stay the tools that change code.

**Where Steward looks.** For an entry without its own setting, the sources are tried in the order of the settings; the first that answers with a version wins:

| Source             | What is read                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency-Track   | `GET /api/v1/repository/latest?purl=…`: the latest version its repository metadata analyzer knows, for components that name a Dependency-Track project ([DEPENDENCY-TRACK.md](DEPENDENCY-TRACK.md))                                                                                                                         |
| Package registry   | by [package URL](https://github.com/package-url/purl-spec) – the SBOM's, else the product's from the product list: **npm** (`registry.npmjs.org`), **PyPI** (JSON API), **Maven Central** (`maven-metadata.xml`), **NuGet** (flat container), the **Go module proxy** (`@v/list`), **crates.io**; yanked versions left out  |
| Container registry | the tags of an image read from a cluster or a Dockerfile (`GET /v2/<name>/tags/list`, [OCI distribution specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md#listing-tags)) on a platform of type _Container registry_ or _Docker Hub_ chosen in the settings, matched by the registry host |
| Git platform       | releases (or tags) of a repository on GitHub, GitLab or Forgejo/Gitea: an entry's own setting, or the product's upstream repository (`pkg:github/…` of the product list) on the GitHub platform of the settings                                                                                                             |
| endoflife.date     | the latest release of the newest release cycle ([End of life](#end-of-life))                                                                                                                                                                                                                                                |

**How versions are compared.** By the ecosystem's rules: [Semantic Versioning 2.0.0](https://semver.org/) (also NuGet, Go modules, Cargo), [PEP 440](https://peps.python.org/pep-0440/) for PyPI, Maven's `ComparableVersion` order for Maven (`alpha < beta < milestone < rc < snapshot < release < sp`), numbers with dots for tags and endoflife.date. **Pre-releases** (alpha, beta, release candidates, milestones, Go pseudo-versions, GitHub releases marked as pre-release) are left out unless the settings or the entry count them. Image tags keep their shape: `nginx:1.27.3-alpine` is compared with the `-alpine` tags only (`1.28.0-alpine`), `postgres:16.4` with plain versions (`18.1`, not `18.1-alpine` or `19beta1`).

**Behind by** is the first part that differs – major, else minor, else patch – and the **days** since the first release newer than the installed one came out (when the source has dates). Parts the installed version leaves out match any: `node:24-alpine` is not behind `24.11.1`. The newest version is shown as the source names it (the tag with its suffix, the release's tag).

**What you see**

- **Component and system**: next to a stack entry that is behind, its newest version (red a major, orange minor, blue a patch behind); it opens the entry.
- **Tech stack of the application** (_Versions_): installed → newest, where it was found, behind by and for how many days, the end of life of the cycle, the open critical and high findings of the component's Dependency-Track project – the worst first; cards on a phone.
- **The entry** (the badge or the details button): newest version, behind by, the release cycle's end of life, the findings in this package from Dependency-Track with their fixed version, and **what each source said** – also those after the one that won, with why a source did not apply (no package URL, blocked by the outbound policy, not read yet …).
- **Where to look**, per entry, for whoever may change the application or system: _Automatic_, one source, or _Not watched_; the package URL, the image or repository on a platform the person may use, a **tag pattern** with `{version}` once (`{version}-alpine`, `v{version}`, `release-{version}`), releases or tags, the comparison rules and pre-releases. _Read now_ reads its sources at once. Changes are audited (`application.version_watch_changed`, `system.version_watch_changed`).
- `GET /api/v1/applications/{id}` carries `watch` on every stack entry (`source`, `where`, `ref`, `newest`, `newestAt`, `lag`, `behind`, `daysBehind`, `checkedAt`, `error`).

**Monitor check _Version behind_** ([MONITORS.md](MONITORS.md#check-types)): the stack of one application (its components and the systems it runs on), optionally one environment or some products – **down** (or degraded) when an entry is a major release behind or its cycle is past its end of life, **degraded** above `maxMinors` minor releases (default 2) or `maxDays` days behind. It judges the cache and calls nothing.

```yaml
checks:
  - id: shop-stack
    name: Shop tech stack up to date
    type: version-behind
    application: Webshop (demo)
    environment: prod
    maxMinors: 2
    maxDays: 180
    majorAs: degraded
    eolAs: down
```

**Dataset _Component versions_** (`catalogue.versions`) for dashboards and reports: one row per stack entry – application, component or system, environment, product, installed, newest, behind, days behind, end of life, source – with a status (serious: a major behind or past its end of life; warning: further behind than the settings allow) and the metrics `entries`, `current`, `major`, `minor`, `patch`, `eol`, `unknown`. Published every hour by the job. It names every application, so only administrators and auditors see it.

**Scorecard part _Up to date_** (off by default, [SCORECARD.md](SCORECARD.md#the-scorecard)): attention when an entry is a major release behind, open when further behind than allowed.

**Messages**: event **New major release** (`stack.release`, [NOTIFICATIONS.md](NOTIFICATIONS.md)) to the owners of the application (else the administrators) or the people responsible for a system, once per product and major release. The newest major release known when an entry is first seen is the starting point – turning the watch on sends no flood. A cycle reaching its end of life is the event _Tech stack end of life_ above. Sent messages are audited (`application.major_release_notice_sent`, `system.major_release_notice_sent`).

**Settings** (_Applications → Version watch_; status for everyone, changes by administrators, audited as `catalogue.versions_settings_changed`):

| Setting                                | Default       | What it does                                                                                                                          |
| -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Sources                                | all, in order | Which sources are tried for entries without their own setting, and in which order (the first that answers wins)                       |
| Read every … hours                     | 24            | How old a lookup may get; a failed one is tried again after at most 6 hours                                                           |
| Package registries                     | public        | The address of each registry – a mirror without login works (Artifactory, Nexus); empty: not read                                     |
| Container registries for images        | none          | Platforms of type _Container registry_ tried for images, matched by the registry host (variable `registry`, else the base URL's host) |
| Git platform for upstream releases     | none          | A GitHub platform for the releases of a product's upstream repository                                                                 |
| Count pre-releases                     | off           | An entry can decide for itself                                                                                                        |
| Message the owners on a new major      | on            | The event _New major release_                                                                                                         |
| Count on the scorecard                 | off           | The part _Up to date_                                                                                                                 |
| Behind above … minor releases / … days | 2 / 180       | Limits for the scorecard and the dataset (monitor checks have their own)                                                              |

_Read all now_ (designers and administrators, `POST /api/catalogue/versions/refresh`, audited as `catalogue.versions_refreshed`) reads every lookup at once.

**Safe by design**

- **Read-only, cached**: the job `version-watch` reads each lookup (one per package, image or repository – shared by every entry that needs it) once a day by default, at most 200 per run; pages, the API, checks and the dataset read only the cache. A failed read keeps the versions read before and records why.
- **Outbound policy** as everywhere ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#outbound-connections)): a registry's host must be allowed – blocked, the lookup says so and the next source answers. Allow `registry.npmjs.org`, `pypi.org`, `repo1.maven.org`, `api.nuget.org`, `proxy.golang.org` and `crates.io` (or your mirror) under _Settings → Outbound access_ to use them.
- **No credentials to public registries**: requests carry no cookies and no authorization, follow no redirects and stop above 16 MB and after 20 seconds. Package URLs are parsed segment by segment and encoded – `..`, `/` inside a segment or control characters are refused, so an SBOM cannot point a request elsewhere. Platforms (Dependency-Track, container registries, Git) use their own credentials, only on their own origins; a registry's token service gets the platform's credentials only when it is one of the platform's origins (Docker Hub: `auth.docker.io` is a trusted origin of the preset), and only the pull right of one repository is asked for.
- **Rights**: an entry of an application or system the reader may not see answers like a missing one; a monitor check sees the application as its owner does. A platform named in an entry's setting must be one the person may use, and is read with their rights afterwards (the platforms of the settings with the instance's).

**Set up**: the demo has _Container registry (demo)_ and simulated npm, PyPI, Maven, NuGet, Go and crates.io registries. For real use, add a platform of type _Docker Hub_ or _Container registry_ (GHCR, Harbor, GitLab, Artifactory …: base URL the registry, variable `registry` the host images name, optional `testImage` for the connection test, anonymous or a read-only robot account), choose it under _Version watch_, and allow the registry hosts in the outbound policy. Container registry platforms are read-only (since 0.9.0: only `GET` and `HEAD`, `PLATFORM_METHOD_DENIED` otherwise – also for requests another platform sends below the registry's base URL).

### Processes: input type application

A process input of type **Application** asks for an application when the run starts (schedules store it, a default can name it). The run gets the application with its components and stack, read when the run starts and kept in the run's protocol:

```yaml
inputs:
  - name: app
    type: application
    default: Orders # a name works in every installation, e.g. through Git sync
steps:
  - id: topics
    type: forEach
    items: inputs.app.components[type="kafka-topic"].name
```

```json
{
  "id": "app_…",
  "name": "Orders",
  "criticality": "high",
  "owners": ["user:olivia"],
  "tags": [],
  "url": "",
  "components": [{ "id": "cmp_…", "type": "kafka-topic", "name": "orders.v1", "url": "", "note": "", "environment": "prod", "stack": [] }],
  "systems": [{ "id": "sys_…", "name": "db01", "kind": "vm", "vendor": "On-premises", "environment": "prod", "production": true, "note": "", "stack": [] }],
  "stack": [
    {
      "product": "nodejs",
      "label": "Node.js",
      "version": "24",
      "components": ["ghcr.io/acme/orders"],
      "systems": [],
      "environments": ["prod"],
      "production": true
    }
  ]
}
```

Components and systems carry their environment, so a process can pick one stage: `inputs.app.components[type="snowflake-database" and environment="prod"].name`, `inputs.app.systems[environment="prod"].name`, or everything in production: `inputs.app.systems[production]`.

The value is an application id or name (case does not matter); an archived or unknown application stops the run before it starts. Ordinary inputs stay for one-off runs.

An input of type **Applications** takes several (ids or names); **empty means every application that is not archived**, at most 500. The run gets a list of the same objects, each stack entry with its `lifecycle`:

```yaml
inputs:
  - name: apps
    type: applications
steps:
  - id: eol
    type: set
    values:
      past: inputs.apps.stack[lifecycle.state="eol"]
```

## Systems and environments

### Systems

A **system** is what applications run on: a server, a VM, a cluster, an appliance, a cloud service. One system often hosts several applications, so it is kept once – with its own tech stack (the operating system and runtimes live on the system, not on each application) – under _Catalogue → Systems_.

A system has a **name** and a **kind** (server, virtual machine, cluster, appliance, cloud service, other, network segment); everything else is optional: the **vendor or provider** (AWS, Azure, on-premises, the hoster), a link to the **CMDB** entry, the users and teams **responsible**, a note, its **tech stack** (by hand or from an SBOM, exactly like a component's) and the **Steward platform** it is – "this cluster is the platform _Kubernetes (prod)_" – so shared infrastructure that also has an API is described once. Readers who may not see that platform see _A platform you may not see_; saving the system keeps it.

The system page lists the applications that run on it with their environment. A system is deleted only when no application runs on it any more.

**Network segments and firewall changes** (0.5.0, optional): a system of the kind _Network segment_ has a VLAN ID, subnets, a zone or security level, a site and who manages its firewall; any system can be _in_ segments, with its address there. The system page's _Firewall & network_ panel shows the segments, the approved firewall rules, the firewall changes and the provider's tickets. Systems are a link kind, so documents, firewall changes and ticket references can name a server directly. _Duplicate_ copies a system with its attributes and its segments (without addresses). Nothing of this is required – see [FIREWALL-CHANGES.md](FIREWALL-CHANGES.md).

### Runs on

On the application page, _Runs on → Add system_: choose the system, its **environment** and, if you like, a note. The same system can appear several times with different environments – a shared test box runs App A (test) and App B (dev); system A runs App A (dev), system B runs App A (prod). The section groups the systems by environment, in the order of the environment list.

The application's **tech stack** includes the stacks of its systems, with the environments each product is used in. End-of-life messages name the component or system with its environment (`db01 (prod)`) and send production first; the scorecard part _Tech stack_ lists production entries first.

### Environments

Environments differ between organisations – `dev` / `staging` / `prod`, `test` / `qa` / `acceptance`, or with a region, `eu-prod`, `us-prod`. _Settings → Environments_ (administrators) keeps the ordered list: a **name**, an optional **colour** and whether it counts as **production**. The default is `dev`, `test`, `prod` (production).

The list is offered on platforms, on "runs on" links and on components; other values stay possible. Values that are in use but not on the list are shown under the list with how often they occur, and _Add_ adopts them. Grouping and sorting use the list's order everywhere; unlisted values come after it, "all environments" last. The list moves with migration packages and is audited as `catalogue.environments_changed`.

Not part of Steward: IP addresses, ports, firewall rules, hardware details, discovery and topology. The CMDB stays the source; Steward keeps the link and what reviews, duties and end-of-life checks need. A firewall review is a [service duty](DUTIES.md) with a manual process and the concept as a living document.

## Maintenance windows

_Catalogue → Maintenance_ lists planned work as a list or a month calendar. A window has a title, a start and an end, and lists what it affects: platforms, systems, applications and services. It happens once or repeats **weekly** or **monthly** (every n weeks or months, optionally up to a last start). Repetition keeps the wall-clock time in the instance's time zone across daylight saving changes; a monthly window on the 29th to 31st falls on the last day of shorter months.

What a window reaches:

- **Down** from what it lists: a service's applications, an application's platforms and systems, a system's platform.
- **Up** from a platform or system: the applications that use it, and the services of affected applications.

While a window lasts:

- **Monitors stay quiet** (default on): monitors that check an affected platform show _maintenance_ and send no alerts. Checks are still recorded, and the time does not count against the monitor's uptime – as with a monitor's own maintenance window.
- **Pause run messages** (default off): check and run messages of runs bound to an affected platform go to the app only.
- **Availability objectives** of affected services and applications record a breach but send no message. Their figures stay Gatus' own; each window shows the planned minutes next to them ([SCORECARD.md](SCORECARD.md)).

Announcements (notification event _Maintenance_, see [NOTIFICATIONS.md](NOTIFICATIONS.md)) go to the responsible people and the owners of what the window lists and reaches: when it is planned, a reminder before each occurrence (24 hours by default, 0 for none), when it starts and when it ends. Each is sent once per occurrence.

The details offer the window as a calendar file (_Add to calendar (.ics)_, with its repetition), the next occurrences and how many platforms, monitors, applications and services it reaches. A window can name the change record that approves it. Platform, system, application and service pages show the maintenance going on and the next windows, with _Plan maintenance_ for those who may change the item.

**Disabled windows:** _Enabled_ in the form switches a window off without cancelling it: a disabled window neither quiets monitors nor pauses messages nor counts as planned minutes, and announces nothing; it is announced as planned when it is enabled. A copy (_Duplicate_ in the details) starts disabled. The public API lists only enabled windows.

**Who may plan:** designers and administrators, and anyone who may change every listed item (owners of services, applications and systems; the _manage_ right on platforms). The same people change or cancel a window; cancelling removes the coming occurrences and keeps the window for the record. Everyone signed in reads windows; platforms the reader may not see are listed without a name. Every change is in the audit trail (`maintenance.*`). API: `/api/maintenance-windows` (web UI), `GET /api/v1/maintenance-windows` (public, read-only, with the occurrences in a range).

## Example: a Snowflake project

A data project on Snowflake, described once:

1. **Platforms:** one Steward platform per Snowflake account – _Snowflake (non-prod)_ with environment `test`, _Snowflake (prod)_ with environment `prod` – so processes and monitors can call them.
2. **Application** _Orders analytics_ with:
   - the components **Repository** `acme/orders-analytics` (no environment – it serves all) and **Snowflake database** `ORDERS_DEV` (`dev`), `ORDERS_TEST` (`test`), `ORDERS_PROD` (`prod`);
   - the two platforms mapped under _Integrations_;
   - under _Runs on_, the cloud service _Snowflake EU_ (kind cloud service, vendor Snowflake) in `prod`, and the shared integration VM `etl01` (with its Ubuntu and Python in the tech stack) in `test` and `prod`.
3. **Credentials register:** the service users (`SVC_ORDERS_ETL`, `SVC_ORDERS_BI`) with their rotation interval, used by the application ([CREDENTIALS.md](CREDENTIALS.md)).

A process with an input of type _Application_ then finds the production database with `inputs.app.components[type="snowflake-database" and environment="prod"].name`, and the end-of-life check names `etl01 (prod)` before `etl01 (test)`.

## Example: an AWS account shared by applications

One AWS account, several applications in it, each tagged `application=<name>` ([AWS.md](AWS.md)). A platform belongs to one application at most, so the account is described once as infrastructure and each application names its part:

1. **Platform:** one per account – _AWS (prod)_ with the role, the `regions`, the `tagKey` and the environment `prod` ([AWS.md](AWS.md#connect-an-account)). It is what readouts, access reviews (source _AWS IAM_), process steps and monitors use.
2. **System:** _Systems → New_ – _AWS 123456789012 (prod)_, kind _cloud service_, vendor AWS, the cloud team as responsible, the CMDB link, and **Steward platform** _AWS (prod)_. The account has one place for its owners, and a maintenance window on it reaches every application that runs on it.
3. **Each application:** _Runs on_ the system in `prod`, and a component **Cloud account** with the platform _AWS (prod)_ whose **name is its tag value** (`shop`) – its resources, costs per month and IAM keys, read from what carries its tag. _Add to the credentials register_ on an IAM key tracks its rotation.
4. **Services** list the applications as usual; they take the protection need, scorecard and costs from them.

Map the platform under _Integrations_ only to the application that stands for the account itself (a _Cloud landing zone_ of the cloud team), or to none: the mapping decides whose CIA rating the platform's evidence names. Activate the tag as a _cost allocation tag_ in AWS Billing, or the costs cannot be split per application.

## Example: a Confluent environment

A Confluent Cloud environment with a cluster per stage, shared by the applications that produce and consume ([KAFKA.md](KAFKA.md)):

1. **Platforms:** one per cluster – _Kafka (test)_, _Kafka (prod)_ – with the bootstrap servers, a read-only service account and the Schema Registry as base URL.
2. **System:** the cluster as a _cloud service_ (vendor Confluent) per stage, the streaming team as responsible, **Steward platform** the cluster's platform; the applications _run on_ it in their environment.
3. **Each application** (or each data project – a team's topics, usually with a common prefix): components **Kafka topic** with the topic name, the environment and the Kafka platform – settings, consumer lag, the newest message and the schema version per topic; the example processes _Kafka – Topic standards_ and _Kafka – Schema change review_ read them.
4. **Monitors** with the check _Kafka topic_ on the topics that matter: new messages within N minutes, lag, a stuck consumer group, an unexpected schema.

Access reviews of Confluent role bindings and ACLs need Confluent's Cloud API (`api.confluent.cloud`), not the Kafka protocol; they are not built in yet.

## Add applications to a service

On the service page, _Applications → Add application_, choose the application and optionally its **role**:

- _Primary_ – the application the service is built on;
- _Dependency_ – something the service needs;
- _Other_ – describe the role in a few words.

The section shows each application with its role, its CIA rating and – through it – its integrations, with links to the platforms. The pencil changes the role, the bin removes the application from the service. Free links (_Links_) stay as they are.

## Rate an application (CIA)

On the application page, _CIA rating → Rate_. For each dimension choose a level and give a **justification** (required): the damage scenarios that apply. Leave a dimension empty if you have not rated it yet.

Steward stores who rated each dimension and when, and audits every change with the old and the new level.

The default levels are the protection needs of **BSI IT-Grundschutz** (BSI-Standard 200-2):

| Level         | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| **Normal**    | The impact of damage is limited and calculable.                                  |
| **High**      | The impact of damage can be considerable.                                        |
| **Very high** | The impact of damage can reach an existentially threatening, catastrophic level. |

## The protection need of a service

The service page shows, per dimension:

- **Derived:** the highest rating of its applications – the **maximum principle** of BSI-Standard 200-2. Archived applications and ratings that need re-rating do not count. The line says which application gave the level and how many of the applications are rated, and _Not counted_ lists the applications left out: not rated, needing re-rating, archived.
- **Effective:** the derived level, or the override.

An override sets a dimension to another level with a **reason** (_Protection need → Override_). Use it when the maximum principle does not fit:

- **Cumulation effect:** many applications of normal need together, or one failure that hits many plants at once, need more.
- **Distribution effect:** a redundant setup, or data that only leaves a plant aggregated, can need less.

_Use the derived level_ removes the override. Overrides are audited with the derived level at that moment. The services list shows the effective protection need as small badges (C, I, A).

## The CIA scale

_Applications → CIA scale_ shows the levels in use, lowest first. The order decides the maximum principle.

Administrators can change the scale (_Change scale_):

- **BSI default** – normal, high, very high for all three dimensions;
- **Own scale for all three dimensions** – for example four or five levels;
- **Own scale for each dimension** – if your company rates confidentiality, integrity and availability differently.

Each level has a key (stored with the ratings: `a`–`z`, `0`–`9`, `_`), a label, an optional description and a colour from a fixed list. Use the arrows to order the levels.

**Changing the scale never loses a rating.** When a level that is in use disappears from the new scale, the editor lists it with the number of ratings and overrides that use it:

- **map** it to a level of the new scale: the ratings keep their justification and show _Mapped from “Very high” when the scale changed_;
- or **flag for re-rating** (the default): the ratings keep their old level and justification, show _Needs re-rating_ with the old label, and do not count for the protection need until someone rates them again. The service page says how many ratings need re-rating.

Renaming a label changes no rating (ratings store the key); the audit entry records the old and new label. **Moving a level** that ratings use – changing its order among the levels that stay – changes what those ratings mean: the editor lists these levels and asks you to confirm, and their ratings and overrides are flagged for re-rating (the API refuses the change with `CIA_REORDER_CONFIRM` unless the request has `confirmReorder: true`). Giving a level the label another level had before – swapping _Normal_ and _High_, say – counts as a move too. A label with a new text does not. Adding a level between others moves nothing.

A stored scale that does not validate – for example from a migration package – is not used: Steward uses the BSI default and logs a warning. Until an administrator saves a scale, every protection need and rating is marked as not reliable – on the service and application pages and lists, in the public API (`scaleInvalid`, `storedInvalid`) and in evidence packs (`catalogue.scale.invalid` and a warning in the PDF) – and ratings and overrides cannot be changed (`CIA_SCALE_INVALID`). A migration package with such a scale is refused in the dry run.

## Documents that apply to an application

A living document (a document type with the workflow _document_) that belongs to a service can name the applications it **applies to** – an ICAM concept for _Insights Hub_, an authorization concept for _Industrial Edge_.

- On the document page, _Applies to → Change_, choose the applications and _Save_ (whoever may edit the document; not for withdrawn documents). Leave it empty when it applies to the whole service.
- _New document_ on the service page offers the applications of the service.
- The service page groups its documents by application, and lists the rest under _Whole service_.
- The application page lists its documents with edition, status and review status.

The scope is not part of the document's content: changing it needs no new edition. It is audited on the document and on each application concerned (`application.document_added`, `application.document_removed`): whoever may edit the document can name any application, and the application's history shows it.

## Who may do what

| Action                                                                         | Who                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| See applications, ratings, protection needs and the scale                      | Everyone who can sign in                                                                  |
| Create applications                                                            | Designers and administrators                                                              |
| Edit, archive, rate an application; change its links                           | Designers, administrators and the users and teams responsible for it                      |
| Map platforms to an application, remove them                                   | Whoever may edit the application **and** has the manage right on the platform             |
| Add, change and remove components; edit their tech stack; import SBOMs         | Whoever may edit the application (not while it is archived)                               |
| Add systems to an application ("runs on"), change or remove them               | Whoever may edit the application (not while it is archived)                               |
| Create systems                                                                 | Designers and administrators                                                              |
| Change and delete a system, edit its stack, import SBOMs                       | Designers, administrators and the users and teams responsible for it                      |
| Change the environment list                                                    | Administrators                                                                            |
| Add applications to a service, change their role, override its protection need | Whoever may edit the service (designers, administrators, its responsible users and teams) |
| Change the CIA scale                                                           | Administrators, with a fresh confirmation (step-up)                                       |
| Change the applications a document applies to                                  | Whoever may edit the document                                                             |

Applications have no access lists, like services: the catalogue is readable for everyone. Only platforms keep their own access lists – an application never shows a platform to someone who may not see it.

## Audit, API, evidence packs, migration

- **Audit log:** `application.created`, `.updated`, `.archived`, `.restored`, `.rated`, `.platform_added`, `.platform_removed`, `.component_added`, `.component_changed`, `.component_removed`, `.sbom_imported` (with what changed), `.system_linked`, `.system_link_changed`, `.system_unlinked`, `.link_added` …; `system.created`, `.changed`, `.deleted`, `.sbom_imported`; `catalogue.environments_changed`; `service.application_added`, `.application_changed`, `.application_removed`, `service.protection_need_overridden`, `service.protection_need_changed` (the effective need of a service moved because of an application, a member or a scale change – one entry per service, on the service); `record.scope_changed`, `application.document_added`, `application.document_removed`; `catalogue.cia_scale_changed`.
- **Public API** (read-only, [API.md](API.md)): `GET /api/v1/applications`, `GET /api/v1/applications/{applicationId}` (with integrations, links, components, systems and the tech stack), `GET /api/v1/applications/{applicationId}/documents`, `GET /api/v1/systems` (filter `environment`), `GET /api/v1/systems/{systemId}`, `GET /api/v1/environments`, `GET /api/v1/cia-scale`. Services carry `applications` and `protectionNeed`; the documents of a service carry `applications` (their scope).
- **Evidence packs** of a service hold its protection need (effective, derived, override with reason) and the CIA rating of each application in `index.json` (`catalogue`) and in the summary PDF; packs of a platform hold the rating of its application. See [COMPLIANCE.md](COMPLIANCE.md#protection-needs-cia).
- **Migration packages** ([MIGRATION.md](MIGRATION.md)) carry applications, ratings, integrations, components with their tech stack, systems with theirs and the "runs on" links, the environment list, the applications of services, overrides, document scopes and the scale. The responsible users and teams follow the identity mapping; who rated something stays as it was.

Internal API (web UI): `GET/POST /api/applications`, `GET/PUT /api/applications/:id`, `POST /api/applications/:id/archive`, `PUT /api/applications/:id/rating`, `POST /api/applications/:id/platforms`, `DELETE /api/applications/:id/platforms/:platformId`, `POST /api/applications/:id/components`, `PUT/DELETE /api/applications/:id/components/:componentId`, `POST /api/applications/:id/components/:componentId/sbom[/preview]` (`{ sbom }` – the JSON text or document – or `{ url }`), `GET /api/catalogue/stack-products`, `GET/POST /api/systems`, `GET/PUT/DELETE /api/systems/:id`, `POST /api/systems/:id/sbom[/preview]`, `POST /api/applications/:id/systems`, `PUT/DELETE /api/applications/:id/systems/:systemLinkId`, `GET/PUT /api/catalogue/environments`, `POST/PATCH/DELETE /api/applications/:id/links[/:linkId]`, `GET /api/platforms/:id/application`, `PUT/DELETE /api/services/:id/applications/:applicationId`, `PUT /api/services/:id/protection-need`, `GET/PUT /api/catalogue/cia-scale`, `PUT /api/records/:id/applications`.
