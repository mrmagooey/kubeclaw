import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const openAICtor = vi.fn();
vi.mock('openai', () => ({
  default: class {
    constructor(opts: unknown) {
      openAICtor(opts);
    }
  },
}));

describe('createLLMClient', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;

  beforeEach(() => {
    openAICtor.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBaseUrl;
  });

  it('uses the OPENAI_API_KEY env var when set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'https://example.com/v1';
    const mod = await import('./llm-client.js');
    mod.createLLMClient();
    expect(openAICtor).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      baseURL: 'https://example.com/v1',
    });
  });

  it('falls back to "no-key" when OPENAI_API_KEY is absent', async () => {
    const mod = await import('./llm-client.js');
    mod.createLLMClient();
    expect(openAICtor).toHaveBeenCalledWith({
      apiKey: 'no-key',
      baseURL: undefined,
    });
  });

  it('passes baseURL as undefined when OPENAI_BASE_URL is absent', async () => {
    process.env.OPENAI_API_KEY = 'sk-xyz';
    const mod = await import('./llm-client.js');
    mod.createLLMClient();
    expect(openAICtor).toHaveBeenCalledWith({
      apiKey: 'sk-xyz',
      baseURL: undefined,
    });
  });
});

describe('DEFAULT_DIRECT_MODEL', () => {
  const originalModel = process.env.DIRECT_LLM_MODEL;

  afterEach(() => {
    if (originalModel === undefined) delete process.env.DIRECT_LLM_MODEL;
    else process.env.DIRECT_LLM_MODEL = originalModel;
    vi.resetModules();
  });

  it('uses DIRECT_LLM_MODEL when set', async () => {
    process.env.DIRECT_LLM_MODEL = 'gpt-test-99';
    vi.resetModules();
    const mod = await import('./llm-client.js');
    expect(mod.DEFAULT_DIRECT_MODEL).toBe('gpt-test-99');
  });

  it('defaults to gpt-4o when DIRECT_LLM_MODEL is not set', async () => {
    delete process.env.DIRECT_LLM_MODEL;
    vi.resetModules();
    const mod = await import('./llm-client.js');
    expect(mod.DEFAULT_DIRECT_MODEL).toBe('gpt-4o');
  });
});
