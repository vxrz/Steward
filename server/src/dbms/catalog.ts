import { DB_CATALOG_COLUMNS, type DbCatalog } from '@sm/shared';
import type { ServerInfo } from './types.js';

/**
 * Steward's catalog queries (ADR 0008): the accounts, role memberships, object privileges, replication state and tables
 * of a database, read with the statement of each DBMS and mapped to the same columns (DB_CATALOG_COLUMNS), so one
 * template serves PostgreSQL, MariaDB, MySQL and SQL Server. The statements to fix what a review finds (REVOKE, lock or
 * disable an account) are generated here, quoted for the DBMS – a person runs them in a manual step.
 *
 * Kept free of connection code so schema snapshots (#222) can reuse it.
 */

export type Flavour = ServerInfo['flavour'];

// ---------- quoting (for the generated statements a person runs) ----------

export const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const myIdent = (s: string) => `\`${s.replace(/`/g, '``')}\``;
export const msIdent = (s: string) => `[${s.replace(/]/g, ']]')}]`;
/** MariaDB/MySQL account: `user`@`host` (backticks: no backslash rules). */
export const myAccount = (user: string, host: string | null | undefined) =>
  host === null || host === undefined ? myIdent(user) : `${myIdent(user)}@${myIdent(host)}`;

/** A privilege name from the catalog that may go into a statement as it is (SELECT, VIEW DEFINITION, CREATE TEMPORARY TABLES …). */
const privilegeOk = (p: unknown): p is string => typeof p === 'string' && /^[A-Z][A-Z ]{0,60}$/.test(p);

export const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(1|y|yes|t|true|on)$/i.test(v.trim()));
const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const time = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(t.getTime()) || !Number.isFinite(t.getTime()) ? null : t.toISOString();
};
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String).filter(Boolean)
    : typeof v === 'string' && v
      ? v
          .replace(/^\{|\}$/g, '')
          .split(',')
          .map((x) => x.trim().replace(/^"|"$/g, ''))
          .filter(Boolean)
      : [];

/** Accounts that come with the DBMS (account hygiene flags them). */
export const DEFAULT_ACCOUNTS: Record<Flavour, readonly string[]> = {
  postgresql: ['postgres'],
  mysql: ['root', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'debian-sys-maint', ''],
  mariadb: ['root', 'mariadb.sys', 'mysql', 'debian-sys-maint', ''],
  sqlserver: ['sa'],
};

type Row = Record<string, unknown>;

interface CatalogDef {
  sql: Record<Flavour, string>;
  map(row: Row, flavour: Flavour, ctx: { database: string }): Row;
}

// ---------- the statements ----------

const PG_RELKIND = `CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'f' THEN 'foreign table' WHEN 'S' THEN 'sequence' ELSE c.relkind::text END`;

const MY_STATUS = (flavour: 'mysql' | 'mariadb') =>
  `SELECT '${flavour === 'mariadb' ? 'MariaDB' : 'MySQL'}' AS product, VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS current_user_name,
  @@SESSION.${flavour === 'mariadb' ? 'tx_read_only' : 'transaction_read_only'} AS read_only, UTC_TIMESTAMP(3) AS server_time,
  (SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES p WHERE p.GRANTEE = CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')
     AND p.PRIVILEGE_TYPE IN ('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'SUPER', 'FILE', 'CREATE USER', 'GRANT OPTION'))
  + (SELECT COUNT(*) FROM information_schema.SCHEMA_PRIVILEGES p WHERE p.GRANTEE = CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')
     AND p.PRIVILEGE_TYPE IN ('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER')) AS can_write`;

const MY_TABLES = `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS row_estimate, DATA_LENGTH + INDEX_LENGTH AS bytes
  FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`;

const MY_PRIVILEGES = `SELECT GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege, 'global' AS object_type, NULL AS schema_name, NULL AS object_name, IS_GRANTABLE AS grantable
  FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE <> 'USAGE'
  UNION ALL SELECT GRANTEE, PRIVILEGE_TYPE, 'schema', TABLE_SCHEMA, NULL, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = DATABASE()
  UNION ALL SELECT GRANTEE, PRIVILEGE_TYPE, 'table', TABLE_SCHEMA, TABLE_NAME, IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY 1, 3, 4, 5, 2`;

