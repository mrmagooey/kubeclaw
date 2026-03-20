/**
 * User Interaction Tests
 *
 * Tests the complete message flow from a user sending a message through a
 * channel, through the orchestrator's trigger detection, agent invocation,
 * and response delivery back to the channel.
 *
 * Uses a mocked agent runner to avoid needing a live Kubernetes cluster,
 * while exercising the real orchestrator logic (trigger detection, message
 * accumulation, cursor management, internal tag stripping).
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from 'vitest';
import type { ContainerOutput } from '../src/runtime/types.js';
import type { RegisteredGroup } from '../src/types.js';

// All mocks must be created with vi.hoisted() so they're available inside
// the vi.mock() factory callbacks, which are hoisted to the top of the file.
const {
  mockRunAgent,
  mockWriteTasksSnapshot,
  mockWriteGroupsSnapshot,
  mockGetACLManager,
} = vi.hoisted(() => {
  const mockRunAgent = vi.fn();
  const mockWriteTasksSnapshot = vi.fn();
  const mockWriteGroupsSnapshot = vi.fn();
  const mockGetACLManager = vi.fn().mockReturnValue({
    createJobACL: vi.fn().mockResolvedValue(undefined),
    revokeJobACL: vi.fn().mockResolvedValue(undefined),
    getJobCredentials: vi.fn().mockReturnValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return { mockRunAgent, mockWriteTasksSnapshot, mockWriteGroupsSnapshot, mockGetACLManager };
});

vi.mock('../src/runtime/index.js', () => ({
  getAgentRunner: vi.fn().mockReturnValue({
    runAgent: mockRunAgent,
    writeTasksSnapshot: mockWriteTasksSnapshot,
    writeGroupsSnapshot: mockWriteGroupsSnapshot,
    shutdown: vi.fn().mockResolvedValue(undefined),
  }),
  resetAgentRunner: vi.fn(),
  getACLManager: mockGetACLManager,
  RedisACLManager: class {},
  createAgentRunner: vi.fn(),
}));

// Mock the Redis IPC watcher (not needed for unit-style e2e tests)
vi.mock('../src/k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
}));

// Mock the Redis-based distributed job queue to avoid Redis dependency
vi.mock('../src/k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    incr: vi.fn().mockResolvedValue(1),
    decr: vi.fn().mockResolvedValue(0),
    get: vi.fn().mockResolvedValue('0'),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    zadd: vi.fn().mockResolvedValue(1),
    zrem: vi.fn().mockResolvedValue(1),
    zrange: vi.fn().mockResolvedValue([]),
    xadd: vi.fn().mockResolvedValue('stream-id'),
    eval: vi.fn().mockResolvedValue(1),
  }),
  getQueueKey: vi.fn().mockReturnValue('kubeclaw:job-queue'),
  getConcurrencyKey: vi.fn().mockReturnValue('kubeclaw:concurrency'),
  getInputStream: vi.fn((jobId: string) => `kubeclaw:input:${jobId}`),
  getJobStatusKey: vi.fn((jobId: string) => `kubeclaw:job:${jobId}:status`),
}));

// Mock the ACL manager separately
vi.mock('../src/k8s/acl-manager.js', () => ({
  getACLManager: mockGetACLManager,
  RedisACLManager: class {},
}));

// Mock sender allowlist (no restrictions in tests)
vi.mock('../src/sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn().mockReturnValue({ rules: [], logDenied: false }),
  isSenderAllowed: vi.fn().mockReturnValue(true),
  isTriggerAllowed: vi.fn().mockReturnValue(true),
  shouldDropMessage: vi.fn().mockReturnValue(false),
}));

// Mock the logger to suppress noise
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import {
  _processGroupMessages,
  _pushChannel,
  _resetState,
  _setRegisteredGroups,
} from '../src/index.js';
import {
  storeChatMetadata,
  storeMessage,
  _initTestDatabase,
} from '../src/db.js';
import {
  createMockChannel,
  getQueuedMessages,
  clearMessageQueue,
  resetMockChannel,
} from './lib/mock-channel.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const CHAT_JID = 'test-group@mock.local';
const ASSISTANT = 'Andy';

/** ISO timestamp spaced 1 second apart so DB ordering is stable */
function ts(offsetSeconds: number = 0): string {
  return new Date(1_700_000_000_000 + offsetSeconds * 1000).toISOString();
}

