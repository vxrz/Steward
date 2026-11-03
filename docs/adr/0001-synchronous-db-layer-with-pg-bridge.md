# 0001. Synchronous database layer, PostgreSQL through a bridge

- **Status:** Accepted
- **Date:** 2026-10-26
- **Since:** 0.2.0 (PostgreSQL support); the synchronous API since 0.1.0

## Context

Steward started on SQLite (`node:sqlite`), whose API is synchronous: `db().get()`, `db().all()`, `db().run()` and `db().tx(fn)` return results directly, and a transaction is a plain function. Hundreds of call sites – the engine, the services, the audit log – rely on that: a transaction cannot be interleaved with another request, and code reads like straight-line logic. Shared installations asked for PostgreSQL. Its Node.js driver (`pg`) is asynchronous only; turning every call site async would have touched nearly all server code and lost the "a transaction is one synchronous function" guarantee.

## Decision

Keep one synchronous database API for both databases (`server/src/db.ts`, `server/src/database/`). PostgreSQL is reached through the **PG bridge** (`database/pg-bridge.ts`): a worker thread owns one `pg.Client`; the calling thread posts a request and blocks with `Atomics.wait` until the worker answers, then reads the reply with `receiveMessageOnPort`. SQL is written once for both (`?` placeholders, portable functions, `db().jsonText()`), migrations are named and additive, PostgreSQL DDL is translated from the SQLite DDL unless a migration gives its own (`database/sql.ts`). `server/test/db.test.ts` scans for SQLite-only SQL and the whole suite also runs on PostgreSQL (`npm run test:pg`).

## Consequences

- Call sites stay unchanged and transactions stay atomic within the process; the same tests cover both databases.
- Every statement on PostgreSQL costs a thread hop, and statements run one after another on one connection – throughput is that of one connection, which fits one team server, not a large multi-tenant service.
- A slow database blocks the event loop. Statement and wait time-outs (`timeoutMs`, a server-side `statement_timeout`) turn a hang into an error (`SM_DB_TIMEOUT`); a transaction that timed out is rolled back and the connection is poisoned until then.
- Only one process may use a database at a time ([0002](0002-single-active-instance-with-lease-lock.md)); scaling out means several instances with their own databases, not several processes on one.
- Revisit if Steward needs several processes per database or many concurrent long statements: then an async data layer (or a separate worker process) is the next step.
