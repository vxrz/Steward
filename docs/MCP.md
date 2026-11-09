# MCP server (AI assistants)

Steward has a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. AI assistants such as Claude Desktop or VS Code can use it to read processes, runs, monitors, schedules, triggers, dashboards and the audit log – and, where an administrator allows it, to read the APIs of connected platforms through Steward.

**An assistant changes nothing by itself.** Reading runs at once. Changing a platform (where its gateway allows it) and starting runs (where an administrator allows it) only ever create a request that a person decides in Steward under _AI requests_ – see [Approved writes](#approved-writes). An assistant cannot decide tasks or approve anything.

Contents:

- [Turn it on](#turn-it-on)
- [Create a token](#create-a-token)
- [Sign in with OAuth (optional)](#sign-in-with-oauth-optional)
- [Connect a client](#connect-a-client)
- [Tools](#tools)
- [Resources](#resources)
- [Platform gateway](#platform-gateway)
- [Approved writes](#approved-writes)
- [Security model](#security-model)
- [Limits](#limits)
- [Logging, audit and metrics](#logging-audit-and-metrics)
- [Configuration](#configuration)
- [Protocol details](#protocol-details)
- [Why no SDK](#why-no-sdk)
- [Phase 2](#phase-2)

## Turn it on

The MCP server is **off** by default.

1. Sign in as an administrator.
2. Open **Settings → MCP server (AI assistants)**.
3. Switch on **Turn on the MCP server**.

The card then shows the endpoint (`https://<your Steward>/api/mcp`) and a ready-to-copy client configuration. The change is written to the audit log (`mcp.settings_changed`). `SM_MCP=off` on the server turns MCP off for good, whatever the setting says.

## Create a token

Every person uses their own token. A tool acts with the rights of the token's owner – never with more.

1. Open your **profile page**.
2. Click **New token**.
3. Choose the access **MCP client** and an expiry.
4. Copy the token. It is shown only once. The dialog also shows the client configuration with the token filled in.

A token with the scope _MCP client_ works **only** on the MCP endpoint. The REST API (`/api/v1`) and the web UI's API refuse it. The other way round, _read_ and _full_ tokens do not work on the MCP endpoint. So an MCP token that leaks from a client configuration file gives read-only MCP access and nothing else.

Revoke a token on the profile page (or, as an administrator, under **Settings → API tokens**). It stops working immediately.

Turning the MCP server on or off (and its AI run requests and control proposals, `PUT /api/mcp-server`) needs a signed-in session, like the OAuth settings: API tokens get `403 SESSION_REQUIRED`, whatever their scope.

## Sign in with OAuth (optional)

Instead of pasting a token, MCP clients that support the [MCP authorization specification](https://modelcontextprotocol.io/specification/latest/basic/authorization) can sign in with the person's Steward account. This is **optional and off by default**; MCP tokens keep working whether it is on or off.

**Turn it on** (administrators): _Settings → Security & sign-in → MCP server_ → **Let MCP clients sign in with OAuth**. The MCP server itself must be on.

**What happens then:**

1. The client calls `/api/mcp` without a token. Steward answers `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"`.
2. The client reads the metadata (RFC 9728 and RFC 8414). If self-registration is allowed, it registers itself (RFC 7591).
3. It opens the browser at Steward's consent page (`/oauth/authorize`). The person signs in as usual (password or single sign-on) and sees:
   - which client asks;
   - where the browser will return;
   - what the client will be able to do.

   Allowing asks for a step-up confirmation, like creating a token.

4. The client exchanges the one-time code for an access token for the MCP endpoint, plus a refresh token.

**What the client can do:** exactly what an MCP token can do. It has the person's own rights, through the MCP tools only, and changes only ever become requests that a person decides ([Approved writes](#approved-writes)). The access token is refused everywhere else: the REST API (`/api/v1`) and the web UI's API.

**Rules:**

- **PKCE** (`S256`) is required. Clients are public: Steward issues no client secrets.
- **Redirect URIs:** https, http on a loopback IP address (`127.0.0.1` or `[::1]`, any port – RFC 8252), or the app's own scheme (e.g. `cursor://…`). They must match exactly; `javascript:`, `data:`, `file:` and similar schemes are refused. The name `localhost` is not accepted for new clients (RFC 8252 §8.3: it may resolve elsewhere); clients registered with it before 0.11 keep working with their exact registered address, not with another port.
- **Scope:** `mcp`. **Audience:** the token is bound to the MCP endpoint (`resource`, RFC 8707); a token issued for another resource is refused.
- **Lifetimes:** access tokens live 60 minutes, and people stay signed in for 30 days without using the client. However often the client refreshes, a connection ends 90 days after the person allowed it (_Sign in again after_); then the person allows the client again. All three can be changed in the settings.
- **Refresh tokens rotate.** Using any refresh token again that was already used – not only the one before the current – revokes the access (RFC 9700 §4.14.2): the client and whoever copied the token both lose it. Steward keeps the hashes of a grant's used refresh tokens until the grant ends. An authorization code is valid once, for 10 minutes; using it twice revokes the access it gave.
- **One grant per person and client.** Allowing the client again replaces the old grant. At most 50 connected clients per person.
- **Self-registration** is off on new installations (since 0.11): anyone could register a client with any https return address, and only the consent page would stand between it and a person's access. Turn it on in the MCP server settings for assistants that register themselves; installations that saved their OAuth settings before keep their choice. While it is off, only clients that administrators add under the MCP server settings (name and redirect URIs) can sign in.

**See and revoke access:**

- People see their connected clients in their profile under _Connected MCP clients_ and revoke them there.
- Administrators see every client and connection in the MCP server settings, and can remove a client, which ends every connection to it.
- Clients can revoke their own tokens (RFC 7009, `POST /oauth/revoke` with their `client_id`): an unknown or missing `client_id` is refused with `invalid_client`, and a token of another client is left alone.
- **Revoked for good:** deactivating the person or resetting their password (by an administrator, or with `steward admin reset-password`) revokes their connected clients; turning OAuth off revokes everyone's. Reactivating the person or turning OAuth on again does not bring the access back – the person connects the client again (one consent). Turning MCP off only stops the tokens while it is off.
- **MCP tokens are not revoked** by any of this: they are named, listed and revoked by their owner or an administrator. While the owner is deactivated, their tokens are refused; after reactivation they work again. Revoke them when a person leaves for good.

**Endpoints:**

| Endpoint                                            | What                                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource/api/mcp` | resource metadata (RFC 9728)                                   |
| `GET /.well-known/oauth-authorization-server`       | authorization server metadata (RFC 8414)                       |
| `GET /.well-known/openid-configuration`             | `404`: Steward is no OpenID provider (no ID tokens, no JWKS)   |
| `POST /oauth/register`                              | dynamic client registration (RFC 7591), JSON                   |
| `GET /oauth/authorize`                              | the consent page in the web UI                                 |
| `POST /oauth/token`                                 | `authorization_code` and `refresh_token`, form-encoded or JSON |
| `POST /oauth/revoke`                                | token revocation (RFC 7009)                                    |

The issuer is `SM_PUBLIC_URL` (recommended: set it), otherwise the address of the request. Its host must be allowed (`SM_ALLOWED_HOSTS`): behind a trusted proxy (`SM_TRUST_PROXY`) both `Host` and `X-Forwarded-Host` are checked, and Steward warns at start-up when `SM_TRUST_PROXY` is set without `SM_PUBLIC_URL`. The discovery documents may be cached for 5 minutes only when they come from `SM_PUBLIC_URL`; built from the request they are sent with `Cache-Control: no-store`. With a base path (`SM_BASE_PATH=/steward`), the well-known addresses put the path at the end, as the RFCs require: `/.well-known/oauth-authorization-server/steward` and `/.well-known/oauth-protected-resource/steward/api/mcp`. Steward answers exactly these two outside its base path, so a reverse proxy has to pass them on as well. Steward never sends CORS headers, so browser-based clients must exchange the code through their own backend.

## Connect a client

### Desktop clients (stdio)

Desktop clients start the MCP server as a program and talk to it over stdin/stdout. Steward ships a small **bridge** for this: it forwards every message to a running Steward over HTTPS. The bridge never opens the database or the vault; it only holds your token.

Save the token in a file only you can read, for example `~/.steward-mcp-token` (`chmod 600` on Linux and macOS).

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "steward": {
      "command": "steward",
      "args": ["mcp", "--url", "https://steward.example.com", "--api-key-file", "/home/me/.steward-mcp-token"]
    }
  }
}
```

`steward` is the desktop executable (use its full path if it is not on your `PATH`). From a source checkout the same bridge runs with `npm run --silent mcp -- --url … --api-key-file …` in the checkout folder – keep `--silent`, because npm must not write anything else to stdout.

Bridge options (`steward mcp --help`):

| Option                  | Meaning                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `--url <url>`           | Steward address. Default: `$STEWARD_URL`, else `http://127.0.0.1:$SM_PORT` (port 4310). |
| `--api-key-file <file>` | File with the MCP token. Default: the environment variable `STEWARD_API_KEY`.           |
| `--data-dir <path>`     | Data folder of a local Steward (see below).                                             |
| `--allow-http`          | Allow plain `http://` to another computer. The token then travels unencrypted.          |
| `--wait <s>`            | For a local URL: how long to wait for Steward to start and prove itself (default 10).   |
| `--no-instance-check`   | Skip the local identity check (less safe, see below).                                   |
| `--timeout <s>`         | Time limit per request (default 60).                                                    |

Safety checks of the bridge:

- It refuses plain `http://` to a host other than this computer unless you pass `--allow-http`.
- For a local URL (`localhost`, `127.x.x.x`, `::1`) it checks that the server is really _your_ Steward before it sends the token: the server has to prove that it knows the secret in the `instance.json` of the data folder (the same check the desktop launcher uses). A different program on the port gets nothing.
  - No `instance.json` yet (Steward is not running, or still starting): the bridge waits up to `--wait` seconds, then stops with an error. It never sends the token without the proof.
  - After a lost connection (Steward stopped or restarted) the bridge checks the proof again before the next request.
  - Give `--data-dir` when Steward uses another data folder than the default.
- **Steward in Docker on `localhost`, or another setup where the check cannot work** (the bridge cannot read the server's data folder): prefer `https://` to the server. If that is not possible, `--no-instance-check` turns the check off. This is less safe: whatever program listens on the port gets the token, for example while the container is stopped. The bridge prints a warning when you use it.
- It never follows redirects and never prints the token.

### HTTP clients (VS Code and others)

Clients that speak **Streamable HTTP** connect directly. **VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "steward": {
      "type": "http",
      "url": "https://steward.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ${input:steward-mcp-token}" }
    }
  },
  "inputs": [{ "type": "promptString", "id": "steward-mcp-token", "description": "Steward MCP token", "password": true }]
}
```

VS Code asks for the token when it starts the server, so the token is not in the file.

Other clients: endpoint `https://<your Steward>/api/mcp`, header `Authorization: Bearer <token>`.

Steward only accepts requests whose `Host` (and, behind a trusted proxy, `X-Forwarded-Host`) is allowed (`localhost`, `127.0.0.1` or `SM_ALLOWED_HOSTS`). Behind a reverse proxy set `SM_PUBLIC_URL` and `SM_ALLOWED_HOSTS` as for the web UI.

## Tools

All tools read only (`annotations.readOnlyHint: true`), except `platform_call_operation`, `request_run`, `propose_control_catalogue`, `propose_control_mappings` and `propose_plant_changes`, which can create a request that waits for a person ([Approved writes](#approved-writes), [Control proposals](#control-proposals), [Plant registry](#plant-registry)). Lists are paginated: a result has `items` and `nextCursor`; pass `nextCursor` back as `cursor` for the next page. Long texts are shortened.

| Tool                          | What it returns                                                                                                                                                                 | Who                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `search_processes`            | Processes by text or tag: name, description, tags, version, owner, your permissions, last run                                                                                   | processes you may view                                   |
| `get_process`                 | One process: inputs (name, type, required – no default values), connection slots, steps (id, type, name), outputs                                                               | process `view`                                           |
| `list_runs`                   | Runs, newest first; filter by process, status, trigger, dry run, time                                                                                                           | runs of processes you may view                           |
| `get_run`                     | One run: status, error, inputs (secret inputs as `***`), platforms used, step journal (paginated, filter by status), checks, decisions, first warnings/errors, sub-process runs | process `view`                                           |
| `get_run_step`                | One journal entry with its input and output (already redacted when stored, shortened)                                                                                           | process `view`                                           |
| `list_monitors`               | Monitors with status, uptime, maintenance, acknowledgement                                                                                                                      | monitors you may view                                    |
| `get_monitor`                 | One monitor and its checks (last result, duration, root causes, uptime) and recent status changes                                                                               | monitor `view`                                           |
| `get_monitor_history`         | Status changes of a monitor (or one check)                                                                                                                                      | monitor `view`                                           |
| `list_dashboards`             | Dashboard definitions and the datasets they show                                                                                                                                | everyone                                                 |
| `list_datasets`               | Datasets: columns, row count, status counts, metrics, staleness                                                                                                                 | publishing process `view`                                |
| `read_dataset`                | Rows of a dataset, filter by status                                                                                                                                             | publishing process `view`                                |
| `list_platforms`              | Platforms you have rights on – metadata only, never credentials or variables; whether the gateway is on                                                                         | platform permission                                      |
| `list_ticket_references`      | Ticket references (ServiceNow incidents, vendor tickets) – open ones by default; affected items only when you may see them                                                      | everyone                                                 |
| `list_schedules`              | Schedules: cron, time zone, enabled, next and last run                                                                                                                          | process `view`                                           |
| `list_triggers`               | Webhook triggers: process, enabled, last firing, counts – never secrets                                                                                                         | process `view`                                           |
| `search_audit_log`            | Audit entries, filter by action, actor, entity, run, text, time                                                                                                                 | auditors and administrators (others do not see the tool) |
| `get_system_status`           | Version, protocol versions, who you are; for auditors and administrators also the server health (the _limited_ view without paths and host names)                               | everyone                                                 |
| `platform_find_operations`    | Read operations of a platform's API ([gateway](#platform-gateway))                                                                                                              | platform `use`, gateway on                               |
| `platform_describe_operation` | Parameters and response schema of one operation                                                                                                                                 | platform `use`, gateway on                               |
| `platform_call_operation`     | Calls one GET/HEAD operation through Steward                                                                                                                                    | platform `use`, gateway on                               |
| `database_query`              | One read-only statement or catalog query on a database platform ([DATABASES.md](DATABASES.md#mcp-gateway)); changing statements are never available                             | platform `use`, gateway on                               |
| `list_control_catalogues`     | Control catalogues: key, name, version, number of controls ([control proposals](#control-proposals))                                                                            |
| `get_control_catalogue`       | The controls of one catalogue with the number of mapped items                                                                                                                   |
| `find_mapping_targets`        | Items of one kind to map to controls (processes, document types, documents, monitors, report schedules, access checks) – only what you may see                                  |
| `propose_control_catalogue`   | Proposes a control catalogue, in parts of up to 200 controls, for an administrator to review                                                                                    |
| `propose_control_mappings`    | Proposes mappings of controls to Steward items with a reason each, for review                                                                                                   |
| `list_plant_sites`            | Sites of the plant registry: code, name, description, counts ([plant registry](#plant-registry))                                                                                | sites you may see; module on                             |
| `get_plant_site`              | One site: its areas, work centers, work units and buildings – no contacts, no access list                                                                                       | site `view`                                              |
| `list_plant_assets`           | Assets, filter by site, device profile (and data point), status, text; with the profile of their assignment                                                                     | assets of sites you may see                              |
| `get_plant_asset`             | One asset with its assignment: profile, endpoints, overrides, additions, publications, KPI instances, checks; `assignmentFile` in the import format                             | site `view`                                              |
| `list_device_profiles`        | Device profiles: manufacturer, model, version, the profile they extend, counts                                                                                                  | everyone who sees the registry                           |
| `get_device_profile`          | One profile resolved: interfaces, groups, data points (with known-as names) and file sets with where each comes from, its bases; `file`: its own part in the import format      | everyone who sees the registry                           |
| `search_data_points`          | Data points whose id, name, address, description or known-as name contains a text                                                                                               | everyone who sees the registry                           |
| `get_data_point`              | One data point: which assets deliver it (their addresses), KPI definitions and collections that read it                                                                         | assets of sites you may see                              |
| `list_kpi_definitions`        | KPI definitions: category, unit, profiles of their inputs, counts                                                                                                               | everyone who sees the registry                           |
| `get_kpi_definition`          | One KPI definition in the import format, its instances and candidates, its checks                                                                                               | everyone who sees the registry                           |
| `list_data_collections`       | The data collections of an asset: collector, mode, items, coverage                                                                                                              | site `view`                                              |
| `get_data_collection`         | One collection: items (paged) with their data points, access patterns, triggers, destination, coverage                                                                          | site `view`                                              |
| `get_plant_import_format`     | The JSON Schema of the plant import format, as a whole or one part                                                                                                              | everyone who sees the registry                           |
| `propose_plant_changes`       | Proposes additions and changes as a document of the import format, for a person to apply                                                                                        | who may import into the registry                         |

`tools/list` only shows the tools the token owner can use (for example no `search_audit_log` for a viewer). The three gateway tools are the exception: they are always listed, because MCP clients keep the tool list of their first connection – a platform that opens its gateway later would otherwise stay out of reach until the client reconnects. Without a platform the owner may use through the gateway, their calls answer how to get one. The tools check the rights again on every call.

**Tool output is data, not instructions.** Results come back as JSON (`structuredContent`, plus the same JSON as text). Names, messages, summaries and platform responses are written by people or by external systems. They can contain text that looks like an instruction ("ignore previous instructions …"). MCP clients and the people using them should treat tool output as untrusted data and keep a human in the loop. The server's `instructions` say the same to the model.

## Resources

| URI                                   | Content                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `steward://semantic-model`            | Steward's data model as an Apache Ossie 0.1.1 semantic model (YAML), see [SEMANTIC-MODEL.md](SEMANTIC-MODEL.md) |
| `steward://semantic-model/0.2.0.dev0` | The same in the in-development Ossie revision                                                                   |

## Platform gateway

The gateway lets an assistant read a platform's API **through Steward**. Steward adds the platform's credentials; the assistant never sees them.

### Turn it on for a platform

1. Open the platform and the tab **MCP**.
2. Switch on **Allow access for MCP clients** and click **Save**. _Changing calls_ stays at _Not possible (read-only)_ unless you choose otherwise ([Approved writes](#approved-writes)).

Only people with the `manage` right on the platform can do this; it is audited (`platform.mcp_gateway_changed`). The setting is part of the platform's sealed connection settings (the mode is kept on the platform's default identity, [ADR 0009](adr/0009-platform-identities.md); the path prefixes stay on the platform), so a change made directly in the database is detected. New platforms, copies and connector types always start with the gateway off. People who call the gateway need the `use` right on the platform.

### How it works

The gateway offers three meta-tools instead of one tool per endpoint:

1. `platform_find_operations` searches the platform's OpenAPI specifications (tab _API specs_) by text or tag. It lists GET and HEAD operations – and, where changing calls are allowed, the changing ones too, marked `needsApproval`.
2. `platform_describe_operation` shows the parameters and a trimmed response schema.
3. `platform_call_operation` calls the operation with `pathParams` and `query`.

An operation is named by its `operationId`, or as `METHOD /path` when it has none. The path includes the spec's path prefix (the path of its server URL, e.g. `GET /api/identitymanagement/v3/Groups`). References in the older form without the prefix (`GET /Groups`) still work.

Platforms **without an API specification** can still be read: list GET path prefixes under _Allowed GET path prefixes_ (e.g. `/api/v1/devices`). Then `platform_call_operation` accepts a literal `path` below one of them. Without prefixes, such a platform offers nothing.

### Rules

- **Reads run, writes wait.** GET and HEAD run at once. Any other method is refused – also when the specification lists it, and audited – unless the platform allows changing calls; then it becomes a request ([Approved writes](#approved-writes)) and nothing is sent until a person approves it. A literal `path` (prefix mode) is always GET or HEAD.
- **Paths come from the specification.** Path parameters are checked against their schema and URL-encoded. Values with `/`, `\`, `%`, `;`, control characters, `.` or `..` are refused. A literal path (prefix mode) must start with a single `/`, may not contain `..` segments, `;` (path parameters – `..;/` is a dot segment for Tomcat, Jetty and Spring), encoded separators, `?`, `#`, `@` or `://`, and must lie below an allowed prefix (segment boundary). The request always goes to the platform's base URL; the gateway checks that the final URL has the base URL's origin and path.
- **Query parameters** must be declared by the operation and match their type and enum. Header and cookie parameters and custom headers are not supported; a JSON `body` (at most 64 kB) only for a changing operation.
- **Outbound policy.** The URL goes through the same outbound (SSRF) policy as processes (_Settings → Outbound access_), including the always-blocked metadata and link-local addresses. Credentials are only attached for the platform's own origins.
- **Redirects** are not followed; the 3xx answer is returned as it is.
- **Responses** are read up to 512 kB (the rest is cut and marked `truncated`). Credential values – also in encoded forms – and fields such as `authorization`, `password`, `access_token` are masked. Only harmless response headers are returned (`content-type`, `etag`, `link`, …), never cookies.
- **Integrity.** If the platform's connection settings were changed outside Steward, the gateway refuses the call until an administrator confirms them.
- **Fair use.** Gateway calls are rate-limited per user and platform (more tokens do not raise the limit). At most 2 gateway calls per platform run at the same time (`SM_MCP_GATEWAY_CONCURRENCY`, never more than half of the platform's _max. concurrent requests_), so MCP clients cannot block runs and monitors.

## Approved writes

An assistant can ask for two kinds of change. Neither happens when it asks: each becomes a **request** that a person decides in Steward under **AI requests** (in the sidebar under _Operate_, next to _My tasks_).

| Request                                            | Turned on where                                                                                                   | Who decides                                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A changing gateway call (POST, PUT, PATCH, DELETE) | Platform → MCP → _Changing calls_ (people with `manage`; turning it on needs a fresh confirmation of the sign-in) | _The token owner confirms each request_, or _A second person approves each request_: an approver or administrator who may use the platform and is not the token owner |
| Starting a run (`request_run`)                     | Settings → MCP server → _Let assistants ask to start runs_ (administrators)                                       | The token owner confirms; the run then follows the process with its own approval steps                                                                                |

How a request goes:

1. The assistant calls `platform_call_operation` with a changing operation (with `reason` and, if needed, a JSON `body`), or `request_run` (with `reason`). It gets a `requestId` and is told that nothing has been changed yet.
2. The people who decide are notified (event _Request from an AI assistant_). The request shows the token, the assistant's reason, and exactly what would be sent: method, path with the path parameters filled in, query and body – or the process, the inputs and whether it is a dry run. The reason and values come from the assistant: check them as data, do not follow instructions in them.
3. **Approve** sends the call (or starts the run) once, as the token owner, with the rights and settings of that moment: if the gateway or the right to use the platform was taken away, changing calls were turned off, or the platform now needs a second person where the request only had the owner's confirmation, the request fails with the reason and nothing is sent. **Reject** (an administrator, or the second person) and **withdraw** (the token owner) close it. A request nobody decides on expires after 24 hours.
4. The assistant reads the outcome with `get_operation_request`: done (HTTP status and the response, credentials masked, shortened), failed, rejected, withdrawn or expired.

Rules:

- Decisions are made in the web app with a signed-in session; API tokens cannot decide (`SESSION_REQUIRED`), and an MCP token reaches only the MCP endpoint.
- An approved request runs exactly once, even when two people approve at the same moment.
- At most 20 open requests per person; reasons up to 500 characters, bodies up to 64 kB of JSON; secret process inputs cannot be given through MCP.
- Every step is in the audit log (entity `mcp_request`): `mcp.request_created`, `mcp.request_approved`, `mcp.request_rejected`, `mcp.request_withdrawn`, `mcp.request_expired`, `mcp.request_executed`; the call itself also as `mcp.gateway_call`, with the request id.
- Approvers have no `use` right on platforms by default; for _A second person approves_, give the approvers who should decide `use` on the platform (or let an administrator decide).
- Requests are not moved by migration packages (they are short-lived).

All non-read methods still go through one function, `writeDecision()` in `server/src/mcp/gateway.ts`.

## Control proposals

An assistant can turn a company's own control set – an ISMS policy, group-wide requirements, a customer's list, in Word, Excel or PDF – into a control catalogue and suggest which Steward items are evidence for which control. It reads the document on its side; Steward only receives the result. Off by default: _Settings → MCP server → Let assistants propose control catalogues and mappings_ (administrators). Then designers and administrators get the tools `list_control_catalogues`, `get_control_catalogue`, `find_mapping_targets`, `propose_control_catalogue` and `propose_control_mappings`.

- **Nothing applies directly.** A proposal waits under **AI requests** for up to 14 days.
- **A catalogue** is compared with the catalogue of the same key: new, changed (with the current text) and unchanged controls, and the controls the proposal leaves out. An **administrator** edits controls, unticks what is wrong and accepts the rest; left-out controls are removed only when ticked (with what is mapped to them). A built-in catalogue only gets its texts changed. A new key creates the catalogue.
- **Mappings** name existing controls and items the token owner may see, each with a reason. **Anyone who may map controls** (designers, administrators) accepts all or some; only items the reviewer may see are mapped. Accepted mappings show _Proposed by the AI assistant of … (token …), accepted by …_ on the control.
- **Large proposals come in parts:** an MCP request is at most 64 kB, so the assistant sends up to 200 controls or mappings per call (`more: true`, then `proposalId` for the next parts). The reviewers are notified and can accept once the last part is in.
- The limits of the file import apply (2000 controls per catalogue, 300 characters per title, 4000 per description; 1000 mappings per proposal). Every step is audited like the other requests, the applied changes as `control_catalogue.imported` and `control.tagged` with the request, the token owner and the reviewer.

How to ask and what to check: [Compliance → Proposals from an AI assistant](COMPLIANCE.md#proposals-from-an-ai-assistant).

## Plant registry

Since 0.12.0 an assistant can read the [plant registry](PLANT.md) and propose changes to it. The tools are listed only while the module is on (_Settings → Modules_); a call while it is off is refused. Plant viewers (role _Plant viewer_) still cannot use MCP clients.

- **Reading** works as in the web app, as the token owner: sites, their assets, assignments and data collections only where the owner may see the site; the catalogues (device profiles, KPI definitions) for everyone who sees the registry. Access lists, contacts and the rights of others are not returned. Lists are paged; `get_device_profile` takes `interfaceId` and `points: false` for a large profile, `get_data_collection` pages its items.
- **Proposing** (`propose_plant_changes`) needs the right to import into the registry (designers, administrators, managers of a site). The assistant sends a `title`, a `rationale` and a `document` of the [plant import format](PLANT.md#yaml-import-and-export) as JSON (at most 48 kB; `get_plant_import_format` describes the format, and `get_device_profile`, `get_kpi_definition` and `get_plant_asset` return the current entries in it). Steward runs the import's preview with the token owner's rights – nothing is written – and answers with the problems, or stores the proposal under **AI requests** for up to 14 days.
- **Only additions and changes.** `remove:` in the document, `removeMissing`, `idMap` (renames), `mode`, `missing` and `replaces` are refused with a reason, when proposed and again when applied.
- **A person applies it**: whoever may import into the registry. The review shows the preview grouped into added and changed entries, each change field by field. While the request is open, the preview runs again as the reviewer; if it differs from the one of the proposal (the registry changed in the meantime), the reviewer ticks that they checked the new one before applying – applying is refused otherwise (`PLANT_PROPOSAL_CHANGED`). A preview with problems, for example a site the reviewer may not change, cannot be applied (`PLANT_PROPOSAL_INVALID`); the request stays open. Entries of sites the reviewer may not see are left out of what they are shown. Applying runs the import core in one transaction.
- **Audit:** `plant.proposal_created`, `plant.proposal_applied` (with the import's own `plant.imported`) and `plant.proposal_rejected`, besides the `mcp.request_*` entries of every request.

What a proposal looks like and what to check: [Plant registry → Proposals from assistants](PLANT.md#proposals-from-assistants).

## Security model

- **Off by default** – globally (administrator setting, `SM_MCP=off`) and per platform for the gateway.
- **Authentication.** `Authorization: Bearer <token>` on every request: an MCP token (scope _MCP client_ only) or, if turned on, an OAuth access token bound to the MCP endpoint ([above](#sign-in-with-oauth-optional)). Session cookies are ignored, tokens in the URL are refused (`400`). Tokens are stored as hashes, can expire and be revoked. A deactivated owner, an owner who must change their password, and a locked vault all stop the token.
- **Authorization.** Every tool runs as the token owner through the same services and permission checks as the web UI and the REST API. Objects the owner may not see answer like objects that do not exist.
- **DNS rebinding.** The `Host` header must be allowed, and a request with an `Origin` header is refused (`403`) unless the origin is Steward's own (`SM_PUBLIC_URL`) or listed in `SM_MCP_ALLOWED_ORIGINS`. Browsers cannot read answers anyway: Steward never sends CORS headers, and the endpoint only accepts `Content-Type: application/json`.
- **Input limits.** Request bodies up to 64 kB, one JSON-RPC message per request (no batches), strict argument schemas (unknown arguments are errors), cursor and string length limits.
- **Output limits.** Pages of at most 100–200 items, long texts shortened, results above about 200 kB refused with a hint to page.
- **Time limits.** 30 s per tool call, 20 s per gateway call; a client that closes the connection cancels its request.
- **Rate limits** per token (and per IP address without a valid token), and per user and platform for gateway calls; a concurrency cap per platform for gateway calls.
- **Proposals never write.** Control and plant proposals wait for a person in Steward, who applies them with their own rights; an MCP token cannot decide a request.
- **No sessions, no server-initiated messages.** The server keeps no state between requests and never sends requests to the client.

## Limits

| What                                        | Default          | Setting                      |
| ------------------------------------------- | ---------------- | ---------------------------- |
| Requests per minute and token               | 120              | `SM_MCP_RATE_LIMIT`          |
| Gateway calls per minute, user and platform | 30               | `SM_MCP_GATEWAY_RATE_LIMIT`  |
| Gateway calls at the same time per platform | 2                | `SM_MCP_GATEWAY_CONCURRENCY` |
| Request body                                | 64 kB            | –                            |
| Tool result                                 | ≈ 200 kB of JSON | –                            |
| Gateway response read                       | 512 kB           | –                            |
| Tool call / gateway call                    | 30 s / 20 s      | –                            |

Above the rate limit the endpoint answers `429` with `Retry-After` and `RateLimit-*` headers.

## Logging, audit and metrics

To keep the audit log meaningful, not every read is audited:

| Event                                                                                                                                                                                                  | Where                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP turned on or off                                                                                                                                                                                   | audit log `mcp.settings_changed`                                                                                                                                                                        |
| Gateway turned on or off for a platform                                                                                                                                                                | audit log `platform.mcp_gateway_changed`                                                                                                                                                                |
| First use of a token per UTC day (an OAuth connection counts as one token)                                                                                                                             | audit log `mcp.token_used`                                                                                                                                                                              |
| OAuth: a client registered or removed, a person allowed a client, a connection revoked, a code or an old refresh token used again                                                                      | audit log `mcp.oauth_client_registered`, `mcp.oauth_client_revoked`, `mcp.oauth_authorized`, `mcp.oauth_grant_revoked`, `mcp.oauth_grants_revoked`, `mcp.oauth_code_reused`, `mcp.oauth_refresh_reused` |
| **Every gateway call** – platform, operation id, method, path template, status, duration, token id, owner, names (not values) of the query parameters                                                  | audit log `mcp.gateway_call`                                                                                                                                                                            |
| **Every refused gateway call** (write method, path, parameters, outbound policy, integrity) with the reason; an invalid literal path is logged as `(invalid)`, control characters in names are escaped | audit log `mcp.gateway_refused`                                                                                                                                                                         |
| Every tool call: tool, token id, owner, short argument summary (values cut to 60 characters, objects by their keys), outcome, duration                                                                 | operational log (JSON, `info`, message `MCP tool call`)                                                                                                                                                 |

Prometheus metrics (`/api/metrics`, [METRICS.md](METRICS.md)): `sm_mcp_requests_total{method,outcome}`, `sm_mcp_tool_calls_total{tool,outcome}`, `sm_mcp_gateway_calls_total{platform,outcome}`. Until 0.10 they were named `steward_mcp_…`; 0.11 still serves the old names (deprecated), 0.12 removes them.

## Configuration

| Variable                         | Default | Meaning                                                                         |
| -------------------------------- | ------- | ------------------------------------------------------------------------------- |
| `SM_MCP`                         | –       | `off` turns the MCP server off, whatever the setting says                       |
| `SM_MCP_RATE_LIMIT`              | `120`   | Requests per minute and token                                                   |
| `SM_MCP_GATEWAY_RATE_LIMIT`      | `30`    | Gateway calls per minute, user and platform                                     |
| `SM_MCP_GATEWAY_CONCURRENCY`     | `2`     | Gateway calls at the same time per platform                                     |
| `SM_MCP_ALLOWED_ORIGINS`         | –       | Comma-separated origins of browser-based MCP clients that may call the endpoint |
| `STEWARD_URL`, `STEWARD_API_KEY` | –       | Defaults of the stdio bridge (`steward mcp`)                                    |

## Protocol details

- **Transport:** Streamable HTTP at `POST /api/mcp`. Answers are single JSON objects (`application/json`); Steward does not open SSE streams. `GET` and `DELETE` answer `405` (no server stream, no sessions). Notifications get `202 Accepted`.
- **Versions:** `2026-07-28` (current; per-request `_meta` with protocol version and client capabilities, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers that must match the body, `server/discover`) and the earlier `2025-11-25` and `2025-06-18` (`initialize` handshake, `ping`). Older clients are answered statelessly, without `Mcp-Session-Id`. `2025-03-26` and older are not supported (they send no version header).
- **Methods:** `server/discover`, `initialize`, `ping` (legacy), `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`.
- **Errors:** JSON-RPC codes `-32700` (parse error), `-32600` (invalid request, e.g. a batch), `-32601` (method not found; `404` for modern requests), `-32602` (invalid params, unknown tool), `-32020` (header mismatch), `-32022` (unsupported protocol version, with the supported list). A tool that fails for a reason the model can fix (bad arguments, not found, no permission) returns a result with `isError: true`. Refusals before the JSON-RPC layer carry Steward codes: `-31000` MCP off, `-31001` no or invalid token, `-31003` forbidden (scope, owner, origin), `-31013` body too large, `-31029` rate limited, `-31503` vault locked.

## Why no SDK

The server is a small, hand-written JSON-RPC 2.0 implementation (`server/src/mcp/`) instead of `@modelcontextprotocol/sdk`:

- Steward needs a fixed, read-only subset: a handful of methods, no sessions, no SSE, no server-to-client requests. That is a few hundred lines that are easy to review.
- The SDK brings its own HTTP stack and validation libraries (Express, its own zod major version, CORS handling) next to Fastify and Steward's zod, and would bypass the app's hooks (host check, error handling). Every request here goes through Fastify with the same limits as the rest of Steward.
- Supporting both the `2026-07-28` revision and older clients is a matter of a few explicit checks that the tests cover.

## Phase 2

Done: **approved writes** ([above](#approved-writes)) and the optional **OAuth sign-in for MCP clients** ([above](#sign-in-with-oauth-optional)).
