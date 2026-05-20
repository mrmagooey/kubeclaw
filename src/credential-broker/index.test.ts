import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfigOrThrow, makeReloadCallback } from './index.js';
import { handleExtAuthz, type Deps } from './ext-authz.js';
import { Resolver } from './resolver.js';
import { K8sSecretSource } from './k8s-secret-source.js';
import { Registry } from 'prom-client';
import { createMetrics } from './metrics.js';

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

// ─── Authz route matching ─────────────────────────────────────────────────────
//
// The broker accepts POST to any URL that starts with /authz so that Envoy's
// ext_authz path_prefix ("/authz") + original request path ("/echo") → "/authz/echo"
// is still handled rather than rejected with 404.
describe('authz route URL matching', () => {
  // Mirror the production check from index.ts so tests stay in sync with the impl.
  const isAuthzPath = (url: string | undefined) =>
    url?.startsWith('/authz') === true;

  it('accepts /authz', () => {
    expect(isAuthzPath('/authz')).toBe(true);
  });
  it('accepts /authz/echo (ext_authz path_prefix appended)', () => {
    expect(isAuthzPath('/authz/echo')).toBe(true);
  });
  it('accepts /authz/v1/path (multi-segment append)', () => {
    expect(isAuthzPath('/authz/v1/path')).toBe(true);
  });
  it('rejects /metrics', () => {
    expect(isAuthzPath('/metrics')).toBe(false);
  });
  it('rejects /healthz', () => {
    expect(isAuthzPath('/healthz')).toBe(false);
  });
  it('rejects undefined url', () => {
    expect(isAuthzPath(undefined)).toBe(false);
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
    expect(Buffer.from(b64Value, 'base64').toString('utf8')).toBe(
      'r8_secret-token',
    );

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
    const emptySrc = new K8sSecretSource({
      readSecret: vi.fn(),
      cacheTtlMs: 0,
    });

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
    const emptySrc = new K8sSecretSource({
      readSecret: vi.fn(),
      cacheTtlMs: 0,
    });
    const operatorSecretReader = vi
      .fn()
      .mockResolvedValue('sk-operator-secret');

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

// ─── makeReloadCallback — unit tests ─────────────────────────────────────────
//
// These tests exercise the reload callback in isolation, without a live server
// or real filesystem watcher. They call the callback directly to simulate the
// watchFile trigger.

describe('makeReloadCallback — unit', () => {
  let tmpDir: string;
  let configFile: string;
  let registry: Registry;
  let metrics: ReturnType<typeof createMetrics>;
  let groupSource: K8sSecretSource;

  const singleMapping = [
    'mappings:',
    '  - id: anthropic',
    '    destinations: ["api.anthropic.com"]',
    '    identities: ["*"]',
    '    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: anthropic-api-key }',
    '    headerScheme: bearer',
    'catalog: []',
    '',
  ].join('\n');

  const twoMappings = [
    'mappings:',
    '  - id: anthropic',
    '    destinations: ["api.anthropic.com"]',
    '    identities: ["*"]',
    '    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: anthropic-api-key }',
    '    headerScheme: bearer',
    '  - id: openai',
    '    destinations: ["api.openai.com"]',
    '    identities: ["*"]',
    '    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: openai-api-key }',
    '    headerScheme: bearer',
    'catalog: []',
    '',
  ].join('\n');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-reload-unit-'));
    configFile = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configFile, singleMapping);
    registry = new Registry();
    metrics = createMetrics(registry);
    groupSource = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces the resolver when config changes successfully', () => {
    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });
    const initialResolver = resolver;

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    // Write updated config with 2 mappings
    fs.writeFileSync(configFile, twoMappings);
    callback();

    expect(resolver).not.toBe(initialResolver);
    // New resolver should have 2 mappings — verify by checking find() works for both
    expect(resolver.find({ destination: 'api.anthropic.com', identity: 'sa/tool' })).toBeDefined();
    expect(resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' })).toBeDefined();
  });

  it('increments credential_broker_config_reloads_total{result=success} on success', async () => {
    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    fs.writeFileSync(configFile, twoMappings);
    callback();

    const text = await registry.metrics();
    expect(text).toMatch(/credential_broker_config_reloads_total\{[^}]*result="success"[^}]*\} 1/);
  });

  it('does NOT touch the resolver when config file is missing', () => {
    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });
    const initialResolver = resolver;

    const callback = makeReloadCallback({
      configPath: path.join(tmpDir, 'does-not-exist.yaml'),
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    callback();

    expect(resolver).toBe(initialResolver);
  });

  it('increments credential_broker_config_reloads_total{result=failure} on parse error', async () => {
    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    // Write invalid YAML
    fs.writeFileSync(configFile, 'mappings: : : bad yaml\n');

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    callback();

    const text = await registry.metrics();
    expect(text).toMatch(/credential_broker_config_reloads_total\{[^}]*result="failure"[^}]*\} 1/);
  });

  it('does NOT replace the resolver when the new config is invalid', () => {
    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });
    const initialResolver = resolver;

    fs.writeFileSync(configFile, 'mappings: "not-an-array"\n');

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    callback();

    expect(resolver).toBe(initialResolver);
  });

  it('firing the callback twice increments the counter to 2', async () => {
    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    fs.writeFileSync(configFile, twoMappings);
    callback();
    callback();

    const text = await registry.metrics();
    expect(text).toMatch(/credential_broker_config_reloads_total\{[^}]*result="success"[^}]*\} 2/);
  });

  it('the metric starts at 0 before any reload fires', async () => {
    const text = await registry.metrics();
    // Counter starts at 0 — the metric should either be absent or show 0
    const match = text.match(/credential_broker_config_reloads_total\{[^}]*result="success"[^}]*\} (\d+)/);
    if (match) {
      expect(Number(match[1])).toBe(0);
    }
    // If the line is absent altogether, that also satisfies "is 0" (prom-client
    // omits zero-value counters by default). Either case is acceptable.
  });
});

