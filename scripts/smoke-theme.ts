import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_THEME,
  getTheme,
  isThemeName,
  loadTheme,
  saveTheme,
  THEMES,
} from '../src/tui/theme.js';

const dir = mkdtempSync(join(tmpdir(), 'dbagent-theme-'));
const file = join(dir, 'settings', 'theme');
const previousEnv = process.env.DBAGENT_THEME;
let passed = 0;

const check = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

try {
  delete process.env.DBAGENT_THEME;

  check('all requested themes are present with complete palettes', () => {
    const expected = [
      'catppuccin-mocha',
      'dracula',
      'tokyo-night',
      'one-dark',
      'nord',
      'gruvbox-dark',
      'solarized-dark',
      'monokai',
      'kanagawa',
      'github-dark',
      'github-light',
      'catppuccin-latte',
    ];
    assert.deepEqual(Object.keys(THEMES), expected);
    for (const theme of Object.values(THEMES)) {
      assert.match(theme.background, /^#[0-9a-f]{6}$/i);
      assert.match(theme.foreground, /^#[0-9a-f]{6}$/i);
      assert.ok(theme.accent && theme.error && theme.success && theme.code && theme.table);
      assert.doesNotMatch(theme.style, /\p{Script=Arabic}/u);
    }
  });

  check('default theme and unknown-name validation', () => {
    assert.equal(DEFAULT_THEME, 'catppuccin-mocha');
    assert.equal(isThemeName('github-light'), true);
    assert.equal(isThemeName('unknown-theme'), false);
    assert.equal(getTheme('unknown-theme').name, DEFAULT_THEME);
    assert.throws(() => saveTheme('unknown-theme', file), /Unknown theme/);
  });

  check('theme can be saved and loaded from user settings', () => {
    assert.equal(saveTheme('nord', file), 'nord');
    assert.equal(loadTheme(file), 'nord');
  });

  check('DBAGENT_THEME overrides the saved theme', () => {
    process.env.DBAGENT_THEME = 'dracula';
    assert.equal(loadTheme(file), 'dracula');
  });

  check('invalid explicit environment theme reports an error', () => {
    process.env.DBAGENT_THEME = 'not-a-theme';
    assert.throws(() => loadTheme(file), /Unknown theme/);
  });
} finally {
  if (previousEnv === undefined) delete process.env.DBAGENT_THEME;
  else process.env.DBAGENT_THEME = previousEnv;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed}/5 theme checks passed`);
