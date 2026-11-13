# Users, roles and access

Everyone signs in, with a password or through single sign-on. What a person may do comes from their **roles**, their **teams**, and the **shares** of single items ([TEAMS.md](TEAMS.md#sharing-the-access-tab)). Every check runs on the server.

## Roles

| Role     | Default rights                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------- |
| admin    | Everything: users and teams, platforms and credentials, settings, all processes, unlocking the vault. |
| designer | Create processes. Edit and run all processes unless their owning teams or Restricted say otherwise.   |
| operator | Run and schedule processes.                                                                           |
| approver | Decide approvals and user tasks.                                                                      |
| auditor  | Read-only access to everything, including the audit log and all protocols.                            |
| viewer   | Read processes and their runs.                                                                        |
| status   | Only the service status pages ([STATUS-PAGES.md](STATUS-PAGES.md)) – nothing else.                    |

## Who may do what

- **Shares and Restricted** add rights on one item for a user, a team or a role, or keep it to its shares ([below](#processes-and-platforms)).
- **Settings** are personal (your profile), per team (_Users → Teams_) or for the whole instance (_Settings_, one area per topic). See [SETTINGS.md](SETTINGS.md).
- **Teams and owning teams.** Resources can belong to one or more teams: members have their roles in the team on them, everyone else does not see them (administrators and auditors see everything). A resource without an owning team behaves as before, so upgrades keep every instance's visibility. See [TEAMS.md](TEAMS.md).
- **Decisions.** A user task can name `assignees` (users, teams, roles). Otherwise everyone with `run` or `approve` on the process may decide. With `fourEyes: true`, the person who started the run may not decide.
- **Schedules.** A schedule runs with the rights of its owner (the person who created it). If the owner loses the rights or is deactivated, the run is skipped and recorded in the audit log.
- **Webhook triggers** follow the same rules as schedules: creating one needs run rights on the process, runs use the owner's rights (checked on every call), and the owner, an admin or a process manager can change it.
- **Owners and responsibles** (services, applications, systems, duties, credentials, tickets) are picked from the users and teams, so a typo cannot become an owner nobody is; the server refuses users and teams that do not exist (owners stored before stay). A person who has not signed in through single sign-on yet is added by an administrator as an account without a password for that provider. Renaming a team keeps it the owner everywhere; deleting a team removes it from owner and responsible lists (access lists and the owners of supplier contracts keep the entry, so access never widens – a contract without a team owner would be seen by every reader of its supplier); a team that is the only owning team of items is deleted only once you name the team they move to (0.20.0, [TEAMS.md](TEAMS.md)); before a team is deleted or an account is deactivated, the Users page lists where it is still named.

### Processes and platforms

A **process**'s rights are `view`, `run` (start, schedule, make selection decisions), `edit`, `approve` and `manage` (its shares, owner, archive); a **platform**'s are `view` (its page and health, 0.23.0), `use` (bind it in runs; read-only explorer calls) and `manage` (configuration, credentials, shares, write calls in the explorer). Without owning teams the role defaults apply; the item's _Access_ tab shares it with `user:…`, `team:…` or `role:…` subjects – View, Edit or Manage (a platform: View or Manage), with `run` and `approve` (processes) or `use` (platforms) beside the level – and **Restricted** keeps it to its shares, for example the production tenant to one team. Admins and the process owner (its creator) always keep full rights; auditors view processes. See [TEAMS.md](TEAMS.md#sharing-the-access-tab).

Until 0.22 these were **access lists**: the upgrade to 0.23.0 turned every entry into a share with exactly its rights, and an item with a list into a Restricted one – nobody gains or loses a right (an entry no level expresses, such as `manage` without `edit`, stays _Custom_ until someone changes it). The routes `PUT /api/processes/:id/access` and `/api/platforms/:id/access` still take an `acl` for one release (deprecated, signed-in sessions only).

## Passwords and recovery

- New accounts get a temporary password and must change it at first sign-in. Passwords need at least 12 characters (any characters, no composition rules) and must not be on the bundled list of common passwords; they are hashed with scrypt (N=2^17). Five failed sign-ins lock the account for five minutes.
- Forgotten admin password: `steward admin reset-password <user>` on the server (needs the master passphrase; audited). To reset a demo, delete its data folder. See [INSTALL.md](INSTALL.md#resetting-a-demo-and-recovering-access).

## Single sign-on

Any OpenID Connect provider works: presets pre-fill Microsoft Entra ID, Keycloak, Okta, Google Workspace and Authentik. You choose which claims give the user name, first and last name, e-mail, read-only profile fields (department, job title …) and the stable identifier, how each field is kept in sync, and which existing accounts a first sign-in may link. A **test sign-in** in the provider editor shows the claims a provider sends and the account a sign-in would get – without signing in. See [SSO.md](SSO.md).

Sign-in uses the OpenID Connect authorization code flow with PKCE, through the [openid-client](https://github.com/panva/openid-client) library. Tokens are checked for issuer, audience, signature (JWKS), expiry, nonce and state. The client secret is stored encrypted with the master passphrase.

How accounts are handled:

- **Auto-provision.** New users get an account on their first sign-in.
- **Role sync.** Roles, and the teams named in the mappings, are updated from the token at every sign-in.
- **Mapping required.** Users without a mapped role are rejected.
- **Pre-created accounts.** An account created for the provider, or a local account an administrator bound to it, is linked on its first SSO sign-in by its user name (e.g. the UPN). Linking any local account by name is a setting per provider ([linking existing accounts](SSO.md#linking-existing-accounts)). After that, the account is found by the identity's stable identifier (issuer + `sub`, or Entra `tid` + `oid`), not by its name.
- **No passwords.** SSO accounts have no password in Steward.
- **SSO only.** Under **Settings → Sign-in**, password sign-in can be limited to administrators. Local admin accounts stay as break-glass access, e.g. to unlock the vault after a restart.

Other providers use their preset or _Generic OIDC_: issuer URL, client ID and secret (or a public client with PKCE), and claim names – the steps per provider are in [SSO.md](SSO.md#presets). In demo mode a simulated Entra ID is preconfigured. Its accounts (Max Admin, Erik Engineer, Oskar Operator, Sofia Approver, Nina Nobody) show the mappings in action.

The steps for each provider, claims, account linking and the test sign-in are in [SSO.md](SSO.md).

## Using it as a team

Steward listens on `127.0.0.1` by default. To make it reachable on your network:

1. Set `SM_HOST=0.0.0.0` and `SM_ALLOWED_HOSTS=<machine name>`.
2. Provide a certificate with `SM_TLS_CERT` / `SM_TLS_KEY`, or run it behind your reverse proxy.
3. Create accounts under **Users & teams**.

One person (an admin) unlocks the vault after a restart, or you provide the passphrase in a file (`SM_MASTER_PASSPHRASE_FILE`) for unattended start-up. Before using it at work, go through [SECURITY-HARDENING.md](SECURITY-HARDENING.md).
