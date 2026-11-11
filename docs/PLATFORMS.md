# Platforms and connector types

A platform is one system Steward works with. Processes, monitors and the API explorer reach it through the platform's settings, so credentials are entered once and stay in the vault.

|                    |                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform**       | One instance of a system: an Insights Hub tenant, an IEM, any REST API. It holds the base URL, authentication, non-secret variables (tenant, region, API paths), encrypted credentials, OpenAPI specs (searchable operations, used by the editor and the API explorer; import by file, paste or URL) and docs (notes, links, files).          |
| **Connector type** | A reusable template for a kind of platform: auth, variables, HTTP options, credential field names, doc links and API specs, but never credential values. Create one from a configured platform with _Save as connector type_. Export it as JSON to share, import it elsewhere, and new platforms created from it get the specs automatically. |

Processes refer to _connection slots_ (e.g. `hub`, kind `insights-hub`), not to a platform: the same process runs against a test and a production tenant. Who may use or manage a platform is set by its access list ([USERS.md](USERS.md#platform-access-list)).

A platform has one or more **identities** – sets of credentials with their own access list, MCP mode, read-only flag and operation filter, for example _Snowflake · Read only_ as the default and _Snowflake · Admin_ for the few who may change things. One platform per system keeps the settings, health, monitors and catalogue in one place; runs, schedules, triggers, monitors and MCP name the identity they use. See [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#identities). Connector types carry identity templates (names, flags, operation filters – never credentials or access lists).

## Changing the address

Stored credentials go only to the platform's own addresses. Changing one of them moves where they go (0.19.0, security review H1):

- the base URL (with its `{{ vars.x }}` filled in – a variable that changes the host counts),
- a trusted origin, a sign-in address (token URL, login and refresh request, STS endpoint), the portal of browser steps, the proxy,
- the connection of kinds that do not talk HTTP to their base URL: the MQTT broker (variable `url`), the Kafka bootstrap servers, the Kafka OAuth `tokenUrl`, Schema Registry (`schemaRegistryUrl`) and REST endpoint (`kafkaRestUrl`), the host and port of a database platform (_Platform → Database_).

A new path on the same host, a new name, description or variable that is not part of an address are ordinary changes.

While the platform has stored credentials (in any identity), such a change

- needs a signed-in session – API tokens get `403 SESSION_REQUIRED` – and a [step-up](SECURITY-HARDENING.md#step-up-re-authentication) (control point `platform.destination`, part of the baseline);
- says what happens to the credentials. Steward asks: an **administrator** chooses _Send them_ (_Send the stored credentials to the new address?_) or _Remove them_; **anyone else** who manages the platform saves only with _Save and remove them_ and enters the credentials again for the new address. Through the API the body names it: `"credentials": "keep"` (administrators only, otherwise `403 PLATFORM_CREDENTIALS_KEEP_ADMIN`) or `"clear"`; without it the answer is `409 PLATFORM_DESTINATION_CREDENTIALS`;
- is audited as `platform.destination_changed` with the old and the new addresses and whether the credentials were kept or removed – alert on it.

An identity cannot move the platform either: the variables of an address – those in the base URL, token URLs, trusted origins or portal, and the connection variables above – cannot be set per identity (`IDENTITY_VARIABLE_FIXED`). A platform without stored credentials changes its address like any other setting (audited the same way).

## API specifications and path prefixes

Import OpenAPI 3.x or Swagger 2.0 specifications under _Platforms → (platform) → API specs_, by file, paste or URL. Their operations appear in the editor's _Pick from API spec_, the API explorer, the contract check and the MCP gateway.

Many specifications put part of the path in their server URL. The Insights Hub Identity Management spec has the server URL `https://gateway.{region}.mindsphere.io/api/identitymanagement/v3` and the path `/Groups`; the API needs `/api/identitymanagement/v3/Groups`. Steward keeps that part as the spec's **path prefix** and puts it in front of every operation path:

- On import, the prefix is the path of the server URL: OpenAPI 3 `servers[0].url` (server variables take their default) or Swagger 2 `basePath`. A spec without a server URL has no prefix.
- If the platform's base URL already ends with that path, the prefix stays empty, so the path is not doubled.
- The list of specs shows each prefix and where requests go (_Requests go to: base URL + prefix/…_). Click the pencil to change it. A prefix is empty or `/segment/segment` (letters, digits and `. _ ~ -`); it can never change the host or leave the base URL.
- Specs imported before Steward had path prefixes get their prefix from the stored server URL when they are read. HTTP steps that were saved with the short path keep it: open the step and pick the operation again.

**Copying to other platforms.** A spec can be copied to other platforms of the same kind (API specs → _Copy to other platforms_, or `POST /api/platforms/{id}/specs/{specId}/copy` with `targets`), e.g. from one Insights Hub tenant to the next. Each platform gets its own, independent copy, since platforms of one kind can run different API versions. The path prefix comes along, unless the target's base URL already ends with it. A target that already has a spec with the same title and version is skipped, or – with _Replace_ – gets the new content under the same spec id, so processes using it keep working. Needs `manage` on the source and every target; audited as `platform.spec_added` / `platform.spec_updated` with `copiedFrom`. _Also copy the operation filters_ (`copyFilters: true`, 0.13.0) gives each identity of the source with a filter its counterpart of the same name on the target (never wider than the target's was), or creates it without credentials, closed and with MCP off ([identities](PLATFORM-SIGN-IN.md#read-only-identities-and-the-operation-filter)). The audit entry of a spec that is changed or removed lists the identities whose operation filter it affects.

## Recorded responses and test runs

While you model a process, the platform is often not reachable yet, or you do not want to call it. **Recorded responses** stand in for it: _Platforms → (platform) → Recorded responses_ keeps answers per operation – method and path, optionally query parameters and parts of a JSON body the request must have – with status, headers and body.

- **Record** one in the API explorer (_Save as recorded response_ under the answer), or enter or paste it by hand, e.g. from Swagger or Postman.
- **Match**: `{id}` in a path matches one segment, a trailing `*` the rest (`/users/{id}`, `/files/*`). When several fit, the most specific wins: more fixed path segments, then more query parameters, then a body to match, then the newest.
- **Test run**: in _Run_, turn on _Use recorded responses (test run)_ (API: `POST /api/runs` with `recorded: true`). A test run is a dry run whose platform calls are answered by the recordings – nothing is sent. A read without a recording fails its step and names the call (_Test run: no recorded response for GET /users?active=true on "…"_). A write with a recording gets that answer; without one it is skipped as in a dry run. Paged reads stop when the same recording would answer the next page. Browser steps are skipped. Sub-processes run as test runs too. Runs show _Test run_; the public API has `recorded` on runs.
- **Monitors**: _Test with recorded responses_ on a monitor runs its platform checks against the recordings and shows the results – nothing is stored, no status changes, no messages. Other check types need the network and are skipped (`POST /api/monitors/{id}/test-run`).
- **Never** used by real runs, dry runs or monitors that run on their schedule.
- Recordings can hold **personal data**: everyone who may use the platform reads them (a run would fetch the same data); changing them needs `manage`. When a recording is saved, the platform's credentials and cached tokens are replaced by `***`, and headers with credentials or cookies (`Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` …) are dropped. At most 500 per platform, 1 MB body each. Audited as `platform.recording_added` / `_changed` / `_removed`; they move with migration packages and are removed with their platform.

## InfluxDB

Two presets of the kind `influxdb` (0.18.0) – _InfluxDB 1.x_ and _2.x_ – differ in the variable `version`, which tells Steward how to ask; both are read-only and serve the freshness check's [InfluxDB source](MONITORS.md#freshness-in-influxdb). The base URL is the server root (`https://HOST:8086`). InfluxDB 3.x is not supported yet: saving a platform whose `version` is neither 1.x nor 2.x is refused.

| Version | Sign-in                                                                                        | Variables           | Connection test                                                  |
| ------- | ---------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| 1.x     | none, basic (a user with READ on the database) or bearer (a JWT signed with the shared secret) | `version: 1`        | `GET /ping` (204), then `SHOW DATABASES` with the credentials    |
| 2.x     | bearer: an API token with read access to the buckets, sent as `Authorization: Token <token>`   | `version: 2`, `org` | `GET /health`, then `GET /api/v2/buckets?limit=1` with the token |

Credentials are kept in the vault like every other platform's and read with the platform's identity; requests go to the base URL only and through the outbound policy. The `Token` scheme is the platform client's own rule for this kind and version, as `PRIVATE-TOKEN` is for GitLab. The demo has _InfluxDB (demo)_, a 2.x mock; the mock also answers as 1.x below `/mock/influxdb1`.

## Cost plan

With the Costs module on, a platform has a tab **Cost plan** (0.19.0, [COSTS.md](COSTS.md#planning-per-platform), [ADR 0032](adr/0032-cost-attribution-platform-plans.md)): the platform team's own contracts – a data platform's capacity, a cloud spend commitment, a streaming subscription – planned per fiscal year and set against the platform's bill as Steward reads it, with entries, _Book_, the CSV import, the contracts covering the platform and what they owe, and prepaid capacity drawn down by the read costs. Who may manage the platform and the members of its owning teams change it; who may see the platform reads it. The platform's costs are not allocated to the services that use it.

## Supported authentication

`none`, `basic`, `bearer`, `apiKey` (header or query), `oauth2_client_credentials` (e.g. Insights Hub service credentials), and `token_request`. `token_request` is a configurable login call whose response contains a token, e.g. the IEM `/portal/api/v1/login/direct` or the Insights Hub Technical Token Manager. Per platform you can also set a proxy, a custom CA, _accept self-signed certificates_ (common for on-prem IEM), a timeout and default headers.

Tokens from `oauth2_client_credentials` and `token_request` are kept in memory until shortly before they expire (`expires_in`). A new one is fetched when the platform's settings or credentials are saved, when Steward restarts, or once after a 401. Roles granted to the technical user in the meantime only appear in a new token, so the platform answers 403 until then: _Test connection_ shows how old the token is, and **Get a new token** (platform → … menu, `POST /api/platforms/{id}/token/renew`, needs `manage`, audited as `platform.token_renewed`) fetches a new one right away.

**Insights Hub reads of the plant registry** (0.14): _Check mapping_ of an [Insights Hub sink](PLANT.md#insights-hub-mapping) reads Asset Management only – `GET …/assets/{id}`, `…/assets/{id}/aspects`, `…/aspecttypes/{id}` under the platform's variable `assetPath` (default `/api/assetmanagement/v3`) – with the platform's default identity, as the person who asks (they need _use_ on the platform and that identity). A read-only identity, or an operation filter that allows these reads, is enough; the identity needs a tenant role that reads assets (else _403_).

Every auth type, with its fields and examples: [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md). Platforms with their own pages: [AWS.md](AWS.md), [DATABASES.md](DATABASES.md), [ENTRA.md](ENTRA.md), [GIT-PLATFORMS.md](GIT-PLATFORMS.md), [KAFKA.md](KAFKA.md), [KUBERNETES.md](KUBERNETES.md), [SNOWFLAKE.md](SNOWFLAKE.md) and the others in the [index](README.md#integrations-by-platform).
