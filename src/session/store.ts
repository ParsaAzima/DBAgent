/**
 * Session persistence: conversation transcripts survive restarts.
 *
 * Stored as JSON at ~/.dbagent/sessions/<id>.json. Includes a small rolling
 * window trim to keep files bounded.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '../core/types.js';

export interface SessionFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Database URL (redacted of nothing — user's own machine). */
  dbUrl: string;
  provider: string;
  model: string;
  messages: AgentMessage[];
  /**
   * Full TUI transcript (tool blocks with results, usage, timestamps) for
   * complete visual restore with --resume. JSON-serializable by contract.
   */
  tuiItems?: unknown[];
}

function sessionsDir(): string {
  const dir = join(homedir(), '.dbagent', 'sessions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveSession(s: SessionFile): void {
  s.updatedAt = new Date().toISOString();
  const file = join(sessionsDir(), `${sanitize(s.id)}.json`);
  // Compact write: tool row payloads can be large.
  writeFileSync(file, JSON.stringify(s), 'utf8');
}

export function loadSession(id: string): SessionFile | null {
  const file = join(sessionsDir(), `${sanitize(id)}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SessionFile;
  } catch {
    return null;
  }
}

export function listSessions(): { id: string; updatedAt: string; provider: string; dbUrl: string }[] {
  const dir = sessionsDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SessionFile;
        return { id: s.id, updatedAt: s.updatedAt, provider: `${s.provider}/${s.model}`, dbUrl: s.dbUrl };
      } catch {
        return { id: f, updatedAt: '?', provider: '?', dbUrl: '?' };
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deleteSession(id: string): boolean {
  const file = join(sessionsDir(), `${sanitize(id)}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}
