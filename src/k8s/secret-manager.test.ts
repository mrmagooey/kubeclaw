import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretManager, GROUP_SECRETS_LABEL } from './secret-manager.js';
import { CatalogInformer } from './catalog.js';

describe('SecretManager', () => {
  let mockK8s: {
    readSecret: ReturnType<typeof vi.fn>;
    createSecret: ReturnType<typeof vi.fn>;
    patchSecret: ReturnType<typeof vi.fn>;
    deleteSecret: ReturnType<typeof vi.fn>;
  };
  let catalog: CatalogInformer;
  let mgr: SecretManager;

  beforeEach(() => {
    mockK8s = {
      readSecret: vi.fn(),
      createSecret: vi.fn(),
      patchSecret: vi.fn(),
      deleteSecret: vi.fn(),
    };
    catalog = new CatalogInformer({
      namespace: 'kubeclaw',
      configMapName: 'x',
      readConfigMap: vi.fn().mockResolvedValue({
        data: {
          'config.yaml': `
catalog:
  - id: replicate
    host: api.replicate.com
    credentialFields: [{ name: token, envVar: REPLICATE_API_TOKEN }]
  - id: jenkins
    host: jenkins.example.com
    credentialFields:
      - { name: user, envVar: JENKINS_USER }
      - { name: password, envVar: JENKINS_PASSWORD }
`,
        },
      }),
    });
    return catalog.sync().then(() => {
      mgr = new SecretManager({ namespace: 'kubeclaw', catalog, k8s: mockK8s });
    });
  });

  it('generates one high-entropy placeholder per field', async () => {
    mockK8s.readSecret.mockRejectedValue({ statusCode: 404 });
    mockK8s.createSecret.mockResolvedValue({});

    await mgr.setGroupSecret('family', 'jenkins', { user: 'alice', password: 'hunter2' });

    const createCall = mockK8s.createSecret.mock.calls[0][0];
    expect(createCall.metadata.name).toBe('kubeclaw-group-secrets-family');
    expect(createCall.metadata.labels[GROUP_SECRETS_LABEL]).toBe('true');

    const jenkinsBlob = JSON.parse(
      Buffer.from(createCall.data.jenkins, 'base64').toString('utf8'),
    );
    expect(jenkinsBlob.fields.user.value).toBe('alice');
    expect(jenkinsBlob.fields.user.placeholder).toMatch(/^KC_PH_user_[0-9a-f]{64}$/);
    expect(jenkinsBlob.fields.password.placeholder).toMatch(/^KC_PH_password_[0-9a-f]{64}$/);
    expect(jenkinsBlob.fields.user.placeholder)
      .not.toEqual(jenkinsBlob.fields.password.placeholder);
    expect(jenkinsBlob.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects unknown catalog id', async () => {
    await expect(mgr.setGroupSecret('family', 'unknown', { x: 'y' }))
      .rejects.toThrow(/unknown_catalog_entry/);
  });

  it('rejects missing required field', async () => {
    await expect(mgr.setGroupSecret('family', 'jenkins', { user: 'alice' }))
      .rejects.toThrow(/missing field/);
  });

  it('rejects empty value', async () => {
    await expect(mgr.setGroupSecret('family', 'replicate', { token: '' }))
      .rejects.toThrow(/empty/);
  });

  it('rejects value with control chars', async () => {
    await expect(mgr.setGroupSecret('family', 'replicate', { token: 'abc\nxyz' }))
      .rejects.toThrow(/invalid characters/);
  });

  it('rejects value over 4KB', async () => {
    await expect(mgr.setGroupSecret('family', 'replicate', { token: 'a'.repeat(5000) }))
      .rejects.toThrow(/too long/);
  });

  it('patches existing Secret without disturbing other entries', async () => {
    mockK8s.readSecret.mockResolvedValue({
      data: {
        replicate: Buffer.from(
          JSON.stringify({
            fields: { token: { value: 'r8_old', placeholder: 'KC_PH_token_aaaa' } },
            registeredAt: '2026-05-15T00:00:00Z',
          }),
        ).toString('base64'),
      },
      metadata: { labels: { [GROUP_SECRETS_LABEL]: 'true' } },
    });
    mockK8s.patchSecret.mockResolvedValue({});

    await mgr.setGroupSecret('family', 'jenkins', { user: 'alice', password: 'hunter2' });

    const patchCall = mockK8s.patchSecret.mock.calls[0];
    expect(patchCall[0]).toBe('kubeclaw-group-secrets-family');
    expect(patchCall[1].data.jenkins).toBeDefined();
    expect(patchCall[1].data.replicate).toBeUndefined(); // patch only includes new key
  });

  it('listGroupSecrets returns names and registeredAt only, no values', async () => {
    mockK8s.readSecret.mockResolvedValue({
      data: {
        replicate: Buffer.from(
          JSON.stringify({
            fields: { token: { value: 'r8_secret', placeholder: 'KC_PH_token_x' } },
            registeredAt: '2026-05-16T10:00:00Z',
          }),
        ).toString('base64'),
      },
    });

    const list = await mgr.listGroupSecrets('family');
    expect(list).toEqual([
      { catalogId: 'replicate', registeredAt: '2026-05-16T10:00:00Z' },
    ]);
    expect(JSON.stringify(list)).not.toContain('r8_secret');
  });

  it('deleteGroupSecret removes named entry; deletes Secret if last', async () => {
    mockK8s.readSecret.mockResolvedValueOnce({
      data: {
        replicate: Buffer.from(JSON.stringify({ fields: {}, registeredAt: '' })).toString('base64'),
        jenkins: Buffer.from(JSON.stringify({ fields: {}, registeredAt: '' })).toString('base64'),
      },
    });
    await mgr.deleteGroupSecret('family', 'replicate');
    expect(mockK8s.patchSecret).toHaveBeenCalled();
    expect(mockK8s.deleteSecret).not.toHaveBeenCalled();

    mockK8s.readSecret.mockResolvedValueOnce({
      data: {
        replicate: Buffer.from('{}').toString('base64'),
      },
    });
    await mgr.deleteGroupSecret('family', 'replicate');
    expect(mockK8s.deleteSecret).toHaveBeenCalledWith('kubeclaw-group-secrets-family');
  });
});
