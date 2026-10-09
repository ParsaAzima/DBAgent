/**
 * DBAgent TUI (Ink + React) — opencode / Claude Code class.
 *
 *  • Banner + persistent status footer (model · mode · tokens · live cost)
 *  • Streaming markdown answers token by token (esc aborts)
 *  • Collapsible tool blocks — ctrl+t toggles detail expansion on transcript
 *  • Interactive table viewer — ctrl+o over the latest result
 *  • Live usage: tokens in/out + estimated USD cost per turn and session
 *  • Full transcript passed to onSave for complete session restore
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Agent, AgentTurnResult } from '../core/agent.js';
import type {
  AgentHooks,
  AgentTurnEvent,
  LLMProviderId,
  TokenUsage,
  WriteConfirmRequest,
} from '../core/types.js';
import type { DatabaseDriver } from '../core/types.js';
import { Transcript, LiveTurn, StatusBar } from './components.js';
import { TableView, pickLatestTable } from './table-viewer.js';
import { ChatInput } from './input.js';
import { findSlashCommand, SLASH_COMMANDS } from './commands.js';
import type { TranscriptItem, ToolRun, UsageInfo, TurnUsage } from './foundation.js';
import {
  usageToInfo,
  fmtTokens,
  fmtCost,
  fmtDuration,
  argsSummaryOf,
  previewOf,
} from './foundation.js';

export interface TuiProps {
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
  /** Restored transcript from a previous session (rendered before anything). */
  initialItems?: TranscriptItem[];
  onModelSwitch?: (model: string) => void;
  /** Called with the FULL transcript (incl. tool data + usage) after each turn. */
  onSave?: (items: TranscriptItem[]) => void;
}

const EMPTY_USAGE: UsageInfo = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
const HINTS =
  'esc stop · ctrl+t tool details · ctrl+o table view · / for commands · /help for help';

interface Live {
  text: string;
  tools: ToolRun[];
  round: number;
  startedAt: number;
  usage: UsageInfo;
  busy: boolean;
}
const IDLE: Live = { text: '', tools: [], round: 0, startedAt: 0, usage: EMPTY_USAGE, busy: false };

