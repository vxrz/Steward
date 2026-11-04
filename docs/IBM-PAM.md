# IBM Security Verify Privilege Vault

Steward uses **IBM Security Verify Privilege Vault 12.0** (the IBM edition of Delinea Secret Server; on premises or in the cloud) as a source of evidence: who may use which privileged account, whether rotation works, and who used a secret (v0.5.0, #205).

**Steward never reads a secret value.** It reads metadata only – names, folders, templates, permissions, heartbeat and rotation state, audit records – and it refuses the value endpoints for this kind of platform, whoever asks ([below](#what-steward-never-calls)).

| What                                                      | Where in Steward                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Who has access to which secret and folder, and which role | Access check source _IBM Verify Privilege Vault permissions and roles_; person reviews |
| Failed heartbeats, rotation, expiry, owners, checkout     | Template _Secret hygiene_, dashboard _Vault hygiene_, monitor check _Vault hygiene_    |
| A credentials register entry's vault secret               | _Vault secret_ on the entry: last change, expiry; overdue rotation flagged             |
| Views, checkouts, access requests of privileged secrets   | Template _Privileged use_, the section `privileged-use/` of evidence packs             |
| All of it at once                                         | Template bundle _Privileged access governance_                                         |

## Setting up the platform

_Platforms → Add platform → IBM Verify Privilege Vault (privileged access, read-only)_.

- **Base URL**: the application root, without `/api/v1` – `https://pam.example.local/SecretServer` on premises (the IIS application, often `/SecretServer`), `https://TENANT.secretservercloud.com` in the cloud. Steward appends `/oauth2/token` and `/api/v1/…`.
- **Credentials**: the service account's user name and password (below).
- **Variables**: `domain` – only for a directory (Active Directory) account, the domain as the vault knows it; leave it empty for a local or application account. `privilegedFolders` and `privilegedTemplates` (comma-separated, e.g. `\Privileged, \IT\Domain Admins` and `Windows Account`) name what evidence packs read the privileged use of.
- **Certificates**: for a private CA, paste it under _Settings → HTTP → CA certificate (PEM)_; do not turn off certificate checks.
- The **outbound policy** must allow the vault's host.

### Sign-in

The preset signs in with the OAuth2 password grant the vault offers for scripts (_Script authentication using tokens_):

```
POST <base>/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=<user>&password=<password>[&domain=<domain>]
```

The answer has `access_token`, `token_type`, `expires_in` and `refresh_token`. Steward sends the token as `Authorization: Bearer …` and renews it shortly before it expires with `grant_type=refresh_token&refresh_token=…`; when the vault refuses the refresh token (a restart, the token's use limit), Steward signs in again. A `401` drops the token and signs in again. Tokens and refresh tokens stay in memory and are masked everywhere ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#custom-login-request-with-a-refresh-token)).

**Test connection** signs in and tries every read Steward makes (one item each): secrets, folders, secret and folder permissions, a secret's audit, users, groups, roles, role assignments, templates, access requests. It passes when the sign-in works and lists each read that does not, with the permission that is missing, e.g. _the service account may not list roles and role assignments – the role permission "View Roles"_.

SDK client accounts (`tss` / client onboarding) are not used: they are made for Delinea's SDK and its local cache. Two-factor authentication must not apply to the service account (application accounts are exempt; check your installation's policy).

## The service account

Create a dedicated account that may **list** secrets and read permissions and audits, but may **not view** any secret.

1. **Account**: _Administration → Users → Create User_, a local user (or an application account, _Application Account_ checked – it can only use the API). Strong password, no e-mail login, no interactive use. Name it e.g. `steward-reader`.
2. **Role** _Steward Reader_ (_Administration → Roles → Create Role_) with only these role permissions, and assign it to the account:

   | Role permission                         | Steward needs it for                              |
   | --------------------------------------- | ------------------------------------------------- |
   | View Users                              | users with domain, e-mail address and last login  |
   | View Groups                             | groups and their members                          |
   | View Roles                              | roles and role assignments                        |
   | View Secret Audit                       | a secret's audit (privileged use, evidence packs) |
   | View Secret Templates                   | template names (hygiene, privileged templates)    |
   | View Secret Access Requests _(if used)_ | access requests and their answers                 |

   The names are those of Secret Server 11.x; check them in _Administration → Roles → Permissions_ of your installation (see [Verify against your installation](#verify-against-your-installation)). Do **not** give _Unlimited Administrator_, _Administer Secrets_, _View Secret_ as a role permission, _Edit Secret_ or anything with _Owner_.

3. **Folder permissions**: on each folder to review (or its parent, inherited), add the account with **Folder: View** and **Secrets: List**. _List_ lets it find a secret and its metadata; _View_ would let it open the secret and read its fields – never give _View_, _Edit_ or _Owner_ on secrets.
4. Secrets with their own (not inherited) permissions need the account listed there too (_Secrets: List_), or they stay invisible to Steward.

### How to check that the account cannot view values

Steward refuses these calls itself, so check with the vault's own tools, signed in as the service account (PowerShell or curl, from an admin workstation):

```bash
TOKEN=$(curl -s https://pam.example.local/SecretServer/oauth2/token \
  -d grant_type=password -d username=steward-reader --data-urlencode password='…' | jq -r .access_token)
H="Authorization: Bearer $TOKEN"
# a secret the account can list (its id from the search)
curl -s -H "$H" "https://pam.example.local/SecretServer/api/v1/secrets?take=1" | jq '.records[0] | {id, name}'
# opening it, or one field, must be refused (HTTP 403 "Access Denied")
curl -s -o /dev/null -w '%{http_code}\n' -H "$H" https://pam.example.local/SecretServer/api/v1/secrets/12
curl -s -o /dev/null -w '%{http_code}\n' -H "$H" https://pam.example.local/SecretServer/api/v1/secrets/12/fields/password
```

Both last calls must answer **403**. If either answers 200, the account has _View_ on that secret (directly, through a group or inherited) or a role permission that implies it – remove it.

## Access reviews

_Compliance → Access reconciliation → New check_, platform: the vault, source _IBM Verify Privilege Vault permissions and roles_, folder: empty (every secret the account may list) or a folder path such as `\Privileged` (it and below). One subject per user, named `domain\user` (local users without domain), with the e-mail address and the plain user name as aliases – so a person review finds the same colleague in the vault and in other sources ([COMPLIANCE.md](COMPLIANCE.md#person-access-reviews)). Rights:

| Right                                                     | Means                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `Secret \IT\Servers\root@db1 (#12): Owner`                | a permission on the secret (List, View, Edit, Owner)              |
| `Secret … (#12): View via group DB Admins`                | the same through a group the user is a member of                  |
| `Secret … (#12): Owner from folder \IT`                   | the secret inherits: the folder's permission for its secrets      |
| `Folder \IT: Edit (secrets: Owner)`                       | a folder permission: the folder role and the role for its secrets |
| `Role Administrator`, `Role User via group Domain Admins` | a role of the user, directly or through a group                   |

A group whose members the account may not read stays a subject of its own (`group:<name>`, type group). Application accounts are typed _technical_. The person review shows the last login and _disabled in the vault_. Every new or removed right needs a documented access change, as for every source; four-eyes approval of person reviews works the same.

## Hygiene

The template **IBM Verify Privilege Vault – Secret hygiene** (daily; dataset `pv.hygiene`, dashboard _Vault hygiene_) and the monitor check **Vault hygiene** find, per secret:

| Finding       | When                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| heartbeat     | the last heartbeat failed (Failed, UnableToConnect, AccountLockedOut, AccessDenied, …)                  |
| not rotated   | the password was not changed within N days (default 90), never, or the last change failed (out of sync) |
| expired       | the password is past its expiry                                                                         |
| automatic off | automatic password changing (remote password changing) is turned off                                    |
| no owner      | nobody holds _Owner_ on the secret – its own permissions or, inherited, its folder's                    |
| no checkout   | a privileged secret without checkout                                                                    |
| no approval   | a privileged secret that needs no approval for access                                                   |

**Privileged** secrets are those in the folders you name (and below) or of the templates you name – template inputs _Privileged folders_ / _Privileged templates_, monitor fields _Privileged folders_ / _Privileged templates_. A finding on a privileged secret always fails the monitor check; others count against _Findings allowed_. The monitor reads the vault at most every 10 minutes per check (the owner check is one call per secret). Example monitor: `examples/monitors/59-vault-hygiene.yaml`.

## Credentials register link

An entry of the [credentials register](CREDENTIALS.md) can name its secret: _Edit → Vault secret_, choose the vault platform and search the secret by name. Every six hours (job `vault-links`) or with _Read now_ Steward reads the secret's summary – name, template, folder, last password change, expiry, automatic changing, heartbeat – with the rights of whoever last changed the entry. The vault's last change counts as the entry's last rotation (when it is newer), so the rotation interval of the entry is checked against it and an overdue rotation is flagged and reminded; the vault's expiry counts when the entry has none. A change found in the vault is a _Rotated_ event in the entry's history (`credential.vault_rotated` in the audit log). A failed change (out of sync) is no rotation.

## Privileged-use evidence

The template **IBM Verify Privilege Vault – Privileged use** (weekly, 8 days; dataset `pv.privileged-use`) lists the views, checkouts and check-ins, password displays, launches and edits of the privileged secrets from each secret's audit (the newest 500 records per secret and run), and the access requests with their answer. Its run protocol is evidence of the period.

An **evidence pack** of the vault platform – or one that holds a vault access check – reads the audit of its own period when it is built, with the creator's right to use the platform, and adds `privileged-use/<platform>/events.json` and `events.csv` (privileged: the platform variables `privilegedFolders` / `privilegedTemplates`; neither set – every secret the account may list, at most 1000) ([COMPLIANCE.md](COMPLIANCE.md#evidence-packs)). Heartbeats and the vault's own password changes are left out.

## What Steward never calls

For platforms of this kind, every request – process steps, the MCP gateway, monitor checks, Steward's own readers, every redirect hop – is checked against a deny list before it is sent (`server/src/platforms/deniedPaths.ts`); a refused request fails with _Steward never reads secret values: … is refused for IBM Verify Privilege Vault platforms_:

- `/secrets/{id}` itself – its answer holds the field values (`items[].itemValue`) – and every sub-resource of a secret except `summary`, `audits` and `state`: `fields/{slug}` (values and file downloads), `restricted/…`, `settings`, … (an allow list: a sub-resource of a later version is refused until reviewed)
- `/secrets/export` and every `export` outside `reports`
- `one-time-password-code`, `secret-extensions`, `launchers`, the `internals` API and the SOAP web services (`*.asmx`)
- the search parameters `filter.extendedFields` (field values in results) and `filter.searchField` / `filter.searchFieldSlug` (testing guesses of a value)

Paths are compared decoded, without case, `;…` parameters or empty segments. Independently, the keys `itemValue`, `extendedFields`, `password`, `privateKey`, `passphrase` and `fileContent` are removed from every answer of the platform before it is used, stored or logged. The built-in API description lists only the metadata endpoints.

## Endpoints and sources

IBM's documentation of 12.0 (ibm.docs.delinea.com) could not be reached from where this integration was written, and the REST API reference of an installation is only on the installation itself (_Help → REST API Guide_, or `<base>/RestApiDocs.ashx`). The endpoints and fields below come from public code that calls Secret Server's REST API v1 – Delinea's own SDKs and the community PowerShell module (written for Secret Server 10.9–11.x) – and are **to be confirmed on 12.0** ([checklist](#verify-against-your-installation)).

| Endpoint                                                                                                                                            | Used for                                              | Source                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /oauth2/token` (password, `domain`)                                                                                                           | sign-in                                               | [python-tss-sdk `server.py`][py], [PowerShell `New-TssSession.ps1`][ps-auth], IBM [Script authentication using tokens][ibm-token] |
| `POST /oauth2/token` (`refresh_token`)                                                                                                              | renewing the token                                    | [PowerShell `Session.cs`][ps-session]                                                                                             |
| `GET /api/v1/healthcheck`                                                                                                                           | –                                                     | [python-tss-sdk `server.py`][py]                                                                                                  |
| `GET /api/v1/users/current`                                                                                                                         | connection test                                       | [PowerShell `Show-TssCurrentUser.ps1`][ps-fn]                                                                                     |
| `GET /api/v1/secrets` (search: `filter.folderId`, `filter.includeSubFolders`, `filter.includeRestricted`, `filter.includeInactive`, `skip`, `take`) | secret summaries                                      | [PowerShell `Search-TssSecret.ps1`][ps-fn], [`Summary.cs`][ps-summary], [python-tss-sdk][py]                                      |
| `GET /api/v1/secrets/{id}/summary`                                                                                                                  | credentials register link                             | [PowerShell `Get-TssSecretSummary.ps1`][ps-fn]                                                                                    |
| `GET /api/v1/secrets/{id}/audits`                                                                                                                   | privileged use                                        | [PowerShell `Get-TssSecretAudit.ps1`][ps-fn], [`Audit.cs`][ps-classes]                                                            |
| `GET /api/v1/folders`                                                                                                                               | folder paths, inheritance                             | [PowerShell `Search-TssFolder.ps1`][ps-fn]                                                                                        |
| `GET /api/v1/secret-permissions?filter.secretId=`                                                                                                   | permissions of a secret                               | [PowerShell `Search-TssSecretPermission.ps1`][ps-fn], [`secret-permissions/Permission.cs`][ps-classes]                            |
| `GET /api/v1/folder-permissions?filter.folderId=`                                                                                                   | permissions of a folder                               | [PowerShell `Search-TssFolderPermission.ps1`][ps-fn], [`folder-permissions/Permission.cs`][ps-classes]                            |
| `GET /api/v1/users` (`filter.includeInactive`)                                                                                                      | users, e-mail, last login                             | [PowerShell `Search-TssUser.ps1`][ps-fn], [`users/Summary.cs`][ps-classes]                                                        |
| `GET /api/v1/groups`, `GET /api/v1/groups/{id}/users`                                                                                               | groups and members                                    | [PowerShell `Search-TssGroup.ps1`, `Get-TssGroupMember.ps1`][ps-fn]                                                               |
| `GET /api/v1/roles`, `GET /api/v1/users/{id}/roles-assigned`                                                                                        | roles, directly or through groups                     | [PowerShell `Search-TssRole.ps1`, `Get-TssUserRoleAssigned.ps1`][ps-fn], [`UserRoleSummary.cs`][ps-classes]                       |
| `GET /api/v1/secret-templates`                                                                                                                      | connection test                                       | [PowerShell `Search-TssSecretTemplate.ps1`][ps-fn]                                                                                |
| `GET /api/v1/secret-access-requests?filter.status=`                                                                                                 | access requests (Approved, Denied, Canceled, Pending) | [PowerShell `Search-TssSecretAccessRequest.ps1`][ps-fn], [`SecretAccessStatus.cs`][ps-enums]                                      |
| `GET /api/v1/secrets/{id}` – **not used, refused**                                                                                                  | returns `items[].itemValue`                           | [python-tss-sdk `get_secret`][py], [tss-sdk-go `secret.go`][go]                                                                   |
| `GET /api/v1/secrets/{id}/fields/{slug}` – **not used, refused**                                                                                    | a field's value or file                               | [python-tss-sdk][py], [PowerShell `Get-TssSecretField.ps1`][ps-fn]                                                                |

Lists are paged with `skip` and `take`; a page carries `records`, `total`, `hasNext` and `nextSkip` (Secret Server's `PagingOf…` models). Steward follows `hasNext` (it does not assume a short page is the last). Heartbeat states are those of `SecretHeartbeatStatus` ([`HeartbeatStatus.cs`][ps-enums]), as text or number.

[py]: https://github.com/DelineaXPM/python-tss-sdk/blob/main/delinea/secrets/server.py
[go]: https://github.com/DelineaXPM/tss-sdk-go/blob/main/server/secret.go
[ps-fn]: https://github.com/thycotic-ps/thycotic.secretserver/tree/main/src/functions
[ps-auth]: https://github.com/thycotic-ps/thycotic.secretserver/blob/main/src/functions/authentication/New-TssSession.ps1
[ps-session]: https://github.com/thycotic-ps/thycotic.secretserver/blob/main/src/Thycotic.SecretServer/classes/authentication/Session.cs
[ps-summary]: https://github.com/thycotic-ps/thycotic.secretserver/blob/main/src/Thycotic.SecretServer/classes/secrets/Summary.cs
[ps-classes]: https://github.com/thycotic-ps/thycotic.secretserver/tree/main/src/Thycotic.SecretServer/classes
[ps-enums]: https://github.com/thycotic-ps/thycotic.secretserver/tree/main/src/Thycotic.SecretServer/enums
[ibm-token]: https://ibm.docs.delinea.com/online-help/isvp-vault/api-scripting/authentication/script-token-auth/index.htm

Further IBM pages: [APIs and scripting](https://ibm.docs.delinea.com/online-help/isvp-vault/api-scripting/index.htm), [developer resources (11.6)](https://ibm.docs.delinea.com/online-help/isvp-vault-11-6-x/developer-resources/index.htm).

## Limits

- Metadata only. Secrets the account may not list are invisible – they appear neither in reviews nor in hygiene.
- One call per secret for permissions and per user for role assignments: a vault with thousands of secrets takes a while; narrow access checks and the hygiene template to folders. At most 10,000 secrets, 5,000 users, groups or folders per read; 1,000 secrets per privileged-use read.
- `GET /secret-permissions` is assumed to list a secret's own permissions; for a secret that inherits and lists none, Steward takes its folder's permissions for secrets (walking up to the first folder that does not inherit).
- The access requests list shows what the account may see – on Secret Server, the requests it made or may approve. Without an approver role the evidence rests on the secret audit.
- The privileged-use template reads the newest 500 audit records per secret and run; evidence packs page until the period's start (at most 2,000 per secret, 20,000 in all).
- Times without a zone are read as UTC.
- No writes: Steward never changes a secret, a permission or a setting in the vault. Fetching Steward's own platform credentials from the vault is a later, separate decision (#205).

## Verify against your installation

Run these with the service account (token as in [How to check that the account cannot view values](#how-to-check-that-the-account-cannot-view-values), `B=https://pam.example.local/SecretServer/api/v1`) and compare:

1. `curl -s -H "$H" $B/users/current` → its `id` and `userName`. **Expected**: the service account.
2. `curl -s -H "$H" "$B/secrets?take=2&filter.includeRestricted=true" | jq '{total, hasNext, nextSkip, r: .records[0]}'` → **Expected**: `records[0]` has `folderPath`, `secretTemplateName`, `lastHeartBeatStatus` (note the spelling), `lastPasswordChangeAttempt`, `daysUntilExpiration`, `autoChangeEnabled`, `checkOutEnabled`, `requiresApproval`, `inheritsPermissions` – and **no** `items` and no field value. Paging: `hasNext` and `nextSkip`.
3. `curl -s -H "$H" "$B/secret-permissions?filter.secretId=<id>"` for a secret that **inherits** its permissions → does it list the folder's permissions or nothing? (Steward handles both; tell us which.) Fields: `userId`, `userName`, `groupId`, `groupName`, `domainName`, `secretAccessRoleName`. Is a group permission's `userId` `-1` or missing?
4. `curl -s -H "$H" "$B/folder-permissions?filter.folderId=<id>"` → `folderAccessRoleName` and `secretAccessRoleName`.
5. `curl -s -H "$H" "$B/folders?take=5"` → `folderPath` (`\IT\Servers`), `parentFolderId`, `inheritPermissions`.
6. `curl -s -H "$H" "$B/users/<id>/roles-assigned"` → `roleName`, `isDirectAssignment`, `groups[].groupName`. And `$B/groups/<id>/users` → `userId`, `enabled`.
7. `curl -s -H "$H" "$B/secrets/<id>/audits?take=5&sortBy[0].name=dateRecorded&sortBy[0].direction=desc"` → `action` values for views, checkouts, password displays (Steward expects `VIEW`, `CHECKOUT`, `CHECKIN`, `PASSWORDDISPLAYED`, …), `byUserDisplayName`, `dateRecorded` (with or without a zone?), `ticketNumber`.
8. `curl -s -H "$H" "$B/secret-access-requests?filter.status=Approved"` → readable for the account? Which requests does it see?
9. The two value calls of [the check above](#how-to-check-that-the-account-cannot-view-values) → **403**.
10. In Steward: _Test connection_ – every read works; then a dry run of _Secret hygiene_ and one access check snapshot, and compare a few secrets and users with the vault's UI.
11. The role permission names of [the service account](#the-service-account) in _Administration → Roles_, and whether reading secret permissions and a secret's audit needs more than _List_ on the secret.
12. The refresh: with a short token lifetime (_Administration → Configuration → Security → Session timeout for webservices_), Steward should renew with the refresh token (vault log: refresh grant) rather than sign in each time.

## Demo and tests

`npm run demo` has the platform _IBM Verify Privilege Vault (demo)_: a simulated vault (`server/src/mock/mockPrivilegeVault.ts`, at `/mock/pvault/SecretServer`) built from the answers above – six secrets in `\IT`, `\Privileged` and `\Shared` with every hygiene finding, groups, roles, audits and access requests, paging, expiring tokens, a limited account (`limited-reader`, 403 on roles and audits) and the value endpoints answered like the real vault and counted. `server/test/privilege-vault.test.ts` checks that Steward never calls them.
