# Steward on Kubernetes

A reviewed starting point: one pod with a persistent volume, the master passphrase as a Secret file, a Service and
an optional Ingress. Copy the folder, change the values marked below, and apply it:

```bash
kubectl create namespace steward
kubectl -n steward create secret generic steward-passphrase --from-file=passphrase=./passphrase.txt   # optional
kubectl -n steward apply -k .            # SQLite
kubectl -n steward apply -k postgres     # or PostgreSQL (create the steward-database Secret first)
```

| File                  | What it is                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `deployment.yaml`     | One replica, `strategy: Recreate`, non-root (uid 1000, `fsGroup: 1000`), read-only root, probes |
| `pvc.yaml`            | The data folder (`/data`), `ReadWriteOnce` block storage                                        |
| `service.yaml`        | `ClusterIP` on port 80                                                                          |
| `ingress.yaml`        | Optional: ingress-nginx with TLS for `steward.example.com`                                      |
| `secret.example.yaml` | The shape of the passphrase Secret (better: `kubectl create secret … --from-file`)              |
| `postgres/`           | Overlay: the database URL from a Secret file (`SM_DATABASE_URL_FILE`)                           |

Change before you apply:

- `image:` – the version you run (pin it; verify the signature: [SECURITY-HARDENING.md](../../docs/SECURITY-HARDENING.md#verifying-downloads)).
- `SM_ALLOWED_HOSTS`, `SM_PUBLIC_URL` and the Ingress host – your DNS name.
- `SM_TRUST_PROXY` – the addresses your Ingress controller connects from.
- `storage:` in `pvc.yaml`, and `resources:` (the `-browser` image needs about 2 GiB of memory).

Why it looks like this:

- **`replicas: 1` and `strategy: Recreate`.** Steward runs one instance per database. A second pod waits for the
  database lock (SQLite) or lease (PostgreSQL); with `RollingUpdate` the new pod never becomes ready and the rollout
  hangs. See [One instance per data folder](../../docs/INSTALL.md#one-instance-per-data-folder-sqlite).
- **`fsGroup: 1000`.** A new volume is owned by root; the image runs as uid 1000. Without it Steward cannot create
  its data folder and stops at start-up.
- **Block storage.** SQLite's locking is not reliable on network file systems (NFS, SMB, EFS, `ReadWriteMany`).
- **Probes.** `livenessProbe` on `/api/health`, `readinessProbe` on `/api/ready/traffic` – never `/api/ready`, which
  is `503` while the vault is locked, so nobody could reach the UI to unlock it. Alert on `/api/ready` or the
  `sm_ready` metric instead ([steward-alerts.yml](../prometheus/steward-alerts.yml)). The probes send
  `Host: localhost`, because Steward refuses host names that are not allowed. A `startupProbe` gives the first start
  after an update time to copy and migrate the database.
- **Secrets as files.** The master passphrase (`SM_MASTER_PASSPHRASE_FILE`) and, on PostgreSQL, the database URL
  (`SM_DATABASE_URL_FILE`) are mounted files, not environment variables, which show up in `kubectl describe`, crash
  dumps and `/proc`. The other secret settings have `_FILE` variants too ([CONFIGURATION.md](../../docs/CONFIGURATION.md)).
- **`enableServiceLinks: false`.** Kubernetes otherwise sets `<SERVICE>_PORT` variables for other Services; a Service
  named `sm` would set `SM_PORT`.

`server/test/kubernetes-example.test.ts` checks these points, so the example cannot drift from what Steward needs.
