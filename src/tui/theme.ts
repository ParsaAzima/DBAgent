import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TuiTheme {
  name: string;
  style: string;
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  accentSecondary: string;
  user: string;
  assistant: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  code: string;
  table: string;
}

export const THEMES = {
  'catppuccin-mocha': {
    name: 'catppuccin-mocha',
    style: 'تیره مدرن',
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    muted: '#9399b2',
    accent: '#89b4fa',
    accentSecondary: '#cba6f7',
    user: '#89b4fa',
    assistant: '#a6e3a1',
    success: '#a6e3a1',
    warning: '#f9e2af',
    error: '#f38ba8',
    info: '#94e2d5',
    code: '#f9e2af',
    table: '#89b4fa',
  },
  dracula: {
    name: 'dracula',
    style: 'تیره رنگارنگ',
    background: '#282a36',
    foreground: '#f8f8f2',
    muted: '#a0a0b0',
    accent: '#8be9fd',
    accentSecondary: '#bd93f9',
    user: '#8be9fd',
    assistant: '#50fa7b',
    success: '#50fa7b',
    warning: '#f1fa8c',
    error: '#ff5555',
    info: '#8be9fd',
    code: '#f1fa8c',
    table: '#8be9fd',
  },
  'tokyo-night': {
    name: 'tokyo-night',
    style: 'آبی مدرن',
    background: '#1a1b26',
    foreground: '#c0caf5',
    muted: '#787c99',
    accent: '#7aa2f7',
    accentSecondary: '#bb9af7',
    user: '#7aa2f7',
    assistant: '#9ece6a',
    success: '#9ece6a',
    warning: '#e0af68',
    error: '#f7768e',
    info: '#7dcfff',
    code: '#e0af68',
    table: '#7aa2f7',
  },
  'one-dark': {
    name: 'one-dark',
    style: 'عمومی',
    background: '#282c34',
    foreground: '#abb2bf',
    muted: '#7f848e',
    accent: '#61afef',
    accentSecondary: '#c678dd',
    user: '#61afef',
    assistant: '#98c379',
    success: '#98c379',
    warning: '#e5c07b',
    error: '#e06c75',
    info: '#56b6c2',
    code: '#e5c07b',
    table: '#61afef',
  },
  nord: {
    name: 'nord',
    style: 'مینیمال',
    background: '#2e3440',
    foreground: '#d8dee9',
    muted: '#8b95a7',
    accent: '#88c0d0',
    accentSecondary: '#b48ead',
    user: '#88c0d0',
    assistant: '#a3be8c',
    success: '#a3be8c',
    warning: '#ebcb8b',
    error: '#bf616a',
    info: '#81a1c1',
    code: '#ebcb8b',
    table: '#88c0d0',
  },
  'gruvbox-dark': {
    name: 'gruvbox-dark',
    style: 'گرم',
    background: '#282828',
    foreground: '#ebdbb2',
    muted: '#a89984',
    accent: '#83a598',
    accentSecondary: '#d3869b',
    user: '#83a598',
    assistant: '#b8bb26',
    success: '#b8bb26',
    warning: '#fabd2f',
    error: '#fb4934',
    info: '#8ec07c',
    code: '#fabd2f',
    table: '#83a598',
  },
  'solarized-dark': {
    name: 'solarized-dark',
    style: 'متعادل',
    background: '#002b36',
    foreground: '#839496',
    muted: '#657b83',
    accent: '#268bd2',
    accentSecondary: '#6c71c4',
    user: '#268bd2',
    assistant: '#859900',
    success: '#859900',
    warning: '#b58900',
    error: '#dc322f',
    info: '#2aa198',
    code: '#b58900',
    table: '#268bd2',
  },
  monokai: {
    name: 'monokai',
    style: 'کدنویسی',
    background: '#272822',
    foreground: '#f8f8f2',
    muted: '#a6a69c',
    accent: '#66d9ef',
    accentSecondary: '#ae81ff',
    user: '#66d9ef',
    assistant: '#a6e22e',
    success: '#a6e22e',
    warning: '#e6db74',
    error: '#f92672',
    info: '#66d9ef',
    code: '#e6db74',
    table: '#66d9ef',
  },
  kanagawa: {
    name: 'kanagawa',
    style: 'هنری',
    background: '#1f1f28',
    foreground: '#dcd7ba',
    muted: '#727169',
    accent: '#7e9cd8',
    accentSecondary: '#957fb8',
    user: '#7e9cd8',
    assistant: '#98bb6c',
    success: '#98bb6c',
    warning: '#e6c384',
    error: '#e82424',
    info: '#7fb4ca',
    code: '#e6c384',
    table: '#7e9cd8',
  },
  'github-dark': {
    name: 'github-dark',
    style: 'توسعه‌دهنده‌محور',
    background: '#0d1117',
    foreground: '#e6edf3',
    muted: '#8b949e',
    accent: '#58a6ff',
    accentSecondary: '#d2a8ff',
    user: '#58a6ff',
    assistant: '#3fb950',
    success: '#3fb950',
    warning: '#d29922',
    error: '#f85149',
    info: '#79c0ff',
    code: '#e3b341',
    table: '#58a6ff',
  },
  'github-light': {
    name: 'github-light',
    style: 'روشن',
    background: '#ffffff',
    foreground: '#1f2328',
    muted: '#656d76',
    accent: '#0969da',
    accentSecondary: '#8250df',
    user: '#0969da',
    assistant: '#1a7f37',
    success: '#1a7f37',
    warning: '#9a6700',
    error: '#cf222e',
    info: '#0550ae',
    code: '#9a6700',
    table: '#0969da',
  },
  'catppuccin-latte': {
    name: 'catppuccin-latte',
    style: 'روشن پاستلی',
    background: '#eff1f5',
    foreground: '#4c4f69',
    muted: '#7c7f93',
    accent: '#1e66f5',
    accentSecondary: '#8839ef',
    user: '#1e66f5',
    assistant: '#40a02b',
    success: '#40a02b',
    warning: '#df8e1d',
    error: '#d20f39',
    info: '#179299',
    code: '#df8e1d',
    table: '#1e66f5',
  },
} satisfies Record<string, TuiTheme>;

export type ThemeName = keyof typeof THEMES;
export const DEFAULT_THEME: ThemeName = 'catppuccin-mocha';

const THEME_FILE = join(homedir(), '.dbagent', 'theme');

export function isThemeName(name: string): name is ThemeName {
  return Object.hasOwn(THEMES, name);
}

export function parseThemeName(name: string): ThemeName {
  if (!isThemeName(name)) {
    throw new Error(`Unknown theme "${name}". Available themes: ${Object.keys(THEMES).join(', ')}`);
  }
  return name;
}

export function getTheme(name: string): TuiTheme {
  return isThemeName(name) ? THEMES[name] : THEMES[DEFAULT_THEME];
}

export function loadTheme(path = THEME_FILE): ThemeName {
  const fromEnv = process.env.DBAGENT_THEME?.trim();
  if (fromEnv) return parseThemeName(fromEnv);
  if (!existsSync(path)) return DEFAULT_THEME;
  try {
    const stored = readFileSync(path, 'utf8').trim();
    return stored ? parseThemeName(stored) : DEFAULT_THEME;
  } catch (err) {
    throw new Error(
      `Cannot read saved TUI theme at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function saveTheme(name: string, path = THEME_FILE): ThemeName {
  const themeName = parseThemeName(name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${themeName}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return themeName;
}
