/**
 * Redis IPC Client for NanoClaw Agent Runner
 * Replaces filesystem-based IPC with Redis pub/sub and streams
 */

import { createClient, RedisClientType } from 'redis';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface TaskRequest {
  type:
    | 'schedule_task'
    | 'pause_task'
    | 'resume_task'
    | 'cancel_task'
    | 'update_task';
  taskId?: string;
  prompt?: string;
  schedule_type?: 'cron' | 'interval' | 'once';
  schedule_value?: string;
  context_mode?: 'group' | 'isolated';
  targetJid?: string;
  createdBy?: string;
  groupFolder?: string;
  isMain?: boolean;
  // For register_group
  jid?: string;
  name?: string;
  folder?: string;
  trigger?: string;
}

interface AgentOutputMessage {
  type: 'output';
  jobId: string;
  groupFolder: string;
  timestamp: string;
  payload: ContainerOutput;
}

interface TaskMessage {
  type:
    | 'schedule_task'
    | 'pause_task'
    | 'resume_task'
    | 'cancel_task'
    | 'update_task'
    | 'register_group';
  jobId: string;
  groupFolder: string;
  timestamp: string;
  payload: TaskRequest;
}

interface LogMessage {
  type: 'log';
  jobId: string;
  groupFolder: string;
  timestamp: string;
  level: string;
  message: string;
  context?: object;
}

interface MessageData {
  type: 'message';
  chatJid: string;
  text: string;
  sender?: string;
  groupFolder: string;
  timestamp: string;
}

export class RedisIPCClient {
  private redis: RedisClientType | null = null;
  private readonly redisUrl: string;
  private readonly groupFolder: string;
  private readonly chatJid: string;
  private readonly isMain: boolean;
  private readonly jobId: string;
  private isConnected = false;

  constructor(
    redisUrl: string,
    groupFolder: string,
    chatJid: string,
    isMain: boolean,
    jobId: string,
  ) {
    this.redisUrl = redisUrl;
    this.groupFolder = groupFolder;
    this.chatJid = chatJid;
    this.isMain = isMain;
    this.jobId = jobId;
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    this.redis = createClient({
      url: this.redisUrl,
    });

    this.redis.on('error', (err) => {
      console.error('[RedisIPC] Redis error:', err);
    });

    await this.redis.connect();
    this.isConnected = true;
    console.error('[RedisIPC] Connected to Redis');
  }

  /**
   * Send a message to the user/group
   */
  async sendMessage(text: string, sender?: string): Promise<void> {
    if (!this.redis || !this.isConnected) {
      throw new Error('Redis not connected');
    }

    const data: MessageData = {
      type: 'message',
      chatJid: this.chatJid,
      text,
      sender,
      groupFolder: this.groupFolder,
      timestamp: new Date().toISOString(),
    };

    const channel = `nanoclaw:messages:${this.groupFolder}`;
    await this.redis.publish(channel, JSON.stringify(data));
  }

  /**
   * Send a task request (schedule, pause, resume, cancel, update)
   */
  async sendTaskRequest(task: TaskRequest): Promise<void> {
    if (!this.redis || !this.isConnected) {
      throw new Error('Redis not connected');
    }

    const message: TaskMessage = {
      type: task.type,
      jobId: this.jobId,
      groupFolder: this.groupFolder,
      timestamp: new Date().toISOString(),
      payload: {
        ...task,
        groupFolder: this.groupFolder,
        isMain: this.isMain,
      },
    };

    const channel = `nanoclaw:tasks:${this.groupFolder}`;
    await this.redis.publish(channel, JSON.stringify(message));
  }

  /**
   * Send agent output
   */
  async sendOutput(output: ContainerOutput): Promise<void> {
    if (!this.redis || !this.isConnected) {
      throw new Error('Redis not connected');
    }

    const message: AgentOutputMessage = {
      type: 'output',
      jobId: this.jobId,
      groupFolder: this.groupFolder,
      timestamp: new Date().toISOString(),
      payload: output,
    };

    // Must match the channel KubernetesJobRunner.streamOutput() subscribes to:
    // nanoclaw:messages:${groupFolder}
    const channel = `nanoclaw:messages:${this.groupFolder}`;
    await this.redis.publish(channel, JSON.stringify(message));
  }

  /**
   * Send a log message
   */
  async sendLog(
    level: string,
    message: string,
    context?: object,
  ): Promise<void> {
    if (!this.redis || !this.isConnected) {
      throw new Error('Redis not connected');
    }

    const logMessage: LogMessage = {
      type: 'log',
      jobId: this.jobId,
      groupFolder: this.groupFolder,
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };

    const channel = `nanoclaw:logs:${this.groupFolder}`;
    await this.redis.publish(channel, JSON.stringify(logMessage));
  }

  /**
   * Listen for incoming messages from the input stream
   * Uses Redis Streams (XREAD) with 5-second blocking
   */
  async *listenForMessages(): AsyncGenerator<string> {
    if (!this.redis || !this.isConnected) {
      throw new Error('Redis not connected');
    }

    const streamKey = `nanoclaw:input:${this.jobId}`;
    let lastId = '0';

    while (true) {
      try {
        // Read from stream, blocking for 5 seconds
        const response = await this.redis.xRead(
          [{ key: streamKey, id: lastId }],
          { BLOCK: 5000, COUNT: 1 },
        );

        if (!response || response.length === 0) {
          continue;
        }

        const streamData = response[0];
        if (!streamData || !streamData.messages) {
          continue;
        }

        for (const message of streamData.messages) {
          lastId = message.id;

          const fields = message.message as Record<string, string>;
          const text = fields.text || '';

          // Check for close sentinel
          if (text === '_close') {
            console.error('[RedisIPC] Close sentinel received');
            return;
          }

          yield text;
        }
      } catch (err) {
        console.error('[RedisIPC] Error reading from stream:', err);
        // Wait a bit before retrying
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Wait for a close signal
   * Returns true if close signal received, false on error/timeout
   */
  async waitForCloseSignal(): Promise<boolean> {
    if (!this.redis || !this.isConnected) {
      throw new Error('Redis not connected');
    }

    const streamKey = `nanoclaw:input:${this.jobId}`;
    let lastId = '0';

    // Try to read any pending messages first
    try {
      const pending = await this.redis.xRange(streamKey, lastId, '+');
      for (const message of pending) {
        const fields = message.message as Record<string, string>;
        if (fields.text === '_close') {
          // Clean up the message
          await this.redis.xDel(streamKey, [message.id]);
          return true;
        }
        lastId = message.id;
      }
    } catch {
      // Ignore errors
    }

    // Poll for close signal
    while (true) {
      try {
        const response = await this.redis.xRead(
          [{ key: streamKey, id: lastId }],
          { BLOCK: 5000, COUNT: 1 },
        );

        if (!response || response.length === 0) {
          continue;
        }

        const streamData = response[0];
        if (!streamData || !streamData.messages) {
          continue;
        }

        for (const message of streamData.messages) {
          lastId = message.id;
          const fields = message.message as Record<string, string>;

          if (fields.text === '_close') {
            await this.redis.xDel(streamKey, [message.id]);
            return true;
          }
        }
      } catch (err) {
        console.error('[RedisIPC] Error waiting for close signal:', err);
        return false;
      }
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.redis && this.isConnected) {
      await this.redis.disconnect();
      this.isConnected = false;
      console.error('[RedisIPC] Disconnected from Redis');
    }
  }
}

export default RedisIPCClient;
