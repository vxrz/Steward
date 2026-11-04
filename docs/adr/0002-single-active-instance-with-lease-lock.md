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
