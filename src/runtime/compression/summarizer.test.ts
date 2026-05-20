import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { summarize } from './summarizer.js';

function makeStubClient(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
          usage: { total_tokens: 55 },
        }),
      },
    },
  } as unknown as OpenAI;
}

describe('summarize', () => {
  it('returns the model response text', async () => {
    const client = makeStubClient('The user asked about cats. No tools used.');
    const messages = [
      { role: 'user', content: 'Tell me about cats.' },
      { role: 'assistant', content: 'Cats are obligate carnivores.' },
    ];
    const result = await summarize(messages, client, 'test-model');
    expect(result.text).toBe('The user asked about cats. No tools used.');
    expect(result.tokenCount).toBe(55);
  });

  it('sends the correct model to the API', async () => {
    const client = makeStubClient('summary');
    const messages = [{ role: 'user', content: 'Hi' }];
    await summarize(messages, client, 'gpt-4o-mini');
    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(call.model).toBe('gpt-4o-mini');
  });

  it('throws if the API returns empty content', async () => {
    const client = makeStubClient('');
    await expect(
      summarize([{ role: 'user', content: 'Hi' }], client, 'gpt-4o'),
    ).rejects.toThrow('Summarizer returned empty response');
  });
});
