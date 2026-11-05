# Database platforms

Steward connects to databases directly – PostgreSQL, MariaDB and MySQL, Microsoft SQL Server – for access reviews, account hygiene, monitor checks and datasets, with the same evidence and safety rules as the HTTP platforms. Everything it sends is **read-only**. The design and its limits are recorded in [ADR 0008](adr/0008-database-platforms.md).

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

**Outbound policy.** A database connection is a host:port connection (like Kafka and MQTT): with the policy _platforms_ (the default) the platform's own host and port are allowed; with _allow-list_ the host (or its IP or CIDR) must be on the allow-list (_Settings → Outbound access_). Cloud-metadata and link-local addresses are never reachable, and the checked address is the one connected to.

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
2. **The session**: PostgreSQL and MariaDB/MySQL run every statement in a read-only transaction, so even a function or view that writes is refused by the server (`DB_READ_ONLY_VIOLATION`); PostgreSQL reads through a cursor (`DECLARE … NO SCROLL CURSOR FOR`), which accepts queries only. Every transaction is rolled back. **SQL Server has no read-only transaction**: a statement that writes would run and then be rolled back – there the read-only login is the protection that counts.
3. **The statement check** (in the editor and on the server, the same code), conservative and without a parser. It refuses: anything but one `SELECT` / `WITH … SELECT`; a `;` before the end; the words that start or change something (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `DROP`, `ALTER`, `GRANT`, `EXEC`, `CALL`, `DO`, `SET`, `INTO`, `LOCK`, `COPY`, `OPENROWSET`, `OPENQUERY`, `WAITFOR` …) – T-SQL needs no semicolon between statements, so they are refused anywhere outside literals and quoted names; functions with effects outside the transaction (`pg_terminate_backend`, `pg_advisory_lock`, `set_config`, `lo_export`, `dblink…`, `GET_LOCK`, `LOAD_FILE`, `xp_…`, `sp_…`); MariaDB/MySQL executable comments `/*! … */` and `--` without a space; backslashes in literals (their meaning depends on server settings – pass such values as parameters); unterminated literals or comments; placeholders that do not match the parameters.

The credentials of the run's **other** platforms are refused in a statement or its parameters, as for an API call to a foreign origin.

Its limits, honestly: it refuses some harmless statements (a column named `update` has to be quoted: `"update"`, `` `update` ``, `[update]`), and it cannot see what a view or a function called by the statement does. Results with more than one result set are refused by the driver.

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

## Demo

In demo mode the platform **Shop database (demo)** points at a simulated PostgreSQL (`postgres.demo.invalid`) that answers the catalog queries and the examples' statements with made-up rows; any other statement is refused. It never reads Steward's own database.

## Tests

PostgreSQL is tested against a real server whenever the suite has one (`npm run test:pg`, or `SM_TEST_PG_ADMIN_URL`); MariaDB and SQL Server with `SM_TEST_MYSQL_URL` and `SM_TEST_MSSQL_URL` (`server/test/dbms-integration.test.ts`, the CI job `test-databases`). The dialect-specific parts – statement check, read-only wrapping, parameter binding, limits, catalog statements and their quoting, error mapping – are unit-tested without a server (`server/test/dbms-unit.test.ts`).
