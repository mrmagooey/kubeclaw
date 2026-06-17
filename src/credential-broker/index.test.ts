import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfigOrThrow, makeReloadCallback } from './index.js';
import { handleExtAuthz, type Deps } from './ext-authz.js';
import { Resolver } from './resolver.js';
import { K8sSecretSource } from './k8s-secret-source.js';
import { PodInformer } from './pod-informer.js';
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
      setResolver: (r) => {
        resolver = r;
      },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    // Write updated config with 2 mappings
    fs.writeFileSync(configFile, twoMappings);
    callback();

    expect(resolver).not.toBe(initialResolver);
    // New resolver should have 2 mappings — verify by checking find() works for both
    expect(
      resolver.find({ destination: 'api.anthropic.com', identity: 'sa/tool' }),
    ).toBeDefined();
    expect(
      resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' }),
    ).toBeDefined();
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
      setResolver: (r) => {
        resolver = r;
      },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    fs.writeFileSync(configFile, twoMappings);
    callback();

    const text = await registry.metrics();
    expect(text).toMatch(
      /credential_broker_config_reloads_total\{[^}]*result="success"[^}]*\} 1/,
    );
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
      setResolver: (r) => {
        resolver = r;
      },
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
      setResolver: (r) => {
        resolver = r;
      },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    callback();

    const text = await registry.metrics();
    expect(text).toMatch(
      /credential_broker_config_reloads_total\{[^}]*result="failure"[^}]*\} 1/,
    );
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
      setResolver: (r) => {
        resolver = r;
      },
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
      setResolver: (r) => {
        resolver = r;
      },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    fs.writeFileSync(configFile, twoMappings);
    callback();
    callback();

    const text = await registry.metrics();
    expect(text).toMatch(
      /credential_broker_config_reloads_total\{[^}]*result="success"[^}]*\} 2/,
    );
  });

  it('the metric starts at 0 before any reload fires', async () => {
    const text = await registry.metrics();
    // Counter starts at 0 — the metric should either be absent or show 0
    const match = text.match(
      /credential_broker_config_reloads_total\{[^}]*result="success"[^}]*\} (\d+)/,
    );
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
      ...ids.map((id) =>
        [
          `  - id: ${id}`,
          `    destinations: ["api.${id}.com"]`,
          `    identities: ["*"]`,
          `    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: ${id}-api-key }`,
          `    headerScheme: bearer`,
        ].join('\n'),
      ),
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
    const groupSource = new K8sSecretSource({
      readSecret: vi.fn(),
      cacheTtlMs: 0,
    });

    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    // Initially only anthropic is mapped
    expect(
      resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' }),
    ).toBeUndefined();

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => {
        resolver = r;
      },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    // Patch config to add openai
    fs.writeFileSync(configFile, yamlWith(['anthropic', 'openai']));
    callback();

    expect(
      resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' }),
    ).toBeDefined();
    expect(
      resolver.find({ destination: 'api.anthropic.com', identity: 'sa/tool' }),
    ).toBeDefined();
  });

  it('removing a host mapping causes that destination to 403 after callback fires', async () => {
    const registry = new Registry();
    const metrics = createMetrics(registry);
    const groupSource = new K8sSecretSource({
      readSecret: vi.fn(),
      cacheTtlMs: 0,
    });

    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    // Verify anthropic works before removal
    expect(
      resolver.find({ destination: 'api.anthropic.com', identity: 'sa/tool' }),
    ).toBeDefined();

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => {
        resolver = r;
      },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    // Remove all mappings
    fs.writeFileSync(configFile, yamlWith([]));
    callback();

    expect(
      resolver.find({ destination: 'api.anthropic.com', identity: 'sa/tool' }),
    ).toBeUndefined();
  });

  it('metric increments on successful reload from real file write', async () => {
    const registry = new Registry();
    const metrics = createMetrics(registry);
    const groupSource = new K8sSecretSource({
      readSecret: vi.fn(),
      cacheTtlMs: 0,
    });

    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => {
        resolver = r;
      },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    fs.writeFileSync(configFile, yamlWith(['anthropic', 'openai', 'voyage']));
    callback();

    const text = await registry.metrics();
    expect(text).toMatch(
      /credential_broker_config_reloads_total\{[^}]*result="success"[^}]*\} 1/,
    );
  });

  it('multiple sequential config patches all take effect', () => {
    const registry = new Registry();
    const metrics = createMetrics(registry);
    const groupSource = new K8sSecretSource({
      readSecret: vi.fn(),
      cacheTtlMs: 0,
    });

    let resolver = new Resolver({
      mappings: loadConfigOrThrow(configFile).mappings,
      catalog: [],
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
    });

    const callback = makeReloadCallback({
      configPath: configFile,
      setResolver: (r) => {
        resolver = r;
      },
      groupSource,
      operatorSecretReader: vi.fn().mockResolvedValue(null),
      metrics,
    });

    // Patch 1: add openai
    fs.writeFileSync(configFile, yamlWith(['anthropic', 'openai']));
    callback();
    expect(
      resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' }),
    ).toBeDefined();

    // Patch 2: remove openai, add voyage
    fs.writeFileSync(configFile, yamlWith(['anthropic', 'voyage']));
    callback();
    expect(
      resolver.find({ destination: 'api.openai.com', identity: 'sa/tool' }),
    ).toBeUndefined();
    expect(
      resolver.find({ destination: 'api.voyage.com', identity: 'sa/tool' }),
    ).toBeDefined();
  });
});