let msgCounter = 0;

function makeMessage(
  content: string,
  offsetSeconds: number,
  isFromMe = false,
): Parameters<typeof storeMessage>[0] {
  msgCounter++;
  return {
    id: `msg-${msgCounter}`,
    chat_jid: CHAT_JID,
    sender: isFromMe ? ASSISTANT : 'user-1',
    sender_name: isFromMe ? ASSISTANT : 'Test User',
    content,
    timestamp: ts(offsetSeconds),
    is_from_me: isFromMe,
    is_bot_message: false,
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    ...overrides,
  };
}

/** Default success agent mock: calls onOutput once then returns success */
function mockAgentSuccess(response: string, newSessionId?: string): void {
  mockRunAgent.mockImplementation(
    async (_group, _input, _onProcess, onOutput) => {
      const result: ContainerOutput = {
        status: 'success',
        result: response,
        newSessionId,
      };
      if (onOutput) await onOutput(result);
      return result;
    },
  );
}

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeEach(async () => {
  await _initTestDatabase();
  _resetState();
  msgCounter = 0;
  clearMessageQueue();

  // Register the mock channel so findChannel() can route messages to it
  const channel = createMockChannel({
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({}),
  });
  await channel.connect();
  _pushChannel(channel);

  // Create the chat metadata so DB queries work
  storeChatMetadata(CHAT_JID, ts(0), 'Test Group', 'mock', true);
});

afterEach(() => {
  resetMockChannel();
  vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('User Interaction: Trigger Detection', () => {
  it('does NOT fire agent when no trigger word present', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });
    storeMessage(makeMessage('Hello there', 1));
    storeMessage(makeMessage('How are you?', 2));

    const result = await _processGroupMessages(CHAT_JID);

    expect(result).toBe(true);
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(getQueuedMessages()).toHaveLength(0);
  });

  it('fires agent when trigger word (@Andy) is present', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });
    mockAgentSuccess('Hello back!');

    storeMessage(makeMessage(`@${ASSISTANT} help me`, 1));

    const result = await _processGroupMessages(CHAT_JID);

    expect(result).toBe(true);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('fires agent on trigger even when earlier messages have no trigger', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });
    mockAgentSuccess('Hi!');

    storeMessage(makeMessage('Some context message', 1));
    storeMessage(makeMessage('More context', 2));
    storeMessage(makeMessage(`@${ASSISTANT} now reply`, 3));

    await _processGroupMessages(CHAT_JID);

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('trigger is case-insensitive', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });
    mockAgentSuccess('Response!');

    storeMessage(makeMessage(`@${ASSISTANT.toLowerCase()} hello`, 1));

    await _processGroupMessages(CHAT_JID);

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('skips trigger check for main groups', async () => {
    _setRegisteredGroups({
      [CHAT_JID]: makeGroup({ isMain: true, requiresTrigger: false }),
    });
    mockAgentSuccess('Main group response');

    storeMessage(makeMessage('No trigger here', 1));

    await _processGroupMessages(CHAT_JID);

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('skips trigger check when requiresTrigger is explicitly false', async () => {
    _setRegisteredGroups({
      [CHAT_JID]: makeGroup({ requiresTrigger: false }),
    });
    mockAgentSuccess('Response');

    storeMessage(makeMessage('No trigger needed', 1));

    await _processGroupMessages(CHAT_JID);

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });
});

