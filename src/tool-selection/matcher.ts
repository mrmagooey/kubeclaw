import type { ToolSpec } from '../tools/types.js';

export type ChatFn = (
  messages: { role: string; content: string }[],
) => Promise<string>;

export interface MatchResult {
  name: string | null;
  confidence: number;
  reason: string;
}

export async function matchTool(
  taskDescription: string,
  specs: ToolSpec[],
  chat: ChatFn,
): Promise<MatchResult> {
  if (specs.length === 0)
    return { name: null, confidence: 0, reason: 'empty set' };

  const catalogText = specs
    .map(
      (s) =>
        `- ${s.name}: ${s.description} (params: ${JSON.stringify(s.parameters)})`,
    )
    .join('\n');

  const system =
    'You select the single best tool for a task. Respond with STRICT JSON only: ' +
    '{"name": <tool name or null>, "confidence": <0..1>, "reason": <string>}. ' +
    'Pick a tool only if it genuinely fits; otherwise name=null.';
  const user = `Task: ${taskDescription}\n\nAvailable tools:\n${catalogText}`;

  const raw = await chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  let parsed: MatchResult;
  try {
    parsed = JSON.parse(raw) as MatchResult;
  } catch {
    return { name: null, confidence: 0, reason: 'unparseable LLM response' };
  }

  // Guard against hallucinated names.
  if (parsed.name !== null && !specs.some((s) => s.name === parsed.name)) {
    return {
      name: null,
      confidence: 0,
      reason: 'selected name not in candidate set',
    };
  }
  return {
    name: parsed.name ?? null,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    reason: parsed.reason ?? '',
  };
}
