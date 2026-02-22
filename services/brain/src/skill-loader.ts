/**
 * Skill Loader — loads Tier 0 (instruction) skills as markdown content
 * to be injected into the agent's system prompt.
 */

import { readFile } from 'node:fs/promises';
import { logger, SkillTier, type SkillMetadata } from '@bakerst/shared';
import { getEnabledSkills } from './db.js';

const log = logger.child({ module: 'skill-loader' });

const INSTRUCTION_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedInstructions: string | undefined;
let cacheTimestamp = 0;

/**
 * Load all enabled Tier 0 skills and return their concatenated markdown content.
 * Results are cached until reloadInstructionSkills() is called.
 */
export async function loadInstructionSkills(): Promise<string> {
  if (cachedInstructions !== undefined && (Date.now() - cacheTimestamp) < INSTRUCTION_TTL_MS) {
    return cachedInstructions;
  }

  const skills = getEnabledSkills().filter((s) => s.tier === SkillTier.Tier0);

  if (skills.length === 0) {
    cachedInstructions = '';
    cacheTimestamp = Date.now();
    return cachedInstructions;
  }

  const parts: string[] = [];

  for (const skill of skills) {
    // Check for inline instruction content first (from config or DB column)
    const inlineContent =
      (typeof skill.config.instructionContent === 'string'
        ? skill.config.instructionContent
        : undefined) ?? skill.instructionContent;

    if (inlineContent) {
      parts.push(`## Skill: ${skill.name}\n\n${inlineContent.trim()}`);
      log.info({ skillId: skill.id }, 'loaded inline instruction skill');
      continue;
    }

    // Fall back to file-based instruction path
    if (!skill.instructionPath) {
      log.warn({ skillId: skill.id }, 'Tier 0 skill missing both instructionContent and instructionPath, skipping');
      continue;
    }

    try {
      const content = await readFile(skill.instructionPath, 'utf-8');
      parts.push(`## Skill: ${skill.name}\n\n${content.trim()}`);
      log.info({ skillId: skill.id, path: skill.instructionPath }, 'loaded instruction skill');
    } catch (err) {
      log.warn({ err, skillId: skill.id, path: skill.instructionPath }, 'could not load instruction skill file');
    }
  }

  cachedInstructions = parts.join('\n\n---\n\n');
  cacheTimestamp = Date.now();
  return cachedInstructions;
}

/**
 * Clear the cached instruction skills, forcing a reload on next call.
 */
export function reloadInstructionSkills(): void {
  cachedInstructions = undefined;
  cacheTimestamp = 0;
  log.info('instruction skill cache cleared');
}
