/**
 * e2e tests for Story 12: User reviews and manages the assistant's learned skills
 * via the /skills chat command.
 *
 * Acceptance criteria:
 *  AC1. POST /message containing `/skills review` — with at least one candidate injected
 *       directly into the channel pod's _candidates dir — returns an SSE reply that shows
 *       the candidate's name, description, and body, and includes the accept/reject prompt
 *       with the candidate id.
 *  AC2. POST /message containing `/skills accept <candidate-id>` moves the candidate to
 *       the accepted skills directory — verified by checking that
 *       `groups/<group>/skills/<name>.md` exists and
 *       `groups/<group>/skills/_candidates/<id>.md` is absent after the command.
 *  AC3. After accepting in AC2, POST /message containing `/skills list` returns an SSE
 *       reply that includes the accepted skill's name and description.
 *  AC4. POST /message containing `/skills reject <nonexistent-id>` returns an SSE reply
 *       that contains "Could not reject" — confirming graceful error handling.
 *  AC5. POST /message containing `/skills disable <name>` for an accepted skill moves it
 *       to _archive/ — verified by checking that the accepted file is absent and the
 *       archive file exists.
 *
 * LLM-independent — /skills is intercepted in channel-runner.ts before the LLM queue.
 *
 * Prerequisites:
 *  - minikube cluster (context: minikube)
 *  - kubeclaw-orchestrator:e2e-test image loaded into kind
 *  - KUBECLAW_SKIP_HELM_INSTALL=true (prevent global-setup from racing this install)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';

const NS = 'kubeclaw-e2e-skills';
const RELEASE = 'ke2e-skills';
const CONTEXT = 'kind-kubeclaw-e2e-istio';
const LOCAL_PORT = 14097;
const HTTP_PORT = 4080; // channel pod's httpPort (default)

// Users
const ALICE_USER = 'alice';
const ALICE_PASS = 'alicepw';

// The group folder for alice via HTTP channel:
//   jidToFolder("http", "http:alice") → prefix "http", sanitize "http:alice" → "http-alice" → "http-http-alice"
const ALICE_GROUP_FOLDER = 'http-http-alice';

// Skills directories inside the channel pod
const GROUPS_BASE = '/app/groups';
const SKILLS_DIR = `${GROUPS_BASE}/${ALICE_GROUP_FOLDER}/skills`;
const CANDIDATES_DIR = `${SKILLS_DIR}/_candidates`;
const ARCHIVE_DIR = `${SKILLS_DIR}/_archive`;

// Skill used in AC1 through AC5
const SKILL_NAME = 'e2e-test-skill';
const SKILL_DESCRIPTION = 'E2E smoke skill for Story 12';
const SKILL_BODY = 'Always greet with "hello from e2e skill".';

// Timeouts
const INSTALL_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;
const SSE_REPLY_TIMEOUT_MS = 20_000;

let portForwardProc: ChildProcess | null = null;
// Candidate id written in AC1 setup, reused in AC2
let candidateId = '';

// ── Helpers ───────────────────────────────────────────────────────────────────

function kube(args: string, opts?: { allowFail?: boolean }): string {
  try {
    return execSync(
      `kubectl --context ${CONTEXT} --namespace ${NS} ${args}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch (e: any) {
    if (opts?.allowFail) return (e.stdout ?? '').trim();
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * POST a message to the channel via the forwarded port and return the HTTP status.
 */