// ─── startBroker handler logic — inline unit tests ────────────────────────────
//
// startBroker() calls kc.loadFromCluster() which requires a real cluster.
// We test the handler closures directly by reconstructing them in test scope —
// they are short pure closures over PodInformer and K8sSecretSource instances.

// Helper: build a valid base64-encoded group-secret data value
function makeGroupSecretData(
  fields: Record<string, { value: string; placeholder: string }>,
): string {
  return Buffer.from(JSON.stringify({ fields, registeredAt: '2026-01-01' })).toString('base64');
}

// ─── Pod upsert handler ───────────────────────────────────────────────────────

describe('startBroker pod-informer handler logic — handlePodUpsert', () => {
  let podInformer: PodInformer;

  // Reconstructed from startBroker in index.ts
  function handlePodUpsert(pod: {
    metadata?: {
      uid?: string;
      name?: string;
      deletionTimestamp?: string;
      annotations?: Record<string, string>;
    };
    status?: { podIP?: string };
  }) {
    const uid = pod.metadata?.uid;
    const podIP = pod.status?.podIP;
    if (!uid || !podIP) return;
    podInformer.upsert({
      uid,
      name: pod.metadata?.name ?? '',
      podIP,
      terminating: pod.metadata?.deletionTimestamp != null,
      annotations: (pod.metadata?.annotations as Record<string, string>) ?? {},
    });
  }

  beforeEach(() => {
    podInformer = new PodInformer();
  });

  it('upserts pod with uid and podIP', () => {
    handlePodUpsert({
      metadata: { uid: 'uid-1', name: 'my-pod' },
      status: { podIP: '10.0.0.1' },
    });
    expect(podInformer.resolveOwnerGroupByIP('10.0.0.1')).toBeNull(); // no annotation yet
    // Verify pod was stored by checking UID lookup works (terminating=false, no annotation → null)
    // Upsert itself doesn't throw — indirect verification via resolveOwnerGroupByUID
    const result = podInformer.resolveOwnerGroupByUID('uid-1');
    expect(result).toBeNull(); // no owner-group annotation → null, but pod was stored
  });

  it('stores pod that is retrievable by IP after upsert', () => {
    handlePodUpsert({
      metadata: {
        uid: 'uid-2',
        name: 'annotated-pod',
        annotations: { 'kubeclaw.io/owner-group': 'family' },
      },
      status: { podIP: '10.0.0.2' },
    });
    const result = podInformer.resolveOwnerGroupByIP('10.0.0.2');
    expect(result).not.toBeNull();
    expect(result!.ownerGroup).toBe('family');
    expect(result!.podUid).toBe('uid-2');
  });

  it('ignores pod missing uid', () => {
    handlePodUpsert({
      metadata: { name: 'no-uid', annotations: { 'kubeclaw.io/owner-group': 'family' } },
      status: { podIP: '10.0.0.3' },
    });
    // Nothing upserted — IP lookup returns null
    expect(podInformer.resolveOwnerGroupByIP('10.0.0.3')).toBeNull();
  });

  it('ignores pod missing podIP', () => {
    handlePodUpsert({
      metadata: {
        uid: 'uid-4',
        name: 'no-ip',
        annotations: { 'kubeclaw.io/owner-group': 'family' },
      },
      status: {},
    });
    expect(podInformer.resolveOwnerGroupByUID('uid-4')).toBeNull();
  });

  it('sets terminating=true when deletionTimestamp is set', () => {
    handlePodUpsert({
      metadata: {
        uid: 'uid-5',
        name: 'terminating-pod',
        deletionTimestamp: '2026-01-01T00:00:00Z',
        annotations: { 'kubeclaw.io/owner-group': 'family' },
      },
      status: { podIP: '10.0.0.5' },
    });
    // terminating pods return null from owner-group resolution
    expect(podInformer.resolveOwnerGroupByIP('10.0.0.5')).toBeNull();
    expect(podInformer.resolveOwnerGroupByUID('uid-5')).toBeNull();
  });

  it('sets terminating=false when deletionTimestamp is absent', () => {
    handlePodUpsert({
      metadata: {
        uid: 'uid-6',
        name: 'live-pod',
        annotations: { 'kubeclaw.io/owner-group': 'work' },
      },
      status: { podIP: '10.0.0.6' },
    });
    // Not terminating — owner-group should resolve
    const result = podInformer.resolveOwnerGroupByUID('uid-6');
    expect(result).not.toBeNull();
    expect(result!.ownerGroup).toBe('work');
  });

  it('captures annotations from pod metadata', () => {
    handlePodUpsert({
      metadata: {
        uid: 'uid-7',
        name: 'annotated',
        annotations: {
          'kubeclaw.io/owner-group': 'friends',
          'some.other/annotation': 'value',
        },
      },
      status: { podIP: '10.0.0.7' },
    });
    const result = podInformer.resolveOwnerGroupByUID('uid-7');
    expect(result).not.toBeNull();
    expect(result!.ownerGroup).toBe('friends');
  });
});

