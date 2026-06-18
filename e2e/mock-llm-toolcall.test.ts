/**
 * Unit tests for the mock LLM server tool-call queue.
 *
 * These tests exercise the in-process mock LLM server (e2e/lib/mock-llm-server.ts)
 * to verify that tool-call responses are queued, dequeued in order, and that
 * the queue is cleared correctly.  No Kubernetes cluster is required.
 */

/**
 * NOTE: The mock LLM server is started at port 11434 by the global e2e/setup.ts
 * beforeAll hook, which runs before this test file's tests.  We do NOT start a
 * second server here — we use the already-running instance and talk to it via
 * fetch, exercising the in-process queueToolCallResponse / clearToolCallQueue
 * helpers and the HTTP control endpoints.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  queueToolCallResponse,
  clearToolCallQueue,
  clearResponseTemplates,
  type MockToolCallDef,
} from './lib/mock-llm-server.js';

// Port used by e2e/setup.ts global beforeAll to start the mock LLM server.
const TEST_PORT = 11434;
const BASE = `http://localhost:${TEST_PORT}`;

async function chatCompletion(): Promise<Response> {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'test/model',
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  });
}

beforeEach(() => {
  clearResponseTemplates(); // also clears tool-call queue via clearToolCallQueue()
});

describe('mock LLM server — tool-call queue', () => {
  it('returns a text response when the queue is empty', async () => {
    const res = await chatCompletion();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const choices = body['choices'] as Array<{ finish_reason: string; message: { content: string } }>;
    expect(choices[0].finish_reason).toBe('stop');
    expect(typeof choices[0].message.content).toBe('string');
  });

  it('returns a tool_calls response when one is queued', async () => {
    const def: MockToolCallDef = {
      name: 'execute_agent',
      arguments: { task: 'sleep 300' },
    };
    queueToolCallResponse(def);

    const res = await chatCompletion();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const choices = body['choices'] as Array<{
      finish_reason: string;
      message: {
        role: string;
        content: null;
        tool_calls: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;

    expect(choices[0].finish_reason).toBe('tool_calls');
    expect(choices[0].message.content).toBeNull();
    expect(choices[0].message.tool_calls).toHaveLength(1);

    const toolCall = choices[0].message.tool_calls[0];
    expect(toolCall.type).toBe('function');
    expect(toolCall.function.name).toBe('execute_agent');
    expect(toolCall.id).toMatch(/^call_mock_/);

    const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    expect(args['task']).toBe('sleep 300');
  });

  it('dequeues tool calls in FIFO order', async () => {
    queueToolCallResponse({ name: 'first_tool', arguments: { n: 1 } });
    queueToolCallResponse({ name: 'second_tool', arguments: { n: 2 } });

    const res1 = await chatCompletion();
    const body1 = await res1.json() as Record<string, unknown>;
    const choices1 = body1['choices'] as Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
    expect(choices1[0].message.tool_calls[0].function.name).toBe('first_tool');

    const res2 = await chatCompletion();
    const body2 = await res2.json() as Record<string, unknown>;
    const choices2 = body2['choices'] as Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
    expect(choices2[0].message.tool_calls[0].function.name).toBe('second_tool');

    // Queue now empty — falls back to text response
    const res3 = await chatCompletion();
    const body3 = await res3.json() as Record<string, unknown>;
    const choices3 = body3['choices'] as Array<{ finish_reason: string }>;
    expect(choices3[0].finish_reason).toBe('stop');
  });

  it('clears the queue with clearToolCallQueue()', async () => {
    queueToolCallResponse({ name: 'should_be_cleared', arguments: {} });
    clearToolCallQueue();

    const res = await chatCompletion();
    const body = await res.json() as Record<string, unknown>;
    const choices = body['choices'] as Array<{ finish_reason: string }>;
    expect(choices[0].finish_reason).toBe('stop');
  });

  it('clears the queue when clearResponseTemplates() is called', async () => {
    queueToolCallResponse({ name: 'also_cleared', arguments: {} });
    clearResponseTemplates();

    const res = await chatCompletion();
    const body = await res.json() as Record<string, unknown>;
    const choices = body['choices'] as Array<{ finish_reason: string }>;
    expect(choices[0].finish_reason).toBe('stop');
  });

  it('control endpoint POST /control/queue-tool-call queues a tool call', async () => {
    const queueRes = await fetch(`${BASE}/control/queue-tool-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'control_tool', arguments: { x: 42 } }),
    });
    expect(queueRes.status).toBe(200);
    const queueBody = await queueRes.json() as Record<string, unknown>;
    expect(queueBody['queued']).toBe(true);
    expect(queueBody['queueLength']).toBe(1);

    // Now the next chat completion should return the queued tool call
    const chatRes = await chatCompletion();
    const body = await chatRes.json() as Record<string, unknown>;
    const choices = body['choices'] as Array<{
      finish_reason: string;
      message: { tool_calls: Array<{ function: { name: string } }> };
    }>;
    expect(choices[0].finish_reason).toBe('tool_calls');
    expect(choices[0].message.tool_calls[0].function.name).toBe('control_tool');
  });

  it('control endpoint POST /control/clear clears the queue', async () => {
    queueToolCallResponse({ name: 'will_be_cleared_via_http', arguments: {} });

    const clearRes = await fetch(`${BASE}/control/clear`, { method: 'POST' });
    expect(clearRes.status).toBe(200);
    const clearBody = await clearRes.json() as Record<string, unknown>;
    expect(clearBody['cleared']).toBe(true);

    const res = await chatCompletion();
    const body = await res.json() as Record<string, unknown>;
    const choices = body['choices'] as Array<{ finish_reason: string }>;
    expect(choices[0].finish_reason).toBe('stop');
  });

  it('response has correct OpenAI-compatible shape', async () => {
    queueToolCallResponse({ name: 'shape_check', arguments: { key: 'value' } });

    const res = await chatCompletion();
    const body = await res.json() as Record<string, unknown>;

    expect(typeof body['id']).toBe('string');
    expect(body['object']).toBe('chat.completion');
    expect(typeof body['created']).toBe('number');
    expect(body['model']).toBe('test/model');

    const usage = body['usage'] as Record<string, number>;
    expect(usage['prompt_tokens']).toBe(10);
    expect(usage['completion_tokens']).toBe(20);
    expect(usage['total_tokens']).toBe(30);
  });
});
