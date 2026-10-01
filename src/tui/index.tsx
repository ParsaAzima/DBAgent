/**
 * Bridge between the CLI and the Ink TUI: wires Agent/DB into <Tui> and
 * manages the session save hook.
 */

import React from 'react';
import { render } from 'ink';
import type { Agent } from '../core/agent.js';
import type { DatabaseDriver, LLMProviderId } from '../core/types.js';
import { Tui } from './app.js';

export interface RenderTuiOptions {
  agent: Agent;
  db: DatabaseDriver;
  provider: LLMProviderId;
  model: string;
  allowWrites: boolean;
  maxRows: number;
  sessionLabel: string;
  /** Restored TUI transcript from a previous session. */
  initialItems?: unknown[];
  onSave?: (transcript?: unknown[]) => void;
}


export function renderTui(opts: RenderTuiOptions): { waitUntilExit: Promise<void> } {
  const { waitUntilExit } = render(
    <Tui
      agent={opts.agent}
      db={opts.db}
      provider={opts.provider}
      model={opts.model}
      allowWrites={opts.allowWrites}
      maxRows={opts.maxRows}
      sessionLabel={opts.sessionLabel}
      initialItems={opts.initialItems as never}
      onSave={opts.onSave ?? undefined}
    />,
    { exitOnCtrlC: true },
  );
  return { waitUntilExit: waitUntilExit() as unknown as Promise<void> };
}
