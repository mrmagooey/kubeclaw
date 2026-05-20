/**
 * Integration tests for per-group capability provisioning.
 *
 * These tests exercise provisionCapability / listGroupCapabilities /
 * removeCapabilityInstance against the real SQLite schema (in-memory) and
 * a FakePerGroupK8sClient so no K8s cluster is needed.
 *
 * Tests mirror AC1–AC5 from Story 36.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { FakePerGroupK8sClient } from './k8s-client.js';
import {
  provisionCapability,
  listGroupCapabilities,
  removeCapabilityInstance,
  type ProvisionDeps,
} from './provision.js';
import { getInstance, listInstances } from './db.js';
import type { CapabilitySpec } from '../capabilities/types.js';

// Echo capability spec (same shape as the echo builder produces)
const echoSpec: CapabilitySpec = {
  kind: 'http',
  name: 'echo',
  image: 'kubeclaw-echo:e2e-test',
  scope: 'group',
  scaleDownAfterIdleSeconds: 120,
  volumeFromGroupPvc: false,
  credentialsFrom: 'none',
  port: 3000,
};

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
});

function makeDeps(
  client: FakePerGroupK8sClient,
  specs: CapabilitySpec[] = [echoSpec],
): ProvisionDeps {
  return {
    client,
    namespace: 'kubeclaw-test',
    groupsPvcName: 'test-groups-pvc',
    listSpecs: () => specs,
  };
}

// ── AC1: provision creates Deployment + DB row ─────────────────────────────

describe('provisionCapability — AC1: creates Deployment, Service, NetworkPolicy and DB row', () => {
  it('creates K8s objects and a SQLite instance row on first call', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    const result = await provisionCapability('http-http-alice', 'echo', deps);

    expect(result.ok).toBe(true);
    expect(result.deploymentName).toBeTruthy();
    expect(result.deploymentName).toMatch(/^mcp-echo-/);
    expect(result.message).toMatch(/provisioned/i);
    expect(result.alreadyProvisioned).toBeFalsy();

    // K8s objects created
    expect(client.store.deployments.size).toBe(1);
    expect(client.store.services.size).toBe(1);
    expect(client.store.policies.size).toBe(1);

    // DB row created
    const inst = getInstance('http-http-alice', 'echo');
    expect(inst).toBeTruthy();
    expect(inst!.deploymentName).toBe(result.deploymentName);
    expect(inst!.groupFolder).toBe('http-http-alice');
    expect(inst!.capabilityName).toBe('echo');
  });

  it('returns error for unknown capability type', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    const result = await provisionCapability('http-http-alice', 'nonexistent', deps);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Unknown capability type/i);
    expect(client.store.deployments.size).toBe(0);
  });

  it('returns error for cluster-scoped specs (not available for per-group provisioning)', async () => {
    const clusterSpec: CapabilitySpec = {
      kind: 'mcp',
      name: 'docling',
      image: 'docling:1',
      // no scope field → defaults to 'cluster'
    };
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client, [clusterSpec]);

    const result = await provisionCapability('http-http-alice', 'docling', deps);

    expect(result.ok).toBe(false);
    expect(client.store.deployments.size).toBe(0);
  });
});

// ── AC3: idempotency — second add returns alreadyProvisioned ───────────────

describe('provisionCapability — AC3: idempotent second call', () => {
  it('returns alreadyProvisioned:true and original deploymentName on second call', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    const first = await provisionCapability('http-http-alice', 'echo', deps);
    expect(first.ok).toBe(true);

    const second = await provisionCapability('http-http-alice', 'echo', deps);
    expect(second.ok).toBe(true);
    expect(second.alreadyProvisioned).toBe(true);
    expect(second.deploymentName).toBe(first.deploymentName);

    // K8s client should only have been called once (no duplicate apply)
    expect(client.store.deployments.size).toBe(1);
  });

  it('metadata.uid is not bumped by second call (K8s apply-idempotency via FakeClient)', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    await provisionCapability('http-http-alice', 'echo', deps);
    const depBefore = [...client.store.deployments.values()][0];
    const uidBefore = depBefore.metadata?.uid;

    await provisionCapability('http-http-alice', 'echo', deps);
    const depAfter = [...client.store.deployments.values()][0];
    const uidAfter = depAfter.metadata?.uid;

    // FakeClient stores by key — same object, no second create
    expect(client.store.deployments.size).toBe(1);
    // uid is unchanged (undefined in FakeClient, but consistent)
    expect(uidBefore).toBe(uidAfter);
  });
});

// ── AC2: list returns type, replicas, lastUsedAt, scaleDownAfterIdleSeconds ─

describe('listGroupCapabilities — AC2: returns typed list', () => {
  it('returns empty array when no capabilities provisioned', () => {
    const deps = makeDeps(new FakePerGroupK8sClient());
    const entries = listGroupCapabilities('http-http-alice', deps);
    expect(entries).toEqual([]);
  });

  it('returns instance with correct fields after provisioning', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    await provisionCapability('http-http-alice', 'echo', deps);
    const entries = listGroupCapabilities('http-http-alice', deps);

    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.type).toBe('echo');
    expect(e.deploymentName).toMatch(/^mcp-echo-/);
    expect(e.replicas).toBe(0);
    expect(e.lastUsedAt).toBeNull(); // newly provisioned — never used
    expect(e.scaleDownAfterIdleSeconds).toBe(120);
  });

  it('lastUsedAt is a number (unix seconds) when set', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    await provisionCapability('http-http-alice', 'echo', deps);

    // Manually touch last_used_at via db helper to simulate activity
    const { touchLastUsed } = await import('./db.js');
    const nowUnix = Math.floor(Date.now() / 1000);
    touchLastUsed('http-http-alice', 'echo', nowUnix);

    const entries = listGroupCapabilities('http-http-alice', deps);
    expect(entries[0].lastUsedAt).toBe(nowUnix);
    // Verify this converts cleanly to ISO-8601
    const iso = new Date(entries[0].lastUsedAt! * 1000).toISOString();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── AC5: per-group isolation — alice's capabilities not visible to bob ─────

describe('listGroupCapabilities — AC5: per-group isolation', () => {
  it('returns only the requesting group\'s capabilities', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    // Provision echo for alice
    await provisionCapability('http-http-alice', 'echo', deps);

    // Alice sees her capability
    const aliceEntries = listGroupCapabilities('http-http-alice', deps);
    expect(aliceEntries).toHaveLength(1);
    expect(aliceEntries[0].type).toBe('echo');

    // Bob sees nothing — even though alice's Deployment exists
    const bobEntries = listGroupCapabilities('http-http-bob', deps);
    expect(bobEntries).toHaveLength(0);
  });
});

// ── AC4: remove deletes Deployment and DB row ──────────────────────────────

describe('removeCapabilityInstance — AC4: removes K8s resources and DB row', () => {
  it('deletes K8s objects by label and removes SQLite row', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    // Provision first
    const addResult = await provisionCapability('http-http-alice', 'echo', deps);
    expect(addResult.ok).toBe(true);
    expect(client.store.deployments.size).toBe(1);
    expect(getInstance('http-http-alice', 'echo')).toBeTruthy();

    // Remove
    const removeResult = await removeCapabilityInstance('http-http-alice', 'echo', deps);

    expect(removeResult.ok).toBe(true);
    expect(removeResult.message).toMatch(/removed/i);

    // K8s objects deleted
    expect(client.store.deployments.size).toBe(0);
    expect(client.store.services.size).toBe(0);
    expect(client.store.policies.size).toBe(0);

    // DB row deleted
    expect(getInstance('http-http-alice', 'echo')).toBeNull();
    expect(listInstances('http-http-alice')).toHaveLength(0);
  });

  it('returns ok:false when capability is not provisioned', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    const result = await removeCapabilityInstance('http-http-alice', 'echo', deps);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not provisioned/i);
  });

  it('does not remove another group\'s capability', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    // Provision echo for alice
    await provisionCapability('http-http-alice', 'echo', deps);

    // Bob tries to remove — should fail (not provisioned for bob)
    const result = await removeCapabilityInstance('http-http-bob', 'echo', deps);
    expect(result.ok).toBe(false);

    // Alice's capability should still exist
    expect(getInstance('http-http-alice', 'echo')).toBeTruthy();
    expect(client.store.deployments.size).toBe(1);
  });
});

// ── IPC handler envelope tests (capability label selector correctness) ──────

describe('provisionCapability — label selector scoping', () => {
  it('deployment label kubeclaw.io/capability matches the capability type', async () => {
    const client = new FakePerGroupK8sClient();
    const deps = makeDeps(client);

    await provisionCapability('http-http-alice', 'echo', deps);

    const dep = [...client.store.deployments.values()][0];
    expect(dep.metadata?.labels?.['kubeclaw.io/capability']).toBe('echo');
    expect(dep.metadata?.labels?.['kubeclaw.io/scope']).toBe('group');
  });
});
