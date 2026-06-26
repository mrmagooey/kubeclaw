import { describe, it, expect } from 'vitest';
import { FakePerGroupK8sClient } from './k8s-client.js';
import {
  setGroupCredential,
  unsetGroupCredential,
  ensureGroupMcpToken,
} from './credentials.js';
import { credsSecretName } from './k8s-objects.js';
import { groupHash } from './hash.js';

describe('setGroupCredential', () => {
  it('creates a Secret with the env key/value', async () => {
    const c = new FakePerGroupK8sClient();
    await setGroupCredential({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'github',
      envName: 'GITHUB_TOKEN',
      value: 'ghp_xxx',
    });
    const name = credsSecretName('github', groupHash('Family'));
    const sec = await c.readSecret('kubeclaw', name);
    expect(sec).not.toBeNull();
    expect(sec?.data?.GITHUB_TOKEN).toBe(
      Buffer.from('ghp_xxx').toString('base64'),
    );
  });

  it('merges multiple keys into the same Secret', async () => {
    const c = new FakePerGroupK8sClient();
    await setGroupCredential({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'github',
      envName: 'A',
      value: '1',
    });
    await setGroupCredential({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'github',
      envName: 'B',
      value: '2',
    });
    const name = credsSecretName('github', groupHash('Family'));
    const sec = await c.readSecret('kubeclaw', name);
    expect(Object.keys(sec?.data ?? {}).sort()).toEqual(['A', 'B']);
  });
});

describe('unsetGroupCredential', () => {
  it('removes a single key and keeps the others', async () => {
    const c = new FakePerGroupK8sClient();
    await setGroupCredential({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'github',
      envName: 'A',
      value: '1',
    });
    await setGroupCredential({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'github',
      envName: 'B',
      value: '2',
    });
    await unsetGroupCredential({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'github',
      envName: 'A',
    });
    const name = credsSecretName('github', groupHash('Family'));
    const sec = await c.readSecret('kubeclaw', name);
    expect(Object.keys(sec?.data ?? {})).toEqual(['B']);
  });

  it('deletes the Secret when all keys are unset', async () => {
    const c = new FakePerGroupK8sClient();
    await setGroupCredential({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'github',
      envName: 'A',
      value: '1',
    });
    await unsetGroupCredential({
      client: c,
      namespace: 'kubeclaw',
      groupFolder: 'Family',
      capabilityName: 'github',
      envName: 'A',
    });
    const name = credsSecretName('github', groupHash('Family'));
    expect(await c.readSecret('kubeclaw', name)).toBeNull();
  });
});

describe('ensureGroupMcpToken', () => {
  it('generates once and is idempotent', async () => {
    const client = new FakePerGroupK8sClient();
    const a = await ensureGroupMcpToken({
      client,
      namespace: 'kubeclaw',
      groupFolder: 'alice',
      capabilityName: 'database',
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const b = await ensureGroupMcpToken({
      client,
      namespace: 'kubeclaw',
      groupFolder: 'alice',
      capabilityName: 'database',
    });
    expect(b).toBe(a); // idempotent — same token returned
  });
});
