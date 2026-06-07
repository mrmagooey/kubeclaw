/**
 * Minikube-live: bootstrap skill registry tools (Story 179).
 *
 * Tests the end-to-end path for list_bootstrap_skills, register_bootstrap_skill,
 * and remove_bootstrap_skill admin-shell tools:
 *   - list_bootstrap_skills returns a merged, source-labelled view (AC1).
 *   - register_bootstrap_skill validates frontmatter and persists on success (AC2).
 *   - register_bootstrap_skill rejects malformed frontmatter with a precise error (AC3).
 *   - register_bootstrap_skill is idempotent on (name, identical content) (AC4).
 *   - remove_bootstrap_skill removes admin entries, refuses baseline, is idempotent (AC5).
 *
 * Strategy:
 *   - Use the admin-shell IPC HTTP API (POST /tools with { tool_name, input }).
 *   - The Helm baseline contains at least the "bootstrap-http-echo" skill
 *     (installed via --set-file bootstrap.skills.bootstrap-http-echo in minikube-live-setup.ts).
 *   - AC1: call list_bootstrap_skills — at least one baseline entry expected.
 *   - AC2: register a valid skill for the "http-echo" channel type (has a known manifest).
 *   - AC3: attempt registrations with each category of frontmatter error — assert rejection.
 *   - AC4: re-register the same skill, assert ConfigMap resourceVersion unchanged.
 *   - AC5: remove the admin-registered skill (removed), remove again (already absent),
 *     attempt to remove the Helm baseline skill (PROTECTED_BASELINE), confirm baseline persists.
 *
 * Prerequisites:
 *   - minikube-live global setup — orchestrator deployed at KUBECLAW_LIVE_ADMIN_LOCAL_PORT.
 *   - At least one Helm baseline skill ("bootstrap-http-echo") and at least one Helm baseline
 *     manifest ("http-echo") must exist so AC3(d) cross-validation has something to check against.
 *
 * AC coverage:
 *   AC1: list_bootstrap_skills returns merged, source-labelled entries
 *   AC2: register_bootstrap_skill accepts valid frontmatter, returns {name, content_hash, source}
 *   AC3(a-f): register_bootstrap_skill rejects each category of frontmatter error
 *   AC4: register_bootstrap_skill is idempotent on (name, identical content)
 *   AC5: remove_bootstrap_skill removes/refuses/is-idempotent per spec
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;

/** Timeout for the entire file */
const FILE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function getAdminPassword(): string {
  const r = spawnSync(
    'kubectl',
    [
      'get', 'secret', 'kubeclaw-admin-password',
      '-n', NAMESPACE,
      '-o', 'jsonpath={.data.password}',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
  );
  if (r.status !== 0) throw new Error('Could not fetch admin password: ' + r.stderr);
  return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
}

function kubectl(
  args: string[],
  opts: { timeout?: number; allowFail?: boolean } = {},
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
 * POST to the admin-shell tools endpoint and return the parsed JSON response.
 */
async function callTool(
  toolName: string,
  input: Record<string, unknown>,
  adminPassword: string,
): Promise<unknown> {
  const resp = await fetch(`${ADMIN_URL}/tools`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: basicAuth(KUBECLAW_LIVE_ADMIN_USERNAME, adminPassword),
    },
    body: JSON.stringify({ tool_name: toolName, input }),
  });
  if (!resp.ok) {
    throw new Error(`/tools returned ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

// ── Test state ─────────────────────────────────────────────────────────────────

let adminPassword: string;

/**
 * A valid bootstrap skill for the "http-echo" channel type.
 * The channel type and manifestVersion must match a known entry in
 * kubeclaw-channel-manifests (http-echo, version 1.0.0 — set via Helm).
 */
const VALID_SKILL_NAME = 'e2e-test-bootstrap-http-echo-v2';
const VALID_SKILL_MARKDOWN = `---
name: ${VALID_SKILL_NAME}
description: E2E test bootstrap skill for http-echo channel
bootstrap:
  channelType: http-echo
  manifestVersion: "1.0.0"
  expectedQuestions:
    - "What port should the HTTP echo server listen on?"
---

This is a synthetic bootstrap skill registered by the e2e test suite.
It is not intended to be run against a real cluster.
`;

beforeAll(async () => {
  adminPassword = getAdminPassword();
}, 30_000);

// ── Tests ──────────────────────────────────────────────────────────────────────

describe(
  'bootstrap skill registry e2e',
  () => {
    it(
      'AC1: list_bootstrap_skills returns an array with source-labelled entries',
      async () => {
        const result = await callTool('list_bootstrap_skills', {}, adminPassword);
        // Returns an array when skills exist, or a string "No bootstrap skills registered."
        expect(Array.isArray(result)).toBe(true);
        const entries = result as Array<Record<string, unknown>>;
        expect(entries.length).toBeGreaterThanOrEqual(1);

        for (const entry of entries) {
          expect(entry).toHaveProperty('name');
          expect(entry).toHaveProperty('content_hash');
          expect(entry).toHaveProperty('source');
          expect(['helm-baseline', 'admin-registered']).toContain(entry.source);
        }
      },
      30_000,
    );

    it(
      'AC1: Helm baseline bootstrap-http-echo skill is present with source: helm-baseline',
      async () => {
        const result = await callTool('list_bootstrap_skills', {}, adminPassword);
        const entries = result as Array<Record<string, unknown>>;
        const baseline = entries.find((e) => e.name === 'bootstrap-http-echo');
        expect(baseline).toBeDefined();
        expect(baseline!.source).toBe('helm-baseline');
        expect(baseline!.content_hash).toBeTruthy();
      },
      30_000,
    );

    it(
      'AC2: register_bootstrap_skill accepts valid frontmatter, returns {name, content_hash, source}',
      async () => {
        const result = await callTool(
          'register_bootstrap_skill',
          { name: VALID_SKILL_NAME, markdown: VALID_SKILL_MARKDOWN },
          adminPassword,
        );
        expect(result).toHaveProperty('name', VALID_SKILL_NAME);
        expect(result).toHaveProperty('content_hash');
        expect(typeof (result as Record<string, unknown>).content_hash).toBe('string');
        expect((result as Record<string, unknown>).content_hash).toHaveLength(64);
        expect(result).toHaveProperty('source', 'admin-registered');
      },
      30_000,
    );

    it(
      'AC2: registered skill appears in list_bootstrap_skills with source: admin-registered',
      async () => {
        const result = await callTool('list_bootstrap_skills', {}, adminPassword);
        const entries = result as Array<Record<string, unknown>>;
        const entry = entries.find((e) => e.name === VALID_SKILL_NAME);
        expect(entry).toBeDefined();
        expect(entry!.source).toBe('admin-registered');
        expect(entry!.channel_type).toBe('http-echo');
      },
      30_000,
    );

    it(
      'AC3(a): register_bootstrap_skill rejects when frontmatter name does not match argument',
      async () => {
        const badMarkdown = `---
name: some-other-name
description: A skill with mismatched name
bootstrap:
  channelType: http-echo
  manifestVersion: "1.0.0"
  expectedQuestions:
    - "Question?"
---
Body.
`;
        const result = await callTool(
          'register_bootstrap_skill',
          { name: VALID_SKILL_NAME, markdown: badMarkdown },
          adminPassword,
        );
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        expect(resultStr).toMatch(/frontmatter name mismatch|name.*mismatch/i);
      },
      30_000,
    );

    it(
      'AC3(b): register_bootstrap_skill rejects when description is missing',
      async () => {
        const badMarkdown = `---
name: ${VALID_SKILL_NAME}
bootstrap:
  channelType: http-echo
  manifestVersion: "1.0.0"
  expectedQuestions:
    - "Question?"
---
Body.
`;
        const result = await callTool(
          'register_bootstrap_skill',
          { name: VALID_SKILL_NAME, markdown: badMarkdown },
          adminPassword,
        );
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        expect(resultStr).toMatch(/description/i);
      },
      30_000,
    );

    it(
      'AC3(c): register_bootstrap_skill rejects when bootstrap.channelType is missing',
      async () => {
        const badMarkdown = `---
name: ${VALID_SKILL_NAME}
description: Valid description
bootstrap:
  manifestVersion: "1.0.0"
  expectedQuestions:
    - "Question?"
---
Body.
`;
        const result = await callTool(
          'register_bootstrap_skill',
          { name: VALID_SKILL_NAME, markdown: badMarkdown },
          adminPassword,
        );
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        expect(resultStr).toMatch(/channelType|channel.*type/i);
      },
      30_000,
    );

    it(
      'AC3(d): register_bootstrap_skill rejects when bootstrap.manifestVersion does not match any registered manifest',
      async () => {
        const badMarkdown = `---
name: ${VALID_SKILL_NAME}
description: Valid description
bootstrap:
  channelType: telegramm
  manifestVersion: "1.0.0"
  expectedQuestions:
    - "Question?"
---
Body.
`;
        const result = await callTool(
          'register_bootstrap_skill',
          { name: VALID_SKILL_NAME, markdown: badMarkdown },
          adminPassword,
        );
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        expect(resultStr).toMatch(/manifestVersion|manifest.*version|channelType=telegramm/i);

        // Crucial AC3 assertion: the typo skill must NOT appear in the ConfigMap.
        const cm = kubectl([
          'get', 'configmap', 'kubeclaw-bootstrap-skills',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.data}',
        ], { allowFail: true });
        // The bad name/content must not be present.
        expect(cm.stdout).not.toContain('channelType: telegramm');
      },
      30_000,
    );

    it(
      'AC3(e): register_bootstrap_skill rejects when bootstrap.expectedQuestions is missing or empty',
      async () => {
        const badMarkdown = `---
name: ${VALID_SKILL_NAME}
description: Valid description
bootstrap:
  channelType: http-echo
  manifestVersion: "1.0.0"
  expectedQuestions: []
---
Body.
`;
        const result = await callTool(
          'register_bootstrap_skill',
          { name: VALID_SKILL_NAME, markdown: badMarkdown },
          adminPassword,
        );
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        expect(resultStr).toMatch(/expectedQuestions/i);
      },
      30_000,
    );

    it(
      'AC4: second register_bootstrap_skill with identical content does not bump ConfigMap resourceVersion',
      async () => {
        // Read the current ConfigMap resourceVersion.
        const before = kubectl([
          'get', 'configmap', 'kubeclaw-bootstrap-skills',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.metadata.resourceVersion}',
        ]);
        expect(before.ok).toBe(true);
        const rvBefore = before.stdout.trim();

        // Register the same skill again (same content → idempotent short-circuit).
        const result = await callTool(
          'register_bootstrap_skill',
          { name: VALID_SKILL_NAME, markdown: VALID_SKILL_MARKDOWN },
          adminPassword,
        );
        expect(result).toHaveProperty('source', 'admin-registered');

        // ConfigMap resourceVersion must be unchanged.
        const after = kubectl([
          'get', 'configmap', 'kubeclaw-bootstrap-skills',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.metadata.resourceVersion}',
        ]);
        expect(after.ok).toBe(true);
        expect(after.stdout.trim()).toBe(rvBefore);
      },
      30_000,
    );

    it(
      'AC4: second register_bootstrap_skill with different content bumps ConfigMap resourceVersion',
      async () => {
        const before = kubectl([
          'get', 'configmap', 'kubeclaw-bootstrap-skills',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.metadata.resourceVersion}',
        ]);
        expect(before.ok).toBe(true);
        const rvBefore = before.stdout.trim();

        const updatedMarkdown = VALID_SKILL_MARKDOWN + '\n<!-- updated -->\n';
        const result = await callTool(
          'register_bootstrap_skill',
          { name: VALID_SKILL_NAME, markdown: updatedMarkdown },
          adminPassword,
        );
        const reg = result as Record<string, unknown>;
        expect(reg.source).toBe('admin-registered');

        const after = kubectl([
          'get', 'configmap', 'kubeclaw-bootstrap-skills',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.metadata.resourceVersion}',
        ]);
        expect(after.ok).toBe(true);
        // resourceVersion must have changed because the content changed.
        expect(after.stdout.trim()).not.toBe(rvBefore);
      },
      30_000,
    );

    it(
      'AC5: remove_bootstrap_skill returns status: removed for an admin-registered skill',
      async () => {
        const result = await callTool(
          'remove_bootstrap_skill',
          { name: VALID_SKILL_NAME },
          adminPassword,
        );
        expect(result).toHaveProperty('name', VALID_SKILL_NAME);
        expect(result).toHaveProperty('status', 'removed');

        // Skill must no longer appear in list_bootstrap_skills as admin-registered.
        const listResult = await callTool('list_bootstrap_skills', {}, adminPassword);
        const entries = Array.isArray(listResult)
          ? (listResult as Array<Record<string, unknown>>)
          : [];
        const found = entries.find(
          (e) => e.name === VALID_SKILL_NAME && e.source === 'admin-registered',
        );
        expect(found).toBeUndefined();
      },
      30_000,
    );

    it(
      'AC5: remove_bootstrap_skill returns status: already absent on second removal',
      async () => {
        const result = await callTool(
          'remove_bootstrap_skill',
          { name: VALID_SKILL_NAME },
          adminPassword,
        );
        expect(result).toHaveProperty('name', VALID_SKILL_NAME);
        expect(result).toHaveProperty('status', 'already absent');
      },
      30_000,
    );

    it(
      'AC5: remove_bootstrap_skill returns PROTECTED_BASELINE for a Helm baseline skill',
      async () => {
        const result = await callTool(
          'remove_bootstrap_skill',
          { name: 'bootstrap-http-echo' },
          adminPassword,
        );
        const res = result as Record<string, unknown>;
        expect(res.code).toBe('PROTECTED_BASELINE');
        expect(res.source).toBe('helm-baseline');
        expect(res.name).toBe('bootstrap-http-echo');

        // The baseline skill must still appear in the ConfigMap.
        const cm = kubectl([
          'get', 'configmap', 'kubeclaw-bootstrap-skills',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.data.bootstrap-http-echo}',
        ], { allowFail: true });
        expect(cm.stdout.trim().length).toBeGreaterThan(0);
      },
      30_000,
    );
  },
  FILE_TIMEOUT_MS,
);
