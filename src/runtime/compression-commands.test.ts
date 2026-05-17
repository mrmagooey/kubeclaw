import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isCompactCommand, parseCompactArgs, handleCompactCommand } from './compression-commands.js';
import { _initTestDatabase, insertSummary, appendConversationMessage, getConversationHistory, db } from '../db.js';

describe('isCompactCommand', () => {
  it('matches /compact', () => expect(isCompactCommand('/compact')).toBe(true));
  it('matches /summary', () => expect(isCompactCommand('/summary')).toBe(true));
  it('matches /clear', () => expect(isCompactCommand('/clear')).toBe(true));
  it('does not match /skills', () => expect(isCompactCommand('/skills list')).toBe(false));
  it('does not match plain text', () => expect(isCompactCommand('hello')).toBe(false));
  it('matches /compact with flags', () =>
    expect(isCompactCommand('/compact --keep 5')).toBe(true));
});

describe('parseCompactArgs', () => {
  it('returns default keep when no flag provided', () => {
    const { keep } = parseCompactArgs('/compact');
    expect(keep).toBeNull();
  });

  it('parses --keep N correctly', () => {
    const { keep } = parseCompactArgs('/compact --keep 10');
    expect(keep).toBe(10);
  });

  it('returns null for non-numeric --keep value', () => {
    const { keep } = parseCompactArgs('/compact --keep abc');
    expect(keep).toBeNull();
  });

  it('returns null for negative --keep value', () => {
    const { keep } = parseCompactArgs('/compact --keep -5');
    expect(keep).toBeNull();
  });
});

// Stub OpenAI client — /summary never calls it
const stubClient = {} as unknown as import('openai').default;
const stubModel = 'gpt-4o';

