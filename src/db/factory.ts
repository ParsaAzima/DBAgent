/**
 * Database driver factory: parses connection URLs and instantiates drivers.
 *
 * Supported URL forms:
 *   sqlite://./path/to/file.db        (also sqlite:///abs/path and file: URLs)
 *   postgres://user:pass@host:5432/db (ssl: ?ssl=true)
 *   postgresql://...                  (alias)
 *   mysql://user:pass@host:3306/db    (ssl: ?ssl=true)
 */

import type { DatabaseConnection, DatabaseDialect, DatabaseDriver, SafetyConfig } from '../core/types.js';
import { SqliteDriver } from './sqlite.js';
import { PostgresDriver } from './postgres.js';
import { MysqlDriver } from './mysql.js';

export function parseDatabaseUrl(url: string): DatabaseConnection {
  const trimmed = url.trim();

  if (trimmed.startsWith('sqlite://') || trimmed.startsWith('file:')) {
    let target = trimmed
      .replace(/^sqlite:\/\//, '')
      .replace(/^file:\/\//, '')
      .replace(/^file:/, '');
    if (target.startsWith('/')) {
      // sqlite:///abs/path.db keeps the absolute path; sqlite://./x.db does not
      if (!trimmed.startsWith('sqlite:////') && !trimmed.startsWith('file:////') && target.match(/^\/[A-Za-z]:/)) {
        // windows drive path like /C:/x.db — strip leading slash
        target = target.slice(1);
      }
    }
    return { dialect: 'sqlite', target: target || ':memory:' };
  }

  const parsed = new URL(trimmed);
  const dialect: DatabaseDialect =
    parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:'
      ? 'postgres'
      : parsed.protocol === 'mysql:' || parsed.protocol === 'mariadb:'
        ? 'mysql'
        : (() => {
            throw new Error(
              `Unsupported database URL "${trimmed}". Use sqlite://, postgres:// or mysql://.`,
            );
          })();

  const sslParam = parsed.searchParams.get('ssl') ?? parsed.searchParams.get('sslmode');
  const ssl = sslParam ? ['1', 'true', 'require', 'yes'].includes(sslParam.toLowerCase()) : false;

  return {
    dialect,
    target: `${parsed.hostname ?? 'localhost'}:${parsed.port ?? ''}/${parsed.pathname.replace(/^\//, '')}`,
    host: parsed.hostname ?? 'localhost',
    port: parsed.port ? Number(parsed.port) : undefined,
    database: parsed.pathname ? decodeURIComponent(parsed.pathname.replace(/^\//, '')) : undefined,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ssl,
  };
}

export function createDatabaseDriver(
  url: string,
  safety: SafetyConfig = {},
): DatabaseDriver {
  const conn = parseDatabaseUrl(url);
  switch (conn.dialect) {
    case 'sqlite':
      return new SqliteDriver(conn, safety);
    case 'postgres':
      return new PostgresDriver(conn, safety);
    case 'mysql':
      return new MysqlDriver(conn, safety);
  }
}

export { SqliteDriver, PostgresDriver, MysqlDriver };
