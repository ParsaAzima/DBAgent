export interface SlashCommand {
  name: string;
  aliases?: string[];
  usage?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    usage: '[command]',
    description: 'Show available commands or help for one command.',
  },
  {
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear the visible transcript without resetting agent context.',
  },
  { name: 'exit', aliases: ['quit'], description: 'Save the session and exit.' },
  {
    name: 'model',
    usage: '[name|number]',
    description: 'List available models or switch the current provider model.',
  },
  {
    name: 'theme',
    usage: '[name]',
    description: 'Show, list, or switch the terminal color theme.',
  },
  { name: 'schema', description: 'List database tables, columns, and relationships.' },
  { name: 'refresh', description: 'Refresh the database schema after external changes.' },
  { name: 'save', description: 'Save the current session transcript.' },
  {
    name: 'skills',
    description: 'List installed skills (SKILL.md packages); /name runs one.',
  },
  { name: 'reset', description: 'Clear the transcript, conversation context, and usage totals.' },
  {
    name: 'status',
    description: 'Show the current database, model, permissions, and session status.',
  },
  { name: 'cost', description: 'Show cumulative token usage and estimated model cost.' },
];

export function findSlashCommand(
  name: string,
  extra: SlashCommand[] = [],
): SlashCommand | undefined {
  const normalized = name.toLowerCase();
  return (
    SLASH_COMMANDS.find(
      (command) =>
        command.name === normalized || command.aliases?.some((alias) => alias === normalized),
    ) ?? extra.find((command) => command.name.toLowerCase() === normalized)
  );
}

export function getSlashCommandSuggestions(
  value: string,
  extra: SlashCommand[] = [],
): SlashCommand[] {
  const match = /^\/([^\s]*)$/.exec(value);
  if (!match) return [];
  const query = match[1].toLowerCase();
  return [...SLASH_COMMANDS, ...extra].filter(
    (command) =>
      command.name.startsWith(query) || command.aliases?.some((alias) => alias.startsWith(query)),
  );
}

export function completeSlashCommand(command: SlashCommand): string {
  return `/${command.name}${command.usage ? ' ' : ''}`;
}
