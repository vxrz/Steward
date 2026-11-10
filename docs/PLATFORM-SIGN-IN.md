# Platform sign-in

How Steward signs in to a platform is its **auth type** (_Platforms → a platform → Settings → Authentication_). Credentials are stored encrypted in the vault, sent only to the platform's own origins (and to its token or STS endpoint), never shown again and masked in everything Steward returns – the request explorer, test runs, the MCP gateway, logs.

| Auth type                       | Credentials                                                 | Used by                                                       |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| None                            | –                                                           | public APIs (endoflife.date)                                  |
| Basic                           | `username`, `password`                                      | many on-prem APIs; on Kafka platforms the Schema Registry key |
| Static bearer token             | `token`                                                     | GitHub, GitLab, Forgejo, Kubernetes, Checkmk                  |
| API key                         | `apiKey` (header or query)                                  |                                                               |
| OAuth2 client credentials       | `clientId`, `clientSecret` – or `privateKey`, `certificate` | Insights Hub, Microsoft Graph (Entra ID)                      |
| Custom login request            | any, referenced as `{{ secrets.x }}`                        | Industrial Edge Management, IBM Verify Privilege Vault        |
| **Key-pair JWT**                | `privateKey` (PEM), optionally `privateKeyPassphrase`       | Snowflake; Google service accounts, Salesforce (exchange)     |
| **AWS request signing (SigV4)** | `accessKeyId`, `secretAccessKey`, optionally `sessionToken` | AWS APIs, S3 and S3-compatible storage                        |

The connection test, _Get a new token_ (for logins, JWTs and assumed roles) and the MCP gateway work the same for every type.

## Identities

