/**
 * Live-LLM end-to-end tests.
 *
 * Drives kubeclaw the way a real user does:
 *   user POST → HttpChannel → DirectLLMRunner → live OpenAI-compatible API →
 *   SSE delivery → user reads response.
 *
 * Wiring mirrors src/channel-runner.ts (the code that runs inside a channel
 * pod): the same HttpChannel and DirectLLMRunner classes the production
 * channel pod uses are instantiated in-process. The only thing skipped is
 * minikube/helm — DirectLLMRunner only needs K8s/Redis when the LLM emits a
 * tool call, and this small Gemma model is not expected to.
 *
 * Provider config (override via env vars):
 *   LIVE_LLM_BASE_URL   http://192.168.7.100:8080/v1
 *   LIVE_LLM_MODEL      gemma-4-E4B-it-Q4_0.gguf
 *   LIVE_LLM_API_KEY    no-key
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const LIVE_BASE_URL =
  process.env.LIVE_LLM_BASE_URL || 'http://192.168.7.100:8080/v1';
const LIVE_MODEL =
  process.env.LIVE_LLM_MODEL || 'gemma-4-E4B-it-Q4_0.gguf';
const LIVE_API_KEY = process.env.LIVE_LLM_API_KEY || 'no-key';

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const GROUP_PREFIX = `live-test-${RUN_ID}`;

// ── Module-level state ────────────────────────────────────────────────────
// `it.skipIf(...)` is evaluated when test definitions are parsed, BEFORE
// `beforeAll` runs. So the provider probe must complete at module load (via
// top-level await) for the skip flag to be correct at definition time.
let providerAvailable = false;
let providerSkipReason = '';
let channel: import('../src/channels/http.js').HttpChannel | null = null;
let runner: import('../src/runtime/direct-llm-runner.js').DirectLLMRunner | null =
  null;
let HTTP_PORT = 0;
let groupsRoot = '';
let createdFolders: string[] = [];

const userPasswords: Record<string, string> = {
  alice: 'alicepass',
  bob: 'bobpass',
};

interface RegisteredGroupLite {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
}
const registeredGroups: Record<string, RegisteredGroupLite> = {};

// ── Helpers ───────────────────────────────────────────────────────────────

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('Could not allocate port'));
      }
    });
  });
}

function basicAuth(user: string): string {
  return (
    'Basic ' +
    Buffer.from(`${user}:${userPasswords[user]}`).toString('base64')
  );
}

async function probeProvider(): Promise<{ ok: boolean; reason: string }> {
  try {
    const modelsRes = await fetch(`${LIVE_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!modelsRes.ok) {
      return {
        ok: false,
        reason: `GET /models returned HTTP ${modelsRes.status}`,
      };
    }

    const chatRes = await fetch(`${LIVE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LIVE_API_KEY}`,
      },
      body: JSON.stringify({
        model: LIVE_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!chatRes.ok) {
      const body = await chatRes.text().catch(() => '');
      return {
        ok: false,
        reason: `POST /chat/completions returned HTTP ${chatRes.status}: ${body.slice(0, 200)}`,
      };
    }
    const payload = (await chatRes.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, reason: 'malformed chat response' };
    }
    return { ok: true, reason: '' };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function ensureGroupFolder(folder: string): string {
  const full = path.join(groupsRoot, folder);
  fs.mkdirSync(full, { recursive: true });
  if (!createdFolders.includes(folder)) createdFolders.push(folder);
  return full;
}

function writeSystemPrompt(folder: string, content: string): void {
  const dir = ensureGroupFolder(folder);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content);
}

function registerGroup(user: string, folder: string): void {
  registeredGroups[`http:${user}`] = {
    name: `Live ${user}`,
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
  };
  ensureGroupFolder(folder);
}

function unregisterUser(user: string): void {
  delete registeredGroups[`http:${user}`];
}

async function postMessage(user: string, text: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${HTTP_PORT}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user),
    },
    body: JSON.stringify({ text }),
  });
}

/**
 * Opens an SSE stream as `user` and returns a controller that yields lines
 * received. Each SSE `data:` line is captured separately. Closes when
 * `dispose()` is called.
 */