export const CATALOG: Record<DbCatalog, CatalogDef> = {
  status: {
    sql: {
      postgresql: `SELECT 'PostgreSQL' AS product, current_setting('server_version') AS version, current_database() AS db, current_user AS current_user_name,
  current_setting('transaction_read_only') AS read_only, now() AS server_time,
  (SELECT rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = current_user)
  OR has_database_privilege(current_database(), 'CREATE')
  OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg!_toast%' ESCAPE '!'
      AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')) AS can_write`,
      mysql: MY_STATUS('mysql'),
      mariadb: MY_STATUS('mariadb'),
      sqlserver: `SELECT 'SQL Server' AS product, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, DB_NAME() AS db, SUSER_SNAME() AS current_user_name,
  CAST(0 AS bit) AS read_only, SYSUTCDATETIME() AS server_time,
  CASE WHEN IS_SRVROLEMEMBER('sysadmin') = 1 OR IS_MEMBER('db_owner') = 1 OR IS_MEMBER('db_datawriter') = 1 OR IS_MEMBER('db_ddladmin') = 1
    OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') = 1 OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') = 1
    OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE') = 1 OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') = 1 THEN 1 ELSE 0 END AS can_write`,
    },
    map: (r) => ({
      product: text(r.product),
      version: text(r.version),
      database: text(r.db),
      currentUser: text(r.current_user_name),
      readOnly: truthy(r.read_only),
      serverTime: time(r.server_time),
      canWrite: truthy(r.can_write) || (num(r.can_write) ?? 0) > 0,
    }),
  },

  accounts: {
    sql: {
      postgresql: `SELECT r.rolname AS name, NULL AS host, r.rolcanlogin AS can_login, r.rolsuper AS superuser,
  (r.rolsuper OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS admin, NOT r.rolcanlogin AS locked,
  CASE WHEN r.rolvaliduntil = 'infinity' THEN NULL ELSE r.rolvaliduntil END AS expires_at, NULL AS password_changed_at,
  COALESCE(r.rolvaliduntil < now(), false) AS password_expired, NULL AS authentication,
  ARRAY(SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid ORDER BY 1) AS roles
FROM pg_roles r WHERE r.rolname NOT LIKE 'pg!_%' ESCAPE '!' AND (r.rolcanlogin OR r.rolsuper) ORDER BY r.rolname`,
      mysql: `SELECT u.User AS name, u.Host AS host, u.account_locked = 'N' AS can_login, u.Super_priv = 'Y' AS superuser,
  (u.Super_priv = 'Y' OR u.Grant_priv = 'Y' OR u.Create_user_priv = 'Y' OR u.Shutdown_priv = 'Y' OR u.File_priv = 'Y') AS admin,
  u.account_locked = 'Y' AS locked, CASE WHEN u.password_lifetime IS NULL OR u.password_lifetime = 0 OR u.password_last_changed IS NULL THEN NULL
    ELSE DATE_ADD(u.password_last_changed, INTERVAL u.password_lifetime DAY) END AS expires_at,
  u.password_last_changed AS password_changed_at, u.password_expired = 'Y' AS password_expired, u.plugin AS authentication,
  (SELECT GROUP_CONCAT(CONCAT(e.FROM_USER, '@', e.FROM_HOST) ORDER BY e.FROM_USER SEPARATOR ',') FROM mysql.role_edges e WHERE e.TO_USER = u.User AND e.TO_HOST = u.Host) AS roles
FROM mysql.user u WHERE NOT (u.account_locked = 'Y' AND u.authentication_string = '' AND NOT EXISTS (SELECT 1 FROM mysql.role_edges e WHERE e.TO_USER = u.User AND e.TO_HOST = u.Host) AND EXISTS (SELECT 1 FROM mysql.role_edges e WHERE e.FROM_USER = u.User AND e.FROM_HOST = u.Host))
ORDER BY u.User, u.Host`,
      mariadb: `SELECT u.User AS name, u.Host AS host, COALESCE(JSON_VALUE(g.Priv, '$.account_locked'), 'false') <> 'true' AS can_login, u.Super_priv = 'Y' AS superuser,
  (u.Super_priv = 'Y' OR u.Grant_priv = 'Y' OR u.Create_user_priv = 'Y' OR u.Shutdown_priv = 'Y' OR u.File_priv = 'Y') AS admin,
  COALESCE(JSON_VALUE(g.Priv, '$.account_locked'), 'false') = 'true' AS locked,
  CASE WHEN COALESCE(JSON_VALUE(g.Priv, '$.password_lifetime'), -1) <= 0 OR COALESCE(JSON_VALUE(g.Priv, '$.password_last_changed'), 0) = 0 THEN NULL
    ELSE FROM_UNIXTIME(JSON_VALUE(g.Priv, '$.password_last_changed') + JSON_VALUE(g.Priv, '$.password_lifetime') * 86400) END AS expires_at,
  CASE WHEN COALESCE(JSON_VALUE(g.Priv, '$.password_last_changed'), 0) = 0 THEN NULL ELSE FROM_UNIXTIME(JSON_VALUE(g.Priv, '$.password_last_changed')) END AS password_changed_at,
  u.password_expired = 'Y' AS password_expired, u.plugin AS authentication,
  (SELECT GROUP_CONCAT(m.Role ORDER BY m.Role SEPARATOR ',') FROM mysql.roles_mapping m WHERE m.User = u.User AND m.Host = u.Host) AS roles
FROM mysql.user u LEFT JOIN mysql.global_priv g ON g.Host = u.Host AND g.User = u.User WHERE u.is_role = 'N' ORDER BY u.User, u.Host`,
      sqlserver: `SELECT sp.name AS name, NULL AS host, CASE WHEN sp.is_disabled = 0 THEN 1 ELSE 0 END AS can_login,
  CASE WHEN EXISTS (SELECT 1 FROM sys.server_role_members rm JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id WHERE rm.member_principal_id = sp.principal_id AND r.name = 'sysadmin') THEN 1 ELSE 0 END AS superuser,
  CASE WHEN EXISTS (SELECT 1 FROM sys.server_role_members rm JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id WHERE rm.member_principal_id = sp.principal_id AND r.name IN ('sysadmin', 'securityadmin', 'serveradmin', 'setupadmin'))
    OR EXISTS (SELECT 1 FROM sys.server_permissions pe WHERE pe.grantee_principal_id = sp.principal_id AND pe.permission_name IN ('CONTROL SERVER', 'ALTER ANY LOGIN') AND pe.state IN ('G', 'W')) THEN 1 ELSE 0 END AS admin,
  CASE WHEN sp.is_disabled = 1 OR CAST(LOGINPROPERTY(sp.name, 'IsLocked') AS int) = 1 THEN 1 ELSE 0 END AS locked,
  CASE WHEN sl.is_expiration_checked = 1 AND CAST(LOGINPROPERTY(sp.name, 'DaysUntilExpiration') AS int) IS NOT NULL
    THEN DATEADD(day, CAST(LOGINPROPERTY(sp.name, 'DaysUntilExpiration') AS int), SYSUTCDATETIME()) END AS expires_at,
  CAST(LOGINPROPERTY(sp.name, 'PasswordLastSetTime') AS datetime2) AS password_changed_at,
  CASE WHEN CAST(LOGINPROPERTY(sp.name, 'IsExpired') AS int) = 1 THEN 1 ELSE 0 END AS password_expired, sp.type_desc AS authentication,
  STUFF((SELECT ',' + r.name FROM sys.server_role_members rm JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id WHERE rm.member_principal_id = sp.principal_id ORDER BY r.name FOR XML PATH('')), 1, 1, '') AS roles
FROM sys.server_principals sp LEFT JOIN sys.sql_logins sl ON sl.principal_id = sp.principal_id
WHERE sp.type IN ('S', 'U', 'G', 'E', 'X') AND sp.name NOT LIKE '##%' ORDER BY sp.name`,
    },
    map: (r, flavour) => {
      const name = String(r.name ?? '');
      const host = text(r.host);
      const disable =
        flavour === 'postgresql'
          ? `ALTER ROLE ${pgIdent(name)} NOLOGIN;`
          : flavour === 'sqlserver'
            ? `ALTER LOGIN ${msIdent(name)} DISABLE;`
            : `ALTER USER ${myAccount(name, host ?? '%')} ACCOUNT LOCK;`;
      return {
        name,
        host,
        canLogin: truthy(r.can_login),
        superuser: truthy(r.superuser),
        admin: truthy(r.admin),
        locked: truthy(r.locked),
        expiresAt: time(r.expires_at),
        passwordChangedAt: time(r.password_changed_at),
        passwordExpired: truthy(r.password_expired),
        defaultAccount: DEFAULT_ACCOUNTS[flavour].includes(name),
        authentication: text(r.authentication),
        roles: list(r.roles),
        disable,
      };
    },
  },

  'role-members': {
    sql: {
      postgresql: `SELECT 'server' AS scope, r.rolname AS role_name, m.rolname AS member, CASE WHEN m.rolcanlogin THEN 'user' ELSE 'role' END AS member_type,
  am.admin_option AS admin_option, g.rolname AS grantor, NULL AS member_host, NULL AS role_host
FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member LEFT JOIN pg_roles g ON g.oid = am.grantor
ORDER BY r.rolname, m.rolname`,
      mysql: `SELECT 'server' AS scope, e.FROM_USER AS role_name, e.TO_USER AS member,
  CASE WHEN EXISTS (SELECT 1 FROM mysql.role_edges x WHERE x.FROM_USER = e.TO_USER AND x.FROM_HOST = e.TO_HOST) THEN 'role' ELSE 'user' END AS member_type,
  e.WITH_ADMIN_OPTION = 'Y' AS admin_option, NULL AS grantor, e.TO_HOST AS member_host, e.FROM_HOST AS role_host
FROM mysql.role_edges e ORDER BY e.FROM_USER, e.TO_USER`,
      mariadb: `SELECT 'server' AS scope, m.Role AS role_name, m.User AS member,
  CASE WHEN EXISTS (SELECT 1 FROM mysql.user u WHERE u.User = m.User AND u.is_role = 'Y') THEN 'role' ELSE 'user' END AS member_type,
  m.Admin_option = 'Y' AS admin_option, NULL AS grantor, m.Host AS member_host, NULL AS role_host
FROM mysql.roles_mapping m ORDER BY m.Role, m.User`,
      sqlserver: `SELECT 'server' AS scope, r.name AS role_name, m.name AS member, LOWER(m.type_desc) AS member_type, 0 AS admin_option, NULL AS grantor, NULL AS member_host, NULL AS role_host
FROM sys.server_role_members rm JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id JOIN sys.server_principals m ON m.principal_id = rm.member_principal_id
UNION ALL
SELECT 'database', r.name, m.name, LOWER(m.type_desc), 0, NULL, NULL, NULL
FROM sys.database_role_members rm JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
ORDER BY 1, 2, 3`,
    },
    map: (r, flavour) => {
      const role = String(r.role_name ?? '');
      const member = String(r.member ?? '');
      const memberHost = text(r.member_host);
      const roleHost = text(r.role_host);
      const scope = r.scope === 'database' ? 'database' : 'server';
      const memberType = String(r.member_type ?? 'user')
        .toLowerCase()
        .replace(/_/g, ' ');
      let revoke: string;
      if (flavour === 'postgresql') revoke = `REVOKE ${pgIdent(role)} FROM ${pgIdent(member)};`;
      else if (flavour === 'sqlserver') revoke = `ALTER ${scope === 'server' ? 'SERVER ROLE' : 'ROLE'} ${msIdent(role)} DROP MEMBER ${msIdent(member)};`;
      else if (flavour === 'mysql') revoke = `REVOKE ${myAccount(role, roleHost ?? '%')} FROM ${myAccount(member, memberHost ?? '%')};`;
      // MariaDB: roles have no host; a member that is a role has none either
      else revoke = `REVOKE ${myIdent(role)} FROM ${memberType === 'role' || !memberHost ? myIdent(member) : myAccount(member, memberHost)};`;
      return {
        scope,
        role,
        member: memberHost ? `${member}@${memberHost}` : member,
        memberType,
        adminOption: truthy(r.admin_option),
        grantor: text(r.grantor),
        revoke,
      };
    },
  },

  privileges: {
    sql: {
      postgresql: `SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE g.rolname END AS grantee, x.privilege_type AS privilege, x.object_type, x.schema_name, x.object_name,
  x.is_grantable AS grantable, gr.rolname AS grantor
FROM (
  SELECT ${PG_RELKIND} AS object_type, n.nspname AS schema_name, c.relname AS object_name, a.grantee, a.grantor, a.privilege_type, a.is_grantable
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg!_toast%' ESCAPE '!' AND a.grantee <> c.relowner
  UNION ALL
  SELECT 'schema', n.nspname, NULL, a.grantee, a.grantor, a.privilege_type, a.is_grantable
  FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg!_%' ESCAPE '!' AND a.grantee <> n.nspowner
  UNION ALL
  SELECT 'database', NULL, d.datname, a.grantee, a.grantor, a.privilege_type, a.is_grantable
  FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE d.datname = current_database() AND a.grantee <> d.datdba
) x LEFT JOIN pg_roles g ON g.oid = x.grantee LEFT JOIN pg_roles gr ON gr.oid = x.grantor
ORDER BY 1, 3, 4, 5, 2`,
      mysql: MY_PRIVILEGES,
      mariadb: MY_PRIVILEGES,
      sqlserver: `SELECT pr.name AS grantee, pe.permission_name AS privilege, LOWER(pe.class_desc) AS object_type,
  CASE pe.class WHEN 1 THEN OBJECT_SCHEMA_NAME(pe.major_id) WHEN 3 THEN SCHEMA_NAME(pe.major_id) END AS schema_name,
  CASE pe.class WHEN 1 THEN OBJECT_NAME(pe.major_id) WHEN 0 THEN DB_NAME() END AS object_name,
  CASE WHEN pe.state = 'W' THEN 1 ELSE 0 END AS grantable, gr.name AS grantor, pe.state_desc AS state
FROM sys.database_permissions pe JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id
LEFT JOIN sys.database_principals gr ON gr.principal_id = pe.grantor_principal_id
WHERE pe.class IN (0, 1, 3) AND pe.minor_id = 0 AND NOT (pe.class = 0 AND pe.permission_name = 'CONNECT' AND pr.name = 'dbo')
ORDER BY 1, 3, 4, 5, 2`,
    },
    map: (r, flavour) => {
      let grantee = String(r.grantee ?? '');
      let account: string | null = null;
      if (flavour === 'mysql' || flavour === 'mariadb') {
        // information_schema writes the grantee as 'user'@'host'
        const m = /^'((?:[^']|'')*)'@'((?:[^']|'')*)'$/.exec(grantee);
        if (m) {
          const user = m[1]!.replace(/''/g, "'");
          const host = m[2]!.replace(/''/g, "'");
          account = myAccount(user, host);
          grantee = `${user}@${host}`;
        }
      }
      const deny = r.state === 'DENY';
      const priv = String(r.privilege ?? '');
      const objectType = String(r.object_type ?? '')
        .toLowerCase()
        .replace(/_/g, ' ');
      const schema = text(r.schema_name);
      const object = text(r.object_name);
      let revoke: string | null = null;
      if (privilegeOk(priv)) {
        if (flavour === 'postgresql') {
          const who = grantee === 'PUBLIC' ? 'PUBLIC' : pgIdent(grantee);
          if (objectType === 'database' && object) revoke = `REVOKE ${priv} ON DATABASE ${pgIdent(object)} FROM ${who};`;
          else if (objectType === 'schema' && schema) revoke = `REVOKE ${priv} ON SCHEMA ${pgIdent(schema)} FROM ${who};`;
          else if (schema && object)
            revoke = `REVOKE ${priv} ON ${objectType === 'sequence' ? 'SEQUENCE' : 'TABLE'} ${pgIdent(schema)}.${pgIdent(object)} FROM ${who};`;
        } else if (flavour === 'sqlserver') {
          const who = msIdent(grantee);
          if (objectType === 'database') revoke = `REVOKE ${priv} FROM ${who};`;
          else if (objectType === 'schema' && schema) revoke = `REVOKE ${priv} ON SCHEMA::${msIdent(schema)} FROM ${who};`;
          else if (schema && object) revoke = `REVOKE ${priv} ON ${msIdent(schema)}.${msIdent(object)} FROM ${who};`;
        } else if (account) {
          const on =
            objectType === 'global'
              ? '*.*'
              : objectType === 'schema' && schema
                ? `${myIdent(schema)}.*`
                : schema && object
                  ? `${myIdent(schema)}.${myIdent(object)}`
                  : null;
          if (on) revoke = `REVOKE ${priv} ON ${on} FROM ${account};`;
        }
      }
      return {
        grantee,
        privilege: deny ? `DENY ${priv}` : priv,
        objectType,
        schema,
        object,
        grantable: truthy(r.grantable),
        grantor: text(r.grantor),
        revoke,
      };
    },
  },

  replication: {
    sql: {
      postgresql: `SELECT 'primary' AS role, COALESCE(NULLIF(application_name, ''), client_addr::text, 'replica') AS name, state,
  EXTRACT(EPOCH FROM COALESCE(replay_lag, flush_lag, write_lag)) AS lag_seconds
FROM pg_stat_replication
UNION ALL
SELECT 'standby', 'this server', 'streaming',
  CASE WHEN pg_last_xact_replay_timestamp() IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()) END
WHERE pg_is_in_recovery()`,
      mysql: 'SHOW REPLICA STATUS',
      mariadb: 'SHOW REPLICA STATUS',
      sqlserver: `SELECT LOWER(COALESCE(ars.role_desc, 'replica')) AS role, ar.replica_server_name + ' / ' + DB_NAME(drs.database_id) AS name,
  LOWER(drs.synchronization_state_desc) AS state, drs.secondary_lag_seconds AS lag_seconds
FROM sys.dm_hadr_database_replica_states drs JOIN sys.availability_replicas ar ON ar.replica_id = drs.replica_id
LEFT JOIN sys.dm_hadr_availability_replica_states ars ON ars.replica_id = drs.replica_id
ORDER BY 2`,
    },
    map: (r, flavour) => {
      if (flavour === 'mysql' || flavour === 'mariadb') {
        // SHOW REPLICA STATUS: MySQL says Source/Replica, MariaDB Master/Slave
        const io = r.Replica_IO_Running ?? r.Slave_IO_Running;
        const sqlRunning = r.Replica_SQL_Running ?? r.Slave_SQL_Running;
        return {
          role: 'replica',
          name: text(r.Source_Host ?? r.Master_Host) ?? 'replica',
          state: `IO ${String(io ?? '?')}, SQL ${String(sqlRunning ?? '?')}`,
          lagSeconds: num(r.Seconds_Behind_Source ?? r.Seconds_Behind_Master),
        };
      }
      return { role: text(r.role), name: text(r.name), state: text(r.state), lagSeconds: num(r.lag_seconds) };
    },
  },

  tables: {
    sql: {
      postgresql: `SELECT n.nspname AS schema_name, c.relname AS name, ${PG_RELKIND} AS type, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_estimate,
  pg_total_relation_size(c.oid) AS bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg!_toast%' ESCAPE '!'
ORDER BY 1, 2`,
      mysql: MY_TABLES,
      mariadb: MY_TABLES,
      sqlserver: `SELECT s.name AS schema_name, o.name AS name, LOWER(o.type_desc) AS type,
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS row_estimate,
  (SELECT SUM(a.total_pages) * 8192 FROM sys.partitions p JOIN sys.allocation_units a ON a.container_id = p.partition_id WHERE p.object_id = o.object_id) AS bytes
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
ORDER BY 1, 2`,
    },
    map: (r) => ({
      schema: text(r.schema_name),
      name: text(r.name),
      type: String(r.type ?? '')
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/^base table$/, 'table')
        .replace(/^user table$/, 'table'),
      rows: num(r.row_estimate),
      bytes: num(r.bytes),
    }),
  },
};

/** The columns of a catalog query, whatever the DBMS. */
export const catalogColumns = (name: DbCatalog): string[] => [...DB_CATALOG_COLUMNS[name]];

/** The statement of a catalog query for a server. */
export const catalogSql = (name: DbCatalog, server: Pick<ServerInfo, 'flavour'>): string => CATALOG[name].sql[server.flavour];

/** Rows of a catalog query mapped to its columns. */
export function mapCatalogRows(name: DbCatalog, server: Pick<ServerInfo, 'flavour'>, rows: Row[], ctx: { database: string }): Row[] {
  return rows.map((r) => CATALOG[name].map(r, server.flavour, ctx));
}
