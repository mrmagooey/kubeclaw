/**
 * Minikube-live RAG end-to-end tests.
 *
 * The globalSetup at e2e/minikube-live-setup.ts helm-installs kubeclaw into
 * namespace `kubeclaw-live` with:
 *   - capabilities.test-embed.{image,port} (deploys kubeclaw-capability-test-embed)
 *   - secrets.embeddingBaseUrl=http://kubeclaw-capability-test-embed:8080/v1
 *   - secrets.embeddingDim=1536
 *
 * RAG capability is installed at runtime via Redis IPC (no `rag.enabled` helm
 * flag, no StatefulSet). The install spec includes
 * `podSecurity: { fsGroup: 1000, runAsUser: 1000 }` so the Qdrant pod
 * actually becomes Ready (Qdrant requires write access to its WORKDIR, which
 * the generic capability builder's default UID 1000 grants when fsGroup is
 * also set).
 *
 * These tests verify:
 *   1. Test waits for the capability Qdrant pod to be Ready, then asserts the
 *      Deployment + Service exist and the pod is Ready.
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
            healthPath: '/healthz',
            storage: { sizeGi: 5, mountPath: '/qdrant/storage' },
            podSecurity: { fsGroup: 1000, runAsUser: 1000 },
            provider: {
              adapter: 'vector-store',
              embedding: {
                provider: 'openai',
                apiKeyEnv: 'OPENAI_API_KEY',
                baseUrl: 'http://kubeclaw-capability-test-embed:8080/v1',
                dim: 1536,
              },
            },
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

    // 4. Wait for the capability Qdrant pod to be Ready.
    //    podSecurity.fsGroup/runAsUser=1000 allows Qdrant to own its PVC, so
    //    the pod actually becomes Ready (unlike the old UID-1000 CrashLoop).
    const capReadyDeadline = Date.now() + 240_000;
    let capReady = false;
    while (Date.now() < capReadyDeadline) {
      const r = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', RAG_CAP_LABEL,
        '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      if (r.ok && r.stdout.trim() && r.stdout.trim().split(/\s+/).every((s) => s === 'True')) {
        capReady = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (!capReady) {
      console.warn(
        `⚠️  Capability Qdrant pod (${RAG_CAP_LABEL}) not Ready within 240 s; ` +
        'subsequent tests may fail if Qdrant is not available.',
      );
    }

    // 5. Wait for the channel pod to sync the new RAG capability.
    //    src/channel-runner.ts calls resetRagProvider() on receipt of capabilities_update.
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

  // ── 1. RAG capability install: cap pod Ready + Deployment + Service exist ─────
  it(
    'runtime RAG capability install: cap pod Ready and Deployment + Service exist',
    () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      const dep = kubectl([
        'get', 'deployment', RAG_CAP_SERVICE, '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      expect(dep.ok, `expected Deployment ${RAG_CAP_SERVICE} to exist: ${dep.stderr}`).toBe(true);
      expect(dep.stdout.trim()).toBe(RAG_CAP_SERVICE);

      const svc = kubectl([
        'get', 'service', RAG_CAP_SERVICE, '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      expect(svc.ok, `expected Service ${RAG_CAP_SERVICE} to exist: ${svc.stderr}`).toBe(true);
      expect(svc.stdout.trim()).toBe(RAG_CAP_SERVICE);

      // The pod must be Ready: podSecurity.fsGroup/runAsUser=1000 gives Qdrant
      // write access to its PVC so it starts cleanly (no CrashLoopBackOff).
      const podReady = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', RAG_CAP_LABEL,
        '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Ready")].status}',
      ]);
      const allReady = podReady.ok &&
        podReady.stdout.trim().length > 0 &&
        podReady.stdout.trim().split(/\s+/).every((s) => s === 'True');
      expect(allReady, `capability Qdrant pod not Ready: ${podReady.stdout}`).toBe(true);
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
        earlyLogs.ok && earlyLogs.stdout.includes('RAG provider: vector-store');
      if (ragLogAlreadySeen) {
        console.log('✅ channel pod logged "RAG provider: vector-store" before polling');
      } else {
        console.log(
          'ℹ️  "RAG provider: vector-store" not yet logged — will keep polling Qdrant directly',
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
        http.get('http://${RAG_CAP_SERVICE}:6333/collections', (res) => {
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
          host: '${RAG_CAP_SERVICE}',
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
    'indexed phrase purple-orchid-7392 is retrievable via Qdrant vector search (reads from the capability Qdrant service)',
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
      //   2. Use that vector to search the capability Qdrant service for the top-5 closest points.
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
          //         Reads from the capability Qdrant service (not a helm StatefulSet).
          let collectionName = '${EXPECTED_COLLECTION}';
          const listRes = await httpRequest({
            host: '${RAG_CAP_SERVICE}',
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
            host: '${RAG_CAP_SERVICE}',
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

      // Assert the retrieval path was used: channel pod should have logged the RAG provider name.
      const channelLogs = kubectl([
        'logs', '-n', NAMESPACE, 'deployment/kubeclaw-channel-http', '--tail=5000',
      ]);
      expect(
        channelLogs.ok && channelLogs.stdout.includes('RAG provider: vector-store'),
        `expected channel pod to log 'RAG provider: vector-store' confirming retrieval was wired; ` +
        `got: ${channelLogs.stdout.slice(-500)}`,
      ).toBe(true);

      console.log(
        'RAG end-to-end verified:',
        exec.stdout.split('\n').filter((l) => l.startsWith('SEARCH_OK:')).join(' | '),
      );
    },
    240_000,
  );
});
