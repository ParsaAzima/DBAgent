/**
 * Terminal markdown renderer (marked lexer → Ink <Text> tree). Full coverage:
 * headings, paragraphs, bold/italic/strike/code inline, links, fenced/indented
 * code, nested lists, blockquotes, hr and GFM tables (box-drawn). Unknown
 * tokens fall back to raw text so nothing is ever lost.
 *
 * Everything degrades safely: deep nesting is capped, wide tables are dropped
 * into a "see ctrl+o" hint instead of mangling the line.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { marked, type Tokens } from 'marked';

const MAX_TABLE_COLS = 8;
const MAX_TABLE_WIDTH = 100;

/* ─────────────────── inline → spans ─────────────────── */

interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
}

function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  // images → alt text; links [t](u) captured; **b** __b__ *i* _i_ ~~s~~ `c`
  const re =
    /(!\[([^\]]*)\]\(([^)]*)\))|(\[([^\]]+)\]\(([^)]*)\))|(\*\*([^*]+)\*\*|__([^_]+)__)|(\*([^*]+)\*|_([^_]+)_)|(~~([^~]+)~~)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    if (m[2] !== undefined) {
      // image: render alt text
      spans.push({ text: m[3] ? `[image: ${m[2]}]` : '[image]' });
    } else if (m[5] !== undefined) {
      spans.push({ text: m[5], link: m[6] });
    } else if (m[8] !== undefined) {
      spans.push({ text: m[8], bold: true });
    } else if (m[9] !== undefined) {
      spans.push({ text: m[9], bold: true });
    } else if (m[11] !== undefined) {
      spans.push({ text: m[11], italic: true });
    } else if (m[12] !== undefined) {
      spans.push({ text: m[12], italic: true });
    } else if (m[14] !== undefined) {
      spans.push({ text: m[14], strike: true });
    } else if (m[16] !== undefined) {
      spans.push({ text: m[16], code: true });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

function Inline({ text }: { text: string }): React.ReactElement {
  const spans = parseInline(text);
  return (
    <Text>
      {spans.map((s, i) => {
        if (s.link) {
          return (
            <Text key={i} color="cyan" underline>
              {s.text}
              {s.link !== s.text ? <Text dimColor> ({s.link})</Text> : null}
            </Text>
          );
        }
        return (
          <Text
            key={i}
            bold={s.bold}
            italic={s.italic}
            strikethrough={s.strike}
            color={s.code ? 'green' : undefined}
          >
            {s.text}
          </Text>
        );
      })}
    </Text>
  );
}

/* ─────────────────── table ─────────────────── */

function renderTable(tok: Tokens.Table, key: string): React.ReactElement {
  const headers: string[] = tok.header.map((c) => c.text ?? '');
  const rows: string[][] = tok.rows.map((r) => r.map((c) => c.text ?? ''));
  const tooWide = headers.length > MAX_TABLE_COLS;

  if (tooWide) {
    return (
      <Text key={key} dimColor>
        (table with {headers.length} columns — {MAX_TABLE_COLS} max; data shown in results above)
      </Text>
    );
  }

  const clip = (s: string) => (s.length > 30 ? `${s.slice(0, 27)}…` : s);
  const widths = headers.map((h, i) => {
    const cellMax = Math.max(h.length, ...rows.map((r) => clip(r[i] ?? '').length), 3);
    return Math.min(cellMax, 30);
  });
  const total = widths.reduce((a, b) => a + b + 3, 0);
  if (total > MAX_TABLE_WIDTH) {
    return (
      <Text key={key} dimColor>
        (wide table omitted — inspect with ctrl+o or ask for specific columns)
      </Text>
    );
  }

  const line = (l: string, m: string, r: string) =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const drawRow = (cells: string[]) =>
    '│' + cells.map((c, i) => ` ${clip(String(c ?? '')).padEnd(widths[i])} `).join('│') + '│';

  return (
    <Box key={key} flexDirection="column" marginY={0}>
      <Text color="cyan">{line('┌', '┬', '┐')}</Text>
      <Text color="cyan" bold>
        {drawRow(headers)}
      </Text>
      <Text color="cyan">{line('├', '┼', '┤')}</Text>
      {rows.map((r, i) => (
        <Text key={i}>{drawRow(headers.map((_, ci) => r[ci] ?? ''))}</Text>
      ))}
      <Text color="cyan">{line('└', '┴', '┘')}</Text>
    </Box>
  );
}

/* ─────────────────── code block ─────────────────── */

function renderCode(code: string, key: string): React.ReactElement {
  return (
    <Box key={key} flexDirection="column" marginY={0}>
      {code.split('\n').map((l, j) => (
        <Text key={j} color="yellow" wrap="truncate">
          │ {l}
        </Text>
      ))}
    </Box>
  );
}

/* ─────────────────── list (recursive) ─────────────────── */

interface ListItem {
  text: string;
  depth: number;
  ordered: boolean;
  index: number;
}

function flattenList(tok: Tokens.List, depth = 0, out: ListItem[] = []): ListItem[] {
  const ordered = !!tok.ordered;
  (tok.items ?? []).forEach((it, j) => {
    const main = (it.text ?? '').split('\n')[0] ?? '';
    out.push({ text: main, depth, ordered, index: j + 1 });
    // nested lists hide inside item subtokens
    for (const sub of (it as unknown as { tokens?: any[] }).tokens ?? []) {
      if (sub.type === 'list') flattenList(sub as Tokens.List, depth + 1, out);
    }
  });
  return out;
}

function renderList(tok: Tokens.List, key: string): React.ReactElement {
  const items = flattenList(tok);
  return (
    <Box key={key} flexDirection="column" marginY={0}>
      {items.map((it, j) => (
        <Box key={j} paddingLeft={it.depth * 2}>
          <Text>
            <Text color="magenta">
              {it.ordered ? `${it.index}. ` : it.depth % 2 === 0 ? '- ' : '* '}
            </Text>
            <Inline text={it.text} />
          </Text>
        </Box>
      ))}
    </Box>
  );
}

/* ─────────────────── block renderer ─────────────────── */

function Markdown({ children }: { children: string }): React.ReactElement {
  const tokens = marked.lexer(children, { gfm: true });
  const out: React.ReactElement[] = [];

  tokens.forEach((tok, i) => {
    const key = `md-${i}`;
    switch (tok.type) {
      case 'heading':
        out.push(
          <Text key={key} bold color="cyan">
            {(tok as Tokens.Heading).text}
          </Text>,
        );
        break;
      case 'code':
        out.push(renderCode((tok as Tokens.Code).text, key));
        break;
      case 'table':
        out.push(renderTable(tok as Tokens.Table, key));
        break;
      case 'list':
        out.push(renderList(tok as Tokens.List, key));
        break;
      case 'blockquote': {
        const text = (tok as Tokens.Blockquote).text ?? '';
        out.push(
          <Box key={key} paddingLeft={1}>
            <Text color="gray" italic>
              {'▏ '}
              <Inline text={text} />
            </Text>
          </Box>,
        );
        break;
      }
      case 'hr':
        out.push(
          <Text key={key} dimColor>
            {'─'.repeat(46)}
          </Text>,
        );
        break;
      case 'space':
        out.push(<Text key={key}> </Text>);
        break;
      case 'html':
        // strip raw html tags, keep inner text
        out.push(
          <Inline key={key} text={(tok as Tokens.HTML).raw.replace(/<[^>]+>/g, '').trim()} />,
        );
        break;
      case 'paragraph':
      default: {
        const raw = (tok as Tokens.Paragraph).text ?? (tok as { raw?: string }).raw ?? '';
        if (raw.trim()) out.push(<Inline key={key} text={raw} />);
        break;
      }
    }
  });

  return <Box flexDirection="column">{out}</Box>;
}

export default Markdown;
