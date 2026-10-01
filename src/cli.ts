/**
 * DBAgent CLI.
 *
 * Commands:
 *   dbagent chat  [--db <url>] [--provider <id>] [--model <name>] [--allow-writes]
 *   dbagent ask   "question"  (same flags)
 *   dbagent health
 *   dbagent sessions [list|rm <id>]
 */

import { createInterface } from 'node:readline';
import { Command } from 'commander';
import { Agent } from './core/agent.js';
import { loadDotEnv, resolveConfig, PROVIDER_IDS } from './core/config.js';
import { assertApiKeyPresent, createLLMAdapter } from './llm/factory.js';
import { createDatabaseDriver } from './db/factory.js';
import { randomUUID } from 'node:crypto';
import { deleteSession, listSessions, loadSession, saveSession, type SessionFile } from './session/store.js';

function redactDbUrl(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
}

async function withDb<T>(
  dbUrl: string,
  safety: { allowWrites: boolean; maxRows: number },
  fn: (db: ReturnType<typeof createDatabaseDriver>) => Promise<T>,
): Promise<T> {
  const db = createDatabaseDriver(dbUrl, safety);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

const program = new Command();

program
  .name('dbagent')
  .description('AI-powered database agent — ask questions in natural language, get SQL answers.')
  .version('0.1.0');

program
  .command('chat')
  .description('Interactive chat with your database (TUI; --plain for simple REPL).')
  .option('--db <url>', 'Database URL (sqlite://./app.db, postgres://..., mysql://...)')
  .option('--provider <id>', `LLM provider (${PROVIDER_IDS.join('|')})`)
  .option('--model <name>', 'Model name override')
  .option('--allow-writes', 'Enable INSERT/UPDATE/DELETE (read-only by default)', false)
  .option('--allow-system', 'Enable system tools (stats/export/import/backup/discover/files)', false)
  .option('--allow-shell', 'Enable the bash tool (runs shell commands) — use with care', false)
  .option('--max-rows <n>', 'Hard LIMIT for read queries', parseInt)
  .option('--resume [id]', 'Resume a saved session (latest if no id given)')
  .option('--plain', 'Use the legacy line-based REPL instead of the TUI', false)
  .action(async (opts) => {
    loadDotEnv();
    let cfg;
    try {
      cfg = resolveConfig({
        providerFlag: opts.provider,
        modelFlag: opts.model,
        dbUrlFlag: opts.db,
        allowWritesFlag: opts.allowWrites,
        allowSystemFlag: opts.allowSystem,
        allowShellFlag: opts.allowShell,
        maxRowsFlag: opts.maxRows,
      });
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    }

    let sessionId = randomUUID().slice(0, 8);
    let history: SessionFile['messages'] = [];
    if (opts.resume !== undefined) {
      const wanted = typeof opts.resume === 'string' ? opts.resume : undefined;
      const all = listSessions();
      const session = wanted ? loadSession(wanted) : all.length > 0 ? loadSession(all[0].id) : null;
      if (!session) {
        console.error(`✗ Session not found${wanted ? `: ${wanted}` : ''}.`);
        process.exit(1);
      }
      sessionId = session.id;
      history = session.messages;
      console.log(`↩ Resumed session ${sessionId} (${session.messages.length} messages)`);
    }

    let db;
    try {
      db = createDatabaseDriver(cfg.dbUrl, {
        allowWrites: cfg.allowWrites,
        maxRows: cfg.maxRows,
      });
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    }

    try {
      assertApiKeyPresent(cfg.llm);
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    }

    const llm = createLLMAdapter(cfg.llm);
    const agent = new Agent(llm, db, cfg.llm, cfg.maxRounds, {
      allowSystem: cfg.allowSystem,
      allowWrites: cfg.allowWrites,
      allowShell: cfg.allowShell,
    });
    // Restore prior transcript into the agent.
    for (const msg of history) {
      (agent as any).history.push(msg);
    }

    let tuiItems: unknown[] | undefined = history.length > 0 ? loadSession(sessionId)?.tuiItems : undefined;
    const persist = (transcript?: unknown[]): void => {
      if (transcript) tuiItems = transcript;
      const existing = loadSession(sessionId);
      const session: SessionFile = {
        id: sessionId,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: existing?.updatedAt ?? new Date().toISOString(),
        dbUrl: cfg.dbUrl,
        provider: cfg.llm.id,
        model: cfg.llm.model,
        messages: agent.getHistory(),
        tuiItems: tuiItems ?? existing?.tuiItems,
      };
      saveSession(session);
    };

    const useTui = !opts.plain && process.stdin.isTTY;
    if (!opts.plain && !process.stdin.isTTY) {
      console.log('ℹ stdin is not a TTY — falling back to plain REPL (use --plain to silence this).');
    }
    if (useTui) {
      // ── Modern TUI (streaming, markdown, tool lines) ──
      const { renderTui } = await import('./tui/index.js');
      await renderTui({
        agent,
        db,
        provider: cfg.llm.id,
        model: cfg.llm.model,
        allowWrites: cfg.allowWrites,
        maxRows: cfg.maxRows,
        sessionLabel: sessionId,
        initialItems: tuiItems as never,
        onSave: (transcript?: unknown[]) => persist(transcript),
      });
      await db.close();
      return;
    }

    console.log(`DBAgent v0.1.0 (plain REPL)`);
    console.log(`  DB      : ${db.describeTarget()}  (${redactDbUrl(cfg.dbUrl)})`);
    console.log(`  Model   : ${cfg.llm.id}/${cfg.llm.model}`);
    console.log(`  Mode    : ${cfg.allowWrites ? 'READ+WRITE' : 'READ-ONLY'} (max ${cfg.maxRows ?? 100} rows)`);
    console.log(`  Session : ${sessionId}`);
    console.log(`Commands: /exit  /reset  /save  /schema  /help\n`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const prompt = () => rl.question('you > ', (answer) => void handleInput(answer.trim()));

    const handleInput = async (input: string): Promise<void> => {
      if (!input) return prompt();
      if (input === '/exit' || input === '/quit') {
        persist();
        await db.close();
        rl.close();
        return;
      }
      if (input === '/reset') {
        agent.reset();
        console.log('↺ Conversation cleared.\n');
        return prompt();
      }
      if (input === '/save') {
        persist();
        console.log(`✓ Session ${sessionId} saved.\n`);
        return prompt();
      }
      if (input === '/schema') {
        try {
          const tables = await db.listTables();
          console.log(
            tables
              .map(
                (t) =>
                  `- ${t.name} (${t.kind}, ~${t.rowCountEstimate ?? '?'} rows)\n` +
                  t.columns.map((c) => `    ${c.name}: ${c.dataType}${c.isPrimaryKey ? ' [PK]' : ''}`).join('\n'),
              )
              .join('\n') || '(no tables)',
          );
        } catch (err) {
          console.error(`✗ ${(err as Error).message}`);
        }
        return prompt();
      }
      if (input === '/help') {
        console.log('/exit  quit (auto-saves)   /reset  clear conversation');
        console.log('/save  persist session     /schema dump tables & columns');
        return prompt();
      }

      try {
        const result = await agent.runTurn(input, {
          timeoutMs: cfg.timeoutMs,
          onStep: (step) => {
            if (step.kind === 'tool_result') {
              console.log(`  [tool] ${step.name} → ${step.ok ? 'ok' : 'error'}`);
            }
          },
        });
        console.log(`\nassistant > ${result.text}\n`);
      } catch (err) {
        console.error(`✗ ${(err as Error).message}\n`);
      }
      persist();
      prompt();
    };

    prompt();
  });

program
  .command('ask')
  .description('One-shot question about the database.')
  .argument('<question>', 'Your question in natural language')
  .option('--db <url>', 'Database URL')
  .option('--provider <id>', `LLM provider (${PROVIDER_IDS.join('|')})`)
  .option('--model <name>', 'Model name override')
  .option('--allow-writes', 'Enable writes (discouraged for one-shots)', false)
  .option('--allow-system', 'Enable system tools (stats/export/import/backup/discover)', false)
  .option('--max-rows <n>', 'Hard LIMIT for read queries', parseInt)
  .action(async (question, opts) => {
    loadDotEnv();
    let cfg;
    try {
      cfg = resolveConfig({
        providerFlag: opts.provider,
        modelFlag: opts.model,
        dbUrlFlag: opts.db,
        allowWritesFlag: opts.allowWrites,
        allowSystemFlag: opts.allowSystem,
        maxRowsFlag: opts.maxRows,
      });
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    }
    try {
      assertApiKeyPresent(cfg.llm);
      const result = await withDb(cfg.dbUrl, { allowWrites: cfg.allowWrites, maxRows: cfg.maxRows }, async (db) => {
        const llm = createLLMAdapter(cfg.llm);
        const agent = new Agent(llm, db, cfg.llm, cfg.maxRounds, {
          allowSystem: cfg.allowSystem,
          allowWrites: cfg.allowWrites,
        });
        return agent.runTurn(question, { timeoutMs: cfg.timeoutMs });
      });
      console.log(result.text);
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('discover')
  .description('Scan this machine for usable databases (servers, sqlite files, client tools).')
  .action(async () => {
    loadDotEnv();
    const { discoverLocalDatabases } = await import('./system/discover.js');
    const d = await discoverLocalDatabases();
    console.log('Servers:');
    if (d.servers.length === 0) console.log('  (none running on default ports)');
    for (const s of d.servers) {
      console.log(`  - ${s.kind} at ${s.host}:${s.port}${s.hasDumpTool ? '' : ' (no dump tool in PATH)'}`);
    }
    console.log('SQLite files (cwd):');
    if (d.sqliteFiles.length === 0) console.log('  (none)');
    for (const f of d.sqliteFiles) {
      console.log(`  - ${f.path} (${(f.sizeBytes / 1024).toFixed(1)} KB)`);
    }
    console.log(`Client tools: ${Object.entries(d.tools).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  });

program
  .command('health')
  .description('Check DB connectivity and list tables (no LLM needed).')
  .option('--db <url>', 'Database URL')
  .action(async (opts) => {
    loadDotEnv();
    const dbUrl = opts.db ?? process.env.DBAGENT_DB_URL;
    if (!dbUrl) {
      console.error('✗ No database URL. Use --db or DBAGENT_DB_URL.');
      process.exit(1);
    }
    await withDb(dbUrl, { allowWrites: false, maxRows: 1 }, async (db) => {
      console.log(`✓ Connected: ${db.describeTarget()}`);
      const tables = await db.listTables();
      console.log(`  Tables/views: ${tables.length}`);
      for (const t of tables) {
        console.log(`    - ${t.name} (${t.kind}, ~${t.rowCountEstimate ?? '?'} rows, ${t.columns.length} cols)`);
      }
    }).catch((err) => {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    });
  });

const sessionsCmd = program.command('sessions').description('Manage saved chat sessions.');
sessionsCmd
  .command('list')
  .action(() => {
    const all = listSessions();
    if (all.length === 0) return console.log('(no saved sessions)');
    for (const s of all) {
      console.log(`${s.id}  ${s.updatedAt}  ${s.provider}  ${redactDbUrl(s.dbUrl)}`);
    }
  });
sessionsCmd
  .command('rm')
  .argument('<id>')
  .action((id) => {
    console.log(deleteSession(id) ? `✓ Deleted ${id}` : `✗ Not found: ${id}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