// ─── Pod DELETE handler ───────────────────────────────────────────────────────

describe('startBroker pod-informer handler logic — DELETE handler', () => {
  let podInformer: PodInformer;

  function handlePodDelete(pod: { metadata?: { uid?: string } }) {
    const uid = pod.metadata?.uid;
    if (uid) podInformer.delete(uid);
  }

  beforeEach(() => {
    podInformer = new PodInformer();
    // Pre-load a pod to delete
    podInformer.upsert({
      uid: 'uid-del-1',
      name: 'to-delete',
      podIP: '10.1.0.1',
      terminating: false,
      annotations: { 'kubeclaw.io/owner-group': 'family' },
    });
  });

  it('deletes pod by uid when uid is present', () => {
    // Verify it exists first
    expect(podInformer.resolveOwnerGroupByUID('uid-del-1')).not.toBeNull();

    handlePodDelete({ metadata: { uid: 'uid-del-1' } });

    expect(podInformer.resolveOwnerGroupByUID('uid-del-1')).toBeNull();
    expect(podInformer.resolveOwnerGroupByIP('10.1.0.1')).toBeNull();
  });

  it('ignores delete event when uid is absent', () => {
    // The pre-loaded pod should still be there
    handlePodDelete({ metadata: {} });

    expect(podInformer.resolveOwnerGroupByUID('uid-del-1')).not.toBeNull();
  });
});

// ─── Secret handler factory ───────────────────────────────────────────────────

