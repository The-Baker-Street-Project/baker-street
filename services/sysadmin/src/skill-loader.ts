import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@bakerst/shared';
import type { SysAdminState } from '@bakerst/shared';

const log = logger.child({ module: 'skill-loader' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

/**
 * Load the Tier 0 prompt for the given state.
 * Prompts are baked into the service image at services/sysadmin/prompts/.
 */
export async function loadPrompt(state: SysAdminState): Promise<string> {
  const fileName = `${state}.md`;
  const filePath = join(PROMPTS_DIR, fileName);
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    log.warn({ state, filePath, err }, 'failed to load prompt file');
    return `You are the Baker Street SysAdmin in ${state} mode.`;
  }
}

/**
 * Load a runtime prompt from content (downloaded from the release manifest).
 * Used for prompt hot-swap when transitioning from verify → runtime.
 */
export function loadPromptFromContent(content: string): string {
  return content;
}
