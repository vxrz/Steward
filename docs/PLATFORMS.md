# Platforms and connector types

A platform is one system Steward works with. Processes, monitors and the API explorer reach it through the platform's settings, so credentials are entered once and stay in the vault.

|                    |                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform**       | One instance of a system: an Insights Hub tenant, an IEM, any REST API. It holds the base URL, authentication, non-secret variables (tenant, region, API paths), encrypted credentials, OpenAPI specs (searchable operations, used by the editor and the API explorer; import by file, paste or URL) and docs (notes, links, files).          |
| **Connector type** | A reusable template for a kind of platform: auth, variables, HTTP options, credential field names, doc links and API specs, but never credential values. Create one from a configured platform with _Save as connector type_. Export it as JSON to share, import it elsewhere, and new platforms created from it get the specs automatically. |

Processes refer to _connection slots_ (e.g. `hub`, kind `insights-hub`), not to a platform: the same process runs against a test and a production tenant. Who may use or manage a platform is set by its access list ([USERS.md](USERS.md#platform-access-list)).

## API specifications and path prefixes

Import OpenAPI 3.x or Swagger 2.0 specifications under _Platforms → (platform) → API specs_, by file, paste or URL. Their operations appear in the editor's _Pick from API spec_, the API explorer, the contract check and the MCP gateway.

Many specifications put part of the path in their server URL. The Insights Hub Identity Management spec has the server URL `https://gateway.{region}.mindsphere.io/api/identitymanagement/v3` and the path `/Groups`; the API needs `/api/identitymanagement/v3/Groups`. Steward keeps that part as the spec's **path prefix** and puts it in front of every operation path:

- On import, the prefix is the path of the server URL: OpenAPI 3 `servers[0].url` (server variables take their default) or Swagger 2 `basePath`. A spec without a server URL has no prefix.
- If the platform's base URL already ends with that path, the prefix stays empty, so the path is not doubled.
- The list of specs shows each prefix and where requests go (_Requests go to: base URL + prefix/…_). Click the pencil to change it. A prefix is empty or `/segment/segment` (letters, digits and `. _ ~ -`); it can never change the host or leave the base URL.
- Specs imported before Steward had path prefixes get their prefix from the stored server URL when they are read. HTTP steps that were saved with the short path keep it: open the step and pick the operation again.

**Copying to other platforms.** A spec can be copied to other platforms of the same kind (API specs → _Copy to other platforms_, or `POST /api/platforms/{id}/specs/{specId}/copy` with `targets`), e.g. from one Insights Hub tenant to the next. Each platform gets its own, independent copy, since platforms of one kind can run different API versions. The path prefix comes along, unless the target's base URL already ends with it. A target that already has a spec with the same title and version is skipped, or – with _Replace_ – gets the new content under the same spec id, so processes using it keep working. Needs `manage` on the source and every target; audited as `platform.spec_added` / `platform.spec_updated` with `copiedFrom`.

## Recorded responses and test runs

While you model a process, the platform is often not reachable yet, or you do not want to call it. **Recorded responses** stand in for it: _Platforms → (platform) → Recorded responses_ keeps answers per operation – method and path, optionally query parameters and parts of a JSON body the request must have – with status, headers and body.

- **Record** one in the API explorer (_Save as recorded response_ under the answer), or enter or paste it by hand, e.g. from Swagger or Postman.
- **Match**: `{id}` in a path matches one segment, a trailing `*` the rest (`/users/{id}`, `/files/*`). When several fit, the most specific wins: more fixed path segments, then more query parameters, then a body to match, then the newest.
- **Test run**: in _Run_, turn on _Use recorded responses (test run)_ (API: `POST /api/runs` with `recorded: true`). A test run is a dry run whose platform calls are answered by the recordings – nothing is sent. A read without a recording fails its step and names the call (_Test run: no recorded response for GET /users?active=true on "…"_). A write with a recording gets that answer; without one it is skipped as in a dry run. Paged reads stop when the same recording would answer the next page. Browser steps are skipped. Sub-processes run as test runs too. Runs show _Test run_; the public API has `recorded` on runs.
- **Monitors**: _Test with recorded responses_ on a monitor runs its platform checks against the recordings and shows the results – nothing is stored, no status changes, no messages. Other check types need the network and are skipped (`POST /api/monitors/{id}/test-run`).
- **Never** used by real runs, dry runs or monitors that run on their schedule.
- Recordings can hold **personal data**: everyone who may use the platform reads them (a run would fetch the same data); changing them needs `manage`. When a recording is saved, the platform's credentials and cached tokens are replaced by `***`, and headers with credentials or cookies (`Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` …) are dropped. At most 500 per platform, 1 MB body each. Audited as `platform.recording_added` / `_changed` / `_removed`; they move with migration packages and are removed with their platform.

## Supported authentication

`none`, `basic`, `bearer`, `apiKey` (header or query), `oauth2_client_credentials` (e.g. Insights Hub service credentials), and `token_request`. `token_request` is a configurable login call whose response contains a token, e.g. the IEM `/portal/api/v1/login/direct` or the Insights Hub Technical Token Manager. Per platform you can also set a proxy, a custom CA, _accept self-signed certificates_ (common for on-prem IEM), a timeout and default headers.

Tokens from `oauth2_client_credentials` and `token_request` are kept in memory until shortly before they expire (`expires_in`). A new one is fetched when the platform's settings or credentials are saved, when Steward restarts, or once after a 401. Roles granted to the technical user in the meantime only appear in a new token, so the platform answers 403 until then: _Test connection_ shows how old the token is, and **Get a new token** (platform → … menu, `POST /api/platforms/{id}/token/renew`, needs `manage`, audited as `platform.token_renewed`) fetches a new one right away.

Every auth type, with its fields and examples: [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md). Platforms with their own pages: [AWS.md](AWS.md), [DATABASES.md](DATABASES.md), [ENTRA.md](ENTRA.md), [GIT-PLATFORMS.md](GIT-PLATFORMS.md), [KAFKA.md](KAFKA.md), [KUBERNETES.md](KUBERNETES.md), [SNOWFLAKE.md](SNOWFLAKE.md) and the others in the [index](README.md#integrations-by-platform).
