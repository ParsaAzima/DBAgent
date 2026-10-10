/**
 * Database driver factory: parses connection URLs and instantiates drivers.
 *
 * Supported URL forms:
 *   sqlite://./path/to/file.db        (also sqlite:///abs/path and file: URLs)
 *   postgres://user:pass@host:5432/db (ssl: ?ssl=true)
 *   postgresql://...                  (alias)
 *   mysql://user:pass@host:3306/db    (ssl: ?ssl=true)
 *   sqlserver://user:pass@host:1433/db (?encrypt=true&trustServerCertificate=false&instance=SQLEXPRESS)
 *   mssql://...                       (alias)
 *   mariadb://host:3306/db (MariaDB via the MySQL-compatible driver)
 *   oracle://user:pass@host:1521/service_name (SID: ?sid=ORCL)
 */

import type {
  DatabaseConnection,
  DatabaseDialect,
  DatabaseDriver,
  SafetyConfig,
} from '../core/types.js';
import { SqliteDriver } from './sqlite.js';
import { PostgresDriver } from './postgres.js';
import { MysqlDriver } from './mysql.js';
import { SqlServerDriver } from './sqlserver.js';
import { OracleDriver } from './oracle.js';

export function parseDatabaseUrl(url: string): DatabaseConnection {
  const trimmed = url.trim();

  if (trimmed.startsWith('sqlite://') || trimmed.startsWith('file:')) {
    let target = trimmed
      .replace(/^sqlite:\/\//, '')
      .replace(/^file:\/\//, '')
      .replace(/^file:/, '');
    if (target.startsWith('/')) {
      // sqlite:///abs/path.db keeps the absolute path; sqlite://./x.db does not
      if (
        !trimmed.startsWith('sqlite:////') &&
        !trimmed.startsWith('file:////') &&
        target.match(/^\/[A-Za-z]:/)
      ) {
        // windows drive path like /C:/x.db — strip leading slash
        target = target.slice(1);
      }
    }
    return { dialect: 'sqlite', target: target || ':memory:' };
  }

  // Windows convention host\INSTANCE is not URL-safe: the URL parser rejects
  // it (or silently turns the backslash into a path separator) — steer users
  // to the query-param form before parsing.
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (
    (scheme === 'sqlserver' || scheme === 'mssql') &&
    /^[^/?]*\\/.test(trimmed.replace(/^[^:]+:\/\//, ''))
  ) {
    throw new Error(
      `Named instance in "${trimmed}" must use ?instance=NAME, e.g. sqlserver://user:pass@host/mydb?instance=SQLEXPRESS.`,
    );
  }

  const parsed = new URL(trimmed);
  const oracleProtocol = parsed.protocol === 'oracle+tcps:' ? 'tcps' : 'tcp';
  const dialect: DatabaseDialect =
    parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:'
      ? 'postgres'
      : parsed.protocol === 'mysql:' || parsed.protocol === 'mariadb:'
        ? 'mysql'
        : parsed.protocol === 'sqlserver:' || parsed.protocol === 'mssql:'
          ? 'sqlserver'
          : parsed.protocol === 'oracle:' || parsed.protocol === 'oracle+tcps:'
            ? 'oracle'
            : (() => {
                throw new Error(
                  `Unsupported database URL "${trimmed}". Use sqlite://, postgres://, mysql://, mariadb://, sqlserver:// or oracle://.`,
                );
              })();

  const sslParam = parsed.searchParams.get('ssl') ?? parsed.searchParams.get('sslmode');
  const ssl = sslParam
    ? ['1', 'true', 'require', 'yes'].includes(sslParam.toLowerCase())
    : undefined;

  if (dialect === 'sqlserver') {
    const encryptParam = parsed.searchParams.get('encrypt');
    const trustParam = parsed.searchParams.get('trustServerCertificate');
    const asBool = (v: string | null): boolean | undefined =>
      v === null ? undefined : ['1', 'true', 'require', 'yes'].includes(v.toLowerCase());
    const instance = parsed.searchParams.get('instance') ?? parsed.searchParams.get('instanceName');
    const database = parsed.pathname
      ? decodeURIComponent(parsed.pathname.replace(/^\//, ''))
      : undefined;
    return {
      dialect,
      target: `${parsed.hostname ?? 'localhost'}:${parsed.port || '1433'}/${database ?? ''}`,
      host: parsed.hostname || 'localhost',
      // A named instance (SQLEXPRESS) negotiates its own port via SQL Browser.
      port: parsed.port ? Number(parsed.port) : instance ? undefined : 1433,
      database,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      ssl: asBool(encryptParam) ?? ssl,
      trustServerCertificate: asBool(trustParam),
      instanceName: instance || undefined,
    };
  }

  if (dialect === 'oracle') {
    const database = parsed.pathname ? decodeURIComponent(parsed.pathname.replace(/^\//, '')) : '';
    const sid = parsed.searchParams.get('sid') ?? undefined;
    const tcps = oracleProtocol === 'tcps' || ssl === true;
    return {
      dialect,
      target: `${parsed.hostname || 'localhost'}:${parsed.port || '1521'}/${database || sid || ''}`,
      host: parsed.hostname || 'localhost',
      port: parsed.port ? Number(parsed.port) : 1521,
      database: database || undefined,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      ssl: tcps,
      oracleProtocol: tcps ? 'tcps' : 'tcp',
      oracleSid: sid,
    };
  }

  return {
    dialect,
    target: `${parsed.hostname ?? 'localhost'}:${parsed.port ?? ''}/${parsed.pathname.replace(/^\//, '')}`,
    host: parsed.hostname ?? 'localhost',
    port: parsed.port ? Number(parsed.port) : dialect === 'mysql' ? 3306 : undefined,
    database: parsed.pathname ? decodeURIComponent(parsed.pathname.replace(/^\//, '')) : undefined,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ssl: ssl ?? false,
  };
}

export function createDatabaseDriver(url: string, safety: SafetyConfig = {}): DatabaseDriver {
  const conn = parseDatabaseUrl(url);
  switch (conn.dialect) {
    case 'sqlite':
      return new SqliteDriver(conn, safety);
    case 'postgres':
      return new PostgresDriver(conn, safety);
    case 'mysql':
      return new MysqlDriver(conn, safety);
    case 'sqlserver':
      return new SqlServerDriver(conn, safety);
    case 'oracle':
      return new OracleDriver(conn, safety);
  }
}

export { SqliteDriver, PostgresDriver, MysqlDriver, SqlServerDriver, OracleDriver };
