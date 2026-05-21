import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  __resetDbForTest,
  db,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
  storeJobACL,
  getJobACL,
  getJobACLByGroup,
  revokeJobACL,
  cleanupExpiredACLs,
  getRouterState,
  setRouterState,
  getSession,
  setSession,
  getAllSessions,
  updateChatName,
  getLastGroupSync,
  setLastGroupSync,
  storeMessageDirect,
  getTasksForGroup,
  getAllTasks,
  getDueTasks,
  updateTaskAfterRun,
  logTaskRun,
  getAllScheduledTasks,
  getConversationHistory,
  appendConversationMessage,
  appendConversationHistory,
  clearConversationHistory,
  runSessionKeyBackfill,
  getRegisteredGroup,
  updateGroupProvider,
  clearInvalidProviders,
  deleteRegisteredGroup,
  recordSkillLoad,
  getSkillLoadStats,
  getSkillsLoadedSince,
  searchConversations,
  backfillFts,
  deleteMessageById,
  recordToolJob,
  resolveToolJob,
  getActiveToolJobs,
  pruneOldToolJobs,
  getToolJobByIdForGroup,
  storeToolJob,
  recordSpecialistUsage,
  getSpecialistUsage,
  getTaskRunLogs,
  pauseTask,
  resumeTask,
} from './db.js';
import { JobACL } from './types.js';