async function postMessage(user: string, pass: string, text: string): Promise<number> {
  const res = await fetch(`http://localhost:${LOCAL_PORT}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(user, pass),
    },
    body: JSON.stringify({ text }),
  });
  return res.status;
}

/**
 * Start an SSE listener, then POST a message, wait for matching reply, stop.
 * Returns { status, replyLines }.
 */
async function sendAndCollect(
  user: string,
  pass: string,
  text: string,
  matcher: (lines: string[]) => boolean,
  timeoutMs = SSE_REPLY_TIMEOUT_MS,
): Promise<{ status: number; replyLines: string[] }> {
  const controller = new AbortController();
  const sseLines: string[] = [];
  let done = false;

  // Start SSE listener BEFORE POST so we do not miss the reply
  const ssePromise = fetch(`http://localhost:${LOCAL_PORT}/stream`, {
    headers: { Authorization: basicAuth(user, pass) },
    signal: controller.signal,
  }).then(async (res) => {
    if (res.status !== 200) return;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            sseLines.push(line.slice(6));
          }
        }
      }
    } catch {
      // AbortError expected on cleanup
    }
  });

  // Give SSE time to connect before sending POST
  await sleep(500);

  const status = await postMessage(user, pass, text);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (matcher(sseLines)) break;
    await sleep(300);
  }

  done = true;
  controller.abort();
  await ssePromise.catch(() => {});

  return { status, replyLines: sseLines };
}

/**
 * Wait until the port-forward is accepting connections.
 */
async function waitForPortForward(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${LOCAL_PORT}/`, {
        signal: AbortSignal.timeout(2000),
        headers: { Authorization: basicAuth('probe', 'x') },
      });
      if (res.status > 0) return;
    } catch {
      // Not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`Port-forward to localhost:${LOCAL_PORT} not ready after ${timeoutMs}ms`);
}

/**
 * Kill any stale process on LOCAL_PORT, then start a fresh port-forward to the channel pod.
 */
async function startPortForward(): Promise<ChildProcess> {
  execSync(`fuser -k ${LOCAL_PORT}/tcp 2>/dev/null || true`, { shell: true });
  await sleep(1000);

  const channelPodName = kube(
    `get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`,
  );

  const pf = spawn(
    'kubectl',
    [
      '--context', CONTEXT,
      '--namespace', NS,
      'port-forward',
      `pod/${channelPodName}`,
      `${LOCAL_PORT}:${HTTP_PORT}`,
    ],
    { stdio: 'ignore', detached: false },
  );

  await waitForPortForward(30_000);
  return pf;
}

/**
 * Get the channel pod name.
 */
function getChannelPodName(): string {
  return kube(`get pod -l app=kubeclaw-channel-http -o jsonpath={.items[0].metadata.name}`);
}

/**
 * Write a skill candidate file directly into the channel pod's _candidates dir.
 * Uses base64 encoding to safely pass content with quotes through sh layers.
 * Returns the candidate id (filename stem, without .md).
 */
function writeSkillCandidate(
  podName: string,
  name: string,
  description: string,
  body: string,
): string {
  // Build the YAML frontmatter + body
  const now = new Date().toISOString().split('T')[0];
  const fileContent = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `created: ${now}`,
    `source: e2e`,
    '---',
    '',
    body,
    '',
  ].join('\n');

  // Use a timestamp-based id that matches the skill-store convention
  const id = `${Date.now()}-e2eid-${name}`;

  // Encode content as base64 to safely pass through shell quoting
  const b64 = Buffer.from(fileContent).toString('base64');

  const result = spawnSync(
    'kubectl',
    [
      '--context', CONTEXT,
      '-n', NS,
      'exec',
      `pod/${podName}`,
      '--',
      'sh', '-c',
      `mkdir -p ${CANDIDATES_DIR} && echo ${b64} | base64 -d > ${CANDIDATES_DIR}/${id}.md`,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
  );

  if (result.status !== 0) {
    throw new Error(
      `writeSkillCandidate failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  return id;
}

/**
 * Check whether a file exists inside the channel pod.
 * Returns true if exit code 0, false if non-zero.
 */
