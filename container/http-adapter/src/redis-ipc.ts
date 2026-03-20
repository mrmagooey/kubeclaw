/**
 * Redis IPC Client for NanoClaw Sidecar Adapters
 *
 * Handles bidirectional communication with the orchestrator using Redis Streams.
 * Uses Redis ACL for authentication with per-job credentials.
 */

import { createClient, RedisClientType } from 'redis';
import { ContainerOutput } from './protocol.js';

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

  /**
   * Connect to Redis with ACL credentials
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      this.client = createClient({
        url: this.config.url,
        username: this.config.username,
        password: this.config.password,
        socket: {
          reconnectStrategy: (retries: number) => {
            if (retries > 10) {
              return new Error('Max Redis reconnection retries exceeded');
            }
            // Exponential backoff: 100ms, 200ms, 400ms, ... up to 10s
            return Math.min(Math.pow(2, retries) * 100, 10000);
          },
        },
      });

      this.client.on('error', (err: Error) => {
        console.error(`[redis-ipc] Redis error: ${err.message}`);
      });

      this.client.on('connect', () => {
        console.error(`[redis-ipc] Connected to Redis`);
      });

      this.client.on('reconnecting', () => {
        console.error(`[redis-ipc] Reconnecting to Redis...`);
      });

      await this.client.connect();
      this.connected = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to Redis: ${errorMsg}`);
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
      this.client = null;
      console.error(`[redis-ipc] Disconnected from Redis`);
    }
  }

  /**
   * Listen for messages from the orchestrator via Redis Streams
   * Yields follow-up prompts or close signals
   */
  async *listenForMessages(): AsyncGenerator<RedisMessage> {
    if (!this.client || !this.connected) {
      throw new Error('Redis client not connected');
    }

    console.error(`[redis-ipc] Listening on stream: ${this.inputStream}`);

    while (this.connected) {
      try {
        // Use XREAD with BLOCK to wait for new messages
        const response = await this.client.xRead(
          [{ key: this.inputStream, id: this.lastId }],
          { BLOCK: 30000, COUNT: 1 }, // Block for 30s, get 1 message at a time
        );

        if (!response || response.length === 0) {
          // Timeout reached, continue polling
          continue;
        }

        const streamData = response[0];
        if (!streamData.messages || streamData.messages.length === 0) {
          continue;
        }

        for (const message of streamData.messages) {
          this.lastId = message.id;

          // Parse message fields
          const fields = message.message as Record<string, string>;
          const type = fields.type;

          if (type === 'close') {
            console.error(`[redis-ipc] Received close signal`);
            yield { type: 'close' };
            return;
          }

          if (type === 'followup') {
            console.error(`[redis-ipc] Received follow-up message`);
            yield {
              type: 'followup',
              prompt: fields.prompt,
              sessionId: fields.sessionId,
            };
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[redis-ipc] Error reading from stream: ${errorMsg}`);

        // If connection lost, try to reconnect
        if (!this.client.isReady) {
          console.error(
            `[redis-ipc] Connection lost, attempting to reconnect...`,
          );
          try {
            await this.client.connect();
          } catch (reconnectErr) {
            console.error(`[redis-ipc] Reconnection failed: ${reconnectErr}`);
            throw err; // Propagate error if reconnection fails
          }
        }
      }
    }
  }

  /**
   * Send output to the orchestrator via Redis Pub/Sub
   * Wraps ContainerOutput in AgentOutputMessage envelope.
   */
  async sendOutput(output: ContainerOutput): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('Redis client not connected');
    }

    try {
      const message = JSON.stringify({
        type: 'output',
        jobId: this.config.jobId,
        groupFolder: this.config.groupFolder,
        timestamp: new Date().toISOString(),
        payload: output,
      });
      await this.client.publish(this.outputChannel, message);
      console.error(`[redis-ipc] Sent output to ${this.outputChannel}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send output: ${errorMsg}`);
    }
  }

  /**
   * Send completion status to the orchestrator via Redis Pub/Sub.
   * Must be called before disconnect so the orchestrator resolves the stream.
   */
  async sendCompleted(): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('Redis client not connected');
    }

    try {
      const message = JSON.stringify({
        type: 'status',
        jobId: this.config.jobId,
        groupFolder: this.config.groupFolder,
        timestamp: new Date().toISOString(),
        payload: { status: 'completed' },
      });
      await this.client.publish(this.outputChannel, message);
      console.error(`[redis-ipc] Sent completed status to ${this.outputChannel}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send completed status: ${errorMsg}`);
    }
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected && this.client !== null && this.client.isReady;
  }
}
