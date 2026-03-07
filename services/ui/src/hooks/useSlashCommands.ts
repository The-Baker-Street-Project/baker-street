export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/save-this', description: 'Save the previous prompt' },
  { name: '/saved-prompts', description: 'Show saved prompts' },
];

/** Check if text is a slash command. Returns the command name or null. */
export function matchSlashCommand(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  const cmd = SLASH_COMMANDS.find((c) => trimmed === c.name || trimmed.startsWith(c.name + ' '));
  return cmd ? cmd.name : null;
}

/** Get autocomplete suggestions for partial slash command input */
export function getSlashSuggestions(text: string): SlashCommand[] {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(trimmed));
}