A platform's credentials belong to an **identity** under it ([ADR 0009](adr/0009-platform-identities.md)). The platform is the system – base URL, specs, TLS, variables, monitors, health, access list; an identity is one set of credentials for it, with its own name, description, sign-in settings (or the platform's), variables, access list, owning teams, MCP mode, read-only flag, privileged flag (0.14.0, [below](#privileged-identities)) and operation filter. Shown as **"Snowflake · Read only"**; the default identity's name only where a platform has more than one.

- **The default identity.** Every platform has exactly one. Requests that name no identity use it – runs, schedules and triggers without a choice, monitors, Steward's own readers (access checks, catalogue readers, backups …), MCP calls without `identity`. It is open to **everyone with the _use_ right on the platform** and has no access list of its own: to narrow it, narrow the platform. It should be the least privileged identity – after the update it still holds the platform's old (often broad) credentials, so consider adding a read-only identity and making that the default.
- **More identities** (_Platform → Identities → Add identity_, people with _manage_ on the platform). A new identity is **closed**: only administrators, members of its owning teams who design or operate, and the entries of its access list (users, teams, roles with _use_) may use it – and only if they may use the platform as well. **Managing the platform does not make someone a user** of its identities: a manager who needs one adds themselves to its list (audited, with a confirmation). The _Why do I have access?_ panel of an identity explains both layers.
- **Sign-in and variables.** An identity signs in with the platform's settings or its own (another API key, another OAuth2 client, another AWS role ARN or external ID). Its variables replace the platform's (a Snowflake `user` or `role`). A variable used in the base URL, a token URL, the trusted origins or the portal URL cannot be set (`IDENTITY_VARIABLE_FIXED`) – an identity cannot point at another system; a value stored there anyway is ignored when a request is sent. Its own sign-in settings may send its credentials **only to the platform's own origins**: the base URL's, the trusted origins and the origins of the platform's own sign-in (its token URL, login and refresh requests, STS endpoint); a relative URL goes to the base URL. Any other address – or a URL with an expression other than `{{ baseUrl }}` and `{{ vars.x }}`, which cannot be checked when saving – is refused (`IDENTITY_AUTH_ORIGIN`). The check runs when the identity's sign-in settings or variables are saved; a later change of the platform's own settings is the platform managers' change and is not checked against its identities.
- **Credentials** of each identity are in the vault (its _Credentials_ tab in the identity dialog), never shown again, masked in protocols and error reports – those of all identities of a platform. Tokens, assumed AWS roles and database connections are kept per identity; key rotation, backups and migration packages cover every identity.
- **Making another identity the default** gives it to everyone with _use_ and closes the former default like any other identity; its access list is cleared (the audit entry keeps it). Confirmed with a step-up.
- **Deleting** an identity removes its credentials. The default identity cannot be deleted, nor an identity a schedule, webhook trigger or monitor still names (`IDENTITY_IN_USE` lists them).
- **Seals.** Each identity is sealed like the platform – platform, name, default flag, sign-in settings, variables, credentials, read-only and privileged flags, operation filter and MCP mode. A row changed directly in the database (or moved to another platform) is refused until an administrator confirms it. The access list is not sealed; every change of it is audited.
- **Audit**: `platform.identity_created|updated|deleted`, `…_secrets_changed`, `…_access_changed`, `…_mcp_changed`, `…_filter_changed`, `…_default_changed` and `platform.identity_refused`, all on the platform (`details.identityId`, `identityName`). `platform.tested` names the identity tested.

### Choosing the identity

- **Runs**: the run dialog shows, per connection slot whose platform has several identities, the identity – only those you may use can be chosen. Without a choice the default identity is used. The run records the identity's id and name per slot (run detail, protocol, `run.started`, `/api/v1` `RunDetail.bindings`); a queued or resumed run uses the same identity again, and fails with its name when it was deleted – it never switches to another one. Dry runs and test runs use the identity chosen too.
- **Slots that write**: a process's connection slot may say `identity: { writes: true }` – it then needs an identity that is not read-only (`IDENTITY_WRITE_REQUIRED`); read-only identities are not offered for it.
- **Schedules and webhook triggers** name the identity per slot (`identities`); it is checked for the person saving and again for the owner at every fire. A fire the owner may no longer make is skipped (reasons `mayNotUseIdentity`, `identityMissing`).
- **Sub-processes** inherit the identity of the parent's slot; a child cannot choose another one, and the parent's actor is checked again.
- **Monitors**: a check or output on a platform may name an identity (`identity`: its id or name) – see [MONITORS.md](MONITORS.md#identities). **MCP**: [MCP.md](MCP.md#identities).
- **The request explorer** sends with the identity you choose (`identityId`), if you may use it.

### Read-only identities and the operation filter

- **Read only.** Steward sends no changing request (any method but GET and HEAD) with a read-only identity – from a process step (a step's _mutating: false_ does not count), the request explorer, a connection test or MCP – and refuses it **before anything is sent** with `IDENTITY_READ_ONLY`, on every redirect hop. A dry run or test run refuses the same write instead of skipping it, so it shows the problem before the real run. _Document access changes_ steps and browser steps with page interactions (click, fill …) are refused as well; monitor outputs need an identity that is not read-only (checked when the monitor is saved). Steward's own reads that use POST (Prometheus queries, AWS query APIs, Snowflake statements, LLM calls) pass. A POST that only reads is allowed when the operation filter chooses that operation. Database platforms are read-only anyway.
- **Operation filter** (platforms with at least one API specification): _All_ (no filter), _Read_ (every GET and HEAD of the current specs plus chosen extras) or _Chosen_ (operations picked one by one, searchable by tag). A request through the identity must match an allowed operation: its URL must lie below the base URL, the rest is compared segment by segment (decoded; an encoded `/`, `;` path parameters and dot segments are refused), `{param}` matches one segment, and the **most specific** operation decides – with `GET /users/{id}` allowed, `GET /users/me` is still refused when the spec has it as an operation of its own. A request that matches no operation – an undocumented endpoint, another host, an AWS service endpoint, a browser step – is refused with `IDENTITY_OPERATION_REFUSED` (method, path and the closest operation in the message, audited as `platform.identity_refused`). Connection tests outside the filter say so.
- **When specs change**: _Read_ follows (new GET operations are in, new POSTs are not). Chosen operations survive a replaced spec and a new path prefix; references that no longer resolve are **stale** – they match nothing, the _Identities_ tab counts them, and the spec's audit entry lists the identities affected. _Copy specs_ can also copy the operation filters (_Also copy the operation filters_): the identity of the same name on the target gets the filter (never wider than it was), or is created without credentials, closed and with MCP off.
- **Limits.** The filter sees method and path, not the body: a chosen `POST /graphql` also lets mutations through. Steward's checks are an additional layer – **the credentials stay the real boundary**: give each identity only the rights it needs in the target system.
- Connector types carry identity templates (names, descriptions, read-only flag and filters – never credentials, access lists or MCP modes); a platform made from one gets these identities closed and without credentials.

### Privileged identities

Since 0.14.0 ([ADR 0009](adr/0009-platform-identities.md) step 4, without the PAM checkout – that is decided in its own record, [ADR 0022](adr/0022-privileged-access-checkout.md) (proposed)). A platform's managers mark an identity **Privileged** (the identity dialog's _General_ tab; `privileged` in `POST`/`PUT /api/platforms/:id/identities…`). It is shown with a _Privileged_ badge wherever identities are named – the _Identities_ tab, the run dialog's identity choice, the run detail and its start approval, MCP requests, the credentials register.

- **Never the default identity** (`IDENTITY_DEFAULT_PRIVILEGED`): everyone with _use_ on the platform and Steward's own background readers use the default. A privileged identity cannot be made the default either – turn the flag off first. Keep the privileged credentials in their own, closed identity.
- **Turning it off is a loosening** and asks for a step-up (like _Read only_ off); turning it on is a tightening and asks nothing.
- **A step-up on every use** – control point `platform.privilegedIdentity` ([ASSURANCE.md](ASSURANCE.md#control-points), action `usePrivilegedIdentity`, on by default): starting a run with one (also _Run now_ of a schedule), saving a schedule or a webhook trigger that names one, a request explorer call with one, approving an MCP request with one, and approving the start of a privileged run. The routes ask only when the request names a privileged identity (or a slot's default is one); the handler checks again, so an identity marked privileged between the two is refused (`IDENTITY_PRIVILEGED_CONFIRM`), never used unconfirmed. **API tokens cannot confirm**: `/api/v1`, scripts and CI cannot start privileged runs or save such schedules (`SESSION_REQUIRED`). Scheduled and triggered fires run as their owner without asking – the owner confirmed when saving.
- **A second person before the run** (four-eyes): the same control point's four-eyes is `off` by default – then only a process with the setting **_Privileged runs need a second person_** (process editor → _Settings_ → _Connections_; `privilegedFourEyes: true` in the definition) asks for one; the assurance policy can make it `required` for every privileged run. Such a run starts in **waiting** with a **start approval** before its first step: nothing is sent with the privileged credentials until a person with the **approve** right on the process approves it – never the person who started it, nor the owner of the schedule, trigger or monitor that started it (by identity: former names and linked single sign-on accounts count as the same person). The approver confirms with a step-up; a start approval is never decided in Microsoft Teams. The run page shows _Waiting for a second person to approve the start_, the privileged identities per connection, who asked and until when; the approvers are notified like for any decision. Rejected – the run is cancelled (with the reason); **without a decision within 24 hours** it is cancelled too (`run.start_approval_expired`, a job every five minutes). Scheduled and triggered runs wait the same way. Test runs (recorded answers) send nothing and never wait. A sub-process run waits only when its own process asks and no run above it had its start approved. Audit: `run.start_approval_requested`, `task.completed` (with the four-eyes proof of `platform.privilegedIdentity`), `run.cancelled`.
- **When the flag counts**: like the read-only flag, it is read when the run resolves its connections – at the start (`runs.bindings` records `privileged` per slot for evidence). A run that started before the flag was set does not gain a start approval mid-way, also not when it is resumed after a restart; the next run reads it again. A waiting start approval stays when the flag is turned off meanwhile.
- **MCP**: only _off_ or _approved writes_ with a second person (four-eyes); marking an identity privileged changes _read_ to _off_ and _confirm_ to _fourEyes_ (audited). MCP clients never read with it – see [MCP.md](MCP.md#privileged-identities).
- **Monitors never use a privileged identity** – checks, outputs and the process runs of outputs (`IDENTITY_PRIVILEGED_BACKGROUND` when saved; a fire whose identity became privileged meanwhile is refused).
- **Credentials register**: an entry can document the identity ([CREDENTIALS.md](CREDENTIALS.md#platform-identities)); the _Identities_ tab shows each identity's entries with their status and next due date and **warns about a privileged identity without an entry** (a warning, not a block). Saving new credentials for an identity with entries offers **_This is a rotation_** (on by default): it records the rotation on those entries.
- **Evidence**: run detail, run protocol (HTML), the PDF run report (column _Identity_, marked _(privileged)_), `run.started` and the request explorer's `api.adhoc_*` entries name the identity and mark it privileged; the start approval appears with its decision among the run's decisions.
- Connector types carry the flag of their (non-default) identity templates; _Copy specs_ creates a privileged identity where the source's was.

**Confirming settings changed outside Steward**: the confirmation dialog lists every identity with its MCP mode, the names of its credentials, its variables, own sign-in, flags, operation filter and access list. Confirming keeps the default identity and every identity whose own seal still verified as shown, and seals them. An identity that was **added or changed outside Steward** (unsealed, or its seal fails) is kept and shown, but **disabled**: nothing can use it and no credentials are sent with it (`IDENTITY_DISABLED`); it carries a _Disabled_ badge on the _Identities_ tab. An administrator enables it one by one (_Enable_ in the identity's dialog, `POST /api/platforms/:id/identities/:iid/enable`, with a step-up and after reading its access list; audited as `platform.identity_enabled` with its access list, credential names and sign-in type). Enabling it in the database breaks its seal. Only a credential source (reserved for a later PAM checkout) is reset. The `platform.config_confirmed` audit entry records what was reviewed and which identities were disabled (never credential values).

**One platform's credentials, one connection**: in a process, a platform's credentials are only used in requests sent through its own connection – `$secret('<slot>', …)` in a step on another slot fails before anything is sent ([SECURITY-HARDENING.md](SECURITY-HARDENING.md#which-rule-checks-which-call)).

## Adding a platform

_Platforms → Add platform_ opens a wizard: **1** choose a connector (search, grouped by area), **2** its address and only the credentials it needs – on a connector that takes several sign-ins (Prometheus, the generic REST API) the auth type follows the fields you fill in –, **3** a **live connection test** with the plain-language diagnosis and the usual fixes inline (credentials, base URL, a sign-in page instead of the API, DNS, outbound policy, certificates), _Change the settings_ and _Test again_ until it works, **4** what's next: the matching template bundles and templates, the monitor check types and examples, access checks and the MCP gateway, one click each. _Skip the wizard_ opens the quick form.

## Platform health

The platform page shows the **last connection test** – passed or failed, when, by whom (or the periodic test), its message. **Test periodically** (off by default; every 15 minutes to once a day, platform managers) runs the same test from the server; when it starts failing, the platform's managers (else administrators) get **Platform connection failing**, routed like every other notification ([NOTIFICATIONS.md](NOTIFICATIONS.md)) – once per failing period. Every test is in the audit log (`platform.tested`, `details.periodic` for the periodic one), the setting too (`platform.health_changed`). API: `GET/PUT /api/platforms/:id/health`.

The tab **Get started** lists the same "what's next" as the wizard's last step (`GET /api/platforms/:id/get-started`).

## Custom login request with a refresh token

A custom login (`token_request`) posts its request (`auth.request`), takes the token from the answer (`tokenPath`, default `access_token`) and keeps it until shortly before its lifetime (`expiresInPath`) ends. With **`auth.refresh`** an expired token is first renewed with the refresh token of the last answer; only when that fails does Steward sign in again:

```json
"refresh": {
  "tokenPath": "refresh_token",
  "request": { "method": "POST", "url": "/oauth2/token", "bodyType": "form",
               "body": { "grant_type": "refresh_token", "refresh_token": "{{ refreshToken }}" } }
}
```

The refresh token is kept with the cached token in memory, never stored, and masked like it. A `401` from the platform drops both and signs in again. The preset _IBM Verify Privilege Vault_ uses it ([IBM-PAM.md](IBM-PAM.md#sign-in)).

## Key-pair JWT

Steward signs a JWT with the platform's private key for every new token: algorithm RS256, RS384, RS512, PS256 (RSA keys) or ES256, ES384 (EC keys), valid for at most an hour (`lifetimeSeconds`, default 3600). The **claims** are templates with `{{ vars.x }}`, `{{ secrets.x }}` and `{{ publicKeyFingerprint }}` (`SHA256:` and the base64 SHA-256 of the DER public key – what Snowflake expects); `iat`, `exp` and a random `jti` are set by Steward.

- **Send the JWT as the token** (`mode: token`): the header is `Authorization: Bearer <jwt>` unless _Header name_ and _Header value_ say otherwise. The JWT is reused until shortly before it ends.
- **Exchange it for an access token** (`mode: exchange`, RFC 7523): Steward posts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` (plus scope and extra parameters) to the _token URL_ and uses the `access_token` it gets.

Snowflake (SQL API, key-pair authentication):

```yaml
auth:
  type: jwt
  jwt:
    alg: RS256
    claims:
      iss: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) & '.' & publicKeyFingerprint }}"
      sub: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) }}"
variables: { account: xy12345, user: STEWARD_READER }
http:
  defaultHeaders: { X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT }
```

Create the key pair with `openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out steward_key.p8` and `openssl rsa -in steward_key.p8 -pubout`, and give the user the public key (`ALTER USER … SET RSA_PUBLIC_KEY = '…'`). The private key goes into the credential `privateKey`; it never leaves Steward.

## Client assertion (certificate)

OAuth2 client credentials can sign in with a **client assertion** instead of the client secret (RFC 7523 `private_key_jwt`, what Entra ID calls certificate credentials): _Send client credentials as → Client assertion signed with a certificate_ (`clientAuth: assertion`), or simply no `clientSecret` but a `privateKey`. For every token Steward signs a JWT valid for ten minutes – RS256 for an RSA key, PS256 for RSA-PSS, ES256 for EC –, with the client id as `iss` and `sub`, the token URL as `aud`, `nbf`, `iat`, `exp` and a random `jti`, and names the certificate in its header by `x5t#S256` and `x5t` (SHA-256 and SHA-1 thumbprints of the credential `certificate`, the public certificate in PEM; or `x5t` from the variable `certificateThumbprint`, a SHA-1 thumbprint in hex). It posts `client_id`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and `client_assertion` to the token URL; the private key never leaves Steward. The _scope_ may use `{{ baseUrl }}` and `{{ vars.x }}` like the token URL – Microsoft Graph asks for `{{ baseUrl }}/.default`. See [ENTRA.md](ENTRA.md#certificate-or-client-secret).

## Client certificate (mutual TLS)

A platform presents a **client certificate** when its credentials hold `tlsCertificate` and `tlsKey` (PEM; an encrypted key with `tlsKeyPassphrase`) – for example for a Kafka Connect REST API behind mutual TLS ([KAFKA.md](KAFKA.md#kafka-connect-and-debezium)). It works with every authentication type, also _none_. Like every other credential it is only presented to the platform's own origins (its base URL and trusted origins), never on a request or redirect to another host; the private key stays in the vault. A private CA of the server goes under the platform's HTTP settings (`caPem`).

## AWS request signing (SigV4)

Every request to the platform is signed right before it is sent – over the exact body that goes over the wire – with AWS Signature Version 4: _region_ (e.g. `eu-central-1`) and _service_ (the signing name: `s3`, `execute-api`, `ce`, `tagging`, `iam` …). Steward's implementation is checked against the examples in AWS's documentation; no AWS SDK is involved.

- **Access key**: credentials `accessKeyId` and `secretAccessKey`, and `sessionToken` for temporary keys.
- **Assume a role** (recommended): with a _role ARN_ (and an _external ID_ if the role's trust policy asks for one), the platform's key only calls `sts:AssumeRole`; requests are signed with the role's temporary credentials, renewed five minutes before they end (one hour) or on _Get a new token_. The STS endpoint is `https://sts.<region>.amazonaws.com/` unless set (GovCloud, China, VPC endpoints).
- **S3**: requests carry `x-amz-content-sha256`; `unsignedPayload` signs large uploads without hashing the body. S3-compatible storage (MinIO, Ceph, Wasabi, Hetzner, Cloudflare R2) works with its own region name.

Give the key (or the role) only the read rights it needs – the AWS and backup docs list them per feature.