describe('User Interaction: Response Delivery', () => {
  it('delivers agent response to the channel', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });
    mockAgentSuccess('Hi, how can I help?');

    storeMessage(makeMessage(`@${ASSISTANT} hello`, 1));
    await _processGroupMessages(CHAT_JID);

    const sent = getQueuedMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(CHAT_JID);
    expect(sent[0].content).toBe('Hi, how can I help?');
  });

  it('strips <internal> reasoning blocks before sending to channel', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });
    mockAgentSuccess(
      '<internal>My internal reasoning here</internal>The actual answer to your question.',
    );

    storeMessage(makeMessage(`@${ASSISTANT} explain`, 1));
    await _processGroupMessages(CHAT_JID);

    const sent = getQueuedMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe('The actual answer to your question.');
    expect(sent[0].content).not.toContain('<internal>');
    expect(sent[0].content).not.toContain('My internal reasoning here');
  });

  it('does not send anything when response is only internal blocks', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });
    mockAgentSuccess('<internal>Only reasoning, no output</internal>');

    storeMessage(makeMessage(`@${ASSISTANT} think`, 1));
    await _processGroupMessages(CHAT_JID);

    expect(getQueuedMessages()).toHaveLength(0);
  });

  it('sends multiple streaming outputs when agent calls onOutput several times', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });

    mockRunAgent.mockImplementation(async (_g, _i, _op, onOutput) => {
      if (onOutput) {
        await onOutput({ status: 'success', result: 'First part.', newSessionId: undefined });
        await onOutput({ status: 'success', result: 'Second part.', newSessionId: undefined });
      }
      return { status: 'success', result: 'Second part.', newSessionId: undefined };
    });

    storeMessage(makeMessage(`@${ASSISTANT} stream`, 1));
    await _processGroupMessages(CHAT_JID);

    const sent = getQueuedMessages();
    expect(sent).toHaveLength(2);
    expect(sent[0].content).toBe('First part.');
    expect(sent[1].content).toBe('Second part.');
  });
});

describe('User Interaction: Message Accumulation', () => {
  it('includes all messages since last agent run in the prompt', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });

    let capturedPrompt = '';
    mockRunAgent.mockImplementation(async (_group, input, _op, onOutput) => {
      capturedPrompt = input.prompt;
      const result: ContainerOutput = { status: 'success', result: 'OK', newSessionId: undefined };
      if (onOutput) await onOutput(result);
      return result;
    });

    storeMessage(makeMessage('Background context', 1));
    storeMessage(makeMessage('More context', 2));
    storeMessage(makeMessage(`@${ASSISTANT} now respond`, 3));

    await _processGroupMessages(CHAT_JID);

    // All 3 messages should be in the prompt
    expect(capturedPrompt).toContain('Background context');
    expect(capturedPrompt).toContain('More context');
    expect(capturedPrompt).toContain(`@${ASSISTANT} now respond`);
  });

  it('sends chatJid and groupFolder to the agent', async () => {
    const group = makeGroup({ folder: 'my-special-group' });
    _setRegisteredGroups({ [CHAT_JID]: group });

    let capturedInput: Parameters<typeof mockRunAgent>[1] | null = null;
    mockRunAgent.mockImplementation(async (_group, input, _op, onOutput) => {
      capturedInput = input;
      const result: ContainerOutput = { status: 'success', result: 'hi', newSessionId: undefined };
      if (onOutput) await onOutput(result);
      return result;
    });

    storeMessage(makeMessage(`@${ASSISTANT} go`, 1));
    await _processGroupMessages(CHAT_JID);

    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.chatJid).toBe(CHAT_JID);
    expect(capturedInput!.groupFolder).toBe('my-special-group');
    expect(capturedInput!.assistantName).toBe(ASSISTANT);
  });

  it('skips unregistered groups', async () => {
    // No groups registered — processGroupMessages should return true early
    _setRegisteredGroups({});

    const result = await _processGroupMessages(CHAT_JID);

    expect(result).toBe(true);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});

