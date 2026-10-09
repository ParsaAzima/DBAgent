/**
 * Audit log: every SQL statement the agent runs through its tools is
 * appended as one JSON line to ~/.dbagent/audit.log (overridable via
 * DBAGENT_AUDIT_FILE, which the test suite uses).
 *
 * Best-effort by design: logging must never break a turn, so all errors
 * are swallowed.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuditDraft, AuditEntry, AuditSink } from '../core/types.js';

export function auditLogPath(): string {
  const override = process.env.DBAGENT_AUDIT_FILE?.trim();
  if (override) return override;
  return join(homedir(), '.dbagent', 'audit.log');
}

/** Append one entry as JSONL. Never throws. */
export function appendAudit(entry: AuditDraft & { sessionId: string; dbTarget: string }): void {
  try {
    const file = auditLogPath();
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
    appendFileSync(file, JSON.stringify(full) + '\n', 'utf8');
  } catch {
    /* audit must never break the agent turn */
  }
}

/** Sink bound to one session; redacts nothing (callers pass redacted targets). */
export function createAuditSink(opts: { sessionId: string; dbTarget: string }): AuditSink {
  return (draft) => {
    appendAudit({ ...draft, sessionId: opts.sessionId, dbTarget: opts.dbTarget });
  };
}
