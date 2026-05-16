import { describe, it, expect, vi } from 'vitest';
import {
  listCredentialsTool,
  buildCredentialSystemBlock,
  type IpcClient,
  type CredentialEntry,
} from './list-credentials.js';
import type { IpcResponse } from '../channel-runner.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const REPLICATE_CATALOG = {
  id: 'replicate',
  host: 'api.replicate.com',
  upstreamPort: 443,
  credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
  baseUrlEnvs: { REPLICATE_API_URL: 'http://api.replicate.com' },
  allowOperatorFallback: false,
  allowedPositions: ['header', 'body'],
};

const MISTRAL_CATALOG = {
  id: 'mistral',
  host: 'api.mistral.ai',
  upstreamPort: 443,
  credentialFields: [{ name: 'token', envVar: 'MISTRAL_API_KEY' }],
  baseUrlEnvs: {},
  allowOperatorFallback: false,
  allowedPositions: ['header', 'body'],
};

const JENKINS_CATALOG = {
  id: 'jenkins',
  host: 'jenkins.example.com',
  upstreamPort: 8080,
  credentialFields: [
    { name: 'user', envVar: 'JENKINS_USER' },
    { name: 'password', envVar: 'JENKINS_PASSWORD' },
  ],
  baseUrlEnvs: { JENKINS_URL: 'http://jenkins.example.com' },
  allowOperatorFallback: false,
  allowedPositions: ['header', 'body'],
};

