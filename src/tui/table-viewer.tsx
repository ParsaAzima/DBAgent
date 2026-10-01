/**
 * Interactive table viewer (ctrl+o): full-screen modal over the transcript.
 *   ↑/↓ or j/k  scroll rows     PgUp/PgDn  page
 *   ←/→ or h/l  scroll columns  g/G        top/bottom
 *   q or esc    close
 */

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ToolResultData } from '../core/types.js';
import { fmtDuration } from './foundation.js';

const VISIBLE_ROWS = 12;
const VISIBLE_COLS = 6;

export function TableView({
  result,
  onClose,
}: {
  result: ToolResultData;
  onClose: () => void;
}): React.ReactElement {
  const [row, setRow] = useState(0);
  const [col, setCol] = useState(0);

  const widths = useMemo(
    () =>
      result.columns.map((c, i) =>
        Math.max(
          c.length,
          ...result.rows.slice(0, 200).map((r) => cellText(r[i]).length),
          3,
        ),
      ),
    [result],
  );

  useInput((input, key) => {
    if (key.escape || input === 'q') return onClose();
    if (key.upArrow || input === 'k') setRow((r) => Math.max(0, r - 1));
    if (key.downArrow || input === 'j') setRow((r) => Math.min(maxRow(), r + 1));
    if (key.pageUp) setRow((r) => Math.max(0, r - VISIBLE_ROWS));
    if (key.pageDown) setRow((r) => Math.min(maxRow(), r + VISIBLE_ROWS));
    if (key.leftArrow || input === 'h') setCol((c) => Math.max(0, c - 1));
    if (key.rightArrow || input === 'l') setCol((c) => Math.min(maxCol(), c + 1));
    if (input === 'g') setRow(0);
    if (input === 'G') setRow(maxRow());
  });

  function maxRow(): number {
    return Math.max(0, result.rows.length - 1);
  }
  function maxCol(): number {
    return Math.max(0, result.columns.length - VISIBLE_COLS);
  }
  function cellText(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    const s = String(v);
    return s.length > 40 ? `${s.slice(0, 37)}…` : s;
  }

  const rowSlice = result.rows.slice(
    Math.min(row, Math.max(0, result.rows.length - VISIBLE_ROWS)),
    Math.min(row, Math.max(0, result.rows.length - VISIBLE_ROWS)) + VISIBLE_ROWS,
  );
  const colSlice = result.columns.slice(col, col + VISIBLE_COLS);
  const widthSlice = widths.slice(col, col + VISIBLE_COLS);

  const line = (l: string, m: string, r: string) =>
    l + widthSlice.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const drawRow = (cells: (string | null)[], highlight = false) =>
    '│' +
    cells
      .map((c, i) => ` ${String(c ?? '').padEnd(widthSlice[i] ?? 3)} `)
      .join('│') +
    '│';

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          [table] {result.table ?? (result.sql ? 'query result' : 'result')}
          {result.sql ? <Text dimColor> — {result.sql.slice(0, 60)}</Text> : null}
        </Text>
        <Text dimColor>
          {result.rowCount} rows{result.durationMs !== undefined ? ` · ${fmtDuration(result.durationMs)}` : ''}
        </Text>
      </Box>
      <Text color="cyan">{line('┌', '┬', '┐')}</Text>
      <Text color="cyan" bold>
        {drawRow(colSlice)}
      </Text>
      <Text color="cyan">{line('├', '┼', '┤')}</Text>
      {rowSlice.map((r, i) => (
        <Text key={i} color={row === Math.min(row, Math.max(0, result.rows.length - VISIBLE_ROWS)) + i ? 'white' : undefined}>
          {drawRow(r.map(cellText))}
        </Text>
      ))}
      <Text color="cyan">{line('└', '┴', '┘')}</Text>
      <Text dimColor>
        ↑↓/jk rows · ←→/hl cols · PgUp/PgDn page · g/G ends · showing rows {Math.min(row, maxRow()) + 1}-
        {Math.min(row + VISIBLE_ROWS, result.rows.length)} of {result.rows.length}, cols {col + 1}-
        {Math.min(col + VISIBLE_COLS, result.columns.length)} of {result.columns.length} · q close
      </Text>
    </Box>
  );
}

/** Pick the most recent table result across all tool runs. */
export function pickLatestTable(tools: ToolRunLike[]): ToolResultData | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    const d = tools[i]?.data;
    if (d?.kind === 'table' && d.rows.length > 0) return d;
  }
  return undefined;
}

export interface ToolRunLike {
  data?: ToolResultData;
}
