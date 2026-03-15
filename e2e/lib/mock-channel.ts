export interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
}

export type LLMProvider = 'claude' | 'openrouter';

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;
  isMain?: boolean;
  llmProvider?: LLMProvider;
}

export interface NewMessage {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe?: boolean;
  isBotMessage?: boolean;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}

export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

export interface MockChannelConfig {
  name?: string;
  messageDelay?: number;
  shouldFail?: boolean;
}

export interface QueuedMessage {
  jid: string;
  content: string;
  timestamp: number;
}

export interface MockChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  config?: MockChannelConfig;
}

let onMessageCallback: OnInboundMessage | null = null;
let onChatMetadataCallback: OnChatMetadata | null = null;
let registeredGroupsFn: (() => Record<string, RegisteredGroup>) | null = null;
let connected = false;
let messageQueue: QueuedMessage[] = [];
let messageDelay = 0;
let shouldFail = false;
let channelName = 'mock';

export function createMockChannel(opts: MockChannelOpts): Channel {
  onMessageCallback = opts.onMessage;
  onChatMetadataCallback = opts.onChatMetadata;
  registeredGroupsFn = opts.registeredGroups;

  if (opts.config) {
    channelName = opts.config.name || 'mock';
    messageDelay = opts.config.messageDelay || 0;
    shouldFail = opts.config.shouldFail || false;
  }

  return {
    name: channelName,

    connect: async () => {
      if (shouldFail) {
        throw new Error('Mock connection failed');
      }
      connected = true;
    },

    sendMessage: async (jid: string, text: string): Promise<void> => {
      if (!connected) {
        throw new Error('Channel not connected');
      }
      if (shouldFail) {
        throw new Error('Mock send failed');
      }

      const queued: QueuedMessage = {
        jid,
        content: text,
        timestamp: Date.now(),
      };
      messageQueue.push(queued);
    },

    isConnected: () => connected,

    ownsJid: (jid: string): boolean => {
      return jid.includes('@mock.local') || jid.startsWith('test-');
    },

    disconnect: async () => {
      connected = false;
      messageQueue = [];
    },

    setTyping: async (jid: string, isTyping: boolean): Promise<void> => {
      // Mock implementation - no-op
    },

    syncGroups: async (_force: boolean): Promise<void> => {
      if (!onChatMetadataCallback || !registeredGroupsFn) return;

      const groups = registeredGroupsFn();
      for (const [jid, group] of Object.entries(groups)) {
        onChatMetadataCallback(
          jid,
          new Date().toISOString(),
          group.name,
          channelName,
          true,
        );
      }
    },
  };
}

export function getQueuedMessages(): QueuedMessage[] {
  return [...messageQueue];
}

export function clearMessageQueue(): void {
  messageQueue = [];
}

export function simulateIncomingMessage(
  chatJid: string,
  content: string,
  sender: string = 'test-user',
  senderName: string = 'Test User',
): void {
  if (!onMessageCallback) {
    throw new Error(
      'Mock channel not initialized - missing onMessage callback',
    );
  }

  const newMessage: NewMessage = {
    id: `mock-msg-${Date.now()}`,
    chatJid,
    sender,
    senderName,
    content,
    timestamp: new Date().toISOString(),
    isFromMe: false,
    isBotMessage: false,
  };

  const deliver = () => {
    if (onMessageCallback) {
      onMessageCallback(chatJid, newMessage);
    }
  };

  if (messageDelay > 0) {
    setTimeout(deliver, messageDelay);
  } else {
    deliver();
  }
}

export function setMessageDelay(delay: number): void {
  messageDelay = delay;
}

export function setChannelShouldFail(fail: boolean): void {
  shouldFail = fail;
}

export function resetMockChannel(): void {
  connected = false;
  messageQueue = [];
  messageDelay = 0;
  shouldFail = false;
  onMessageCallback = null;
  onChatMetadataCallback = null;
  registeredGroupsFn = null;
  channelName = 'mock';
}

export function registerMockChannel(): void {
  const { registerChannel } = require('../src/channels/registry.js');

  registerChannel('mock', (opts: MockChannelOpts) => {
    return createMockChannel(opts);
  });
}
