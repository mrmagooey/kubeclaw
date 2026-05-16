import type { GlobalSpecialist } from './specialists/types.js';

export type { GlobalSpecialist };

/**
 * Extract specialists mentioned in the prompt via @Name syntax.
 * Matching is case-insensitive. Returns only specialists present in `available`.
 * Returns empty array if none matched.
 */
export function detectMentionedSpecialists(
  prompt: string,
  available: GlobalSpecialist[],
): GlobalSpecialist[] {
  const matches = new Map<string, GlobalSpecialist>();
  const re = /@(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const mention = m[1].toLowerCase();
    for (const s of available) {
      if (
        s.name.toLowerCase() === mention ||
        (s.triggers ?? []).some((t) => t.toLowerCase() === mention)
      ) {
        if (!matches.has(s.name)) matches.set(s.name, s);
        break;
      }
    }
  }
  return [...matches.values()];
}
