// LLM model + credential selection for the agent runtime.
//
// All providers run through pi-ai's native APIs — there is no LLM CLI/SDK in the
// container. The provider is selected by KUBECLAW_LLM_PROVIDER; per-provider
// model id, base URL, and API key come from env vars injected by the
// orchestrator (see src/k8s/job-runner.ts).
import type { Model, Api } from '@mariozechner/pi-ai';

export function buildModel(): Model<Api> {
  const provider = process.env.KUBECLAW_LLM_PROVIDER || 'openai';

  if (provider === 'claude' || provider === 'anthropic') {
    const modelId = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
    return {
      id: modelId,
      name: modelId,
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };
  }

  if (provider === 'openrouter') {
    const modelId = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'openrouter',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
  }

  if (provider === 'ollama') {
    const modelId = process.env.OLLAMA_MODEL || 'llama3.2';
    return {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl: `${process.env.OLLAMA_HOST || 'http://ollama:11434'}/v1`,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };
  }

  // Default: OpenAI-compatible
  const modelId = process.env.OPENAI_MODEL || process.env.DIRECT_LLM_MODEL || 'gpt-4o';
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

export function getApiKeyForProvider(provider: string): string | undefined {
  if (provider === 'claude' || provider === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY;
  }
  if (provider === 'openrouter') {
    return process.env.OPENROUTER_API_KEY;
  }
  if (provider === 'ollama') return 'ollama';
  return process.env.OPENAI_API_KEY;
}
