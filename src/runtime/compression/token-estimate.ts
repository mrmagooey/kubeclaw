/**
 * Heuristic token estimator — no LLM call.
 *
 * Uses the 4-chars-per-token approximation. Suitable for threshold checks
 * only; do not use for billing or precise context-window management.
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(
  messages: { role: string; content: string }[],
): number {
  if (messages.length === 0) return 0;
  const totalChars = messages.reduce(
    (sum, m) => sum + m.role.length + m.content.length,
    0,
  );
  return Math.ceil(totalChars / 4);
}
