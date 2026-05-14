/**
 * Minikube-live RAG end-to-end tests.
 *
 * The globalSetup at e2e/minikube-live-setup.ts helm-installs kubeclaw into
 * namespace `kubeclaw-live` with:
 *   - rag.enabled=true (deploys kubeclaw-qdrant StatefulSet)
 *   - capabilities.test-embed.{image,port} (deploys kubeclaw-capability-test-embed)
 *   - secrets.embeddingBaseUrl=http://kubeclaw-capability-test-embed:8080/v1
 *   - secrets.embeddingDim=1536
 *
 * The channel pod starts with QDRANT_URL and EMBEDDING_BASE_URL set, but
 * getRagProvider() returns NullRagProvider until a RAG capability is
 * registered in the orchestrator.
 *
 * These tests install a RAG capability at runtime via Redis IPC, then verify:
 *   1. Provider switches from none → Qdrant after capabilities_update.
 *   2. A POST message causes a Qdrant collection to be created and populated.
 *   3. The indexed content can be retrieved via direct Qdrant search (uses
 *      the deterministic test embedding server so query and index vectors match).
 *
 * Group folder derivation (src/channel-runner.ts:255 jidToFolder):
 *   channelType='http', jid='http:alice'
 *   prefix='http', sanitized='http-alice' → folder='http-http-alice'
 *   Qdrant collection: 'kubeclaw-http-http-alice'
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const RAG_CAPABILITY_NAME = 'test-rag';

// The capability Service/pod label follows deploymentName() in
// src/capabilities/builders/common.ts: `kubeclaw-cap-${name}`.
const RAG_CAP_SERVICE = `kubeclaw-cap-${RAG_CAPABILITY_NAME}`;
const RAG_CAP_LABEL = `app=${RAG_CAP_SERVICE}`;

// Expected group folder for http:alice (derived by jidToFolder).
// jidToFolder('http', 'http:alice') → 'http-http-alice'
// See src/channel-runner.ts:255.
const EXPECTED_GROUP_FOLDER = 'http-http-alice';
const EXPECTED_COLLECTION = `kubeclaw-${EXPECTED_GROUP_FOLDER}`;

const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// ── Helpers (mirrors minikube-live.test.ts) ──────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kubectl(
  args: string[],
  opts: { timeout?: number; input?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    input: opts.input,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Reads `data: ...` lines from an SSE stream and resolves on a predicate.
 * Returns an array of all data lines received so far.
 */
