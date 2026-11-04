# Microsoft Graph and Entra ID

Steward reads an **Entra ID tenant** (formerly Azure AD) through Microsoft Graph – **read-only**: it never creates, changes or deletes anything there. One platform of the connector _Microsoft Graph (Entra ID, read-only)_ is one tenant. It is used by

- the **access check source _Entra ID_** ([COMPLIANCE.md](COMPLIANCE.md#access-reconciliation)): who belongs to which group (also through nested groups), owns which group, holds which directory role (active and – with Entra ID P2 – eligible through Privileged Identity Management) and which app role of an enterprise application; guests and disabled accounts. Users are named by their user principal name with their e-mail addresses as other names, so **person reviews** find a person in Entra ID and on the other platforms at once;
- five **templates** ([examples/README.md](../examples/README.md)): guest user review, privileged directory role review (four-eyes), stale accounts, group owner and membership review, expiring app secrets and certificates – together the bundle **Entra ID access governance** with the dashboard _Entra ID governance_;
- the **monitor check _Entra ID_** ([MONITORS.md](MONITORS.md)): app secrets and certificates that expire, or the Microsoft 365 service health;
- the **credentials register**: _Credentials → Import from Entra ID_ turns the app registrations' secrets and certificates into entries with their end date ([CREDENTIALS.md](CREDENTIALS.md#app-credentials-from-entra-id));
- process steps and the **MCP gateway**, with the built-in API description of the Graph read endpoints.

Signing in to Steward with Entra ID (single sign-on) is something else: see [SSO.md](SSO.md).

## 1. Register an app in Entra ID

1. [Entra admin center](https://entra.microsoft.com) → **Identity → Applications → App registrations → New registration**.
2. Name: e.g. `Steward (read-only)`. Supported account types: **Accounts in this organizational directory only**. No redirect URI. **Register**.
3. On the _Overview_ page note the **Application (client) ID** and the **Directory (tenant) ID**.
4. **API permissions → Add a permission → Microsoft Graph → Application permissions** (not _Delegated_) and add the permissions of the table below.
5. **Grant admin consent for _your tenant_** (a Global Administrator or Privileged Role Administrator). Every permission's status must read _Granted for …_ – without the consent the token carries no permission at all, and the connection test says so.
6. **Certificates & secrets**: a certificate (recommended) or a client secret, see [below](#certificate-or-client-secret).

### Permissions

All of them are **application permissions** of Microsoft Graph and read-only. Steward asks for nothing that writes.

| Permission                      | Needed for                                                                                                                               | Without it                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `User.Read.All`                 | users and guests: user principal name, e-mail addresses, enabled or disabled, invitation state (access source, every template)           | nothing works – the connection test fails                      |
| `Group.Read.All`                | groups, their members (direct, and through nested groups) and owners (access source, guest and group review, stale accounts)             | the access source and the group review fail                    |
| `Directory.Read.All`            | the tenant's name, directory objects named in role and app role assignments (groups, service principals), administrative units           | the connection test shows no tenant name; names may be missing |
| `AuditLog.Read.All`             | the last sign-in of each user (`signInActivity`) and the MFA registration (`userRegistrationDetails`) – both also need Entra ID P1 or P2 | the last sign-in and MFA show as _not available_               |
| `RoleManagement.Read.Directory` | directory role assignments, active and eligible (PIM, Entra ID P2), and the role definitions (access source, privileged role review)     | role assignments are not read                                  |
| `Application.Read.All`          | app registrations with their secrets and certificates (names and dates only), enterprise applications and their app role assignments     | app roles, expiring credentials and the import fail            |
| `ServiceHealth.Read.All`        | _optional_: Microsoft 365 service health for the monitor check                                                                           | the service health check is unknown                            |

`Directory.Read.All` also covers reading users, groups and applications; the narrower permissions are listed so a tenant that does not grant it still works. Steward only ever sends `GET` requests.

### Licences

| Part                            | Needs               | Without the licence                                                                  |
| ------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| Last sign-in (`signInActivity`) | Entra ID P1 (or P2) | _last sign-in not available (licence or permission)_; stale accounts cannot be found |
| MFA registration                | Entra ID P1 (or P2) | _MFA registration not available_; person reviews show no "no MFA method registered"  |
| Eligible role assignments (PIM) | Entra ID P2         | only active assignments are read; the snapshot's audit entry and the review say so   |
| Everything else                 | any licence (free)  |                                                                                      |

A part that is not available never fails an access check or a review: it is left out, and the snapshot's audit entry (`access_check.snapshot`, `details.notAvailable`), the connection test and the review text name it.

## 2. Add the platform in Steward

_Platforms → Add platform → Microsoft Graph (Entra ID, read-only)_:

- **Base URL**: `https://graph.microsoft.com` (see [national clouds](#national-clouds)).
- **Variables**: `tenantId` – the directory (tenant) ID (a verified domain such as `contoso.com` works too); `loginUrl` – `https://login.microsoftonline.com`.
- **Credentials**: `clientId` – the application (client) ID; then either `clientSecret`, or `certificate` and `privateKey` (and `privateKeyPassphrase` for an encrypted key).

The wizard tests the connection right away. The test signs in, reads which permissions the token carries (the `roles` claim) and probes every part Steward reads:

- _Admin consent_ – the token carries no permission: an administrator has to grant admin consent.
- _Application permissions_ – which of the table's permissions are granted and which are missing or lack consent.
- one line per part (users, groups, directory roles, app registrations, last sign-in, MFA registration, eligible roles, service health): _readable_, or what is missing in plain words – _lacks the application permission Group.Read.All, or an administrator has not granted admin consent for it_, or _not available – the tenant has no Microsoft Entra ID P1/P2 licence for it_.

Sign-in errors of Entra ID (`AADSTS…`) are explained: a wrong secret (`7000215`: use the secret's value, not its id), an expired secret (`7000222`), an unknown client id (`700016`), an unknown tenant (`90002`), a certificate not registered (`700027`), a blocked sign-in (Conditional Access, `53003`).

The token is cached until shortly before it ends (about an hour); after granting further permissions use _Get a new token_ on the platform page.

### Certificate or client secret

|                  | Certificate (recommended)                                                         | Client secret                                |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| What is stored   | the private key (in Steward's vault) – Entra ID knows only the public certificate | the secret – the same value Entra ID checks  |
| What is sent     | a short-lived signed client assertion (10 minutes), never the key                 | the secret, with every token request         |
| Lifetime         | as long as the certificate (Microsoft allows up to several years; rotate yearly)  | at most 24 months, Microsoft recommends less |
| Microsoft's view | recommended for applications in production                                        | acceptable for tests                         |

A certificate for the app (a self-signed one is fine – Entra ID only compares it):

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes -subj "/CN=steward-graph-reader" \
  -keyout steward-graph.key -out steward-graph.crt
```

Upload `steward-graph.crt` under _Certificates & secrets → Certificates_; put its content into the credential `certificate` and `steward-graph.key` (PKCS#8 PEM, `-----BEGIN PRIVATE KEY-----`) into `privateKey`. Steward then signs in with a **client assertion** (OAuth 2.0 client credentials with `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`): a JWT signed with RS256 (PS256 for an RSA-PSS key), naming the certificate by its `x5t#S256` and `x5t` thumbprints, with the client id as issuer and subject and the token endpoint as audience ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#client-assertion-certificate)). Instead of the certificate the variable `certificateThumbprint` may hold its SHA-1 thumbprint as the Entra admin center shows it.

Without a certificate: create a **client secret** under _Certificates & secrets_ and copy its **Value** (not the _Secret ID_) into `clientSecret`. Leave `clientSecret` empty when you use a certificate – a platform with a private key and no secret signs in with the certificate.

Both kinds expire. The template _Expiring app secrets and certificates_ and the monitor check _Entra ID_ watch the end dates of every app registration – Steward's own included.

### National clouds

| Cloud                       | Base URL                                  | Variable `loginUrl`                 |
| --------------------------- | ----------------------------------------- | ----------------------------------- |
| Global (default)            | `https://graph.microsoft.com`             | `https://login.microsoftonline.com` |
| US Government L4 (GCC High) | `https://graph.microsoft.us`              | `https://login.microsoftonline.us`  |
| US Government L5 (DoD)      | `https://dod-graph.microsoft.us`          | `https://login.microsoftonline.us`  |
| China (21Vianet)            | `https://microsoftgraph.chinacloudapi.cn` | `https://login.chinacloudapi.cn`    |

The scope Steward asks for is the base URL followed by `/.default`.

### Outbound access

Steward sends the token only to the base URL's origin; Graph's next-page links are followed only on that origin. Under the outbound policy _platforms_ (the default) the base URL is allowed because it is a platform; under _allowList_ add the Graph host (`graph.microsoft.com`) and the sign-in host (`login.microsoftonline.com`) to _Settings → Outbound access_. A proxy for these hosts goes into the platform's HTTP settings or `HTTPS_PROXY`.

## Paging and throttling

Graph returns long lists in pages (`@odata.nextLink`); Steward follows them – up to 500 pages of up to 999 items – in the access source, the monitor check, the import and, with `paginate: { mode: nextLink, nextPath: "`@odata.nextLink`", itemsPath: value }`, in process steps. When Graph throttles (HTTP 429 or 503 with `Retry-After`) Steward waits as long as it asks (at most a minute per wait) and tries again, at most four times, before it reports _Microsoft Graph is throttling_. At most four requests per platform run at the same time (_HTTP settings → Maximum concurrent requests_). A large tenant's access check reads every group's members and owners: plan its schedule outside business hours.

## Access reviews

Create an access check (_Compliance → Access reconciliation → New check_) on the Graph platform; the source _Entra ID_ is chosen with it. **What to read** (the scope):

| Scope                        | Subjects and rights                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Everything (empty)           | every user and guest, with all of the rights below; groups and service principals that hold a role or an app role themselves                                             |
| Group memberships and owners | `group:<name>`, `group:<name> (nested)` (member through a nested group), `owner:group:<name>`                                                                            |
| Directory roles              | `role:<role>`, `role:<role> @<scope>` (an administrative unit or an object), `role:<role> (eligible)` (PIM), `role:<role> (via group <group>)` (a role-assignable group) |
| App role assignments         | `app:<enterprise application>/<app role>` (the default access: `app:<enterprise application>`), `… (via group <group>)`                                                  |
| Guests only                  | every guest with all of their rights                                                                                                                                     |

Users are subjects by their **user principal name** (guests: `name_domain#EXT#@tenant.onmicrosoft.com`), with their e-mail addresses and object id as other names; a disabled account carries `account:disabled`. Groups are `group:<name>`, service principals `sp:<name>`. Last sign-in and MFA registration are a hint for reviewers (_last sign-in 2026-10-30 (5 days ago), no MFA method registered, invitation not accepted_) – read live, never part of a snapshot.

The reviews of the templates document their removals as access changes in the same rights (`group:Developers`, `role:Global Administrator (eligible)`, an offboarding of the guest's UPN), so the next snapshot finds them explained.

## What Steward stores

The snapshots of an access check (who has which right – names, UPNs, e-mail addresses), the datasets of the templates, and the register entries you import. It never stores or shows a secret of the tenant: Graph returns no secret values, and the hint of a client secret (its first characters) is left out. The platform's own client secret or private key stays encrypted in the vault and is masked in every answer, log and audit entry.

## Demo

`npm run demo` adds the platform _Microsoft Graph (demo)_ – a simulated tenant _Contoso (demo)_ (`server/src/mock/mockGraph.ts`): nine users with three guests (one never accepted the invitation), a stale and a disabled account, nested groups, a role-assignable group, PIM eligibility, a service principal with a role on an administrative unit, app registrations whose secrets and certificates expire, one throttled page and Microsoft 365 service health.
