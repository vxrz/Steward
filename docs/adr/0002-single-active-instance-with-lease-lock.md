# 0002. One active instance, held by a lease lock

- **Status:** Accepted
- **Date:** 2026-11-03
- **Since:** 0.4.0 (before: a PostgreSQL session advisory lock only)

## Context

The scheduler, monitors, notification jobs, audit checkpoints and backups run inside the server process. Two processes on the same database would start every scheduled run twice, send every notification twice and race on the audit chain, whose entries must be appended in one order. Until 0.3 the PG bridge took a PostgreSQL session advisory lock per schema at start-up ([0001](0001-synchronous-db-layer-with-pg-bridge.md)); SQLite relied on one process per data folder. An advisory lock lives as long as its connection: a connection that is half-open after a network failure, or a lock held through a connection pooler, can block a restarted instance or – worse – not protect at all.

## Decision

One instance is **active** at a time, and it proves it with a **lease** stored in the database: a lease row naming the holder and an expiry (a time to live). The active instance renews the lease well before it expires; an instance that finds a valid lease held by someone else does not run the jobs (and does not start as the active instance); a lease that was not renewed in time expires and can be taken over. Taking and renewing the lease are single conditional writes, so two instances can never both hold it. On PostgreSQL the session advisory lock stays as an additional guard.

The lease is implemented with the start-up and shutdown code (`server/src/main.ts`, `server/src/scheduler.ts`, `server/src/database/pg-bridge.ts`); see the 0.4.0 entry in the [CHANGELOG](../../CHANGELOG.md) for its table and settings.

## Consequences

- Scheduled work runs exactly once even when an old process lingers, a container is restarted next to the old one, or a network partition leaves a connection open.
- After a crash the next instance waits at most one lease period before it takes over; a clean shutdown releases the lease at once.
- There is still no horizontal scaling of one installation: a second process is a standby, not extra capacity. High availability is "restart quickly", not "run two".
- Clocks matter: the expiry has to be judged by one clock (the database's), so instances with skewed host clocks cannot take over early.

## Update 0.10.1: SQLite gets an instance lock

Until 0.10.0 the lease above existed on PostgreSQL only; the text did not say so. On SQLite nothing stopped a second process on the same data folder. On one machine the port usually did (`address in use`), but containers each have their own network: a Kubernetes rolling update, a second `docker run` on the same volume or a blue/green switch started two active instances. Both ran every schedule and raced on the audit chain.

**Decision.** On SQLite the active instance holds an **instance lock** before it opens the database: an exclusive lock on a small, separate SQLite file next to the database, `<database file>.lock` (by default `service-manager.db.lock` in the data folder). The holder keeps that file open in `BEGIN EXCLUSIVE`. The lock is the operating system's file lock, the same one SQLite uses for its own files (`fcntl` on Linux and macOS, `LockFileEx` on Windows).

- **Why not a lease row, as on PostgreSQL.** The lease needs a renewal, an expiry and a takeover after a crash. A file lock needs none of these: the operating system ends it with the process. A crash or `kill -9` leaves no stale lock, and the next instance starts at once. It also holds across containers that share the volume on one machine.
- **Why a separate file.** The app's own connection reads and writes the database in WAL mode, and a waiting instance must not open, let alone migrate, a database that another instance uses.
- **Same behaviour as on PostgreSQL.** A second instance does not exit. It waits, logs `waiting for the database lock` once a minute with the holder (process, host, version, from `<database file>.lock.json`, which is informative only), answers `/api/health` with 200 and `/api/ready` and `/api/ready/traffic` with 503, and takes over within two seconds when the first one stops or dies. If the lock file is deleted while Steward runs, Steward takes the lock on the new file again; if another process was faster, it stops with exit code 70, as after a lost lease.
- **Command-line tools.** `admin` (outside of emergency access through the running server), `migrate` and `db:copy` with a SQLite database hold the lock while they work. They refuse to run while Steward (or another tool) holds it, also when Steward runs in another container on the same volume, and a Steward started meanwhile waits for them. The desktop launcher opens the running Steward when its data folder is already in use, instead of starting a second instance that would wait.
- **Limits.** File locks are not reliable on network file systems (NFS, SMB, many `ReadWriteMany` volumes). SQLite's own locking has the same limit, so SQLite does not belong on them anyway; the installation guide says so. Two machines that mount the same volume over the network are not protected.

The PostgreSQL lease is implemented in `server/src/database/lease.ts` and taken in `server/src/main.ts`; the SQLite lock is in `server/src/database/sqlite-lock.ts`.
