import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  isKubernetesAvailable,
  isRedisAvailable,
  getSharedRedis,
  getNamespace,
  createTestNamespace,
  flushTestKeys,
  getRedisUrlForTests,
} from './setup.js';

const NAMESPACE = getNamespace();

interface MessageState {
  id: string;
  chatJid: string;
  content: string;
  sender: string;
  timestamp: string;
  isFromMe: boolean;
}

interface SessionState {
  sessionId: string;
  groupFolder: string;
  createdAt: number;
  lastActivity: number;
}

interface GroupState {
  groupFolder: string;
  name: string;
  triggerPattern: string;
  registeredAt: number;
}

describe('State Persistence Integration', () => {
  let redis: import('ioredis').Redis;
  let testGroup: string;
  let testGroup2: string;

  beforeAll(async () => {
    redis = getSharedRedis()!;
    if (!redis) {
      console.warn('⚠️  Redis not available, skipping tests');
      return;
    }
    testGroup = createTestNamespace();
    testGroup2 = createTestNamespace();
  }, 30000);

  beforeEach(async () => {
    if (redis) {
      await flushTestKeys(redis, `*:${testGroup}`);
      await flushTestKeys(redis, `*:${testGroup2}`);
    }
  }, 10000);

  afterEach(async () => {
    if (redis) {
      await flushTestKeys(redis, `*:${testGroup}`);
      await flushTestKeys(redis, `*:${testGroup2}`);
    }
  }, 10000);

  afterAll(async () => {
    if (redis) {
      await flushTestKeys(redis, `*:${testGroup}`);
      await flushTestKeys(redis, `*:${testGroup2}`);
    }
  }, 10000);

  describe('Message State Storage and Retrieval', () => {
    it('should store and retrieve message state using string', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const messageKey = `${NAMESPACE}:message:${testGroup}:msg-001`;
      const messageState: MessageState = {
        id: 'msg-001',
        chatJid: 'chat-123',
        content: 'Hello, world!',
        sender: 'user-456',
        timestamp: new Date().toISOString(),
        isFromMe: false,
      };

      await redis.set(messageKey, JSON.stringify(messageState));

      const retrieved = await redis.get(messageKey);
      expect(retrieved).toBeTruthy();

      const parsed: MessageState = JSON.parse(retrieved!);
      expect(parsed.id).toBe(messageState.id);
      expect(parsed.chatJid).toBe(messageState.chatJid);
      expect(parsed.content).toBe(messageState.content);
      expect(parsed.sender).toBe(messageState.sender);
    }, 10000);

    it('should store multiple messages using hash', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const hashKey = `${NAMESPACE}:messages:${testGroup}`;

      const messages: Record<string, MessageState> = {
        'msg-001': {
          id: 'msg-001',
          chatJid: 'chat-123',
          content: 'First message',
          sender: 'user-1',
          timestamp: new Date().toISOString(),
          isFromMe: false,
        },
        'msg-002': {
          id: 'msg-002',
          chatJid: 'chat-123',
          content: 'Second message',
          sender: 'user-2',
          timestamp: new Date().toISOString(),
          isFromMe: true,
        },
      };

      for (const [id, msg] of Object.entries(messages)) {
        await redis.hset(hashKey, id, JSON.stringify(msg));
      }

      const storedCount = await redis.hlen(hashKey);
      expect(storedCount).toBe(2);

      const msg1 = await redis.hget(hashKey, 'msg-001');
      expect(JSON.parse(msg1!).content).toBe('First message');

      const msg2 = await redis.hget(hashKey, 'msg-002');
      expect(JSON.parse(msg2!).content).toBe('Second message');
    }, 10000);

    it('should retrieve all messages using hash', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const hashKey = `${NAMESPACE}:messages:${testGroup}`;

      await redis.hset(
        hashKey,
        'msg-test',
        JSON.stringify({ id: 'msg-test', content: 'Test' }),
      );

      const allMessages = await redis.hgetall(hashKey);
      expect(Object.keys(allMessages).length).toBeGreaterThan(0);
    }, 10000);

    it('should handle message state updates', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const messageKey = `${NAMESPACE}:message:${testGroup}:msg-003`;

      const originalState: MessageState = {
        id: 'msg-003',
        chatJid: 'chat-456',
        content: 'Original content',
        sender: 'user-789',
        timestamp: new Date().toISOString(),
        isFromMe: false,
      };

      await redis.set(messageKey, JSON.stringify(originalState));

      const updatedState: MessageState = {
        ...originalState,
        content: 'Updated content',
        timestamp: new Date().toISOString(),
      };

      await redis.set(messageKey, JSON.stringify(updatedState));

      const retrieved = await redis.get(messageKey);
      const parsed: MessageState = JSON.parse(retrieved!);
      expect(parsed.content).toBe('Updated content');
    }, 10000);
  });

  describe('Session State Persistence', () => {
    it('should store session state using string', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const sessionKey = `${NAMESPACE}:session:${testGroup}`;
      const sessionState: SessionState = {
        sessionId: `session-${Date.now()}`,
        groupFolder: testGroup,
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };

      await redis.set(sessionKey, JSON.stringify(sessionState));

      const retrieved = await redis.get(sessionKey);
      expect(retrieved).toBeTruthy();

      const parsed: SessionState = JSON.parse(retrieved!);
      expect(parsed.sessionId).toBe(sessionState.sessionId);
      expect(parsed.groupFolder).toBe(testGroup);
    }, 10000);

    it('should store multiple sessions using hash', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const sessionsHashKey = `${NAMESPACE}:sessions`;

      const sessions: Record<string, SessionState> = {
        [testGroup]: {
          sessionId: 'session-1',
          groupFolder: testGroup,
          createdAt: Date.now(),
          lastActivity: Date.now(),
        },
        [testGroup2]: {
          sessionId: 'session-2',
          groupFolder: testGroup2,
          createdAt: Date.now(),
          lastActivity: Date.now(),
        },
      };

      for (const [folder, session] of Object.entries(sessions)) {
        await redis.hset(sessionsHashKey, folder, JSON.stringify(session));
      }

      const session1 = await redis.hget(sessionsHashKey, testGroup);
      const session2 = await redis.hget(sessionsHashKey, testGroup2);

      expect(JSON.parse(session1!).groupFolder).toBe(testGroup);
      expect(JSON.parse(session2!).groupFolder).toBe(testGroup2);
    }, 10000);

    it('should track session activity with sorted set', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const activityKey = `${NAMESPACE}:session-activity`;

      const sessions = [
        { sessionId: 'session-a', score: Date.now() - 100000 },
        { sessionId: 'session-b', score: Date.now() - 50000 },
        { sessionId: 'session-c', score: Date.now() },
      ];

      for (const session of sessions) {
        await redis.zadd(activityKey, session.score, session.sessionId);
      }

      const recentSessions = await redis.zrevrange(activityKey, 0, -1);
      expect(recentSessions).toHaveLength(3);
      expect(recentSessions[0]).toBe('session-c');
    }, 10000);

    it('should retrieve all sessions', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const sessionsHashKey = `${NAMESPACE}:sessions`;

      const allSessions = await redis.hgetall(sessionsHashKey);
      expect(Object.keys(allSessions).length).toBeGreaterThanOrEqual(2);
    }, 10000);
  });

  describe('TTL/Expiration Handling for State Data', () => {
    it('should set TTL on message state', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const messageKey = `${NAMESPACE}:temp-message:${testGroup}:temp-001`;
      const messageState = {
        id: 'temp-001',
        chatJid: 'chat-temp',
        content: 'Temporary message',
        sender: 'user-temp',
        timestamp: new Date().toISOString(),
      };

      await redis.set(messageKey, JSON.stringify(messageState), 'EX', 2);

      const ttlBefore = await redis.ttl(messageKey);
      expect(ttlBefore).toBeGreaterThan(0);
      expect(ttlBefore).toBeLessThanOrEqual(2);

      // Poll until the key expires rather than using a fixed 2.5s sleep —
      // avoids false failures on slow CI runners where the sleep finishes early.
      const deadline = Date.now() + 5000;
      let expiredValue: string | null = 'not-expired';
      while (Date.now() < deadline) {
        expiredValue = await redis.get(messageKey);
        if (expiredValue === null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(expiredValue).toBeNull();
    }, 10000);

    it('should set TTL on session state', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const sessionKey = `${NAMESPACE}:temp-session:${testGroup}`;
      const sessionState = {
        sessionId: 'temp-session',
        groupFolder: testGroup,
        createdAt: Date.now(),
      };

      await redis.set(sessionKey, JSON.stringify(sessionState), 'EX', 5);

      const ttl = await redis.ttl(sessionKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(5);
    }, 10000);

    it('should refresh TTL on state access', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const stateKey = `${NAMESPACE}:refreshable:${testGroup}`;
      const stateData = { key: 'value' };

      await redis.set(stateKey, JSON.stringify(stateData), 'EX', 10);

      await redis.set(
        stateKey,
        JSON.stringify({ ...stateData, updated: true }),
        'KEEPTTL',
      );

      const ttl = await redis.ttl(stateKey);
      expect(ttl).toBeGreaterThan(5);
    }, 10000);

    it('should handle hash with individual field TTL using sorted sets', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const hashKey = `${NAMESPACE}:hash-ttl:${testGroup}`;
      const metaKey = `${NAMESPACE}:hash-ttl-meta:${testGroup}`;

      await redis.hset(hashKey, 'field1', 'value1');
      await redis.hset(hashKey, 'field2', 'value2');

      await redis.zadd(metaKey, Date.now() + 5000, 'field1');
      await redis.zadd(metaKey, Date.now() + 10000, 'field2');

      const ttl1 = await redis.zscore(metaKey, 'field1');
      const ttl2 = await redis.zscore(metaKey, 'field2');

      expect(ttl1).toBeTruthy();
      expect(ttl2).toBeTruthy();
      expect(parseFloat(ttl1!)).toBeLessThan(parseFloat(ttl2!));
    }, 10000);

    it('should auto-expire old session activity', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const activityKey = `${NAMESPACE}:temp-activity:${testGroup}`;

      await redis.zadd(activityKey, Date.now() - 3600000, 'old-session');
      await redis.zadd(activityKey, Date.now(), 'new-session');

      const oneHourAgo = Date.now() - 3600000;
      await redis.zremrangebyscore(activityKey, 0, oneHourAgo);

      const remaining = await redis.zrange(activityKey, 0, -1);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toBe('new-session');
    }, 10000);
  });

  describe('Atomic State Updates', () => {
    it('should use MULTI/EXEC for atomic updates', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const stateKey = `${NAMESPACE}:atomic:${testGroup}`;

      const pipeline = redis.pipeline();
      pipeline.set(`${stateKey}:counter`, '0');
      pipeline.incr(`${stateKey}:counter`);
      pipeline.incr(`${stateKey}:counter`);
      pipeline.get(`${stateKey}:counter`);

      const results = await pipeline.exec();
      expect(results).toBeTruthy();
      expect(results![3][1]).toBe('2');
    }, 10000);

    it('should use WATCH for optimistic locking', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const stateKey = `${NAMESPACE}:locked:${testGroup}`;
      const key = `${stateKey}:balance`;

      await redis.set(key, '100');

      const maxRetries = 3;
      let success = false;

      for (let attempt = 0; attempt < maxRetries && !success; attempt++) {
        const watchKey = key;

        try {
          await redis.watch(watchKey);

          const current = await redis.get(watchKey);
          const newValue = parseInt(current || '0', 10) + 10;

          const multi = redis.multi();
          multi.set(watchKey, newValue.toString());
          const execResult = await multi.exec();

          if (execResult === null) {
            continue;
          }

          success = true;
        } finally {
          await redis.unwatch();
        }
      }

      expect(success).toBe(true);
    }, 10000);

    it('should use HSCAN for atomic hash updates', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const hashKey = `${NAMESPACE}:atomic-hash:${testGroup}`;

      await redis.del(hashKey);
      await redis.hset(hashKey, 'item1', '1');
      await redis.hset(hashKey, 'item2', '2');
      await redis.hset(hashKey, 'item3', '3');

      let cursor = 0;
      let totalCount = 0;

      do {
        const [newCursor, entries] = await redis.hscan(
          hashKey,
          cursor,
          'COUNT',
          10,
        );
        cursor = parseInt(newCursor, 10);
        totalCount += entries.length / 2;
      } while (cursor !== 0);

      expect(totalCount).toBe(3);
    }, 10000);

    it('should use Lua script for atomic read-modify-write', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const counterKey = `${NAMESPACE}:lua-counter:${testGroup}`;

      await redis.set(counterKey, '0');

      const incrementScript = `
        local current = redis.call('GET', KEYS[1])
        local newValue = tonumber(current) + 1
        redis.call('SET', KEYS[1], newValue)
        return newValue
      `;

      const result1 = await redis.eval(incrementScript, 1, counterKey);
      const result2 = await redis.eval(incrementScript, 1, counterKey);
      const result3 = await redis.eval(incrementScript, 1, counterKey);

      expect(parseInt(result1 as string, 10)).toBe(1);
      expect(parseInt(result2 as string, 10)).toBe(2);
      expect(parseInt(result3 as string, 10)).toBe(3);
    }, 10000);
  });

  describe('Group State Isolation', () => {
    it('should isolate state between groups using namespace', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const group1Key = `${NAMESPACE}:group:${testGroup}:state`;
      const group2Key = `${NAMESPACE}:group:${testGroup2}:state`;

      await redis.set(
        group1Key,
        JSON.stringify({ group: testGroup, value: 100 }),
      );
      await redis.set(
        group2Key,
        JSON.stringify({ group: testGroup2, value: 200 }),
      );

      const group1State = await redis.get(group1Key);
      const group2State = await redis.get(group2Key);

      expect(JSON.parse(group1State!).value).toBe(100);
      expect(JSON.parse(group2State!).value).toBe(200);
    }, 10000);

    it('should isolate hash state between groups', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const hash1Key = `${NAMESPACE}:data:${testGroup}`;
      const hash2Key = `${NAMESPACE}:data:${testGroup2}`;

      await redis.hset(hash1Key, 'key1', 'value1-group1');
      await redis.hset(hash2Key, 'key1', 'value1-group2');

      const val1 = await redis.hget(hash1Key, 'key1');
      const val2 = await redis.hset(hash2Key, 'key1', 'value1-group2-updated');

      const updatedVal2 = await redis.hget(hash2Key, 'key1');

      expect(val1).toBe('value1-group1');
      expect(updatedVal2).toBe('value1-group2-updated');

      const keys = await redis.keys(`${NAMESPACE}:data:*`);
      expect(keys.length).toBeGreaterThanOrEqual(2);
    }, 10000);

    it('should isolate sorted set activity between groups', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const activity1Key = `${NAMESPACE}:activity:${testGroup}`;
      const activity2Key = `${NAMESPACE}:activity:${testGroup2}`;

      await redis.zadd(activity1Key, Date.now(), 'user-a');
      await redis.zadd(activity1Key, Date.now() - 1000, 'user-b');

      await redis.zadd(activity2Key, Date.now(), 'user-c');
      await redis.zadd(activity2Key, Date.now() - 2000, 'user-d');

      const group1Activity = await redis.zrange(activity1Key, 0, -1);
      const group2Activity = await redis.zrange(activity2Key, 0, -1);

      expect(group1Activity).toContain('user-a');
      expect(group1Activity).not.toContain('user-c');
      expect(group2Activity).toContain('user-c');
      expect(group2Activity).not.toContain('user-a');
    }, 10000);

    it('should use separate keys for each group', async () => {
      if (!redis) {
        console.warn('⚠️  Redis not available, skipping test');
        return;
      }
      const group1StateKey = `${NAMESPACE}:group:${testGroup}`;
      const group2StateKey = `${NAMESPACE}:group:${testGroup2}`;
      const sessionKey1 = `${NAMESPACE}:session:${testGroup}`;
      const sessionKey2 = `${NAMESPACE}:session:${testGroup2}`;

      await redis.set(group1StateKey, 'state1');
      await redis.set(group2StateKey, 'state2');
      await redis.set(sessionKey1, 'session1');
      await redis.set(sessionKey2, 'session2');

      const allGroupKeys = await redis.keys(`${NAMESPACE}:group:*`);
      const allSessionKeys = await redis.keys(`${NAMESPACE}:session:*`);

      expect(allGroupKeys.length).toBeGreaterThanOrEqual(2);
      expect(allSessionKeys.length).toBeGreaterThanOrEqual(2);
    }, 10000);
  });

  describe('State Recovery After Redis Restart', () => {
    // ── Helpers ────────────────────────────────────────────────────────────

    /**
     * Run a kubectl command synchronously. Returns ok/stdout/stderr.
     * Uses the `kubeclaw` namespace by default (where the regular e2e suite
     * deploys Redis via global-setup.ts).
     */
    function kubectl(
      args: string[],
      opts: { timeout?: number } = {},
    ): { ok: boolean; stdout: string; stderr: string } {
      const r = spawnSync('kubectl', args, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: opts.timeout ?? 30_000,
      });
      return {
        ok: r.status === 0,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
      };
    }

    /**
     * Delete the Redis pod (by label selector) and wait for a new pod with
     * a different name to become Ready, or the timeout to expire.
     *
     * Returns true on success, false on timeout.
     *
     * The delete uses --wait=false so kubectl returns immediately; we then
     * poll for the new pod ourselves (same pattern as
     * minikube-live.test.ts:340-363 for the channel pod).
     */
    async function restartRedisPod(
      ns: string,
      timeoutMs = 120_000,
    ): Promise<boolean> {
      // Capture the old pod name so we can wait for a *different* pod to be Ready.
      const oldPodResult = kubectl([
        'get', 'pods', '-n', ns,
        '-l', 'app=kubeclaw-redis',
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]);
      const oldPodName = oldPodResult.stdout.trim();

      // Trigger the delete without waiting.
      const del = kubectl([
        'delete', 'pod', '-n', ns,
        '-l', 'app=kubeclaw-redis',
        '--wait=false',
      ]);
      if (!del.ok) {
        console.error(`kubectl delete pod failed: ${del.stderr}`);
        return false;
      }

      // Poll for a new pod (different name from oldPodName) with Ready=True.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = kubectl([
          'get', 'pods', '-n', ns,
          '-l', 'app=kubeclaw-redis',
          '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
        ]);
        if (r.ok) {
          const lines = r.stdout.trim().split('\n').filter(Boolean);
          const newReady = lines.some((line) => {
            const [name, ready] = line.split('\t');
            return name && name !== oldPodName && ready === 'True';
          });
          if (newReady) return true;
        }
        await new Promise((res) => setTimeout(res, 3_000));
      }
      return false;
    }

    /**
     * Poll the given Redis client with PING until it succeeds or the
     * timeout elapses.  The port-forward bash loop in global-setup
     * automatically reconnects to the new pod; ioredis's retryStrategy
     * handles the brief ECONNREFUSED window.  Returns true when reachable.
     */
    async function waitForRedisReachable(
      client: import('ioredis').Redis,
      timeoutMs = 60_000,
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const pong = await client.ping();
          if (pong === 'PONG') return true;
        } catch {
          // ECONNREFUSED / ECONNRESET — port-forward not yet reconnected
        }
        await new Promise((res) => setTimeout(res, 500));
      }
      return false;
    }

    // ── Tests ──────────────────────────────────────────────────────────────

    /**
     * AC 1 + AC 5 (AOF persistence):
     * Write several keys across different Redis data types, restart the
     * Redis pod via `kubectl delete pod`, wait for the replacement pod to
     * be Ready, wait for the port-forward + ioredis to reconnect, then
     * assert every key is still readable with its original value.
     *
     * AOF (append-only file) is enabled in the chart's Redis config; the
     * data-volume (PVC) is retained across pod restarts. If AOF were
     * disabled or the PVC lost, all keys would return nil after restart.
     */
    it(
      'AOF persistence: state survives Redis pod restart',
      async () => {
        if (!redis) {
          console.warn('⚠️  Redis not available, skipping test');
          return;
        }
        if (!isKubernetesAvailable()) {
          console.warn('⚠️  Kubernetes not available, skipping Redis restart test');
          return;
        }

        const ns = 'kubeclaw';

        // ── 1. Write state (string, hash, sorted-set) before restart ──────
        const strKey  = `${NAMESPACE}:rst:str:${testGroup}`;
        const hashKey = `${NAMESPACE}:rst:hash:${testGroup}`;
        const zsetKey = `${NAMESPACE}:rst:zset:${testGroup}`;

        const strValue = JSON.stringify({
          sessionId: 'aof-test-session',
          groupFolder: testGroup,
          savedAt: Date.now(),
        });
        await redis.set(strKey, strValue);

        const groupState: GroupState = {
          groupFolder: testGroup,
          name: 'AOF Test Group',
          triggerPattern: '/aof',
          registeredAt: Date.now(),
        };
        await redis.hset(hashKey, 'metadata', JSON.stringify(groupState));
        await redis.hset(hashKey, 'counter', '42');

        await redis.zadd(zsetKey, Date.now() - 2000, 'session-a');
        await redis.zadd(zsetKey, Date.now() - 1000, 'session-b');
        await redis.zadd(zsetKey, Date.now(),          'session-c');

        // Verify the writes landed before restarting.
        expect(await redis.get(strKey)).toBe(strValue);
        expect(await redis.hget(hashKey, 'counter')).toBe('42');
        expect(await redis.zcard(zsetKey)).toBe(3);

        // ── 2. Restart the Redis pod ───────────────────────────────────────
        const restarted = await restartRedisPod(ns, 120_000);
        expect(
          restarted,
          'Redis pod did not become Ready within 120 s after kubectl delete pod',
        ).toBe(true);

        // ── 3. Wait for ioredis to reconnect via the port-forward ──────────
        // The global-setup port-forward is a plain `kubectl port-forward svc/kubeclaw-redis`
        // that will reconnect on its own (svc endpoint switches to the new pod).
        // ioredis's built-in reconnection loop retries the TCP connect.
        const reconnected = await waitForRedisReachable(redis, 60_000);
        expect(
          reconnected,
          'ioredis did not reconnect to the restarted Redis within 60 s',
        ).toBe(true);

        // ── 4. Assert all state survived (AOF persistence) ─────────────────
        const recoveredStr = await redis.get(strKey);
        expect(recoveredStr, 'string key missing after Redis restart').not.toBeNull();
        const parsedStr = JSON.parse(recoveredStr!);
        expect(parsedStr.sessionId).toBe('aof-test-session');
        expect(parsedStr.groupFolder).toBe(testGroup);

        const recoveredMeta = await redis.hget(hashKey, 'metadata');
        expect(recoveredMeta, 'hash field "metadata" missing after Redis restart').not.toBeNull();
        const parsedMeta: GroupState = JSON.parse(recoveredMeta!);
        expect(parsedMeta.name).toBe('AOF Test Group');
        expect(parsedMeta.triggerPattern).toBe('/aof');

        const recoveredCounter = await redis.hget(hashKey, 'counter');
        expect(recoveredCounter, 'hash field "counter" missing after Redis restart').toBe('42');

        const recoveredSessions = await redis.zrevrange(zsetKey, 0, -1);
        expect(
          recoveredSessions,
          'sorted-set missing after Redis restart',
        ).toHaveLength(3);
        expect(recoveredSessions[0]).toBe('session-c');
        expect(recoveredSessions[2]).toBe('session-a');
      },
      180_000,
    );

    /**
     * AC 3 + AC 4 (ioredis retryStrategy):
     * Create a fresh ioredis client configured with an explicit retryStrategy
     * (exponential back-off, mirrors the pattern used by the orchestrator's
     * ipc-redis.ts). Write a key, restart the Redis pod, confirm the client
     * automatically reconnects via retryStrategy (without any process
     * restart), then assert the written key is still readable.
     *
     * A separate client is used so we can verify retryStrategy independently
     * of the shared test client's default config.
     */
    it(
      'ioredis retryStrategy: client reconnects automatically after Redis pod restart',
      async () => {
        if (!redis) {
          console.warn('⚠️  Redis not available, skipping test');
          return;
        }
        if (!isKubernetesAvailable()) {
          console.warn('⚠️  Kubernetes not available, skipping Redis restart test');
          return;
        }

        const ns = 'kubeclaw';
        const redisUrl = getRedisUrlForTests();

        // Open a dedicated client with an explicit retryStrategy so we can
        // assert that ioredis's reconnect path (not just the shared client's)
        // works after a pod restart.
        const retryClient = new Redis(redisUrl, {
          connectTimeout: 10_000,
          maxRetriesPerRequest: null, // no per-request limit — let retryStrategy drive
          retryStrategy: (times: number) => {
            // Exponential back-off: 200 ms, 400 ms, … capped at 3 s.
            // Same formula as orchestrator's ipc-redis.ts retryStrategy.
            return Math.min(times * 200, 3_000);
          },
          reconnectOnError: () => true,
        });

        try {
          // ── 1. Verify the client is live before restart ──────────────────
          await retryClient.ping();

          const retryKey = `${NAMESPACE}:rst:retry:${testGroup}`;
          const retryValue = JSON.stringify({
            testName: 'retryStrategy',
            groupFolder: testGroup,
            ts: Date.now(),
          });
          await retryClient.set(retryKey, retryValue);
          expect(await retryClient.get(retryKey)).toBe(retryValue);

          // ── 2. Restart the Redis pod ───────────────────────────────────
          const restarted = await restartRedisPod(ns, 120_000);
          expect(
            restarted,
            'Redis pod did not become Ready within 120 s after kubectl delete pod',
          ).toBe(true);

          // ── 3. Wait for retryClient to auto-reconnect ──────────────────
          // retryStrategy drives ioredis to keep retrying. We poll PING
          // via the same client — once it responds the reconnect succeeded.
          const reconnected = await waitForRedisReachable(retryClient, 60_000);
          expect(
            reconnected,
            'ioredis retryStrategy client did not reconnect within 60 s',
          ).toBe(true);

          // ── 4. Key is readable after reconnect (AOF + retryStrategy) ──
          const recovered = await retryClient.get(retryKey);
          expect(
            recovered,
            'key written before restart is missing after ioredis retryStrategy reconnect',
          ).toBe(retryValue);
          const parsedRetry = JSON.parse(recovered!);
          expect(parsedRetry.testName).toBe('retryStrategy');
          expect(parsedRetry.groupFolder).toBe(testGroup);
        } finally {
          // Clean up the dedicated client; ignore errors during shutdown.
          try {
            await retryClient.del(`${NAMESPACE}:rst:retry:${testGroup}`);
          } catch { /* best-effort */ }
          retryClient.disconnect();
        }
      },
      180_000,
    );

    /**
     * AC 2 (restart timing window):
     * Measures the wall-clock gap between the pod delete command and the
     * moment the shared ioredis client successfully responds to PING.
     * Asserts the reconnect window is within the configured connectTimeout
     * (120 s), confirming the platform SLA documented in the story.
     */
    it(
      'reconnect window is bounded: Redis reachable within 120 s of pod restart',
      async () => {
        if (!redis) {
          console.warn('⚠️  Redis not available, skipping test');
          return;
        }
        if (!isKubernetesAvailable()) {
          console.warn('⚠️  Kubernetes not available, skipping Redis restart test');
          return;
        }

        const ns = 'kubeclaw';
        const MAX_RECONNECT_MS = 120_000;

        // Write a canary value we can verify after reconnect.
        const canaryKey = `${NAMESPACE}:rst:canary:${testGroup}`;
        await redis.set(canaryKey, 'timing-canary');
        expect(await redis.get(canaryKey)).toBe('timing-canary');

        const deleteStart = Date.now();
        const restarted = await restartRedisPod(ns, MAX_RECONNECT_MS);
        expect(
          restarted,
          'Redis pod did not become Ready within 120 s after kubectl delete pod',
        ).toBe(true);

        const reconnected = await waitForRedisReachable(redis, MAX_RECONNECT_MS);
        const reconnectMs = Date.now() - deleteStart;

        expect(
          reconnected,
          `ioredis did not reconnect within ${MAX_RECONNECT_MS} ms after pod restart`,
        ).toBe(true);
        expect(
          reconnectMs,
          `reconnect took ${reconnectMs} ms, exceeded ${MAX_RECONNECT_MS} ms bound`,
        ).toBeLessThan(MAX_RECONNECT_MS);

        // Also verify the canary key survived (AOF).
        const canary = await redis.get(canaryKey);
        expect(canary, 'canary key missing after restart').toBe('timing-canary');
      },
      180_000,
    );
  });
});
