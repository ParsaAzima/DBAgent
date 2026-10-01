/**
 * File tools for the agent — SQL script reading/writing, project navigation.
 * All paths go through resolveUserPath (working-directory sandbox).
 * Gated behind --allow-system (same privilege level as export/import).
 */

import { readFile, writeFile, readdir, mkdir, stat, unlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { globSync } from 'node:fs';
import { resolveUserPath } from '../system/paths.js';
import type { ToolHandler } from './index.js';

const MAX_READ_BYTES = 512 * 1024; // 512 KB per read
const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 2 MB per write
const MAX_LIST_ENTRIES = 500;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_BYTES = 4 * 1024 * 1024;

export interface FileToolDeps {
  allowSystem: boolean;
}

export function createFileToolRegistry(deps: FileToolDeps): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();
  const guard = (name: string): void => {
    if (!deps.allowSystem) {
      throw new Error(
        `Tool "${name}" requires system mode. Restart with --allow-system or set DBAGENT_ALLOW_SYSTEM=1.`,
      );
    }
  };

  registry.set('read_file', async (args) => {
    guard('read_file');
    const p = resolveUserPath(String(args.path ?? ''));
    const st = statSync(p);
    if (st.size > MAX_READ_BYTES) {
      throw new Error(`File too large to read (${(st.size / 1024).toFixed(0)} KB, max 512 KB).`);
    }
    const offset = Math.max(0, Number(args.offset ?? 0));
    const content = await readFile(p, 'utf8');
    const lines = content.split('\n');
    const slice = lines.slice(offset, offset + 400);
    return {
      path: p,
      totalLines: lines.length,
      offset,
      lines: slice.length,
      content: slice.join('\n'),
      truncated: offset + slice.length < lines.length,
    };
  });

  registry.set('write_file', async (args) => {
    guard('write_file');
    const p = resolveUserPath(String(args.path ?? ''));
    const content = String(args.content ?? '');
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
      throw new Error('Content exceeds 2 MB write limit.');
    }
    if (existsSync(p)) {
      const prev = await readFile(p, 'utf8');
      if (String(args.overwrite ?? '') !== 'true' && prev !== String(args.expected ?? '')) {
        throw new Error(
          'File exists. Pass content of current file in "expected" to confirm overwrite, or set overwrite:"true".',
        );
      }
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
    return { path: p, bytes: Buffer.byteLength(content), written: true };
  });

  registry.set('edit_file', async (args) => {
    guard('edit_file');
    const p = resolveUserPath(String(args.path ?? ''));
    const oldString = String(args.oldString ?? '');
    const newString = String(args.newString ?? '');
    if (!oldString) throw new Error('edit_file requires "oldString".');
    const content = await readFile(p, 'utf8');
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) throw new Error('oldString not found in file.');
    if (occurrences > 1 && args.allowMultiple !== true) {
      throw new Error(
        `oldString matches ${occurrences} times. Provide more context or set allowMultiple:"true".`,
      );
    }
    const updated = args.allowMultiple === true
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    await writeFile(p, updated, 'utf8');
    return { path: p, replaced: occurrences, bytes: Buffer.byteLength(updated) };
  });

  registry.set('list_dir', async (args) => {
    guard('list_dir');
    const p = resolveUserPath(String(args.path ?? '.'));
    const entries = await readdir(p, { withFileTypes: true });
    const items = entries.slice(0, MAX_LIST_ENTRIES).map((e) => {
      let size: number | undefined;
      try {
        size = statSync(join(p, e.name)).size;
      } catch {
        /* ignore */
      }
      return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size };
    });
    return { path: p, count: entries.length, items };
  });

  registry.set('glob_files', async (args) => {
    guard('glob_files');
    const pattern = String(args.pattern ?? '*.sql');
    const cwd = resolveUserPath(String(args.cwd ?? '.'));
    const matches = globSync(pattern, { cwd, exclude: (f) => f.includes('node_modules') });
    const items = matches.slice(0, MAX_LIST_ENTRIES).map((m) => {
      const full = join(cwd, m);
      let size: number | undefined;
      try {
        size = statSync(full).size;
      } catch {
        /* ignore */
      }
      return { path: relative(cwd, full) || basename(full), size };
    });
    return { pattern, cwd, matches: items.length, items };
  });

  registry.set('grep_files', async (args) => {
    guard('grep_files');
    const pattern = String(args.pattern ?? '');
    if (!pattern) throw new Error('grep_files requires "pattern".');
    const regex = new RegExp(pattern, 'i');
    const cwd = resolveUserPath(String(args.cwd ?? '.'));
    const ext = String(args.ext ?? '.sql,.txt,.md,.csv,.json,.ts,.js,.py,.mjs');
    const extensions = ext.split(',').map((e) => e.trim().toLowerCase());

    const all = globSync('**/*', { cwd, exclude: (f) => f.includes('node_modules') || f.includes('.git') });
    const matches: { file: string; line: number; text: string }[] = [];
    for (const rel of all) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      const full = join(cwd, rel);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_GREP_BYTES) continue;
      if (!extensions.some((e) => rel.toLowerCase().endsWith(e))) continue;
      try {
        const content = await readFile(full, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
          }
        }
      } catch {
        /* unreadable */
      }
    }
    return { pattern, cwd, matchCount: matches.length, matches };
  });

  registry.set('delete_file', async (args) => {
    guard('delete_file');
    const p = resolveUserPath(String(args.path ?? ''));
    if (!existsSync(p)) throw new Error(`Not found: ${p}`);
    const st = statSync(p);
    if (st.isDirectory()) throw new Error('Refusing to delete a directory. Use shell rm -rf explicitly if needed.');
    await unlink(p);
    return { deleted: p };
  });

  registry.set('make_dir', async (args) => {
    guard('make_dir');
    const p = resolveUserPath(String(args.path ?? ''));
    await mkdir(p, { recursive: true });
    return { created: p };
  });

  return registry;
}

export { resolveUserPath };
