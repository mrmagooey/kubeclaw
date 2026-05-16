import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfigOrThrow } from './index.js';
import { handleExtAuthz, type Deps } from './ext-authz.js';
import { Resolver } from './resolver.js';
import { K8sSecretSource } from './k8s-secret-source.js';

describe('loadConfigOrThrow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a well-formed broker config YAML', () => {
    const file = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(
      file,
      [
        'mappings:',
        '  - id: anthropic',
        '    destinations:',
        '      - api.anthropic.com',
        '    identities:',
        '      - sa/kubeclaw-tool-job',
        '    credentialRef:',
        '      kind: Secret',
        '      name: kubeclaw-secrets',
        '      key: ANTHROPIC_API_KEY',
        '    headerScheme: bearer',
        '',
      ].join('\n'),
    );
    const cfg = loadConfigOrThrow(file);
    expect(cfg.mappings).toHaveLength(1);
    expect(cfg.mappings[0].id).toBe('anthropic');
    expect(cfg.mappings[0].destinations).toContain('api.anthropic.com');
  });

  it('throws with a "not readable" message for a missing file', () => {
    const missing = path.join(tmpDir, 'does-not-exist.yaml');
    expect(() => loadConfigOrThrow(missing)).toThrow(/not readable/i);
    expect(() => loadConfigOrThrow(missing)).toThrow(missing);
  });

  it('throws with an "invalid" message for non-YAML garbage', () => {
    const file = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(file, 'mappings: : : not valid yaml\n');
    expect(() => loadConfigOrThrow(file)).toThrow(/invalid/i);
  });

  it('throws with an "invalid" message when schema validation fails', () => {
    const file = path.join(tmpDir, 'schema-bad.yaml');
    fs.writeFileSync(file, 'mappings: "this should be an array"\n');
    expect(() => loadConfigOrThrow(file)).toThrow(/invalid/i);
  });

  it('preserves the underlying error as the cause', () => {
    const missing = path.join(tmpDir, 'absent.yaml');
    try {
      loadConfigOrThrow(missing);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    }
  });
});

// ─── Helpers shared across substitution-header tests ──────────────────────────

function makeGroupSrc(
  group: string,
  catalogId: string,
  fields: Record<string, { value: string; placeholder: string }>,
): K8sSecretSource {
  const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
  src.applyGroupSecretEvent({
    type: 'ADDED',
    secret: {
      metadata: {
        name: `kubeclaw-group-secrets-${group}`,
        labels: { 'kubeclaw.io/group-secrets': 'true' },
      },
      data: {
        [catalogId]: Buffer.from(
          JSON.stringify({ fields, registeredAt: '2026-05-16T00:00:00Z' }),
        ).toString('base64'),
      },
    },
  });
  return src;
}

function makeReplicateCatalog(allowOperatorFallback = false) {
  return [
    {
      id: 'replicate',
      host: 'api.replicate.com',
      upstreamPort: 443 as const,
      credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
      baseUrlEnvs: {},
      allowOperatorFallback,
      allowedPositions: ['header', 'body'] as Array<'header' | 'body'>,
    },
  ];
}

function makeIdentityVerifier(
  identity = 'sa/kubeclaw-tool-job',
  ownerGroup: string | null = 'family',
) {
  const resolveResult = { identity, ownerGroup, podUid: null };
  return {
    verify: vi.fn().mockResolvedValue(identity),
    resolveOwnerGroup: vi.fn().mockResolvedValue(resolveResult),
  };
}

// ─── x-kubeclaw-substitutions / x-kubeclaw-policy header tests ───────────────

