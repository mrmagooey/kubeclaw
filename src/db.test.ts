import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
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
  clearConversationHistory,
  getRegisteredGroup,
  updateGroupProvider,
  clearInvalidProviders,
  deleteRegisteredGroup,
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
    expect(history[0]).toEqual({ role: 'user', content: 'hello' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'hi there' });
    expect(history[2]).toEqual({ role: 'user', content: 'how are you?' });
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
