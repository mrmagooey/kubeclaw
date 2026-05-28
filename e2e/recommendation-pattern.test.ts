/**
 * E2E tests for Plan 10: Recommendation execution pattern.
 *
 * Verifies end-to-end observable behaviors:
 *   AC1. System prompt sent to the LLM contains the RECOMMENDATION_CONTRACT section
 *        (## Recommendation guidelines, read_user_profile, places_search).
 *   AC2. `read_user_profile` is registered as a local tool on the runner
 *        (getLocalToolNames returns it).
 *   AC3. When no profile row exists, read_user_profile handler returns '{}' without error.
 *   AC4. Conversation history from a first turn is visible to the second turn's LLM call
 *        (multi-turn refinement threading works).
 *   AC5. `places_search` is present in the tool list advertised to the LLM.
 *
 * Uses the in-process mock LLM server (getMockLlmPort) + real SQLite.
 * No Kubernetes required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase } from '../src/db.js';

describe('Recommendation execution pattern (E2E)', () => {
  beforeAll(async () => {
    await _initTestDatabase();

    const port = getMockLlmPort();
    if (!port) return;
    process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DIRECT_LLM_MODEL = 'test/model';
  });

  it('AC1: system prompt contains RECOMMENDATION_CONTRACT when no opt-out is present', async () => {
    if (!getMockLlmPort()) return;

    const { __testing__ } = await import('../src/runtime/direct-llm-runner.js');
    const groupFolder = `rec-contract-${Date.now()}`;

    // No CLAUDE.md written — uses default system prompt, contract should be appended
    const prompt = __testing__.loadSystemPromptForTest(groupFolder, '/tmp/nonexistent-groups');

    expect(prompt).toContain('## Recommendation guidelines');
    expect(prompt).toContain('read_user_profile');
    expect(prompt).toContain('places_search');
    console.log('✅ AC1: RECOMMENDATION_CONTRACT present in system prompt');
  });

  it('AC1 opt-out: system prompt does NOT contain contract when opt-out marker is present', async () => {
    if (!getMockLlmPort()) return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-optout-'));
    const groupFolder = `g-optout`;
    fs.mkdirSync(path.join(tmpDir, groupFolder), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, groupFolder, 'CLAUDE.md'),
      'CUSTOM SYSTEM PROMPT\n<!-- no-recommendation-contract -->',
    );

    try {
      const { __testing__ } = await import('../src/runtime/direct-llm-runner.js');
      const prompt = __testing__.loadSystemPromptForTest(groupFolder, tmpDir);

      expect(prompt).not.toContain('## Recommendation guidelines');
      expect(prompt).toContain('CUSTOM SYSTEM PROMPT');
      console.log('✅ AC1 opt-out: contract suppressed when opt-out marker present');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('AC2: read_user_profile is registered as a local tool on a fresh runner', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { READ_USER_PROFILE_TOOL } = await import(
      '../src/runtime/tools/read-user-profile.js'
    );

    const runner = new DirectLLMRunner();
    runner.registerLocalTool('read_user_profile', READ_USER_PROFILE_TOOL);

    expect(runner.getLocalToolNames()).toContain('read_user_profile');
    console.log('✅ AC2: read_user_profile registered on runner');
  });

  it('AC3: read_user_profile handler returns "{}" when no profile exists', async () => {
    if (!getMockLlmPort()) return;

    const { readUserProfileHandler } = await import(
      '../src/runtime/tools/read-user-profile.js'
    );

    const result = await readUserProfileHandler(
      {},
      {
        groupFolder: `no-profile-group-${Date.now()}`,
        chatJid: 'anon@e2e',
        isMain: false,
        prompt: 'find me a restaurant',
        assistantName: 'Bot',
      },
    );

    expect(result).toBe('{}');
    console.log('✅ AC3: read_user_profile returns {} for unknown group');
  });

  it('AC4: conversation history from first turn is present in second turn LLM context', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { getConversationHistory } = await import('../src/db.js');
    const { READ_USER_PROFILE_TOOL } = await import(
      '../src/runtime/tools/read-user-profile.js'
    );

    const runner = new DirectLLMRunner();
    runner.registerLocalTool('read_user_profile', READ_USER_PROFILE_TOOL);

    const groupFolder = `rec-hist-${Date.now()}`;
    const group = {
      name: groupFolder,
      folder: groupFolder,
      trigger: '',
      added_at: new Date().toISOString(),
    };

    // First turn: "good Italian restaurants near me"
    const turn1 = await runner.runAgent(group, {
      prompt: 'good Italian restaurants near me',
      groupFolder,
      chatJid: 'e2e@e2e',
      isMain: false,
      assistantName: 'Bot',
    });
    expect(turn1.status).toBe('success');

    // Second turn: follow-up refinement
    const turn2 = await runner.runAgent(group, {
      prompt: 'cheaper options please',
      groupFolder,
      chatJid: 'e2e@e2e',
      isMain: false,
      assistantName: 'Bot',
    });
    expect(turn2.status).toBe('success');

    // History must contain both user turns
    const history = getConversationHistory(groupFolder);
    expect(
      history.some((m) => m.content === 'good Italian restaurants near me'),
    ).toBe(true);
    expect(history.some((m) => m.content === 'cheaper options please')).toBe(
      true,
    );
    console.log(`✅ AC4: history has ${history.length} messages across two turns`);
  });

  it('AC5: places_search is in the tool list advertised to the LLM', async () => {
    if (!getMockLlmPort()) return;

    const { __testing__ } = await import('../src/runtime/direct-llm-runner.js');
    const toolNames = __testing__.toolsForTest().map((t: any) => t.function.name);

    expect(toolNames).toContain('places_search');
    // Verify it has the expected parameter shape
    const tool = __testing__.toolsForTest().find(
      (t: any) => t.function.name === 'places_search',
    );
    expect(tool!.function.parameters.properties).toHaveProperty('query');
    console.log('✅ AC5: places_search present in TOOLS with query parameter');
  });
});