export function Tui(props: TuiProps): React.ReactElement {
  const { exit } = useApp();
  const [items, setItems] = useState<TranscriptItem[]>(props.initialItems ?? []);
  const [live, setLive] = useState<Live>(IDLE);
  const [model, setModel] = useState(props.model);
  const [totals, setTotals] = useState<UsageInfo>(EMPTY_USAGE);
  const [showTable, setShowTable] = useState(false);
  const [toolDetail, setToolDetail] = useState(false);
  const [tick, setTick] = useState(0);
  /** Pending write approval: resolves the confirm gate on y/n. */
  const [pending, setPending] = useState<{
    req: WriteConfirmRequest;
    resolve: (v: boolean) => void;
  } | null>(null);
  const pendingRef = useRef<typeof pending>(null);
  pendingRef.current = pending;
  const abortRef = useRef<AbortController | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Saved history is separate so clearing the screen does not erase the session.
  const transcriptRef = useRef<TranscriptItem[]>(props.initialItems ?? []);
  const modelRef = useRef(model);
  modelRef.current = model;

  // re-render for the elapsed-time clock while busy
  useEffect(() => {
    if (!live.busy) return;
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, [live.busy]);

  const push = useCallback((item: TranscriptItem) => {
    transcriptRef.current = [...transcriptRef.current, item];
    setItems((prev) => [...prev, item]);
  }, []);

  /* ── write-approval gate: y/n answers resolve the tool's confirm hook ── */
  const confirmGate = useCallback(
    (req: WriteConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setPending({ req, resolve });
      }),
    [],
  );
  useEffect(() => {
    if (props.assumeYes) return;
    const prev = props.hooks.confirm;
    props.hooks.confirm = confirmGate;
    return () => {
      if (props.hooks.confirm === confirmGate) props.hooks.confirm = prev;
    };
  }, [confirmGate, props.assumeYes, props.hooks]);

  const answerPending = useCallback(
    (approved: boolean) => {
      const p = pendingRef.current;
      if (!p) return;
      setPending(null);
      push({
        role: 'info',
        text: approved ? `✓ confirmed ${p.req.tool}` : `✗ denied ${p.req.tool} — statement not run`,
      });
      p.resolve(approved);
    },
    [push],
  );

  /* ── banner ── */
  useEffect(() => {
    push({
      role: 'info',
      text:
        `╭──────────────────────────────────────────╮\n` +
        `│  DBAgent — AI for your databases         │\n` +
        `╰──────────────────────────────────────────╯`,
    });
    push({ role: 'info', text: `${props.db.describeTarget()} · session ${props.sessionLabel}` });
  }, []);

  const accumulate = useCallback((u: TokenUsage) => {
    setTotals((prev) => {
      const info = usageToInfo(modelRef.current, u);
      return {
        inputTokens: prev.inputTokens + info.inputTokens,
        outputTokens: prev.outputTokens + info.outputTokens,
        costUsd: prev.costUsd + info.costUsd,
      };
    });
  }, []);

  const handleEvent = useCallback(
    (ev: AgentTurnEvent, acc: Live) => {
      switch (ev.kind) {
        case 'text_delta':
          acc.text += ev.text;
          break;
        case 'tool_start':
          acc.tools = [
            ...acc.tools,
            {
              id: ev.id,
              name: ev.name,
              status: 'running' as const,
              argsSummary: argsSummaryOf(ev.name, ev.args),
              data: ev.name === 'query' || ev.name === 'sample_rows' ? undefined : undefined,
            },
          ];
          break;
        case 'tool_done': {
          acc.tools = acc.tools.map((t) =>
            t.id === ev.id
              ? {
                  ...t,
                  status: ev.ok ? ('ok' as const) : ('error' as const),
                  durationMs: ev.durationMs,
                  preview: previewOf(ev.data, ev.preview),
                  data: ev.data,
                }
              : t,
          );
          break;
        }
        case 'usage':
          accumulate(ev.usage);
          acc.usage = {
            inputTokens: acc.usage.inputTokens + (ev.usage.promptTokens ?? 0),
            outputTokens: acc.usage.outputTokens + (ev.usage.completionTokens ?? 0),
            costUsd: acc.usage.costUsd + usageToInfo(modelRef.current, ev.usage).costUsd,
          };
          break;
        case 'round_done':
          acc.round = ev.round;
          break;
      }
      setLive({ ...acc, busy: true });
    },
    [accumulate],
  );

  const runTurn = useCallback(
    async (input: string) => {
      const acc: Live = {
        text: '',
        tools: [],
        round: 1,
        startedAt: Date.now(),
        usage: EMPTY_USAGE,
        busy: true,
      };
      setLive(acc);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const result: AgentTurnResult = await props.agent.runTurnStream(input, {
          signal: ctrl.signal,
          onEvent: (ev) => handleEvent(ev, acc),
        });
        const turn: TurnUsage = {
          model: modelRef.current,
          rounds: result.rounds,
          durationMs: Date.now() - acc.startedAt,
          usage: acc.usage,
          entries: [],
        };
        const doneItem: TranscriptItem = {
          role: 'assistant',
          text: result.text,
          tools: acc.tools,
          turn,
          ts: Date.now(),
        };
        push(doneItem);
        // Auto-persist the full transcript after every completed turn.
        props.onSave?.(transcriptRef.current);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (ctrl.signal.aborted) push({ role: 'info', text: '· cancelled' });
        else push({ role: 'error', text: message });
      } finally {
        abortRef.current = null;
        setLive(IDLE);
      }
    },
    [props.agent, props.onSave, push, handleEvent],
  );

  const handleSubmit = useCallback(
    async (raw: string) => {
      const input = raw.trim();
      if (!input) return;
      if (live.busy || pendingRef.current) return;

      if (input.startsWith('/')) {
        const parsed = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input);
        if (!parsed) {
          push({ role: 'error', text: 'Invalid command. Type /help to see available commands.' });
          return;
        }
        const command = findSlashCommand(parsed[1]);
        if (!command) {
          push({
            role: 'error',
            text: `Unknown command: /${parsed[1]}. Type /help to see available commands.`,
          });
          return;
        }
        const args = parsed[2]?.trim() ?? '';
        if (args && command.name !== 'help' && command.name !== 'model') {
          push({ role: 'error', text: `/${command.name} does not take arguments.` });
          return;
        }

        switch (command.name) {
          case 'help': {
            if (args) {
              const requested = args.replace(/^\//, '').split(/\s/)[0];
              const target = findSlashCommand(requested);
              if (!target) {
                push({
                  role: 'error',
                  text: `Unknown command: ${args}. Type /help to list commands.`,
                });
                return;
              }
              push({
                role: 'info',
                text: `/${target.name}${target.usage ? ` ${target.usage}` : ''}\n${target.description}${
                  target.aliases
                    ? `\nAliases: ${target.aliases.map((alias) => `/${alias}`).join(', ')}`
                    : ''
                }`,
              });
              return;
            }
            push({
              role: 'info',
              text:
                'Slash commands (type / and use ↑/↓, Tab, or Enter to complete):\n' +
                SLASH_COMMANDS.map(
                  (entry) =>
                    `/${entry.name}${entry.usage ? ` ${entry.usage}` : ''} — ${entry.description}`,
                ).join('\n') +
                '\n\nKeyboard: Esc stop · ctrl+t tool details · ctrl+o table viewer · ctrl+l clear transcript.',
            });
            return;
          }
          case 'clear':
            setItems([]);
            return;
          case 'exit':
            props.onSave?.(transcriptRef.current);
            exit();
            return;
          case 'model':
            if (!args) {
              push({ role: 'info', text: `current model: ${props.provider}/${model}` });
              return;
            }
            try {
              if (!props.onModelSwitch) {
                throw new Error('Model switching is unavailable in this TUI instance.');
              }
              props.onModelSwitch(args);
              setModel(args);
              push({ role: 'info', text: `✓ model → ${args}` });
            } catch (err) {
              push({ role: 'error', text: (err as Error).message });
            }
            return;
          case 'schema':
            try {
              const tables = await props.db.listTables();
              const shown = tables.slice(0, 50);
              const lines = shown
                .map(
                  (t) =>
                    `▎${t.name} (${t.kind}, ~${t.rowCountEstimate ?? '?'} rows)\n` +
                    t.columns
                      .map(
                        (c) =>
                          `   ${c.name}: ${c.dataType}${c.isPrimaryKey ? ' ⚿' : ''}${c.nullable ? '' : ' ∗'}`,
                      )
                      .join('\n'),
                )
                .join('\n');
              let text = lines || '(no tables)';
              if (tables.length > shown.length) {
                text += `\n… and ${tables.length - shown.length} more tables (ask the agent or use search via chat).`;
              }
              try {
                const relations = await props.db.listRelations();
                if (relations.length > 0) {
                  text +=
                    '\nRelations:\n' +
                    relations
                      .map((r) => `  ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`)
                      .join('\n');
                }
              } catch {
                /* FK catalog may be unreadable; tables above are enough */
              }
              push({ role: 'info', text });
            } catch (err) {
              push({ role: 'error', text: (err as Error).message });
            }
            return;
          case 'refresh':
            try {
              await props.db.refreshSchema();
              const tables = await props.db.listTables();
              push({ role: 'info', text: `✓ Schema refreshed (${tables.length} tables/views)` });
            } catch (err) {
              push({ role: 'error', text: (err as Error).message });
            }
            return;
          case 'save': {
            push({ role: 'info', text: '✓ session saved' });
            props.onSave?.(transcriptRef.current);
            return;
          }
          case 'reset':
            props.agent.reset();
            transcriptRef.current = [];
            setItems([]);
            setTotals(EMPTY_USAGE);
            return;
          case 'status':
            push({
              role: 'info',
              text:
                `Provider/model: ${props.provider}/${model}\n` +
                `Database: ${props.db.dialect} · ${props.db.describeTarget()}\n` +
                `Mode: ${props.allowWrites ? 'read + write' : 'read-only'}\n` +
                `Session: ${props.sessionLabel}\n` +
                `Conversation messages: ${props.agent.getHistory().length}\n` +
                `Transcript items: ${itemsRef.current.length}`,
            });
            return;
          case 'cost':
            push({
              role: 'info',
              text:
                `Model: ${props.provider}/${model}\n` +
                `Tokens: ${fmtTokens(totals.inputTokens)} in / ${fmtTokens(totals.outputTokens)} out\n` +
                `Estimated cost: ${fmtCost(totals.costUsd)}`,
            });
            return;
        }
      }

      push({ role: 'user', text: input, ts: Date.now() });
      await runTurn(input);
    },
    [props, push, runTurn, model, live.busy, exit, totals],
  );

  useInput((input, key) => {
    if (pendingRef.current) {
      if (input === 'y' || input === 'Y') answerPending(true);
      else if (input === 'n' || input === 'N' || key.escape) answerPending(false);
      return;
    }
    if (key.escape && live.busy) {
      abortRef.current?.abort();
      return;
    }
    if (key.ctrl && input === 't') setToolDetail((v) => !v);
    if (key.ctrl && input === 'o') {
      const t = pickLatestTable([...live.tools, ...items.flatMap((i) => i.tools ?? [])]);
      if (t) setShowTable(true);
    }
    if (key.ctrl && input === 'l') {
      setItems([]);
    }
  });

  const elapsed = live.busy ? Date.now() - live.startedAt : 0;
  void tick; // re-render driver

  return (
    <Box flexDirection="column">
      <Transcript items={items} />
      {live.busy ? (
        <LiveTurn
          text={live.text}
          tools={live.tools}
          elapsedMs={elapsed}
          usage={live.usage}
          round={live.round}
        />
      ) : null}

      {showTable ? (
        <TableView
          result={pickLatestTable([...live.tools, ...items.flatMap((i) => i.tools ?? [])])!}
          onClose={() => setShowTable(false)}
        />
      ) : pending ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>
            Confirm {pending.req.tool} ({pending.req.kind}
            {pending.req.tables.length > 0 ? ` on ${pending.req.tables.join(', ')}` : ''})
          </Text>
          {pending.req.impactEstimate ? <Text>Impact: {pending.req.impactEstimate}</Text> : null}
          {pending.req.noWhereWarning ? (
            <Text color="red">WARNING: no WHERE clause — this affects the whole table!</Text>
          ) : null}
          <Text>
            SQL:{' '}
            {pending.req.sql.length > 400 ? pending.req.sql.slice(0, 400) + '…' : pending.req.sql}
          </Text>
          <Text>
            Press <Text bold>y</Text> to run · <Text bold>n</Text> to deny
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <ChatInput onSubmit={handleSubmit} disabled={live.busy} />
        </Box>
      )}

      <StatusBar
        provider={props.provider}
        model={model}
        readOnly={!props.allowWrites}
        sessionLabel={props.sessionLabel}
        totals={totals}
        hints={HINTS}
      />
    </Box>
  );
}
