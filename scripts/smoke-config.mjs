/**
 * Smoke checks for dbagent.toml loading (run: npm run test:config).
 * No database or network needed — pure config-file behavior.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findConfigFile,
  initFileConfig,
  readConfigDoc,
  validateConfigDoc,
} from '../dist/core/config-file.js';
import { resolveConfig } from '../dist/core/config.js';

const TOUCHED = [
  'DBAGENT_CONFIG',
  'DBAGENT_PROVIDER',
  'DBAGENT_MODEL',
  'DBAGENT_DB_URL',
  'DBAGENT_ALLOW_WRITES',
  'DBAGENT_ALLOW_SYSTEM',
  'DBAGENT_MAX_ROWS',
  'DBAGENT_TEMPERATURE',
  'DBAGENT_API_KEY',
  'DBAGENT_BASE_URL',
  'OPENROUTER_API_KEY',
  'SMOKE_INTERP_KEY',
];
const saved = new Map();
for (const k of TOUCHED) saved.set(k, process.env[k]);
const restore = () => {
  for (const k of TOUCHED) {
    if (saved.get(k) === undefined) delete process.env[k];
    else process.env[k] = saved.get(k);
  }
};
const clearAll = () => {
  for (const k of TOUCHED) delete process.env[k];
};

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
  try {
    fn();
  } catch (err) {
    assert.match(err.message, re, `expected /${re}/, got: ${err.message}`);
    return;
  }
  throw new Error(`expected throw matching /${re}/`);
};

const dir = mkdtempSync(join(tmpdir(), 'dbagent-cfg-'));
const goodPath = join(dir, 'dbagent.toml');
writeFileSync(
  goodPath,
  `[llm]
provider = "openrouter"
model = "vendor/model"
temperature = 0.5
api_key = "\${SMOKE_INTERP_KEY:-fallback-key}"

[database]
url = "sqlite://./from-file.db"

[safety]
allow_writes = true

[limits]
max_rows = 42
`,
);
process.env.SMOKE_INTERP_KEY = 'interp-secret';

try {
  check('findConfigFile honors DBAGENT_CONFIG', () => {
    clearAll();
    process.env.DBAGENT_CONFIG = goodPath;
    assert.equal(findConfigFile(), goodPath);
  });

  check('initFileConfig backfills unset env vars', () => {
    clearAll();
    process.env.SMOKE_INTERP_KEY = 'interp-secret';
    const found = initFileConfig(goodPath);
    assert.equal(found, goodPath);
    assert.equal(process.env.DBAGENT_PROVIDER, 'openrouter');
    assert.equal(process.env.DBAGENT_MODEL, 'vendor/model');
    assert.equal(process.env.DBAGENT_DB_URL, 'sqlite://./from-file.db');
    assert.equal(process.env.DBAGENT_ALLOW_WRITES, '1');
    assert.equal(process.env.DBAGENT_MAX_ROWS, '42');
    assert.equal(process.env.DBAGENT_TEMPERATURE, '0.5');
    assert.equal(process.env.DBAGENT_API_KEY, 'interp-secret');
  });

  check('real environment wins over the file', () => {
    clearAll();
    process.env.SMOKE_INTERP_KEY = 'interp-secret';
    process.env.DBAGENT_MODEL = 'from-env';
    process.env.DBAGENT_MAX_ROWS = '7';
    initFileConfig(goodPath);
    assert.equal(process.env.DBAGENT_MODEL, 'from-env');
    assert.equal(process.env.DBAGENT_MAX_ROWS, '7');
    assert.equal(process.env.DBAGENT_PROVIDER, 'openrouter');
  });

  check('resolveConfig sees file values + generic api key', () => {
    clearAll();
    process.env.SMOKE_INTERP_KEY = 'interp-secret';
    initFileConfig(goodPath);
    const cfg = resolveConfig({});
    assert.equal(cfg.provider, 'openrouter');
    assert.equal(cfg.llm.model, 'vendor/model');
    assert.equal(cfg.llm.apiKey, 'interp-secret');
    assert.equal(cfg.dbUrl, 'sqlite://./from-file.db');
    assert.equal(cfg.allowWrites, true);
    assert.equal(cfg.maxRows, 42);
  });

  check('CLI flags still win over file + env', () => {
    clearAll();
    process.env.SMOKE_INTERP_KEY = 'interp-secret';
    initFileConfig(goodPath);
    const cfg = resolveConfig({ modelFlag: 'flag-model', dbUrlFlag: 'sqlite://./flag.db' });
    assert.equal(cfg.llm.model, 'flag-model');
    assert.equal(cfg.dbUrl, 'sqlite://./flag.db');
  });

  check('explicit missing file throws', () => {
    clearAll();
    throws(() => initFileConfig(join(dir, 'nope.toml')), /not found/);
  });

  check('malformed TOML throws with path', () => {
    const bad = join(dir, 'bad.toml');
    writeFileSync(bad, '[llm\nprovider = ');
    throws(() => readConfigDoc(bad), new RegExp('Invalid TOML'));
  });

  check('unknown key throws with did-you-mean', () => {
    throws(
      () => validateConfigDoc({ safety: { allow_write: true } }, 'f.toml'),
      /unknown key\. Did you mean "allow_writes"/,
    );
  });

  check('unknown section throws', () => {
    throws(() => validateConfigDoc({ server: {} }, 'f.toml'), /\[server\] unknown section/);
  });

  check('mistyped value throws', () => {
    throws(
      () => validateConfigDoc({ limits: { max_rows: 'many' } }, 'f.toml'),
      /must be a number, got string/,
    );
  });

  check('bad provider id throws', () => {
    throws(() => validateConfigDoc({ llm: { provider: 'skynet' } }, 'f.toml'), /expected one of/);
  });

  check('bad allow_ddl throws', () => {
    throws(
      () => validateConfigDoc({ safety: { allow_ddl: 'sometimes' } }, 'f.toml'),
      /expected off, dry-run, or on/,
    );
  });
} finally {
  restore();
}

console.log(passed === 12 ? '\nAll config checks passed ✓' : `\n${passed}/12 passed`);
