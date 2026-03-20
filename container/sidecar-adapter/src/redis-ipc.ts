/**
 * Redis IPC Client for NanoClaw Sidecar Adapter
 *
 * Handles bidirectional communication with the orchestrator using Redis:
 * - Output delivery via Pub/Sub on the group channel (push, no polling)
 * - Follow-up message receipt via Redis Streams (XREAD BLOCK)
 */

import { createClient, RedisClientType } from 'redis';
import { TaskOutput } from './types.js';

export interface RedisIPCConfig {
  url: string;
  username: string;
  password: string;
  jobId: string;
  groupFolder: string;
}

export interface RedisMessage {
  type: 'followup' | 'close';
  prompt?: string;
  sessionId?: string;
}

export class RedisIPCClient {
  private client: RedisClientType | null = null;
  private config: RedisIPCConfig;
  private inputStream: string;
  private outputChannel: string;
  private lastId: string = '0';
  private connected: boolean = false;

  constructor(config: RedisIPCConfig) {
    this.config = config;
    this.inputStream = `kubeclaw:input:${config.jobId}`;
    this.outputChannel = `kubeclaw:messages:${config.groupFolder}`;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.client = createClient({
      url: this.config.url,
      username: this.config.username,
      password: this.config.password,
      socket: {
        reconnectStrategy: (retries: number) => {
          if (retries > 10) return new Error('Max Redis reconnection retries exceeded');
          return Math.min(Math.pow(2, retries) * 100, 10000);
        },
      },
    });

    this.client.on('error', (err: Error) => {
      console.error(`[redis-ipc] Redis error: ${err.message}`);
    });

    await this.client.connect();
    this.connected = true;
    console.error(`[redis-ipc] Connected to Redis`);
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
      this.client = null;
      console.error(`[redis-ipc] Disconnected from Redis`);
    }
  }

  /**
   * Send output to the orchestrator via Redis Pub/Sub.
   * Wraps TaskOutput in the AgentOutputMessage envelope the orchestrator expects.
   */
  async sendOutput(output: TaskOutput): Promise<void> {
    if (!this.client || !this.connected) throw new Error('Redis client not connected');

    const message = JSON.stringify({
      type: 'output',
      jobId: this.config.jobId,
      groupFolder: this.config.groupFolder,
      timestamp: new Date().toISOString(),
      payload: output,
    });
    await this.client.publish(this.outputChannel, message);
    console.error(`[redis-ipc] Sent output to ${this.outputChannel}`);
  }

  /**
   * Send completion status so the orchestrator resolves the stream promise.
   */
  async sendCompleted(): Promise<void> {
    if (!this.client || !this.connected) throw new Error('Redis client not connected');

    const message = JSON.stringify({
      type: 'status',
      jobId: this.config.jobId,
      groupFolder: this.config.groupFolder,
      timestamp: new Date().toISOString(),
      payload: { status: 'completed' },
    });
    await this.client.publish(this.outputChannel, message);
    console.error(`[redis-ipc] Sent completed status to ${this.outputChannel}`);
  }

  /**
   * Listen for follow-up messages from the orchestrator via Redis Streams.
   */
  async *listenForMessages(): AsyncGenerator<RedisMessage> {
    if (!this.client || !this.connected) throw new Error('Redis client not connected');

    console.error(`[redis-ipc] Listening on stream: ${this.inputStream}`);

    while (this.connected) {
      try {
        const response = await this.client.xRead(
          [{ key: this.inputStream, id: this.lastId }],
          { BLOCK: 30000, COUNT: 1 },
        );

        if (!response || response.length === 0) continue;

        const streamData = response[0];
        if (!streamData.messages || streamData.messages.length === 0) continue;

        for (const message of streamData.messages) {
          this.lastId = message.id;
          const fields = message.message as Record<string, string>;

          if (fields.type === 'close') {
            console.error(`[redis-ipc] Received close signal`);
            yield { type: 'close' };
            return;
          }

          if (fields.type === 'followup') {
            console.error(`[redis-ipc] Received follow-up message`);
            yield { type: 'followup', prompt: fields.prompt, sessionId: fields.sessionId };
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[redis-ipc] Error reading from stream: ${errorMsg}`);
        if (this.client && !this.client.isReady) {
          try { await this.client.connect(); } catch (_) { throw err; }
        }
      }
    }
  }

  isConnected(): boolean {
    return this.connected && this.client !== null && this.client.isReady;
  }
}
