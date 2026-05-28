/**
 * E2E tests for the set_reminder LocalTool.
 *
 * Uses the in-process mock LLM server to simulate the LLM calling
 * set_reminder, then asserts:
 *   1. The tool result fed back to the LLM contains "Reminder set" and the
 *      reminder text.
 *   2. The final runner output status is 'success'.
 *   3. The confirmation reply echoes the reminder text and a human-readable
 *      datetime.
 *
 * No Kubernetes required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getMockLlmPort } from './setup.js';
import { _initTestDatabase } from '../src/db.js';

describe('set_reminder — e2e', () => {
  const whenIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    await _initTestDatabase();

    const port = getMockLlmPort();
    if (!port) return;
    process.env.OPENAI_BASE_URL = `http://localhost:${port}/v1`;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DIRECT_LLM_MODEL = 'test/model';
  });

  it('returns success and a confirmation containing the reminder text and human-readable time', async () => {
    if (!getMockLlmPort()) return;

    // We inject a custom OpenAI client stub so we can control the two-turn
    // exchange without depending on the mock LLM server's routing logic.
    const groupFolder = `e2e-reminder-${Date.now()}`;
    const whenIsoLocal = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    // Import the real DirectLLMRunner (which registers set_reminder).
    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');

    let capturedToolResult: string | undefined;

    const stubCreate = (async (req: {
      messages: Array<{ role: string; content?: string }>;
    }) => {
      // If there is a tool result in the messages, this is the second call.
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      if (hasToolResult) {
        const toolMsg = req.messages.find((m) => m.role === 'tool');
        capturedToolResult = toolMsg?.content ?? '';
        return {
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: `Reminder set for ${new Date(whenIsoLocal).toLocaleString()}: "call the dentist".`,
            },
          }],
        };
      }
      // First call: return a set_reminder tool call.
      return {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'e2e_call_1',
              type: 'function',
              function: {
                name: 'set_reminder',
                arguments: JSON.stringify({
                  reminder_text: 'call the dentist',
                  when_iso: whenIsoLocal,
                }),
              },
            }],
          },
        }],
      };
    }) as unknown as typeof import('openai').default.prototype.chat.completions.create;

    const fakeClient = {
      chat: { completions: { create: stubCreate } },
    } as unknown as import('openai').default;

    const runner = new DirectLLMRunner(fakeClient);
    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      {
        prompt: 'remind me to call the dentist in 2 hours',
        groupFolder,
        chatJid: `${groupFolder}@e2e`,
        isMain: false,
        assistantName: 'Bot',
      },
    );

    // AC1: runner completes successfully
    expect(output.status).toBe('success');

    // AC2: tool result fed back to LLM contains reminder text + "Reminder set"
    expect(capturedToolResult).toBeDefined();
    expect(capturedToolResult).toMatch(/call the dentist/);
    expect(capturedToolResult).toMatch(/Reminder set/i);

    // AC3: final reply from LLM echoes reminder text and human-readable time
    expect(output.result).toMatch(/call the dentist/);
    expect(output.result).toMatch(/20[23]\d/); // year in toLocaleString()
  });

  it('returns an error tool result (not a crash) when LLM passes a relative when_iso', async () => {
    if (!getMockLlmPort()) return;

    const groupFolder = `e2e-reminder-bad-${Date.now()}`;
    const { DirectLLMRunner } = await import('../src/runtime/direct-llm-runner.js');

    let capturedToolResult: string | undefined;

    const stubCreate = (async (req: {
      messages: Array<{ role: string; content?: string }>;
    }) => {
      const hasToolResult = req.messages.some((m) => m.role === 'tool');
      if (hasToolResult) {
        capturedToolResult = req.messages.find((m) => m.role === 'tool')?.content ?? '';
        return {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'I could not set that reminder.' },
          }],
        };
      }
      return {
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'e2e_call_bad',
              type: 'function',
              function: {
                name: 'set_reminder',
                arguments: JSON.stringify({
                  reminder_text: 'call dentist',
                  when_iso: 'in 3 days',
                }),
              },
            }],
          },
        }],
      };
    }) as unknown as typeof import('openai').default.prototype.chat.completions.create;

    const fakeClient = {
      chat: { completions: { create: stubCreate } },
    } as unknown as import('openai').default;

    const runner = new DirectLLMRunner(fakeClient);
    const output = await runner.runAgent(
      { name: groupFolder, folder: groupFolder, trigger: '', added_at: new Date().toISOString() },
      {
        prompt: 'remind me to call dentist in 3 days',
        groupFolder,
        chatJid: `${groupFolder}@e2e`,
        isMain: false,
        assistantName: 'Bot',
      },
    );

    // Runner must not crash — it returns success (the LLM handled the error gracefully)
    expect(output.status).toBe('success');

    // Tool result must be an error string, not an exception
    expect(capturedToolResult).toBeDefined();
    expect(capturedToolResult).toMatch(/invalid.*datetime/i);
  });
});
