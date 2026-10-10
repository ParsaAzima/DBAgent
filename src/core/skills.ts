/**
 * Agent Skills — the open SKILL.md standard used by Claude Code, Codex CLI,
 * GitHub Copilot and Qwen Code, adapted for a database agent:
 *
 *   .dbagent/skills/<name>/SKILL.md    project skills (commit, share with the team)
 *   ~/.dbagent/skills/<name>/SKILL.md  personal skills (every project on this machine)
 *
 * Each SKILL.md has YAML frontmatter between `---` markers (at least a
 * `description`; optional `name`) and a markdown body with the instructions.
 *
 * Progressive disclosure, like Claude Code: only the name + description reach
 * the system prompt, so long playbooks cost nothing until they are used. The
 * body loads when the model calls the use_skill tool, or immediately when the
 * operator invokes /<skill-name> in chat.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SkillMeta {
  /** Command name: frontmatter `name` when set, else the directory name. */
  name: string;
  /** One line: what the skill does and when to use it. */
  description: string;
  /** Absolute path of the SKILL.md file. */
  path: string;
  /** project = .dbagent/skills under the working dir; user = ~/.dbagent/skills. */
  source: 'project' | 'user';
}

export interface Skill extends SkillMeta {
  /** Markdown body: the instructions followed when the skill runs. */
  body: string;
}

export interface LoadSkillsOptions {
  /** Directory whose .dbagent/skills is searched (default: cwd). */
  projectDir?: string;
  /** Home directory whose .dbagent/skills is searched (default: os.homedir()). */
  userDir?: string;
}

/** Skill names double as slash commands — keep them URL/shell friendly. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Discover installed skills. Project skills shadow user skills of the same
 * name; results are sorted for a stable system prompt.
 */
export function loadSkills(opts: LoadSkillsOptions = {}): Skill[] {
  const projectRoot = join(opts.projectDir ?? process.cwd(), '.dbagent', 'skills');
  const userRoot = join(opts.userDir ?? homedir(), '.dbagent', 'skills');
  const byName = new Map<string, Skill>();
  for (const skill of readSkillDir(userRoot, 'user')) byName.set(skill.name, skill);
  for (const skill of readSkillDir(projectRoot, 'project')) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readSkillDir(root: string, source: 'project' | 'user'): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // nothing installed at this location
  }
  const out: Skill[] = [];
  for (const entry of entries.sort()) {
    const file = join(root, entry, 'SKILL.md');
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const skill = parseSkill(raw, entry, file, source);
    if (skill) out.push(skill);
  }
  return out;
}

/**
 * Parse one SKILL.md. Returns null when the file is unusable: no frontmatter,
 * no description (the description is what makes a skill discoverable), an
 * empty body, or an invalid name.
 */
export function parseSkill(
  raw: string,
  dirName: string,
  path: string,
  source: 'project' | 'user',
): Skill | null {
  const text = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const frontmatter = parseFrontmatter(match[1]);
  const description = (frontmatter.description ?? '').trim();
  const body = match[2].trim();
  if (!description || !body) return null;
  const name = (frontmatter.name?.trim() || dirName).toLowerCase();
  if (!NAME_RE.test(name)) return null;
  return { name, description, path, source, body };
}

/** Flat `key: value` pairs (the only shape the standard's core fields use). */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1].toLowerCase()] = stripQuotes(m[2]);
  }
  return out;
}

function stripQuotes(value: string): string {
  const t = value.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Look up a skill by name (case-insensitive), e.g. for /<name> chat input. */
export function findSkillByName(skills: Skill[] | undefined, name: string): Skill | undefined {
  const needle = name.toLowerCase();
  return skills?.find((s) => s.name === needle);
}

/**
 * Turn a slash invocation into the user message the agent runs: the skill
 * body inlined, plus whatever arguments the operator typed after /name
 * (Claude Code-style explicit invocation).
 */
export function buildSkillPrompt(skill: Skill, args = ''): string {
  return [
    `# Skill: ${skill.name}`,
    '',
    skill.body,
    '',
    args
      ? `Additional context from the operator: ${args}`
      : 'Apply this skill to the current database and conversation, then report the result.',
  ].join('\n');
}
