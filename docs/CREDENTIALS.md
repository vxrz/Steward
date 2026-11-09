# Credentials register

The credentials register documents the credentials your services depend on: API clients, technical users, tokens, certificates, agent certificates (for example of Insights Hub agents), SSH keys and passwords. For each one it records where it is kept, who owns it, who uses it and when it expires or needs rotating or a review. Steward reminds the owners in time.

**The register never holds a secret.** There is no field for a password or key. Keep the secrets where they are today (for example in KeePass) and write down _where_. Steward rejects text that looks like a secret, see [No secrets](#no-secrets).

Open it with **Credentials** in the navigation (German: _Zugangsdaten_).

## Add an entry

1. _Credentials → New entry_.
2. Enter a **name** and choose the **type**:
   API client / OAuth client, technical user / service account, password, token / API key, certificate, agent / device certificate, SSH key, other.
3. **Belongs to** (optional): the application, component or system of the [catalogue](APPLICATIONS.md) the credential belongs to – also when the application has no platform in Steward (a technical user of a database, a certificate of a server, a key of a cloud account). A new entry without Steward owners takes the owners of what it belongs to. The application page lists the entries of the application and of its components (with the component's name), the system page those of the system.
   Choose the **platform** (a platform in Steward you have a right on) or type a name, for example "Insights Hub eu1". Add the **environment** if it helps (production, test). People without a right on the linked platform do not see its name.
4. **Where it is kept**: the KeePass database and the path of the entry, for example `KeePass: IT-Ops.kdbx → Insights Hub/Agents/IoT2050-17`. **Link or path** is optional:
   - an `http(s)` link opens in a new tab (for example a vault web UI);
   - `keepass://…`, `*.kdbx`, `C:\…` or `\\server\share\…` paths are shown as text with a copy button, never as a link;
   - other link types (`javascript:`, `data:` …) are refused.
5. **Ownership**: e-mail addresses with a role, for example _Business owner_ (the business owns the credential) and _IT operations_ (IT manages it), at most 10. Their domain must be allowed, see [E-mail addresses outside Steward](#e-mail-addresses-outside-steward). Add Steward users or teams as owners if they should get reminders in Steward and may edit the entry.
6. **Used by**: a short description; links to processes, monitors, platforms, catalogue services or **applications** in Steward (the service's page lists the entry under _Linked from_, the application page under _Credentials_ with what is due); and **external links** with a label – a Swagger page, a vault entry, a wiki page (http(s) only, shown as plain links; other locations of the secret go under _Location_). The entry lists the first five, then _Show all_.
7. **Roles and permissions** (optional): what the credential may do – role or permission (required, e.g. `mdsp:core:TenantAdmin`), scope (e.g. _tenant modev_, _group X_), granted on, note. Rights often change without the secret being rotated, so changing this list writes its own history entry (_Roles changed_ – added, removed and changed entries, with an optional reason such as a ticket number) and an audit entry `credential.roles_changed`. The overview shows the roles as chips and filters by role (_Role_ filter; search finds roles and scopes too).
8. **Dates**:
   - _Expires_: the expiry date, if there is one;
   - _Rotate every (days)_ and _Last rotated_: the next rotation is computed from the last rotation (or the issue date);
   - _Review every (days)_ and _Last reviewed_: a regular check whether the credential is still needed and still owned by the right people (default for new entries: 365 days).
9. Save.

### Certificates

For the types _certificate_ and _agent / device certificate_ you can upload the **public** certificate: PEM, CRT or DER, also a whole chain (leaf first).

- Steward reads the subject, issuer, serial number, SHA-256 fingerprint, alternative names and validity, and sets _Expires_ to the earliest expiry date of the chain (unless you enter a date yourself).
- Only these details are stored, not the file. The fingerprint identifies the certificate if you need to find it again.
- A file with a private key is rejected, with the reason. PKCS#12 files (`.pfx`, `.p12`) contain the private key, so they are rejected too. Export the public part, for example `openssl pkcs12 -in agent.pfx -nokeys -clcerts -out agent.pem`.

### Expiry from Gatus

If Gatus already checks the certificate of an HTTPS endpoint, link the entry to it: _Expiry from Gatus_ (platform) and _Gatus endpoint_. Metrics mode must be on for the Gatus platform ([GATUS.md](GATUS.md#5-metrics-mode)). After each scrape Steward compares the certificate expiry Gatus reports with the entry and updates _Expires_ when it moved by more than 12 hours (a renewed certificate). The change is in the entry's history and in the audit log (`credential.expiry_synced`, actor `system`).

Certificates Gatus does not see, such as agent certificates of Insights Hub agents, are uploaded or entered by hand.

### App credentials from Entra ID

_Credentials → Import from Entra ID_ (people who may add entries, with _use_ on a Microsoft Graph platform) turns the **client secrets and certificates of an Entra ID tenant's app registrations** – and the signing certificates of its enterprise applications – into entries: one per secret or certificate, of type _API client / OAuth client_ or _Certificate_, linked to the platform, with the end date as _Expires_ and the start date as _Issued_, the location `Entra ID: App registrations → <app> → Certificates & secrets → client secret “<name>” (key id …)` and a link to the app's page in the Entra admin center, tag `entra-id`. **Preview** first shows what would be added; _Only those that end within (days)_ narrows it (credentials that ended more than 30 days ago are always left out).

An entry is found again by the key id in its location: a later import adds only new secrets and certificates and – when Entra ID says another end date (a renewed secret keeps its key id only in rare cases; a rotated one is a new entry) – changes the entry's _Expires_, with the history event _Expiry updated from Entra ID_ and the audit entry `credential.expiry_synced`. Everything else you changed (owners, notes, roles, reminders) stays. Graph returns names, ids and dates only, never a secret's value; Steward does not keep the hint (the first characters of a secret). API: `POST /api/credentials/import/entra` (`{ platformId, withinDays?, dryRun? }`). See [ENTRA.md](ENTRA.md).

### Vault secret (IBM Verify Privilege Vault)

An entry whose secret lives in IBM Verify Privilege Vault can name it: _Vault secret_ (the vault platform) and _Secret_ (search by name). Every six hours, or with _Read now_, Steward reads the secret's name, template, folder, last password change and expiry – never its value. The vault's last change counts as the last rotation when it is newer, so _Rotation interval_ is checked against it and an overdue rotation is flagged and reminded; the vault's expiry counts when the entry has none. A change found in the vault is a _Rotated_ event (`credential.vault_rotated`, actor `system`). See [IBM-PAM.md](IBM-PAM.md#credentials-register-link).

## Status

| Status   | Meaning                                                                      |
| -------- | ---------------------------------------------------------------------------- |
| OK       | No date is due within the "due soon" window                                  |
| Due soon | A date (expiry, rotation, review) is due within the window (default 30 days) |
| Overdue  | A rotation or review date has passed                                         |
| Expired  | The expiry date has passed                                                   |

The list shows the worst status of an entry and the next due date. Filter by type, status, platform, owner, due within _N_ days, and archived entries. The home page shows a _Credentials due_ card when something is expired, overdue or due soon.

## Rotate and review

Open an entry and use:

- **Mark rotated**: the date (default today), an optional new expiry date and a comment. For certificates, upload the new certificate in the editor instead – it sets the new expiry.
- **Mark reviewed**: the date and a comment, for example "still used by the historian export".

Both are recorded in the entry's history and in the audit log. Comments are checked for secrets like every other text.

## Reminders

Steward checks the register every few minutes and sends reminders through the notification service:

- to the Steward users and team members listed as owners: in the app and by e-mail, following each person's notification settings;
- to the owner e-mail addresses: by e-mail only, when e-mail is set up (_Settings → Notifications_), the event _Credential due_ is routed to e-mail (the default) and the address's domain is allowed (see below);
- to the administrators, if an entry has no owner at all.

When:

- before a due date, at each threshold of _Remind days before_ (default 30, 14, 7 and 1 days). Only the most recent threshold is sent: an entry added 5 days before its date gets the 7-day reminder, not three at once;
- after the date, an _overdue_ (or _expired_) reminder, repeated every _N_ days (default 7; 0 = once).

Each reminder is recorded in the database before it is sent, so it goes out once – also after a restart. A new due date (rotated, renewed, changed) starts the thresholds again. Nothing is sent while the vault is locked; the reminder follows after the unlock.

Administrators change the defaults under _Settings → Credential reminders_: the days, the repeat interval for overdue entries and the "due soon" window. Each entry can have its own days or no reminders (_Reminders_ in the editor).

Reminders and messages are in the recipient's language (English or German). The subject starts with "Credential reminder:" and shows the entry name in quotes, shortened to 80 characters.

### E-mail addresses outside Steward

Owner addresses are written by whoever edits an entry, so Steward does not mail just any address. An address only gets e-mails when its domain is allowed under _Settings → Notifications → Allowed e-mail domains for addresses outside Steward_:

- enter domains such as `corp.example`, or `*.corp.example` for all its subdomains (`*.corp.example` does not include `corp.example` itself – list both if you need both);
- while the list is empty, the company's own domains are allowed: the domains of active Steward users' addresses that an administrator or a single sign-on account uses, or at least two users. One user cannot open a domain by changing their own profile address.

Saving an entry with an address outside these domains fails with a message that names the setting. Addresses stored earlier are checked again on every send and skipped (the server log counts them).

## Who may do what

|                                          | Read                  | Add, edit, rotate, review | Archive, restore, delete |
| ---------------------------------------- | --------------------- | ------------------------- | ------------------------ |
| Administrator                            | ✓                     | ✓                         | ✓                        |
| Designer, operator                       | ✓                     | ✓                         |                          |
| Approver, auditor                        | ✓                     |                           |                          |
| Viewer                                   | only entries they own | entries they own          |                          |
| Owner (user or team listed on the entry) | ✓                     | ✓ (for that entry)        |                          |

Viewers do not see the register: it shows where credentials are kept and who holds them, which is more than a read-only dashboard user needs. A viewer listed as an owner sees and maintains that entry. Owners who edit an entry as owner (not as designer, operator or administrator) must keep themselves (or their team) in the owner list and cannot change the owner e-mail addresses – they decide who gets the reminders by e-mail. Archived entries are read-only until an administrator restores them.

All checks happen on the server; the API answers 404 for entries you may not see.

<a id="links-to-services-and-records"></a>

## Links to services and documents

- An entry that **belongs to** an application, a component or a system is listed on the application page (entries of its components with the component's name) and on the system page, with status and next due date. Removing a component hands its entries to the application; a system with entries is not deleted until they are moved or archived. The list filters by it (`?belongs=application:<id>`, `component:<id>`, `system:<id>`), the search finds the name, the CSV has a `belongs_to` column.
- An entry's **Used by** links can name catalogue services and applications. The service page shows the entry under _Linked from_, the application page under _Credentials_ (with status and next due date) – but only to people who may read the entry (viewers see only the entries they own).
- Documents and services can link to an entry (_Add link → Credential_). The link picker only offers entries you may see. For readers who may not see the entry, the link shows as "not visible", without its name.
- The entry's detail panel lists the documents and services that link to it under _Linked from_ (`GET /api/backlinks?kind=credential&id=…`).

## Export and API

- **CSV**: _Export CSV_ exports the entries you may see, with the current filters (archived entries included unless filtered). Values that start with `=`, `+`, `-` or `@` are prefixed with `'`, so spreadsheet programs do not run them as formulas. Exports are audited (`credential.exported`).
- **Public API** (read-only, API token, see [API.md](API.md)): `GET /api/v1/credentials` (filters `status`, `type`, `platform`, `dueWithinDays`, `archived`, `q`, `role`, `belongs`; paginated; entries carry `belongsTo`, `roles` and `usedBy.urls`) and `GET /api/v1/credentials/{credentialId}`. Same visibility as in the UI. Example: everything that expires or needs action within 30 days:

  ```bash
  curl -H "Authorization: Bearer $STEWARD_TOKEN" "https://steward.corp.example/api/v1/credentials?dueWithinDays=30"
  ```

- Internal API (web UI): `GET/POST /api/credentials`, `GET/PUT/DELETE /api/credentials/:id`, `POST /api/credentials/:id/rotated|reviewed|archive|restore`, `GET /api/credentials/:id/history`, `GET /api/credentials/export.csv`, `GET /api/credentials/summary`, `POST /api/credentials/certificate/parse`, `GET/PUT /api/credentials/settings`, `GET /api/credentials/belongs-targets` (what an entry can belong to).

## Identities

The credentials Steward itself uses to sign in to a platform are not part of the register: they are kept in the vault, on the platform's **default identity** ([ADR 0009](adr/0009-platform-identities.md), [PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#identities)). Nothing changes for the register: an entry links the platform as before. Linking an entry to one identity of a platform comes with several identities per platform in a later release.

## No secrets

The register is documentation. To keep secrets out of it:

- there is no field for a secret value;
- every free-text field (name, platform, environment, description, used by, owner roles, location, link, notes, tags, comments) is checked when it is saved. Steward rejects
  - private key blocks (`-----BEGIN … PRIVATE KEY-----`, OpenSSH, PGP);
  - JSON Web Tokens;
  - well-known token formats: GitHub (`ghp_…`, `github_pat_…`), GitLab, AWS access keys, Slack, Google API keys, Stripe, npm, Azure storage keys, Steward's own tokens;
  - URLs with a password (`https://user:secret@host`);
  - `password: …` / `client_secret = …` when the value looks like a password (mixed character classes, not a path or a link);
  - long random-looking strings (32+ characters with upper and lower case and digits and high entropy).
- The error names the field and the kind of secret, never the value. KeePass paths, URLs, host names, UUIDs and hex fingerprints are accepted.
- Uploaded certificates are parsed and only their metadata is kept; anything with a private key is refused.

The checks are deliberately conservative to avoid false alarms. They cannot catch every password ("Summer2024" alone is accepted). Train people to document the location, not the value.

## Audit

`credential.created`, `credential.updated` (with the changed fields, before and after), `credential.roles_changed` (added, removed, changed, reason), `credential.rotated`, `credential.reviewed`, `credential.archived`, `credential.restored`, `credential.deleted`, `credential.expiry_synced` (from Gatus or Entra ID), `credential.imported` (an import from Entra ID, on the platform), `credential.exported`, `credential.settings_changed`. The entry's own history shows the same events plus the reminders that were sent.
