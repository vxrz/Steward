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

## Demo

The demo has _Snowflake (demo)_, account `DEMO12345` with the databases `SHOP` and `CRM`, a failing task, two warehouses and four users (one technical, one disabled). Demo setup creates a key pair; the mock verifies every JWT with its public key.
