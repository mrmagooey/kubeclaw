import OpenAI from 'openai';
import {
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizationUserMessage,
} from './prompts.js';

export interface SummaryResult {
  text: string;
  tokenCount: number;
}

/**
 * Call the LLM to summarize a message slice.
 *
 * Uses the same OpenAI client instance as the channel runner — credentials,
 * base URL, and proxy settings are inherited automatically.
 *
 * Throws on API error or empty response. The caller must handle errors and
 * decide whether to fall back to the sliding-window behavior.
 */
export async function summarize(
  messages: { role: string; content: string }[],
  client: OpenAI,
  model: string,
): Promise<SummaryResult> {
  const userMessage = buildSummarizationUserMessage(messages);
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 600,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('Summarizer returned empty response');

  const tokenCount = response.usage?.total_tokens ?? 0;
  return { text, tokenCount };
}
