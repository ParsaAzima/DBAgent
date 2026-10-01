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
import type { AgentTurnEvent, LLMProviderId, TokenUsage } from '../core/types.js';
import type { DatabaseDriver } from '../core/types.js';
import { Transcript, LiveTurn, StatusBar } from './components.js';
import { TableView, pickLatestTable } from './table-viewer.js';
import { ChatInput } from './input.js';
import type { TranscriptItem, ToolRun, UsageInfo, TurnUsage } from './foundation.js';
import { usageToInfo, fmtTokens, fmtCost, fmtDuration, argsSummaryOf, previewOf } from './foundation.js';

export interface TuiProps {
  agent: Agent;
  db: DatabaseDriver;
  provider: LLMProviderId;
  model: string;
  allowWrites: boolean;
  maxRows: number;
  sessionLabel: string;
  /** Restored transcript from a previous session (rendered before anything). */
  initialItems?: TranscriptItem[];
  onModelSwitch?: (model: string) => void;
  /** Called with the FULL transcript (incl. tool data + usage) after each turn. */
  onSave?: (items: TranscriptItem[]) => void;
}

const EMPTY_USAGE: UsageInfo = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
const HINTS = 'esc stop · ctrl+t tool details · ctrl+o table view · /model · /schema · /help · /exit';

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
  const abortRef = useRef<AbortController | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const modelRef = useRef(model);
  modelRef.current = model;

  // re-render for the elapsed-time clock while busy
  useEffect(() => {
    if (!live.busy) return;
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, [live.busy]);

  const push = useCallback((item: TranscriptItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const acc: Live = { text: '', tools: [], round: 1, startedAt: Date.now(), usage: EMPTY_USAGE, busy: true };
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
        props.onSave?.([...itemsRef.current, doneItem]);
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
      if (live.busy) return;

      if (input === '/exit' || input === '/quit') {
        props.onSave?.(itemsRef.current);
        exit();
        return;
      }
      if (input === '/reset') {
        props.agent.reset();
        setItems([]);
        setTotals(EMPTY_USAGE);
        return;
      }
      if (input === '/save') {
        props.onSave?.(itemsRef.current);
        push({ role: 'info', text: '✓ session saved' });
        return;
      }
      if (input === '/help') {
        push({
          role: 'info',
          text: '/schema tables+columns · /model [name] switch model · /save · /reset · ctrl+t tool detail · ctrl+o last result · /exit',
        });
        return;
      }
      if (input === '/schema') {
        try {
          const tables = await props.db.listTables();
          const lines = tables
            .map(
              (t) =>
                `▎${t.name} (${t.kind}, ~${t.rowCountEstimate ?? '?'} rows)\n` +
                t.columns
                  .map((c) => `   ${c.name}: ${c.dataType}${c.isPrimaryKey ? ' ⚿' : ''}${c.nullable ? '' : ' ∗'}`)
                  .join('\n'),
            )
            .join('\n');
          push({ role: 'info', text: lines || '(no tables)' });
        } catch (err) {
          push({ role: 'error', text: (err as Error).message });
        }
        return;
      }
      if (input.startsWith('/model')) {
        const target = input.slice('/model'.length).trim();
        if (!target) {
          push({ role: 'info', text: `current model: ${props.provider}/${model}` });
          return;
        }
        setModel(target);
        props.onModelSwitch?.(target);
        push({ role: 'info', text: `✓ model → ${target}` });
        return;
      }

      push({ role: 'user', text: input, ts: Date.now() });
      await runTurn(input);
    },
    [props, push, runTurn, model, live.busy],
  );

  useInput((input, key) => {
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
      setItems([]); // clear screen (transcript stays in session on save)
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
