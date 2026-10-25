# Single sign-on (OpenID Connect)

Steward signs people in through any OpenID Connect provider: Microsoft Entra ID, Keycloak, Okta, Google Workspace, Authentik, ADFS and others. This page explains how to set up a provider, how the claims of a sign-in become a Steward account, and how to test it without signing anyone in.

Sign-in uses the authorization code flow with PKCE ([openid-client](https://github.com/panva/openid-client)). Steward checks the issuer, audience, signature (JWKS), expiry, nonce and state of every ID token. The client secret is stored encrypted with the master passphrase, and the provider's settings are sealed: settings changed outside Steward are refused until an administrator saves them again.

- [Set up a provider](#set-up-a-provider)
- [Test sign-in](#test-sign-in)
- [How claims become an account](#how-claims-become-an-account)
- [Linking existing accounts](#linking-existing-accounts)
- [Security: claims your organisation controls](#security-claims-your-organisation-controls)
- [Presets](#presets): [Microsoft Entra ID](#microsoft-entra-id) · [Keycloak](#keycloak) · [Okta](#okta) · [Google Workspace](#google-workspace) · [Authentik](#authentik) · [Generic OpenID Connect](#generic-openid-connect)
- [Audit entries](#audit-entries)
- [Upgrading from an earlier version](#upgrading-from-an-earlier-version)

## Set up a provider

1. **Copy the redirect URI.** Go to **Users & teams → Single sign-on**. Copy the redirect URI shown there, e.g. `https://steward.example.com/api/auth/oidc/callback`. It must match exactly how people open Steward (host name, `http`/`https`, base path).
2. **Register Steward at your identity provider** as a confidential web application with that redirect URI. The [presets](#presets) below list the steps for each provider.
3. **Add the provider in Steward.** Click **Add provider** and choose the identity provider. The preset pre-fills the scopes, claim names and the groups claim. Every value stays editable; a preset is never required.
4. Enter the **issuer URL**, the **client ID** and the **client secret**, then click **Test discovery**.
5. **Save**, then run a **test sign-in** (below). It shows what your provider sends and what Steward would do with it.
6. **Map roles and teams** from the groups (or roles) claim, then enable the provider.

## Test sign-in

The test sign-in is at the bottom of the provider editor (saved providers, also disabled ones).

1. Click **Test sign-in**. The provider's sign-in page opens in a new window.
2. Sign in there – as yourself or with a test account.
3. Back in the editor you see:
   - the **claims of the ID token** and the **claims from the userinfo endpoint** (names and values; never the tokens themselves);
   - a **preview of the account**: user name (and the claim it came from), display, first and last name, e-mail and whether it is confirmed, profile fields, the stable identifier, groups and the mappings they match, roles and teams;
   - **what a sign-in would do**: sign in to the linked account, re-link it, link an existing account, create a new one – or refuse it, and why.

The preview uses the settings in the form, also unsaved ones. Change a claim name or the linking policy and the preview follows. The connection (issuer, client, secret) is always the saved one.

A test sign-in never signs anyone in: no session, no cookie, no account created, linked or changed. Only the administrator who started it can see the result, for 15 minutes. It is audited as `sso.test_sign_in`.

## How claims become an account

### User name

- **User name claim** (default `preferred_username`). Without it, the e-mail claim names the account, and without that, the `sub`.
- **User name rule:** _lower case_ (default, as before), _lower case without @domain_ (`max@contoso.com` → `max`), or _as sent by the provider_. User names are unique ignoring case.
- Without the domain, people of different domains get the same name. The second one is refused (the account belongs to the first identity). When you save the rule, Steward lists accounts of this provider that would collide.
- A user name has at most 128 characters.

### Stable identifier

Once an identity is linked to an account, Steward finds the account by the identity's **stable identifier**, not by its name.

- It is the **issuer** together with one to three claims. The default is `sub`. The Entra ID preset uses `tid` + `oid` (the object id in the tenant is the same for every app registration; `sub` differs per app).
- Use claims nobody can change. Never `email`, `upn`, `preferred_username` or `name`: the editor warns about them.
- **Changing the claims is safe.** Steward also records the issuer + `sub` of every linked identity. At the next sign-in after a change, the account is found by that earlier link and re-linked to the new identifier (`user.sso_relinked`). An account linked by the claims configured now is never re-linked to another identity, even if its recorded `sub` matches.
- **Links from earlier versions** (provider id + `sub`) keep working: they are re-linked the same way at the next sign-in.
- **Changing the issuer** starts a new namespace: links stay with the former issuer, and those people get no access through the new one. When the new issuer issues the same subjects (e.g. a renamed host or realm URL), tick **Keep the existing accounts linked to the new issuer** when you save.
- When the claims are missing from the token, the sign-in is refused.

### Names, e-mail and sync rules

- **First and last name** come from `given_name` and `family_name` (configurable).
- **Display name** from its own claim (`name`) or from a template such as `{given_name} {family_name}` (claims in braces; nested claims allowed). Missing claims are left out.
- **E-mail** from the e-mail claim.
- **Sync rule per field:** _at every sign-in_ – the provider is the source of truth, and the field cannot be edited in Steward (not by the person, not by an administrator) – or _only when the account is created or linked_ – then it can be edited in Steward afterwards. Fields are updated only when the claim is sent.

### Profile fields

Read-only fields on the account, e.g. department, job title, phone, city:

- A list of _key ← claim_ pairs with a label, at most 20. Nested claims with dots: `address.locality`. A claim name that contains dots itself (like a URL) is used as it is.
- Lists are joined with commas; values are cut at 500 characters; control characters are removed.
- Sync rule per field: _at every sign-in_ (a field the provider no longer sends is removed) or _only when the account is created or linked_.
- Shown on the user dialog (**Users & teams**), on the person's profile and in the public API (`/api/v1/users`: `firstName`, `lastName`, `profile`) – so reports and dashboards can use them.

### Groups and roles

- **Groups claim** (default `roles` for Entra app roles, `groups` elsewhere) and the **mappings**: a claim value → roles and teams.
- **Values are names** (matched ignoring case) or **ids** (matched exactly, e.g. Entra group object ids, Okta group ids).
- **Group overage:** when a person has too many groups, Entra ID leaves them out of the token and sends `_claim_names` / `_claim_sources` (or `hasgroups`). Steward cannot see the groups then: no roles come from them, the sign-in is logged and audited (`sso.groups_overage`), a provider that requires a mapping refuses the sign-in, and the test sign-in shows it. Fix it at the provider: assign groups to the application ("groups assigned to the application"), use app roles, or a group filter.

### Required claims

Sign-in only when a claim has one of the accepted values (compared ignoring case; for a list claim one of its values), e.g.:

- Google Workspace: `hd` = your domain (otherwise any Google account can sign in);
- Entra ID with a multi-tenant issuer (`common`, `organizations`): `tid` = your tenant id.

### Userinfo endpoint

Some providers leave claims out of the ID token. Turn on **Also read the userinfo endpoint**: its claims complete the ID token's (the ID token wins when both have a claim; the userinfo response must name the same `sub`). The test sign-in always shows the userinfo claims.

### E-mail confirmation

Whenever the e-mail claim **names** the account (the user name claim is `email`, or the user name falls back to it) or **identifies** it (it is a stable identifier claim), the provider must confirm the address: `email_verified` must be `true`. Otherwise the sign-in is refused.

Some providers never send `email_verified` (Entra ID without the optional claim). If your provider verifies every address anyway, tick **This provider verifies e-mail addresses** – the editor warns while it is on. With Entra ID, prefer `preferred_username` (the UPN) as user name.

## Linking existing accounts

What happens when an identity signs in for the first time and an account with its user name exists already – per provider:

| Setting                                                                               | What it links                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Only accounts an administrator bound to this provider** (default for new providers) | Accounts created for this provider (_New user → Signs in with_) and local accounts an administrator bound to it (_Edit user → Signs in with_; this removes the password). |
| **Any local account with the same user name**                                         | Also local accounts with a password. Whoever has that name at the provider gets the account, its roles and its history. The editor warns.                                 |
| **Never – only new accounts**                                                         | No existing account, also no bound one. A new identity whose user name is taken is refused.                                                                               |

In every mode:

- a **local administrator** is never linked by its name – bind it first;
- an account of **another provider** is never linked;
- an account **linked to another identity** of the same provider is never handed over;
- a disabled account is refused, and a former name of an imported account never becomes a new account.

Providers saved before this setting existed keep **Any local account with the same user name** (as before) and show a warning in the editor. Review it and switch to _Only bound accounts_ once your accounts are bound.

## Security: claims your organisation controls

Every claim that names, identifies or links an account must be controlled by your organisation – not by the person and not by another organisation. Otherwise someone can sign in as someone else (the "nOAuth" class of flaws).

- Use an immutable identifier as the stable identifier (`sub`; Entra ID `tid` + `oid`).
- With a multi-tenant issuer (Entra ID `common` / `organizations`), every organisation's administrators decide the `email`, `upn` and `preferred_username` of their accounts. Add a required claim `tid` and do not name accounts by these claims.
- People can often change `name`, `nickname`, `given_name` and `family_name` themselves.
- The editor shows a warning for each of these cases. All changes of the claim settings are audited with the old and new values (`sso.provider_updated`).

See also [SECURITY-HARDENING.md](SECURITY-HARDENING.md).

## Presets

### Microsoft Entra ID

1. In the Entra admin center go to _App registrations → New registration_. Name it e.g. "Steward", single tenant.
2. Add the redirect URI (platform _Web_). For purely local use `http://localhost:4310/api/auth/oidc/callback` works – Entra only allows plain http for `localhost`.
3. Under _Certificates & secrets_ create a client secret.
4. Under _App roles_ create e.g. `SM.Admins`, `SM.Designers`, `SM.Operators`, `SM.Approvers`, `SM.Auditors`, `SM.Viewers` (member types _Users/Groups_).
5. Under _Enterprise applications → Steward → Users and groups_ assign people or groups to the roles. Optionally set _Assignment required = Yes_.
6. In Steward choose **Microsoft Entra ID**, enter the tenant id, client id and secret.

Pre-filled: issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`, scopes `openid profile email`, user name `preferred_username` (the UPN), stable identifier `tid` + `oid`, groups claim `roles` (app role values, names), client secret in the form body.

Notes:

- **E-mail:** Entra ID sends `email_verified` only as an optional claim, and the `email` claim is not verified for every account. Keep `preferred_username` as user name.
- **Groups instead of app roles:** let Entra emit the `groups` claim (_Token configuration_), set the groups claim to `groups` and the values to _ids_, and map group object ids. Tokens carry at most 200 groups; beyond that Entra sends an overage indicator ([groups and roles](#groups-and-roles)). App roles avoid that.
- **Multi-tenant** (`organizations`): add the required claim `tid`.

### Keycloak

1. In your realm, _Clients → Create client_: type OpenID Connect, client authentication on, standard flow on.
2. Add the redirect URI as _Valid redirect URI_.
3. Copy the secret from _Credentials_.
4. For groups: _Client scopes → \<client\>-dedicated → Add mapper → Group Membership_, token claim name `groups`, _Full group path_ off, _Add to ID token_ on.

Pre-filled: issuer `https://<host>/realms/<realm>`, user name `preferred_username`, groups claim `groups` (names), Basic client authentication. Keycloak sends `email_verified`.

### Okta

1. _Applications → Create App Integration → OIDC – Web Application_; add the redirect URI as sign-in redirect URI.
2. Assign people or groups.
3. For groups: _Security → API → Authorization servers → default → Claims → Add claim_ `groups`, type ID token, value type _Groups_, a filter (e.g. starts with `SM.`); or the app's _Groups claim filter_ with the org authorization server.

Pre-filled: issuer `https://<your-org>.okta.com/oauth2/default` (use `https://<your-org>.okta.com` for the org authorization server), scopes `openid profile email groups`, groups claim `groups` (names). Okta sends `email_verified`. If profile claims are missing from the ID token, turn on the userinfo endpoint.

### Google Workspace

1. In the Google Cloud console, _APIs & Services → OAuth consent screen_: user type **Internal** (only your Workspace).
2. _Credentials → Create credentials → OAuth client ID_, type _Web application_, add the redirect URI.
3. In Steward enter your Workspace domain as accepted value of the required claim `hd` – the preset adds the rule, and the provider cannot be saved without a value.

Pre-filled: issuer `https://accounts.google.com`, user name from `email` (Google sends no `preferred_username`; the address is confirmed with `email_verified`), no groups claim (Google ID tokens carry no groups: use default roles, or create accounts with roles in Steward and bind them).

### Authentik

1. _Applications → Providers → Create → OAuth2/OpenID Provider_, client type confidential, add the redirect URI.
2. Create an application with that provider; note its slug.
3. The default scope mappings (`openid`, `profile`, `email`) include `groups`.

Pre-filled: issuer `https://<host>/application/o/<application-slug>/` (with the trailing slash; Steward accepts the issuer with or without it), user name `preferred_username`, groups claim `groups` (names), Basic client authentication.

### Generic OpenID Connect

Any provider with discovery (`/.well-known/openid-configuration` below the issuer): enter the issuer, client id and secret (or a public client with PKCE: client authentication _none_), and the claim names your provider uses. Run a test sign-in to see them.

## Audit entries

| Action                 | When                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `sso.provider_created` | A provider is added (all settings).                                                  |
| `sso.provider_updated` | Settings change: the changed settings with their former values, links kept or moved. |
| `sso.test_sign_in`     | A test sign-in finished: as whom, and what a sign-in would do (nothing changed).     |
| `sso.groups_overage`   | A token left the groups out.                                                         |
| `user.created`         | An account was created at its first sign-in.                                         |
| `user.linked_sso`      | An existing account was linked at the first sign-in (with the linking policy).       |
| `user.sso_relinked`    | An account was re-linked to the stable identifier through its earlier link.          |
| `user.roles_synced`    | Roles or mapped teams changed from the claims.                                       |
| `auth.login_failed`    | A sign-in was refused (with the reason).                                             |

## Upgrading from an earlier version

- Providers keep working unchanged. Settings they were saved without are read with the behaviour of earlier versions: user name in lower case, `sub` as stable identifier, names and e-mail updated at every sign-in, group values as names – and **linking local accounts by name**, which the editor flags. New providers link only bound accounts.
- Existing links are re-linked to the new format at each person's next sign-in (`user.sso_relinked`).
- The database migration `signin-002-sso-claims` adds first and last name, the profile fields and the recorded issuer + `sub` to the user accounts. It does not touch the providers (their settings stay sealed as stored).
