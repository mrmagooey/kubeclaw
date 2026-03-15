import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setResponseTemplate,
  clearResponseTemplates,
} from './lib/mock-llm-server.js';
import { createTestDb, type TestDatabase } from './lib/test-db.js';
import {
  createMockChannel,
  getQueuedMessages,
  clearMessageQueue,
  simulateIncomingMessage,
  resetMockChannel,
} from './lib/mock-channel.js';
import { getMockLlmPort } from './setup.js';

// Helper function to retry fetch with exponential backoff
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  delayMs: number = 100,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || i === maxRetries - 1) {
        return response;
      }
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, delayMs * Math.pow(2, i)),
        );
      }
    }
  }

  throw (
    lastError || new Error(`Failed to fetch ${url} after ${maxRetries} retries`)
  );
}

describe('Mock E2E Usage', () => {
  let testDb: TestDatabase | null = null;

  beforeEach(async () => {
    testDb = await createTestDb();
    clearMessageQueue();
    resetMockChannel();
    clearResponseTemplates();
  });

  afterEach(async () => {
    if (testDb) {
      testDb.close();
      testDb = null;
    }
    resetMockChannel();
    clearResponseTemplates();
  });

  describe('Message Routing', () => {
    it('should route message through channel', async () => {
      const { registerMockChannel } = await import('./lib/mock-channel.js');

      let receivedMessage: { chatJid: string; content: string } | null = null;

      const channel = createMockChannel({
        onMessage: (chatJid, message) => {
          receivedMessage = { chatJid, content: message.content };
        },
        onChatMetadata: () => {},
        registeredGroups: () => ({}),
      });

      await channel.connect();

      simulateIncomingMessage(
        'test-group@mock.local',
        'Hello, assistant!',
        'test-user',
        'Test User',
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedMessage).not.toBeNull();
      expect(receivedMessage!.chatJid).toBe('test-group@mock.local');
      expect(receivedMessage!.content).toBe('Hello, assistant!');
    });

    it('should get response from mock LLM', async () => {
      setResponseTemplate('default', {
        role: 'assistant',
        content: 'Hello! How can I help you today?',
      });

      const response = await fetchWithRetry(
        `http://localhost:${getMockLlmPort()}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test/model',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        },
      );

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.choices).toHaveLength(1);
      expect(data.choices[0].message.content).toBe(
        "Hello! I'm your NanoClaw assistant. How can I help you today?",
      );
    });

    it('should deliver response to channel', async () => {
      const channel = createMockChannel({
        onMessage: () => {},
        onChatMetadata: () => {},
        registeredGroups: () => ({}),
      });

      await channel.connect();

      await channel.sendMessage(
        'test-group@mock.local',
        'Hello! How can I help you today?',
      );

      const queued = getQueuedMessages();
      expect(queued).toHaveLength(1);
      expect(queued[0].jid).toBe('test-group@mock.local');
      expect(queued[0].content).toBe('Hello! How can I help you today?');
    });

    it('should handle end-to-end conversation flow', async () => {
      setResponseTemplate('default', {
        role: 'assistant',
        content: 'Mock response to your message',
      });

      const channel = createMockChannel({
        onMessage: () => {},
        onChatMetadata: () => {},
        registeredGroups: () => ({}),
      });

      await channel.connect();

      testDb!.addChat('test-group@mock.local', 'Test Group', 'mock', true);

      testDb!.addMessage({
        id: 'user-msg-1',
        chat_jid: 'test-group@mock.local',
        sender: 'user-1',
        sender_name: 'Test User',
        content: 'Hello!',
        timestamp: new Date().toISOString(),
        is_from_me: 0,
        is_bot_message: 0,
      });

      const userMessages = testDb!.getMessages('test-group@mock.local');
      expect(userMessages).toHaveLength(1);

      await channel.sendMessage(
        'test-group@mock.local',
        'Mock response to your message',
      );

      const queued = getQueuedMessages();
      expect(queued).toHaveLength(1);

      testDb!.addMessage({
        id: 'bot-msg-1',
        chat_jid: 'test-group@mock.local',
        sender: 'assistant',
        sender_name: 'Assistant',
        content: 'Mock response to your message',
        timestamp: new Date().toISOString(),
        is_from_me: 1,
        is_bot_message: 1,
      });

      const allMessages = testDb!.getMessages('test-group@mock.local');
      expect(allMessages).toHaveLength(2);
    });

    it('should support custom response templates', async () => {
      setResponseTemplate('greeting', {
        role: 'assistant',
        content: 'Hi there! Nice to meet you!',
      });

      setResponseTemplate('help', {
        role: 'assistant',
        content: "I'm here to help! What would you like to do?",
      });

      const greetingResponse = await fetchWithRetry(
        `http://localhost:${getMockLlmPort()}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test/model',
            messages: [{ role: 'user', content: 'I want to say greeting' }],
          }),
        },
      );

      const greetingData = await greetingResponse.json();
      expect(greetingData.choices[0].message.content).toBe(
        'Hi there! Nice to meet you!',
      );

      const helpResponse = await fetchWithRetry(
        `http://localhost:${getMockLlmPort()}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'test/model',
            messages: [{ role: 'user', content: 'I need help' }],
          }),
        },
      );

      const helpData = await helpResponse.json();
      expect(helpData.choices[0].message.content).toBe(
        "I'm here to help! What would you like to do?",
      );
    });
  });
});
