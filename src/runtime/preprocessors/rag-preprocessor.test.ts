import { describe, it, expect, vi } from 'vitest';

const augmentPrompt = vi.hoisted(() => vi.fn());
vi.mock('../../rag/provider.js', () => ({ augmentPrompt }));
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { RagPreprocessor } from './rag-preprocessor.js';
import { runPreprocessorChain } from './chain.js';

describe('RagPreprocessor', () => {
  it('is an augment effect named rag', () => {
    const p = new RagPreprocessor();
    expect(p.name).toBe('rag');
    expect(p.effect).toBe('augment');
  });

  it('delegates to augmentPrompt and never sets persistedContent', async () => {
    augmentPrompt.mockResolvedValueOnce('<retrieved_context>\nMEM\n</retrieved_context>\n\nhello');
    const result = await new RagPreprocessor().apply({ groupFolder: 'g', prompt: 'hello' });
    expect(augmentPrompt).toHaveBeenCalledWith('g', 'hello');
    expect(result.prompt).toBe('<retrieved_context>\nMEM\n</retrieved_context>\n\nhello');
    expect(result.persistedContent).toBeUndefined();
  });

  it('is non-fatal: returns the input prompt when augmentPrompt throws', async () => {
    augmentPrompt.mockRejectedValueOnce(new Error('qdrant down'));
    const result = await new RagPreprocessor().apply({ groupFolder: 'g', prompt: 'hello' });
    expect(result.prompt).toBe('hello');
    expect(result.persistedContent).toBeUndefined();
  });

  // Regression: a chain with only RAG reproduces the SP2 seam byte-for-byte.
  it('chain with only RagPreprocessor: prompt=augmented, persistedContent=original', async () => {
    augmentPrompt.mockResolvedValueOnce('<retrieved_context>\nM\n</retrieved_context>\n\nhi');
    const out = await runPreprocessorChain([new RagPreprocessor()], 'g', 'hi');
    expect(out.prompt).toBe('<retrieved_context>\nM\n</retrieved_context>\n\nhi');
    expect(out.persistedContent).toBe('hi');
  });
});
