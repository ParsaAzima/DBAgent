/**
 * TUI building blocks (Claude Code / opencode style):
 *   • user / assistant messages with markdown
 *   • collapsible tool blocks (dimmed single line when collapsed)
 *   • live spinner + streaming markdown pane
 *   • persistent status footer (model · mode · tokens · cost)
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, Static } from 'ink';
import Markdown from './markdown.js';
import type { TranscriptItem, ToolRun, TurnUsage, UsageInfo } from './foundation.js';
import { fmtTokens, fmtCost, fmtDuration, fmtTime } from './foundation.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Animated braille spinner that ticks on an interval. */
export function Spinner({ label, color = 'cyan' }: { label: string; color?: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color={color}>
      {SPINNER_FRAMES[frame]} {label}
    </Text>
  );
}

function StatusIcon({ status }: { status: ToolRun['status'] }): React.ReactElement {
  if (status === 'running') return <Spinner label="" />;
  if (status === 'error') return <Text color="red">✗</Text>;
  return <Text color="green">✓</Text>;
}

/**
 * One collapsible tool block. Collapsed shows a single dim line (Claude Code
 * style); expanded shows args (SQL) + result preview table.
 */
export function ToolBlock({
  run,
  expanded,
  onToggle,
}: {
  run: ToolRun;
  expanded: boolean;
  onToggle?: () => void;
}): React.ReactElement {
  const running = run.status === 'running';
  const headerColor = running ? 'cyan' : run.status === 'error' ? 'red' : 'gray';
  const title = run.argsSummary ? `${run.name} ${run.argsSummary}` : run.name;
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={headerColor} dimColor={!running}>
        {'  '}
        {run.status === 'running' ? (
          <Spinner label={title} />
        ) : (
          <>
            <StatusIcon status={run.status} /> {title}
            {run.durationMs !== undefined ? <Text dimColor> ({fmtDuration(run.durationMs)})</Text> : null}
            {run.preview ? <Text dimColor> — {run.preview}</Text> : null}
          </>
        )}
      </Text>
      {expanded && run.argsSummary && run.argsSummary.length > 0 && (
        <Box marginLeft={5} flexDirection="column">
          <Text color="yellow">{run.name === 'query' || run.name === 'execute' ? run.argsSummary : `→ ${run.argsSummary}`}</Text>
        </Box>
      )}
      {expanded && run.data && run.data.rows.length > 0 && (
        <Box marginLeft={5} flexDirection="column">
          <Text dimColor>ctrl+o to open interactive viewer ({run.data.rowCount} rows)</Text>
        </Box>
      )}
      {onToggle ? null : null}
    </Box>
  );
}

function TurnBadge({ turn }: { turn?: TurnUsage }): React.ReactElement | null {
  if (!turn) return null;
  const { usage } = turn;
  return (
    <Text dimColor>
      {'   '}
      {turn.rounds} round{turn.rounds === 1 ? '' : 's'} · {fmtDuration(turn.durationMs)} ·{' '}
      {fmtTokens(usage.inputTokens)} in / {fmtTokens(usage.outputTokens)} out
      {usage.costUsd > 0 ? ` · ${fmtCost(usage.costUsd)}` : ''}
    </Text>
  );
}

export function TranscriptEntry({ item }: { item: TranscriptItem }): React.ReactElement {
  if (item.role === 'user') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color="blue" bold>
            ❯{' '}
          </Text>
          <Text bold>{item.text}</Text>
          <Text dimColor> {fmtTime(item.ts)}</Text>
        </Box>
      </Box>
    );
  }
  if (item.role === 'info') {
    return (
      <Text color="gray" dimColor>
        {item.text}
      </Text>
    );
  }
  if (item.role === 'error') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="red">✗ {item.text}</Text>
      </Box>
    );
  }
  // assistant: tools first (dim, collapsed), then the markdown answer
  return (
    <Box marginTop={1} flexDirection="column">
      {item.tools && item.tools.length > 0 && (
        <Box flexDirection="column">
          {item.tools.map((t) => (
            <ToolBlock key={t.id} run={t} expanded={false} />
          ))}
        </Box>
      )}
      {item.text && item.text.trim().length > 0 && (
        <Box flexDirection="column">
          <Text color="green" bold>
            ●
          </Text>
          <Markdown>{item.text}</Markdown>
        </Box>
      )}
      <TurnBadge turn={item.turn} />
    </Box>
  );
}

export function Transcript({ items }: { items: TranscriptItem[] }): React.ReactElement {
  return <Static items={items}>{(item, i) => <TranscriptEntry key={i} item={item} />}</Static>;
}

/** Live pane while a turn runs: spinner + tool blocks + streaming markdown. */
export function LiveTurn({
  text,
  tools,
  elapsedMs,
  usage,
  round,
}: {
  text: string;
  tools: ToolRun[];
  elapsedMs: number;
  usage: UsageInfo;
  round: number;
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      {tools.map((t) => (
        <ToolBlock key={t.id} run={t} expanded={false} />
      ))}
      <Box>
        <Text color="green" bold>
          ●{' '}
        </Text>
        <Spinner label={`thinking… (round ${round}, ${fmtDuration(elapsedMs)})`} />
      </Box>
      {text && (
        <Box flexDirection="column">
          <Markdown>{text}</Markdown>
        </Box>
      )}
      <Text dimColor>
        {'   '}
        {fmtTokens(usage.inputTokens)} in / {fmtTokens(usage.outputTokens)} out
        {usage.costUsd > 0 ? ` · ${fmtCost(usage.costUsd)}` : ''} · esc to stop
      </Text>
    </Box>
  );
}

/** Persistent status footer, opencode-style. */
export function StatusBar({
  provider,
  model,
  readOnly,
  sessionLabel,
  totals,
  hints,
}: {
  provider: string;
  model: string;
  readOnly: boolean;
  sessionLabel: string;
  totals: UsageInfo;
  hints: string;
}): React.ReactElement {
  return (
    <Box marginTop={0} borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
      <Box>
        <Text color="magenta">{provider}</Text>
        <Text dimColor>/</Text>
        <Text color="magenta" bold>
          {model}
        </Text>
        <Text dimColor> · </Text>
        <Text color={readOnly ? 'yellow' : 'red'}>{readOnly ? 'READ-ONLY' : 'READ+WRITE'}</Text>
        <Text dimColor> · session {sessionLabel} · </Text>
        <Text color="cyan">
          {fmtTokens(totals.inputTokens)} in / {fmtTokens(totals.outputTokens)} out
        </Text>
        {totals.costUsd > 0 ? <Text color="cyan"> · {fmtCost(totals.costUsd)}</Text> : null}
      </Box>
      <Text dimColor>{hints}</Text>
    </Box>
  );
}
