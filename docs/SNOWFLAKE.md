# Snowflake

Steward reads a Snowflake account through the **SQL API** with **key-pair authentication**: the **databases** of applications (tables, their size and last change, failing tasks, the credits of the warehouses used), **access reviews** (who has which roles, who reaches a database, schema or table, technical users marked), a **monitor check** (freshness of a table, failing tasks, warehouse credits) and, as example processes, a **cost estimate** with the projection for the month and a **waste check** with the saving per finding (0.21.0, [below](#cost-estimate-and-waste-check)). Everything is read-only; every value goes into the statements as a bind parameter, never as text.

| What                                       | From                                                                                                                                                               | Delay                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Tables, size, last change                  | `SNOWFLAKE.ACCOUNT_USAGE.TABLES`                                                                                                                                   | up to 90 minutes      |
| Failing tasks                              | `ACCOUNT_USAGE.TASK_HISTORY`                                                                                                                                       | up to 45 minutes      |
| Credits per warehouse                      | `ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY`, `QUERY_HISTORY`                                                                                                        | up to 3 hours         |
| Users, roles, grants                       | `ACCOUNT_USAGE.USERS`, `GRANTS_TO_USERS`, `GRANTS_TO_ROLES`                                                                                                        | up to 2 hours         |
| Credits per service type, storage          | `ACCOUNT_USAGE.METERING_DAILY_HISTORY`, `STORAGE_USAGE`, `DATABASE_STORAGE_USAGE_HISTORY` (cost estimate)                                                          | up to 3 hours         |
| Credits per query tag and user             | `ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY` (cost estimate)                                                                                                          | up to 8 hours         |
| Load, reads of tables, serverless features | `WAREHOUSE_LOAD_HISTORY`, `ACCESS_HISTORY`, `TABLE_STORAGE_METRICS`, the task, pipe, clustering, materialised view and search optimisation histories (waste check) | 45 minutes to 3 hours |
| Freshness of one table                     | `<database>.INFORMATION_SCHEMA.TABLES` (monitor check)                                                                                                             | current               |

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
   -- for the waste check only: SHOW WAREHOUSES lists every warehouse with its size and auto-suspend
   -- (without it, only the warehouses the role has a privilege on)
   GRANT MONITOR USAGE ON ACCOUNT TO ROLE STEWARD_READ;
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

The platform's costs in money ([COSTS.md](COSTS.md#sources)): turned on under _Costs → the platform → Source_, Steward reads `SNOWFLAKE.ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY` once a day for the platform's account (`ACCOUNT_LOCATOR` or the name after `ORG-` in the variable `account`) – the organisation's usage views must be readable (`IMPORTED PRIVILEGES` on the `SNOWFLAKE` database in an account that has `ORGANIZATION_USAGE`; not for reseller contracts). Without them it reads the credits of `ACCOUNT_USAGE.METERING_DAILY_HISTORY` and multiplies them by the **price per credit** – since 0.21.0 the item `compute-credit` of the platform's contracted price book ([PRICE-BOOKS.md](PRICE-BOOKS.md#price-books)), still set on the source as well. The costs belong to the platform's application, else they are unassigned.

## Data products discovery

A discovery source of the data products module ([DATA-PRODUCTS.md](DATA-PRODUCTS.md#discovery)) on a Snowflake platform reads the **databases and schemas of its scope** (`SHOP`, `SHOP.SALES`) into the element catalogue: databases, schemas, tables, views, dynamic tables, streams, tasks, stages and pipes, with row counts, bytes and the last change as metadata. Two modes (ADR 0036 decision 12):

| Mode                             | Reads                                                                                                                                   | Needs                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Information schema** (default) | per database `<DB>.INFORMATION_SCHEMA.SCHEMATA`, `TABLES` and `VIEWS` (the secure ones) – current                                       | privileges on the objects that show metadata, not data (below) – the least privilege |
| **Account usage**                | `SNOWFLAKE.ACCOUNT_USAGE.DATABASES`, `SCHEMATA`, `TABLES` and `VIEWS` for the whole scope, one statement each – up to 90 minutes behind | `IMPORTED PRIVILEGES` on the `SNOWFLAKE` database (as for the readouts above)        |

In both modes `SHOW DYNAMIC TABLES`, `SHOW STREAMS`, `SHOW TASKS`, `SHOW STAGES` and `SHOW PIPES` `IN DATABASE` (or `IN SCHEMA` for a schema in the scope) add what the views do not hold; of their output Steward keeps metadata columns only – never a definition. **Account usage** suits large accounts: one statement per view for all databases, and the `TABLE_ID` makes a renamed table the same element (people's descriptions, memberships and links stay). Its wider view is the whole account's metadata – `IMPORTED PRIVILEGES` shows every database's objects to the role; Steward still keeps only the scope. In **information schema** mode a role sees only the objects it has a privilege on, and there is no `TABLE_ID`: a renamed table is a new element and the old one goes missing.

**Object dependencies** (0.24.0, [DATA-PRODUCTS.md](DATA-PRODUCTS.md#lineage-from-tools)): in **account usage** mode, after a complete run, the source reads `SNOWFLAKE.ACCOUNT_USAGE.OBJECT_DEPENDENCIES` once – which table-like object of its scope (a view, a materialized or dynamic table, a stream) references which – and proposes a step per referencing object in _Data → Discovery → Proposed steps_, for a person to accept; ways the documented steps say already are marked _already documented_. Metadata, as the catalogue views: no definition, no query text. Information schema mode has no such view and proposes nothing.

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

**Set it up:**

1. A role with the grants above for the databases you want in the catalogue, for the platform's identity – mark the identity **read-only** ([PLATFORM-SIGN-IN.md](PLATFORM-SIGN-IN.md#read-only-identities-and-the-operation-filter)); for _account usage_ mode also `IMPORTED PRIVILEGES` on `SNOWFLAKE`.
2. With the module on, _Data → Discovery → New source_: the Snowflake platform, the **scope** (`SHOP`, `SHOP_DEV` – databases, or schemas as `SHOP.SALES`), include and exclude prefixes if you want only part of it, **environment rules** for databases named per environment (suffix `_DEV` → _dev_, prefix `SHOP` → _prod_ – the first that matches; else the platform's environment), the mode, the identity, how often (daily by default) and the owning teams of what it finds. You need to use the platform; the source runs as you.
3. **Read now** and look at the run: added, changed, renamed, missing, and what it could not read. The elements are in _Data → Elements_ (prefix search `SHOP.CURATED.`); add them to products from there or from a product's _Elements_ tab.

The demo's source _Shop warehouse (demo)_ is set up this way over `SHOP` and `SHOP_DEV` ([DATA-PRODUCTS.md](DATA-PRODUCTS.md#the-demo)).

**Volume and quality checks** (0.24.0, the `data-element` check – [DATA-PRODUCTS.md](DATA-PRODUCTS.md#the-check-type-data-element)): the _volume_ mode reads `ROW_COUNT` and `BYTES` from the same `INFORMATION_SCHEMA.TABLES` row as freshness (`/* steward:dp-table-volume */`, no further grant); the _quality_ mode with Data Metric Functions reads `SNOWFLAKE.LOCAL.DATA_QUALITY_MONITORING_RESULTS` (`/* steward:dp-dmf-results */`, the table's database, schema and name as bindings) – the measured metrics, never the table's rows – and needs:

```sql
GRANT APPLICATION ROLE SNOWFLAKE.DATA_QUALITY_MONITORING_VIEWER TO ROLE STEWARD_READ;
```

**Contract tests** of a `snowflake` server through the datacontract CLI ([DATA-CONTRACTS.md](DATA-CONTRACTS.md#testing)) use the platform's account, user, role, warehouse and key pair; the CLI's data checks need `SELECT` on what the contracts test – a data right Steward's own reads never need.

## Templates

Example processes that call the SQL API themselves (`POST /api/v2/statements` on the Snowflake platform, statements with bind parameters, read-only):

| Template                                                                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Schedule  | Datasets                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| [61 Snowflake – Project access review](../examples/processes/61-snowflake-project-access-review.yaml) | `SHOW GRANTS ON DATABASE` per database → the roles with a privilege → `SHOW GRANTS OF ROLE` per role, nested roles followed up to four levels to the users, with the path (`PRD_X_READONLY ← PBI_REPORTING ← Z006MNOP`); users from `ACCOUNT_USAGE.USERS`, technical users (TYPE or a name pattern) marked; the owner attests, a second person confirms, a manual step lists the `REVOKE ROLE … FROM USER …;` statements (maker–checker), access changes documented | quarterly | `snowflake.project-access`                                                                                     |
| [62 Snowflake – Account hygiene and usage](../examples/processes/62-snowflake-account-hygiene.yaml)   | People inactive for N days, password sign-ins without MFA, technical users with a password, ACCOUNTADMIN and SECURITYADMIN holders, disabled users that still hold roles, credits per warehouse over 7 and 30 days, failed tasks                                                                                                                                                                                                                                    | daily     | `snowflake.users`, `snowflake.credits`, `snowflake.tasks`                                                      |
| [621 Snowflake – Cost estimate and trend](../examples/processes/621-snowflake-cost-estimate.yaml)     | Credits per warehouse (compute and cloud services), billed credits per service type with the serverless ones (tasks, Snowpipe, clustering, materialised views, search optimisation), storage per database, fail-safe and stages, credits per query tag and user – this month so far, projected for the month and the previous month, in money with the price per credit and per TB of the inputs; checks for the monthly budget and the growth against last month   | daily     | `snowflake.cost-services`, `snowflake.cost-warehouses`, `snowflake.cost-storage`, `snowflake.cost-attribution` |
| [622 Snowflake – Waste check](../examples/processes/622-snowflake-waste-check.yaml)                   | Idle and oversized warehouses, auto-suspend off or late, tables not read for N days, large time travel and fail-safe, failing tasks and pipes, serverless features on objects hardly read, long failed queries – each with the reason, the estimated saving per month and the SQL to consider                                                                                                                                                                       | weekly    | `snowflake.waste`                                                                                              |

The dashboard [Snowflake account](../examples/dashboards/61-snowflake-account.yaml) shows 61 and 62, [Snowflake costs](../examples/dashboards/62-snowflake-costs.yaml) shows 621 and 622 (the bundle _Snowflake costs (estimate and waste)_ sets them up together), the monitor [Snowflake account](../examples/monitors/50-snowflake-account.yaml) watches a table, the tasks of a database and the credits of a warehouse live.

- **Names from inputs** (databases, role prefixes) are checked against `^[A-Za-z0-9_$."-]+$` and always sent as quoted identifiers: unquoted names in upper case as Snowflake stores them, `"Quoted"` names as they are, `"` doubled. Role names from Snowflake's own answers are quoted as they come.
- **Rights**: `SHOW GRANTS OF ROLE` shows the grantees to a role with MANAGE GRANTS (e.g. SECURITYADMIN) or the ownership of the role – grant it to Steward's role only if your policy allows; otherwise the review names the roles it could not read. `ACCOUNT_USAGE` needs IMPORTED PRIVILEGES and a warehouse.
- Roles of account administration (`ACCOUNTADMIN`, `SECURITYADMIN`, `SYSADMIN`, `USERADMIN`, `ORGADMIN`; an input) are named, not followed – they reach every database and are reviewed on their own (62).
- The process reads the first result partition of the SQL API (some thousand rows), enough for the grants of a project.

### Cost estimate and waste check

**What it costs this month** (621, daily): every statement reads whole days in UTC (`parameters: { timezone: UTC }`), given as bind parameters – the first day of the month, today, the first day of the run rate, the first day of the previous month. Today is left out: ACCOUNT_USAGE is not complete for it.

- **This month so far**: the complete days of the month. **Projected**: that plus the daily average of the last N complete days (input `runRateDays`, default 7) for each day left, today included – a change in the last week shows at once, and from the first day of a month on. Storage: the byte-days so far plus the latest day's bytes for the days left, ÷ the days of the month × the price per TB and month (TB = 2^40 bytes). **Previous month**: the whole calendar month.
- **Per warehouse**: `CREDITS_USED` of `WAREHOUSE_METERING_HISTORY`, compute and cloud services apart – before the daily adjustment (cloud services are billed only above 10 % of the day's compute). **Per service type**: `CREDITS_BILLED` of `METERING_DAILY_HISTORY`, after the adjustment, and a row _Storage_ – the service types add up to the account's total. **Per query tag and user**: `CREDITS_ATTRIBUTED_COMPUTE` (and query acceleration) of `QUERY_ATTRIBUTION_HISTORY` – idle time of the warehouses is not attributed, so the sum stays below the warehouses' credits. Without the view the dataset stays empty and the run log says why.
- **Money** = credits × the input _Price per credit_, storage × _Storage price per TB and month_ – your contracted prices, in the currency of the input _Currency_. Processes cannot read Steward's price books: the platform's contracted book with the item `compute-credit` ([Costs](#costs)) prices the cost source, not this estimate. For the billed amounts, use the cost source ([COSTS.md](COSTS.md)).
- **Checks**: the projection above the input _Monthly budget_ (0: no check; the message says when the budget will be used up and, once the dataset has a week of history, how the projection moved in 7 days); the projection more than _growth %_ above the previous month; and every warehouse or service type projected above _minimum_ that grows by more than that.

**Where it wastes** (622, weekly) – each finding with the object, the reason, the saving per month (30 days from the last N days, input `days`, default 30) and the SQL a person could run, as text:

| Finding                         | When                                                                                                             | Saving per month                                                  | SQL to consider                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Idle warehouse                  | at least `minCredits` credits, at most `idleQueries` queries                                                     | all its credits                                                   | `ALTER WAREHOUSE … SUSPEND;`                               |
| Auto-suspend                    | off, or longer than `maxAutoSuspend` seconds (`SHOW WAREHOUSES`)                                                 | credits × the share of metered hours without a query × (1 − 60/s) | `ALTER WAREHOUSE … SET AUTO_SUSPEND = 60;`                 |
| Oversized warehouse             | ≥ `shortSharePercent` of the queries under `shortSeconds`, average load ≤ `maxAverageLoad`, no spilling or queue | half its credits (the next smaller size)                          | `ALTER WAREHOUSE … SET WAREHOUSE_SIZE = '…';`              |
| Table not read                  | ≥ `minTableGb`, created and not read for `unreadDays` (`ACCESS_HISTORY`)                                         | its bytes × the price per TB                                      | `DROP TABLE …;` once the owner agreed                      |
| Time travel and fail-safe       | ≥ `minRetentionGb` per table                                                                                     | the time travel bytes × the price per TB                          | `ALTER TABLE … SET DATA_RETENTION_TIME_IN_DAYS = 1;`       |
| Failing task / pipe             | ≥ `minTaskFailures` failed runs / ≥ `minFailedFiles` failed files                                                | the share of its credits spent on failures (serverless only)      | `ALTER TASK … SUSPEND;`, `… PIPE_EXECUTION_PAUSED`         |
| Serverless feature, rarely read | clustering, materialised view or search optimisation with credits, read ≤ `maxReads` times (`ACCESS_HISTORY`)    | all its credits                                                   | `SUSPEND RECLUSTER`, `SUSPEND`, `DROP SEARCH OPTIMIZATION` |
| Long failed queries             | failed or cancelled after `longQueryMinutes`                                                                     | their hours × the credits per hour of the warehouse size          | a statement timeout on the warehouse                       |

The estimates are rough on purpose – a smaller warehouse may run some queries longer, a shorter auto-suspend means more resumes. Findings of one object overlap (an idle warehouse may also suspend late): the total saving counts each object once, with its largest saving. **ACCESS_HISTORY** needs the Enterprise Edition (and the database role `SNOWFLAKE.GOVERNANCE_VIEWER` or IMPORTED PRIVILEGES): without it – or when it is empty – the two findings that need it are skipped, the check _ACCESS_HISTORY readable_ says so (as information, never notified), and the rest runs. Pipes are matched to their credits by name. Results larger than the first partition of the SQL API are cut; the tables and findings are limited (50–100 rows per kind).

## Demo

The demo has _Snowflake (demo)_, account `DEMO12345` with the databases `SHOP`, `CRM` and the project database `PRD_SDC_OPQ_PBI_DEV` (roles `…_OWNER`, `…_READONLY`, `…_READWRITE` and the nested `PBI_REPORTING`), a failing task, four warehouses and twelve users: four with short names, seven with employee ids or technical names (one disabled, one with a password and no MFA, one with no login for 200 days, a technical user with a password) and an emergency administrator. Demo setup creates a key pair; the mock verifies every JWT with its public key. It answers `SHOW GRANTS ON DATABASE`, `SHOW GRANTS OF ROLE`, `SHOW WAREHOUSES` and SELECTs from the `ACCOUNT_USAGE` views the templates use (`server/src/mock/mockSnowflake.ts`). For the cost estimate and the waste check (`server/src/mock/mockSnowflakeUsage.ts`) the four warehouses have daily credits that add up to the hygiene check's 7 and 30 days – the transformation warehouse and the Power BI warehouse grow this month, `UNUSED_WH` has stopped – plus serverless tasks, Snowpipe, clustering, a materialised view and search optimisation, storage per database and stage, query tags, and the waste: `BI_WH` (Large, AUTO_SUSPEND 1800 s, short queries), `PBI_WH` (auto-suspend off), two tables nobody reads, a table with 0.9 TB of time travel, a task that always fails, a pipe with failing files and long cancelled queries. Tests switch views off with `setSnowflakeUnavailableViews`. For data products discovery it has a catalogue of its own – `SHOP` and `SHOP_DEV` with the schemas `RAW`, `STAGED`, `CURATED` and `MART` (a transient table, a stream, an external stage, a pipe, a task, a dynamic table, a secure and a materialized view), `CRM` – each object with a `TABLE_ID`, and sends large results in partitions; tests add tens of thousands of tables (`server/test/dataproducts-discovery.test.ts`, `…-scale.test.ts`). The demo also has the access check _Platform access (demo) – Snowflake roles_ and the sample application _Webshop (demo)_ with the database `SHOP`.
