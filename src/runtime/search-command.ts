// src/runtime/search-command.ts
import { searchConversations } from '../db.js';

const USAGE = [
  'Search conversation history:',
  '  /search <query>',
  '  /search --limit <n> <query>',
  '  /search --since <YYYY-MM[-DD]> <query>',
  '  /search --before <YYYY-MM[-DD]> <query>',
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

  // --since YYYY-MM[-DD]
  const sinceMatch = /--since\s+(\d{4}-\d{2}(?:-\d{2})?)/.exec(remaining);
  if (sinceMatch) {
    since = sinceMatch[1];
    remaining = remaining.replace(sinceMatch[0], '').trim();
  }

  // --before YYYY-MM[-DD]
  const beforeMatch = /--before\s+(\d{4}-\d{2}(?:-\d{2})?)/.exec(remaining);
  if (beforeMatch) {
    before = beforeMatch[1];
    remaining = remaining.replace(beforeMatch[0], '').trim();
  }

  const query = remaining.trim();
  if (!query) return null;

  return { query, limit, since, before };
}

export function isSearchCommand(message: string): boolean {
  return /^\/search(\s|$)/.test(message.trim());
}

export function handleSearchCommand(groupFolder: string, message: string): string {
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
