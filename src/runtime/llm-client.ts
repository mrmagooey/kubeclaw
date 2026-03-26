/**
 * Shared OpenAI-compatible LLM client factory.
 *
 * Works with any provider that exposes an OpenAI-compatible API:
 *   - OpenAI (default)
 *   - OpenRouter  (OPENAI_BASE_URL=https://openrouter.ai/api/v1)
 *   - Groq        (OPENAI_BASE_URL=https://api.groq.com/openai/v1)
 *   - Mistral     (OPENAI_BASE_URL=https://api.mistral.ai/v1)
 *   - Ollama      (OPENAI_BASE_URL=http://localhost:11434/v1, OPENAI_API_KEY=ollama)
 *   - Any other OpenAI-compatible endpoint
 *
 * Environment variables:
 *   OPENAI_API_KEY   — required (use "ollama" or similar placeholder for local models)
 *   OPENAI_BASE_URL  — optional, overrides the API endpoint
 *   DIRECT_LLM_MODEL — default model for DirectLLMRunner and AdminShell
 */

import OpenAI from 'openai';

export const DEFAULT_DIRECT_MODEL =
  process.env.DIRECT_LLM_MODEL || 'gpt-4o';

export function createLLMClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'no-key',
    baseURL: process.env.OPENAI_BASE_URL,
  });
}
