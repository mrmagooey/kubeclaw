// src/runtime/search-command.ts
import { searchConversations } from '../db.js';

const USAGE = [
  'Search conversation history:',
  '  /search <query>',
  '  /search --limit <n> <query>',
  '  /search --since <YYYY[-MM[-DD]]> <query>',
  '  /search --before <YYYY[-MM[-DD]]> <query>',
  '',
  'Flags may be combined: /search --limit 5 --since 2026-04 kubernetes',
  'Search is scoped to the current group. Max 10 results by default.',
].join('\n');

interface ParsedSearchArgs {
  query: string;
  limit: number;
  since?: string;
  before?: string;
}

/**
 * Expand a partial date string to an inclusive ISO timestamp for use in SQL comparisons.
 *
 * Partial dates are expanded to cover the entire period they represent:
 *   YYYY        → for `before`: YYYY-12-31T23:59:59.999Z
 *                  for `since`:  YYYY-01-01T00:00:00.000Z
 *   YYYY-MM     → for `before`: YYYY-MM-<last day>T23:59:59.999Z
 *                  for `since`:  YYYY-MM-01T00:00:00.000Z
 *   YYYY-MM-DD  → for `before`: YYYY-MM-DDT23:59:59.999Z
 *                  for `since`:  YYYY-MM-DDT00:00:00.000Z
 *   Full ISO (contains 'T') → passed through unchanged.
 */
export function expandPartialDate(
  dateStr: string,
  mode: 'before' | 'since',
): string {
  // Already a full ISO timestamp — pass through unchanged.
  if (dateStr.includes('T')) return dateStr;

  const parts = dateStr.split('-');

  if (parts.length === 1) {
    // YYYY
    const year = parts[0];
    if (mode === 'before') return `${year}-12-31T23:59:59.999Z`;
    return `${year}-01-01T00:00:00.000Z`;
  }

  if (parts.length === 2) {
    // YYYY-MM
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    if (mode === 'before') {
      // new Date(year, month, 0) gives the last day of `month` (month is 1-based here)
      const lastDay = new Date(year, month, 0).getDate();
      const mm = parts[1];
      const dd = String(lastDay).padStart(2, '0');
      return `${parts[0]}-${mm}-${dd}T23:59:59.999Z`;
    }
    return `${parts[0]}-${parts[1]}-01T00:00:00.000Z`;
  }

  // YYYY-MM-DD
  if (mode === 'before') return `${dateStr}T23:59:59.999Z`;
  return `${dateStr}T00:00:00.000Z`;
}

function parseSearchArgs(message: string): ParsedSearchArgs | null {
  // Strip the command prefix
  let remaining = message.trim().replace(/^\/search\s*/, '');
  if (!remaining) return null;

  let limit = 10;
  let since: string | undefined;
  let before: string | undefined;

  // --limit N
  const limitMatch = /--limit\s+(\d+)/.exec(remaining);
  if (limitMatch) {
    limit = Math.min(Math.max(1, parseInt(limitMatch[1], 10)), 50);
    remaining = remaining.replace(limitMatch[0], '').trim();
  }

  // --since YYYY[-MM[-DD[THH:MM:SS...]]]
  const sinceMatch = /--since\s+(\S+)/.exec(remaining);
  if (sinceMatch) {
    since = expandPartialDate(sinceMatch[1], 'since');
    remaining = remaining.replace(sinceMatch[0], '').trim();
  }

  // --before YYYY[-MM[-DD[THH:MM:SS...]]]
  const beforeMatch = /--before\s+(\S+)/.exec(remaining);
  if (beforeMatch) {
    before = expandPartialDate(beforeMatch[1], 'before');
    remaining = remaining.replace(beforeMatch[0], '').trim();
  }

  const query = remaining.trim();
  if (!query) return null;

  return { query, limit, since, before };
}

export function isSearchCommand(message: string): boolean {
  return /^\/search(\s|$)/.test(message.trim());
}

export function handleSearchCommand(
  groupFolder: string,
  message: string,
): string {
  const args = parseSearchArgs(message);
  if (!args) return `Usage:\n${USAGE}`;

  const results = searchConversations({
    groupFolder,
    query: args.query,
    limit: args.limit,
    after: args.since,
    before: args.before,
  });

  if (results.length === 0) {
    return `No results for "${args.query}".`;
  }

  const lines = results.map((r, i) => {
    const date = r.createdAt.slice(0, 10); // YYYY-MM-DD
    const role = r.role === 'user' ? 'You' : 'Assistant';
    return `[${i + 1}] [${date}] ${role}: ${r.snippet}`;
  });

  const header = `Found ${results.length} result${results.length === 1 ? '' : 's'} for "${args.query}":`;
  return [header, ...lines].join('\n');
}