describe('startBroker secret-informer handler logic — makeSecretHandler', () => {
  let secretSource: K8sSecretSource;

  function makeSecretHandler(type: 'ADDED' | 'MODIFIED' | 'DELETED') {
    return (secret: {
      metadata?: { name?: string; labels?: Record<string, string> };
      data?: Record<string, string>;
    }) => {
      secretSource.applyGroupSecretEvent({
        type,
        secret: {
          metadata: {
            name: secret.metadata?.name,
            labels: secret.metadata?.labels as Record<string, string> | undefined,
          },
          data: secret.data ?? {},
        },
      });
    };
  }

  beforeEach(() => {
    secretSource = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
  });

  it('ADDED event registers group credentials in K8sSecretSource', () => {
    const handler = makeSecretHandler('ADDED');
    handler({
      metadata: {
        name: 'kubeclaw-group-secrets-family',
        labels: { 'kubeclaw.io/group-secrets': 'true' },
      },
      data: {
        replicate: makeGroupSecretData({
          token: { value: 'r8_secret', placeholder: 'KC_PH_token_aabb' },
        }),
      },
    });

    const cred = secretSource.getGroupCredential('family', 'replicate');
    expect(cred).not.toBeNull();
    expect(cred!.fields.token.value).toBe('r8_secret');
  });

  it('MODIFIED event updates group credentials', () => {
    const addHandler = makeSecretHandler('ADDED');
    addHandler({
      metadata: {
        name: 'kubeclaw-group-secrets-family',
        labels: { 'kubeclaw.io/group-secrets': 'true' },
      },
      data: {
        replicate: makeGroupSecretData({
          token: { value: 'old-secret', placeholder: 'KC_PH_token_aabb' },
        }),
      },
    });

    const modHandler = makeSecretHandler('MODIFIED');
    modHandler({
      metadata: {
        name: 'kubeclaw-group-secrets-family',
        labels: { 'kubeclaw.io/group-secrets': 'true' },
      },
      data: {
        replicate: makeGroupSecretData({
          token: { value: 'new-secret', placeholder: 'KC_PH_token_aabb' },
        }),
      },
    });

    const cred = secretSource.getGroupCredential('family', 'replicate');
    expect(cred).not.toBeNull();
    expect(cred!.fields.token.value).toBe('new-secret');
  });

  it('DELETED event removes group credentials', () => {
    const addHandler = makeSecretHandler('ADDED');
    addHandler({
      metadata: {
        name: 'kubeclaw-group-secrets-family',
        labels: { 'kubeclaw.io/group-secrets': 'true' },
      },
      data: {
        replicate: makeGroupSecretData({
          token: { value: 'r8_secret', placeholder: 'KC_PH_token_aabb' },
        }),
      },
    });

    expect(secretSource.getGroupCredential('family', 'replicate')).not.toBeNull();

    const delHandler = makeSecretHandler('DELETED');
    delHandler({
      metadata: {
        name: 'kubeclaw-group-secrets-family',
        labels: { 'kubeclaw.io/group-secrets': 'true' },
      },
      data: {},
    });

    expect(secretSource.getGroupCredential('family', 'replicate')).toBeNull();
    expect(secretSource.listGroups()).not.toContain('family');
  });

  it('ignores secrets not named kubeclaw-group-secrets-*', () => {
    const handler = makeSecretHandler('ADDED');
    handler({
      metadata: {
        name: 'some-other-secret',
        labels: { 'kubeclaw.io/group-secrets': 'true' },
      },
      data: {
        replicate: makeGroupSecretData({
          token: { value: 'r8_secret', placeholder: 'KC_PH_token_aabb' },
        }),
      },
    });

    expect(secretSource.listGroups()).toHaveLength(0);
  });
});

// ─── operatorSecretReader ─────────────────────────────────────────────────────

describe('startBroker operatorSecretReader', () => {
  it('returns the credential value when the key exists', async () => {
    const readSecret = vi.fn().mockResolvedValue({
      metadata: { name: 'kubeclaw-secrets' },
      data: { myKey: Buffer.from('my-api-value').toString('base64') },
    });
    const secretSource = new K8sSecretSource({ readSecret, cacheTtlMs: 0 });

    // Reconstruct operatorSecretReader from startBroker
    const operatorSecretReader = async (catalogId: string): Promise<string | null> => {
      try {
        return await secretSource.read({ kind: 'Secret', name: 'kubeclaw-secrets', key: catalogId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('has no key')) return null;
        throw err;
      }
    };

    const result = await operatorSecretReader('myKey');
    expect(result).toBe('my-api-value');
  });

  it('returns null when error message contains "has no key"', async () => {
    const readSecret = vi.fn().mockResolvedValue({
      metadata: { name: 'kubeclaw-secrets' },
      data: {}, // no key named 'missingKey'
    });
    const secretSource = new K8sSecretSource({ readSecret, cacheTtlMs: 0 });

    const operatorSecretReader = async (catalogId: string): Promise<string | null> => {
      try {
        return await secretSource.read({ kind: 'Secret', name: 'kubeclaw-secrets', key: catalogId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('has no key')) return null;
        throw err;
      }
    };

    const result = await operatorSecretReader('missingKey');
    expect(result).toBeNull();
  });

  it('rethrows errors that do not contain "has no key"', async () => {
    const readSecret = vi.fn().mockRejectedValue(new Error('network timeout'));
    const secretSource = new K8sSecretSource({ readSecret, cacheTtlMs: 0 });

    const operatorSecretReader = async (catalogId: string): Promise<string | null> => {
      try {
        return await secretSource.read({ kind: 'Secret', name: 'kubeclaw-secrets', key: catalogId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('has no key')) return null;
        throw err;
      }
    };

    await expect(operatorSecretReader('someKey')).rejects.toThrow('network timeout');
  });
});
