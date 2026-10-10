/**
 * Bridge between the CLI and the Ink TUI: wires Agent/DB into <Tui> and
 * manages the session save hook.
 */

import React from 'react';
import { render } from 'ink';
import type { Agent } from '../core/agent.js';
import type { Skill } from '../core/skills.js';
import type { AgentHooks, DatabaseDriver } from '../core/types.js';
import { Tui } from './app.js';
import type { ThemeName } from './theme.js';

export interface RenderTuiOptions {
  agent: Agent;
  db: DatabaseDriver;
  provider: string;
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
  initialTheme?: ThemeName;
  onThemeSwitch?: (name: string) => void;
  /** Restored TUI transcript from a previous session. */
  initialItems?: unknown[];
  onModelSwitch?: (model: string) => void;
  onListModels?: () => Promise<string[]>;
  onSave?: (transcript?: unknown[]) => void;
  /** Use the terminal's alternate screen buffer instead of the scrollback. */
  fullScreen?: boolean;
}

export function renderTui(opts: RenderTuiOptions): { waitUntilExit: Promise<void> } {
  const fullScreen =
    opts.fullScreen ??
    (Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== 'dumb');
  if (fullScreen) process.stdout.write('\u001B[?1049h\u001B[2J\u001B[H');

  try {
    const app = render(
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
        initialTheme={opts.initialTheme}
        onThemeSwitch={opts.onThemeSwitch}
        initialItems={opts.initialItems as never}
        onModelSwitch={opts.onModelSwitch}
        onListModels={opts.onListModels}
        onSave={opts.onSave ?? undefined}
      />,
      { exitOnCtrlC: true },
    );
    const waitUntilExit = app.waitUntilExit().finally(() => {
      if (fullScreen) process.stdout.write('\u001B[?1049l\u001B[?25h');
    });
    return { waitUntilExit: waitUntilExit as unknown as Promise<void> };
  } catch (error) {
    if (fullScreen) process.stdout.write('\u001B[?1049l\u001B[?25h');
    throw error;
  }
}
