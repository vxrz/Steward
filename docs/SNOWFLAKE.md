# Snowflake

Steward reads a Snowflake account through the **SQL API** with **key-pair authentication**: the **databases** of applications (tables, their size and last change, failing tasks, the credits of the warehouses used), **access reviews** (who has which roles, who reaches a database, schema or table, technical users marked) and a **monitor check** (freshness of a table, failing tasks, warehouse credits). Everything is read-only; every value goes into the statements as a bind parameter, never as text.

| What                      | From                                                        | Delay            |
| ------------------------- | ----------------------------------------------------------- | ---------------- |
| Tables, size, last change | `SNOWFLAKE.ACCOUNT_USAGE.TABLES`                            | up to 90 minutes |
| Failing tasks             | `ACCOUNT_USAGE.TASK_HISTORY`                                | up to 45 minutes |
| Credits per warehouse     | `ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY`, `QUERY_HISTORY` | up to 3 hours    |
| Users, roles, grants      | `ACCOUNT_USAGE.USERS`, `GRANTS_TO_USERS`, `GRANTS_TO_ROLES` | up to 2 hours    |
| Freshness of one table    | `<database>.INFORMATION_SCHEMA.TABLES` (monitor check)      | current          |

The ACCOUNT_USAGE views cover the whole account, also dropped objects and history; they lag a little behind. Only the freshness check reads the database's own INFORMATION_SCHEMA, which is current.

## Connect an account

1. A user and a role for Steward, with a key pair (no password):

   ```sql
   CREATE ROLE STEWARD_READ;
   GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE STEWARD_READ;   -- the ACCOUNT_USAGE views
   CREATE WAREHOUSE STEWARD_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE;
   GRANT USAGE ON WAREHOUSE STEWARD_WH TO ROLE STEWARD_READ;
   CREATE USER STEWARD_READER TYPE = SERVICE DEFAULT_ROLE = STEWARD_READ DEFAULT_WAREHOUSE = STEWARD_WH;
   GRANT ROLE STEWARD_READ TO USER STEWARD_READER;
   -- for the freshness check only: INFORMATION_SCHEMA lists the tables the role has a privilege on –
   -- REFERENCES shows the metadata, not the data
   GRANT USAGE ON DATABASE SHOP TO ROLE STEWARD_READ;
   GRANT USAGE ON SCHEMA SHOP.SALES TO ROLE STEWARD_READ;
   GRANT REFERENCES ON TABLE SHOP.SALES.ORDERS TO ROLE STEWARD_READ;
   ```

2. The key pair: `openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out steward_key.p8` and `openssl rsa -in steward_key.p8 -pubout`. Give the user the public key: `ALTER USER STEWARD_READER SET RSA_PUBLIC_KEY = 'MIIBIjANBgkqh…';`.

3. Under _Platforms_, a platform of type _Snowflake (SQL API, read-only)_:
   - **Base URL**: `https://<account identifier>.snowflakecomputing.com` (e.g. `https://myorg-myaccount.snowflakecomputing.com`).
   - **Variables**: `account` – the account identifier as Snowflake expects it in the JWT (`MYORG-MYACCOUNT`, or the account locator `XY12345`; upper case is applied), `user`, `role` and `warehouse`.
   - **Credentials**: `privateKey` (the PEM of `steward_key.p8`), `privateKeyPassphrase` if it is encrypted.
   - Sign-in is the _key-pair JWT_ with the Snowflake claims and the header `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT`, preset ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#key-pair-jwt)).

_Test connection_ shows account, user, role and warehouse, and whether the ACCOUNT_USAGE views can be read.

