/**
 * Lightweight snapshot test for the web_search tool definition in TOOLS.
 *
 * Ensures the description documents structured result fields (snippet, url,
 * title) so the LLM knows what to expect from the new Brave Search backend.
 * No mocking needed — just imports the constant.
 */
import { describe, it, expect } from 'vitest';

// TOOLS is not currently exported.  After Step 3 adds `export`, this resolves.
import { TOOLS } from './runtime/direct-llm-runner.js';
import type OpenAI from 'openai';

describe('web_search tool definition', () => {
  const webSearchTool = (TOOLS as OpenAI.ChatCompletionFunctionTool[]).find(
    (t) => t.function.name === 'web_search',
  );

  it('tool definition exists', () => {
    expect(webSearchTool).toBeDefined();
  });

  it('description mentions structured JSON result fields', () => {
    const desc = webSearchTool!.function.description;
    expect(desc).toMatch(/snippet/i);
    expect(desc).toMatch(/title/i);
    expect(desc).toMatch(/url/i);
    expect(desc).toMatch(/json/i);
  });

  it('query parameter is still required', () => {
    const params = webSearchTool!.function.parameters as {
      required?: string[];
    };
    expect(params.required).toContain('query');
  });
});