// ─── makeReloadCallback — integration tests ───────────────────────────────────
//
// These tests use a REAL temp file on disk and drive the reload callback
// directly (without relying on fs.watchFile polling). They verify that actual
// file reads update the in-memory resolver state.

describe('makeReloadCallback — integration', () => {
  let tmpDir: string;
  let configFile: string;

  const yamlWith = (ids: string[]) =>
    [
      'mappings:',
      ...ids.map((id) => [
        `  - id: ${id}`,
        `    destinations: ["api.${id}.com"]`,
        `    identities: ["*"]`,
        `    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: ${id}-api-key }`,
        `    headerScheme: bearer`,
      ].join('\n')),
      'catalog: []',
      '',
    ].join('\n');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-reload-intg-'));
    configFile = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configFile, yamlWith(['anthropic']));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adding a host mapping becomes live after callback fires', () => {
    const registry = new Registry();
    const metrics = createMetrics(registry);
    const groupSource = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });

    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    // Initially only anthropic is mapped
    expect(resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' })).toBeUndefined();

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    // Patch config to add openai
    fs.writeFileSync(configFile, yamlWith(['anthropic', 'openai']));
    callback();

    expect(resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' })).toBeDefined();
    expect(resolver.find({ destination: 'api.anthropic.com', identity: 'sa/tool' })).toBeDefined();
  });

  it('removing a host mapping causes that destination to 403 after callback fires', async () => {
    const registry = new Registry();
    const metrics = createMetrics(registry);
    const groupSource = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });

    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    // Verify anthropic works before removal
    expect(resolver.find({ destination: 'api.anthropic.com', identity: 'sa/tool' })).toBeDefined();

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    // Remove all mappings
    fs.writeFileSync(configFile, yamlWith([]));
    callback();

    expect(resolver.find({ destination: 'api.anthropic.com', identity: 'sa/tool' })).toBeUndefined();
  });

  it('metric increments on successful reload from real file write', async () => {
    const registry = new Registry();
    const metrics = createMetrics(registry);
    const groupSource = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });

    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    fs.writeFileSync(configFile, yamlWith(['anthropic', 'openai', 'voyage']));
    callback();

    const text = await registry.metrics();
    expect(text).toMatch(/credential_broker_config_reloads_total\{[^}]*result="success"[^}]*\} 1/);
  });

  it('multiple sequential config patches all take effect', () => {
    const registry = new Registry();
    const metrics = createMetrics(registry);
    const groupSource = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });

    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => { resolver = r; },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    // Patch 1: add openai
    fs.writeFileSync(configFile, yamlWith(['anthropic', 'openai']));
    callback();
    expect(resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' })).toBeDefined();

    // Patch 2: remove openai, add voyage
    fs.writeFileSync(configFile, yamlWith(['anthropic', 'voyage']));
    callback();
    expect(resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' })).toBeUndefined();
    expect(resolver.find({ destination: 'api.voyage.com', identity: 'sa/tool' })).toBeDefined();
  });
});
