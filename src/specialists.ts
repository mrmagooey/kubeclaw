import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { resolveGroupFolderPath } from './group-folder.js';

export interface SpecialistDef {
  name: string;
  prompt: string;
  triggers?: string[]; // Additional trigger aliases, e.g. ["@Research", "@Researcher"]
  llmProvider?: string; // Override LLM provider for this specialist
  containerConfig?: Record<string, unknown>; // Partial ContainerConfig overrides
  memory?: { isolated?: boolean }; // If isolated=true, use specialist-scoped session key
  claudemd?: string; // Extra system-prompt content appended for this specialist
}

/**
 * Load specialist definitions for a group.
 * Returns null if agents.json is absent or invalid (log a warning on invalid).
 * Never throws.
 */
export function loadSpecialists(groupFolder: string): SpecialistDef[] | null {
  // Validate group folder path using the safe resolver
  let groupPath: string;
  try {
    groupPath = resolveGroupFolderPath(groupFolder);
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Invalid group folder name');
    return null;
  }

  const filePath = path.join(groupPath, 'agents.json');

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    // File not found is not an error condition - return null silently
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Other read errors should log warning
    logger.warn({ err, groupFolder }, 'Failed to read agents.json');
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Failed to parse agents.json');
    return null;
  }

  // Validate top-level structure
  if (typeof parsed !== 'object' || parsed === null) {
    logger.warn({ groupFolder }, 'agents.json must be an object');
    return null;
  }

  const parsedObj = parsed as Record<string, unknown>;

  // Validate specialists array exists and is non-empty
  if (!('specialists' in parsedObj)) {
    logger.warn({ groupFolder }, 'agents.json missing "specialists" array');
    return null;
  }

  const specialists = parsedObj.specialists;

  if (!Array.isArray(specialists)) {
    logger.warn({ groupFolder }, 'agents.json "specialists" must be an array');
    return null;
  }

  if (specialists.length === 0) {
    logger.warn({ groupFolder }, 'agents.json "specialists" array is empty');
    return null;
  }

  // Validate each specialist entry
  const validatedSpecialists: SpecialistDef[] = [];
  for (let i = 0; i < specialists.length; i++) {
    const entry = specialists[i];

    if (typeof entry !== 'object' || entry === null) {
      logger.warn(
        { groupFolder, index: i },
        'Specialist entry must be an object',
      );
      return null;
    }

    const entryObj = entry as Record<string, unknown>;

    // Validate name
    if (
      !('name' in entryObj) ||
      typeof entryObj.name !== 'string' ||
      entryObj.name.trim() === ''
    ) {
      logger.warn(
        { groupFolder, index: i },
        'Specialist entry missing non-empty "name" string',
      );
      return null;
    }

    // Validate prompt
    if (
      !('prompt' in entryObj) ||
      typeof entryObj.prompt !== 'string' ||
      entryObj.prompt.trim() === ''
    ) {
      logger.warn(
        { groupFolder, index: i },
        'Specialist entry missing non-empty "prompt" string',
      );
      return null;
    }

    // Collect optional extended fields if present and valid
    const triggers =
      Array.isArray(entryObj.triggers) &&
      entryObj.triggers.every((t) => typeof t === 'string')
        ? (entryObj.triggers as string[])
        : undefined;

    const llmProvider =
      typeof entryObj.llmProvider === 'string'
        ? entryObj.llmProvider
        : undefined;

    const containerConfig =
      typeof entryObj.containerConfig === 'object' &&
      entryObj.containerConfig !== null &&
      !Array.isArray(entryObj.containerConfig)
        ? (entryObj.containerConfig as Record<string, unknown>)
        : undefined;

    const memoryIsolated =
      typeof entryObj.memory === 'object' &&
      entryObj.memory !== null &&
      typeof (entryObj.memory as Record<string, unknown>).isolated === 'boolean'
        ? {
            isolated: (entryObj.memory as Record<string, unknown>)
              .isolated as boolean,
          }
        : undefined;

    const claudemd =
      typeof entryObj.claudemd === 'string' ? entryObj.claudemd : undefined;

    validatedSpecialists.push({
      name: entryObj.name.trim(),
      prompt: entryObj.prompt.trim(),
      ...(triggers !== undefined && { triggers }),
      ...(llmProvider !== undefined && { llmProvider }),
      ...(containerConfig !== undefined && { containerConfig }),
      ...(memoryIsolated !== undefined && { memory: memoryIsolated }),
      ...(claudemd !== undefined && { claudemd }),
    });
  }

  return validatedSpecialists;
}

/**
 * Extract specialists mentioned in the prompt via @Name syntax.
 * Matching is case-insensitive. Returns only specialists present in `available`.
 * Returns empty array if none matched.
 */
export function detectMentionedSpecialists(
  prompt: string,
  available: SpecialistDef[],
): SpecialistDef[] {
  // Find all @Name mentions in the prompt
  const mentionRegex = /@(\w+)/g;
  const mentionedNames = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(prompt)) !== null) {
    mentionedNames.add(match[1].toLowerCase());
  }

  if (mentionedNames.size === 0) {
    return [];
  }

  // Return specialists that match mentioned names or triggers, in order of available array
  const result: SpecialistDef[] = [];
  const seen = new Set<string>();

  for (const specialist of available) {
    const lowerName = specialist.name.toLowerCase();
    if (seen.has(lowerName)) continue;

    // Check name match
    const nameMatched = mentionedNames.has(lowerName);

    // Check triggers: strip leading '@', compare case-insensitively
    const triggerMatched =
      !nameMatched &&
      Array.isArray(specialist.triggers) &&
      specialist.triggers.some((t) =>
        mentionedNames.has(t.replace(/^@/, '').toLowerCase()),
      );

    if (nameMatched || triggerMatched) {
      result.push(specialist);
      seen.add(lowerName);
    }
  }

  return result;
}
