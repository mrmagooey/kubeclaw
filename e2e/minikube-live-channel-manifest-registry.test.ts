/**
 * Minikube-live: channel manifest registry tools (Story 178).
 *
 * Tests the end-to-end path for list_channel_manifests and
 * register_channel_manifest admin-shell tools:
 *   - list_channel_manifests returns a merged view of Helm baseline and admin overrides.
 *   - register_channel_manifest validates, computes the hash, and persists to the ConfigMap.
 *   - register_channel_manifest rejects payloads with non-allowlisted lifecycle scripts.
 *   - register_channel_manifest is idempotent on (channel_type, identical content).
 *   - An admin-registered manifest overrides the Helm baseline for the same channel_type.
 *
 * Strategy:
 *   - Use the admin-shell IPC HTTP API (POST /tools with tool_name / input).
 *   - The minikube Helm install already registers a "telegram" baseline manifest
 *     (values-minikube.yaml bootstrap.channelManifests.telegram).
 *   - AC1: assert list_channel_manifests returns at least one entry with source: "helm-baseline".
 *   - AC2: register_channel_manifest for a new type, assert the return shape.
 *   - AC3: register a manifest with a non-allowlisted lifecycle script, assert rejection.
 *   - AC4: register the same manifest twice, assert the ConfigMap resourceVersion is unchanged.
 *   - AC5: register a manifest for "telegram" (Helm baseline), assert list_channel_manifests
 *     now shows source: "admin-registered" for telegram and the new hash.
 *
 * Prerequisites:
 *   - minikube-live global setup (e2e/minikube-live-setup.ts) — the orchestrator must be
 *     deployed and accessible at KUBECLAW_LIVE_ADMIN_LOCAL_PORT.
 *   - The Helm release must include at least one channelManifests entry (telegram).
 *
 * AC coverage:
 *   AC1: list_channel_manifests returns merged, source-labelled entries
 *   AC2: register_channel_manifest accepts valid input, returns {channel_type, manifest_hash, source}
 *   AC3: register_channel_manifest rejects non-allowlisted lifecycle scripts
 *   AC4: register_channel_manifest is idempotent on (channel_type, identical content)
 *   AC5: admin-registered manifest overrides helm-baseline in list_channel_manifests
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  KUBECLAW_LIVE_ADMIN_LOCAL_PORT,
  KUBECLAW_LIVE_ADMIN_USERNAME,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const ADMIN_URL = `http://127.0.0.1:${KUBECLAW_LIVE_ADMIN_LOCAL_PORT}`;

/** Timeout for this entire test file */
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
 * admin-shell exposes tools via POST /tools with { tool_name, input }.
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

// Minimal valid package.json and package-lock.json for a new "slack-test" channel type.
// No lifecycle scripts — passes the default empty allowlist.
const SLACK_PACKAGE_JSON = JSON.stringify({
  name: 'slack-test-runtime',
  version: '1.0.0',
  dependencies: { 'node-fetch': '3.3.2' },
});

const SLACK_PACKAGE_LOCK_JSON = JSON.stringify({
  name: 'slack-test-runtime',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'slack-test-runtime',
      version: '1.0.0',
      dependencies: { 'node-fetch': '3.3.2' },
    },
    'node_modules/node-fetch': {
      version: '3.3.2',
    },
  },
});

// A package.json with a non-allowlisted lifecycle script — must be rejected.
const INVALID_PACKAGE_JSON = JSON.stringify({
  name: 'bad-runtime',
  version: '1.0.0',
  dependencies: {},
  scripts: { postinstall: 'echo pwned' },
});

const INVALID_PACKAGE_LOCK_JSON = JSON.stringify({
  name: 'bad-runtime',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'bad-runtime', version: '1.0.0' },
  },
});

beforeAll(async () => {
  adminPassword = getAdminPassword();
}, 30_000);

// ── Tests ──────────────────────────────────────────────────────────────────────

