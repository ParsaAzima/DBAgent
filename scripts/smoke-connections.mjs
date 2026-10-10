/**
 * Smoke checks for saved database connections (run: npm run test:config).
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConnections,
  removeConnection,
  resolveConnectionUrl,
  saveConnection,
  selectedConnectionUrl,
  setDefaultConnection,
  validateConnectionName,
} from '../dist/core/connections.js';

const dir = mkdtempSync(join(tmpdir(), 'dbagent-connections-'));
const path = join(dir, 'connections.json');
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};
const throws = (fn, re) => {
  assert.throws(fn, re);
};

try {
  check('missing file starts with no saved connections', () => {
    assert.deepEqual(loadConnections(path), { version: 1, connections: {} });
  });

  check('save and resolve a named database URL', () => {
    saveConnection('analytics', 'postgres://user:secret@localhost/db', false, path);
    assert.equal(resolveConnectionUrl('analytics', path), 'postgres://user:secret@localhost/db');
    assert.equal(
      resolveConnectionUrl('postgres://localhost/other', path),
      'postgres://localhost/other',
    );
  });

  check('default connection is persisted and selected', () => {
    saveConnection('local', 'sqlite://./app.db', true, path);
    assert.equal(loadConnections(path).default, 'local');
    assert.equal(selectedConnectionUrl(undefined, undefined, path), 'sqlite://./app.db');
  });

  check('explicit URL and saved alias beat the default', () => {
    assert.equal(
      selectedConnectionUrl('analytics', undefined, path),
      'postgres://user:secret@localhost/db',
    );
    assert.equal(
      selectedConnectionUrl('sqlite://./explicit.db', undefined, path),
      'sqlite://./explicit.db',
    );
  });

  check('environment URL wins over saved default', () => {
    assert.equal(selectedConnectionUrl(undefined, 'postgres://env/db', path), 'postgres://env/db');
  });

  check('switching default requires a saved connection', () => {
    setDefaultConnection('analytics', path);
    assert.equal(loadConnections(path).default, 'analytics');
    throws(() => setDefaultConnection('missing', path), /not found/);
  });

  check('removing the default clears it', () => {
    assert.equal(removeConnection('analytics', path), true);
    assert.equal(loadConnections(path).default, undefined);
    assert.equal(removeConnection('analytics', path), false);
  });

  check('connection names reject unsafe characters', () => {
    throws(() => validateConnectionName('../secret'), /Connection name/);
    throws(() => saveConnection('bad name', 'sqlite://./app.db', false, path), /Connection name/);
    assert.equal(resolveConnectionUrl('toString', path), 'toString');
    throws(() => setDefaultConnection('constructor', path), /not found/);
  });

  check('malformed connection file fails explicitly', () => {
    writeFileSync(path, '{');
    throws(() => loadConnections(path), /Cannot read saved database connections/);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(passed === 9 ? '\nAll database connection checks passed ✓' : `${passed}/9 passed`);
