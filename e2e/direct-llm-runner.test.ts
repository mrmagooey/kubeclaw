/**
 * DirectLLMRunner E2E Tests
 *
 * Verifies that DirectLLMRunner correctly:
 *   - Calls the LLM API and returns a text response
 *   - Invokes the onOutput callback with the result
 *   - Persists conversation history in SQLite
 *   - Merges custom tool definitions from containerConfig.tools
 *
 * Uses the in-process mock LLM server started by global setup.
 * No Kubernetes required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase } from '../src/db.js';

describe('DirectLLMRunner', () => {
  beforeAll(async () => {
    // Ensure the test database is initialized even if Redis was unavailable
    // during the global setup (setup.ts skips _initTestDatabase on Redis failure).
    await _initTestDatabase();

    const port = getMockLlmPort();
    if (!port) return;
    // Point the LLM client at the mock server before any runner is constructed.
    // createLLMClient() reads these env vars at construction time.
    process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DIRECT_LLM_MODEL = 'test/model';
  });

  it('returns a successful text response for a plain prompt', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const groupFolder = `dlr-plain-${Date.now()}`;

    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      { prompt: 'Say hello', groupFolder, chatJid: 'e2e@e2e', isMain: false, assistantName: 'Bot' },
    );

    expect(output.status).toBe('success');
    expect(typeof output.result).toBe('string');
    expect(output.result!.length).toBeGreaterThan(0);
    console.log(`✅ DirectLLMRunner plain response: "${output.result}"`);
  });

  it('invokes onOutput callback with the result', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const groupFolder = `dlr-cb-${Date.now()}`;
    const captured: string[] = [];

    await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      { prompt: 'help me please', groupFolder, chatJid: 'e2e@e2e', isMain: false, assistantName: 'Bot' },
      undefined,
      async (out) => { if (out.result) captured.push(out.result); },
    );

    expect(captured.length).toBeGreaterThan(0);
    console.log(`✅ onOutput called with: "${captured[0]}"`);
  });

  it('persists conversation history across two calls', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const { getConversationHistory } = await import('../src/db.js');
    const runner = new DirectLLMRunner();
    const groupFolder = `dlr-hist-${Date.now()}`;
    const group = { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() };
    const input = (prompt: string) => ({ prompt, groupFolder, chatJid: 'e2e@e2e', isMain: false, assistantName: 'Bot' });

    await runner.runAgent(group, input('First message'));
    await runner.runAgent(group, input('Second message'));

    const history = getConversationHistory(groupFolder);

    // Should have: user(1), assistant(1), user(2), assistant(2) = 4 entries
    expect(history.length).toBeGreaterThanOrEqual(4);
    expect(history.some((m) => m.content === 'First message')).toBe(true);
    expect(history.some((m) => m.content === 'Second message')).toBe(true);
    console.log(`✅ Conversation history has ${history.length} entries`);
  });

  it('accepts custom tool definitions from containerConfig.tools without error', async () => {
    if (!getMockLlmPort()) return;

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const groupFolder = `dlr-tools-${Date.now()}`;

    // The mock LLM always returns plain text (never calls tools),
    // so the runner must accept custom tool defs without crashing.
    const output = await runner.runAgent(
      {
        name: groupFolder,
        folder: groupFolder,
        trigger: '',
        added_at: new Date().toISOString(),
        containerConfig: {
          tools: [
            {
              name: 'home_control',
              description: 'Control smart home devices',
              parameters: {
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command'],
              },
              image: 'alpine:latest',
              pattern: 'http' as const,
              port: 8080,
            },
          ],
        },
      },
      { prompt: 'turn on the lights', groupFolder, chatJid: 'e2e@e2e', isMain: false, assistantName: 'Bot' },
    );

    expect(output.status).toBe('success');
    console.log(`✅ Custom tool definitions accepted, response: "${output.result}"`);
  });

  it('returns error status on API failure', async () => {
    // Override to a non-existent port to force a connection error
    const origUrl = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'http://localhost:19999';

    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');
    const runner = new DirectLLMRunner();
    const groupFolder = `dlr-err-${Date.now()}`;

    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      { prompt: 'hello', groupFolder, chatJid: 'e2e@e2e', isMain: false, assistantName: 'Bot' },
    );

    expect(output.status).toBe('error');
    expect(output.error).toBeTruthy();
    console.log(`✅ API failure correctly returns error status: "${output.error}"`);

    process.env.OPENAI_BASE_URL = origUrl;
  });
});