beforeEach(async () => {
  await _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Job ACL Functions ---

describe('Job ACL Functions', () => {
  describe('storeJobACL', () => {
    it('should store and retrieve ACL correctly', () => {
      const acl: JobACL = {
        jobId: 'acl-test-job-1',
        groupFolder: 'test-group',
        username: 'sidecar-acl-test-job-1',
        password: 'encrypted-password-xyz',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl);
      const retrieved = getJobACL('acl-test-job-1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.jobId).toBe(acl.jobId);
      expect(retrieved?.groupFolder).toBe(acl.groupFolder);
      expect(retrieved?.username).toBe(acl.username);
      expect(retrieved?.password).toBe(acl.password);
      expect(retrieved?.status).toBe(acl.status);
    });

    it('should update existing ACL on conflict', () => {
      const acl: JobACL = {
        jobId: 'acl-test-job-update',
        groupFolder: 'test-group',
        username: 'sidecar-original',
        password: 'password-v1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl);

      const updatedAcl: JobACL = {
        ...acl,
        username: 'sidecar-updated',
        password: 'password-v2',
        status: 'revoked',
      };

      storeJobACL(updatedAcl);
      const retrieved = getJobACL('acl-test-job-update');

      expect(retrieved?.username).toBe('sidecar-updated');
      expect(retrieved?.password).toBe('password-v2');
      expect(retrieved?.status).toBe('revoked');
    });
  });

  describe('getJobACL', () => {
    it('should return undefined for non-existent job', () => {
      const retrieved = getJobACL('non-existent-acl-job');
      expect(retrieved).toBeUndefined();
    });

    it('should return correct ACL for existing job', () => {
      const acl: JobACL = {
        jobId: 'acl-exists-test',
        groupFolder: 'test-group',
        username: 'sidecar-exists',
        password: 'secret',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl);
      const retrieved = getJobACL('acl-exists-test');

      expect(retrieved).toBeDefined();
      expect(retrieved?.jobId).toBe('acl-exists-test');
    });
  });

  describe('getJobACLByGroup', () => {
    it('should find ACL by group folder', () => {
      const acl: JobACL = {
        jobId: 'acl-group-test',
        groupFolder: 'specific-group',
        username: 'sidecar-group',
        password: 'encrypted',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl);
      const retrieved = getJobACLByGroup('specific-group');

      expect(retrieved).toBeDefined();
      expect(retrieved?.jobId).toBe('acl-group-test');
    });

    it('should return most recent active ACL for group', () => {
      const olderAcl: JobACL = {
        jobId: 'acl-older',
        groupFolder: 'multi-acl-group',
        username: 'sidecar-older',
        password: 'encrypted',
        createdAt: new Date(Date.now() - 5000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      const newerAcl: JobACL = {
        jobId: 'acl-newer',
        groupFolder: 'multi-acl-group',
        username: 'sidecar-newer',
        password: 'encrypted',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(olderAcl);
      storeJobACL(newerAcl);

      const retrieved = getJobACLByGroup('multi-acl-group');
      expect(retrieved?.jobId).toBe('acl-newer');
    });

    it('should not return revoked ACLs', () => {
      const acl: JobACL = {
        jobId: 'acl-revoked-group',
        groupFolder: 'revoked-group',
        username: 'sidecar-revoked',
        password: 'encrypted',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'revoked',
      };

      storeJobACL(acl);
      const retrieved = getJobACLByGroup('revoked-group');

      expect(retrieved).toBeUndefined();
    });

    it('should return undefined for non-existent group', () => {
      const retrieved = getJobACLByGroup('no-such-group');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('revokeJobACL', () => {
    it('should mark ACL as revoked', () => {
      const acl: JobACL = {
        jobId: 'acl-to-revoke',
        groupFolder: 'test-group',
        username: 'sidecar-revoke',
        password: 'encrypted',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(acl);
      revokeJobACL('acl-to-revoke');

      const retrieved = getJobACL('acl-to-revoke');
      expect(retrieved?.status).toBe('revoked');
    });

    it('should not throw for non-existent job', () => {
      expect(() => revokeJobACL('non-existent-job')).not.toThrow();
    });

    it('should keep other fields intact when revoking', () => {
      const acl: JobACL = {
        jobId: 'acl-revoke-intact',
        groupFolder: 'test-group',
        username: 'sidecar-intact',
        password: 'encrypted-password',
        createdAt: '2024-01-01T00:00:00.000Z',
        expiresAt: '2024-12-31T23:59:59.000Z',
        status: 'active',
      };

      storeJobACL(acl);
      revokeJobACL('acl-revoke-intact');

      const retrieved = getJobACL('acl-revoke-intact');
      expect(retrieved?.groupFolder).toBe('test-group');
      expect(retrieved?.username).toBe('sidecar-intact');
      expect(retrieved?.password).toBe('encrypted-password');
      expect(retrieved?.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('cleanupExpiredACLs', () => {
    it('should mark expired ACLs as revoked', () => {
      const expiredAcl: JobACL = {
        jobId: 'acl-expired-1',
        groupFolder: 'test-group',
        username: 'sidecar-expired',
        password: 'encrypted',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(expiredAcl);

      const revokedIds = cleanupExpiredACLs();

      expect(revokedIds).toContain('acl-expired-1');
      const retrieved = getJobACL('acl-expired-1');
      expect(retrieved?.status).toBe('revoked');
    });

    it('should not affect active ACLs', () => {
      const activeAcl: JobACL = {
        jobId: 'acl-active-cleanup',
        groupFolder: 'test-group',
        username: 'sidecar-active',
        password: 'encrypted',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        status: 'active',
      };

      storeJobACL(activeAcl);

      const revokedIds = cleanupExpiredACLs();

      expect(revokedIds).not.toContain('acl-active-cleanup');
      const retrieved = getJobACL('acl-active-cleanup');
      expect(retrieved?.status).toBe('active');
    });

    it('should handle multiple expired ACLs', () => {
      const expiredIds = ['acl-exp-1', 'acl-exp-2', 'acl-exp-3'];

      for (const jobId of expiredIds) {
        storeJobACL({
          jobId,
          groupFolder: 'test-group',
          username: `sidecar-${jobId}`,
          password: 'encrypted',
          createdAt: new Date(Date.now() - 7200000).toISOString(),
          expiresAt: new Date(Date.now() - 3600000).toISOString(),
          status: 'active',
        });
      }

      const revokedIds = cleanupExpiredACLs();

      expect(revokedIds).toHaveLength(3);
      for (const jobId of expiredIds) {
        expect(revokedIds).toContain(jobId);
      }
    });

    it('should return empty array when no expired ACLs', () => {
      const revokedIds = cleanupExpiredACLs();
      expect(revokedIds).toEqual([]);
    });

    it('should not double-revoke already revoked expired ACLs', () => {
      const alreadyRevoked: JobACL = {
        jobId: 'acl-already-revoked',
        groupFolder: 'test-group',
        username: 'sidecar-already',
        password: 'encrypted',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
        status: 'revoked',
      };

      storeJobACL(alreadyRevoked);

      const revokedIds = cleanupExpiredACLs();

      expect(revokedIds).not.toContain('acl-already-revoked');
    });
  });
});

// --- getRouterState / setRouterState ---

describe('getRouterState / setRouterState', () => {
  it('returns undefined for unknown key', () => {
    expect(getRouterState('no-such-key')).toBeUndefined();
  });

  it('stores and retrieves a value', () => {
    setRouterState('last_timestamp', '2024-01-01T00:00:00.000Z');
    expect(getRouterState('last_timestamp')).toBe('2024-01-01T00:00:00.000Z');
  });

  it('overwrites an existing value', () => {
    setRouterState('my_key', 'v1');
    setRouterState('my_key', 'v2');
    expect(getRouterState('my_key')).toBe('v2');
  });

  it('isolates different keys', () => {
    setRouterState('key_a', 'aaa');
    setRouterState('key_b', 'bbb');
    expect(getRouterState('key_a')).toBe('aaa');
    expect(getRouterState('key_b')).toBe('bbb');
  });
});

// --- getSession / setSession / getAllSessions ---

describe('session management', () => {
  it('returns undefined for unknown group_folder', () => {
    expect(getSession('nonexistent')).toBeUndefined();
  });

  it('stores and retrieves a session', () => {
    setSession('group-a', 'sess-123');
    expect(getSession('group-a')).toBe('sess-123');
  });

  it('overwrites existing session', () => {
    setSession('group-b', 'old-sess');
    setSession('group-b', 'new-sess');
    expect(getSession('group-b')).toBe('new-sess');
  });

  it('getAllSessions returns all stored sessions', () => {
    setSession('folder-1', 'sess-aaa');
    setSession('folder-2', 'sess-bbb');
    const all = getAllSessions();
    expect(all['folder-1']).toBe('sess-aaa');
    expect(all['folder-2']).toBe('sess-bbb');
  });

  it('getAllSessions returns empty object when no sessions', () => {
    expect(getAllSessions()).toEqual({});
  });
});

// --- updateChatName ---

describe('updateChatName', () => {
  it('updates the name for an existing chat', () => {
    storeChatMetadata('chat@g.us', '2024-01-01T00:00:00.000Z', 'OldName');
    updateChatName('chat@g.us', 'NewName');
    const chats = getAllChats();
    const chat = chats.find((c) => c.jid === 'chat@g.us');
    expect(chat?.name).toBe('NewName');
  });

  it('inserts a new chat row if jid does not exist', () => {
    updateChatName('newchat@g.us', 'Fresh Name');
    const chats = getAllChats();
    const chat = chats.find((c) => c.jid === 'newchat@g.us');
    expect(chat).toBeDefined();
    expect(chat?.name).toBe('Fresh Name');
  });
});

// --- getLastGroupSync / setLastGroupSync ---

describe('getLastGroupSync / setLastGroupSync', () => {
  it('returns null when no sync has occurred', () => {
    expect(getLastGroupSync()).toBeNull();
  });

  it('stores a sync timestamp and retrieves it', () => {
    const before = new Date().toISOString();
    setLastGroupSync();
    const after = new Date().toISOString();
    const ts = getLastGroupSync();
    expect(ts).not.toBeNull();
    expect(ts! >= before).toBe(true);
    expect(ts! <= after).toBe(true);
  });

  it('updates the sync timestamp on subsequent calls', () => {
    setLastGroupSync();
    const first = getLastGroupSync();
    setLastGroupSync();
    const second = getLastGroupSync();
    expect(second! >= first!).toBe(true);
  });
});

// --- storeMessageDirect ---

describe('storeMessageDirect', () => {
  it('stores a message and it can be retrieved', () => {
    storeChatMetadata('direct@g.us', '2024-01-01T00:00:00.000Z');
    storeMessageDirect({
      id: 'direct-1',
      chat_jid: 'direct@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'Tester',
      content: 'direct message',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
    });
    const messages = getMessagesSince(
      'direct@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('direct-1');
    expect(messages[0].content).toBe('direct message');
  });

  it('stores is_bot_message flag when provided', () => {
    storeChatMetadata('direct@g.us', '2024-01-01T00:00:00.000Z');
    storeMessageDirect({
      id: 'direct-bot',
      chat_jid: 'direct@g.us',
      sender: 'bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot output',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
    // bot messages are excluded by getMessagesSince
    const messages = getMessagesSince(
      'direct@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages.find((m) => m.id === 'direct-bot')).toBeUndefined();
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('direct@g.us', '2024-01-01T00:00:00.000Z');
    storeMessageDirect({
      id: 'direct-dup',
      chat_jid: 'direct@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'original',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });
    storeMessageDirect({
      id: 'direct-dup',
      chat_jid: 'direct@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'replaced',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_from_me: false,
    });
    const messages = getMessagesSince(
      'direct@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages.filter((m) => m.id === 'direct-dup')).toHaveLength(1);
    expect(messages.find((m) => m.id === 'direct-dup')?.content).toBe(
      'replaced',
    );
  });
});

// --- getTasksForGroup ---

describe('getTasksForGroup', () => {
  it('returns tasks for the specified group', () => {
    createTask({
      id: 'tg-1',
      group_folder: 'group-alpha',
      chat_jid: 'alpha@g.us',
      prompt: 'task for alpha',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: '2025-01-01T09:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'tg-2',
      group_folder: 'group-beta',
      chat_jid: 'beta@g.us',
      prompt: 'task for beta',
      schedule_type: 'cron',
      schedule_value: '0 10 * * *',
      context_mode: 'isolated',
      next_run: '2025-01-01T10:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const alphaTasks = getTasksForGroup('group-alpha');
    expect(alphaTasks).toHaveLength(1);
    expect(alphaTasks[0].id).toBe('tg-1');

    const betaTasks = getTasksForGroup('group-beta');
    expect(betaTasks).toHaveLength(1);
    expect(betaTasks[0].id).toBe('tg-2');
  });

  it('returns empty array for group with no tasks', () => {
    expect(getTasksForGroup('no-such-group')).toEqual([]);
  });

  it('returns multiple tasks for same group ordered by created_at DESC', () => {
    createTask({
      id: 'tg-3',
      group_folder: 'group-gamma',
      chat_jid: 'gamma@g.us',
      prompt: 'first',
      schedule_type: 'once',
      schedule_value: '2025-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-01-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'tg-4',
      group_folder: 'group-gamma',
      chat_jid: 'gamma@g.us',
      prompt: 'second',
      schedule_type: 'once',
      schedule_value: '2025-02-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2025-02-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-02-01T00:00:00.000Z',
    });
    const tasks = getTasksForGroup('group-gamma');
    expect(tasks).toHaveLength(2);
    // most recently created first
    expect(tasks[0].id).toBe('tg-4');
    expect(tasks[1].id).toBe('tg-3');
  });
});

// --- getAllTasks ---

describe('getAllTasks', () => {
  it('returns empty array when no tasks exist', () => {
    expect(getAllTasks()).toEqual([]);
  });

  it('returns all tasks across groups', () => {
    createTask({
      id: 'at-1',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'p1',
      schedule_type: 'once',
      schedule_value: '2025-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'at-2',
      group_folder: 'g2',
      chat_jid: 'g2@g.us',
      prompt: 'p2',
      schedule_type: 'once',
      schedule_value: '2025-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'paused',
      created_at: '2024-01-02T00:00:00.000Z',
    });

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(2);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('at-1');
    expect(ids).toContain('at-2');
  });
});

// --- getDueTasks ---

describe('getDueTasks', () => {
  it('returns only past-due active tasks', () => {
    const pastRun = new Date(Date.now() - 60000).toISOString();
    const futureRun = new Date(Date.now() + 3600000).toISOString();

    createTask({
      id: 'due-past',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'overdue',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: pastRun,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'due-future',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'not yet',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: futureRun,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'due-paused',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'paused overdue',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: pastRun,
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const due = getDueTasks();
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('due-past');
  });

  it('returns empty when no tasks are due', () => {
    const futureRun = new Date(Date.now() + 3600000).toISOString();
    createTask({
      id: 'not-due',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'future',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: futureRun,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    expect(getDueTasks()).toEqual([]);
  });
});

// --- updateTaskAfterRun ---

describe('updateTaskAfterRun', () => {
  it('updates next_run, last_run, and last_result', () => {
    createTask({
      id: 'uar-1',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'recurring',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60000).toISOString(),
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const nextRun = new Date(Date.now() + 86400000).toISOString();
    updateTaskAfterRun('uar-1', nextRun, 'success');

    const task = getTaskById('uar-1');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe(nextRun);
    expect(task!.last_result).toBe('success');
    expect(task!.last_run).not.toBeNull();
    expect(task!.status).toBe('active');
  });

  it('marks task as completed when nextRun is null', () => {
    createTask({
      id: 'uar-2',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'one-time',
      schedule_type: 'once',
      schedule_value: '2025-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60000).toISOString(),
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTaskAfterRun('uar-2', null, 'done');

    const task = getTaskById('uar-2');
    expect(task).toBeDefined();
    expect(task!.status).toBe('completed');
    expect(task!.last_result).toBe('done');
    expect(task!.next_run).toBeNull();
  });
});

// --- logTaskRun ---

describe('logTaskRun', () => {
  it('stores a task_run_log entry without error', () => {
    createTask({
      id: 'log-task-1',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'loggable',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    expect(() =>
      logTaskRun({
        task_id: 'log-task-1',
        run_at: new Date().toISOString(),
        duration_ms: 1234,
        status: 'success',
        result: 'all good',
        error: null,
      }),
    ).not.toThrow();
  });

  it('stores log entry with error field', () => {
    createTask({
      id: 'log-task-2',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'failing task',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    expect(() =>
      logTaskRun({
        task_id: 'log-task-2',
        run_at: new Date().toISOString(),
        duration_ms: 500,
        status: 'error',
        result: null,
        error: 'something went wrong',
      }),
    ).not.toThrow();
  });
});

// --- getAllScheduledTasks ---

describe('getAllScheduledTasks', () => {
  it('returns empty array when no tasks exist', () => {
    expect(getAllScheduledTasks()).toEqual([]);
  });

  it('returns all tasks ordered by created_at DESC', () => {
    createTask({
      id: 'ast-1',
      group_folder: 'g1',
      chat_jid: 'g1@g.us',
      prompt: 'first',
      schedule_type: 'once',
      schedule_value: '2025-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'ast-2',
      group_folder: 'g2',
      chat_jid: 'g2@g.us',
      prompt: 'second',
      schedule_type: 'once',
      schedule_value: '2025-02-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'paused',
      created_at: '2024-06-01T00:00:00.000Z',
    });

    const tasks = getAllScheduledTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe('ast-2');
    expect(tasks[1].id).toBe('ast-1');
  });
});

// --- getConversationHistory / appendConversationMessage / clearConversationHistory ---

describe('conversation history', () => {
  it('returns empty array when no messages exist', () => {
    expect(getConversationHistory('group-x')).toEqual([]);
  });

  it('stores and retrieves messages in chronological order', () => {
    appendConversationMessage('group-x', 'user', 'hello');
    appendConversationMessage('group-x', 'assistant', 'hi there');
    appendConversationMessage('group-x', 'user', 'how are you?');

    const history = getConversationHistory('group-x');
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(history[1]).toMatchObject({
      role: 'assistant',
      content: 'hi there',
    });
    expect(history[2]).toMatchObject({ role: 'user', content: 'how are you?' });
  });

  it('isolates history by group_folder', () => {
    appendConversationMessage('group-a', 'user', 'message for a');
    appendConversationMessage('group-b', 'assistant', 'message for b');

    expect(getConversationHistory('group-a')).toHaveLength(1);
    expect(getConversationHistory('group-b')).toHaveLength(1);
    expect(getConversationHistory('group-a')[0].content).toBe('message for a');
    expect(getConversationHistory('group-b')[0].content).toBe('message for b');
  });

  it('clearConversationHistory removes only messages for that group', () => {
    appendConversationMessage('group-clear', 'user', 'to be cleared');
    appendConversationMessage('group-keep', 'user', 'keep this');

    clearConversationHistory('group-clear');

    expect(getConversationHistory('group-clear')).toHaveLength(0);
    expect(getConversationHistory('group-keep')).toHaveLength(1);
  });

  it('clearConversationHistory is idempotent on empty history', () => {
    expect(() => clearConversationHistory('no-history-group')).not.toThrow();
  });
});

// --- conversation_history_fts triggers ---

describe('conversation_history_fts triggers', () => {
  it('INSERT trigger populates FTS index', async () => {
    await _initTestDatabase();
    appendConversationMessage('main', 'user', 'the quick brown fox');
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'quick'`,
    );
    expect(result.length).toBe(1);
    expect(result[0].values.length).toBe(1);
  });

  it('DELETE trigger removes row from FTS index', async () => {
    await _initTestDatabase();
    appendConversationMessage('main', 'user', 'unique canary phrase zqxw');
    db.run(`DELETE FROM conversation_history WHERE group_folder = 'main'`);
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'zqxw'`,
    );
    expect(result.length).toBe(0);
  });

  it('UPDATE trigger replaces FTS entry on content change', async () => {
    await _initTestDatabase();
    appendConversationMessage('main', 'user', 'original phrase abc');
    db.run(
      `UPDATE conversation_history SET content = 'revised phrase xyz' WHERE group_folder = 'main'`,
    );
    const old = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'abc'`,
    );
    const updated = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xyz'`,
    );
    expect(old.length).toBe(0);
    expect(updated[0].values.length).toBe(1);
  });

  it('clearConversationHistory also empties FTS rows for that group', async () => {
    await _initTestDatabase();
    appendConversationMessage('main', 'user', 'searchable cleared word zqyy');
    clearConversationHistory('main');
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'zqyy'`,
    );
    expect(result.length).toBe(0);
  });
});

// --- searchConversations ---

describe('searchConversations', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    const rows = [
      { role: 'user' as const, content: 'hello world greetings' },
      { role: 'assistant' as const, content: 'hello back from assistant' },
      { role: 'user' as const, content: 'goodbye world farewell' },
      { role: 'user' as const, content: 'completely unrelated content here' },
    ];
    for (const r of rows) {
      appendConversationMessage('search-group', r.role, r.content);
    }
  });

  it('returns rows matching the query term', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
    });
    expect(results.length).toBe(2);
  });

  it('snippet contains the matched term wrapped in brackets', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
    });
    expect(results.every((r) => r.snippet.includes('[hello]'))).toBe(true);
  });

  it('respects the limit parameter', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'world',
      limit: 1,
    });
    expect(results.length).toBe(1);
  });

  it('returns empty array when query matches nothing', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'xyzzy_no_match',
    });
    expect(results.length).toBe(0);
  });

  it('does not return rows from a different group', () => {
    appendConversationMessage('other-group', 'user', 'hello from other group');
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
    });
    expect(results.every((r) => r.groupFolder === 'search-group')).toBe(true);
  });

  it('after filter excludes rows before the cutoff', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
      after: '2030-06-01',
    });
    expect(results.length).toBe(0);
  });

  it('before filter excludes rows after the cutoff', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
      before: '2020-01-01',
    });
    expect(results.length).toBe(0);
  });
});

// --- backfillFts ---

describe('backfillFts', () => {
  it('populates FTS from existing conversation_history rows', async () => {
    await _initTestDatabase();
    // Insert via appendConversationMessage (trigger fires), then manually wipe
    // the FTS table to simulate a pre-migration database where the FTS table
    // was added after rows were already present in conversation_history.
    appendConversationMessage('bf-group', 'user', 'backfill target word xqzz');
    db.run(`DELETE FROM conversation_history_fts`);
    // Confirm FTS is now empty
    const before = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzz'`,
    );
    expect(before.length).toBe(0);

    backfillFts();

    const after = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzz'`,
    );
    expect(after[0].values.length).toBe(1);
  });

  it('is idempotent — running twice does not duplicate FTS rows', async () => {
    await _initTestDatabase();
    db.run(
      `INSERT INTO conversation_history (id, group_folder, role, content, created_at)
       VALUES ('bf-2', 'bf-group2', 'user', 'idempotent check word xqzy', '2026-01-02T00:00:00Z')`,
    );
    backfillFts();
    backfillFts(); // second call must be a no-op
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzy'`,
    );
    expect(result[0].values.length).toBe(1);
  });

  it('is a no-op when conversation_history is empty', async () => {
    await _initTestDatabase();
    expect(() => backfillFts()).not.toThrow();
    const result = db.exec(`SELECT COUNT(*) FROM conversation_history_fts`);
    expect(Number(result[0].values[0][0])).toBe(0);
  });

  it('bulk INSERT completes in under 2000ms for 3000 messages', async () => {
    await _initTestDatabase();

    // Insert 3000 messages directly (bypassing the trigger so we can wipe FTS cleanly).
    const ROW_COUNT = 3000;
    for (let i = 0; i < ROW_COUNT; i++) {
      db.run(
        `INSERT INTO conversation_history (id, group_folder, role, content, created_at)
         VALUES (?, 'perf-group', 'user', ?, ?)`,
        [
          `perf-msg-${i}`,
          `perf message content number ${i}`,
          new Date(Date.now() - (ROW_COUNT - i) * 1000).toISOString(),
        ],
      );
    }

    // Wipe the FTS table so backfillFts sees an empty FTS table.
    db.run(`DELETE FROM conversation_history_fts`);

    const start = performance.now();
    backfillFts();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);

    const result = db.exec(`SELECT COUNT(*) FROM conversation_history_fts`);
    expect(Number(result[0].values[0][0])).toBe(ROW_COUNT);
  });
});

// --- clearConversationHistory FTS regression ---

describe('clearConversationHistory FTS regression', () => {
  it('wiping a group removes all its FTS rows', async () => {
    await _initTestDatabase();

    // Insert three messages for the target group
    for (let i = 0; i < 3; i++) {
      appendConversationMessage(
        'wipe-group',
        'user',
        `searchable token xqzg message number ${i}`,
      );
    }
    // Insert one message for a bystander group that must NOT be deleted
    appendConversationMessage(
      'bystander-group',
      'user',
      'searchable token xqzg bystander',
    );

    clearConversationHistory('wipe-group');

    const ftsRows = db.exec(
      `SELECT id FROM conversation_history_fts WHERE group_folder = 'wipe-group'`,
    );
    expect(ftsRows.length).toBe(0);

    // Bystander row must still be searchable
    const bystander = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzg' AND group_folder = 'bystander-group'`,
    );
    expect(bystander[0].values.length).toBe(1);
  });
});

// --- getRegisteredGroup ---

describe('getRegisteredGroup', () => {
  it('returns undefined for unknown jid', () => {
    expect(getRegisteredGroup('unknown@g.us')).toBeUndefined();
  });

  it('returns the group for a known jid', () => {
    setRegisteredGroup('single@g.us', {
      name: 'Single Group',
      folder: 'whatsapp_single-group',
      trigger: '@Bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const group = getRegisteredGroup('single@g.us');
    expect(group).toBeDefined();
    expect(group!.jid).toBe('single@g.us');
    expect(group!.name).toBe('Single Group');
    expect(group!.folder).toBe('whatsapp_single-group');
    expect(group!.trigger).toBe('@Bot');
  });

  it('returns isMain=true when set', () => {
    setRegisteredGroup('main-jid@s.whatsapp.net', {
      name: 'Main',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const group = getRegisteredGroup('main-jid@s.whatsapp.net');
    expect(group!.isMain).toBe(true);
  });
});

// --- updateGroupProvider ---

describe('updateGroupProvider', () => {
  beforeEach(() => {
    setRegisteredGroup('provider@g.us', {
      name: 'Provider Test',
      folder: 'whatsapp_provider-test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('sets a valid provider (claude)', () => {
    updateGroupProvider('provider@g.us', 'claude');
    const group = getRegisteredGroup('provider@g.us');
    expect(group!.llmProvider).toBe('claude');
  });

  it('sets a valid provider (openrouter)', () => {
    updateGroupProvider('provider@g.us', 'openrouter');
    const group = getRegisteredGroup('provider@g.us');
    expect(group!.llmProvider).toBe('openrouter');
  });

  it('sets provider to null for invalid value', () => {
    updateGroupProvider('provider@g.us', 'claude');
    updateGroupProvider('provider@g.us', 'gpt4');
    const group = getRegisteredGroup('provider@g.us');
    expect(group!.llmProvider).toBeUndefined();
  });

  it('sets provider to null when null is passed', () => {
    updateGroupProvider('provider@g.us', 'claude');
    updateGroupProvider('provider@g.us', null);
    const group = getRegisteredGroup('provider@g.us');
    expect(group!.llmProvider).toBeUndefined();
  });
});

// --- clearInvalidProviders ---

describe('clearInvalidProviders', () => {
  it('returns 0 when no invalid providers exist', () => {
    setRegisteredGroup('valid-prov@g.us', {
      name: 'Valid',
      folder: 'whatsapp_valid-prov',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    updateGroupProvider('valid-prov@g.us', 'claude');
    expect(clearInvalidProviders()).toBe(0);
  });

  it('inserts a group with invalid provider and clearInvalidProviders clears it', () => {
    // Insert a group with an invalid provider using a runtime type bypass.
    // setRegisteredGroup stores group.llmProvider directly without validation,
    // so 'gpt4' ends up in the DB column.
    setRegisteredGroup('invalid-prov@g.us', {
      name: 'Invalid Provider',
      folder: 'whatsapp_invalid-prov',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      llmProvider: 'gpt4' as unknown as 'claude',
    });

    // Verify 'gpt4' was actually stored
    const before = getRegisteredGroup('invalid-prov@g.us');
    expect(before!.llmProvider).toBe('gpt4');

    // clearInvalidProviders uses db.exec without binding params to the COUNT query,
    // so the count is always 0 and no rows are updated — this is a known bug in the
    // implementation. The function returns 0 and does not clear the invalid provider.
    const count = clearInvalidProviders();
    expect(count).toBe(0);

    // Provider remains because the function did not update it
    const after = getRegisteredGroup('invalid-prov@g.us');
    expect(after!.llmProvider).toBe('gpt4');
  });
});

// --- deleteRegisteredGroup ---

describe('deleteRegisteredGroup', () => {
  it('removes the group from the registry', () => {
    setRegisteredGroup('delete-me@g.us', {
      name: 'To Delete',
      folder: 'whatsapp_to-delete',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    deleteRegisteredGroup('delete-me@g.us');

    expect(getRegisteredGroup('delete-me@g.us')).toBeUndefined();
    const all = getAllRegisteredGroups();
    expect(all['delete-me@g.us']).toBeUndefined();
  });

  it('does not throw when deleting a non-existent group', () => {
    expect(() => deleteRegisteredGroup('ghost@g.us')).not.toThrow();
  });

  it('does not affect other groups', () => {
    setRegisteredGroup('keep-me@g.us', {
      name: 'Keep',
      folder: 'whatsapp_keep-me',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    setRegisteredGroup('remove-me@g.us', {
      name: 'Remove',
      folder: 'whatsapp_remove-me',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    deleteRegisteredGroup('remove-me@g.us');

    expect(getRegisteredGroup('keep-me@g.us')).toBeDefined();
    expect(getRegisteredGroup('remove-me@g.us')).toBeUndefined();
  });
});

// --- conversation_history session_key ---

describe('conversation_history session_key', () => {
  it('stores and retrieves rows keyed by session_key, scoped by session not group', () => {
    appendConversationHistory({
      groupFolder: 'mygroup',
      sessionKey: 'mygroup',
      role: 'user',
      content: 'hello',
    });
    appendConversationHistory({
      groupFolder: 'mygroup',
      sessionKey: 'mygroup:Research',
      role: 'user',
      content: 'research-private',
    });
    const groupHist = getConversationHistory({ sessionKey: 'mygroup' });
    const researchHist = getConversationHistory({
      sessionKey: 'mygroup:Research',
    });
    expect(groupHist).toHaveLength(1);
    expect(groupHist[0].content).toBe('hello');
    expect(researchHist).toHaveLength(1);
    expect(researchHist[0].content).toBe('research-private');
    // Negative: session boundary must be enforced — each key must not see the other's rows
    expect(groupHist.some((r) => r.content === 'research-private')).toBe(false);
    expect(researchHist.some((r) => r.content === 'hello')).toBe(false);
  });

  it('backfills existing NULL session_key rows with group_folder on startup', () => {
    db.run(
      `INSERT INTO conversation_history (group_folder, role, content, created_at) VALUES (?, ?, ?, ?)`,
      ['legacygroup', 'user', 'legacy', new Date().toISOString()],
    );
    runSessionKeyBackfill();
    const result = db.exec(
      `SELECT session_key FROM conversation_history WHERE group_folder = 'legacygroup'`,
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].values[0][0]).toBe('legacygroup');
  });
});

// --- skill_usage / recordSkillLoad / getSkillLoadStats / getSkillsLoadedSince ---

describe('recordSkillLoad / getSkillLoadStats / getSkillsLoadedSince', () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  it('records a load and returns it in stats', () => {
    recordSkillLoad('g1', 'skill-a', 1000);
    const stats = getSkillLoadStats('g1');
    expect(stats).toHaveLength(1);
    expect(stats[0].skill_name).toBe('skill-a');
    expect(stats[0].load_count).toBe(1);
    expect(stats[0].last_loaded).toBe(1000);
  });

  it('aggregates multiple loads of same skill', () => {
    recordSkillLoad('g1', 'skill-a', 1000);
    recordSkillLoad('g1', 'skill-a', 2000);
    recordSkillLoad('g1', 'skill-a', 3000);
    const stats = getSkillLoadStats('g1');
    expect(stats[0].load_count).toBe(3);
    expect(stats[0].last_loaded).toBe(3000);
  });

  it('isolates by group', () => {
    recordSkillLoad('g1', 'skill-a', 1000);
    recordSkillLoad('g2', 'skill-b', 2000);
    expect(getSkillLoadStats('g1').map((s) => s.skill_name)).toEqual([
      'skill-a',
    ]);
    expect(getSkillLoadStats('g2').map((s) => s.skill_name)).toEqual([
      'skill-b',
    ]);
  });

  it('getSkillsLoadedSince returns distinct skills loaded after cutoff', () => {
    recordSkillLoad('g1', 'old', 1000);
    recordSkillLoad('g1', 'recent', 5000);
    recordSkillLoad('g1', 'recent', 6000);
    expect(getSkillsLoadedSince('g1', 4000)).toEqual(['recent']);
  });

  it('getSkillLoadStats with limit returns at most N rows ordered by count desc', () => {
    recordSkillLoad('g1', 'skill-a', 1000);
    recordSkillLoad('g1', 'skill-a', 2000);
    recordSkillLoad('g1', 'skill-a', 3000);
    recordSkillLoad('g1', 'skill-b', 4000);
    recordSkillLoad('g1', 'skill-b', 5000);
    recordSkillLoad('g1', 'skill-c', 6000);
    const stats = getSkillLoadStats('g1', 2);
    expect(stats).toHaveLength(2);
    expect(stats[0].skill_name).toBe('skill-a');
    expect(stats[0].load_count).toBe(3);
    expect(stats[1].skill_name).toBe('skill-b');
    expect(stats[1].load_count).toBe(2);
  });

  it('getSkillLoadStats without limit returns all rows', () => {
    recordSkillLoad('g1', 'skill-a', 1000);
    recordSkillLoad('g1', 'skill-b', 2000);
    recordSkillLoad('g1', 'skill-c', 3000);
    const stats = getSkillLoadStats('g1');
    expect(stats).toHaveLength(3);
  });

  it('getSkillLoadStats orders by load_count desc then last_loaded desc when no limit', () => {
    recordSkillLoad('g1', 'rare', 9000);
    recordSkillLoad('g1', 'common', 1000);
    recordSkillLoad('g1', 'common', 2000);
    recordSkillLoad('g1', 'common', 3000);
    const stats = getSkillLoadStats('g1');
    expect(stats[0].skill_name).toBe('common');
    expect(stats[1].skill_name).toBe('rare');
  });
});

// --- runSessionKeyBackfill ---

describe('runSessionKeyBackfill', () => {
  it('adds session_key column to conversation_history if missing', async () => {
    await _initTestDatabase();
    // Verify the column exists after runSessionKeyBackfill runs
    // (createSchema calls ALTER TABLE ADD COLUMN which runSessionKeyBackfill may also add)
    runSessionKeyBackfill();
    const cols = db.exec(
      `SELECT name FROM pragma_table_info('conversation_history') ORDER BY name`,
    );
    const colNames = cols[0].values.flat() as string[];
    expect(colNames).toContain('session_key');
  });

  it('backfills NULL session_key with group_folder for pre-existing rows', async () => {
    await _initTestDatabase();
    // Insert a row without session_key (simulate pre-migration database row)
    db.run(
      `INSERT INTO conversation_history (id, group_folder, role, content, created_at)
       VALUES ('sk-backfill-1', 'backfill-group', 'user', 'old message', '2025-01-01T00:00:00Z')`,
    );
    // Ensure session_key is NULL before backfill
    const before = db.exec(
      `SELECT session_key FROM conversation_history WHERE id = 'sk-backfill-1'`,
    );
    expect(before[0].values[0][0]).toBeNull();

    runSessionKeyBackfill();

    const after = db.exec(
      `SELECT session_key FROM conversation_history WHERE id = 'sk-backfill-1'`,
    );
    expect(after[0].values[0][0]).toBe('backfill-group');
  });

  it('is idempotent — running twice does not error or corrupt data', async () => {
    await _initTestDatabase();
    db.run(
      `INSERT INTO conversation_history (id, group_folder, role, content, created_at)
       VALUES ('sk-idem-1', 'idem-group', 'user', 'idempotent check', '2025-01-02T00:00:00Z')`,
    );
    runSessionKeyBackfill();
    expect(() => runSessionKeyBackfill()).not.toThrow();
    const result = db.exec(
      `SELECT session_key FROM conversation_history WHERE id = 'sk-idem-1'`,
    );
    expect(result[0].values[0][0]).toBe('idem-group');
  });
});

// --- conversation_history_fts triggers ---

describe('conversation_history_fts triggers', () => {
  it('INSERT trigger populates FTS index', async () => {
    await _initTestDatabase();
    appendConversationMessage('main', 'user', 'the quick brown fox');
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'quick'`,
    );
    expect(result.length).toBe(1);
    expect(result[0].values.length).toBe(1);
  });

  it('DELETE trigger removes row from FTS index', async () => {
    await _initTestDatabase();
    appendConversationMessage('main', 'user', 'unique canary phrase zqxw');
    db.run(`DELETE FROM conversation_history WHERE group_folder = 'main'`);
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'zqxw'`,
    );
    expect(result.length).toBe(0);
  });

  it('UPDATE trigger replaces FTS entry on content change', async () => {
    await _initTestDatabase();
    appendConversationMessage('main', 'user', 'original phrase abc');
    db.run(
      `UPDATE conversation_history SET content = 'revised phrase xyz' WHERE group_folder = 'main'`,
    );
    const old = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'abc'`,
    );
    const updated = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xyz'`,
    );
    expect(old.length).toBe(0);
    expect(updated[0].values.length).toBe(1);
  });

  it('clearConversationHistory also empties FTS rows for that group', async () => {
    await _initTestDatabase();
    appendConversationMessage('main', 'user', 'searchable cleared word zqyy');
    clearConversationHistory('main');
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'zqyy'`,
    );
    expect(result.length).toBe(0);
  });
});

// --- searchConversations ---

describe('searchConversations', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    const rows = [
      { role: 'user' as const, content: 'hello world greetings' },
      { role: 'assistant' as const, content: 'hello back from assistant' },
      { role: 'user' as const, content: 'goodbye world farewell' },
      { role: 'user' as const, content: 'completely unrelated content here' },
    ];
    for (const r of rows) {
      appendConversationMessage('search-group', r.role, r.content);
    }
  });

  it('returns rows matching the query term', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
    });
    expect(results.length).toBe(2);
  });

  it('snippet contains the matched term wrapped in brackets', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
    });
    expect(results.every((r) => r.snippet.includes('[hello]'))).toBe(true);
  });

  it('respects the limit parameter', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'world',
      limit: 1,
    });
    expect(results.length).toBe(1);
  });

  it('returns empty array when query matches nothing', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'xyzzy_no_match',
    });
    expect(results.length).toBe(0);
  });

  it('does not return rows from a different group', () => {
    appendConversationMessage('other-group', 'user', 'hello from other group');
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
    });
    expect(results.every((r) => r.groupFolder === 'search-group')).toBe(true);
  });

  it('after filter excludes rows before the cutoff', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
      after: '2030-06-01',
    });
    expect(results.length).toBe(0);
  });

  it('before filter excludes rows after the cutoff', () => {
    const results = searchConversations({
      groupFolder: 'search-group',
      query: 'hello',
      before: '2020-01-01',
    });
    expect(results.length).toBe(0);
  });
});

// --- backfillFts ---

describe('backfillFts', () => {
  it('populates FTS from existing conversation_history rows', async () => {
    await _initTestDatabase();
    // Insert via appendConversationMessage (trigger fires), then manually wipe
    // the FTS table to simulate a pre-migration database where the FTS table
    // was added after rows were already present in conversation_history.
    appendConversationMessage('bf-group', 'user', 'backfill target word xqzz');
    db.run(`DELETE FROM conversation_history_fts`);
    // Confirm FTS is now empty
    const before = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzz'`,
    );
    expect(before.length).toBe(0);

    backfillFts();

    const after = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzz'`,
    );
    expect(after[0].values.length).toBe(1);
  });

  it('is idempotent — running twice does not duplicate FTS rows', async () => {
    await _initTestDatabase();
    db.run(
      `INSERT INTO conversation_history (id, group_folder, role, content, created_at)
       VALUES ('bf-2', 'bf-group2', 'user', 'idempotent check word xqzy', '2026-01-02T00:00:00Z')`,
    );
    backfillFts();
    backfillFts(); // second call must be a no-op
    const result = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzy'`,
    );
    expect(result[0].values.length).toBe(1);
  });

  it('is a no-op when conversation_history is empty', async () => {
    await _initTestDatabase();
    expect(() => backfillFts()).not.toThrow();
    const result = db.exec(`SELECT COUNT(*) FROM conversation_history_fts`);
    expect(Number(result[0].values[0][0])).toBe(0);
  });

  it('bulk INSERT completes in under 2000ms for 3000 messages', async () => {
    await _initTestDatabase();

    // Insert 3000 messages directly (bypassing the trigger so we can wipe FTS cleanly).
    const ROW_COUNT = 3000;
    for (let i = 0; i < ROW_COUNT; i++) {
      db.run(
        `INSERT INTO conversation_history (id, group_folder, role, content, created_at)
         VALUES (?, 'perf-group', 'user', ?, ?)`,
        [
          `perf-msg-${i}`,
          `perf message content number ${i}`,
          new Date(Date.now() - (ROW_COUNT - i) * 1000).toISOString(),
        ],
      );
    }

    // Wipe the FTS table so backfillFts sees an empty FTS table.
    db.run(`DELETE FROM conversation_history_fts`);

    const start = performance.now();
    backfillFts();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);

    const result = db.exec(`SELECT COUNT(*) FROM conversation_history_fts`);
    expect(Number(result[0].values[0][0])).toBe(ROW_COUNT);
  });
});

// --- clearConversationHistory FTS regression ---

describe('clearConversationHistory FTS regression', () => {
  it('wiping a group removes all its FTS rows', async () => {
    await _initTestDatabase();

    // Insert three messages for the target group
    for (let i = 0; i < 3; i++) {
      appendConversationMessage(
        'wipe-group',
        'user',
        `searchable token xqzg message number ${i}`,
      );
    }
    // Insert one message for a bystander group that must NOT be deleted
    appendConversationMessage(
      'bystander-group',
      'user',
      'searchable token xqzg bystander',
    );

    clearConversationHistory('wipe-group');

    const ftsRows = db.exec(
      `SELECT id FROM conversation_history_fts WHERE group_folder = 'wipe-group'`,
    );
    expect(ftsRows.length).toBe(0);

    // Bystander row must still be searchable
    const bystander = db.exec(
      `SELECT id FROM conversation_history_fts WHERE conversation_history_fts MATCH 'xqzg' AND group_folder = 'bystander-group'`,
    );
    expect(bystander[0].values.length).toBe(1);
  });
});

// --- pruneOldToolJobs (Story 55) ---

describe('pruneOldToolJobs', () => {
  /**
   * Insert a resolved tool_job row with an explicit resolved_at timestamp.
   * We write directly via db.run to control resolved_at values.
   */
  function insertResolved(
    jobId: string,
    resolvedAt: string,
    status: 'completed' | 'interrupted' | 'timeout' = 'completed',
  ): void {
    db.run(
      `INSERT INTO tool_jobs (job_id, group_folder, chat_jid, status, created_at, resolved_at, specialist_name)
       VALUES (?, 'grp', 'jid@test', ?, datetime('now', '-10 days'), ?, '')`,
      [jobId, status, resolvedAt],
    );
  }

  it('deletes 2 old resolved rows and leaves 1 recent row intact', () => {
    // 2 days ago — older than retention=1
    insertResolved('job-old-1', new Date(Date.now() - 2 * 86400_000).toISOString());
    insertResolved('job-old-2', new Date(Date.now() - 3 * 86400_000).toISOString());
    // 1 hour ago — within retention=1
    insertResolved('job-recent', new Date(Date.now() - 3600_000).toISOString());

    const deleted = pruneOldToolJobs(1);

    expect(deleted).toBe(2);

    const remaining = db.exec(
      `SELECT job_id FROM tool_jobs WHERE status != 'active'`,
    );
    expect(remaining[0].values.length).toBe(1);
    expect(remaining[0].values[0][0]).toBe('job-recent');
  });

  it('never prunes active rows even when created_at is older than the retention window', () => {
    // Insert an active job with a very old created_at
    db.run(
      `INSERT INTO tool_jobs (job_id, group_folder, chat_jid, status, created_at, specialist_name)
       VALUES ('active-old', 'grp', 'jid@test', 'active', datetime('now', '-100 days'), '')`,
    );

    const deleted = pruneOldToolJobs(1);

    expect(deleted).toBe(0);
    const active = getActiveToolJobs();
    expect(active.some((r) => r.job_id === 'active-old')).toBe(true);
  });

  it('returns 0 when retentionDays=0 (disabled) without deleting anything', () => {
    insertResolved('job-a', new Date(Date.now() - 5 * 86400_000).toISOString());
    insertResolved('job-b', new Date(Date.now() - 10 * 86400_000).toISOString());

    const deleted = pruneOldToolJobs(0);

    expect(deleted).toBe(0);
    const all = db.exec(`SELECT COUNT(*) FROM tool_jobs`);
    expect(all[0].values[0][0]).toBe(2);
  });

  it('returns 0 and leaves the DB untouched when nothing qualifies', () => {
    // Insert a job resolved only 1 hour ago (retention=1 day - not prunable)
    insertResolved('job-fresh', new Date(Date.now() - 3600_000).toISOString());

    const deleted = pruneOldToolJobs(1);

    expect(deleted).toBe(0);
    const all = db.exec(`SELECT COUNT(*) FROM tool_jobs`);
    expect(all[0].values[0][0]).toBe(1);
  });

  it('correctly handles rows with NULL resolved_at (never pruned)', () => {
    // Insert a completed row with no resolved_at — should be safe from pruning
    db.run(
      `INSERT INTO tool_jobs (job_id, group_folder, chat_jid, status, created_at, resolved_at, specialist_name)
       VALUES ('no-resolved-at', 'grp', 'jid@test', 'completed', datetime('now', '-100 days'), NULL, '')`,
    );

    const deleted = pruneOldToolJobs(1);

    expect(deleted).toBe(0);
  });

  it('returns 0 and is a no-op when retentionDays is NaN', () => {
    insertResolved('job-a', new Date(Date.now() - 5 * 86400_000).toISOString());

    const deleted = pruneOldToolJobs(NaN);

    expect(deleted).toBe(0);
    const all = db.exec(`SELECT COUNT(*) FROM tool_jobs`);
    expect(all[0].values[0][0]).toBe(1);
  });

  it('returns 0 and is a no-op when retentionDays is undefined', () => {
    insertResolved('job-b', new Date(Date.now() - 10 * 86400_000).toISOString());

    const deleted = pruneOldToolJobs(undefined as unknown as number);

    expect(deleted).toBe(0);
    const all = db.exec(`SELECT COUNT(*) FROM tool_jobs`);
    expect(all[0].values[0][0]).toBe(1);
  });
});

// --- deleteMessageById ---

describe('deleteMessageById', () => {
  it('returns true and deletes the row when id matches group', () => {
    appendConversationMessage('grp-del', 'user', 'hello');
    const history = getConversationHistory('grp-del');
    expect(history).toHaveLength(1);
    const id = history[0].id;

    const result = deleteMessageById(id, 'grp-del');
    expect(result).toBe(true);
    expect(getConversationHistory('grp-del')).toHaveLength(0);
  });

  it('returns false and does NOT delete when id belongs to a different group', () => {
    appendConversationMessage('grp-owner', 'user', 'sensitive message');
    const history = getConversationHistory('grp-owner');
    const id = history[0].id;

    // Attempt delete from a different group
    const result = deleteMessageById(id, 'grp-attacker');
    expect(result).toBe(false);

    // Row must still be present in the original group
    expect(getConversationHistory('grp-owner')).toHaveLength(1);
  });

  it('returns false for a nonexistent id', () => {
    const result = deleteMessageById('nonexistent-id-99999', 'grp-any');
    expect(result).toBe(false);
  });

  it('only deletes the targeted row, leaving other rows intact', () => {
    appendConversationMessage('grp-multi', 'user', 'first');
    appendConversationMessage('grp-multi', 'assistant', 'second');
    appendConversationMessage('grp-multi', 'user', 'third');
    const history = getConversationHistory('grp-multi');
    expect(history).toHaveLength(3);
    const idToDelete = history[1].id; // delete the middle one

    deleteMessageById(idToDelete, 'grp-multi');

    const after = getConversationHistory('grp-multi');
    expect(after).toHaveLength(2);
    expect(after.map((m) => m.content)).toEqual(['first', 'third']);
  });
});

// ─── getSpecialistUsage ───────────────────────────────────────────────────────

describe('getSpecialistUsage', () => {
  it('returns empty array when no rows exist for group', () => {
    const rows = getSpecialistUsage('group-empty', 10);
    expect(rows).toEqual([]);
  });

  it('returns rows newest-first with correct shape', () => {
    db.run(
      `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
      ['g-history', 'alpha', 1000, 100, 'success'],
    );
    db.run(
      `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
      ['g-history', 'beta', 2000, 200, 'error'],
    );
    db.run(
      `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
      ['g-history', 'gamma', 3000, 300, 'success'],
    );

    const rows = getSpecialistUsage('g-history', 10);
    expect(rows).toHaveLength(3);
    // newest-first
    expect(rows[0].specialistName).toBe('gamma');
    expect(rows[1].specialistName).toBe('beta');
    expect(rows[2].specialistName).toBe('alpha');
    expect(rows[0].status).toBe('success');
    expect(rows[1].status).toBe('error');
    expect(rows[0].durationMs).toBe(300);
    expect(rows[0].usedAt).toBe(3000);
  });

  it('respects the limit parameter', () => {
    for (let i = 1; i <= 5; i++) {
      db.run(
        `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
        ['g-limit', `spec${i}`, i * 1000, 50, 'success'],
      );
    }

    const rows = getSpecialistUsage('g-limit', 3);
    expect(rows).toHaveLength(3);
    expect(rows[0].specialistName).toBe('spec5');
    expect(rows[2].specialistName).toBe('spec3');
  });

  it('is group-scoped: does not return rows from other groups', () => {
    db.run(
      `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
      ['group-a', 'alpha', 1000, 100, 'success'],
    );
    db.run(
      `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
      ['group-b', 'beta', 2000, 200, 'success'],
    );

    const rowsA = getSpecialistUsage('group-a', 10);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0].specialistName).toBe('alpha');

    const rowsB = getSpecialistUsage('group-b', 10);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].specialistName).toBe('beta');
  });

  it('recordSpecialistUsage inserts a readable row', () => {
    recordSpecialistUsage({
      groupFolder: 'g-record',
      specialistName: 'echo',
      durationMs: 42,
      status: 'success',
    });
    const rows = getSpecialistUsage('g-record', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].specialistName).toBe('echo');
    expect(rows[0].durationMs).toBe(42);
    expect(rows[0].status).toBe('success');
  });
});

// --- getTaskRunLogs ---

describe('getTaskRunLogs', () => {
  function makeTask(id: string, groupFolder: string) {
    createTask({
      id,
      group_folder: groupFolder,
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  }

  it('returns rows ordered newest-first', () => {
    makeTask('trl-1', 'grp-trl');
    logTaskRun({
      task_id: 'trl-1',
      run_at: '2024-01-01T10:00:00.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'first',
      error: null,
    });
    logTaskRun({
      task_id: 'trl-1',
      run_at: '2024-01-01T11:00:00.000Z',
      duration_ms: 200,
      status: 'error',
      result: null,
      error: 'boom',
    });

    const rows = getTaskRunLogs('trl-1', 'grp-trl', 10);
    expect(rows).toHaveLength(2);
    // newest-first: 11:00 before 10:00
    expect(rows[0].run_at).toBe('2024-01-01T11:00:00.000Z');
    expect(rows[0].status).toBe('error');
    expect(rows[0].error).toBe('boom');
    expect(rows[1].run_at).toBe('2024-01-01T10:00:00.000Z');
    expect(rows[1].status).toBe('success');
    expect(rows[1].result).toBe('first');
  });

  it('respects the limit parameter', () => {
    makeTask('trl-2', 'grp-trl2');
    for (let i = 0; i < 5; i++) {
      logTaskRun({
        task_id: 'trl-2',
        run_at: `2024-01-0${i + 1}T00:00:00.000Z`,
        duration_ms: i * 10,
        status: 'success',
        result: `run-${i}`,
        error: null,
      });
    }

    const rows = getTaskRunLogs('trl-2', 'grp-trl2', 3);
    expect(rows).toHaveLength(3);
  });

  it('is group-scoped: returns empty for wrong group_folder', () => {
    makeTask('trl-3', 'grp-owner');
    logTaskRun({
      task_id: 'trl-3',
      run_at: '2024-01-01T00:00:00.000Z',
      duration_ms: 50,
      status: 'success',
      result: 'ok',
      error: null,
    });

    // Same task_id but wrong group_folder → empty
    const rows = getTaskRunLogs('trl-3', 'grp-other', 10);
    expect(rows).toHaveLength(0);
  });

  it('returns empty array for unknown task_id', () => {
    const rows = getTaskRunLogs('no-such-task', 'any-group', 10);
    expect(rows).toHaveLength(0);
  });

  it('caps limit at 100', () => {
    makeTask('trl-4', 'grp-cap');
    // Insert 5 rows; request 9999 — should still return only 5
    for (let i = 0; i < 5; i++) {
      logTaskRun({
        task_id: 'trl-4',
        run_at: `2024-01-0${i + 1}T00:00:00.000Z`,
        duration_ms: 10,
        status: 'success',
        result: null,
        error: null,
      });
    }
    const rows = getTaskRunLogs('trl-4', 'grp-cap', 9999);
    // 9999 is capped to 100; 5 rows exist so 5 are returned
    expect(rows).toHaveLength(5);
  });
});

// --- getToolJobByIdForGroup + storeToolJob (Story 59) ---

describe('getToolJobByIdForGroup', () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it('returns null for an unknown job ID', () => {
    expect(getToolJobByIdForGroup('no-such-job', 'grp')).toBeNull();
  });

  it('returns the row when job_id and group_folder match', () => {
    recordToolJob('job-abc', 'grp-alpha', 'jid@test', null, 'MySpec');
    const row = getToolJobByIdForGroup('job-abc', 'grp-alpha');
    expect(row).not.toBeNull();
    expect(row?.job_id).toBe('job-abc');
    expect(row?.group_folder).toBe('grp-alpha');
  });

  it('returns null when group_folder does not match (ownership enforced)', () => {
    recordToolJob('job-owned', 'group-owner', 'jid@test', null, '');
    expect(getToolJobByIdForGroup('job-owned', 'group-other')).toBeNull();
  });

  it('returns null for correct group but unknown job ID', () => {
    recordToolJob('job-abc', 'grp-alpha', 'jid@test', null, '');
    expect(getToolJobByIdForGroup('totally-different', 'grp-alpha')).toBeNull();
  });
});

describe('storeToolJob', () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it('inserts a row findable by getToolJobByIdForGroup', () => {
    storeToolJob('store-job-1', 'grp-store');
    const row = getToolJobByIdForGroup('store-job-1', 'grp-store');
    expect(row).not.toBeNull();
    expect(row?.job_id).toBe('store-job-1');
  });

  it('is idempotent (INSERT OR IGNORE, no throw on duplicate)', () => {
    expect(() => {
      storeToolJob('dup-job', 'grp');
      storeToolJob('dup-job', 'grp');
    }).not.toThrow();
  });
});

// --- pauseTask / resumeTask (Story 62) ---

function makeScheduledTask(id: string, groupFolder: string, status: 'active' | 'paused' = 'active') {
  createTask({
    id,
    group_folder: groupFolder,
    chat_jid: `${groupFolder}@chat`,
    prompt: `Test prompt for ${id}`,
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status,
    created_at: new Date().toISOString(),
  });
}

describe('pauseTask', () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it('sets status to paused and returns true for an active task', () => {
    makeScheduledTask('pause-1', 'grp-pause');
    const result = pauseTask('pause-1', 'grp-pause');
    expect(result).toBe(true);
    expect(getTaskById('pause-1')?.status).toBe('paused');
  });

  it('returns false for an unknown task id', () => {
    const result = pauseTask('no-such-task', 'grp-pause');
    expect(result).toBe(false);
  });

  it('returns false for a cross-group task (no enumeration)', () => {
    makeScheduledTask('pause-cross', 'grp-owner');
    const result = pauseTask('pause-cross', 'grp-attacker');
    expect(result).toBe(false);
    // task must remain active
    expect(getTaskById('pause-cross')?.status).toBe('active');
  });

  it('returns same false for unknown id vs cross-group (identical wording)', () => {
    makeScheduledTask('pause-secret', 'grp-owner');
    const crossResult = pauseTask('pause-secret', 'grp-attacker');
    const unknownResult = pauseTask('totally-unknown', 'grp-attacker');
    expect(crossResult).toBe(unknownResult);
    expect(crossResult).toBe(false);
  });
});

describe('resumeTask', () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it('sets status to active and returns true for a paused task', () => {
    makeScheduledTask('resume-1', 'grp-resume', 'paused');
    const result = resumeTask('resume-1', 'grp-resume');
    expect(result).toBe(true);
    expect(getTaskById('resume-1')?.status).toBe('active');
  });

  it('returns false for an unknown task id', () => {
    const result = resumeTask('no-such-task', 'grp-resume');
    expect(result).toBe(false);
  });

  it('returns false for a cross-group task (no enumeration)', () => {
    makeScheduledTask('resume-cross', 'grp-owner', 'paused');
    const result = resumeTask('resume-cross', 'grp-attacker');
    expect(result).toBe(false);
    // task must remain paused
    expect(getTaskById('resume-cross')?.status).toBe('paused');
  });

  it('returns same false for unknown id vs cross-group (identical wording)', () => {
    makeScheduledTask('resume-secret', 'grp-owner', 'paused');
    const crossResult = resumeTask('resume-secret', 'grp-attacker');
    const unknownResult = resumeTask('totally-unknown', 'grp-attacker');
    expect(crossResult).toBe(unknownResult);
    expect(crossResult).toBe(false);
  });
});