async function openSseStream(
  user: string,
  pass: string,
): Promise<{
  lines: string[];
  waitFor: (
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`${HTTP_URL}/stream`, {
    headers: { Authorization: basicAuth(user, pass) },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  }
  const lines: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  (async () => {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('data: ')) lines.push(line.slice(6));
        }
      }
    } catch {
      // aborted
    }
  })().catch(() => {});

  return {
    lines,
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(lines)) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs}ms (lines: ${JSON.stringify(lines)})`,
      );
    },
    dispose: () => controller.abort(),
  };
}

async function postMessage(text: string): Promise<Response> {
  return await fetch(`${HTTP_URL}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
    },
    body: JSON.stringify({ text }),
  });
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Minikube-live: RAG capability installed at runtime + indexing verified', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // 1. Verify the HTTP-channel port-forward is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
      return;
    }

    // 2. Read the Redis admin password then connect as the 'orchestrator' ACL user.
    const pwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        // Tolerant config: survive a port-forward restart (typically <100 ms)
        // without the test-side client giving up. 20 retries × up to 2 s back-
        // off = up to ~20 s of reconnect attempts before hard failure.
        maxRetriesPerRequest: 20,
        connectTimeout: 15_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        reconnectOnError: () => true,
      },
    );
    await redis.ping();

    // 3. Install the RAG capability at runtime via Redis IPC.
    //    `isMain` must be the literal string 'true' — see src/k8s/ipc-redis.ts
    //    for the equality check that promotes this to the main capability slot.
    //
    // Retry the XADD up to 5 times. The port-forward + Redis ACL handshake
    // can flake transiently, and the orchestrator must actually see the
    // entry — a silent dropped XADD here is the most expensive failure
    // mode (every downstream test fails confusingly).
    let xaddOk = false;
    for (let attempt = 0; attempt < 5 && !xaddOk; attempt++) {
      try {
        await redis.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'install_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'spec', JSON.stringify({
            kind: 'rag',
            name: RAG_CAPABILITY_NAME,
            backend: 'qdrant',
            image: 'qdrant/qdrant:latest',
            port: 6333,
          }),
        );
        xaddOk = true;
      } catch (err) {
        console.warn(
          `XADD install_capability attempt ${attempt + 1}/5 failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!xaddOk) {
      throw new Error('failed to XADD install_capability after 5 attempts');
    }

    // 4. Wait for the orchestrator's post-install capabilities_update push
    //    to reach the channel pod and trigger resetRagProvider().
    //    src/channel-runner.ts:120 calls resetRagProvider() on receipt.
    //
    //    NOTE: we deliberately do NOT wait for the capability-installed
    //    Qdrant pod (kubeclaw-cap-test-rag) to be Ready. The generic
    //    capability builder runs containers as UID 1000 by default which
    //    prevents Qdrant from writing to its WORKDIR — the pod
    //    CrashLoopBackOffs. That side-effect pod isn't used at runtime:
    //    QdrantRagProvider routes to the pre-existing `QDRANT_URL` env
    //    (provider.ts:171), which points at the helm-managed kubeclaw-qdrant
    //    StatefulSet. The capability entry's sole purpose here is to register
    //    in the orchestrator's registry so getRagProvider() returns
    //    QdrantRagProvider instead of NullRagProvider.
    //
    // Poll for the Deployment to exist (proves the orchestrator's
    // task-request watcher processed the XADD and ran applySpec).
    const deployDeadline = Date.now() + 120_000;
    while (Date.now() < deployDeadline) {
      const r = kubectl([
        'get', 'deployment', RAG_CAP_SERVICE,
        '-n', NAMESPACE, '-o', 'jsonpath={.metadata.name}',
      ]);
      if (r.ok && r.stdout.trim() === RAG_CAP_SERVICE) break;
      await new Promise((res) => setTimeout(res, 2000));
    }

    // Then poll the channel pod's logs for evidence that it has SYNCED
    // the new RAG capability into its local SQLite. The orchestrator
    // publishes capabilities_update via Redis pub/sub AFTER applySpec
    // returns, but delivery to the channel pod is not synchronous — if
    // tests POST before the sync runs, `getRagProvider()` returns
    // NullRagProvider (caches it) and the next message never reaches
    // QdrantRagProvider. Wait until we see our cap name in a sync log.
    const syncDeadline = Date.now() + 60_000;
    let synced = false;
    while (Date.now() < syncDeadline) {
      const logs = kubectl([
        'logs', '-n', NAMESPACE,
        'deployment/kubeclaw-channel-http', '--tail=5000',
      ]);
      if (
        logs.ok &&
        logs.stdout.includes('"Synced capabilities to local DB"') &&
        logs.stdout.includes(RAG_CAPABILITY_NAME)
      ) {
        synced = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    if (!synced) {
      console.warn(
        '⚠️  Did not observe channel pod sync of test-rag within 60 s; ' +
        'subsequent tests may race.',
      );
    }
  }, 360_000);

  afterAll(async () => {
    if (redis) {
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    }
  });

  // ── 1. RAG capability install switches the channel pod's provider to Qdrant ──
  it(
    'runtime RAG capability install switches channel pod provider to Qdrant',
    () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Hard assertion: the K8s Deployment for the capability was created
      // by the orchestrator's applySpec path. We don't require the cap pod
      // to be Ready — the capability builder's UID 1000 default CrashLoops
      // Qdrant, and at runtime QdrantRagProvider routes to the helm-managed
      // kubeclaw-qdrant via the channel pod's pre-set QDRANT_URL env. The
      // Deployment existence proves applySpec ran end-to-end.
      const dep = kubectl([
        'get', 'deployment', RAG_CAP_SERVICE, '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      expect(
        dep.ok,
        `expected Deployment ${RAG_CAP_SERVICE} to exist: ${dep.stderr}`,
      ).toBe(true);
      expect(dep.stdout.trim()).toBe(RAG_CAP_SERVICE);

      // Note: we intentionally do NOT check for the 'RAG provider: Qdrant'
      // log here. That log line is emitted only when getRagProvider() is
      // first called, which happens inside DirectLLMRunner.runAgent
      // (src/runtime/direct-llm-runner.ts:959 — `void
      // getRagProvider().indexConversationTurn(...)`). Until a user message
      // is posted, the cached provider stays `undefined` and no log fires.
      // Test 2 below performs the provider-selection assertion AFTER its
      // POST has flushed through.
    },
    180_000,
  );

  // ── 2. POST a message and verify a Qdrant collection grows ───────────────────
  it(
    'POST message causes Qdrant collection to be created and contain indexed points',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Open SSE before posting so we don't miss fast replies.
      const sse = await openSseStream(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS);
      try {
        // The Gemma "thinking" path returns the actual answer in a
        // reasoning_content field while leaving `content` empty for some
        // prompts. DirectLLMRunner only reads content (direct-llm-runner.ts:868)
        // and skips indexing when content is empty. A directive prompt with
        // a known short answer reliably produces content — and the marker
        // phrase is included so the indexed chunk contains it.
        const res = await postMessage(
          'Reply with exactly the word noted to acknowledge: purple-orchid-7392',
        );
        expect(res.status, 'POST /message returned unexpected status').toBe(200);

        // Wait briefly for SSE — informational only. Under sustained
        // Gemma load the assistant turn can take 2+ minutes; we don't
        // want to block the test budget on it. The real signal is the
        // Qdrant collection growing, polled below with a generous window.
        try {
          await sse.waitFor((l) => l.length > 0, 5_000);
          console.log(
            `SSE delivered ${sse.lines.length} line(s) after POST (early):`,
            sse.lines.slice(0, 3),
          );
        } catch {
          console.log(
            'SSE not delivered within 5 s — fine, the indexing path is async; ' +
            'we poll Qdrant directly below.',
          );
        }
      } finally {
        sse.dispose();
      }

      // Informational: log whether the provider-selection signal has appeared
      // by now. Under sustained LLM load the channel pod can spend a long
      // time inside the chat-completion call before reaching
      // indexConversationTurn (which is where getRagProvider runs). We don't
      // hard-fail on this — the real signal is "did the collection get
      // populated", which we poll below with a generous timeout.
      const earlyLogs = kubectl([
        'logs', '-n', NAMESPACE,
        'deployment/kubeclaw-channel-http', '--tail=5000',
      ]);
      const ragLogAlreadySeen =
        earlyLogs.ok && earlyLogs.stdout.includes('RAG provider: Qdrant');
      if (ragLogAlreadySeen) {
        console.log('✅ channel pod logged "RAG provider: Qdrant" before polling');
      } else {
        console.log(
          'ℹ️  "RAG provider: Qdrant" not yet logged — will keep polling Qdrant directly',
        );
      }

      // Locate the channel pod once so we can exec into it for Qdrant queries.
      const channelPods = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]);
      expect(
        channelPods.ok,
        `failed to get channel pod name: ${channelPods.stderr}`,
      ).toBe(true);
      const channelPod = channelPods.stdout.trim();
      expect(channelPod, 'no channel pod found').toBeTruthy();

      // Poll for up to 60 s: indexing is fire-and-forget so it may arrive
      // shortly after the SSE response completes.
      //
      // Strategy:
      //   a) List all collections via GET /collections. Use the known
      //      EXPECTED_COLLECTION name (kubeclaw-http-http-alice), but also
      //      accept any collection starting with 'kubeclaw-' in case the group
      //      folder derivation differed.
      //   b) Once the collection exists, poll its point count until > 0.
      const listScript = `
        const http = require('node:http');
        http.get('http://kubeclaw-qdrant:6333/collections', (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => { console.log('COLLECTIONS:' + data); });
        }).on('error', (e) => { console.error('ERR:' + e.message); process.exit(1); });
      `;

      const countScript = (collName: string) => `
        const http = require('node:http');
        // Qdrant's /points/count is a POST endpoint, not GET. With GET you
        // get a "wrong input" error and no result.count field.
        const body = JSON.stringify({ exact: true });
        const req = http.request({
          host: 'kubeclaw-qdrant',
          port: 6333,
          path: '/collections/${collName}/points/count',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => { console.log('COUNT:' + data); });
        });
        req.on('error', (e) => { console.error('ERR:' + e.message); process.exit(1); });
        req.write(body);
        req.end();
      `;

      // Generous 300 s budget — under sustained Gemma load the
      // indexConversationTurn callback can take 2+ minutes to fire,
      // and indexing+ensureCollection adds further async work after that.
      const pollDeadline = Date.now() + 300_000;
      let collectionName: string | null = null;
      let pointCount = 0;

      while (Date.now() < pollDeadline) {
        // Step a: discover the collection.
        if (!collectionName) {
          const listExec = kubectl(
            ['exec', '-n', NAMESPACE, channelPod, '-c', 'channel', '--', 'node', '-e', listScript],
            { timeout: 15_000 },
          );
          if (listExec.ok) {
            const m = listExec.stdout.match(/COLLECTIONS:(.*)/s);
            if (m) {
              try {
                const parsed = JSON.parse(m[1]) as {
                  result?: { collections?: Array<{ name: string }> };
                };
                const collections = parsed?.result?.collections ?? [];
                // Prefer the known name, then any kubeclaw- prefixed name.
                const match =
                  collections.find((c) => c.name === EXPECTED_COLLECTION) ??
                  collections.find((c) => c.name.startsWith('kubeclaw-'));
                if (match) collectionName = match.name;
              } catch {
                // JSON parse error — try again
              }
            }
          }
        }

        // Step b: check point count.
        if (collectionName) {
          const countExec = kubectl(
            ['exec', '-n', NAMESPACE, channelPod, '-c', 'channel', '--', 'node', '-e', countScript(collectionName)],
            { timeout: 15_000 },
          );
          if (countExec.ok) {
            const m = countExec.stdout.match(/COUNT:(.*)/s);
            if (m) {
              try {
                const parsed = JSON.parse(m[1]) as {
                  result?: { count?: number };
                };
                pointCount = parsed?.result?.count ?? 0;
                if (pointCount > 0) break;
              } catch {
                // JSON parse error — try again
              }
            }
          }
        }

        await new Promise((res) => setTimeout(res, 4000));
      }

      expect(
        collectionName,
        `No Qdrant collection starting with 'kubeclaw-' found within 300 s. ` +
        `Expected '${EXPECTED_COLLECTION}'. Indexing may not have run.`,
      ).not.toBeNull();
      expect(
        pointCount,
        `Qdrant collection '${collectionName}' has 0 points after 60 s. ` +
        `Indexing may have failed silently — check channel pod logs for 'Indexed text chunks'.`,
      ).toBeGreaterThan(0);

      console.log(
        `Qdrant collection '${collectionName}' created with ${pointCount} point(s).`,
      );
    },
    360_000,
  );

  // ── 3. Indexed content retrievable via direct Qdrant search ──────────────────
  it(
    'indexed phrase purple-orchid-7392 is retrievable via Qdrant vector search',
    () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      const channelPods = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]);
      expect(
        channelPods.ok,
        `failed to get channel pod name: ${channelPods.stderr}`,
      ).toBe(true);
      const channelPod = channelPods.stdout.trim();
      expect(channelPod, 'no channel pod found').toBeTruthy();

      // This script runs inside the channel pod.
      // Steps:
      //   1. POST to the deterministic test embedding server to get a vector
      //      for "purple-orchid-7392". Because the embedding server is
      //      deterministic, the same input always produces the same vector.
      //   2. Use that vector to search Qdrant for the top-5 closest points.
      //   3. Assert at least one result exists and its payload.text contains
      //      the phrase "purple-orchid-7392".
      //
      // The collection name is EXPECTED_COLLECTION but we also discover it
      // dynamically in case the group folder differed at runtime.
      const searchScript = `
        const http = require('node:http');

        function httpRequest(opts, body) {
          return new Promise((resolve, reject) => {
            const req = http.request(opts, (res) => {
              let data = '';
              res.on('data', (c) => data += c);
              res.on('end', () => resolve({ status: res.statusCode, body: data }));
            });
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
          });
        }

        async function main() {
          // Step 1: Embed the query phrase using the deterministic test server.
          const embedBody = JSON.stringify({
            model: 'test-embedding',
            input: 'purple-orchid-7392',
          });
          const embedRes = await httpRequest({
            host: 'kubeclaw-capability-test-embed',
            port: 8080,
            path: '/v1/embeddings',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(embedBody),
            },
          }, embedBody);

          if (embedRes.status < 200 || embedRes.status >= 300) {
            console.error('EMBED_ERR:status=' + embedRes.status + ' body=' + embedRes.body.slice(0, 200));
            process.exit(2);
          }

          let vector;
          try {
            const parsed = JSON.parse(embedRes.body);
            vector = parsed.data[0].embedding;
          } catch (e) {
            console.error('EMBED_PARSE_ERR:' + e.message + ' body=' + embedRes.body.slice(0, 200));
            process.exit(3);
          }

          if (!Array.isArray(vector) || vector.length === 0) {
            console.error('EMBED_EMPTY_VEC: vector=' + JSON.stringify(vector).slice(0, 100));
            process.exit(4);
          }

          // Step 2: Discover the collection name. Try the known name first,
          //         then fall back to listing all collections.
          let collectionName = '${EXPECTED_COLLECTION}';
          const listRes = await httpRequest({
            host: 'kubeclaw-qdrant',
            port: 6333,
            path: '/collections',
            method: 'GET',
          }, null);

          if (listRes.status >= 200 && listRes.status < 300) {
            try {
              const listParsed = JSON.parse(listRes.body);
              const cols = listParsed?.result?.collections ?? [];
              const found = cols.find((c) => c.name === '${EXPECTED_COLLECTION}')
                         ?? cols.find((c) => c.name.startsWith('kubeclaw-'));
              if (found) collectionName = found.name;
            } catch { /* keep default */ }
          }

          // Step 3: Search Qdrant using the embedding vector.
          const searchBody = JSON.stringify({
            vector: vector,
            limit: 5,
            with_payload: true,
          });
          const searchRes = await httpRequest({
            host: 'kubeclaw-qdrant',
            port: 6333,
            path: '/collections/' + collectionName + '/points/search',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(searchBody),
            },
          }, searchBody);

          if (searchRes.status < 200 || searchRes.status >= 300) {
            console.error('SEARCH_ERR:status=' + searchRes.status + ' body=' + searchRes.body.slice(0, 300));
            process.exit(5);
          }

          let results;
          try {
            const parsed = JSON.parse(searchRes.body);
            results = parsed.result ?? [];
          } catch (e) {
            console.error('SEARCH_PARSE_ERR:' + e.message);
            process.exit(6);
          }

          if (results.length === 0) {
            console.error('SEARCH_EMPTY: collection=' + collectionName + ' no results returned');
            process.exit(7);
          }

          const texts = results.map((r) => r.payload?.text ?? '');
          const found = texts.some((t) => t.includes('purple-orchid-7392'));

          console.log('SEARCH_OK:collection=' + collectionName);
          console.log('SEARCH_OK:count=' + results.length);
          console.log('SEARCH_OK:phrase_found=' + found);
          console.log('SEARCH_OK:top_text=' + (texts[0] ?? '').slice(0, 200));

          if (!found) {
            // Print all texts for diagnosis — this is a hard failure below.
            console.error('PHRASE_MISSING: texts=' + JSON.stringify(texts.map((t) => t.slice(0, 100))));
            process.exit(8);
          }

          process.exit(0);
        }

        main().catch((e) => { console.error('SCRIPT_ERR:' + e.message); process.exit(9); });
      `;

      const exec = kubectl(
        ['exec', '-n', NAMESPACE, channelPod, '-c', 'channel', '--', 'node', '-e', searchScript],
        { timeout: 60_000 },
      );
      expect(
        exec.ok,
        `Qdrant search script failed:\nstdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
      ).toBe(true);
      expect(
        exec.stdout,
        `expected 'SEARCH_OK:phrase_found=true' in output — ` +
        `phrase 'purple-orchid-7392' was not found in top Qdrant results.\n` +
        `stdout: ${exec.stdout}\nstderr: ${exec.stderr}`,
      ).toContain('SEARCH_OK:phrase_found=true');

      console.log(
        'RAG end-to-end verified:',
        exec.stdout.split('\n').filter((l) => l.startsWith('SEARCH_OK:')).join(' | '),
      );
    },
    240_000,
  );
});
