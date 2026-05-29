/**
 * read_user_profile — in-process local tool for DirectLLMRunner.
 *
 * Reads the per-group structured user profile via getGroupProfile (Plan 2).
 * Returns a JSON-serialised GroupProfile, or '{}' if no profile row exists or
 * if getGroupProfile is not yet available (graceful degradation pre-Plan-2).
 */
import { getGroupProfile } from '../../db.js';
import { logger } from '../../logger.js';
import type { ContainerInput } from '../types.js';
import type { LocalTool } from '../direct-llm-runner.js';
import OpenAI from 'openai';

export async function readUserProfileHandler(
  _args: Record<string, unknown>,
  input: ContainerInput,
): Promise<string> {
  let profile: ReturnType<typeof getGroupProfile>;
  try {
    profile = getGroupProfile(input.groupFolder);
  } catch (err) {
    logger.error(
      { err, groupFolder: input.groupFolder },
      'read_user_profile: getGroupProfile threw; profile unavailable',
    );
    return '{"error":"profile_unavailable"}';
  }
  if (!profile) return '{}';
  return JSON.stringify(profile);
}

export const READ_USER_PROFILE_TOOL: LocalTool = {
  def: {
    type: 'function',
    function: {
      name: 'read_user_profile',
      description:
        'Read the stored user profile for this conversation (timezone, location, cuisine preferences, ' +
        'dietary restrictions, budget tier). Call this at the start of any recommendation flow. ' +
        'Returns a JSON object; empty object ({}) means no profile has been set yet.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  } as OpenAI.ChatCompletionTool,
  handler: readUserProfileHandler,
};
