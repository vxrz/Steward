# Database platforms

Steward connects to databases directly – PostgreSQL, MariaDB and MySQL, Microsoft SQL Server – for access reviews, account hygiene, monitor checks and datasets, with the same evidence and safety rules as the HTTP platforms. Everything it sends is **read-only**. It also keeps the [schema](#database-schemas) of each database – snapshots, their breaking changes, DBML and DDL exports, tbls imports from CI. The design and its limits are recorded in [ADR 0008](adr/0008-database-platforms.md).

| DBMS                 | Versions                                                           | Driver (pure JavaScript, no client install) | Read-only by                                                       |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------ |
| PostgreSQL           | 12 and later (also RDS / Aurora, Azure, Cloud SQL)                 | `pg`                                        | read-only session and `BEGIN TRANSACTION READ ONLY`, cursor        |
| MariaDB / MySQL      | MariaDB 10.6 and later, MySQL 8.0.22 and later (also RDS / Aurora) | `mysql2`                                    | `SET SESSION TRANSACTION READ ONLY`, `START TRANSACTION READ ONLY` |
| Microsoft SQL Server | 2016 and later (also Azure SQL Managed Instance, RDS)              | `tedious`                                   | a read-only login, and a transaction that is always rolled back    |

Oracle (`oracledb` in thin mode), Entra ID sign-in for SQL Server and IAM tokens for RDS come later.

## Set up a database platform

1. **Create a read-only account** in the database – the exact statements are [below](#a-read-only-account-per-dbms). Do not use an administrator or an application account.
2. _Platforms → Add platform → Databases_: choose the DBMS, enter a name, the **host** (name or IP address, without scheme or port), the **database** and the **TLS mode**, and the credentials **username** and **password** of the read-only account. The wizard creates the platform and tests the connection.
3. Under _Platform → Database_ the platform's managers change the connection later: port, TLS (CA certificate, the server name in the certificate), the **limits** and the number of connections. The connection is part of the platform's sealed connection settings; every change is audited (`platform.database_changed`) and closes the platform's open connections.

| Setting        | Default                | Meaning                                                                                                                         |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| TLS mode       | `verify`               | `verify`: encrypted, certificate and host name checked (add a private CA); `require`: encrypted without checks; `off`: plain    |
| Time limit     | 30 s (at most 300 s)   | Per statement, on the server (`statement_timeout`, `MAX_EXECUTION_TIME` / `max_statement_time`, request timeout) and in Steward |
| Most rows      | 1,000 (at most 50,000) | More rows fail the step, or are cut with `onLimit: truncate`                                                                    |
| Largest result | 5 MB (at most 50 MB)   | The rows as JSON                                                                                                                |
| Connections    | 2 (at most 5)          | A small pool per platform; idle connections close after 60 s                                                                    |

The platform's limits are **ceilings**: a step can lower them, never raise them.

**The connection test** signs in with a new connection and reports: the server version, whether the session is read-only, **whether the account can write** (a writing account is shown as a finding – use a read-only one), and which catalog queries the account may read (with what is missing). It is audited like every connection test (`platform.tested`); the periodic test of the platform page works the same way.

**Outbound policy.** A database connection is a host:port connection (like Kafka and MQTT): with the policy _platforms_ (the default) the platform's own host and port are allowed; with _allow-list_ the host (or its IP or CIDR) must be on the allow-list (_Settings → Outbound access_). Cloud-metadata and link-local addresses are never reachable, and the checked address is the one connected to. **Steward's own database** (`SM_DATABASE_URL` on PostgreSQL) is refused under every policy (`DB_OWN_DATABASE`): the same database name on the same host and port, compared by address – any loopback or local address counts as this machine when Steward's database runs on it. Other databases on that server are allowed (PostgreSQL has no queries across databases, and `dblink` is refused); give their read-only role no `CONNECT` right on Steward's database (`REVOKE CONNECT ON DATABASE steward FROM PUBLIC`).

## The step "Query a database"

A process step that runs **one read-only statement** on the database platform of a connection slot (`kind: database`):

- **Catalog query** (`catalog:`) – Steward's own statement for the platform's DBMS, with the same columns everywhere, so one template serves every DBMS:

  | Catalog        | Columns                                                                                                                                         |
  | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | `status`       | product, version, database, currentUser, readOnly, serverTime, canWrite                                                                         |
  | `accounts`     | name, host, canLogin, superuser, admin, locked, expiresAt, passwordChangedAt, passwordExpired, defaultAccount, authentication, roles, `disable` |
  | `role-members` | scope (server / database), role, member, memberType, adminOption, grantor, `revoke`                                                             |
  | `privileges`   | grantee, privilege, objectType, schema, object, grantable, grantor, `revoke`                                                                    |
  | `replication`  | role (primary / standby / replica), name, state, lagSeconds                                                                                     |
  | `tables`       | schema, name, type, rows (estimate), bytes                                                                                                      |

  `revoke` and `disable` are the statements that undo a grant or lock an account, **quoted for the DBMS** (`REVOKE "role" FROM "user";`, ``REVOKE `role`@`%` FROM `user`@`host`;``, `ALTER ROLE [db_datawriter] DROP MEMBER [user];`). Steward never runs them: a manual step shows them to a person.

- **Own SQL** (`sql:`) – one `SELECT` or `WITH … SELECT`, with **parameters** (`params:`, templates) bound with the DBMS's own placeholders: `$1, $2` (PostgreSQL), `?` (MariaDB/MySQL), `@p1, @p2` (SQL Server). Values never go into the text. `dialect:` names the DBMS the statement is written for; the step then refuses a platform of another.

```yaml
- id: connections
  type: query
  connection: db
  dialect: postgresql
  sql: SELECT datname, count(*) AS connections FROM pg_stat_activity WHERE backend_type = $1 GROUP BY datname
  params: ['client backend']
  maxRows: 100 # lower than the platform's limit
  onLimit: fail # or truncate
  saveAs: connections
```

The result is `{ columns, rows, rowCount, truncated, durationMs }` – stored like an HTTP answer, so later steps, run reports, evidence packs and the editor's _Last run_ panel (a table of the first rows) see it. The step's input records the platform, the DBMS and server version, the statement as sent (for a catalog query its SQL) and the parameters (secret values masked). The platform's user name and password are credentials: they are masked wherever they would appear, also in result rows (Steward's own account then reads `***`).

- **Dry runs** run the query – it only reads.
- **Test runs** never connect: the platform's recorded response `POST /sql/<step id>` answers (a list of rows, or `{ "rows": [...] }`; _Platform → Recorded responses_).

### What Steward refuses

Three layers, none trusted alone:

1. **The account** is read-only ([below](#a-read-only-account-per-dbms)).
2. **The session**: PostgreSQL and MariaDB/MySQL run every statement in a read-only transaction, so even a function or view that writes is refused by the server (`DB_READ_ONLY_VIOLATION`); PostgreSQL reads through a cursor (`DECLARE … NO SCROLL CURSOR FOR`), which accepts queries only. Every transaction is rolled back. Some effects outlive a rollback – a PostgreSQL session-level advisory lock taken inside a function the check cannot see, for example – so Steward runs its own `SELECT pg_advisory_unlock_all()` after every statement and does not pool a connection whose reset failed; nothing else of the session can be changed by a statement the check accepts. A MariaDB/MySQL statement that Steward's own time limit or a cancel stops is ended on the server with `KILL QUERY` over a second, short-lived connection (same account, same outbound rules) before the connection is dropped – closing the socket alone would leave the server running it. **SQL Server has no read-only transaction**: a statement that writes would run and then be rolled back – there the read-only login is the protection that counts.
3. **The statement check** (in the editor and on the server, the same code), conservative and without a parser – a **best-effort extra layer**: its lists of words and functions cannot be complete, the read-only account is the real protection. It refuses:
   - anything but one `SELECT` / `WITH … SELECT`, and a `;` before the end;
   - the words that start or change something (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `DROP`, `ALTER`, `GRANT`, `EXEC`, `CALL`, `DO`, `SET`, `INTO`, `LOCK`, `COPY`, `OPENROWSET`, `OPENQUERY`, `WAITFOR` …), and `NEXT VALUE FOR` (a sequence moves on even when the transaction is rolled back);
   - **SQL Server**: T-SQL needs no semicolon between statements, so these words are refused anywhere outside literals and quoted names, together with the words that start control flow, messages, Service Broker or cursor statements (`IF`, `WHILE`, `RETURN`, `GOTO`, `THROW`, `RAISERROR`, `PRINT`, `ENABLE`, `DISABLE`, `RECEIVE`, `SEND`, `OPEN`, `CLOSE` …), and a second `SELECT` outside parentheses unless `UNION`, `EXCEPT` or `INTERSECT` joins it (or it is the query of a `WITH … AS (…)`);
   - row locks: `FOR SHARE`, `FOR KEY SHARE`, `FOR NO KEY UPDATE` (with `NOWAIT` / `SKIP LOCKED` too; `FOR UPDATE` and `LOCK IN SHARE MODE` contain refused words) and the SQL Server lock hints `UPDLOCK`, `XLOCK`, `HOLDLOCK`, `TABLOCK`, `TABLOCKX`;
   - functions with effects outside the transaction (`pg_terminate_backend`, `pg_advisory_lock`, `set_config`, `lo_export`, `dblink…`, `GET_LOCK`, `LOAD_FILE`, `xp_…`, `sp_…`) and functions that run SQL given as text, which the check cannot look into (`query_to_xml` and the other `…_to_xml` / `…_to_xmlschema` functions, `ts_stat`, `crosstab…`) – also when the name is quoted (`"name"`, `[name]`, `` `name` ``), compared without regard to case;
   - MariaDB/MySQL executable comments `/*! … */`, optimizer hints `/*+ … */` (they can lift the time limit) and `--` without a space; PostgreSQL `UESCAPE`;
   - backslashes in literals (their meaning depends on server settings – pass such values as parameters); unterminated literals or comments; placeholders that do not match the parameters.

   The editor shows the reason at once, in the UI language; the server answers `DB_STATEMENT_REFUSED` with the same reason.

The credentials of the run's **other** platforms are refused in a statement or its parameters, as for an API call to a foreign origin.

Its limits, honestly: it refuses some harmless statements (a column named `update`, `open` or `print` has to be quoted: `"update"`, `` `update` ``, `[update]`), and it cannot see what a view or a function called by the statement does. Results with more than one result set are refused by the driver.

## Templates, dashboard and monitor

The bundle **Databases** (_Processes → Templates → Bundles_) sets these up together for one database platform:

| Template                                                                                      | What it does                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Database – Access review](../examples/processes/66-database-access-review.yaml) (quarterly)  | Every role membership and object privilege (catalog queries), accounts that cannot sign in marked; the owner ticks what stays, a second person confirms (four-eyes), a manual step shows the generated `REVOKE` statements and a second person verifies; removals are documented as access changes; dataset `database.access`. |
| [Database – Account hygiene](../examples/processes/67-database-account-hygiene.yaml) (daily)  | Superusers and administrators, default accounts that can sign in (`postgres`, `root`, `sa` …), locked and expired accounts, password age, accounts that expire soon; checks and dataset `database.accounts` with the statement to lock each account.                                                                           |
| [Database – Table sizes](../examples/processes/68-database-table-sizes.yaml) (daily)          | Tables and views with estimated rows and size; dataset `database.tables` with its history.                                                                                                                                                                                                                                     |
| [PostgreSQL – Connections per database](../examples/processes/69-postgresql-connections.yaml) | An example of own SQL with a bound parameter; dataset `database.connections`.                                                                                                                                                                                                                                                  |

The dashboard [Databases](../examples/dashboards/88-databases.yaml) shows the four datasets. The monitor check type **Database** ([example](../examples/monitors/60-database.yaml), [MONITORS.md](MONITORS.md)) has three modes:

- `connection` – connects and signs in; _degraded_ when the account can write;
- `replication` – the largest replication lag in seconds (replicas of a primary, or this standby), against `warn` and `crit`; `noData` when there is no replication;
- `query` – the first column of the first row of a read-only statement (the same check and limits as the step), against `warn` and `crit` (`direction: above | below`).

Test runs of monitors use the recorded response `POST /sql/<check id>`.

## Database schemas

Steward keeps the **structure** of the databases it cares about – schemas, tables and views, columns with type, NULL, default and comment, primary and foreign keys, unique keys and indexes – as **snapshots**, shows **what changed** between them and which changes are **breaking**, and hands the schema to other tools as **DBML**, **SQL DDL** or **JSON** (#222). Two sources, one model:

- **Steward reads a database platform** (_Platform → Schema → Read now_, a scheduled read, or the monitor check): its own catalog statements (`server/src/dbms/schema-catalog.ts`, next to the catalog queries), one after the other on a pooled connection, in the same read-only transaction as every statement ([What Steward refuses](#what-steward-refuses)), within the platform's time limit per statement and 180 s for the whole read. The platform's row and size limits (_Platform → Database → Limits_, when set) are ceilings for each of these statements too, as for every statement ([ADR 0008](adr/0008-database-platforms.md)): a read cut by them, or by the limits below, is kept as a _truncated_ snapshot. PostgreSQL reads `pg_catalog` (every schema but the system ones, partitions folded into their table), MariaDB/MySQL `information_schema` of the connection's database (one view per statement), SQL Server `sys.*` of the database (descriptions are the `MS_Description` extended properties). The read-only account of [below](#a-read-only-account-per-dbms) sees what it needs; on SQL Server `VIEW ANY DEFINITION` makes the metadata visible.
- **A tbls import**: [tbls](https://github.com/k1LoW/tbls) (MIT) documents a database and writes it as JSON (`tbls out -t json`). Steward does not bundle tbls: it runs where the database is – a CI job, a job inside a separated network – and its `schema.json` is uploaded (_Import tbls_) or pushed from CI with a push token ([below](#tbls-from-ci)). This also works for a database that only has a **system** in Steward (_Systems → system → Database schema_), with no platform and no connection. The file is checked against the tbls JSON format ([`spec/tbls.schema.json_schema.json`](https://github.com/k1LoW/tbls/tree/main/spec) of tbls: the required fields and their types; viewpoints, functions and labels are ignored), and the import is audited with the file's **SHA-256** (`dbschema.imported`). The output of **`tbls lint`**, when it is sent along, becomes **checks** named by their rule (`requireColumnComment`, `columnCount`, `requireForeignKeyIndex` … – tbls prints no rule names, Steward recognises its messages; unknown ones are `tbls-lint`).

| Limit                           | Value                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| Tables and views                | 2,000 (a read keeps the first and marks the snapshot _truncated_; an import is refused) |
| Columns (all tables), per table | 50,000, 1,000                                                                           |
| Indexes, foreign keys per table | 200 each                                                                                |
| tbls file, lint output          | 10 MB, 1 MB                                                                             |
| Snapshots kept                  | 30 by default, 1–500 (_Schema → Settings_)                                              |

**Snapshots.** Every read and every import that finds a schema other than the newest snapshot stores a new one (who, when, from where: the web app, the API, the scheduled read or a monitor); an identical one only moves the newest snapshot's _checked_ time. The newest N snapshots are kept (_retention_), with two exceptions so that an import cannot erase the history: a tbls import or push removes only imported snapshots, never Steward's own reads (those go with the next read or a lower retention); and a snapshot that recorded a breaking change (or any change, for a check in mode `changed`) stays while a `db-schema` monitor check on the database still counts it – up to twice the retention. _Schema → Settings_ (the platform's managers, or who may change the system) also sets a **scheduled read** every N hours (0: off; the job `db-schemas` asks every 5 minutes and reads at most 10 platforms at a time). Snapshots of a deleted platform or system are removed by that job.

### Changes between snapshots

Each snapshot is compared with the one before it (or, on the page, with any other): tables, columns (type, NULL, default), primary keys, foreign keys, unique keys and indexes added, removed or changed. A change is **breaking** when something that worked before can fail afterwards:

| Breaking                                                                                    | Not breaking                                                                                    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| a table or column removed                                                                   | a table, column, key or index added                                                             |
| a **narrower** type (shorter text, smaller integer, less precision or scale, Unicode → not) | a wider type (`varchar(40)` → `varchar(80)`, `integer` → `bigint`, `real` → `double precision`) |
| another kind of type (`integer` → `text`, `jsonb` → `json`)                                 | NOT NULL → NULL, another default                                                                |
| NOT NULL added without a default, or a new NOT NULL column without one                      | NOT NULL added **with** a default                                                               |
| a primary, unique or foreign key removed or changed                                         | a plain index removed                                                                           |

Spellings that mean the same type are the same (`int4` = `integer`, `character varying(120)` = `varchar(120)`, MySQL display widths). When a snapshot is truncated, removals cannot be told from what was left out: they are not listed and the comparison says so. The Schema tab shows the changes with the reason of each breaking one, copies them as Markdown and starts a **change request** with them (a change record linked to the platform or system); the monitor check below watches them.

**Monitor check _Database schema changes_** (`type: db-schema`, [MONITORS.md](MONITORS.md)): a database platform (`platform`) or a system (`system`); `mode: breaking` (default, down) fails on a breaking change within `withinHours` (default 24), `mode: changed` (degraded) on any change; `read: true` reads the platform first (only a changed schema adds a snapshot); without a snapshot the check is `noData` (unknown). Whoever saves the check or tries it with _Check now_ must see the platform or system it names (one they may not see answers like a missing one); _Check now_ with `read: true` needs their own _use_ right on the platform, not only the monitor owner's.

```yaml
- id: shop-schema
  name: No breaking schema change
  type: db-schema
  platform: Shop database
  mode: breaking
  withinHours: 24
  read: true
```

### Export and other tools

_Export_ (and `GET …/schema/snapshots/{snapshotId}/export?format=` in the API) writes the snapshot as

- **DBML** ([dbml.dbdiagram.io](https://dbml.dbdiagram.io/docs)) – tables with their columns, `pk`, `not null`, `unique`, defaults and notes, indexes, and `Ref`s for the foreign keys; views become tables with the note `view`. Written by Steward itself, no library;
- **SQL DDL** in the dialect of the source (`CREATE TABLE`, constraints, indexes, comments, then the foreign keys as `ALTER TABLE`); databases Steward does not speak (a tbls import of BigQuery, Snowflake …) get standard SQL. Views appear as a comment: a snapshot keeps their columns, not their definition;
- **JSON**: Steward's schema model (`"format": "steward-db-schema"`).

Steward runs none of it – but the DDL is meant to be run elsewhere, and what it holds comes from the database or a tbls file, written by anyone who may create a table there or holds a push token. So nothing of a snapshot can end a statement or a comment in it:

- names are quoted for the dialect (PostgreSQL and standard SQL `"…"` with `""`, MariaDB/MySQL `` `…` `` with doubled backticks, SQL Server `[…]` with `]]`); tabs and line breaks in a name (a quoted identifier may hold them) are kept as their control pictures `␉ ␊ ␍` – in the snapshot, on the page and in every export – so a name is always one line and still shows what it held;
- texts (comments) are string literals of the dialect on one line; MariaDB/MySQL also escape `\`, PostgreSQL writes a text with a `\` as `E'…'` (safe whatever `standard_conforming_strings` says);
- every comment line (`--`, DBML's `//`) is one line;
- a data type or a default is written only when it is a plain type name (`varchar(120)`, `timestamp(3) with time zone`, `enum('a','b')`, `integer[]` …) or a plain expression (quotes and brackets balanced; no `;`, comment, `$` or `\`); otherwise the file says so in a comment above the table and leaves the column or the default out;
- an index without columns (an expression index) is written from its definition only for Steward's own read of PostgreSQL (`pg_get_indexdef`), never from a tbls file.

Read a DDL file before running it all the same, as any SQL from somewhere else. The DBML or SQL file opens in editors such as [dbdiagram.io](https://dbdiagram.io), [drawDB](https://github.com/drawdb-io/drawdb) or [ChartDB](https://github.com/chartdb/chartdb); [Azimutt](https://github.com/azimuttapp/azimutt) (self-hosted) suits exploring very large databases. Steward bundles no editor: drawDB and ChartDB are AGPL-3.0 applications of their own. Such a tool can be registered as an application in the service catalogue, with a link on the database platform.

### Rights

Whoever sees the database platform (any right) or the system sees its schema, snapshots and changes – a platform or system someone may not see answers like one that does not exist, in the web app and the API. Reading the database needs the platform's _use_ right; importing and the settings its _manage_ right, or the right to change the system. A system that is a database platform of Steward keeps its schema on the platform (`DB_SCHEMA_ON_PLATFORM`). Who may not see the database platform a system is sees that system like any other: nothing on its schema page or in the API tells that the platform exists or what kind it is. Audit log: `dbschema.read` (a person's read, or a scheduled or monitor read that found a change), `dbschema.imported` (with the SHA-256, the file name, `via`, the counts; for a push the token), `dbschema.settings_changed`, `dbschema.push_token_created`, `_rotated`, `_revoked`.

### tbls from CI

CI pushes with a **push token**, not with a personal API token: _Schema → Push from CI → New push token_ (the platform's _manage_ right, or the right to change the system). A push token belongs to exactly one database platform or system and can do nothing but push its `schema.json` (and the output of `tbls lint`); several per database, each with a name, an optional expiry, optional allowed addresses (IP or CIDR) and a limit of pushes per minute (default 10). Steward stores only its SHA-256 and shows the secret once – keep it as a CI secret (`STEWARD_PUSH_TOKEN`). The list shows when and from where each token was last used; _Rotate_ gives a new secret (the old one stops at once), _Revoke_ ends it. Like an API token with its owner, a push token **stops with its creator**: it works only while the person who created it is active and may still manage the database (the platform's _manage_ right, or the right to change the system) – otherwise the list marks it _Creator inactive – create a new token_ and its pushes get the same `401` as a wrong token. Creating, rotating and revoking are audited (`dbschema.push_token_created`, `_rotated`, `_revoked`), and every push as `dbschema.imported` with the token's id and name and the file's SHA-256.

The endpoint is `POST /api/hooks/db-schema/platform/{platformId}` (or `/api/hooks/db-schema/system/{systemId}`), like heartbeats and webhook triggers – the read-only API `/api/v1` does not write; _Import tbls_ and the token dialog show the exact URL. Send `Authorization: Bearer sdbp_…` and the `schema.json` as it is (`Content-Type: application/json`, at most 10 MB), or `{ "schema": "<the file as text>", "lint": "<tbls lint output>", "fileName": "schema.json" }`. The endpoint takes no API token and no sign-in session. The token is checked from the headers before the body is read: a request without a valid token is refused without Steward reading up to 10 MB first. A wrong, revoked or expired token, a token of another database, a token whose creator is inactive or may no longer manage the database and an address outside the allowed ranges all get the same `401`; more pushes than allowed `429` with `Retry-After`. The answer names the snapshot, whether it was new, and its changes.

The allowed addresses are checked against the address Steward sees. Behind a reverse proxy with `SM_TRUST_PROXY` ([CONFIGURATION.md](CONFIGURATION.md)) that is the address the proxy forwards (`X-Forwarded-For`), so the ranges are only as strong as that setting: trust only your own proxy (its address, or a hop count – then only a peer on loopback or a private network may forward), never any peer.

A plain shell job (any CI, a cron job next to the database):

```sh
#!/bin/sh
set -eu
# TBLS_DSN, e.g. postgres://tbls_reader:…@db.internal.example:5432/shop?sslmode=require
tbls out -t json -o schema.json "$TBLS_DSN"
tbls lint "$TBLS_DSN" > lint.txt || true   # findings make tbls exit 1
jq -n --rawfile schema schema.json --rawfile lint lint.txt '{schema: $schema, lint: $lint, fileName: "schema.json"}' |
  curl -sS -f -X POST "https://steward.example.com/api/hooks/db-schema/platform/$STEWARD_PLATFORM" \
    -H "Authorization: Bearer $STEWARD_PUSH_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary @- | jq '{created, snapshot: .snapshot.id, changes: .diff.total, breaking: .diff.breaking}'
```

GitHub Actions, after the migrations of a branch ran against a test database:

```yaml
name: database schema
on:
  push:
    branches: [main]
jobs:
  schema:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: k1low/setup-tbls@v1
      - name: Document and lint the schema
        env:
          TBLS_DSN: ${{ secrets.TBLS_DSN }}
        run: |
          tbls out -t json -o schema.json
          tbls lint > lint.txt || true
      - name: Push it to Steward
        env:
          STEWARD_PUSH_TOKEN: ${{ secrets.STEWARD_PUSH_TOKEN }}
        run: |
          jq -n --rawfile schema schema.json --rawfile lint lint.txt '{schema: $schema, lint: $lint, fileName: "schema.json"}' |
            curl -sS -f -X POST "https://steward.example.com/api/hooks/db-schema/system/${{ vars.STEWARD_SYSTEM }}" \
              -H "Authorization: Bearer $STEWARD_PUSH_TOKEN" -H 'Content-Type: application/json' --data-binary @-
```

Without the lint results, `curl … --data-binary @schema.json` sends the file itself. A schema that equals the newest snapshot adds none, so the job can run on every push. To fail a pipeline on a breaking change, check `.diff.breaking` in the answer.

## MCP gateway

Off by default, like for every platform. When a platform's managers turn it on (_Platform → MCP_), MCP clients get the tool `database_query`: one statement (`sql` with `params`) or a catalog query, through the same check, session and limits – at most 200 rows and 1 MB per answer, marked truncated. Every call and refusal is audited (`mcp.gateway_call`, `mcp.gateway_refused`). **Changing statements are not available**: the gateway of a database platform cannot be set to _confirm_ or _four-eyes_ (`MCP_WRITES_NOT_AVAILABLE`). See [MCP.md](MCP.md).

## A read-only account per DBMS

Replace `steward_reader`, the password, the host pattern and `shop` (the database). Grant `SELECT` on application tables only where own SQL needs them.

### PostgreSQL

```sql
CREATE ROLE steward_reader LOGIN PASSWORD 'choose-a-long-password' CONNECTION LIMIT 5;
ALTER ROLE steward_reader SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE shop TO steward_reader;
-- other sessions in pg_stat_activity, the lag columns of pg_stat_replication
GRANT pg_read_all_stats TO steward_reader;
-- only for own SQL on application tables (or pg_read_all_data on PostgreSQL 14 and later)
GRANT USAGE ON SCHEMA public TO steward_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO steward_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO steward_reader;
```

The catalog queries read `pg_roles`, `pg_auth_members`, `pg_class`, `pg_namespace` and `pg_database`, which every role may read. `rolpassword` (in `pg_authid`) is never read; PostgreSQL does not record when a password was set, so `passwordChangedAt` stays empty.

### MariaDB

```sql
CREATE USER 'steward_reader'@'10.0.%' IDENTIFIED BY 'choose-a-long-password' WITH MAX_USER_CONNECTIONS 5;
GRANT SELECT ON mysql.user TO 'steward_reader'@'10.0.%';
GRANT SELECT ON mysql.global_priv TO 'steward_reader'@'10.0.%';
GRANT SELECT ON mysql.roles_mapping TO 'steward_reader'@'10.0.%';
GRANT SELECT ON mysql.db TO 'steward_reader'@'10.0.%';
GRANT SELECT ON mysql.tables_priv TO 'steward_reader'@'10.0.%';
-- SHOW REPLICA STATUS (MariaDB 10.5.9 and later; before: REPLICATION CLIENT)
GRANT REPLICA MONITOR ON *.* TO 'steward_reader'@'10.0.%';
-- tables of the database (catalog query "tables" and own SQL)
GRANT SELECT ON shop.* TO 'steward_reader'@'10.0.%';
```

### MySQL

```sql
CREATE USER 'steward_reader'@'10.0.%' IDENTIFIED BY 'choose-a-long-password' WITH MAX_USER_CONNECTIONS 5;
GRANT SELECT ON mysql.user TO 'steward_reader'@'10.0.%';
GRANT SELECT ON mysql.role_edges TO 'steward_reader'@'10.0.%';
GRANT SELECT ON mysql.db TO 'steward_reader'@'10.0.%';
GRANT SELECT ON mysql.tables_priv TO 'steward_reader'@'10.0.%';
-- SHOW REPLICA STATUS
GRANT REPLICATION CLIENT ON *.* TO 'steward_reader'@'10.0.%';
GRANT SELECT ON shop.* TO 'steward_reader'@'10.0.%';
```

`SELECT` on `mysql.user` shows the password hashes (`authentication_string`) to the account; Steward never selects that column. Where that is not acceptable, leave the grant out: the catalog query `accounts` then fails with the missing privilege, the others keep working.

### Microsoft SQL Server

```sql
USE master;
CREATE LOGIN steward_reader WITH PASSWORD = 'choose-a-long-password', CHECK_POLICY = ON;
-- availability group lag (sys.dm_hadr_*); SQL Server 2022: VIEW SERVER PERFORMANCE STATE is enough
GRANT VIEW SERVER STATE TO steward_reader;
-- every login, server role and permission, LOGINPROPERTY; SQL Server 2022: VIEW ANY SECURITY DEFINITION is enough
GRANT VIEW ANY DEFINITION TO steward_reader;
USE shop;
CREATE USER steward_reader FOR LOGIN steward_reader;
-- only for own SQL on application tables
ALTER ROLE db_datareader ADD MEMBER steward_reader;
```

Give the login nothing else: no `db_datawriter`, `db_owner`, `db_ddladmin` or `sysadmin` – SQL Server has no read-only transaction, so this login is what keeps Steward from writing. The connection test reports such memberships as "the account can write".

## Errors

| Code                                                   | Meaning                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `DB_STATEMENT_REFUSED`                                 | The statement check refused the statement (the reason names the word or character)   |
| `DB_READ_ONLY_VIOLATION`                               | The server refused a write in the read-only transaction                              |
| `DB_PERMISSION_DENIED`                                 | The account may not read an object – grant the read-only role above                  |
| `DB_ROW_LIMIT`, `DB_SIZE_LIMIT`, `DB_TIMEOUT`          | A limit was reached                                                                  |
| `DB_AUTH_FAILED`, `DB_TLS_FAILED`, `DB_CONNECT_FAILED` | Sign-in, TLS or the connection failed (with the driver's message)                    |
| `DB_DIALECT_MISMATCH`                                  | The step is written for another DBMS                                                 |
| `DB_PARAM_INVALID`                                     | A parameter is not a text, number or boolean (lists only on PostgreSQL: `= ANY($1)`) |
| `DB_OWN_DATABASE`                                      | The platform names Steward's own database on its server                              |
| `DB_SCHEMA_TBLS_INVALID`, `DB_SCHEMA_TOO_LARGE`        | The file is not a tbls schema.json, or beyond the [limits](#database-schemas)        |
| `DB_SCHEMA_ON_PLATFORM`, `DB_SCHEMA_NO_READ`           | A system that is a database platform imports there; a system has nothing to read     |

## Demo

In demo mode the platform **Shop database (demo)** points at a simulated PostgreSQL (`postgres.demo.invalid`) that answers the catalog queries and the examples' statements with made-up rows; any other statement is refused. It never reads Steward's own database.

## Tests

PostgreSQL is tested against a real server whenever the suite has one (the schema read included) (`npm run test:pg`, or `SM_TEST_PG_ADMIN_URL`); MariaDB and SQL Server with `SM_TEST_MYSQL_URL` and `SM_TEST_MSSQL_URL` (`server/test/dbms-integration.test.ts`, the CI job `test-databases`). The dialect-specific parts – statement check, read-only wrapping, parameter binding, limits, catalog statements and their quoting, error mapping – are unit-tested without a server (`server/test/dbms-unit.test.ts`).
