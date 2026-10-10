/**
 * TUI building blocks (Claude Code / opencode style):
 *   • user / assistant messages with markdown
 *   • collapsible tool blocks (dimmed single line when collapsed)
 *   • live spinner + streaming markdown pane
 *   • persistent status footer (model · mode · tokens · cost)
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Markdown from './markdown.js';
import type { TranscriptItem, ToolRun, TurnUsage, UsageInfo } from './foundation.js';
import { fmtTokens, fmtCost, fmtDuration, fmtTime } from './foundation.js';
import type { TuiTheme } from './theme.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Animated braille spinner that ticks on an interval. */
export function Spinner({
  label,
  color = 'cyan',
}: {
  label: string;
  color?: string;
}): React.ReactElement {
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

function StatusIcon({
  status,
  theme,
}: {
  status: ToolRun['status'];
  theme: TuiTheme;
}): React.ReactElement {
  if (status === 'running') return <Spinner label="" color={theme.accent} />;
  if (status === 'error') return <Text color={theme.error}>✗</Text>;
  return <Text color={theme.success}>✓</Text>;
}

/**
 * One collapsible tool block. Collapsed shows a single dim line (Claude Code
 * style); expanded shows args (SQL) + result preview table.
 */
export function ToolBlock({
  run,
  expanded,
  onToggle,
  theme,
}: {
  run: ToolRun;
  expanded: boolean;
  onToggle?: () => void;
  theme: TuiTheme;
}): React.ReactElement {
  const running = run.status === 'running';
  const headerColor = running ? theme.accent : run.status === 'error' ? theme.error : theme.muted;
  const title = run.argsSummary ? `${run.name} ${run.argsSummary}` : run.name;
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={headerColor}>
        {'  '}
        {run.status === 'running' ? (
          <Spinner label={title} color={theme.accent} />
        ) : (
          <>
            <StatusIcon status={run.status} theme={theme} /> {title}
            {run.durationMs !== undefined ? (
              <Text color={theme.muted}> ({fmtDuration(run.durationMs)})</Text>
            ) : null}
            {run.preview ? <Text color={theme.muted}> — {run.preview}</Text> : null}
          </>
        )}
      </Text>
      {expanded && run.argsSummary && run.argsSummary.length > 0 && (
        <Box marginLeft={5} flexDirection="column">
          <Text color={theme.warning}>
            {run.name === 'query' || run.name === 'execute'
              ? run.argsSummary
              : `→ ${run.argsSummary}`}
          </Text>
        </Box>
      )}
      {expanded && run.data && run.data.rows.length > 0 && (
        <Box marginLeft={5} flexDirection="column">
          <Text color={theme.muted}>
            ctrl+o to open interactive viewer ({run.data.rowCount} rows)
          </Text>
        </Box>
      )}
      {onToggle ? null : null}
    </Box>
  );
}

function TurnBadge({
  turn,
  theme,
}: {
  turn?: TurnUsage;
  theme: TuiTheme;
}): React.ReactElement | null {
  if (!turn) return null;
  const { usage } = turn;
  return (
    <Text color={theme.muted}>
      {'   '}
      {turn.rounds} round{turn.rounds === 1 ? '' : 's'} · {fmtDuration(turn.durationMs)} ·{' '}
      {fmtTokens(usage.inputTokens)} in / {fmtTokens(usage.outputTokens)} out
      {usage.costUsd > 0 ? ` · ${fmtCost(usage.costUsd)}` : ''}
    </Text>
  );
}

export function TranscriptEntry({
  item,
  expanded = false,
  theme,
}: {
  item: TranscriptItem;
  expanded?: boolean;
  theme: TuiTheme;
}): React.ReactElement {
  if (item.role === 'user') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.user} bold>
            ❯{' '}
          </Text>
          <Text color={theme.foreground} bold>
            {item.text}
          </Text>
          <Text color={theme.muted}> {fmtTime(item.ts)}</Text>
        </Box>
      </Box>
    );
  }
  if (item.role === 'info') {
    return <Text color={theme.muted}>{item.text}</Text>;
  }
  if (item.role === 'error') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.error}>✗ {item.text}</Text>
      </Box>
    );
  }
  // assistant: tools first (dim, collapsed), then the markdown answer
  return (
    <Box marginTop={1} flexDirection="column">
      {item.tools && item.tools.length > 0 && (
        <Box flexDirection="column">
          {item.tools.map((t) => (
            <ToolBlock key={t.id} run={t} expanded={expanded} theme={theme} />
          ))}
        </Box>
      )}
      {item.text && item.text.trim().length > 0 && (
        <Box flexDirection="column">
          <Text color={theme.assistant} bold>
            ●
          </Text>
          <Markdown theme={theme}>{item.text}</Markdown>
        </Box>
      )}
      <TurnBadge turn={item.turn} theme={theme} />
    </Box>
  );
}

