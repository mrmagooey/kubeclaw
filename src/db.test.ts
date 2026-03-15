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