/** Build an IPC mock that returns the given secret-list and catalog. */
function makeIpc(
  secretEntries: Array<{ catalogId: string; registeredAt: string }>,
  catalogEntries: object[],
): IpcClient {
  return vi.fn(
    async (
      type: string,
      _fields: Record<string, string>,
    ): Promise<IpcResponse> => {
      if (type === 'secret.list') {
        return { ok: true, result: secretEntries };
      }
      if (type === 'catalog.list') {
        return { ok: true, result: catalogEntries };
      }
      return { ok: false, error: `unexpected IPC type: ${type}` };
    },
  ) as unknown as IpcClient;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('listCredentialsTool', () => {
  it('returns merged catalog + registered metadata', async () => {
    const ipc = makeIpc(
      [{ catalogId: 'replicate', registeredAt: '2026-05-16T14:22:11Z' }],
      [REPLICATE_CATALOG, MISTRAL_CATALOG],
    );

    const result = await listCredentialsTool({ group: 'family' }, { ipc });

    expect(result).toEqual([
      {
        catalogId: 'replicate',
        host: 'api.replicate.com',
        fields: ['token'],
        hasCredential: true,
        registeredAt: '2026-05-16T14:22:11Z',
      },
      {
        catalogId: 'mistral',
        host: 'api.mistral.ai',
        fields: ['token'],
        hasCredential: false,
        registeredAt: null,
      },
    ]);
  });

  it('marks hasCredential=false and registeredAt=null for unregistered entries', async () => {
    const ipc = makeIpc([], [REPLICATE_CATALOG]);

    const result = await listCredentialsTool({ group: 'family' }, { ipc });

    expect(result).toHaveLength(1);
    expect(result[0].hasCredential).toBe(false);
    expect(result[0].registeredAt).toBeNull();
  });

  it('includes all credential field names for multi-field entries', async () => {
    const ipc = makeIpc(
      [{ catalogId: 'jenkins', registeredAt: '2026-05-16T10:00:00Z' }],
      [JENKINS_CATALOG],
    );

    const result = await listCredentialsTool({ group: 'ops' }, { ipc });

    expect(result).toHaveLength(1);
    expect(result[0].fields).toEqual(['user', 'password']);
    expect(result[0].hasCredential).toBe(true);
  });

  it('returns empty array when catalog is empty', async () => {
    const ipc = makeIpc([], []);
    const result = await listCredentialsTool({ group: 'family' }, { ipc });
    expect(result).toEqual([]);
  });

  it('fires both IPC calls in parallel (both are called)', async () => {
    const ipc = makeIpc([], [REPLICATE_CATALOG]);
    await listCredentialsTool({ group: 'family' }, { ipc });

    const callTypes = (ipc as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(callTypes).toContain('secret.list');
    expect(callTypes).toContain('catalog.list');
  });

  it('passes the correct group to secret.list', async () => {
    const ipc = makeIpc([], []);
    await listCredentialsTool({ group: 'team-alpha' }, { ipc });

    const secretListCall = (ipc as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'secret.list',
    );
    expect(secretListCall).toBeDefined();
    expect(secretListCall![1]).toEqual({ group: 'team-alpha' });
  });

  // ── Security: values are NEVER in the return shape ────────────────────────

  it('return shape contains no cleartext values, hashes, or previews', async () => {
    const ipc = makeIpc(
      [{ catalogId: 'replicate', registeredAt: '2026-05-16T14:22:11Z' }],
      [REPLICATE_CATALOG],
    );

    const result = await listCredentialsTool({ group: 'family' }, { ipc });
    const serialized = JSON.stringify(result);

    // These are example secret strings that must never leak
    const forbidden = [
      'r8_supersecrettoken1234567890',
      'sk-abc123',
      'Bearer supersecret',
      'hunter2',
    ];
    for (const secret of forbidden) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('serialised result does not contain typical secret patterns', async () => {
    // Even if the IPC mock somehow returned values in the result, the tool
    // should not propagate fields beyond what the return type declares.
    const ipcWithExtraFields = vi.fn(
      async (type: string): Promise<IpcResponse> => {
        if (type === 'secret.list') {
          return {
            ok: true,
            result: [
              {
                catalogId: 'replicate',
                registeredAt: '2026-05-16T14:22:11Z',
                // These extra fields must not appear in the return shape
                value: 'r8_should_not_leak',
                hash: 'sha256:abc123',
                preview: 'r8_****',
              },
            ],
          };
        }
        if (type === 'catalog.list') {
          return { ok: true, result: [REPLICATE_CATALOG] };
        }
        return { ok: false, error: 'unexpected' };
      },
    ) as unknown as IpcClient;

    const result = await listCredentialsTool(
      { group: 'family' },
      { ipc: ipcWithExtraFields },
    );
    const serialized = JSON.stringify(result);

    // Extra fields must not be present
    expect(serialized).not.toContain('r8_should_not_leak');
    expect(serialized).not.toContain('sha256:abc123');
    expect(serialized).not.toContain('r8_****');
  });

  // ── Error handling: IPC failure → throw ──────────────────────────────────

  it('throws when secret.list IPC rejects (not partial data)', async () => {
    const ipc = vi.fn(async (type: string): Promise<IpcResponse> => {
      if (type === 'secret.list') throw new Error('redis down');
      return { ok: true, result: [REPLICATE_CATALOG] };
    }) as unknown as IpcClient;

    await expect(
      listCredentialsTool({ group: 'family' }, { ipc }),
    ).rejects.toThrow();
  });

  it('throws when catalog.list IPC rejects (not partial data)', async () => {
    const ipc = vi.fn(async (type: string): Promise<IpcResponse> => {
      if (type === 'secret.list') return { ok: true, result: [] };
      if (type === 'catalog.list') throw new Error('catalog unavailable');
      return { ok: false, error: 'unexpected' };
    }) as unknown as IpcClient;

    await expect(
      listCredentialsTool({ group: 'family' }, { ipc }),
    ).rejects.toThrow();
  });

  it('throws on IPC ok=false for secret.list', async () => {
    const ipc = vi.fn(async (type: string): Promise<IpcResponse> => {
      if (type === 'secret.list')
        return { ok: false, error: 'SecretManager not initialised' };
      return { ok: true, result: [REPLICATE_CATALOG] };
    }) as unknown as IpcClient;

    await expect(
      listCredentialsTool({ group: 'family' }, { ipc }),
    ).rejects.toThrow('secret.list IPC failed');
  });

  it('throws on IPC ok=false for catalog.list', async () => {
    const ipc = vi.fn(async (type: string): Promise<IpcResponse> => {
      if (type === 'secret.list') return { ok: true, result: [] };
      if (type === 'catalog.list')
        return { ok: false, error: 'CatalogInformer not initialised' };
      return { ok: false, error: 'unexpected' };
    }) as unknown as IpcClient;

    await expect(
      listCredentialsTool({ group: 'family' }, { ipc }),
    ).rejects.toThrow('catalog.list IPC failed');
  });
});

// ── buildCredentialSystemBlock ────────────────────────────────────────────────

describe('buildCredentialSystemBlock', () => {
  it('returns empty string when entries are empty', () => {
    expect(buildCredentialSystemBlock([], 'family')).toBe('');
  });

  it('includes the group name in the header', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'replicate',
        host: 'api.replicate.com',
        fields: ['token'],
        hasCredential: true,
        registeredAt: '2026-05-16T14:22:11Z',
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'my-group');
    expect(block).toContain('"my-group"');
  });

  it('marks registered entries with "credential registered"', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'replicate',
        host: 'api.replicate.com',
        fields: ['token'],
        hasCredential: true,
        registeredAt: '2026-05-16T14:22:11Z',
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'family');
    expect(block).toContain('replicate');
    expect(block).toContain('api.replicate.com');
    expect(block).toContain('credential registered');
  });

  it('marks unregistered entries with /secret add hint', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'mistral',
        host: 'api.mistral.ai',
        fields: ['token'],
        hasCredential: false,
        registeredAt: null,
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'family');
    expect(block).toContain('mistral');
    expect(block).toContain('no credential');
    expect(block).toContain('/secret add mistral');
  });

  it('includes both registered and unregistered entries', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'replicate',
        host: 'api.replicate.com',
        fields: ['token'],
        hasCredential: true,
        registeredAt: '2026-05-16T14:22:11Z',
      },
      {
        catalogId: 'jenkins',
        host: 'jenkins.example.com',
        fields: ['user', 'password'],
        hasCredential: false,
        registeredAt: null,
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'ops');
    expect(block).toContain('replicate');
    expect(block).toContain('credential registered');
    expect(block).toContain('jenkins');
    expect(block).toContain('no credential');
  });

  it('block starts with [SYSTEM]', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'x',
        host: 'x.example',
        fields: ['t'],
        hasCredential: false,
        registeredAt: null,
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'g');
    expect(block.startsWith('[SYSTEM]')).toBe(true);
  });
});