function podFileExists(podName: string, filePath: string): boolean {
  const result = spawnSync(
    'kubectl',
    [
      '--context', CONTEXT,
      '-n', NS,
      'exec',
      `pod/${podName}`,
      '--',
      'ls', filePath,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
  );
  return result.status === 0;
}

// ── Skip guard ────────────────────────────────────────────────────────────────

const clusterReachable = (() => {
  try {
    execSync(`kubectl --context ${CONTEXT} cluster-info`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════════════

describe.skipIf(!clusterReachable)(
  '/skills slash command end-to-end (Story 12)',
  { timeout: INSTALL_TIMEOUT },
  () => {
    let installed = false;

    beforeAll(async () => {
      // Clean up any previous run
      execSync(
        `kubectl --context ${CONTEXT} delete namespace ${NS} --ignore-not-found --timeout=60s`,
        { stdio: 'pipe' },
      );
      // Wait for namespace termination
      for (let i = 0; i < 30; i++) {
        try {
          execSync(`kubectl --context ${CONTEXT} get namespace ${NS}`, { stdio: 'pipe' });
          await sleep(2000);
        } catch {
          break; // namespace gone
        }
      }

      // Write a values file — single-user, HTTP channel, credential injection off.
      const valuesDir = mkdtempSync(path.join(tmpdir(), 'ke2e-skills-'));
      const valuesFile = path.join(valuesDir, 'values.yaml');
      writeFileSync(
        valuesFile,
        [
          `namespace: ${NS}`,
          `image:`,
          `  tag: e2e-test`,
          `  pullPolicy: IfNotPresent`,
          `credentialInjection:`,
          `  mode: "off"`,
          `  broker:`,
          `    image: kubeclaw-orchestrator:e2e-test`,
          `orchestrator:`,
          `  replicas: 1`,
          `channels:`,
          `  http:`,
          `    enabled: true`,
          `    type: http`,
          `    httpPort: ${HTTP_PORT}`,
          `    envVars:`,
          `      - name: HTTP_CHANNEL_USERS`,
          `        key: users`,
          `secrets:`,
          `  httpChannelUsers: "${ALICE_USER}:${ALICE_PASS}"`,
          `networkPolicy:`,
          `  enabled: false`,
        ].join('\n'),
      );

      try {
        execSync(
          [
            `helm --kube-context ${CONTEXT} upgrade --install ${RELEASE} ./helm/kubeclaw`,
            `--namespace ${NS} --create-namespace`,
            `-f ${valuesFile}`,
          ].join(' '),
          { stdio: 'inherit', timeout: 120_000 },
        );
      } finally {
        rmSync(valuesDir, { recursive: true, force: true });
      }
      installed = true;

      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-orchestrator -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );
      execSync(
        `kubectl --context ${CONTEXT} rollout status deployment/kubeclaw-channel-http -n ${NS} --timeout=180s`,
        { stdio: 'inherit' },
      );

      portForwardProc = await startPortForward();

      // Give services a moment to be fully ready
      await sleep(3000);

      // Seed the candidate file that AC1 and AC2 depend on
      const podName = getChannelPodName();
      candidateId = writeSkillCandidate(
        podName,
        SKILL_NAME,
        SKILL_DESCRIPTION,
        SKILL_BODY,
      );
    }, INSTALL_TIMEOUT);

    afterAll(() => {
      if (portForwardProc) {
        portForwardProc.kill();
        portForwardProc = null;
      }
      if (installed) {
        execSync(
          `helm --kube-context ${CONTEXT} uninstall ${RELEASE} -n ${NS} 2>/dev/null || true`,
          { stdio: 'pipe' },
        );
        execSync(
          `kubectl --context ${CONTEXT} delete namespace ${NS} --wait=false 2>/dev/null || true`,
          { stdio: 'pipe' },
        );
      }
    }, 60_000);

    // ── AC1: /skills review shows candidate with accept/reject prompt ─────────

    it(
      'AC1: /skills review returns candidate name, description, body and accept/reject prompt',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/skills review',
          // Matcher: reply must mention "accept" (part of the accept/reject prompt)
          (lines) => lines.some((l) => l.toLowerCase().includes('accept')),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');

        expect(replyText, `Reply must contain skill name "${SKILL_NAME}"`).toContain(SKILL_NAME);
        expect(replyText, `Reply must contain skill description "${SKILL_DESCRIPTION}"`).toContain(
          SKILL_DESCRIPTION,
        );
        expect(replyText, 'Reply must contain the candidate id').toContain(candidateId);
        expect(replyText, 'Reply must contain accept/reject prompt').toMatch(/accept/i);
      },
      TEST_TIMEOUT,
    );

    // ── AC2: /skills accept moves candidate to accepted dir ───────────────────

    it(
      'AC2: /skills accept <id> moves candidate to accepted dir; candidate file is removed',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/skills accept ${candidateId}`,
          (lines) => lines.some((l) => l.toLowerCase().includes('accepted')),
        );

        expect(status, 'POST /message must return 200').toBe(200);
        expect(
          replyLines.join('\n').toLowerCase(),
          'Reply must confirm candidate was accepted',
        ).toMatch(/accepted/i);

        const podName = getChannelPodName();

        // Accepted skill file must exist
        const acceptedPath = `${SKILLS_DIR}/${SKILL_NAME}.md`;
        expect(
          podFileExists(podName, acceptedPath),
          `Accepted skill file ${acceptedPath} must exist`,
        ).toBe(true);

        // Candidate file must be gone
        const candidatePath = `${CANDIDATES_DIR}/${candidateId}.md`;
        expect(
          podFileExists(podName, candidatePath),
          `Candidate file ${candidatePath} must be absent after accept`,
        ).toBe(false);
      },
      TEST_TIMEOUT,
    );

    // ── AC3: /skills list shows accepted skill ────────────────────────────────

    it(
      'AC3: /skills list after accept includes the accepted skill name and description',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          '/skills list',
          (lines) => lines.some((l) => l.includes(SKILL_NAME)),
        );

        expect(status, 'POST /message must return 200').toBe(200);

        const replyText = replyLines.join('\n');
        expect(replyText, `Reply must contain accepted skill name "${SKILL_NAME}"`).toContain(
          SKILL_NAME,
        );
        expect(
          replyText,
          `Reply must contain accepted skill description "${SKILL_DESCRIPTION}"`,
        ).toContain(SKILL_DESCRIPTION);
      },
      TEST_TIMEOUT,
    );

    // ── AC4: /skills reject <nonexistent-id> returns graceful error ───────────

    it(
      'AC4: /skills reject <nonexistent-id> returns graceful error containing "Could not reject"',
      async () => {
        const bogusId = `nonexistent-e2e-id-${Date.now()}`;

        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/skills reject ${bogusId}`,
          // Matcher: reply must contain "Could not reject" or similar error phrase
          (lines) =>
            lines.some(
              (l) =>
                l.toLowerCase().includes('could not reject') ||
                l.toLowerCase().includes('not found'),
            ),
        );

        expect(status, 'POST /message must return 200').toBe(200);
        expect(
          replyLines.join('\n').toLowerCase(),
          'Reply must contain graceful error message',
        ).toMatch(/could not reject|not found/i);
      },
      TEST_TIMEOUT,
    );

    // ── AC5: /skills disable moves accepted skill to _archive/ ────────────────

    it(
      'AC5: /skills disable <name> moves accepted skill to _archive/; accepted file is absent',
      async () => {
        const { status, replyLines } = await sendAndCollect(
          ALICE_USER,
          ALICE_PASS,
          `/skills disable ${SKILL_NAME}`,
          (lines) => lines.some((l) => l.toLowerCase().includes('disabled')),
        );

        expect(status, 'POST /message must return 200').toBe(200);
        expect(
          replyLines.join('\n').toLowerCase(),
          'Reply must confirm skill was disabled',
        ).toMatch(/disabled/i);

        const podName = getChannelPodName();

        // Accepted skill file must be gone
        const acceptedPath = `${SKILLS_DIR}/${SKILL_NAME}.md`;
        expect(
          podFileExists(podName, acceptedPath),
          `Accepted skill file ${acceptedPath} must be absent after disable`,
        ).toBe(false);

        // Archive file must exist
        const archivePath = `${ARCHIVE_DIR}/${SKILL_NAME}.md`;
        expect(
          podFileExists(podName, archivePath),
          `Archive file ${archivePath} must exist after disable`,
        ).toBe(true);
      },
      TEST_TIMEOUT,
    );
  },
);
