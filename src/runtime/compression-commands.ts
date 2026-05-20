import {
  clearConversationHistory,
  getLatestSummary,
  getSummaryById,
  insertSummary,
  getConversationHistory,
  deleteMessagesByIds,
  SummaryRecord,
} from '../db.js';
import { summarize } from './compression/summarizer.js';
import { logger } from '../logger.js';
import OpenAI from 'openai';

export function isCompactCommand(message: string): boolean {
  return /^\/(compact|summary|clear)(\s|$)/.test(message.trim());
}

export interface ParsedCompactArgs {
  verb: 'compact' | 'summary' | 'clear';
  keep: number | null;
}

export function parseCompactArgs(message: string): ParsedCompactArgs {
  const parts = message.trim().split(/\s+/);
  const verb = parts[0].slice(1) as 'compact' | 'summary' | 'clear';
  const keepIdx = parts.indexOf('--keep');
  let keep: number | null = null;
  if (keepIdx !== -1 && parts[keepIdx + 1]) {
    const n = parseInt(parts[keepIdx + 1], 10);
    keep = Number.isFinite(n) && n >= 0 ? n : null;
  }
  return { verb, keep };
}

export async function handleCompactCommand(
  groupFolder: string,
  message: string,
  client: OpenAI,
  model: string,
): Promise<string> {
  const { verb, keep } = parseCompactArgs(message);

  if (verb === 'clear') {
    clearConversationHistory(groupFolder);
    return 'Conversation history and summaries cleared.';
  }

  if (verb === 'summary') {
    const latest = getLatestSummary(groupFolder);
    if (!latest) return 'No summary exists for this group yet.';
    // Walk parent chain newest-first, bounded at 50 iterations to defend against accidental cycles
    const chain: SummaryRecord[] = [];
    let current: SummaryRecord | null = latest;
    for (let i = 0; i < 50 && current; i++) {
      chain.push(current);
      if (!current.parentSummaryId) break;
      current = getSummaryById(current.parentSummaryId);
    }
    const lines = chain.map(
      (s, idx) =>
        `[${idx + 1}/${chain.length}] id=${s.id} created=${s.createdAt} tokens=${s.tokenCount}\n${s.summaryText}`,
    );
    return `Summary chain (${chain.length} entry/entries):\n\n${lines.join('\n\n---\n\n')}`;
  }

  // verb === 'compact'
  const defaultKeep = parseInt(
    process.env.MAX_CONVERSATION_HISTORY || '20',
    10,
  );
  const keepWindow = keep ?? defaultKeep;
  const history = getConversationHistory(groupFolder, 0);

  if (history.length === 0) return 'No conversation history to compact.';

  const toSummarize = history.slice(
    0,
    Math.max(0, history.length - keepWindow),
  );
  if (toSummarize.length === 0) {
    return `Nothing to compact — all messages are within the keep-window of ${keepWindow}.`;
  }

  try {
    const prevSummary = getLatestSummary(groupFolder);
    const { text, tokenCount } = await summarize(toSummarize, client, model);
    const summaryId = insertSummary({
      groupFolder,
      sessionKey: groupFolder,
      parentSummaryId: prevSummary?.id ?? null,
      messageStartId: toSummarize[0].id,
      messageEndId: toSummarize[toSummarize.length - 1].id,
      summaryText: text,
      modelUsed: model,
      tokenCount,
    });
    deleteMessagesByIds(toSummarize.map((m) => m.id));
    logger.info(
      { groupFolder, summaryId, compacted: toSummarize.length },
      'compression-commands: /compact completed',
    );
    return (
      `Compacted ${toSummarize.length} messages into summary ${summaryId}.\n\n` +
      `Summary:\n${text}\n\n` +
      `(${keepWindow} most recent messages retained in full.)`
    );
  } catch (err) {
    logger.error({ groupFolder, err }, 'compression-commands: /compact failed');
    return `Compact failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
