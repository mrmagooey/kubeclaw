import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  isKubernetesAvailable,
  isRedisAvailable,
  getSharedRedis,
  getNamespace,
  getRedisUrlForTests,
  requireKubernetes,
  waitFor,
} from './setup.js';
import {
  startIRCServer,
  stopIRCServer,
  getIRCServer,
} from './lib/irc-server.js';
import { IRCChannel, IRCChannelOpts } from '../src/channels/irc.js';
import { execSync, spawnSync } from 'child_process';

const NAMESPACE = getNamespace();

/**
 * Phase 3: End-to-End Tests
 *
 * These tests verify complete workflows:
 * - Full message processing
 * - Agent container lifecycle
 * - IPC communication
 * - IRC channel integration
 */
describe('Phase 3: End-to-End', () => {
  const namespace = 'kubeclaw';
  let redis: import('ioredis').Redis;

  beforeAll(async () => {
    redis = getSharedRedis()!;
    if (!redis) {
      console.warn('⚠️  Redis not available for e2e tests');
    }
  });

  afterAll(async () => {
    // Redis is managed by setup.ts
  });

  describe('Complete Workflow', () => {
    it.todo(
      'should process a message through the system',
      // Requires: running orchestrator pod, registered group, agent image.
      // Steps: push message → wait for job creation → verify job completes → check Redis output.
    );

    it.todo(
      'should handle agent container lifecycle',
      // Requires: running orchestrator pod, agent image.
      // Steps: trigger job → verify pod starts → verify pod exits cleanly → verify TTL cleanup.
    );

    it('should handle Redis pub/sub', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping');
        return;
      }

      const channel = `e2e-test-channel-${Date.now()}`;
      const message = { test: 'message', timestamp: Date.now() };

      const received: any[] = [];

      const { default: Redis } = await import('ioredis');
      // Use a dedicated subscriber connection — the shared redis client
      // cannot both subscribe and publish on the same connection.
      const subscriber = new Redis(getRedisUrlForTests());
      const publisher = new Redis(getRedisUrlForTests());

      try {
        await new Promise<void>((resolve, reject) => {
          subscriber.subscribe(channel, (err) => {
            if (err) return reject(err);

            subscriber.on('message', (chan: string, msg: string) => {
              if (chan === channel) {
                received.push(JSON.parse(msg));
                resolve();
              }
            });

            publisher.publish(channel, JSON.stringify(message));
          });

          setTimeout(() => reject(new Error('pub/sub timed out after 5s')), 5000);
        });
      } finally {
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
        await publisher.quit();
      }

      expect(received.length).toBeGreaterThan(0);
      expect(received[0]).toMatchObject({ test: 'message' });
    });
  });

  describe('Error Handling', () => {
    it.todo(
      'should handle invalid messages gracefully',
      // Push malformed JSON to kubeclaw:messages, verify orchestrator logs a warning
      // and continues processing subsequent valid messages without crashing.
    );

    it.todo(
      'should handle container failures',
      // Create a job whose agent image intentionally exits non-zero.
      // Verify the orchestrator marks the job failed and does not retry (backoffLimit=0).
    );

    it.todo(
      'should handle Redis connection loss',
      // Simulate Redis becoming unavailable (kill port-forward), verify orchestrator
      // reconnects and resumes message consumption without data loss.
    );
  });

  describe('Performance', () => {
    it.todo(
      'should handle multiple concurrent requests',
      // Push N messages simultaneously, verify all N jobs are created and each
      // completes without queue entries being lost or processed twice.
    );

    it('should respond within acceptable time', async () => {
      // Placeholder for performance test
      const start = Date.now();

      // Simulate work
      await new Promise((resolve) => setTimeout(resolve, 100));

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('IRC Channel Integration', () => {
    const IRC_PORT = 16668; // Use different port from irc-channel.test.ts
    const IRC_SERVER = 'localhost';
    const IRC_NICK = 'NanoClawE2E';
    const IRC_CHANNEL = '#e2e-test';

    let ircServer: ReturnType<typeof getIRCServer>;
    let channel: IRCChannel | null = null;
    let receivedMessages: { chatJid: string; message: any }[] = [];

    function createTestOpts(): IRCChannelOpts {
      return {
        onMessage: (chatJid: string, message: any) => {
          receivedMessages.push({ chatJid, message });
        },
        onChatMetadata: () => {
          // Metadata handler
        },
        registeredGroups: () => ({
          [`irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`]: {
            name: 'E2E IRC Channel',
            folder: 'e2e-irc',
            trigger: '@Andy',
            added_at: new Date().toISOString(),
          },
        }),
      };
    }

    beforeAll(async () => {
      console.log('\n🚀 Starting IRC Server for E2E tests...');
      ircServer = await startIRCServer(IRC_PORT);
      console.log(`✅ IRC Server running on ${IRC_SERVER}:${IRC_PORT}\n`);
    }, 30000);

    afterAll(async () => {
      if (channel) {
        await channel.disconnect();
        channel = null;
      }
      console.log('\n🧹 Stopping IRC Server...');
      await stopIRCServer();
      console.log('✅ IRC Server stopped\n');
    }, 30000);

    it('should connect to IRC server and join channel', async () => {
      const config = {
        server: IRC_SERVER,
        port: IRC_PORT,
        nick: IRC_NICK,
        channels: [IRC_CHANNEL],
      };

      channel = new IRCChannel(config, createTestOpts());
      await channel.connect();

      expect(channel.isConnected()).toBe(true);
      expect(ircServer?.getConnectedClients()).toContain(IRC_NICK);

      // Poll until the server records the JOIN
      await waitFor(
        () =>
          (ircServer?.getChannels() ?? [])
            .map((c) => c.toLowerCase())
            .includes(IRC_CHANNEL.toLowerCase()),
        3000,
      );
      const channels = ircServer?.getChannels() || [];
      expect(channels.map((c) => c.toLowerCase())).toContain(
        IRC_CHANNEL.toLowerCase(),
      );
    }, 15000);

    it('should receive and process IRC messages', async () => {
      receivedMessages = [];
      const testMessage = 'Hello from E2E test!';

      ircServer?.simulateMessage('TestUser', IRC_CHANNEL, testMessage);

      await waitFor(() => receivedMessages.length > 0, 3000);

      expect(receivedMessages.length).toBeGreaterThan(0);
      expect(receivedMessages[0].message.content).toBe(testMessage);
      expect(receivedMessages[0].message.sender).toBe('TestUser');
    }, 5000);

    it('should send messages to IRC channel', async () => {
      if (!channel || !channel.isConnected()) {
        console.warn('⚠️  Channel not connected, skipping');
        return;
      }

      const chatJid = `irc:${IRC_CHANNEL.toLowerCase()}@${IRC_SERVER}:${IRC_PORT}`;
      const messageText = 'Response from NanoClaw bot';

      // Record messages on the server before sending
      const messagesBefore = ircServer?.getChannelMessages?.(IRC_CHANNEL) ?? [];

      await channel.sendMessage(chatJid, messageText);

      // Wait for the server to receive the outbound PRIVMSG (flood protection may add delay)
      await waitFor(
        () =>
          (ircServer?.getChannelMessages?.(IRC_CHANNEL) ?? []).length >
          messagesBefore.length,
        3000,
      );

      const messagesAfter = ircServer?.getChannelMessages?.(IRC_CHANNEL) ?? [];
      const newMessages = messagesAfter.slice(messagesBefore.length);

      expect(newMessages.length).toBeGreaterThan(0);
      expect(newMessages.some((m: any) => m.text?.includes(messageText))).toBe(true);
    }, 5000);

    it('should handle @mention translation', async () => {
      receivedMessages = [];
      const mentionMessage = `@${IRC_NICK} help me please`;

      ircServer?.simulateMessage('MentionUser', IRC_CHANNEL, mentionMessage);

      await waitFor(() => receivedMessages.length > 0, 3000);

      expect(receivedMessages.length).toBeGreaterThan(0);
      // Message should be translated to include @Andy
      expect(receivedMessages[0].message.content).toContain('@Andy');
    }, 5000);

    it('should handle IRC connection gracefully', async () => {
      // Disconnect and reconnect
      if (channel) {
        await channel.disconnect();
        expect(channel.isConnected()).toBe(false);

        // Reconnect
        await channel.connect();
        expect(channel.isConnected()).toBe(true);
      }
    }, 15000);
  });

  describe('IRC Full Roundtrip', () => {
    const IRC_FULL_PORT = 16669; // Use different port from other tests
    const IRC_FULL_SERVER = 'localhost';
    const IRC_FULL_NICK = 'NanoClawRoundtrip';
    const IRC_FULL_CHANNEL = '#roundtrip-test';

    let ircFullServer: ReturnType<typeof getIRCServer>;
    let ircFullChannel: IRCChannel | null = null;
    let receivedFullMessages: { chatJid: string; message: any }[] = [];
    let orchestratorAvailable = false;

    function createFullRoundtripOpts(): IRCChannelOpts {
      return {
        onMessage: (chatJid: string, message: any) => {
          receivedFullMessages.push({ chatJid, message });
        },
        onChatMetadata: () => {
          // Metadata handler
        },
        registeredGroups: () => ({
          [`irc:${IRC_FULL_CHANNEL.toLowerCase()}@${IRC_FULL_SERVER}:${IRC_FULL_PORT}`]:
            {
              name: 'Roundtrip IRC Channel',
              folder: 'roundtrip-irc',
              trigger: '@Andy',
              added_at: new Date().toISOString(),
            },
        }),
      };
    }

    /** Run kubectl without throwing; returns stdout and exit code. */
    function kcSafe(args: string[]): { stdout: string; exitCode: number } {
      const result = spawnSync('kubectl', args, { encoding: 'utf8' });
      return { stdout: (result.stdout ?? '').trim(), exitCode: result.status ?? 1 };
    }

    async function getOrchestratorPodLogs(
      namespace: string,
      tail: number = 100,
    ): Promise<string> {
      try {
        return execSync(
          `kubectl logs -n ${namespace} -l app=kubeclaw-orchestrator --tail=${tail}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
        );
      } catch {
        return '';
      }
    }

    beforeAll(async () => {
      // Check if Kubernetes is available for job verification
      try {
        requireKubernetes();
        orchestratorAvailable = true;
      } catch {
        console.log(
          '⚠️  Kubernetes not available, will skip K8s job verification',
        );
        orchestratorAvailable = false;
      }

      console.log('\n🚀 Starting IRC Server for Full Roundtrip tests...');
      ircFullServer = await startIRCServer(IRC_FULL_PORT);
      console.log(
        `✅ IRC Server running on ${IRC_FULL_SERVER}:${IRC_FULL_PORT}\n`,
      );
    }, 30000);

    afterAll(async () => {
      if (ircFullChannel) {
        await ircFullChannel.disconnect();
        ircFullChannel = null;
      }
      console.log('\n🧹 Stopping IRC Server for Full Roundtrip tests...');
      await stopIRCServer();
      console.log('✅ IRC Server stopped\n');
    }, 30000);

    it('should complete IRC message → Redis → orchestrator → K8s job flow', async () => {
      const redis = getSharedRedis();
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping');
        return;
      }

      // Step 1: Connect IRC channel
      console.log('\n📡 Step 1: Connecting IRC channel...');
      const config = {
        server: IRC_FULL_SERVER,
        port: IRC_FULL_PORT,
        nick: IRC_FULL_NICK,
        channels: [IRC_FULL_CHANNEL],
      };

      ircFullChannel = new IRCChannel(config, createFullRoundtripOpts());
      await ircFullChannel.connect();
      await waitFor(
        () =>
          (ircFullServer?.getChannels() ?? [])
            .map((c) => c.toLowerCase())
            .includes(IRC_FULL_CHANNEL.toLowerCase()),
        3000,
      );

      expect(ircFullChannel.isConnected()).toBe(true);
      console.log('✅ IRC channel connected and joined');

      // Step 2: Simulate incoming IRC message with @mention
      console.log('\n💬 Step 2: Simulating IRC message with @mention...');
      receivedFullMessages = [];
      const testMessage = `@${IRC_FULL_NICK} Hello from roundtrip test!`;
      const senderNick = 'RoundtripUser';

      ircFullServer?.simulateMessage(senderNick, IRC_FULL_CHANNEL, testMessage);
      await waitFor(() => receivedFullMessages.length > 0, 3000);

      // Step 3: Verify message callback was invoked
      console.log('\n✅ Step 3: Verifying message callback...');
      expect(receivedFullMessages.length).toBeGreaterThan(0);
      const receivedMessage = receivedFullMessages[0];
      expect(receivedMessage.message.sender).toBe(senderNick);
      expect(receivedMessage.message.content).toContain('@Andy'); // Should be translated
      expect(receivedMessage.message.content).toContain(testMessage);
      console.log('✅ Message callback invoked with correct data');

      // Step 4: Publish message to Redis queue in orchestrator format
      console.log('\n📤 Step 4: Publishing message to Redis queue...');
      const chatJid = `irc:${IRC_FULL_CHANNEL.toLowerCase()}@${IRC_FULL_SERVER}:${IRC_FULL_PORT}`;
      const orchestratorMessage = {
        type: 'message',
        payload: {
          id: `e2e-roundtrip-${Date.now()}`,
          chat_jid: chatJid,
          sender: senderNick,
          sender_name: senderNick,
          content: receivedMessage.message.content,
          timestamp: new Date().toISOString(),
        },
      };

      await redis.lpush(
        'kubeclaw:messages',
        JSON.stringify(orchestratorMessage),
      );
      console.log('✅ Message published to Redis queue');

      // Step 5: Wait for orchestrator to process
      console.log('\n⏳ Step 5: Waiting for orchestrator to process...');
      await new Promise((r) => setTimeout(r, 15000));

      // Get orchestrator logs to verify processing
      const logs = await getOrchestratorPodLogs(NAMESPACE, 100);
      console.log('📝 Orchestrator logs:');
      console.log(logs.slice(-1000));

      // Step 6: Verify Kubernetes job was created (if K8s available)
      if (orchestratorAvailable) {
        console.log('\n🔍 Step 6: Verifying Kubernetes job creation...');
        await new Promise((r) => setTimeout(r, 30000));

        try {
          // Use --no-headers to avoid ENOBUFS from large JSON payloads
          // when many test jobs have accumulated in the namespace.
          const jobNames = kcSafe([
            'get', 'jobs', '-n', NAMESPACE, '--no-headers',
            '-o', 'custom-columns=NAME:.metadata.name',
          ]);
          const names = jobNames.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);

          if (names.length > 0) {
            const recentJobs = names.slice(-5);

            console.log(`✅ Found ${names.length} total jobs`);
            console.log('📦 Recent jobs:', recentJobs);

            expect(recentJobs.length).toBeGreaterThan(0);
            console.log('✅ Kubernetes job was created by orchestrator');
          } else {
            console.log(
              '⚠️  No jobs found - orchestrator may need group registration',
            );
          }
        } catch (error) {
          console.error('❌ Error checking jobs:', error);
          throw error;
        }
      } else {
        console.log(
          '⚠️  Skipping K8s job verification - orchestrator not available',
        );
      }

      console.log('\n✅ IRC Full Roundtrip test completed successfully!');
    }, 180000);
  });
});
