# Credentials register

The credentials register documents the credentials your services depend on: API clients, technical users, tokens, certificates, agent certificates (for example of Insights Hub agents), SSH keys and passwords. For each one it records where it is kept, who owns it, who uses it and when it expires or needs rotating or a review. Steward reminds the owners in time.

**The register never holds a secret.** There is no field for a password or key. Keep the secrets where they are today (for example in KeePass) and write down _where_. Steward rejects text that looks like a secret, see [No secrets](#no-secrets).

Open it with **Credentials** in the navigation (German: _Zugangsdaten_).

## Add an entry

1. _Credentials → New entry_.
2. Enter a **name** and choose the **type**:
   API client / OAuth client, technical user / service account, password, token / API key, certificate, agent / device certificate, SSH key, other.
3. Choose the **platform** (a platform in Steward) or type a name, for example "Insights Hub eu1". Add the **environment** if it helps (production, test).
4. **Where it is kept**: the KeePass database and the path of the entry, for example `KeePass: IT-Ops.kdbx → Insights Hub/Agents/IoT2050-17`. **Link or path** is optional:
   - an `http(s)` link opens in a new tab (for example a vault web UI);
   - `keepass://…`, `*.kdbx`, `C:\…` or `\\server\share\…` paths are shown as text with a copy button, never as a link;
   - other link types (`javascript:`, `data:` …) are refused.
5. **Ownership**: e-mail addresses with a role, for example _Business owner_ (the business owns the credential) and _IT operations_ (IT manages it), at most 10. Their domain must be allowed, see [E-mail addresses outside Steward](#e-mail-addresses-outside-steward). Add Steward users or teams as owners if they should get reminders in Steward and may edit the entry.
6. **Used by**: a short description, and links to processes, monitors or platforms in Steward.
7. **Dates**:
   - _Expires_: the expiry date, if there is one;
   - _Rotate every (days)_ and _Last rotated_: the next rotation is computed from the last rotation (or the issue date);
   - _Review every (days)_ and _Last reviewed_: a regular check whether the credential is still needed and still owned by the right people (default for new entries: 365 days).
8. Save.

### Certificates

For the types _certificate_ and _agent / device certificate_ you can upload the **public** certificate: PEM, CRT or DER, also a whole chain (leaf first).

- Steward reads the subject, issuer, serial number, SHA-256 fingerprint, alternative names and validity, and sets _Expires_ to the earliest expiry date of the chain (unless you enter a date yourself).
- Only these details are stored, not the file. The fingerprint identifies the certificate if you need to find it again.
- A file with a private key is rejected, with the reason. PKCS#12 files (`.pfx`, `.p12`) contain the private key, so they are rejected too. Export the public part, for example `openssl pkcs12 -in agent.pfx -nokeys -clcerts -out agent.pem`.

### Expiry from Gatus

If Gatus already checks the certificate of an HTTPS endpoint, link the entry to it: _Expiry from Gatus_ (platform) and _Gatus endpoint_. Metrics mode must be on for the Gatus platform ([GATUS.md](GATUS.md#5-metrics-mode)). After each scrape Steward compares the certificate expiry Gatus reports with the entry and updates _Expires_ when it moved by more than 12 hours (a renewed certificate). The change is in the entry's history and in the audit log (`credential.expiry_synced`, actor `system`).

Certificates Gatus does not see, such as agent certificates of Insights Hub agents, are uploaded or entered by hand.

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

## Export and API

- **CSV**: _Export CSV_ exports the entries you may see, with the current filters (archived entries included unless filtered). Values that start with `=`, `+`, `-` or `@` are prefixed with `'`, so spreadsheet programs do not run them as formulas. Exports are audited (`credential.exported`).
- **Public API** (read-only, API token, see [API.md](API.md)): `GET /api/v1/credentials` (filters `status`, `type`, `platform`, `dueWithinDays`, `archived`, `q`; paginated) and `GET /api/v1/credentials/{credentialId}`. Same visibility as in the UI. Example: everything that expires or needs action within 30 days:

  ```bash
  curl -H "Authorization: Bearer $STEWARD_TOKEN" "https://steward.corp.example/api/v1/credentials?dueWithinDays=30"
  ```

- Internal API (web UI): `GET/POST /api/credentials`, `GET/PUT/DELETE /api/credentials/:id`, `POST /api/credentials/:id/rotated|reviewed|archive|restore`, `GET /api/credentials/:id/history`, `GET /api/credentials/export.csv`, `GET /api/credentials/summary`, `POST /api/credentials/certificate/parse`, `GET/PUT /api/credentials/settings`.

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

`credential.created`, `credential.updated` (with the changed fields, before and after), `credential.rotated`, `credential.reviewed`, `credential.archived`, `credential.restored`, `credential.deleted`, `credential.expiry_synced`, `credential.exported`, `credential.settings_changed`. The entry's own history shows the same events plus the reminders that were sent.
