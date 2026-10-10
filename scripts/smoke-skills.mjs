/**
 * Smoke test: Agent Skills (SKILL.md standard) — discovery, frontmatter
 * parsing, project/user shadowing, system-prompt section, the use_skill
 * tool round-trip (scripted LLM), and the `dbagent skills` CLI listing.
 * No API key or network needed.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadSkills, parseSkill, findSkillByName, buildSkillPrompt } from '../dist/core/skills.js';
import { Agent } from '../dist/core/agent.js';
import { createDatabaseDriver } from '../dist/db/factory.js';
import { buildSystemPrompt } from '../dist/core/prompt.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

/* ── fixture skill trees ─────────────────────────────────────────────────── */
const root = mkdtempSync(join(tmpdir(), 'dbagent-skills-'));
const proj = join(root, 'project');
const home = join(root, 'home');
const mkSkill = (base, name, content) => {
  const dir = join(base, '.dbagent', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
};

mkSkill(
  proj,
  'top-customers',
  '---\ndescription: Report the top customers by revenue.\n---\n\n## Steps\nSKILL-BODY: rank customers by total order revenue.\n',
);
mkSkill(
  proj,
  'report',
  '---\nname: custom-report\ndescription: "Build the weekly sales report."\n---\n\nSKILL-BODY-REPORT\n',
);
mkSkill(proj, 'broken', 'no frontmatter at all\n');
mkSkill(proj, 'no-desc', '---\nname: no-desc\n---\n\nbody without description\n');
mkSkill(home, 'global-tip', '---\ndescription: User-level tip skill.\n---\n\nSKILL-BODY-GLOBAL\n');
// Same name as the project skill — the project version must win.
mkSkill(
  home,
  'top-customers',
  '---\ndescription: USER VERSION (should be shadowed).\n---\n\nUSER BODY\n',
);

/* ── 1. discovery + frontmatter parsing ──────────────────────────────────── */
const skills = loadSkills({ projectDir: proj, userDir: home });
const names = skills.map((s) => s.name);
check(
  'discovers valid skills only',
  names.join(',') === 'custom-report,global-tip,top-customers',
  JSON.stringify(names),
);
check(
  'frontmatter name overrides dir name',
  findSkillByName(skills, 'custom-report') !== undefined,
);
check(
  'quoted description is unquoted',
  findSkillByName(skills, 'custom-report')?.description === 'Build the weekly sales report.',
);
const top = findSkillByName(skills, 'top-customers');
check(
  'project skill shadows user skill',
  top?.source === 'project' && top?.description.startsWith('Report the top'),
  JSON.stringify(top),
);
check('user-only skill marked as user', findSkillByName(skills, 'global-tip')?.source === 'user');
check('skill body captured', top?.body.includes('SKILL-BODY'), top?.body);
check(
  'slash prompt inlines body + args',
  (() => {
    const p = buildSkillPrompt(findSkillByName(skills, 'custom-report'), 'last week');
    return (
      p.includes('# Skill: custom-report') &&
      p.includes('SKILL-BODY-REPORT') &&
      p.includes('Additional context from the operator: last week')
    );
  })(),
);
check(
  'parseSkill rejects hostile names',
  parseSkill('---\nname: ../evil\ndescription: x\n---\nbody\n', 'd', '/x', 'user') === null,
);
check(
  'parseSkill rejects empty body',
  parseSkill('---\ndescription: x\n---\n\n', 'd', '/x', 'user') === null,
);

/* ── 2. system prompt: progressive disclosure ─────────────────────────────── */
const db = createDatabaseDriver('sqlite://./demo.db', { maxRows: 5 });
const cfg = { id: 'openai', model: 'scripted-test' };
const system = await buildSystemPrompt(db, cfg, { allowWrites: false }, skills);
check(
  'prompt lists skills as name: description',
  system.includes('- top-customers: Report the top customers by revenue.'),
);
check('prompt grounds the use_skill tool', system.includes('use_skill'));
check(
  'prompt hides skill bodies (progressive disclosure)',
  !system.includes('SKILL-BODY: rank customers'),
);
const systemNoSkills = await buildSystemPrompt(db, cfg, { allowWrites: false });
check('no skills → no skills section', !systemNoSkills.includes('## Skills'));

/* ── 3. use_skill round-trip with a scripted LLM ─────────────────────────── */
function makeScriptedLLM(script) {
  let round = 0;
  return {
    id: 'openai',
    model: 'scripted-test',
    lastTools: [],
    async complete(messages, tools, systemPrompt) {
      this.lastTools = tools ?? [];
      const step = script[round++];
      if (!step) throw new Error(`Unexpected extra LLM round ${round}`);
      if (!systemPrompt.includes('SQLITE')) throw new Error('System prompt missing dialect');
      return step(messages);
    },
  };
}

{
  const llm = makeScriptedLLM([
    () => ({ toolCalls: [{ id: 'c1', name: 'use_skill', args: { name: 'top-customers' } }] }),
    (messages) => {
      const r = messages[messages.length - 1]?.toolResult?.result;
      return {
        text: r?.instructions?.includes('rank customers') ? 'SKILL-LOADED' : 'MISSING-BODY',
      };
    },
  ]);
  const agent = new Agent(llm, db, cfg, 6, { skills });
  const res = await agent.runTurn('How are my best customers doing?');
  check('use_skill delivers the body to the model', res.text === 'SKILL-LOADED', res.text);
  check(
    'use_skill registered only when skills exist',
    llm.lastTools.some((t) => t.name === 'use_skill'),
  );
}
{
  const llm = makeScriptedLLM([
    () => ({ toolCalls: [{ id: 'c1', name: 'use_skill', args: { name: 'nope' } }] }),
    (messages) => {
      const t = messages[messages.length - 1]?.toolResult;
      return {
        text:
          t?.ok === false && String(t.error).includes('Unknown skill') ? 'UNKNOWN-HANDLED' : 'FAIL',
      };
    },
  ]);
  const agent = new Agent(llm, db, cfg, 6, { skills });
  const res = await agent.runTurn('use a skill please');
  check('unknown skill surfaces as a tool error', res.text === 'UNKNOWN-HANDLED', res.text);
}
{
  const llm = makeScriptedLLM([() => ({ text: 'plain answer' })]);
  const agent = new Agent(llm, db, cfg, 6);
  await agent.runTurn('hello');
  check(
    'no skills → use_skill not offered to the model',
    !llm.lastTools.some((t) => t.name === 'use_skill'),
  );
}

/* ── 4. `dbagent skills` CLI listing ──────────────────────────────────────── */
const cli = join(process.cwd(), 'dist', 'cli.js');
const out = spawnSync(process.execPath, [cli, 'skills'], {
  cwd: proj,
  encoding: 'utf8',
  env: { ...process.env, HOME: home, USERPROFILE: home },
});
check('cli skills exits 0', out.status === 0, out.stderr);
check(
  'cli lists project skill with source',
  out.stdout.includes('top-customers [project]'),
  out.stdout,
);
check('cli lists user skill with source', out.stdout.includes('global-tip [user]'), out.stdout);

await db.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll skills checks passed ✓');