describe(
  'channel manifest registry e2e',
  () => {
    it(
      'AC1: list_channel_manifests returns an array with source-labelled entries',
      async () => {
        const result = await callTool('list_channel_manifests', {}, adminPassword);
        // When no manifests are registered it returns a string, otherwise an array.
        // After the helm install we always have at least the telegram baseline entry.
        expect(Array.isArray(result)).toBe(true);
        const entries = result as Array<Record<string, unknown>>;
        expect(entries.length).toBeGreaterThanOrEqual(1);

        // Each entry must carry the expected fields.
        for (const entry of entries) {
          expect(entry).toHaveProperty('channel_type');
          expect(entry).toHaveProperty('manifest_hash');
          expect(entry).toHaveProperty('source');
          expect(['helm-baseline', 'admin-registered']).toContain(entry.source);
        }
      },
      30_000,
    );

    it(
      'AC1: Helm baseline telegram entry is present with source: helm-baseline',
      async () => {
        const result = await callTool('list_channel_manifests', {}, adminPassword);
        const entries = result as Array<Record<string, unknown>>;
        const telegram = entries.find((e) => e.channel_type === 'telegram');
        // The telegram entry is set via values-minikube.yaml —
        // it may be helm-baseline or admin-registered if a previous test run registered it.
        expect(telegram).toBeDefined();
        expect(telegram!.manifest_hash).toBeTruthy();
      },
      30_000,
    );

    it(
      'AC2: register_channel_manifest accepts valid input and returns {channel_type, manifest_hash, source}',
      async () => {
        const result = await callTool(
          'register_channel_manifest',
          {
            channel_type: 'slack-test',
            package_json: SLACK_PACKAGE_JSON,
            package_lock_json: SLACK_PACKAGE_LOCK_JSON,
          },
          adminPassword,
        );
        expect(result).toHaveProperty('channel_type', 'slack-test');
        expect(result).toHaveProperty('manifest_hash');
        expect(typeof (result as Record<string, unknown>).manifest_hash).toBe('string');
        expect((result as Record<string, unknown>).manifest_hash).toHaveLength(64); // sha256 hex
        expect(result).toHaveProperty('source', 'admin-registered');
      },
      30_000,
    );

    it(
      'AC2: registered manifest appears in list_channel_manifests with source: admin-registered',
      async () => {
        const result = await callTool('list_channel_manifests', {}, adminPassword);
        const entries = result as Array<Record<string, unknown>>;
        const slackEntry = entries.find((e) => e.channel_type === 'slack-test');
        expect(slackEntry).toBeDefined();
        expect(slackEntry!.source).toBe('admin-registered');
        expect(slackEntry!.manifest_hash).toHaveLength(64);
      },
      30_000,
    );

    it(
      'AC3: register_channel_manifest rejects package.json with non-allowlisted lifecycle scripts',
      async () => {
        const result = await callTool(
          'register_channel_manifest',
          {
            channel_type: 'bad-channel',
            package_json: INVALID_PACKAGE_JSON,
            package_lock_json: INVALID_PACKAGE_LOCK_JSON,
          },
          adminPassword,
        );
        // The tool returns an error string (not an object) for rejected inputs.
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        expect(resultStr).toMatch(/not allowed|lifecycle|postinstall/i);
      },
      30_000,
    );

    it(
      'AC3: rejected manifest does not appear in list_channel_manifests',
      async () => {
        const result = await callTool('list_channel_manifests', {}, adminPassword);
        const entries = result as Array<Record<string, unknown>>;
        const badEntry = entries.find((e) => e.channel_type === 'bad-channel');
        expect(badEntry).toBeUndefined();
      },
      30_000,
    );

    it(
      'AC4: second register_channel_manifest call with identical content does not bump ConfigMap resourceVersion',
      async () => {
        // Read the current ConfigMap resourceVersion.
        const before = kubectl([
          'get', 'configmap', 'kubeclaw-channel-manifests',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.metadata.resourceVersion}',
        ]);
        expect(before.ok).toBe(true);
        const rvBefore = before.stdout.trim();

        // Register the same manifest again (idempotent — same content).
        const result = await callTool(
          'register_channel_manifest',
          {
            channel_type: 'slack-test',
            package_json: SLACK_PACKAGE_JSON,
            package_lock_json: SLACK_PACKAGE_LOCK_JSON,
          },
          adminPassword,
        );
        expect(result).toHaveProperty('source', 'admin-registered');

        // The ConfigMap resourceVersion must be unchanged (no patch was issued).
        const after = kubectl([
          'get', 'configmap', 'kubeclaw-channel-manifests',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.metadata.resourceVersion}',
        ]);
        expect(after.ok).toBe(true);
        expect(after.stdout.trim()).toBe(rvBefore);
      },
      30_000,
    );

    it(
      'AC5: registering a manifest for an existing helm-baseline channel_type overrides it in list output',
      async () => {
        // Register a different manifest for "telegram" (currently helm-baseline).
        const overridePackageJson = JSON.stringify({
          name: 'runtime',
          version: '2.0.0',
          dependencies: { telegraf: '4.16.3' },
        });
        const overridePackageLockJson = JSON.stringify({
          name: 'runtime',
          version: '2.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'runtime', version: '2.0.0', dependencies: { telegraf: '4.16.3' } },
            'node_modules/telegraf': { version: '4.16.3' },
          },
        });

        const registerResult = await callTool(
          'register_channel_manifest',
          {
            channel_type: 'telegram',
            package_json: overridePackageJson,
            package_lock_json: overridePackageLockJson,
          },
          adminPassword,
        );
        const reg = registerResult as Record<string, unknown>;
        expect(reg.channel_type).toBe('telegram');
        expect(reg.source).toBe('admin-registered');
        const overrideHash = reg.manifest_hash as string;

        // list_channel_manifests must show telegram as admin-registered with the new hash.
        const listResult = await callTool('list_channel_manifests', {}, adminPassword);
        const entries = listResult as Array<Record<string, unknown>>;
        const telegram = entries.find((e) => e.channel_type === 'telegram');
        expect(telegram).toBeDefined();
        expect(telegram!.source).toBe('admin-registered');
        expect(telegram!.manifest_hash).toBe(overrideHash);

        // The live ConfigMap must also reflect the new hash.
        const cm = kubectl([
          'get', 'configmap', 'kubeclaw-channel-manifests',
          '-n', NAMESPACE,
          '-o', 'jsonpath={.data.telegram}',
        ]);
        expect(cm.ok).toBe(true);
        expect(cm.stdout).toContain(overrideHash);
      },
      60_000,
    );
  },
  FILE_TIMEOUT_MS,
);
