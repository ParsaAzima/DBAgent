/**
 * Shared path guard: keeps file operations inside the working directory
 * unless the operator explicitly opts out (DBAGENT_ANY_PATH=1).
 */

import { resolve, sep } from 'node:path';

export function resolveUserPath(p: string): string {
  const abs = resolve(p);
  const cwd = process.cwd();
  const outDir = process.env.DBAGENT_OUT_DIR ? resolve(process.env.DBAGENT_OUT_DIR) : null;

  const insideCwd = abs === cwd || abs.startsWith(cwd + sep);
  const insideOutDir =
    outDir !== null && (abs === outDir || abs.startsWith(outDir + sep));

  if (!insideCwd && !insideOutDir && process.env.DBAGENT_ANY_PATH !== '1') {
    throw new Error(
      `Path "${p}" is outside the working directory. Set DBAGENT_ANY_PATH=1 to allow arbitrary paths.`,
    );
  }
  return abs;
}
