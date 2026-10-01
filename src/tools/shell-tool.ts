/**
 * Shell tool — the most powerful (and most dangerous) tool.
 * Gated behind its own flag: --allow-shell / DBAGENT_ALLOW_SHELL=1.
 *
 * Safety rails:
 *  • separate opt-in gate from --allow-system
 *  • hard timeout (default 30s, cap 120s)
 *  • output capped (10 KB stdout, 4 KB stderr)
 *  • cwd always sandboxed through resolveUserPath
 *  • exit code + stderr always surfaced to the model
 */

import { spawn } from 'node:child_process';
import { resolveUserPath } from '../system/paths.js';
import type { ToolHandler } from './index.js';

const MAX_STDOUT = 10 * 1024;
const MAX_STDERR = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export interface ShellToolDeps {
  allowShell: boolean;
}

export function createShellToolRegistry(deps: ShellToolDeps): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();

  registry.set('bash', async (args) => {
    if (!deps.allowShell) {
      throw new Error(
        'Tool "bash" requires shell mode. Restart with --allow-shell or set DBAGENT_ALLOW_SHELL=1.',
      );
    }
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('bash requires "command".');
    const cwd = resolveUserPath(String(args.cwd ?? '.'));
    const timeout = Math.min(
      Math.max(Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1000),
      MAX_TIMEOUT_MS,
    );

    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const child = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/c', command] : ['-c', command], {
        cwd,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeout);

      child.stdout.on('data', (c) => {
        if (stdout.length < MAX_STDOUT) stdout += String(c);
      });
      child.stderr.on('data', (c) => {
        if (stderr.length < MAX_STDERR) stderr += String(c);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          command,
          cwd,
          exitCode: code,
          killed,
          stdout: stdout.slice(0, MAX_STDOUT),
          stderr: stderr.slice(0, MAX_STDERR),
          stdoutTruncated: stdout.length > MAX_STDOUT,
          stderrTruncated: stderr.length > MAX_STDERR,
        });
      });
    });
  });

  return registry;
}
