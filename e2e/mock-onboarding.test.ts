import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { createTestDb, type TestDatabase } from './lib/test-db.js';
import { getMockLlmPort } from './setup.js';

describe('Mock E2E', () => {
  let testDb: TestDatabase | null = null;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    if (testDb) {
      testDb.close();
      testDb = null;
    }
  });

  describe('Onboarding', () => {
    it('should initialize test environment', async () => {
      expect(getMockLlmPort()).toBe(11434);
      expect(testDb).toBeTruthy();
    });

    it('should register mock channel', async () => {
      const { registerMockChannel, createMockChannel } =
        await import('./lib/mock-channel.js');

      let messageReceived = false;

      const channel = createMockChannel({
        onMessage: (_chatJid, _message) => {
          messageReceived = true;
        },
        onChatMetadata: () => {},
        registeredGroups: () => ({}),
      });

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('should create test group in database', async () => {
      expect(testDb).toBeTruthy();

      testDb!.addChat('test-group@mock.local', 'Test Group', 'mock', true);

      const chats = testDb!.getChats();
      expect(chats).toHaveLength(1);
      expect(chats[0].jid).toBe('test-group@mock.local');
      expect(chats[0].name).toBe('Test Group');
      expect(chats[0].channel).toBe('mock');
      expect(chats[0].is_group).toBe(1);
    });

    it('should add messages to test group', async () => {
      expect(testDb).toBeTruthy();

      testDb!.addChat('test-group@mock.local', 'Test Group', 'mock', true);

      testDb!.addMessage({
        id: 'msg-1',
        chat_jid: 'test-group@mock.local',
        sender: 'user-1',
        sender_name: 'Test User',
        content: 'Hello, world!',
        timestamp: new Date().toISOString(),
        is_from_me: 0,
        is_bot_message: 0,
      });

      const messages = testDb!.getMessages('test-group@mock.local');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello, world!');
      expect(messages[0].sender_name).toBe('Test User');
    });

    it('should support scheduled tasks', async () => {
      expect(testDb).toBeTruthy();

      testDb!.addTask({
        id: 'task-1',
        group_folder: 'test-group',
        chat_jid: 'test-group@mock.local',
        prompt: 'Daily summary',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        context_mode: 'isolated',
        next_run: new Date().toISOString(),
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: new Date().toISOString(),
      });

      const tasks = testDb!.getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe('Daily summary');
      expect(tasks[0].schedule_type).toBe('cron');
    });
  });
});