/**
 * Memoized entry: keystrokes re-render the chat input without re-parsing the
 * markdown of every past message. `expanded` (ctrl+t) is a prop, so toggling
 * re-renders every entry — which is exactly why this can't be `<Static>`:
 * static output is append-only and could never re-expand past tool blocks.
 */
const MemoTranscriptEntry = React.memo(TranscriptEntry);

export function Transcript({
  items,
  expanded = false,
  theme,
  maxLines = 1000,
  columns = 80,
  scrollOffset = 0,
}: {
  items: TranscriptItem[];
  expanded?: boolean;
  theme: TuiTheme;
  maxLines?: number;
  columns?: number;
  scrollOffset?: number;
}): React.ReactElement {
  const end = Math.max(0, items.length - scrollOffset);
  let start = end;
  let usedLines = 0;
  for (let index = end - 1; index >= 0; index--) {
    const count = estimateTranscriptLines(items[index], columns, expanded);
    if (usedLines + count > maxLines && start < end) break;
    usedLines += count;
    start = index;
    if (usedLines >= maxLines) break;
  }
  const visible = items.slice(start, end);
  const hiddenBefore = start > 0;
  const hiddenAfter = end < items.length;
  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {hiddenBefore || hiddenAfter ? (
        <Text color={theme.muted}>
          {hiddenAfter ? '↑ newer messages below' : '… earlier messages hidden'} · PgUp/PgDn history
        </Text>
      ) : null}
      {visible.map((item, i) => (
        <MemoTranscriptEntry key={i} item={item} expanded={expanded} theme={theme} />
      ))}
    </Box>
  );
}

function estimateTranscriptLines(item: TranscriptItem, columns: number, expanded: boolean): number {
  const width = Math.max(20, columns - 8);
  const textLines = (text: string): number =>
    text
      .split('\n')
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / width)), 0);
  const toolLines = (item.tools ?? []).reduce(
    (total, tool) => total + 1 + (expanded && tool.argsSummary ? textLines(tool.argsSummary) : 0),
    0,
  );
  return (
    textLines(item.text) + toolLines + (item.role === 'user' || item.role === 'assistant' ? 1 : 0)
  );
}

/** Live pane while a turn runs: spinner + tool blocks + streaming markdown. */
export function LiveTurn({
  text,
  tools,
  elapsedMs,
  usage,
  round,
  expanded = false,
  theme,
}: {
  text: string;
  tools: ToolRun[];
  elapsedMs: number;
  usage: UsageInfo;
  round: number;
  expanded?: boolean;
  theme: TuiTheme;
}): React.ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      {tools.map((t) => (
        <ToolBlock key={t.id} run={t} expanded={expanded} theme={theme} />
      ))}
      <Box>
        <Text color={theme.assistant} bold>
          ●{' '}
        </Text>
        <Spinner
          label={`thinking… (round ${round}, ${fmtDuration(elapsedMs)})`}
          color={theme.accent}
        />
      </Box>
      {text && (
        <Box flexDirection="column">
          <Markdown theme={theme}>{text}</Markdown>
        </Box>
      )}
      <Text color={theme.muted}>
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
  theme,
}: {
  provider: string;
  model: string;
  readOnly: boolean;
  sessionLabel: string;
  totals: UsageInfo;
  hints: string;
  theme: TuiTheme;
}): React.ReactElement {
  return (
    <Box width="100%" borderTop borderColor={theme.muted} paddingX={1} flexDirection="column">
      <Box>
        <Text color={theme.accentSecondary}>{provider}</Text>
        <Text color={theme.muted}>/</Text>
        <Text color={theme.accentSecondary} bold>
          {model}
        </Text>
        <Text color={theme.muted}> · </Text>
        <Text color={readOnly ? theme.warning : theme.error}>
          {readOnly ? 'READ-ONLY' : 'READ+WRITE'}
        </Text>
        <Text color={theme.muted}> · session {sessionLabel} · </Text>
        <Text color={theme.accent}>
          {fmtTokens(totals.inputTokens)} in / {fmtTokens(totals.outputTokens)} out
        </Text>
        {totals.costUsd > 0 ? <Text color={theme.accent}> · {fmtCost(totals.costUsd)}</Text> : null}
      </Box>
      <Text color={theme.muted}>{hints}</Text>
    </Box>
  );
}
