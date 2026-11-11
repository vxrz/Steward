# 0009. Platform identities: several credentials per platform

- **Status:** Accepted
- **Date:** 2026-11-06
- **Since:** 0.9.0 (#228), planned in steps (below); steps 2 and 3 implemented in 0.13.0; step 4 without the PAM checkout in 0.14.0 (the checkout: ADR 0022, proposed)

## Context

A platform entry has one set of credentials, and access is per entry (`use`, `manage`). To separate privileges, people create two entries for one system (_Snowflake (read)_, _Snowflake (admin)_). Then the base URL, API specs, connector type, TLS settings and AI models are kept twice. Connection tests, maintenance windows, monitors and the catalogue see two platforms. Evidence does not show that both are the same system.

Several credentials on one entry, without more, would be worse: everybody with `use` on the platform could run the privileged one.

What the code does today:

- **One row per platform** (`platforms`, `server/src/db.ts`): `config` (JSON: `auth`, `variables`, `http`, `testPath`, `mcpGateway`, `ai`, `database` – `shared/src/api.ts` `PlatformConfig`), `secrets` (one vault blob, `server/src/platforms/service.ts` `getSecrets`/`setSecrets`), `acl` and `config_mac`.
- **The seal** (`server/src/platforms/integrity.ts`) covers name, kind, base URL, environment, config and a digest of the secrets. The access list is not sealed. `getSecrets` refuses a platform whose seal does not match (`PLATFORM_CONFIG_UNVERIFIED`).
- **Access**: `platformAccess()` in `server/src/auth/policy.ts` calls `decide()`; designers and operators get `use` by default (`DEFAULT_PLATFORM`, `auth/permissions.ts`); `manage` includes `use`; owning teams per ADR [0006](0006-owning-teams-policy-module.md).
- **Runs**: a process has connection slots (`connectionSlotSchema`, `shared/src/process.ts`: `slot`, `kind`, `description`). `StartRunRequest.bindings` maps slot → platform id. `use` is checked in `routes/processes.ts` (`requireBindingsUsable`), at schedule fire (`scheduler.ts`), at trigger save (`routes/triggers.ts`) and fire (`triggers/hook.ts`). `resolveBindings()` in `engine/runner.ts` reads the secrets; `runs.bindings` stores `{ platformId, platformName, baseUrl }` per slot; queued and resumed runs resolve again by platform id. A sub-process maps its slots to the parent's platform ids (`execSubprocess`), without a new rights check.
- **Caches per platform id** in `platforms/http.ts`: `tokenCache` (OAuth2, logins, JWT), `awsCache` (assumed-role sessions), the dispatcher (TLS, proxy) and the semaphore (`maxConcurrency`). `dbms/pool.ts` keeps one pool per platform. `invalidatePlatformCaches()` clears them.
- **Background use**: `monitors/platforms.ts` `platformFor(owner, platformId)` checks the owner's `use` (cached a minute). About 40 more call sites read `getSecrets(platformId)` or `platformFor` directly: access checks (`compliance/reconciliation.ts`), evidence packs, catalogue readers (Kubernetes, repositories, lifecycle), AWS, Kafka, Snowflake, Dependency-Track, Gatus metrics, Entra import, schema snapshots, the credentials register vault link, backups to S3, the MQTT listener, monitor outputs.
- **What is a write**: `isMutating()` (`shared/src/process.ts`) – non-GET/HEAD, unless the step sets `mutating`. Dry runs skip writes on this basis (`execHttp`). The request explorer (`POST /api/platforms/:id/request`) needs `manage` for writes. Steward's own readers also use POST (Prometheus queries, AWS query APIs, Snowflake statements, LLM calls). Monitor outputs, Teams messages, Gatus pushes and backups write.
- **MCP**: `config.mcpGateway` `{ enabled, writes: off|confirm|fourEyes, allowedPathPrefixes }`, set with `PUT /api/platforms/:id/mcp-gateway` (`manage`; writes on is step-up `mcp.allowWrites`). `mcp/gateway.ts` `writeDecision()` decides changing calls; `mcp_requests.platform_id` holds approved writes. Database platforms refuse writes (`MCP_WRITES_NOT_AVAILABLE`, ADR [0008](0008-database-platforms.md)).
- **Operations**: `parseSpec()` stores each spec's operations in `platform_specs.operations`; `listOperations()` gives effective paths (spec path prefix + path). The gateway finds an operation by `operationId` or `METHOD /path` (`findOperation`). An http step's `operationId` is informational only. **Nothing matches a concrete request to an operation today.** The closest code is `platforms/recordings.ts` (`{name}` matches one segment, the most specific match wins) and `platforms/deniedPaths.ts` (decoded segments, checked in `platformRequest` on every redirect hop).
- **Credentials register** (`credentials` table): documentation, never a secret; links a platform (`platform_id`) and a vault secret (`vault_platform_id`).
- **Assurance**: control points in `shared/src/assurance.ts`; `requireStepUp()`, `checkFourEyes()` in `auth/assurance.ts`; a route's `StepUpRule` can apply only `when` a request is sensitive.
- **Migration packages**: every table is classified in `migration/tables.ts`; encrypted columns are listed in `ENCRYPTED_COLUMNS` (`vault-rotation.ts`); the import re-seals platforms that were intact on the source (`migration/import.ts`).
- **PAM** ([IBM-PAM.md](../IBM-PAM.md)): Steward reads vault metadata only and refuses the value endpoints (`deniedPaths.ts`). Fetching Steward's own credentials from the vault is left to a later decision (#205).

## Decision

### Platform and identity

- **Platform** = the system. It keeps everything shared: base URL, kind, specs, TLS and proxy, variables, AI models, database connection, maintenance windows, monitors, health, recordings, catalogue links, documentation, its own access list (`use`, `manage`) and owning teams.
- **Identity** = one set of credentials under a platform: name, description, its sign-in settings (or the platform's), credentials, access list, owning teams, MCP mode, read-only flag, privileged flag, operation filter.
- Every platform has **exactly one default identity**. It is meant to be the least privileged one. Requests that name no identity use it.
- Shown everywhere as **"Snowflake · Read only"**; the default identity's name is shown only where a platform has more than one.

### Data model

New table (named migration `platforms-005-identities`; `platforms-004` is the Kafka Connect migration of 0.9.0):

```sql
CREATE TABLE platform_identities (
  id TEXT PRIMARY KEY,                -- pi_…
  platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  auth TEXT,                          -- AuthConfig JSON; NULL = the platform's config.auth
  variables TEXT NOT NULL DEFAULT '{}', -- overlay on the platform's variables
  secrets TEXT,                       -- vault blob, as platforms.secrets today
  acl TEXT NOT NULL DEFAULT '[]',     -- AclEntry<'use'>[]
  read_only INTEGER NOT NULL DEFAULT 0,
  privileged INTEGER NOT NULL DEFAULT 0,
  operation_filter TEXT,              -- NULL = all; {preset: read|chosen, operations: [...]}
  mcp TEXT NOT NULL DEFAULT '{"mode":"off"}', -- {mode: off|read|writes, writes?: confirm|fourEyes}; with off, writes = the mode chosen before
  credential_source TEXT,             -- NULL = vault; reserved for PAM (#205, step 4)
  config_mac TEXT,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX platform_identities_name ON platform_identities(platform_id, lower(name));
CREATE UNIQUE INDEX platform_identities_default ON platform_identities(platform_id) WHERE is_default = 1;
```

- **Sign-in per identity.** `auth` may differ (a read identity with an API key, an admin with OAuth2; another AWS `roleArn`, `externalId`, `sessionName`). NULL inherits the platform's `config.auth`. `variables` overlays the platform's, e.g. Snowflake `user` and `role`. An identity may **not** override a variable used in the base URL, the token URL's origin or `trustedOrigins` (refused at save, `IDENTITY_VARIABLE_FIXED`): an identity cannot point at another system.
- An operation reference in the filter is `{ specId, method, specPath, operationId? }` – the spec's own path, so a changed path prefix follows.
- Other additive columns: `schedules.identities`, `webhook_triggers.identities` (JSON slot → identity id), `mcp_requests.identity_id`, `credentials.identity_id`, and an `identity_id` on the saved objects that read a platform in the background (access checks, backup settings and the like). JSON definitions gain an optional `identity` field: monitor checks and outputs, process connection slots. `runs.bindings` keeps its JSON column and gains `identityId`, `identityName` per slot.
- `platforms.config.mcpGateway` keeps only `allowedPathPrefixes` (it describes the API, not a credential). `enabled` and `writes` move to the identity. Until the routes per identity exist, the API still shows `config.mcpGateway` with `enabled` and `writes` read from the default identity.
- `OWNED_KINDS` (`shared/src/api.ts`) gains `platform_identity`, so `resource_teams` holds identity owning teams.

### Migration: one default identity per platform

- The SQL migration inserts one row per platform: id `pi_` + the platform id's random part (deterministic, so migration packages and references line up), name _Default_, `is_default = 1`, `auth = NULL`, the **ciphertext** of `platforms.secrets` copied unchanged (the vault encrypts without context, so the copy decrypts), no filter, not read-only, not privileged, and the MCP mode from `config.mcpGateway` (`enabled` → `read`, `writes` → `writes` with its approval mode; SQLite `json_extract`, a PostgreSQL variant in `pg`).
- **The access list is not copied.** The default identity is open to everybody with `use` on the platform, which is exactly today's rule. The platform keeps its `acl`; two copies of one list would drift.
- **A one-time step after the next unlock** (like `sealPlatformConfigs`, setting `security.platformIdentitiesMigrated`): for each platform whose seal is `ok`, write its default identity from the platform row (its credentials, the MCP mode, everything else at the defaults – never the unsealed copy, which could have been changed in the database in between), seal it, set `platforms.secrets = NULL`, drop `enabled`/`writes` from `config.mcpGateway`, re-seal the platform. One transaction per platform; a platform that fails is rolled back and tried again at the next unlock (the setting is written only when none failed). One audit entry `platform.identities_created` per run (actor `system`, count, names, platforms not intact, failures). A platform that is not intact keeps its unsealed identity: both are refused until an administrator confirms (`confirm-config` then moves the credentials and seals both).
- **Nothing changes in behaviour**: one identity, the same credentials, the same people, the same MCP mode.
- **Additive.** No column is dropped (`platforms.secrets` stays, empty). Steward does not support downgrades ([INSTALL.md](../INSTALL.md)): going back means the pre-upgrade copy or a backup, which still has the old layout.

### Secrets, seals and caches

- Secrets live in the vault per identity: `platform_identities.secrets`, registered in `ENCRYPTED_COLUMNS` so key rotation, backups and migration packages re-encrypt them.
- **Identity seal**: `checkMac('platform_identity', id, …)` over `platform_id`, name, `is_default`, `auth`, `variables`, the secrets digest, `read_only`, `privileged`, `operation_filter`, `mcp`, `credential_source`. Binding `platform_id` stops a row (with its credentials) being moved to another platform in the database. The access list stays unsealed, as for platforms; its changes are audited.
- **One resolver**: `getConnection(platformId, identityId?)` in `platforms/service.ts` returns `{ platform, identity, secrets }`, checks both seals, and gives the platform object with the identity's `auth` and `variables` merged in. `platformRequest`, `obtainAuthHeader`, `signerFor`, `resolveBaseUrl` keep their signatures and logic. `getSecrets(platformId)` stays as "the default identity" for the call sites not yet converted.
- **Caches per identity**: `tokenCache` and `awsCache` keyed by `platformId:identityId`; `tokenInfo`, `renewToken`, `tokenClaims` per identity; database pools per identity (each identity is its own database account). The dispatcher and the semaphore stay per platform: TLS and the platform's capacity are shared. `invalidatePlatformCaches(platformId)` clears all identities; changing one identity clears only its entries.
- **Masking**: error reports and the redactors mask the secrets of all identities of a platform (`allSecretsUnchecked`), not only the one in use. `getSecretsUnchecked` stays the default identity's (names of its keys).

### Who may use an identity

- Using an identity needs **both** `use` on the platform **and** `use` on the identity. One function, `identityAccess(u, platform, identity)` in `auth/policy.ts`, decides it and returns the reasons (_Why do I have access?_ shows "platform: designer" and "identity: access list team:dba").
- **Default identity**: `use` on the platform is enough. It has no access list of its own.
- **Other identities** are **closed by default**: only administrators, owning-team members whose team role gives `use` (designer, operator), and access-list entries. `decide()` gets an option `instanceDefaults: false`, so instance roles alone give nothing on an identity.
- **Managing** identities (create, edit, credentials, delete, test) follows the platform's `manage`. A manager is not a user of a non-default identity unless listed (open question 1).
- **Step-up** (baseline `access.grant`) for: an identity's access list or owning teams, making another identity the default (everyone with `use` gets it), and loosening an identity (read-only off, filter wider or removed, privileged off). MCP writes on uses `mcp.allowWrites`, as today.
- The credentials stay the real boundary: they should only have the rights the identity needs in the target system. Steward's checks are an additional layer – the docs say so.

### Choosing the identity in a run

- **Slots.** A connection slot may say `identity: { writes: true }` – it needs an identity that is not read-only. Old slots say nothing and accept any identity. A process that reads and writes the same system has two slots for one platform (`sf_read`, `sf_admin`). The process check warns, without failing, when a writing step uses a slot not marked `writes`.
- **Start dialog.** Per slot, the person picks the platform and then an identity among those they may use. Only the default → no choice shown. `StartRunRequest` gains `identities: Record<slot, identityId>`; a missing slot means the default.
- **Rights at start.** `POST /api/runs` checks `identityAccess` and the slot requirement (`IDENTITY_WRITE_REQUIRED`), next to `requireBindingsUsable`.
- **Dry runs** use the default identity unless the person picks another. A skipped write is still checked against the identity the slot is bound to: a write the identity would refuse fails the dry run with the same error, so the dry run shows it before the real run.
- **Test runs** (recorded responses) send nothing. The read-only and filter checks still run before a recording is looked up, as `assertPathAllowed` does today. Recordings stay per platform.
- **Schedules and webhook triggers** name the identity per slot (`identities` column). Checked against the owner's rights when saved, and again at each fire. A failure skips with new reason codes `mayNotUseIdentity`, `identityMissing` (`scheduler.ts`, `triggers/hook.ts`). A duplicated schedule starts disabled (as today) and is checked against the new owner.
- **Sub-processes inherit**: a child slot mapped to a parent slot gets the parent's identity. A child cannot choose another (that would be a way around the start dialog). A child slot with `writes: true` mapped to a read-only identity fails the step. The parent's actor is checked again for the identity at child start.
- **Queued and resumed runs** resolve the stored identity id. A deleted identity fails the run with its name; a run is not switched to another identity silently.
- `runs.bindings`, run protocols and reports carry the identity's id and name.

### Monitors, health checks and Steward's own readers

- A monitor check or output, an access check, a dataset reader, a backup target, a credentials register vault link names an identity or uses the default. `platformFor(owner, platformId, identityId?)` and `ownerProblem` check the identity for the owner (cache key with the identity). Rights are checked when saving and at every run.
- The periodic connection test (`platforms/health.ts`) tests the default identity. _Test connection_ tests one identity; every test is audited (`platform.tested` with `identityId`).
- The call sites listed in _Context_ move to `getConnection` one module at a time; until then they keep `getSecrets(platformId)` = the default identity. A unit test lists the remaining direct callers, so none is forgotten.

### Read-only identities: what counts as writing

A read-only identity refuses, **before anything is sent**, with `IDENTITY_READ_ONLY`:

- any non-safe HTTP method (not GET, HEAD) from a process step, the request explorer, a connection test or MCP. A step's `mutating: false` does **not** count: designers set it, the identity's managers set the flag. A POST that only reads is allowed only when the identity's operation filter chooses that operation;
- approved writes (MCP requests are refused when created and again when approved);
- `accessChange` steps (an access change recorded through a read-only identity cannot be right);
- browser steps with interaction actions (the `dryRunReadOnly` set is the limit);
- Steward's own writers: monitor outputs, Teams and webhook messages, Gatus pushes, backups to S3. They need an identity that is not read-only; saving them checks it.

Steward's own fixed reads that use POST (Prometheus queries, AWS query APIs, Snowflake statements, LLM calls, Kafka and MQTT reads) pass `intent: 'read'` to `platformRequest`. Only Steward's code sets it; steps cannot.

Database platforms are read-only already (ADR 0008). Their identities show _Read only_ fixed.

The check sits in **one place**: `platformRequest` (next to `assertPathAllowed`, on every redirect hop), plus the dry-run skip branch of `execHttp` and the non-HTTP step functions (`query`, `accessChange`, `browser`).

### Operation filter

- **Only for platforms with at least one OpenAPI spec.** Presets: _All_ (no filter, the default); _Read_ (every GET and HEAD of the current specs, plus chosen extras); _Chosen_ (operations picked one by one). Setting the read-only flag on an identity with specs selects _Read_ unless operations were chosen.
- **Matching** (new `platforms/operationFilter.ts`): the final URL after `buildUrl`. Its origin must be the base URL's and its path must lie below the base URL's path; the rest is split into decoded segments like `deniedPaths.pathSegments` (undecodable segments and encoded `/` refused). `{param}` matches one non-empty segment. The **most specific** matching operation decides (most literal segments, as in `recordings.ts`); `/users/me` is not allowed because `/users/{id}` is. HEAD counts as GET. Query and body are not part of the match.
- **With a filter set, a request that matches no operation is refused** – undocumented endpoints, other trusted origins, AWS service endpoints of `step.aws`, browser steps. Error `IDENTITY_OPERATION_REFUSED` (method, path, identity, the closest operation if any), audited as `platform.identity_refused`.
- **Checked before sending**, in process steps, the request explorer, connection tests (a `testPath` outside the filter says so), the contract check (refused operations listed as skipped) and MCP. `platform_find_operations` lists only allowed operations. Prefix mode (literal paths) must also match an allowed operation.
- **When the spec changes**: _Read_ follows (new GET operations are in, new POSTs are not). Chosen references survive a replaced spec (`copySpec` with `replace` keeps the spec id) and a new path prefix. References that no longer resolve are **stale**: they match nothing (fail closed), the _Identities_ tab marks them, and the spec's audit entry (`platform.spec_added|updated|deleted`) lists the identities affected. A filter whose specs are all gone refuses everything until someone edits it.
- **Limit**: the filter sees method and path, not the body. A chosen `POST /graphql` also lets mutations through. The docs say so; the credentials decide.
- **Platforms without a spec or not REST** (databases, Kafka, MQTT, Snowflake's own client): no filter is offered. The read-only flag and the kind's own read-only rules apply.

### MCP gateway

- The mode is per identity: _off_, _read_, _approved writes_ (`confirm` or `fourEyes`, still raised by the policy's `mcp.write`). New identities, copies and connector types start _off_, as the gateway does today.
- `platform_call_operation` and `platform_find_operations` take an optional `identity` (name). Without it, **reads use the default identity**; a changing call without it uses the default only when that allows writes. The token owner must be allowed to use the named identity. Its mode, read-only flag and filter apply.
- `list_platforms` shows per platform the identities open to the token owner over MCP (name, mode, _read only_).
- `mcp_requests.identity_id` records the identity. Approval re-checks the identity's rights, mode and flags at that moment. A second person must be allowed to use the identity.
- Privileged identities: MCP mode is _off_ or _approved writes_ with `fourEyes`; reads with them are refused. Approving needs the approver's step-up (`platform.privilegedIdentity`). `request_run` starts runs with default identities only.
- `mcp.gateway_call` audit entries and the gateway log name platform and identity.

### Privileged identities

- A flag set by platform managers. Turning it off is a loosening (step-up, above).
- **Step-up**: new control point `platform.privilegedIdentity` (group `identity`; step-up `on`; action `usePrivilegedIdentity`). It applies to starting a run, saving a schedule or trigger, a request explorer call and approving an MCP request with a privileged identity. Routes declare it with `StepUpRule.when` (only requests that name a privileged identity). Being `on` by default changes nothing until someone marks an identity privileged. API tokens cannot step up, so `/api/v1` and scripts cannot start privileged runs.
- **Four-eyes before the run**: the same control point has four-eyes `off` (only where a process asks; the policy can make it `required`). A process setting _Privileged runs need a second person_ is the override. Such a run starts in `waiting` with one start approval before the first step. A person with `approve` on the process decides it, never the starter or the schedule owner (`checkFourEyes`, `sameIdentity`). It expires after 24 hours (run cancelled, audited). Scheduled and triggered runs wait the same way.
- `ASSURANCE.md`'s table and `server/test/assurance.test.ts` gain the point.

### Credentials register and PAM

- An entry can link one identity (`credentials.identity_id`, next to `platform_id`). The _Identities_ tab shows each identity's entry with its status and next due date. A privileged identity without an entry gets a warning, not a block.
- Changing an identity's credentials offers _This is a rotation_ (on by default). It records _Rotated_ on the linked entry (`credential.rotated`, with the identity).
- The register stays documentation: it never receives a secret.
- **PAM checkout per identity (#205)** is reserved, not built here: `credential_source = { kind: 'pam', vaultPlatformId, secretId, fields, checkout: true }` would check out at run start, keep values in memory and check in at run end. This reverses "Steward never reads a secret value" ([IBM-PAM.md](../IBM-PAM.md)) and the value deny list, so it needs its own decision record before step 4 (open question 4).

### Evidence and audit

- Run protocols, run reports, evidence packs, `run.started` (bindings), `api.write`, `api.write_skipped` and the MCP log name platform and identity.
- Audit entries stay on the platform (`entityType: 'platform'`, `details.identityId`), so the platform's history shows everything: `platform.identity_created|updated|deleted`, `…_secrets_changed`, `…_access_changed`, `…_mcp_changed`, `…_filter_changed`, `…_default_changed`, `platform.identity_refused`.
- Prometheus metrics stay per platform (no identity label: cardinality).

### APIs, import and export, copies

- **Internal API**: `GET/POST /api/platforms/:id/identities`; `PUT/DELETE …/identities/:iid`; `PUT …/:iid/secrets|access|mcp`; `POST …/:iid/default|test|token/renew`. Deleting the default is refused. Deleting an identity still named by a schedule, trigger, monitor or saved check is refused with the list. The old routes (`PUT …/secrets`, `POST …/test`, `…/token/renew`, `PUT …/mcp-gateway`) act on the default identity for one release. Every new route is classified in `route-matrix.test.ts` (ADR [0005](0005-route-access-declared-on-routes.md)); object rights stay in the services.
- **`/api/v1`**: `GET /platforms` and `/platforms/{id}` gain `identities: [{ id, name, description, default, readOnly, privileged, mcp, operationFilter: { preset, operations } | null, mayUse }]`. They are shown to whoever sees the platform. Never secrets, `auth` or variables. `RunDetail.bindings` gains `identityId`, `identityName`. All additive.
- **Connector types** (`platforms/connectors.ts`, `ConnectorPackage`): carry identity templates – name, description, read-only, privileged, filter (preset and `METHOD specPath` references into the bundled specs). Never secrets, access lists or an MCP mode. A platform made from the type gets these identities without credentials, closed (empty access list), MCP off.
- **Copy specs to other platforms** (`copySpec`): copies specs only by default. Option _Also copy the operation filters_: for each identity of the source, the target identity of the same name gets the filter, or is created without credentials, closed and MCP off. It needs `manage` on the target (as now), never copies secrets and grants nobody anything.
- **Postman export** (`export/postman.ts`): the default identity, or a chosen one; credentials stay empty variables.
- **Git sync**: processes carry slot requirements (`identity.writes`); monitors may name an identity by name, resolved like platform names. Identities themselves are not synced (platforms are not).
- **Migration packages / instance moves**: `platform_identities` is `MOVED` in `migration/tables.ts` (`acl` in `USER_REFS`; `created_by`/`updated_by` are history, in `HISTORY_COLUMNS`); `resource_teams` rows of kind `platform_identity` follow the identity mapping; secrets re-encrypted through `ENCRYPTED_COLUMNS`; the manifest gains `identityIntegrity` and the import seals identities that were intact on the source, like platforms. A package from an older version gets its default identities in staging by the same SQL migration; the import then moves the credentials of each platform that was intact on the source, as the one-time step does.

## UI outline

- **Platform page → tab _Identities_** (replaces _Credentials_). A row per identity: name, badges _Default_, _Read only_, _Privileged_, _MCP: read_, filter summary (_Read + 2_, _12 chosen_, _3 stale_), last test, register entry. Opening one: description, sign-in (inherit or own), credentials, access list and owning teams, MCP mode, filter (preset buttons, then a searchable list of operations by tag with checkboxes), _Test connection_, _Get a new token_.
- **Platform → _MCP_** keeps the path prefixes and shows each identity's mode with a link.
- **Run dialog** (`web/src/components/RunDialog.tsx`): per slot, platform, then identity (only those the person may use). A _Privileged_ choice says a step-up – and maybe a second person – will be needed. A slot that needs writes hides read-only identities.
- **Process editor**: slot settings gain _Needs an identity that can write_. A writing step on a slot without it shows a hint. Schedule, trigger, monitor-check and output editors get the identity picker.
- **Badges** wherever a platform is named in runs, reports and the audit view: "Snowflake · Read only".

## Alternatives considered

- **Two platform entries per system (today).** Settings kept twice, health and catalogue split, no evidence they are one system. That is the problem.
- **Credentials per step.** The designer picks the credential in the definition, but the person who runs is not the designer. Rights would have to be checked per step at run time, and the start dialog could not show what will be used. Slots already are the place where a run meets a platform.
- **A separate "connection" object** (platform + credentials, referenced by processes). A third kind with its own access list, seal, catalogue and API, and every existing binding to migrate. An identity under its platform gives the same separation with one new table, and reuses the platform's settings, access and history.
- **Personal credentials per user.** Good for interactive tools, wrong for service procedures. Schedules and four-eyes need credentials that do not belong to whoever happens to start the run. Leavers break runs, and evidence shows a person's account instead of a technical one. It could come later as an identity whose `credential_source` is per user; nothing here prevents it.

## Consequences

**Positive**

- One platform per system: settings, health, maintenance, monitors and catalogue once; evidence names system and credential.
- Least privilege becomes the default path: the default identity can be read-only, and privileged credentials have their own access list, step-up and optional four-eyes.
- Defence in depth for APIs with a spec: the filter limits what a credential is used for in Steward, even when the credential could do more.

**Negative**

- More to understand: two access checks, slot requirements, a filter that can go stale. The _Why do I have access?_ panel and the refusal messages must explain both layers.
- About 40 call sites move from `getSecrets(platformId)` to `getConnection()`; until each moves, it uses the default identity.
- Cache keys, pools and seals per identity add code paths to test.

**Risks**

- **Threats considered for steps 2 and 3** (0.13.0):
  - _Moving or adding identities in the database._ The identity seal binds `platform_id`, so a row (with its credentials) moved to another platform is refused; a row inserted directly is unsealed and refused. Confirming the platform's settings keeps the default identity (as the platform's confirmation always did) and every identity whose own seal verified; any other identity is shown in the dialog, kept **disabled** (`disabled` is part of the seal when set, so enabling it in the database breaks the seal) and refused at use (`IDENTITY_DISABLED`) until an administrator enables it one by one with a step-up, after reading its access list (`platform.identity_enabled`) – the conservative default for 0.13.0 (migration `platforms-007-identity-disabled`).
  - _Access lists are not sealed_ (as for platforms). Someone who can write the database can add themselves to an identity's list; every change through Steward is audited (`platform.identity_access_changed`), and the credentials remain the real boundary.
  - _An identity that points elsewhere._ Variables used in the base URL, token URLs, trusted origins and the portal cannot be set on an identity (refused at save, ignored at use). An identity's **own sign-in settings** may only send its credentials to the platform's own origins – the base URL's, the trusted origins and those of the platform's own sign-in (token URL, login and refresh requests, STS endpoint); relative URLs go to the base URL; anything else, and a URL with an expression other than `{{ baseUrl }}` and `{{ vars.x }}`, is refused when saved (`IDENTITY_AUTH_ORIGIN`, the conservative default for 0.13.0 – it may be relaxed later). A later change of the platform's own settings is not re-checked against its identities; since 0.19.0 a change of the platform's addresses needs a step-up in a signed-in session and removes the stored credentials of every identity unless an administrator keeps them ([PLATFORMS.md](../PLATFORMS.md#changing-the-address)), and the connection variables of Kafka and MQTT platforms cannot be set on an identity either.
  - _Using an identity without the right._ `identityAccess()` is checked on the server for every use: the run start (and each queued or resumed start resolves the stored identity again, never another one), schedules and triggers when saved and at every fire as their owner, sub-processes for the parent's actor, monitor checks and outputs for the owner (cached for at most a minute, as platform rights), the request explorer and MCP (the token owner; again when a request is approved, and the second person must be allowed to use it). An identity id of another platform is not found.
  - _Read-only and filter bypass._ The check runs before anything is sent, in `platformRequest` on every redirect hop (a redirect to a path or host outside the filter is refused before the next hop), in the dry-run and test-run branches, and for access-change and browser steps. `intent: 'read'` is a field of Steward's internal request only (no step sets it) and lifts only the read-only flag, never the filter. The flags are read with the identity's seal checked when the run resolves its connection: a change during a running run applies to the next run.
  - _Matcher mistakes._ The filter fails closed: undecodable segments, encoded `/` or `\`, `;` and dot segments are refused; literals compare case-insensitively for the decision, and on a tie every tied operation must be allowed; a request matching no operation is refused.
  - _Caches._ A plain platform object stands for the current default identity in the token and AWS caches; making another identity the default clears the platform's caches.
- A wrong matcher could let a request through. Mitigation: fail closed (no match → refused), the most specific match decides, decoded segments as in `deniedPaths.ts`, a test table with tricky paths (`..`, `%2F`, `;`, trailing slashes, `{id}` against literals).
- The default identity keeps today's (often broad) credentials after the upgrade. Steward cannot fix that; the release notes and the _Identities_ tab suggest adding a read-only identity and making it the default.
- Privileged runs that wait for a second person can stall scheduled work. Expiry and notifications make it visible; it only applies where a process asks or the policy requires it.

### Migration and rollout plan

Each step is its own PR. Each is backward compatible: until someone adds a second identity, nothing changes.

1. **Model and default identity, no behaviour change.** Table, SQL migration, one-time seal step, identity seal, `ENCRYPTED_COLUMNS`, migration-package classification, `getConnection()`, caches keyed per identity, the old routes on the default identity, `/api/v1` identities (read-only fields), the _Identities_ tab showing the one default. Tests: an upgraded database behaves exactly as before, including MCP modes and seals.
2. **More identities and choosing them** – _implemented in 0.13.0_ (see "Changed while building steps 2 and 3"). Create, edit and delete identities; access lists, owning teams and `identityAccess`; slot requirements; the run dialog; schedules, triggers and sub-processes; monitors and background readers with `identity`; MCP mode per identity and the `identity` tool argument; evidence and audit with identity names; connector types carrying identity templates.
3. **Read-only flag and operation filter** – _implemented in 0.13.0_. `intent: 'read'` for Steward's own readers; the checks in `platformRequest`, the dry-run branch, non-HTTP steps and MCP; `operationFilter.ts` with presets, stale references and the _Copy specs_ option; `IDENTITY_READ_ONLY`, `IDENTITY_OPERATION_REFUSED`.
4. **Privileged identities and PAM** – _implemented in 0.14.0 without the PAM checkout_ (see "Changed while building step 4"). Control point `platform.privilegedIdentity`, step-up on the four places, the start approval, register links and rotation, privileged MCP rules. PAM checkout only after its own decision record: [ADR 0022](0022-privileged-access-checkout.md) (proposed); `credential_source` stays reserved and unused.

## Changed while building step 1

1. The migration is `platforms-005-identities` (0.9.0 already has `platforms-004-kafka-connect`).
2. `created_by`/`updated_by` of `platform_identities` are history columns, not `USER_REFS` (they say who did something, like every other `created_by`).
3. The one-time step writes the default identity from the sealed platform row instead of sealing the copy the SQL migration made, runs one transaction per platform and retries failures at the next unlock (above).
4. The MCP mode `off` may keep `writes`: 0.8.0 remembered the approval mode while the gateway was off, and turning it on again restored it.
5. `OWNED_KINDS` gains `platform_identity` in step 2, with owning teams of identities; step 1 has no owning teams on identities.
6. The caches key a plain platform object (from `getPlatform`) as the default identity, whose id is derived from the platform id. Step 2 (another identity can become the default) has to key it by the actual default identity, or convert the remaining callers to `getConnection` first.
7. A platform's `integrity` is the worst of its own seal and its identities' seals; `confirm-config` seals both.

## Changed while building steps 2 and 3

0.13.0. What differs from the decision above, and why:

1. **Migrations**: `platforms-007-identity-disabled` adds `platform_identities.disabled` (identities kept disabled at a confirmation, see the threat notes); `platforms-006-identity-choices` adds `schedules.identities`, `webhook_triggers.identities` (JSON slot → identity id, default `'{}'`) and `mcp_requests.identity_id`. `credentials.identity_id` (register links and rotation) moves to step 4 with the rest of the register work.
2. **Background readers** other than monitors (access checks, catalogue readers, backups, the register's vault link …) still use the default identity: their saved objects get no identity column yet. Monitor checks and outputs name an identity (`identity`, by id or name; stored by id after saving). Process outputs of monitors take `identities` per slot (API and YAML; the editor has no picker for them yet).
3. **Owning teams of an identity** are set with the general owning-teams route (`kind: platform_identity`) – by administrators, adding a team with a step-up – not by platform managers.
4. **Routes**: `PUT …/identities/:iid` changes name, description, sign-in, variables, read-only flag and filter together (a loosening asks for the step-up); `GET …/identities/:iid/settings` gives managers the sign-in settings and variables (never credentials) and the filter's references resolved, stale ones marked.
5. **A new default identity's access list is cleared** (the default has none; the audit entry keeps it); the former default becomes closed like any other identity.
6. **Read-only and filter**: `intent: 'read'` lifts the read-only flag only, never the filter. A read-only identity lets a changing method through only for operations the filter chose one by one. The flags apply as read when the run (or monitor read, MCP call) resolves its connection.
7. **Matching**: literals compare case-insensitively when deciding (a server that ignores case cannot be used to slip past a more specific operation); on a tie every tied operation must be allowed; `;` path parameters are refused.
8. **Connector types**: a template with `default: true` names and flags the new platform's default identity; the privileged flag is not carried (step 4). Filter references are `METHOD /specPath` of the bundled specs.
9. **Copy specs**: an identity of the same name on the target gets the filter only when that does not widen it (otherwise it is skipped and listed – widening needs its managers' step-up on the target).
10. **Writing steps on a slot without `identity.writes`**: the process editor's _Connections_ panel shows a hint next to the slot's switch _Needs an identity that can write_; the server's process check does not warn.
11. **Not built in this step**: the contract check and the Postman export use the default identity; debug runs (step-through and single node) and `request_run` use default identities; run reports show the identity in the run detail and `run.started`, not yet in the PDF; database platforms show _Read only_ fixed in the dialog, the flag itself is not stored.

## Changed while building step 4

0.14.0, without the PAM checkout (ADR 0022, proposed – `credential_source` is unchanged and unused). What differs from the decision above, and why:

1. **Migrations**: `platforms-008-start-approval` adds `run_tasks.start_approval` (JSON: the privileged identities per slot, who asked, why, until when) – a start approval is a task of the run with the step key `$start`, so the existing decision paths, notifications, run protocols, reports and restarts carry it. `credentials-005-identity` adds `credentials.identity_id` (indexed). The flag itself was in `platform_identities` (and its seal) since step 1.
2. **The default identity is never privileged** (`IDENTITY_DEFAULT_PRIVILEGED`), and a privileged identity cannot become the default. Everyone with `use` and Steward's own background readers (access checks, catalogue readers, backups …) use the default identity without anyone confirming; a privileged default would bypass every check of this step. The conservative choice for 0.14.0 – the owner may decide otherwise.
3. **Monitors never use a privileged identity**: checks, outputs and the process runs of outputs are refused when saved (`IDENTITY_PRIVILEGED_BACKGROUND`) and at use (the owner check, a fire whose identity became privileged). The decision above names no rule for monitors; reading in the background with privileged credentials, unconfirmed, is what the flag exists to prevent.
4. **The step-up also applies to approving a start approval** (the approver confirms), to _Run now_ of a schedule (a start) and to changing a schedule or trigger that names one. Each route declares it with `StepUpRule.when`; the handler checks again that the request passed the hook for `platform.privilegedIdentity` (an identity marked privileged in between answers `IDENTITY_PRIVILEGED_CONFIRM`). Start approvals and MCP requests with a privileged identity are never decided in Microsoft Teams (`needsSteward`): a card cannot show a step-up.
5. **The start approval**: decided by a person with the `approve` right on the process (not `run`, unlike approval steps), who need not be allowed to use the identity – as decided above. Not the starter, nor the owner of the schedule, trigger or monitor that started the run (for _Run now_ both the person and the owner). Rejecting cancels the run with the reason (like the expiry). The expiry job runs every five minutes. Test runs (recorded answers) send nothing and never wait; the step-up still applies to their start. A sub-process run waits only when its own process asks and no run above it had its start approved; it asks no step-up (no request).
6. **When the flag counts**: read when the run resolves its connections, like the read-only flag; `runs.bindings` records `privileged` per slot. A run that started before the flag was set never gains a start approval, also not when resumed after a restart; a start approval that waits stays when the flag is turned off meanwhile.
7. **MCP**: setting the flag tightens the stored mode (_read_ → _off_, _confirm_ → _fourEyes_, audited); `writeDecision` treats a privileged identity's approved writes as `fourEyes` whatever is stored. `platform_find_operations` lists no read operations for it. `request_run` is unchanged: it binds no slots (default identities only, never privileged).
8. **Register**: the rotation is recorded on every entry that documents the identity (not archived), for the person who saved the credentials whatever their rights on the entries – a fact of the platform, audited (`credential.rotated`, `source: "identity"`). Only a new value counts; removing one does not. `/api/v1` credentials do not show the link yet.
9. **Connector types** carry the flag on non-default templates; _Copy specs_ creates a privileged identity where the source's was (both are tightenings).
10. **Not built**: the PAM checkout; debug runs and the contract check still use default identities (never privileged).

## Decided after review

1. **Do platform managers use every identity of their platform?** Decided: no. Managers configure; using a non-default identity needs a place on its list (they can add themselves, with a step-up and an audit entry). Administrators keep every right, as in ADR 0006.
2. **Can the default identity have its own access list?** Decided: no. "Default" means "everyone with `use`". To narrow it, narrow the platform. This differs slightly from the issue's "its current access list" for the migration: the list stays on the platform, with the same effect.
3. **Four-eyes on privileged runs: start approval or per write?** Decided: one approval before the run starts (simple, matches the issue). The approver sees process, inputs and identities. Approving each write would need a dry-run diff Steward does not have.
4. **PAM checkout (#205): who reads the value, and through which account?** Decided: a separate vault platform identity flagged _checkout_. It may only read the listed secret ids; the value endpoint is allowed only for it, from Steward's own code, never from steps or MCP. Values stay in memory for the run. All of this in its own ADR before step 4.
5. **Connector types and _Copy specs_ (the issue's question).** Decided: copy names, descriptions, flags and filters, never secrets, access lists or MCP modes. Connector types always carry them. _Copy specs_ does so only when asked; created identities are closed and have no credentials.
6. **Who sees identities they may not use?** Decided: everyone who sees the platform sees names and flags (UI and `/api/v1`, with `mayUse`). It explains why a choice is missing and is evidence. Names must not reveal secrets; the secret check of the register applies to them.