describe('handleExtAuthz — per-group substitution header', () => {
  it('200 ext_authz response includes x-kubeclaw-substitutions when group-cred hits', async () => {
    const groupSrc = makeGroupSrc('family', 'replicate', {
      token: { value: 'r8_secret-token', placeholder: 'KC_PH_token_aabbcc' },
    });

    const deps: Deps = {
      resolver: new Resolver({
        mappings: [],
        catalog: makeReplicateCatalog(),
        groupSource: groupSrc,
        operatorSecretReader: vi.fn().mockResolvedValue(null),
      }),
      identityVerifier: makeIdentityVerifier() as any,
      secretSource: groupSrc as any,
      audit: { record: vi.fn() },
      auditOnly: false,
    };

    const res = await handleExtAuthz(
      {
        authorization: 'Bearer fake-sa-token',
        'x-forwarded-authority': 'api.replicate.com',
      },
      deps,
    );

    expect(res.status).toBe(200);

    // x-kubeclaw-substitutions: placeholder=<base64value>;...
    const subsHeader = res.headers['x-kubeclaw-substitutions'];
    expect(subsHeader).toBeDefined();
    // Parse: "KC_PH_token_aabbcc=<b64>"
    const [placeholder, b64Value] = subsHeader!.split('=');
    expect(placeholder).toBe('KC_PH_token_aabbcc');
    expect(Buffer.from(b64Value, 'base64').toString('utf8')).toBe('r8_secret-token');

    // x-kubeclaw-policy: positions=header,body;per=10;total=50
    const policyHeader = res.headers['x-kubeclaw-policy'];
    expect(policyHeader).toBeDefined();
    expect(policyHeader).toContain('positions=header,body');
    expect(policyHeader).toContain('per=10');
    expect(policyHeader).toContain('total=50');

    // Old single-header must be absent
    expect(res.headers['x-kubeclaw-substitute']).toBeUndefined();
  });

  it('403 path emits no substitution headers (no_credential)', async () => {
    // No creds in K8sSecretSource — will hit no_credential
    const emptySrc = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });

    const deps: Deps = {
      resolver: new Resolver({
        mappings: [],
        catalog: makeReplicateCatalog(),
        groupSource: emptySrc,
        operatorSecretReader: vi.fn().mockResolvedValue(null),
      }),
      identityVerifier: makeIdentityVerifier() as any,
      secretSource: emptySrc as any,
      audit: { record: vi.fn() },
      auditOnly: false,
    };

    const res = await handleExtAuthz(
      {
        authorization: 'Bearer t',
        'x-forwarded-authority': 'api.replicate.com',
      },
      deps,
    );

    expect(res.status).toBe(403);
    expect(res.headers['x-kubeclaw-substitute']).toBeUndefined();
    expect(res.headers['x-kubeclaw-substitutions']).toBeUndefined();
    expect(res.headers['x-kubeclaw-policy']).toBeUndefined();
  });

  it('audit log records ownerGroup, catalogId, keySource, substitutionCount for per-group hit', async () => {
    const audit = { record: vi.fn() };
    const groupSrc = makeGroupSrc('family', 'replicate', {
      token: { value: 'r8_secret', placeholder: 'KC_PH_token_xxxx' },
    });

    const deps: Deps = {
      resolver: new Resolver({
        mappings: [],
        catalog: makeReplicateCatalog(),
        groupSource: groupSrc,
        operatorSecretReader: vi.fn().mockResolvedValue(null),
      }),
      identityVerifier: makeIdentityVerifier() as any,
      secretSource: groupSrc as any,
      audit,
      auditOnly: false,
    };

    await handleExtAuthz(
      {
        authorization: 'Bearer fake-sa-token',
        'x-forwarded-authority': 'api.replicate.com',
      },
      deps,
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        ownerGroup: 'family',
        catalogId: 'replicate',
        keySource: 'groupSecret',
        substitutionCount: 1,
      }),
    );

    // Values must NOT appear in the audit log
    const recorded = audit.record.mock.calls[0][0];
    const recordedStr = JSON.stringify(recorded);
    expect(recordedStr).not.toContain('r8_secret');
  });

  it('audit log records keySource=operatorFallback for operator-fallback hit', async () => {
    const audit = { record: vi.fn() };
    // No per-group creds — will fall back to operator secret
    const emptySrc = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    const operatorSecretReader = vi.fn().mockResolvedValue('sk-operator-secret');

    const deps: Deps = {
      resolver: new Resolver({
        mappings: [],
        catalog: makeReplicateCatalog(/* allowOperatorFallback= */ true),
        groupSource: emptySrc,
        operatorSecretReader,
      }),
      identityVerifier: makeIdentityVerifier() as any,
      secretSource: emptySrc as any,
      audit,
      auditOnly: false,
    };

    const res = await handleExtAuthz(
      {
        authorization: 'Bearer fake-sa-token',
        'x-forwarded-authority': 'api.replicate.com',
      },
      deps,
    );

    expect(res.status).toBe(200);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        keySource: 'operatorFallback',
        catalogId: 'replicate',
        substitutionCount: 1,
      }),
    );

    // Values must NOT appear in the audit log
    const recorded = audit.record.mock.calls[0][0];
    const recordedStr = JSON.stringify(recorded);
    expect(recordedStr).not.toContain('sk-operator-secret');
  });
});
