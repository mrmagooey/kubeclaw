/**
 * Prompts used by the context-compression summarizer.
 *
 * The summarization call is a separate LLM request using the same
 * client/credentials as the channel's normal conversation. Keep the
 * system prompt short to minimize billed tokens.
 */

export const SUMMARIZER_SYSTEM_PROMPT = `\
You are a conversation archiver. Your output will be inserted verbatim into
future conversation context as a compressed memory header. Write in dense,
factual prose — no filler words, no pleasantries. Cover:
1. What the user asked or instructed (chronological order).
2. What the assistant decided and why (key reasoning steps).
3. Tool calls made and their outcomes.
4. Any facts, values, or names that were established and may be referenced later.
5. Any open tasks or unresolved questions at the point the conversation was cut.
Limit: 400 words. Do NOT add commentary about the summarization process itself.`;

/**
 * Build the user-turn message for the summarization call.
 *
 * @param messages  The conversation slice to summarize (oldest → newest).
 * @returns         A formatted string ready to send as the user message.
 */
export function buildSummarizationUserMessage(
  messages: { role: string; content: string }[],
): string {
  const lines = messages.map(
    (m, i) => `[${i + 1}] ${m.role.toUpperCase()}: ${m.content}`,
  );
  return (
    `Summarize the following conversation segment (${messages.length} messages):\n\n` +
    lines.join('\n\n')
  );
}
