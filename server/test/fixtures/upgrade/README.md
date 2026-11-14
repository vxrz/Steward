# Upgrade test fixtures – TEST DATA ONLY

Each folder holds a Steward data folder written by a released version, used by
`server/test/upgrade.test.ts` to check that the current version upgrades it (see
[docs/TESTING.md](../../../../docs/TESTING.md#upgrade-tests)).

| Folder     | Written by          | Made                                         |
| ---------- | ------------------- | -------------------------------------------- |
| `v0.1.0/`  | v0.1.0 (`8306c7a`)  | 2026-10-23, demo data plus the content below |
| `v0.2.0/`  | v0.2.0 (`3e229f1`)  | 2026-10-26, demo data plus the content below |
| `v0.2.1/`  | v0.2.1 (`a8c1a40`)  | 2026-10-27, demo data plus the content below |
| `v0.2.2/`  | v0.2.2 (`a251063`)  | 2026-10-28, demo data plus the content below |
| `v0.2.3/`  | v0.2.3 (`626abd0`)  | 2026-10-28, demo data plus the content below |
| `v0.2.4/`  | v0.2.4 (`f5e3f20`)  | 2026-10-29, demo data plus the content below |
| `v0.2.5/`  | v0.2.5 (`e29426c`)  | 2026-10-30, demo data plus the content below |
| `v0.2.6/`  | v0.2.6 (`7812a1d`)  | 2026-10-30, demo data plus the content below |
| `v0.2.7/`  | v0.2.7 (`ffedab8`)  | 2026-10-30, demo data plus the content below |
| `v0.2.8/`  | v0.2.8 (`bf76265`)  | 2026-10-31, demo data plus the content below |
| `v0.2.9/`  | v0.2.9 (`40275c9`)  | 2026-10-31, demo data plus the content below |
| `v0.2.10/` | v0.2.10 (`f23bf21`) | 2026-10-31, demo data plus the content below |
| `v0.3.0/`  | v0.3.0 (`e999cf5`)  | 2026-11-02, demo data plus the content below |
| `v0.3.1/`  | v0.3.1 (`7d29135`)  | 2026-11-03, demo data plus the content below |
| `v0.4.0/`  | v0.4.0 (`e21c4b9`)  | 2026-11-04, demo data plus the content below |
| `v0.5.1/`  | v0.5.1 (`e1d3bc9`)  | 2026-11-05, demo data plus the content below |
| `v0.6.0/`  | v0.6.0 (`4e45d29`)  | 2026-11-05, demo data plus the content below |
| `v0.7.0/`  | v0.7.0 (`89c1ed7`)  | 2026-11-06, demo data plus the content below |
| `v0.8.0/`  | v0.8.0 (`edaebe2`)  | 2026-11-06, demo data plus the content below |
| `v0.9.0/`  | v0.9.0 (`67565a8`)  | 2026-11-07, demo data plus the content below |
| `v0.10.0/` | v0.10.0 (`6439eb8`) | 2026-11-08, demo data plus the content below |
| `v0.10.1/` | v0.10.1 (`e965ca2`) | 2026-11-08, demo data plus the content below |
| `v0.11.0/` | v0.11.0 (`7096e55`) | 2026-11-09, demo data plus the content below |
| `v0.12.0/` | v0.12.0 (`b05b60e`) | 2026-11-09, demo data plus the content below |
| `v0.13.0/` | v0.13.0 (`4a1b0dd`) | 2026-11-10, demo data plus the content below |
| `v0.14.0/` | v0.14.0 (`633b532`) | 2026-11-10, demo data plus the content below |
| `v0.15.0/` | v0.15.0 (`d0c3a67`) | 2026-11-10, demo data plus the content below |
| `v0.16.0/` | v0.16.0 (`4ec4544`) | 2026-11-10, demo data plus the content below |
| `v0.17.0/` | v0.17.0 (`d49206b`) | 2026-11-11, demo data plus the content below |
| `v0.18.0/` | v0.18.0 (`2a16994`) | 2026-11-11, demo data plus the content below |
| `v0.19.0/` | v0.19.0 (`a053d42`) | 2026-11-12, demo data plus the content below |
| `v0.20.0/` | v0.20.0 (`95f34aa`) | 2026-11-13, demo data plus the content below |
| `v0.21.0/` | v0.21.0 (`47537bc`) | 2026-11-13, demo data plus the content below |
| `v0.22.0/` | v0.22.0 (`cf22a4c`) | 2026-11-13, demo data plus the content below |
| `v0.23.0/` | v0.23.0 (`7b998c9`) | 2026-11-13, demo data plus the content below |
| `v0.24.0/` | v0.24.0 (`cc716d7`) | 2026-11-13, demo data plus the content below |

**Nothing here is secret.** The vault (`datadir/vault.json`), the installation's Ed25519 signing
key and HMAC audit key wrapped in it, and the encrypted platform credentials in the database are
protected by a passphrase that is published on purpose:

- master passphrase: `steward-upgrade-fixture`
- administrator: `admin` / `Fixture-admin-password-1`
- demo users (`dana`, `olivia`, `adam`, `audrey`, `vera`, …): `Demo-password-1`
- the demo platforms point at the mock platforms of a server that no longer runs

Never use these files, keys or passwords for anything else. The secret scanners skip only the
generated vault, anchor and database files of these folders (`.gitleaks.toml`).

## Contents

- `datadir/` – what an installation keeps: `service-manager.db` (SQLite, compacted),
  `vault.json`, `audit-anchor.json`, `records/` (attachments), `reports/` (a PDF/A run report),
  `evidence-packs/` (a signed evidence pack). No logs, no `instance.json`.
- `manifest.json` – the version, the passphrase and the ids and counts the test checks.

The data: the demo setup (platforms, processes, users, dashboards, schedules, feeder runs,
monitors, an access check), finished runs (succeeded and failed), an access review with a decision
and its PDF report, a run waiting for an approval task, a disabled schedule, a change request with
two attachments that was submitted and approved (four-eyes), a draft decision record, a service, a
credentials register entry, monitors with check history, a dashboard, a ticket reference, two access
changes (one documented after the fact), an evidence pack, and an audit log of about 270 entries
with signed checkpoints.

## Making a new one

After tagging a minor release, run the generator against a checkout of that release:

```bash
git worktree add --detach ../steward-v0.2.0 v0.2.0
(cd ../steward-v0.2.0 && npm ci --ignore-scripts)
node scripts/fixtures/make-upgrade-fixture.mjs --app ../steward-v0.2.0 --out server/test/fixtures/upgrade/v0.2.0
git worktree remove ../steward-v0.2.0
```

Then add a row to the table above. Do not regenerate the fixture of an old release with newer
code: it has to be what that release wrote.
