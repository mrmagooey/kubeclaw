import { describe, it, expect } from 'vitest';
import { FakePerGroupK8sClient } from './k8s-client.js';
import { ensureGroupDbCredentials } from './provision-credentials.js';
import { setGroupCredential } from './credentials.js';
import { credsSecretName } from './k8s-objects.js';
import { groupHash } from './hash.js';

describe('ensureGroupDbCredentials', () => {
  it('provisions rw + ro passwords + mcp token idempotently', async () => {
    const client = new FakePerGroupK8sClient();
    const a = {
      client,
      namespace: 'kubeclaw',
      groupFolder: 'alice',
      capabilityName: 'database',
    };
    await ensureGroupDbCredentials(a);

    const secretName = credsSecretName('database', groupHash('alice'));
    const sec = await client.readSecret('kubeclaw', secretName);
    expect(sec).not.toBeNull();

    // Helper to read + base64-decode a key from the fake secret
    const read = (k: string) => {
      const raw = sec?.data?.[k];
      if (!raw) return null;
      return Buffer.from(raw, 'base64').toString('utf-8');
    };

    // rw password: POSTGRES_PASSWORD and PGPASSWORD must be the same value
    expect(read('POSTGRES_PASSWORD')).toBe(read('PGPASSWORD'));
    // rw password is a 48-char hex string (24 bytes)
    expect(read('POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
    // ro password is a distinct 48-char hex string
    expect(read('PG_RO_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
    expect(read('PG_RO_PASSWORD')).not.toBe(read('POSTGRES_PASSWORD'));
    // mcp token is a 64-char hex string (32 bytes)
    expect(read('KUBECLAW_MCP_TOKEN')).toMatch(/^[0-9a-f]{64}$/);

    // Idempotent: a second call must not change the values
    const before = read('POSTGRES_PASSWORD');
    await ensureGroupDbCredentials(a);
    const sec2 = await client.readSecret('kubeclaw', secretName);
    const read2 = (k: string) => {
      const raw = sec2?.data?.[k];
      if (!raw) return null;
      return Buffer.from(raw, 'base64').toString('utf-8');
    };
    expect(read2('POSTGRES_PASSWORD')).toBe(before);
  });

  it('repairs a partial write where POSTGRES_PASSWORD exists but PGPASSWORD is absent', async () => {
    const client = new FakePerGroupK8sClient();
    const a = {
      client,
      namespace: 'kubeclaw',
      groupFolder: 'bob',
      capabilityName: 'database',
    };
    const secretName = credsSecretName('database', groupHash('bob'));

    // Simulate a partial prior write: POSTGRES_PASSWORD is set but PGPASSWORD is absent
    const partialPassword = 'a'.repeat(48); // a known 48-char hex-like value
    await setGroupCredential({
      client,
      namespace: 'kubeclaw',
      groupFolder: 'bob',
      capabilityName: 'database',
      envName: 'POSTGRES_PASSWORD',
      value: partialPassword,
    });

    // Confirm precondition: PGPASSWORD is absent
    const pre = await client.readSecret('kubeclaw', secretName);
    expect(pre?.data?.['PGPASSWORD']).toBeUndefined();

    // Now run ensureGroupDbCredentials — it must repair the partial write
    await ensureGroupDbCredentials(a);

    const sec = await client.readSecret('kubeclaw', secretName);
    const read = (k: string) => {
      const raw = sec?.data?.[k];
      if (!raw) return null;
      return Buffer.from(raw, 'base64').toString('utf-8');
    };

    // Both keys must be present and equal
    expect(read('POSTGRES_PASSWORD')).not.toBeNull();
    expect(read('PGPASSWORD')).not.toBeNull();
    expect(read('PGPASSWORD')).toBe(read('POSTGRES_PASSWORD'));

    // The existing POSTGRES_PASSWORD value must be preserved (not rotated)
    expect(read('POSTGRES_PASSWORD')).toBe(partialPassword);
  });

  it('does not write rw password if both POSTGRES_PASSWORD and PGPASSWORD are already set', async () => {
    const client = new FakePerGroupK8sClient();
    const a = {
      client,
      namespace: 'kubeclaw',
      groupFolder: 'carol',
      capabilityName: 'database',
    };
    const secretName = credsSecretName('database', groupHash('carol'));

    // Pre-populate both keys with a known value
    const existingPw = 'f'.repeat(48);
    await setGroupCredential({
      client,
      namespace: 'kubeclaw',
      groupFolder: 'carol',
      capabilityName: 'database',
      envName: 'POSTGRES_PASSWORD',
      value: existingPw,
    });
    await setGroupCredential({
      client,
      namespace: 'kubeclaw',
      groupFolder: 'carol',
      capabilityName: 'database',
      envName: 'PGPASSWORD',
      value: existingPw,
    });

    await ensureGroupDbCredentials(a);

    const sec = await client.readSecret('kubeclaw', secretName);
    const read = (k: string) => {
      const raw = sec?.data?.[k];
      if (!raw) return null;
      return Buffer.from(raw, 'base64').toString('utf-8');
    };

    // Values must be unchanged
    expect(read('POSTGRES_PASSWORD')).toBe(existingPw);
    expect(read('PGPASSWORD')).toBe(existingPw);
  });
});