describe('User Interaction: Multi-turn Conversation', () => {
  it('does not re-process messages from a previous turn', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });
    mockAgentSuccess('First response');

    // First turn
    storeMessage(makeMessage(`@${ASSISTANT} first question`, 1));
    await _processGroupMessages(CHAT_JID);

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    clearMessageQueue();
    mockRunAgent.mockClear();

    // Second turn — new trigger, but no new messages after the cursor
    // (in a real scenario the user would send more; here we just verify
    //  the first turn messages are not re-sent when there's nothing new)
    const result = await _processGroupMessages(CHAT_JID);

    expect(result).toBe(true);
    expect(mockRunAgent).not.toHaveBeenCalled(); // nothing new since cursor advanced
  });

  it('processes new messages in second turn with context cursor', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });

    const prompts: string[] = [];
    mockRunAgent.mockImplementation(async (_g, input, _op, onOutput) => {
      prompts.push(input.prompt);
      const result: ContainerOutput = { status: 'success', result: 'OK', newSessionId: undefined };
      if (onOutput) await onOutput(result);
      return result;
    });

    // First turn
    storeMessage(makeMessage(`@${ASSISTANT} turn one`, 1));
    await _processGroupMessages(CHAT_JID);

    clearMessageQueue();

    // Second turn — new message after cursor
    storeMessage(makeMessage(`@${ASSISTANT} turn two`, 10));
    await _processGroupMessages(CHAT_JID);

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toContain('turn one');
    expect(prompts[0]).not.toContain('turn two');
    expect(prompts[1]).toContain('turn two');
    expect(prompts[1]).not.toContain('turn one'); // first message is before cursor
  });

  it('preserves session ID across turns', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });

    const sessionIds: (string | undefined)[] = [];
    mockRunAgent.mockImplementation(async (_g, input, _op, onOutput) => {
      sessionIds.push(input.sessionId);
      const result: ContainerOutput = {
        status: 'success',
        result: 'Hi',
        newSessionId: 'session-abc-123',
      };
      if (onOutput) await onOutput(result);
      return result;
    });

    storeMessage(makeMessage(`@${ASSISTANT} first`, 1));
    await _processGroupMessages(CHAT_JID);

    clearMessageQueue();

    storeMessage(makeMessage(`@${ASSISTANT} second`, 10));
    await _processGroupMessages(CHAT_JID);

    // First call has no session; second call uses the session from first response
    expect(sessionIds[0]).toBeUndefined();
    expect(sessionIds[1]).toBe('session-abc-123');
  });
});

describe('User Interaction: Error Handling', () => {
  it('returns false and rolls back cursor on agent error', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });

    mockRunAgent.mockImplementation(async (_g, _i, _op, onOutput) => {
      // Error with no output sent to user — cursor should be rolled back
      return { status: 'error', result: null, error: 'K8s job failed' };
    });

    storeMessage(makeMessage(`@${ASSISTANT} do something`, 1));
    const result = await _processGroupMessages(CHAT_JID);

    expect(result).toBe(false);
    expect(getQueuedMessages()).toHaveLength(0);

    // After rollback, calling again should re-process the same message
    mockAgentSuccess('Retry succeeded');
    const retryResult = await _processGroupMessages(CHAT_JID);
    expect(retryResult).toBe(true);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('does not roll back cursor when error occurs after output was already sent', async () => {
    _setRegisteredGroups({ [CHAT_JID]: makeGroup() });

    mockRunAgent.mockImplementation(async (_g, _i, _op, onOutput) => {
      // Send output first, then report error (partial response scenario)
      if (onOutput) {
        await onOutput({ status: 'success', result: 'Partial answer', newSessionId: undefined });
      }
      return { status: 'error', result: null, error: 'Crashed after output' };
    });

    storeMessage(makeMessage(`@${ASSISTANT} question`, 1));
    const result = await _processGroupMessages(CHAT_JID);

    // Returns true (no rollback) to prevent duplicate sends on retry
    expect(result).toBe(true);
    // The partial output was still sent
    expect(getQueuedMessages()).toHaveLength(1);
    expect(getQueuedMessages()[0].content).toBe('Partial answer');

    // Verify cursor was NOT rolled back: next call finds no new messages
    mockRunAgent.mockClear();
    clearMessageQueue();
    await _processGroupMessages(CHAT_JID);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('skips when no channel owns the JID', async () => {
    // Register group but use a JID that the mock channel does NOT own
    const unknownJid = 'unknown@whatsapp.net';
    storeChatMetadata(unknownJid, ts(0), 'Unknown Group', 'whatsapp', true);
    _setRegisteredGroups({
      [unknownJid]: makeGroup(),
    });
    storeMessage({
      ...makeMessage(`@${ASSISTANT} hello`, 1),
      chat_jid: unknownJid,
    });

    const result = await _processGroupMessages(unknownJid);

    expect(result).toBe(true); // not an error — just skipped
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});
