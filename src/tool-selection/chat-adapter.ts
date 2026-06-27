import { createLLMClient, DEFAULT_DIRECT_MODEL } from '../runtime/llm-client.js';
import type { ChatFn } from './matcher.js';

export function makeOrchestratorChatFn(): ChatFn {
  const client = createLLMClient();
  return async (messages) => {
    const resp = await client.chat.completions.create({
      model: DEFAULT_DIRECT_MODEL,
      messages: messages as Parameters<typeof client.chat.completions.create>[0]['messages'],
    });
    return resp.choices[0]?.message?.content ?? '';
  };
}
