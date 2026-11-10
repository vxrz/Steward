# Backups to S3

Steward can back itself up: on a schedule it makes a consistent copy of its **database** and its **data folder**, encrypts the copy with a **backup passphrase** and uploads it to an **S3 bucket**. A retention rule removes older copies, and once a week the newest copy is downloaded, decrypted and checked completely. Administrators are notified when a backup or a restore test fails (event _Backup failed_).

Set it up under _Settings → Backups_ (administrators; changes ask for your password again).

## What is in a backup

| Part        | SQLite                                                                          | PostgreSQL                                                                |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Database    | a consistent snapshot (`VACUUM INTO` in a worker thread, while Steward runs)    | `pg_dump --format=custom` of Steward's schema (restore with `pg_restore`) |
| Data folder | `vault.json`, `artifacts/`, `docs/`, `reports/`, `audit-anchor.json`, …         | the same                                                                  |
| Manifest    | `manifest.json`: every file with its size and SHA-256, the last audit log entry | the same                                                                  |

Not included: the live database files (the snapshot stands for them), the automatic copies made before upgrades (`backups/`), the work folders of backups and exports, and – when an administrator leaves them out ([Contents](#contents)) – run artifacts, archived reports and evidence packs.

**The master passphrase is never in a backup.** The credentials in the database are encrypted with the vault's key, which `vault.json` holds encrypted with the master passphrase. To restore you need the backup, the **backup passphrase** and the **master passphrase**. Keep both passphrases offline, apart from each other and from the bucket.

### Contents

From 0.16.0 an administrator chooses under _Settings → Backups → Contents_ which bulky folders of the data folder a backup holds. The page shows every part with its current size (_Show sizes_) and what a restore lacks without it.

| Part                                       | In a backup    | Without it, a restore lacks …                                                                                                                                                                                         |
| ------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database                                   | always         | everything – it is the backup                                                                                                                                                                                         |
| `vault.json`                               | always         | the keys of the credentials: the database could not be read                                                                                                                                                           |
| `audit-anchor.json`                        | always         | the proof that the audit log was not cut short                                                                                                                                                                        |
| `audit-archives/`                          | always         | audit entries the audit retention moved out of the database                                                                                                                                                           |
| `records/`, `docs/`, `branding/`, the rest | always         | originals people uploaded (attachments of records and documents, platform documents, logos)                                                                                                                           |
| `manifest.json`                            | always         | the SHA-256 of every file: nothing could be checked                                                                                                                                                                   |
| Run artifacts (`artifacts/`)               | yes, by choice | screenshots, files and evidence of manual steps of every run. **Evidence that cannot be made again**; reports and evidence packs generated after the restore miss them                                                |
| Archived reports (`reports/`)              | yes, by choice | the archived PDF reports. **Evidence**: a report can be generated again from its run, as a new version with another SHA-256 – the archived copy and signatures added to it are gone (the audit log names its SHA-256) |
| Evidence packs (`evidence-packs/`)         | yes, by choice | the packs built so far (they expire after `SM_EVIDENCE_RETENTION_DAYS` anyway). They can be built again for the same period – with a new signature, from the data still in Steward                                    |

All three optional parts are evidence, so **all are included by default** (as before 0.16.0), the page warns while one is left out, and saving a part left out asks for a confirmation that names what a restore then lacks. Leave one out only when it is kept elsewhere – e.g. artifacts on storage with its own backup – or not needed after a restore. A required part cannot be left out: the API refuses it (`BACKUP_PART_REQUIRED`) instead of dropping it.

A backup that leaves parts out says so everywhere: `manifest.json` lists them under `excluded` (folder, files and bytes at the time of the backup), the unencrypted header of the file names them (`npm run backup -- info <file>` prints _Left out by the backup settings (a restore lacks them): artifacts/, reports/_), the run's steps show a step _contents_, and the restore test adds a passing step _contents_ with what a restore from that backup lacks. The audit entry of the settings (`backup.settings_updated`) names the parts left out.

## Encryption

The backup is a ZIP archive, encrypted with AES-256-GCM in 4 MB chunks with a key derived from the backup passphrase (scrypt, N=2¹⁷). Each chunk is authenticated together with the file header, its position and whether it is the last one: a changed byte, re-ordered or missing chunks and a file cut short are all detected. Steward keeps the derived key encrypted in its vault so scheduled backups need no one; the passphrase itself is not stored anywhere.

After you change the backup passphrase, new backups use the new key. Older backups stay readable with the passphrase they were made with – keep it until the retention rule has removed them. The header of every file names its key (`npm run backup -- info <file>`).

## Setting it up

### 1. The bucket

Any S3 bucket or S3-compatible storage (MinIO, Ceph, Wasabi, Hetzner Object Storage, Cloudflare R2 …). Recommended:

- **Versioning** and **S3 Object Lock** (governance or compliance mode, default retention of e.g. 35 days): even someone with Steward's key cannot delete or overwrite a recent backup. Steward reports backups that Object Lock keeps instead of failing – and, apart from them, backups it may not delete because the key lacks `s3:DeleteObject` (_not removed: the key may not delete_).
- A **lifecycle rule** that removes old versions and incomplete multipart uploads after a few days.
- A bucket in another account or location than the server.

A policy for Steward's key or role, limited to the folder (`steward/` here):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::my-backups", "Condition": { "StringLike": { "s3:prefix": "steward/*" } } },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::my-backups/steward/*"
    }
  ]
}
```

### 2. The storage platform

Under _Platforms_, add a platform of type _Generic REST API_:

- **Base URL**: the bucket – `https://my-backups.s3.eu-central-1.amazonaws.com` (virtual-hosted), or `https://minio.example.com/my-backups` (path style).
- **Authentication**: _AWS request signing (SigV4)_, service `s3`, the bucket's region (S3-compatible storage: its own region name, often `us-east-1`). Credentials `accessKeyId` and `secretAccessKey`, or – recommended on AWS – a role to assume ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md)).

