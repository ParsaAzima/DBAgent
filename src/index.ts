/**
 * Library entry point — use DBAgent programmatically.
 *
 * ```ts
 * import { createDatabaseDriver } from './db/factory.js';
 * import { createLLMAdapter } from './llm/factory.js';
 * import { Agent } from './core/agent.js';
 *
 * const db = createDatabaseDriver('sqlite://./demo.db', { maxRows: 100 });
 * const llm = createLLMAdapter({ id: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY });
 * const agent = new Agent(llm, db, { id: 'openai', model: 'gpt-4o-mini' });
 * const { text } = await agent.runTurn('Which product sold the most last month?');
 * await db.close();
 * ```
 */

export * from './core/types.js';
export { Agent, AgentError } from './core/agent.js';
export { resolveConfig, loadDotEnv, DEFAULT_MODELS } from './core/config.js';
export { createLLMAdapter, assertApiKeyPresent } from './llm/factory.js';
export { createDatabaseDriver, parseDatabaseUrl } from './db/factory.js';
export { buildTools } from './tools/index.js';
export { saveSession, loadSession, listSessions, deleteSession } from './session/store.js';
