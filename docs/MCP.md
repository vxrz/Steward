# MCP server (AI assistants)

Steward has a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. AI assistants such as Claude Desktop or VS Code can use it to read processes, runs, monitors, schedules, triggers, dashboards and the audit log – and, where an administrator allows it, to read the APIs of connected platforms through Steward.

**Phase 1 is read-only.** An assistant cannot start runs, decide tasks or change anything, in Steward or on a platform.

Contents:

- [Turn it on](#turn-it-on)
- [Create a token](#create-a-token)
- [Connect a client](#connect-a-client)
- [Tools](#tools)
- [Resources](#resources)
- [Platform gateway](#platform-gateway)
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

Steward only accepts requests whose `Host` is allowed (`localhost`, `127.0.0.1` or `SM_ALLOWED_HOSTS`). Behind a reverse proxy set `SM_PUBLIC_URL` and `SM_ALLOWED_HOSTS` as for the web UI.

## Tools

All tools are read-only (`annotations.readOnlyHint: true`). Lists are paginated: a result has `items` and `nextCursor`; pass `nextCursor` back as `cursor` for the next page. Long texts are shortened.

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

`tools/list` only shows the tools the token owner can use (for example no `search_audit_log` for a viewer, no gateway tools without a gateway platform). The tools check the rights again on every call.

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
2. Switch on **Allow read-only access for MCP clients** and click **Save**.

Only people with the `manage` right on the platform can do this; it is audited (`platform.mcp_gateway_changed`). The setting is part of the platform's sealed connection settings, so a change made directly in the database is detected. New platforms, copies and connector types always start with the gateway off. People who call the gateway need the `use` right on the platform.

### How it works

The gateway offers three meta-tools instead of one tool per endpoint:

1. `platform_find_operations` searches the platform's OpenAPI specifications (tab _API specs_) by text or tag. It lists only GET and HEAD operations.
2. `platform_describe_operation` shows the parameters and a trimmed response schema.
3. `platform_call_operation` calls the operation with `pathParams` and `query`.

Platforms **without an API specification** can still be read: list GET path prefixes under _Allowed GET path prefixes_ (e.g. `/api/v1/devices`). Then `platform_call_operation` accepts a literal `path` below one of them. Without prefixes, such a platform offers nothing.

### Rules

- **Read-only.** Only GET and HEAD. Every other method is refused – also when the specification lists it – and the refusal is audited.
- **Paths come from the specification.** Path parameters are checked against their schema and URL-encoded. Values with `/`, `\`, `%`, `;`, control characters, `.` or `..` are refused. A literal path (prefix mode) must start with a single `/`, may not contain `..` segments, `;` (path parameters – `..;/` is a dot segment for Tomcat, Jetty and Spring), encoded separators, `?`, `#`, `@` or `://`, and must lie below an allowed prefix (segment boundary). The request always goes to the platform's base URL; the gateway checks that the final URL has the base URL's origin and path.
- **Query parameters** must be declared by the operation and match their type and enum. Header and cookie parameters, request bodies and custom headers are not supported.
- **Outbound policy.** The URL goes through the same outbound (SSRF) policy as processes (_Settings → Outbound access_), including the always-blocked metadata and link-local addresses. Credentials are only attached for the platform's own origins.
- **Redirects** are not followed; the 3xx answer is returned as it is.
- **Responses** are read up to 512 kB (the rest is cut and marked `truncated`). Credential values – also in encoded forms – and fields such as `authorization`, `password`, `access_token` are masked. Only harmless response headers are returned (`content-type`, `etag`, `link`, …), never cookies.
- **Integrity.** If the platform's connection settings were changed outside Steward, the gateway refuses the call until an administrator confirms them.
- **Fair use.** Gateway calls are rate-limited per user and platform (more tokens do not raise the limit). At most 2 gateway calls per platform run at the same time (`SM_MCP_GATEWAY_CONCURRENCY`, never more than half of the platform's _max. concurrent requests_), so MCP clients cannot block runs and monitors.

### Phase 2 extension point

All non-read methods go through one function, `writeDecision()` in `server/src/mcp/gateway.ts`. In Phase 1 it always refuses. Phase 2 will route changing calls through an approval in Steward instead (see [below](#phase-2)).

## Security model

- **Off by default** – globally (administrator setting, `SM_MCP=off`) and per platform for the gateway.
- **Authentication.** `Authorization: Bearer <token>` on every request, scope _MCP client_ only. Session cookies are ignored, tokens in the URL are refused (`400`). Tokens are stored as hashes, can expire and be revoked. A deactivated owner, an owner who must change their password, and a locked vault all stop the token.
- **Authorization.** Every tool runs as the token owner through the same services and permission checks as the web UI and the REST API. Objects the owner may not see answer like objects that do not exist.
- **DNS rebinding.** The `Host` header must be allowed, and a request with an `Origin` header is refused (`403`) unless the origin is Steward's own (`SM_PUBLIC_URL`) or listed in `SM_MCP_ALLOWED_ORIGINS`. Browsers cannot read answers anyway: Steward never sends CORS headers, and the endpoint only accepts `Content-Type: application/json`.
- **Input limits.** Request bodies up to 64 kB, one JSON-RPC message per request (no batches), strict argument schemas (unknown arguments are errors), cursor and string length limits.
- **Output limits.** Pages of at most 100–200 items, long texts shortened, results above about 200 kB refused with a hint to page.
- **Time limits.** 30 s per tool call, 20 s per gateway call; a client that closes the connection cancels its request.
- **Rate limits** per token (and per IP address without a valid token), and per user and platform for gateway calls; a concurrency cap per platform for gateway calls.
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

| Event                                                                                                                                                                                                  | Where                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| MCP turned on or off                                                                                                                                                                                   | audit log `mcp.settings_changed`                        |
| Gateway turned on or off for a platform                                                                                                                                                                | audit log `platform.mcp_gateway_changed`                |
| First use of a token per UTC day                                                                                                                                                                       | audit log `mcp.token_used`                              |
| **Every gateway call** – platform, operation id, method, path template, status, duration, token id, owner, names (not values) of the query parameters                                                  | audit log `mcp.gateway_call`                            |
| **Every refused gateway call** (write method, path, parameters, outbound policy, integrity) with the reason; an invalid literal path is logged as `(invalid)`, control characters in names are escaped | audit log `mcp.gateway_refused`                         |
| Every tool call: tool, token id, owner, short argument summary (values cut to 60 characters, objects by their keys), outcome, duration                                                                 | operational log (JSON, `info`, message `MCP tool call`) |

Prometheus metrics (`/api/metrics`): `steward_mcp_requests_total{method,outcome}`, `steward_mcp_tool_calls_total{tool,outcome}`, `steward_mcp_gateway_calls_total{platform,outcome}`.

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

Planned, not part of this version:

- **Approved writes.** Changing gateway calls (and starting runs) become requests that a person approves in Steward (four-eyes where configured) before they run – via the `writeDecision()` extension point.
- **OAuth sign-in for MCP clients** following the MCP authorization specification, as an alternative to pasted tokens.
