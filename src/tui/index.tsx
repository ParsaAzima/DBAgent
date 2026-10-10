/**
 * Bridge between the CLI and the Ink TUI: wires Agent/DB into <Tui> and
 * manages the session save hook.
 */

import React from 'react';
import { render } from 'ink';
import type { Agent } from '../core/agent.js';
import type { Skill } from '../core/skills.js';
import type { AgentHooks, DatabaseDriver, LLMProviderId } from '../core/types.js';
import { Tui } from './app.js';

export interface RenderTuiOptions {
  agent: Agent;
  db: DatabaseDriver;
  provider: LLMProviderId;
  model: string;
  allowWrites: boolean;
  /** Skip the y/n write gate (operator passed --yes). */
  assumeYes: boolean;
  /** Shared-by-reference hooks; the TUI installs its confirm gate here. */
  hooks: AgentHooks;
  maxRows: number;
  sessionLabel: string;
  /** Installed Agent Skills (slash-suggestions + /skills + /name invocation). */
  skills?: Skill[];
  /** Restored TUI transcript from a previous session. */
  initialItems?: unknown[];
  onModelSwitch?: (model: string) => void;
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
      assumeYes={opts.assumeYes}
      hooks={opts.hooks}
      maxRows={opts.maxRows}
      sessionLabel={opts.sessionLabel}
      skills={opts.skills}
      initialItems={opts.initialItems as never}
      onModelSwitch={opts.onModelSwitch}
      onSave={opts.onSave ?? undefined}
    />,
    { exitOnCtrlC: true },
  );
  return { waitUntilExit: waitUntilExit() as unknown as Promise<void> };
}