Backups only go over https and only to a platform with this sign-in.

### 3. Passphrase, schedule, retention

- **Backup passphrase**: at least 16 characters. Write it down and keep it offline.
- **S3 storage** and **folder in the bucket** (`steward/` by default).
- **Schedule**: five-field cron, default `15 2 * * *` (02:15 every day), and the time zone.
- **Keep**: the newest backup of each of the last 7 days, 4 ISO weeks and 12 months (by default) that have one; the newest backup is always kept. Counting only days that have a backup means that when backups stop, the last ones are not deleted day by day. Only objects named `steward-<UTC time>.smbackup` directly in the folder are ever removed.
- **Weekly restore test**: default `45 3 * * 0` (Sundays 03:45).

_Back up now_ and _Test the newest backup_ start one right away. _History_ shows every run with its steps; the audit log records each backup (object, size, SHA-256), each test, and every change of settings or passphrase.

## The restore test

1. Download the newest backup and compare its SHA-256 with the one recorded at upload – a copy changed in the bucket fails here.
2. Decrypt it: every chunk must authenticate.
3. Check every file of the archive against the manifest (SHA-256, size, CRC, nothing missing, nothing extra).
4. What the backup settings left out ([Contents](#contents)): a passing step _contents_ names the folders a restore from this backup lacks.
5. The database: SQLite – `PRAGMA integrity_check` on the snapshot and the **audit chain of the snapshot** (every entry, against the installation's audit key, ending at the entry the manifest names; after archived entries were deleted, from the signed checkpoint they were deleted up to). PostgreSQL – `pg_restore --list` reads the dump; with a restore test database (below), the dump is restored and checked like a SQLite snapshot.

**PostgreSQL: a restore test database.** `pg_restore --list` only shows that the table of contents of a dump can be read. To find out whether the data restores, give the restore test a database of its own: `SM_BACKUP_RESTORE_TEST_DATABASE_URL=postgres://steward_restore@db.corp.example:5432/steward_restore_test` (or `SM_BACKUP_RESTORE_TEST_DATABASE_URL_FILE`). The test then restores the dump there with `pg_restore --no-owner --no-privileges`, checks that the tables and the schema version are there and verifies the **audit chain of the restored data** as above (step _restore_ and _audit_), and drops the restored schema again.

- It must be another database than the live one: `pg_restore` restores into the schema the dump was made of, which is the live schema's name. Steward refuses a URL that names the live database (same host, port and database).
- Use an empty database that nothing else uses. Its account needs to create schemas (owner of the database). A schema of the same name that the restore test did not create is left alone, and the test fails. Steward marks the schemas it creates there with a comment.
- The restore takes as long as a real restore and needs the space of the database on that server once a week.

**Audit archives** (_Audit log → Epochs, archives and retention_) are in the data folder (`audit-archives/`), so every backup holds them. With _Also upload to the backup target_ each archive is uploaded once more on its own, encrypted with the backup key like a backup, to `<prefix>audit-archives/<file>.smbackup` – outside the retention rule of the backups, which only touches objects directly under the prefix. Read one with `steward backup decrypt <file> --out archive.zip`, then check it with `steward audit verify-archive archive.zip`.

A failed step fails the test, and the administrators get the _Backup failed_ notification (in-app and e-mail by default; change the channels under _Settings → Notifications_).

## Restoring

Decrypt and check a backup on any machine with Node.js and the Steward sources (or the container image, or the desktop app):

```bash
npm run backup -- verify steward-20261030T021500Z.smbackup              # asks for the backup passphrase
npm run backup -- decrypt steward-20261030T021500Z.smbackup --out restore.zip
# container: docker run --rm -it -v "$PWD:/work" ghcr.io/vxrz/steward:<version> node server/dist/backup.js decrypt /work/<file> --out /work/restore.zip
# desktop:   steward backup decrypt <file> --out restore.zip
```

The passphrase can also come from `--passphrase-file <file>` or `SM_BACKUP_PASSPHRASE`. Exit status 0 means decrypted and intact. Export files and uploaded audit archives are encrypted with the same key; since 0.16.0 the authenticated header of every file says what it is (`content`: `backup`, `export`, `audit-archives`), and `verify` **fails** for a file that is not a backup and names what it is – so an export file put in a backup's place never passes as an intact backup (the restore test refuses it too). `decrypt` still reads them. Backups made before 0.16.0 have no `content` and are read as backups.

Then, with Steward **stopped** and the **same or a newer version** of Steward:

A backup larger than 4 GB, or with more than 65,535 files, is a ZIP64 archive. `unzip` (Info-ZIP 6.0, as in current Linux distributions and macOS), 7-Zip, Windows Explorer and Python's `zipfile` read it. Backups within those limits are plain ZIP files, as before 0.11.0.

**SQLite**

```bash
unzip restore.zip -d restore
cp -a restore/data/. /data/                          # the data folder (vault.json, artifacts, …)
cp restore/database/steward.db /data/service-manager.db
rm -f /data/service-manager.db-wal /data/service-manager.db-shm
chmod 600 /data/service-manager.db /data/vault.json  # chown 1000:1000 in the container
```

**PostgreSQL**

```bash
unzip restore.zip -d restore
cp -a restore/data/. /data/
pg_restore --clean --if-exists --no-owner -d "postgres://steward@db:5432/steward" restore/database/steward.pgdump
```

A backup that left parts out ([Contents](#contents)) restores without them: copy those folders back from where you keep them, or accept what the table above says is missing.

Start Steward and unlock the vault with the **master passphrase**. Verify the audit log (_Audit log → Verify_). If the installation moved, also set up single sign-on redirect URLs and the public URL again.

## Limits and notes

- From 0.11.0 a backup archive has no 4 GB or 65,000-file limit (ZIP64 where needed). It holds up to 2 million files; S3 takes up to 10,000 parts per upload, so the parts get larger than `SM_BACKUP_PART_BYTES` for a very large backup (5 TB per object at most). Large files of runs still belong in their retention settings, not in years of backups.
- The SQLite snapshot is made on a connection of its own in a worker thread: requests and health probes go on meanwhile. Writes made during the snapshot are in the next backup.
- Prometheus can watch the backups: `sm_backup_last_success_timestamp_seconds` and the other `sm_backup_*` metrics, with a "no backup for 26 hours" rule in [`examples/prometheus/steward-alerts.yml`](../examples/prometheus/steward-alerts.yml) ([METRICS.md](METRICS.md)).
- The container image has `pg_dump`/`pg_restore` of PostgreSQL 17 (Debian trixie); they back up servers up to version 17. For a newer server, point `SM_PG_DUMP` and `SM_PG_RESTORE` at matching programs. The password of `SM_DATABASE_URL` goes to `pg_dump` in `PGPASSWORD`, never on its command line.
- `pg_restore` of PostgreSQL 17 or newer starts with `SET transaction_timeout = 0`, which PostgreSQL 16 and older do not know: restoring into such a server reports `unrecognized configuration parameter "transaction_timeout"` and restores everything else. The restore test accepts this one error and fails on any other; by hand, restore without `--exit-on-error`.
- During a backup the work folder `<data folder>/.backup-work` (0700) briefly holds the snapshot and the encrypted file; it is emptied after every run and at start.
- One backup or restore test runs at a time. A backup in progress when Steward stops is marked _Interrupted_ at the next start.
- Whoever may change the storage platform (its managers) can point backups at another bucket. The copies stay encrypted, but give that platform only administrators as managers.
- Backups are per installation: a migration package (_Settings → Migration_) does not carry backup settings, the passphrase or the history.
- Readable copies of chosen data for people outside Steward – cost plans, the plant registry, the catalogue – are [exports](EXPORTS.md), not backups: they go to S3 on a schedule of their own and cannot restore Steward.