**`401 JWT token is invalid (390144)`** – Snowflake gives no reason; the test and access reviews add the usual ones. The variable `account` goes into the JWT's `iss` and `sub` (`<ACCOUNT>.<USER>[.SHA256:<fingerprint>]`) and must be the account identifier as Snowflake checks it there: the **account locator without region and cloud** (`XY12345`, not `xy12345.eu-central-1` or `xy12345.eu-central-1.aws` from the old host name) or **`ORGNAME-ACCOUNTNAME` with a hyphen** (not `orgname.accountname`) – not the host name. Then check that `user` is the user's login name and that `DESC USER` shows the `RSA_PUBLIC_KEY_FP` of the platform's key (`SHA256:…`).

The queries are small, but they run on the warehouse: an XSMALL warehouse with `AUTO_SUSPEND = 60` costs a few credits a month for Steward's reads.

## Databases of an application

An application component of type **Snowflake database** names the platform, with the database as its name (`SHOP`). Every 6 hours or on _Read now_ Steward shows:

- the number of tables and views and their size; the tables that did not change for more than a day (stalest first, up to 500 in the readout);
- **failed tasks** of the last 24 hours, with the error – a task that newly fails is recorded in the application's history (`application.snowflake_tasks_failed`);
- the **warehouses** that ran queries on the database in the last 30 days, with their credits over 30 and 7 days (warehouses are shared: the credits are the warehouse's, not only this database's).

When the account cannot be read, the component keeps the last readout and says why. Processes see it as `readout` of the component (input type _Application_).

## Access reviews

Access reviews (_Compliance → Access reviews_) take the source **Snowflake**:

| Scope               | Who has what                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| empty               | every user with the roles granted to them directly (`role:ANALYST`)                                                |
| `SHOP`              | every user who reaches the database or objects in it, through their roles **and the roles granted to those roles** |
| `SHOP.SALES`        | … the schema and its tables and views                                                                              |
| `SHOP.SALES.ORDERS` | … this table (and the database and schema grants needed to reach it)                                               |

Rights read like `SELECT TABLE SHOP.SALES.ORDERS`, `USAGE SCHEMA SHOP.SALES`, `OWNERSHIP DATABASE SHOP`. **Technical users** (`TYPE = SERVICE` or `LEGACY_SERVICE`) are marked _technical_, disabled users _disabled_. Each run is a snapshot; the next run shows what was granted or removed, as for every other source.

Where the account's `USERS` view has them, Steward also reads `EMAIL`, `LAST_SUCCESS_LOGIN`, `HAS_PASSWORD`, `HAS_MFA` and `EXT_AUTHN_DUO` (without them – an older account – the four columns of before). The **e-mail address** is kept as an alias of the user when it differs from the login name, so a **person review** finds users whose names are employee ids (`Z003ABCD`) by their e-mail address. Person reviews show the **last login** (and "password without MFA") next to each right as a hint for the reviewer; the hint is read live and never part of a snapshot, so it does not create new snapshots every day.

Not counted: future grants (they apply to objects created later and show up once those exist), database roles, and grants to shares.

## Monitor check

```yaml
checks:
  - id: orders-fresh
    name: Orders loaded
    type: snowflake
    platform: Snowflake prod
    mode: freshness # the table changed within maxAgeMinutes
    object: SHOP.SALES.ORDERS
    maxAgeMinutes: 90
  - id: shop-tasks
    name: Shop tasks
    type: snowflake
    platform: Snowflake prod
    mode: tasks # no task of the database (or DATABASE.SCHEMA) failed within withinHours
    object: SHOP
    withinHours: 24
    failAs: degraded
  - id: transform-credits
    name: Transform warehouse credits
    type: snowflake
    platform: Snowflake prod
    mode: credits # the warehouse used at most maxCredits within withinHours
    object: TRANSFORM_WH
    withinHours: 24
    maxCredits: 20
```

`failAs` (`down` or `degraded`, default `down`) is the status when the limit is not met; a table that cannot be found is _unknown_.

## Costs

