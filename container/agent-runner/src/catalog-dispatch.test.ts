import { describe, it, expect, vi } from 'vitest';
import { callCatalogToolViaRedis } from './index.js';

function fakeRedis() {
  const adds: Array<{ stream: string; fields: Record<string, string> }> = [];
  let resultPushed = false;
  return {
    adds,
    xAdd: vi.fn(
      async (stream: string, _id: string, fields: Record<string, string>) => {
        adds.push({ stream, fields });
        return '1-0';
      },
    ),
    xRead: vi.fn(async () => {
      const call = adds.find((a) => a.stream.startsWith('kubeclaw:toolcalls:'));
      if (call && !resultPushed) {
        resultPushed = true;
        return [
          {
            name: `kubeclaw:toolresults:job-1:bash`,
            messages: [
              {
                id: '1-0',
                message: {
                  requestId: call.fields.requestId,
                  result: JSON.stringify('hello'),
                },
              },
            ],
          },
        ];
      }
      return null;
    }),
  };
}

describe('callCatalogToolViaRedis', () => {
  it('writes the call, spawns by name, and returns the correlated result', async () => {
    const redis = fakeRedis();
    const spawned = new Set<string>();
    const out = await callCatalogToolViaRedis(
      redis as any,
      'job-1',
      'g1',
      '',
      { name: 'bash', description: 'd', parameters: {} },
      { command: 'echo hello' },
      spawned,
    );
    expect(out).toBe('hello');

    const call = redis.adds.find(
      (a) => a.stream === 'kubeclaw:toolcalls:job-1:bash',
    );
    expect(call?.fields.tool).toBe('bash');
    expect(JSON.parse(call!.fields.input)).toEqual({ command: 'echo hello' });

    const spawn = redis.adds.find(
      (a) => a.stream === 'kubeclaw:spawn-tool-pod',
    );
    expect(spawn?.fields).toMatchObject({
      agentJobId: 'job-1',
      groupFolder: 'g1',
      category: 'bash',
      channel: '',
    });
    expect(spawn?.fields.timeout).toBeDefined();
  });

  it('spawns only once per tool name', async () => {
    const redis = fakeRedis();
    const spawned = new Set<string>();
    await callCatalogToolViaRedis(
      redis as any,
      'job-1',
      'g1',
      '',
      { name: 'bash', description: 'd', parameters: {} },
      { command: 'a' },
      spawned,
    );
    const spawnCount = redis.adds.filter(
      (a) => a.stream === 'kubeclaw:spawn-tool-pod',
    ).length;
    expect(spawnCount).toBe(1);
    expect(spawned.has('bash')).toBe(true);
  });
});