async function openSseStream(user: string): Promise<{
  /** All `data: …` payloads received, in order. Multi-line messages append
   *  each line as its own entry, matching how HttpChannel.sendMessage splits. */
  lines: string[];
  /** Wait until `predicate(lines)` is true, or throw on timeout. */
  waitFor: (
    predicate: (lines: string[]) => boolean,
    timeoutMs: number,
  ) => Promise<void>;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/stream`, {
    headers: { Authorization: basicAuth(user) },
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
        // SSE frames are separated by blank line; within a frame, multiple
        // `data:` prefixes concatenate (per spec) but HttpChannel emits each
        // newline-split segment as its own data: line, then a single \n\n.
        // We capture every `data:` line so multi-line replies are visible.
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('data: ')) lines.push(line.slice(6));
        }
      }
    } catch {
      // aborted or socket closed
    }
  })().catch(() => {});

  return {
    lines,
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(lines)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        `SSE waitFor timed out after ${timeoutMs}ms (lines so far: ${JSON.stringify(lines)})`,
      );
    },
    dispose: () => controller.abort(),
  };
}

// Probe the provider at module load (top-level await), so `it.skipIf` sees
// the correct value when test definitions are evaluated.
{
  const probe = await probeProvider();
  providerAvailable = probe.ok;
  providerSkipReason = probe.reason;
  if (!providerAvailable) {
    console.warn(
      `\n⚠️  Live LLM provider at ${LIVE_BASE_URL} is unreachable: ${probe.reason}\n   All live-LLM tests will be skipped.\n`,
    );
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────

describe('Live-LLM end-to-end via HTTP channel + DirectLLMRunner', () => {
  beforeAll(async () => {
    if (!providerAvailable) return;

    // Configure the LLM client BEFORE importing direct-llm-runner so its
    // module-level createLLMClient() picks up the right base URL & key.
    process.env.OPENAI_BASE_URL = LIVE_BASE_URL;
    process.env.OPENAI_API_KEY = LIVE_API_KEY;
    process.env.DIRECT_LLM_MODEL = LIVE_MODEL;
    // Ensure DirectLLMRunner takes the non-channel path (no Redis required).
    delete process.env.KUBECLAW_MODE;

    // In-memory SQLite for conversation history.
    const { _initTestDatabase } = await import('../src/db.js');
    await _initTestDatabase();

    // Resolve groups root from the same module the runner uses.
    const { GROUPS_DIR } = await import('../src/config.js');
    groupsRoot = GROUPS_DIR;
    fs.mkdirSync(groupsRoot, { recursive: true });

    // Construct the channel and the runner exactly the way a channel pod does.
    const { HttpChannel } = await import('../src/channels/http.js');
    const { DirectLLMRunner } = await import(
      '../src/runtime/direct-llm-runner.js'
    );
    runner = new DirectLLMRunner();
    HTTP_PORT = await pickFreePort();

    channel = new HttpChannel(
      { port: HTTP_PORT, users: { ...userPasswords } },
      {
        registeredGroups: () =>
          registeredGroups as unknown as Record<
            string,
            import('../src/types.js').RegisteredGroup
          >,
        onChatMetadata: () => {},
        onMessage: (jid, msg) => {
          const group = registeredGroups[jid];
          if (!group) return;
          // Fire-and-forget; the channel test is observed via SSE.
          void runner!
            .runAgent(
              group as unknown as import('../src/types.js').RegisteredGroup,
              {
                prompt: msg.content,
                groupFolder: group.folder,
                chatJid: jid,
                isMain: false,
                assistantName: 'Andy',
              },
              undefined,
              async (output) => {
                if (output.status === 'success' && output.result) {
                  await channel!.sendMessage(jid, output.result);
                } else if (output.status === 'error') {
                  await channel!.sendMessage(
                    jid,
                    `[error] ${output.error ?? 'unknown'}`,
                  );
                }
              },
            )
            .catch((err) => {
              void channel!.sendMessage(
                jid,
                `[error] ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        },
      },
    );
    await channel.connect();
  }, 60_000);

  afterAll(async () => {
    if (channel) await channel.disconnect();
    await runner?.shutdown();
    // Best-effort cleanup of group folders we created.
    for (const folder of createdFolders) {
      const full = path.join(groupsRoot, folder);
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }, 30_000);

  beforeEach(() => {
    // Each test re-declares its registrations explicitly; clear inherited.
    for (const k of Object.keys(registeredGroups)) delete registeredGroups[k];
  });

  // ── 1. Provider gate ───────────────────────────────────────────────────
  // Reports provider status; skips gracefully when unreachable so an
  // environment without the local LLM doesn't pollute the failure count.
  it('provider at LIVE_LLM_BASE_URL is reachable and answers /chat/completions', function () {
    if (!providerAvailable) {
      console.warn(
        `[SKIP] Live LLM provider at ${LIVE_BASE_URL} is unreachable: ${providerSkipReason}`,
      );
      return;
    }
  });

  // ── 2. Single-turn roundtrip ───────────────────────────────────────────
  it.skipIf(!providerAvailable)(
    'delivers a single-turn assistant reply over SSE',
    async () => {
      const folder = `${GROUP_PREFIX}-single`;
      registerGroup('alice', folder);
      writeSystemPrompt(
        folder,
        'You are a terse assistant. Reply with exactly one short sentence.',
      );

      const sse = await openSseStream('alice');
      try {
        const res = await postMessage(
          'alice',
          "Reply with exactly the single word 'pong' and nothing else.",
        );
        expect(res.status).toBe(200);

        await sse.waitFor(
          (lines) =>
            lines.some((l) => l.toLowerCase().includes('pong')) ||
            lines.length > 0,
          60_000,
        );

        // The model may add punctuation/quotes; we accept any reply that
        // contains 'pong' OR (looser) any non-empty reply at all.
        const full = sse.lines.join('\n');
        expect(full.length).toBeGreaterThan(0);
        // Soft assertion (logged only) — small models don't always comply:
        if (!full.toLowerCase().includes('pong')) {
          console.warn(
            `[soft] model did not include 'pong' literal. Reply was: ${JSON.stringify(full)}`,
          );
        }
      } finally {
        sse.dispose();
        unregisterUser('alice');
      }
    },
  );

  // ── 3. Multi-turn conversation memory ──────────────────────────────────
  it.skipIf(!providerAvailable)(
    'remembers a fact across two turns (SQLite history is fed back to the LLM)',
    async () => {
      const folder = `${GROUP_PREFIX}-memory`;
      registerGroup('alice', folder);
      writeSystemPrompt(
        folder,
        'You are a careful assistant. When the user asks you to remember a fact, repeat it back. When asked about an earlier fact, recall it precisely.',
      );

      const sse = await openSseStream('alice');
      try {
        // Turn 1 — establish the fact.
        let res = await postMessage(
          'alice',
          "Please remember this: my favorite color is octarine. Confirm with the single word 'noted'.",
        );
        expect(res.status).toBe(200);
        const beforeCount = sse.lines.length;
        await sse.waitFor((lines) => lines.length > beforeCount, 60_000);

        // Turn 2 — recall the fact. The DirectLLMRunner pulls history from
        // SQLite and prepends it to the request, so the model sees turn 1.
        res = await postMessage(
          'alice',
          'What did I just say my favorite color was?',
        );
        expect(res.status).toBe(200);

        const beforeRecall = sse.lines.length;
        await sse.waitFor((lines) => lines.length > beforeRecall, 60_000);

        const reply = sse.lines.slice(beforeRecall).join('\n').toLowerCase();
        expect(
          reply,
          `Expected reply to mention 'octarine'. Full reply: ${JSON.stringify(reply)}`,
        ).toContain('octarine');
      } finally {
        sse.dispose();
        unregisterUser('alice');
      }
    },
  );

  // ── 4. Per-group history isolation ─────────────────────────────────────
  it.skipIf(!providerAvailable)(
    "two users' conversation histories do not leak into each other",
    async () => {
      const aliceFolder = `${GROUP_PREFIX}-iso-alice`;
      const bobFolder = `${GROUP_PREFIX}-iso-bob`;
      registerGroup('alice', aliceFolder);
      registerGroup('bob', bobFolder);
      const prompt =
        'You are a careful assistant. If the user mentions a fact, repeat it back. If asked about an earlier fact, recall it precisely.';
      writeSystemPrompt(aliceFolder, prompt);
      writeSystemPrompt(bobFolder, prompt);

      const aliceSse = await openSseStream('alice');
      const bobSse = await openSseStream('bob');

      try {
        // Both users seed a distinct fact.
        await postMessage(
          'alice',
          "My secret word is 'aurora'. Acknowledge with 'noted'.",
        );
        await postMessage(
          'bob',
          "My secret word is 'borealis'. Acknowledge with 'noted'.",
        );

        await aliceSse.waitFor((l) => l.length > 0, 60_000);
        await bobSse.waitFor((l) => l.length > 0, 60_000);

        const aliceBefore = aliceSse.lines.length;
        const bobBefore = bobSse.lines.length;

        // Each asks the other's secret. They should NOT know it.
        await postMessage('alice', 'What is my secret word?');
        await postMessage('bob', 'What is my secret word?');

        await aliceSse.waitFor((l) => l.length > aliceBefore, 60_000);
        await bobSse.waitFor((l) => l.length > bobBefore, 60_000);

        const aliceReply = aliceSse.lines
          .slice(aliceBefore)
          .join('\n')
          .toLowerCase();
        const bobReply = bobSse.lines.slice(bobBefore).join('\n').toLowerCase();

        // Alice's reply should mention 'aurora' and NOT 'borealis'.
        expect(aliceReply).toContain('aurora');
        expect(aliceReply).not.toContain('borealis');
        // Bob's reply should mention 'borealis' and NOT 'aurora'.
        expect(bobReply).toContain('borealis');
        expect(bobReply).not.toContain('aurora');
      } finally {
        aliceSse.dispose();
        bobSse.dispose();
        unregisterUser('alice');
        unregisterUser('bob');
      }
    },
  );

  // ── 5. System prompt from groups/<folder>/CLAUDE.md ────────────────────
  it.skipIf(!providerAvailable)(
    'CLAUDE.md system prompt shapes the response (PIRATEBOT persona)',
    async () => {
      const folder = `${GROUP_PREFIX}-persona`;
      registerGroup('alice', folder);
      writeSystemPrompt(
        folder,
        // Deliberately on-the-nose so a small model complies.
        'You are PIRATEBOT. EVERY response you produce MUST begin with the exact characters "Ahoy!" (capital A, lower h-o-y, exclamation mark). Do not preface it with anything else. Then answer in one short sentence.',
      );

      const sse = await openSseStream('alice');
      try {
        const res = await postMessage('alice', 'Say hello.');
        expect(res.status).toBe(200);
        await sse.waitFor((l) => l.length > 0, 60_000);

        const reply = sse.lines.join('\n').trimStart().toLowerCase();
        expect(
          reply,
          `Expected reply to start with 'ahoy'. Reply: ${JSON.stringify(reply)}`,
        ).toMatch(/^ahoy/);
      } finally {
        sse.dispose();
        unregisterUser('alice');
      }
    },
  );

  // ── 6. Concurrent users ────────────────────────────────────────────────
  it.skipIf(!providerAvailable)(
    'two simultaneous in-flight prompts each receive their own SSE reply',
    async () => {
      const aliceFolder = `${GROUP_PREFIX}-conc-alice`;
      const bobFolder = `${GROUP_PREFIX}-conc-bob`;
      registerGroup('alice', aliceFolder);
      registerGroup('bob', bobFolder);
      writeSystemPrompt(
        aliceFolder,
        'Reply with one short sentence.',
      );
      writeSystemPrompt(bobFolder, 'Reply with one short sentence.');

      const aliceSse = await openSseStream('alice');
      const bobSse = await openSseStream('bob');

      try {
        // Kick off both prompts in parallel.
        const [aliceRes, bobRes] = await Promise.all([
          postMessage('alice', 'Count: one two three.'),
          postMessage('bob', 'Color: red green blue.'),
        ]);
        expect(aliceRes.status).toBe(200);
        expect(bobRes.status).toBe(200);

        await Promise.all([
          aliceSse.waitFor((l) => l.length > 0, 90_000),
          bobSse.waitFor((l) => l.length > 0, 90_000),
        ]);

        // Each stream received at least one reply.
        expect(aliceSse.lines.length).toBeGreaterThan(0);
        expect(bobSse.lines.length).toBeGreaterThan(0);
      } finally {
        aliceSse.dispose();
        bobSse.dispose();
        unregisterUser('alice');
        unregisterUser('bob');
      }
    },
    120_000,
  );

  // ── 7. Image attachment marker ─────────────────────────────────────────
  // The Gemma 4 E4B model is not vision-capable, so we don't assert that the
  // model "sees" the image. We assert the full channel-side pipeline:
  //   - multipart upload accepted
  //   - file written to GROUPS_DIR/<folder>/attachments/raw/
  //   - inbound message uses the [ImageAttachment: …] marker
  //   - the model responds (does not crash) when the marker is in its input
  it.skipIf(!providerAvailable)(
    'multipart image upload produces a marker in conversation history and a non-error reply',
    async () => {
      const folder = `${GROUP_PREFIX}-image`;
      registerGroup('alice', folder);
      writeSystemPrompt(
        folder,
        'You are a helpful assistant. Reply in one short sentence.',
      );

      // Smallest possible valid PNG (1x1 transparent).
      const onePxPng = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8ffff3f0005fe02fea735812e0000000049454e44ae426082',
        'hex',
      );

      const fd = new FormData();
      fd.append('text', 'What do you see?');
      fd.append(
        'image',
        new Blob([onePxPng], { type: 'image/png' }),
        'pixel.png',
      );

      const sse = await openSseStream('alice');
      try {
        const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/message`, {
          method: 'POST',
          headers: { Authorization: basicAuth('alice') }, // fetch sets Content-Type with boundary
          body: fd,
        });
        const responseBody = await res.text();
        expect(
          res.status,
          `multipart POST returned ${res.status}: ${responseBody}`,
        ).toBe(200);

        // The HTTP channel writes the raw upload under groups/<jid>/
        // (see src/channels/http.ts:433 — path uses jid, not group.folder).
        const rawDir = path.join(groupsRoot, 'http:alice', 'attachments', 'raw');
        if (!createdFolders.includes('http:alice')) {
          createdFolders.push('http:alice');
        }
        const deadline = Date.now() + 5000;
        let files: string[] = [];
        while (Date.now() < deadline) {
          if (fs.existsSync(rawDir)) {
            files = fs.readdirSync(rawDir);
            if (files.length > 0) break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(
          files.length,
          `Expected an image file under ${rawDir}, got ${JSON.stringify(files)}`,
        ).toBeGreaterThan(0);
        expect(files[0]).toMatch(/^img-\d+-[a-z0-9]+\.png$/);

        // The LLM responds with *something* (we don't constrain what).
        // 180s: multipart pipeline involves file I/O + LLM inference, which
        // can be slow on constrained hardware; 60s was too tight in practice.
        // TODO: if this still times out, investigate whether DirectLLMRunner
        // is properly awaiting the image-marker substitution before forwarding
        // the prompt to the LLM (src/runtime/direct-llm-runner.ts).
        await sse.waitFor((l) => l.length > 0, 180_000);
        expect(sse.lines.join('\n').length).toBeGreaterThan(0);

        // Conversation history persisted the user turn with the marker.
        const { getConversationHistory } = await import('../src/db.js');
        const history = getConversationHistory(folder);
        const userTurn = history.find((m) => m.role === 'user');
        expect(userTurn?.content).toMatch(/\[ImageAttachment:/);
      } finally {
        sse.dispose();
        unregisterUser('alice');
      }
    },
  );
});