The platform's costs in money ([COSTS.md](COSTS.md#sources)): turned on under _Costs → the platform → Source_, Steward reads `SNOWFLAKE.ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY` once a day for the platform's account (`ACCOUNT_LOCATOR` or the name after `ORG-` in the variable `account`) – the organisation's usage views must be readable (`IMPORTED PRIVILEGES` on the `SNOWFLAKE` database in an account that has `ORGANIZATION_USAGE`; not for reseller contracts). Without them it reads the credits of `ACCOUNT_USAGE.METERING_DAILY_HISTORY` and multiplies them by the **price per credit** set on the source. The costs belong to the platform's application, else they are unassigned.

## Data products discovery

A discovery source of the data products module ([DATA-PRODUCTS.md](DATA-PRODUCTS.md#discovery)) on a Snowflake platform reads the **databases and schemas of its scope** (`SHOP`, `SHOP.SALES`) into the element catalogue: databases, schemas, tables, views, dynamic tables, streams, tasks, stages and pipes, with row counts, bytes and the last change as metadata. Two modes (ADR 0036 decision 12):

| Mode                             | Reads                                                                                                                                   | Needs                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Information schema** (default) | per database `<DB>.INFORMATION_SCHEMA.SCHEMATA`, `TABLES` and `VIEWS` (the secure ones) – current                                       | privileges on the objects that show metadata, not data (below) – the least privilege |
| **Account usage**                | `SNOWFLAKE.ACCOUNT_USAGE.DATABASES`, `SCHEMATA`, `TABLES` and `VIEWS` for the whole scope, one statement each – up to 90 minutes behind | `IMPORTED PRIVILEGES` on the `SNOWFLAKE` database (as for the readouts above)        |

In both modes `SHOW DYNAMIC TABLES`, `SHOW STREAMS`, `SHOW TASKS`, `SHOW STAGES` and `SHOW PIPES` `IN DATABASE` (or `IN SCHEMA` for a schema in the scope) add what the views do not hold; of their output Steward keeps metadata columns only – never a definition. **Account usage** suits large accounts: one statement per view for all databases, and the `TABLE_ID` makes a renamed table the same element (people's descriptions, memberships and links stay). Its wider view is the whole account's metadata – `IMPORTED PRIVILEGES` shows every database's objects to the role; Steward still keeps only the scope. In **information schema** mode a role sees only the objects it has a privilege on, and there is no `TABLE_ID`: a renamed table is a new element and the old one goes missing.

Grants for **information schema** mode – metadata, not data (`REFERENCES` shows a table's or view's definition of columns, never its rows; `MONITOR` shows a dynamic table, task or pipe):

```sql
GRANT USAGE ON DATABASE SHOP TO ROLE STEWARD_READ;
GRANT USAGE ON ALL SCHEMAS IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT USAGE ON FUTURE SCHEMAS IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT REFERENCES ON ALL TABLES IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT REFERENCES ON FUTURE TABLES IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT REFERENCES ON ALL VIEWS IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT REFERENCES ON FUTURE VIEWS IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT MONITOR ON ALL DYNAMIC TABLES IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT MONITOR ON ALL TASKS IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT MONITOR ON ALL PIPES IN DATABASE SHOP TO ROLE STEWARD_READ;
GRANT USAGE ON ALL STAGES IN DATABASE SHOP TO ROLE STEWARD_READ;   -- external stages; internal ones need READ (a data right)
```

Streams are listed only to a role with `SELECT` on them, internal stages only with `READ` – both are data rights: grant them only if your policy allows, otherwise those objects are not discovered. (A database in the scope the role may not see fails the run: _does not exist or not authorized_.)

**Statements.** Every statement starts with its tag (`/* steward:dp-tables */` …); the information schema views are named as a bound `IDENTIFIER(?)` (`SHOP.INFORMATION_SCHEMA.TABLES`), the database or schema of `SHOW` as a quoted identifier checked against the scope's rule (letters, digits, `_` and `$`), every other value is a binding. Results come partition by partition, at most 50,001 rows per statement, with a statement timeout of 120 s; a run stops after 10 minutes or 50,000 elements and then marks nothing missing. The tests check every statement discovery sends against this list and that none reads a table of the account.

## Templates

Example processes that call the SQL API themselves (`POST /api/v2/statements` on the Snowflake platform, statements with bind parameters, read-only):

| Template                                                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Schedule  | Datasets                                                  |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------- |
| [61 Snowflake – Project access review](../examples/processes/61-snowflake-project-access-review.yaml) | `SHOW GRANTS ON DATABASE` per database → the roles with a privilege → `SHOW GRANTS OF ROLE` per role, nested roles followed up to four levels to the users, with the path (`PRD_X_READONLY ← PBI_REPORTING ← Z006MNOP`); users from `ACCOUNT_USAGE.USERS`, technical users (TYPE or a name pattern) marked; the owner attests, a second person confirms, a manual step lists the `REVOKE ROLE … FROM USER …;` statements (maker–checker), access changes documented | quarterly | `snowflake.project-access`                                |
| [62 Snowflake – Account hygiene and usage](../examples/processes/62-snowflake-account-hygiene.yaml)   | People inactive for N days, password sign-ins without MFA, technical users with a password, ACCOUNTADMIN and SECURITYADMIN holders, disabled users that still hold roles, credits per warehouse over 7 and 30 days, failed tasks                                                                                                                                                                                                                                    | daily     | `snowflake.users`, `snowflake.credits`, `snowflake.tasks` |

The dashboard [Snowflake account](../examples/dashboards/61-snowflake-account.yaml) shows both, the monitor [Snowflake account](../examples/monitors/50-snowflake-account.yaml) watches a table, the tasks of a database and the credits of a warehouse live.

- **Names from inputs** (databases, role prefixes) are checked against `^[A-Za-z0-9_$."-]+$` and always sent as quoted identifiers: unquoted names in upper case as Snowflake stores them, `"Quoted"` names as they are, `"` doubled. Role names from Snowflake's own answers are quoted as they come.
- **Rights**: `SHOW GRANTS OF ROLE` shows the grantees to a role with MANAGE GRANTS (e.g. SECURITYADMIN) or the ownership of the role – grant it to Steward's role only if your policy allows; otherwise the review names the roles it could not read. `ACCOUNT_USAGE` needs IMPORTED PRIVILEGES and a warehouse.
- Roles of account administration (`ACCOUNTADMIN`, `SECURITYADMIN`, `SYSADMIN`, `USERADMIN`, `ORGADMIN`; an input) are named, not followed – they reach every database and are reviewed on their own (62).
- The process reads the first result partition of the SQL API (some thousand rows), enough for the grants of a project.

## Demo

The demo has _Snowflake (demo)_, account `DEMO12345` with the databases `SHOP`, `CRM` and the project database `PRD_SDC_OPQ_PBI_DEV` (roles `…_OWNER`, `…_READONLY`, `…_READWRITE` and the nested `PBI_REPORTING`), a failing task, four warehouses and twelve users: four with short names, seven with employee ids or technical names (one disabled, one with a password and no MFA, one with no login for 200 days, a technical user with a password) and an emergency administrator. Demo setup creates a key pair; the mock verifies every JWT with its public key. It answers `SHOW GRANTS ON DATABASE`, `SHOW GRANTS OF ROLE` and SELECTs from the `ACCOUNT_USAGE` views the templates use (`server/src/mock/mockSnowflake.ts`). For data products discovery it has a catalogue of its own – `SHOP` and `SHOP_DEV` with the schemas `RAW`, `STAGED`, `CURATED` and `MART` (a transient table, a stream, an external stage, a pipe, a task, a dynamic table, a secure and a materialized view), `CRM` – each object with a `TABLE_ID`, and sends large results in partitions; tests add tens of thousands of tables (`server/test/dataproducts-discovery.test.ts`, `…-scale.test.ts`). The demo also has the access check _Platform access (demo) – Snowflake roles_ and the sample application _Webshop (demo)_ with the database `SHOP`.