describe('/summary chain walk', () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  it('returns a message when no summary exists', async () => {
    const result = await handleCompactCommand('testgroup', '/summary', stubClient, stubModel);
    expect(result).toBe('No summary exists for this group yet.');
  });

  it('single-summary case: chain has 1 entry', async () => {
    insertSummary({
      groupFolder: 'testgroup',
      sessionKey: 'testgroup',
      parentSummaryId: null,
      messageStartId: 'start-1',
      messageEndId: 'end-1',
      summaryText: 'First summary text',
      modelUsed: stubModel,
      tokenCount: 10,
    });

    const result = await handleCompactCommand('testgroup', '/summary', stubClient, stubModel);
    expect(result).toContain('Summary chain (1 entry/entries)');
    expect(result).toContain('First summary text');
  });

  it('two-generation case: output contains both summaries', async () => {
    const idA = insertSummary({
      groupFolder: 'testgroup',
      sessionKey: 'testgroup',
      parentSummaryId: null,
      messageStartId: 'start-a',
      messageEndId: 'end-a',
      summaryText: 'Oldest summary A',
      modelUsed: stubModel,
      tokenCount: 5,
    });

    insertSummary({
      groupFolder: 'testgroup',
      sessionKey: 'testgroup',
      parentSummaryId: idA,
      messageStartId: 'start-b',
      messageEndId: 'end-b',
      summaryText: 'Newer summary B',
      modelUsed: stubModel,
      tokenCount: 8,
    });

    const result = await handleCompactCommand('testgroup', '/summary', stubClient, stubModel);
    expect(result).toContain('Summary chain (2 entry/entries)');
    expect(result).toContain('Oldest summary A');
    expect(result).toContain('Newer summary B');
    // Newest-first: B appears before A in the output
    expect(result.indexOf('Newer summary B')).toBeLessThan(result.indexOf('Oldest summary A'));
  });

  it('three-generation case: output contains all three in newest-first order', async () => {
    const idA = insertSummary({
      groupFolder: 'testgroup',
      sessionKey: 'testgroup',
      parentSummaryId: null,
      messageStartId: 'start-a',
      messageEndId: 'end-a',
      summaryText: 'Generation 1 (oldest)',
      modelUsed: stubModel,
      tokenCount: 5,
    });

    const idB = insertSummary({
      groupFolder: 'testgroup',
      sessionKey: 'testgroup',
      parentSummaryId: idA,
      messageStartId: 'start-b',
      messageEndId: 'end-b',
      summaryText: 'Generation 2 (middle)',
      modelUsed: stubModel,
      tokenCount: 6,
    });

    insertSummary({
      groupFolder: 'testgroup',
      sessionKey: 'testgroup',
      parentSummaryId: idB,
      messageStartId: 'start-c',
      messageEndId: 'end-c',
      summaryText: 'Generation 3 (newest)',
      modelUsed: stubModel,
      tokenCount: 7,
    });

    const result = await handleCompactCommand('testgroup', '/summary', stubClient, stubModel);
    expect(result).toContain('Summary chain (3 entry/entries)');
    expect(result).toContain('Generation 1 (oldest)');
    expect(result).toContain('Generation 2 (middle)');
    expect(result).toContain('Generation 3 (newest)');
    // Newest-first order: [3] appears before [2] appears before [1]
    const pos3 = result.indexOf('Generation 3 (newest)');
    const pos2 = result.indexOf('Generation 2 (middle)');
    const pos1 = result.indexOf('Generation 1 (oldest)');
    expect(pos3).toBeLessThan(pos2);
    expect(pos2).toBeLessThan(pos1);
  });

  it('cycle defense: terminates within cap (does not hang)', async () => {
    // Insert two summaries with a self-referential parent_summary_id to simulate a cycle.
    // We bypass insertSummary (which generates IDs) and insert directly so we can
    // craft a specific ID that another row can reference before it exists.
    const idX = 'testgroup-summary-cycle-x';
    const idY = 'testgroup-summary-cycle-y';
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO conversation_summaries
        (id, group_folder, session_key, parent_summary_id,
         message_start_id, message_end_id, summary_text,
         model_used, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [idX, 'testgroup', 'testgroup', idY, 'sx', 'ex', 'Cycle X', stubModel, 1, now],
    );
    // Insert Y referencing X (creates a mutual cycle: X→Y→X→…)
    const laterNow = new Date(Date.now() + 1).toISOString();
    db.run(
      `INSERT INTO conversation_summaries
        (id, group_folder, session_key, parent_summary_id,
         message_start_id, message_end_id, summary_text,
         model_used, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [idY, 'testgroup', 'testgroup', idX, 'sy', 'ey', 'Cycle Y', stubModel, 1, laterNow],
    );

    // Should return without hanging and cap at ≤50 entries
    const result = await handleCompactCommand('testgroup', '/summary', stubClient, stubModel);
    // The chain must have been capped (not infinite), so we get a bounded result
    const match = result.match(/Summary chain \((\d+) entry\/entries\)/);
    expect(match).not.toBeNull();
    const chainLength = parseInt(match![1], 10);
    expect(chainLength).toBeLessThanOrEqual(50);
    expect(chainLength).toBeGreaterThanOrEqual(1);
  });
});

describe('parseCompactArgs: negative --keep', () => {
  it('/compact --keep -5 yields keep=null (falls back to default)', () => {
    const { keep } = parseCompactArgs('/compact --keep -5');
    expect(keep).toBeNull();
  });
});

describe('/compact deletes compressed messages', () => {
  const groupFolder = 'compact-delete-test';

  beforeEach(async () => {
    await _initTestDatabase();
  });

  it('removes compacted rows from conversation_history', async () => {
    process.env.MAX_CONVERSATION_HISTORY = '2';

    // Insert 5 messages
    for (let i = 0; i < 5; i++) {
      appendConversationMessage(groupFolder, i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`);
    }
    expect(getConversationHistory(groupFolder, 0).length).toBe(5);

    // Stub summarizer — we spy on the client that handleCompactCommand receives
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'Summary text', tool_calls: [] } }],
            usage: { total_tokens: 10 },
          }),
        },
      },
    } as any;

    await handleCompactCommand(groupFolder, '/compact --keep 2', mockClient, stubModel);

    // Only the 2 keep-window messages should remain
    const remaining = getConversationHistory(groupFolder, 0);
    expect(remaining.length).toBe(2);

    delete process.env.MAX_CONVERSATION_HISTORY;
  });
});
