# Backups to S3

Steward can back itself up: on a schedule it makes a consistent copy of its **database** and its **data folder**, encrypts the copy with a **backup passphrase** and uploads it to an **S3 bucket**. A retention rule removes older copies, and once a week the newest copy is downloaded, decrypted and checked completely. Administrators are notified when a backup or a restore test fails (event _Backup failed_).

Set it up under _Settings → Backups_ (administrators; changes ask for your password again).

## What is in a backup

| Part        | SQLite                                                                          | PostgreSQL                                                                |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Database    | a consistent snapshot (`VACUUM INTO`, while Steward runs)                       | `pg_dump --format=custom` of Steward's schema (restore with `pg_restore`) |
| Data folder | `vault.json`, `artifacts/`, `docs/`, `reports/`, `audit-anchor.json`, …         | the same                                                                  |
| Manifest    | `manifest.json`: every file with its size and SHA-256, the last audit log entry | the same                                                                  |

Not included: the live database files (the snapshot stands for them), the automatic copies made before upgrades (`backups/`) and the work folder of backups.

**The master passphrase is never in a backup.** The credentials in the database are encrypted with the vault's key, which `vault.json` holds encrypted with the master passphrase. To restore you need the backup, the **backup passphrase** and the **master passphrase**. Keep both passphrases offline, apart from each other and from the bucket.

## Encryption

The backup is a ZIP archive, encrypted with AES-256-GCM in 4 MB chunks with a key derived from the backup passphrase (scrypt, N=2¹⁷). Each chunk is authenticated together with the file header, its position and whether it is the last one: a changed byte, re-ordered or missing chunks and a file cut short are all detected. Steward keeps the derived key encrypted in its vault so scheduled backups need no one; the passphrase itself is not stored anywhere.

After you change the backup passphrase, new backups use the new key. Older backups stay readable with the passphrase they were made with – keep it until the retention rule has removed them. The header of every file names its key (`npm run backup -- info <file>`).

## Setting it up

### 1. The bucket

Any S3 bucket or S3-compatible storage (MinIO, Ceph, Wasabi, Hetzner Object Storage, Cloudflare R2 …). Recommended:

- **Versioning** and **S3 Object Lock** (governance or compliance mode, default retention of e.g. 35 days): even someone with Steward's key cannot delete or overwrite a recent backup. Steward reports backups that Object Lock keeps instead of failing.
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
4. The database: SQLite – `PRAGMA integrity_check` on the snapshot and the **audit chain of the snapshot** (every entry, against the installation's audit key, ending at the entry the manifest names). PostgreSQL – `pg_restore --list` reads the dump.

A failed step fails the test, and the administrators get the _Backup failed_ notification (in-app and e-mail by default; change the channels under _Settings → Notifications_).

## Restoring

Decrypt and check a backup on any machine with Node.js and the Steward sources (or the container image, or the desktop app):

```bash
npm run backup -- verify steward-20261030T021500Z.smbackup              # asks for the backup passphrase
npm run backup -- decrypt steward-20261030T021500Z.smbackup --out restore.zip
# container: docker run --rm -it -v "$PWD:/work" ghcr.io/vxrz/steward:<version> node --import tsx server/src/cli/backup.ts decrypt /work/<file> --out /work/restore.zip
# desktop:   steward backup decrypt <file> --out restore.zip
```

The passphrase can also come from `--passphrase-file <file>` or `SM_BACKUP_PASSPHRASE`. Exit status 0 means decrypted and intact.

Then, with Steward **stopped** and the **same or a newer version** of Steward:

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

Start Steward and unlock the vault with the **master passphrase**. Verify the audit log (_Audit log → Verify_). If the installation moved, also set up single sign-on redirect URLs and the public URL again.

## Limits and notes

- A backup archive must stay below 4 GB (ZIP without ZIP64). Large files of runs belong in their retention settings, not in years of backups.
- The container image has `pg_dump`/`pg_restore` of PostgreSQL 17 (Debian trixie); they back up servers up to version 17. For a newer server, point `SM_PG_DUMP` and `SM_PG_RESTORE` at matching programs. The password of `SM_DATABASE_URL` goes to `pg_dump` in `PGPASSWORD`, never on its command line.
- During a backup the work folder `<data folder>/.backup-work` (0700) briefly holds the snapshot and the encrypted file; it is emptied after every run and at start.
- One backup or restore test runs at a time. A backup in progress when Steward stops is marked _Interrupted_ at the next start.
- Backups are per installation: a migration package (_Settings → Migration_) does not carry backup settings, the passphrase or the history.
