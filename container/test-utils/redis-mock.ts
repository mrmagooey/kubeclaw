/**
 * Redis Mock for testing NanoClaw adapters
 * Provides an in-memory mock of Redis client functionality
 */

import { vi } from 'vitest';

export interface MockRedisMessage {
  id: string;
  message: Record<string, string>;
}

export interface MockStreamData {
  name: string;
  messages: MockRedisMessage[];
}

export class MockRedisClient {
  private connected: boolean = false;
  private subscribers: Map<string, ((message: string) => void)[]> = new Map();
  private streams: Map<string, MockRedisMessage[]> = new Map();
  private messageCounter: number = 0;

  // Event handlers
  private errorHandlers: ((err: Error) => void)[] = [];
  private connectHandlers: (() => void)[] = [];
  private reconnectingHandlers: (() => void)[] = [];

  isReady: boolean = false;

  on(event: string, handler: (...args: any[]) => void): void {
    if (event === 'error') {
      this.errorHandlers.push(handler);
    } else if (event === 'connect') {
      this.connectHandlers.push(handler);
    } else if (event === 'reconnecting') {
      this.reconnectingHandlers.push(handler);
    }
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.isReady = true;
    this.connectHandlers.forEach((h) => h());
  }

  async quit(): Promise<void> {
    this.connected = false;
    this.isReady = false;
  }

  async publish(channel: string, message: string): Promise<number> {
    if (!this.connected) {
      throw new Error('Redis client not connected');
    }
    const handlers = this.subscribers.get(channel) || [];
    handlers.forEach((handler) => handler(message));
    return handlers.length;
  }

  async subscribe(
    channel: string,
    callback: (message: string) => void,
  ): Promise<void> {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)!.push(callback);
  }

  async xRead(
    streams: { key: string; id: string }[],
    options: { BLOCK?: number; COUNT?: number },
  ): Promise<MockStreamData[] | null> {
    if (!this.connected) {
      throw new Error('Redis client not connected');
    }

    const results: MockStreamData[] = [];

    for (const { key, id } of streams) {
      const streamMessages = this.streams.get(key) || [];
      const startIndex =
        id === '0' ? 0 : streamMessages.findIndex((m) => m.id === id) + 1;

      if (startIndex < streamMessages.length) {
        results.push({
          name: key,
          messages: streamMessages.slice(
            startIndex,
            startIndex + (options.COUNT || 1),
          ),
        });
      }
    }

    return results.length > 0 ? results : null;
  }

  async xAdd(
    key: string,
    id: string,
    fields: Record<string, string>,
  ): Promise<string> {
    if (!this.connected) {
      throw new Error('Redis client not connected');
    }

    this.messageCounter++;
    const messageId = id === '*' ? `${Date.now()}-${this.messageCounter}` : id;

    if (!this.streams.has(key)) {
      this.streams.set(key, []);
    }

    this.streams.get(key)!.push({
      id: messageId,
      message: fields,
    });

    return messageId;
  }

  // Test helper methods
  simulateError(error: Error): void {
    this.errorHandlers.forEach((h) => h(error));
  }

  simulateReconnecting(): void {
    this.isReady = false;
    this.reconnectingHandlers.forEach((h) => h());
  }

  addStreamMessage(
    streamKey: string,
    fields: Record<string, string>,
    id?: string,
  ): string {
    if (!this.streams.has(streamKey)) {
      this.streams.set(streamKey, []);
    }

    this.messageCounter++;
    const messageId = id || `${Date.now()}-${this.messageCounter}`;

    this.streams.get(streamKey)!.push({
      id: messageId,
      message: fields,
    });

    return messageId;
  }

  clearStreams(): void {
    this.streams.clear();
    this.messageCounter = 0;
  }

  clearSubscribers(): void {
    this.subscribers.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  triggerError(error: Error): void {
    this.errorHandlers.forEach((handler) => handler(error));
  }
}

// Factory function to create a mock Redis client factory
export function createMockRedisClientFactory(mockClient: MockRedisClient) {
  return vi.fn().mockReturnValue(mockClient);
}
