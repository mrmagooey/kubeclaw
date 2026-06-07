/**
 * Helm chart static template tests.
 *
 * Verifies `helm template` / `helm lint` rendering without a live cluster.
 * No cluster required — these tests run with the helm CLI alone.
 *
 * Extracted from e2e/helm-chart.test.ts so that template-rendering checks
 * are never gated behind the live-cluster beforeAll that drives the full
 * helm install suite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execSync } from 'child_process';

// ─── Constants ───────────────────────────────────────────────────────────────

const CHART_DIR = './helm/kubeclaw';

// ─── 1. Static checks ─────────────────────────────────────────────────────────

describe('helm chart static checks', () => {
  it('passes helm lint', () => {
    const result = spawnSync('helm', ['lint', CHART_DIR], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('0 chart(s) failed');
  });

  it('renders all expected resource kinds', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    for (const kind of [
      'StatefulSet', 'Deployment', 'NetworkPolicy',
      'PersistentVolumeClaim', 'ConfigMap', 'Secret',
      'ServiceAccount', 'Role', 'RoleBinding',
    ]) {
      expect(result.stdout, `missing kind: ${kind}`).toContain(`kind: ${kind}`);
    }
  });

  it('imagePullPolicy is Always when image.registry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'image.registry=registry.example.com',
        '--set', 'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('registry.example.com/kubeclaw-orchestrator');
    expect(result.stdout).toContain('imagePullPolicy: Always');
  });

  it('omits kubeclaw-secrets when existingSecret is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'secrets.existingSecret=my-secret',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('name: my-secret');
    expect(result.stdout).not.toContain('name: kubeclaw-secrets');
  });

  it('omits NetworkPolicy when networkPolicy.enabled is false', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'networkPolicy.enabled=false',
        '--set', 'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('kind: NetworkPolicy');
  });

  it('injects storageClassName when storage.storageClass is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'storage.storageClass=efs-sc',
        '--set', 'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('storageClassName: efs-sc');
  });

  it('uses ReadWriteMany for all group PVCs when accessMode is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'storage.accessMode=ReadWriteMany',
        '--set', 'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ReadWriteMany');
  });
});

// ─── ClusterRoleBinding scoping (Story 162 regression) ───────────────────────

describe('ClusterRoleBinding name is release-scoped (collision regression)', () => {
  it('CRB name contains the release name (not hardcoded)', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'my-release', CHART_DIR,
        '--set', 'credentialInjection.mode=sidecar',
        '--set', 'namespace=kubeclaw',
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('name: my-release-credential-broker-tokenreview');
    expect(result.stdout).not.toContain('name: kubeclaw-credential-broker-tokenreview');
  });

  it('two different release names produce two different CRB names', () => {
    const renderAs = (releaseName: string) =>
      spawnSync(
        'helm',
        [
          'template', releaseName, CHART_DIR,
          '--set', 'credentialInjection.mode=sidecar',
          '--set', 'namespace=kubeclaw',
          '--set', 'secrets.anthropicApiKey=test',
          '--set', 'redis.password=test',
        ],
        { encoding: 'utf8' },
      );

    const alpha = renderAs('alpha-release');
    const beta = renderAs('beta-release');

    expect(alpha.status, alpha.stderr).toBe(0);
    expect(beta.status, beta.stderr).toBe(0);

    expect(alpha.stdout).toContain('name: alpha-release-credential-broker-tokenreview');
    expect(beta.stdout).toContain('name: beta-release-credential-broker-tokenreview');

    // The two CRB names must differ so sibling installs never collide.
    expect(alpha.stdout).not.toContain('name: beta-release-credential-broker-tokenreview');
    expect(beta.stdout).not.toContain('name: alpha-release-credential-broker-tokenreview');
  });
});

// ─── Story-165 regression: namespace-scoped resources follow --namespace ──────
//
// Before the fix, every resource had `namespace: kubeclaw` (from values.yaml
// default) regardless of the --namespace flag, causing install collisions.
// After the fix, the helper kubeclaw.namespace resolves to .Release.Namespace
// when .Values.namespace is empty, so all resources land in the correct namespace.
describe('helm template — namespace isolation (story-165 regression)', () => {
  it('all namespace-scoped resources carry the --namespace value, never a hardcoded default', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'kubeclaw-helm-test', CHART_DIR,
        '--namespace', 'foobar-test',
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);

    // Parse out every `namespace:` line (handles both 2- and 4-space indent).
    const namespaceLines = result.stdout
      .split('\n')
      .filter((line) => /^\s+namespace:/.test(line))
      .map((line) => line.trim());

    // There must be at least one namespace-scoped resource.
    expect(namespaceLines.length).toBeGreaterThan(0);

    for (const line of namespaceLines) {
      expect(line, `Expected 'namespace: foobar-test', got: '${line}'`).toBe(
        'namespace: foobar-test',
      );
    }

    // Explicit check: the legacy default 'kubeclaw' must never appear.
    expect(result.stdout).not.toMatch(/^\s+namespace:\s+kubeclaw\s*$/m);
  });

  it('two parallel installs into different namespaces produce non-overlapping resource namespaces', () => {
    const renderNs = (releaseName: string, ns: string) =>
      spawnSync(
        'helm',
        [
          'template', releaseName, CHART_DIR,
          '--namespace', ns,
          '--set', 'secrets.anthropicApiKey=test',
          '--set', 'redis.password=test',
        ],
        { encoding: 'utf8' },
      );

    const alpha = renderNs('kubeclaw', 'kubeclaw');
    const beta = renderNs('kubeclaw-helm-test', 'kubeclaw-helm-test');

    expect(alpha.status, alpha.stderr).toBe(0);
    expect(beta.status, beta.stderr).toBe(0);

    // Alpha resources must all be in 'kubeclaw', not 'kubeclaw-helm-test'.
    const alphaNamespaceLines = alpha.stdout
      .split('\n')
      .filter((line) => /^\s+namespace:/.test(line))
      .map((line) => line.trim());
    for (const line of alphaNamespaceLines) {
      expect(line, `Alpha resource should be in kubeclaw, got: '${line}'`).toBe(
        'namespace: kubeclaw',
      );
    }

    // Beta resources must all be in 'kubeclaw-helm-test', not 'kubeclaw'.
    const betaNamespaceLines = beta.stdout
      .split('\n')
      .filter((line) => /^\s+namespace:/.test(line))
      .map((line) => line.trim());
    for (const line of betaNamespaceLines) {
      expect(
        line,
        `Beta resource should be in kubeclaw-helm-test, got: '${line}'`,
      ).toBe('namespace: kubeclaw-helm-test');
    }
  });
});

// ─── mode=istio (Istio EnvoyFilter / NetworkPolicy) ──────────────────────────

describe('helm template — mode=istio', () => {
  const render = (extraArgs = '') =>
    execSync(
      `helm template helm/kubeclaw --set credentialInjection.mode=istio --set namespace=kubeclaw ${extraArgs}`,
      { encoding: 'utf8' },
    );

  it('renders cleanly without errors', () => {
    expect(() => render()).not.toThrow();
  });

  it('renders Sidecar resource', () => {
    expect(render()).toContain('kind: Sidecar');
  });

  it('renders all 4 built-in ServiceEntry resources', () => {
    const out = render();
    const count = (out.match(/kind: ServiceEntry/g) ?? []).length;
    expect(count).toBe(4);
  });

  it('renders Gateway and VirtualService', () => {
    const out = render();
    expect(out).toContain('kind: Gateway');
    expect(out).toContain('kind: VirtualService');
  });

  it('renders EnvoyFilter for ext_authz', () => {
    const out = render();
    expect(out).toContain('kind: EnvoyFilter');
    expect(out).toContain('ext_authz');
  });

  it('Lua substitution filter in istio EnvoyFilter', () => {
    const out = render();
    expect(out).toContain('envoy.filters.http.lua');
    expect(out).toContain('x-kubeclaw-substitutions');
    // The chart renders two `envoy.filters.http.lua` filters: an early
    // `set-forwarded-authority` and the later substitution filter that reads
    // ext_authz's response headers. The substitution filter is the LAST Lua
    // occurrence, and it must come after ext_authz (INSERT_AFTER).
    const luaIdx = out.lastIndexOf('envoy.filters.http.lua');
    const authzIdx = out.indexOf('envoy.filters.http.ext_authz');
    expect(luaIdx).toBeGreaterThan(authzIdx);
  });

  it('renders 5 ServiceEntry resources with one additionalDestination', () => {
    const out = render(
      '--set "credentialInjection.istio.additionalDestinations[0]=my-mcp.internal:8443"',
    );
    const count = (out.match(/kind: ServiceEntry/g) ?? []).length;
    expect(count).toBe(5);
  });

  it('renders orchestrator with sidecar.istio.io/inject=false annotation', () => {
    const out = render();
    expect(out).toContain('sidecar.istio.io/inject: "false"');
  });

  it('does NOT render the credential-sidecar Envoy container', () => {
    const out = render();
    expect(out).not.toContain('credential-sidecar');
  });

  it('renders istio-mode NetworkPolicies', () => {
    const out = render();
    expect(out).toContain('kubeclaw-broker-ingress-istio');
  });

  it('renders egress gateway Deployment', () => {
    const out = render();
    expect(out).toContain('kubeclaw-istio-egressgateway');
  });

  it('renders Gateway with HTTP listener on port 80 (not HTTPS PASSTHROUGH)', () => {
    const out = render();
    expect(out).toMatch(/protocol:\s*HTTP\b(?!S)/);
    expect(out).toContain('number: 80');
    expect(out).not.toContain('mode: PASSTHROUGH');
  });

  it('renders VirtualService http: routes (not tls:)', () => {
    const out = render();
    expect(out).toContain('kind: VirtualService');
    expect(out).toMatch(/kind:\s*VirtualService[\s\S]+http:/);
    expect(out).not.toMatch(/kind:\s*VirtualService[\s\S]+\n\s+tls:/);
  });

  it('renders one DestinationRule per built-in HTTPS destination', () => {
    const out = render();
    for (const slug of [
      'api-anthropic-com',
      'api-openai-com',
      'openrouter-ai',
      'api-voyageai-com',
    ]) {
      expect(out).toContain(`kubeclaw-egress-tls-${slug}`);
    }
    expect(out).toMatch(/mode:\s*SIMPLE/);
    expect(out).toMatch(/caCertificates:\s*\/etc\/ssl\/certs\/ca-certificates\.crt/);
  });

  it('renders ServiceEntry with two ports per destination (workload http + upstream tls)', () => {
    const out = render();
    expect(out).toMatch(
      /name:\s*kubeclaw-egress-api-openai-com[\s\S]+number:\s*80[\s\S]+protocol:\s*HTTP[\s\S]+number:\s*443[\s\S]+protocol:\s*HTTPS/,
    );
  });

  it('Service kubeclaw-istio-egressgateway exposes port 80 (not 443)', () => {
    const out = render();
    expect(out).toMatch(
      /name:\s*kubeclaw-istio-egressgateway[\s\S]+?ports:\s*\n\s+-\s*name:\s*http\s*\n\s+port:\s*80/,
    );
  });

  it('injects http:// base URL envs into channel and capability pods', () => {
    const out = render(
      '--set channels.http.enabled=true --set "capabilities.memory.image=kubeclaw-memory:latest"',
    );
    expect(out).toContain('value: "http://api.openai.com"');
    expect(out).toContain('value: "http://api.anthropic.com"');
    expect(out).toContain('value: "http://openrouter.ai"');
    // Both pod families must carry them; the simplest check is two distinct
    // occurrences of OPENAI_BASE_URL in the rendered output.
    expect((out.match(/OPENAI_BASE_URL/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  describe('with testFixture.enabled=true', () => {
    let renderWithFixture: () => string;
    beforeAll(() => {
      renderWithFixture = () =>
        execSync(
          `helm template helm/kubeclaw \
            --set credentialInjection.mode=istio \
            --set namespace=kubeclaw \
            --set credentialInjection.istio.testFixture.enabled=true`,
          { encoding: 'utf8' },
        );
    });

    it('renders the mock-upstream Deployment and Service', () => {
      const out = renderWithFixture();
      expect(out).toContain('name: kubeclaw-mock-upstream');
      expect(out).toContain('mendhak/http-https-echo');
      expect(out).toContain('sidecar.istio.io/inject: "false"');
    });

    it('appends a ServiceEntry + Gateway server + VS routes for mock-upstream.kubeclaw-test', () => {
      const out = renderWithFixture();
      expect(out).toContain('mock-upstream.kubeclaw-test');
      expect(out).toContain('kubeclaw-egress-mock-upstream-kubeclaw-test');
    });

    it('appends a test-mock mapping to the broker ConfigMap', () => {
      const out = renderWithFixture();
      expect(out).toMatch(/id:\s*test-mock/);
      expect(out).toContain('mock-upstream.kubeclaw-test');
      expect(out).toContain('test-mock-token');
    });

    it('renders test-mock-token in the kubeclaw-secrets Secret', () => {
      const out = renderWithFixture();
      expect(out).toMatch(/test-mock-token:\s*"?(test-token-12345|dGVzdC10b2tlbi0xMjM0NQ==)"?/);
    });

    it('does NOT render a DestinationRule for the mock (HTTP upstream)', () => {
      const out = renderWithFixture();
      expect(out).not.toContain('kubeclaw-egress-tls-mock-upstream-kubeclaw-test');
    });
  });
});

// ─── Lua filter (Story 159 regression) ───────────────────────────────────────

describe('helm template — Lua substitution filter', () => {
  it('renders Lua substitution filter in sidecar mode ConfigMap', () => {
    const out = execSync(
      `helm template helm/kubeclaw --set credentialInjection.mode=sidecar --set namespace=kubeclaw`,
      { encoding: 'utf8' },
    );
    expect(out).toContain('envoy.filters.http.lua');
    expect(out).toContain('x-kubeclaw-substitutions');
    expect(out).toContain('x-kubeclaw-policy');
  });

  it('sidecar mode Lua filter appears inside the kubeclaw-envoy-sidecar ConfigMap', () => {
    const out = execSync(
      `helm template helm/kubeclaw --set credentialInjection.mode=sidecar --set namespace=kubeclaw`,
      { encoding: 'utf8' },
    );
    // Split by document separator and find the sidecar ConfigMap
    const docs = out.split(/\n---\n/);
    const sidecarCmDoc = docs.find(
      (d) =>
        d.includes('kind: ConfigMap') &&
        d.includes('name: kubeclaw-envoy-sidecar'),
    );
    expect(sidecarCmDoc).toBeDefined();
    expect(sidecarCmDoc).toContain('envoy.filters.http.lua');
    expect(sidecarCmDoc).toContain('x-kubeclaw-substitutions');
  });
});

// ─── mode=sidecar (no Istio regression) ──────────────────────────────────────

describe('helm template — mode=sidecar (no Istio regression)', () => {
  const render = () =>
    execSync(
      `helm template helm/kubeclaw --set credentialInjection.mode=sidecar --set namespace=kubeclaw --set channels.http.enabled=true`,
      { encoding: 'utf8' },
    );

  it('does NOT render Istio resources', () => {
    const out = render();
    expect(out).not.toContain('kind: Sidecar');
    expect(out).not.toContain('kind: ServiceEntry');
    expect(out).not.toContain('kind: Gateway');
    expect(out).not.toContain('kind: VirtualService');
    expect(out).not.toContain('kind: EnvoyFilter');
  });

  it('renders credential-sidecar container', () => {
    expect(render()).toContain('credential-sidecar');
  });

  it('does NOT render the test fixture even if requested', () => {
    const out = execSync(
      `helm template helm/kubeclaw \
        --set credentialInjection.mode=sidecar \
        --set namespace=kubeclaw \
        --set credentialInjection.istio.testFixture.enabled=true`,
      { encoding: 'utf8' },
    );
    expect(out).not.toContain('name: kubeclaw-mock-upstream');
    expect(out).not.toContain('mock-upstream.kubeclaw-test');
    expect(out).not.toMatch(/id:\s*test-mock/);
  });

  it('renders catalog entries in credential-broker ConfigMap', () => {
    const out = execSync(
      `helm template helm/kubeclaw \
        --set credentialInjection.mode=sidecar \
        --set 'credentialInjection.catalog[0].id=replicate' \
        --set 'credentialInjection.catalog[0].host=api.replicate.com' \
        --set 'credentialInjection.catalog[0].credentialFields[0].name=token' \
        --set 'credentialInjection.catalog[0].credentialFields[0].envVar=REPLICATE_API_TOKEN'`,
      { encoding: 'utf8' },
    );
    expect(out).toContain('id: "replicate"');
    expect(out).toContain('envVar: "REPLICATE_API_TOKEN"');
  });
});

// ─── mode=off (no regression) ────────────────────────────────────────────────

describe('helm template — mode=off (no regression)', () => {
  const render = () =>
    execSync(
      `helm template helm/kubeclaw --set credentialInjection.mode=off --set namespace=kubeclaw`,
      { encoding: 'utf8' },
    );

  it('renders cleanly', () => {
    expect(() => render()).not.toThrow();
  });

  it('does NOT render credential-broker', () => {
    const out = render();
    expect(out).not.toContain('credential-broker');
  });

  it('does NOT render any EnvoyFilter', () => {
    expect(render()).not.toContain('kind: EnvoyFilter');
  });
});

// ─── Story 182: RWX/RWO replica guardrail ────────────────────────────────────

describe('helm template — story-182 RWX/RWO replica guardrail', () => {
  const renderWith = (extraArgs: string[]) =>
    spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'redis.password=test',
        ...extraArgs,
      ],
      { encoding: 'utf8' },
    );

  it('renders HPA with maxReplicas:1 for RWO (default)', () => {
    const result = renderWith([]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('kind: HorizontalPodAutoscaler');
    expect(result.stdout).toContain('maxReplicas: 1');
    expect(result.stdout).toContain('name: kubeclaw-channel-rwo-guardrail');
  });

  it('HPA annotation names the accessModes constraint', () => {
    const result = renderWith([]);
    expect(result.status, result.stderr).toBe(0);
    // HPA annotation must name the accessModes constraint per story AC3
    expect(result.stdout).toContain('ReadWriteMany');
  });

  it('does NOT render HPA guardrail when accessModes is RWX', () => {
    const result = renderWith([
      '--set', 'bootstrap.runtimePvc.accessModes[0]=ReadWriteMany',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('kind: HorizontalPodAutoscaler');
  });

  it('RWO render includes BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES env var in orchestrator', () => {
    const result = renderWith([]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BOOTSTRAP_RUNTIME_PVC_ACCESS_MODES');
    expect(result.stdout).toContain('ReadWriteOnce');
  });

  it('RWX render includes BOOTSTRAP_STEADY_STATE_REPLICAS env var with custom value', () => {
    const result = renderWith([
      '--set', 'bootstrap.runtimePvc.accessModes[0]=ReadWriteMany',
      '--set', 'bootstrap.steadyState.defaultReplicas=3',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BOOTSTRAP_STEADY_STATE_REPLICAS');
    expect(result.stdout).toContain('"3"');
  });
});

// ─── Story 183: air-gapped npm mirror ────────────────────────────────────────

describe('helm template — bootstrap.npmRegistry (Story 183)', () => {
  const baseArgs = [
    '--set', 'secrets.anthropicApiKey=test',
    '--set', 'redis.password=test',
  ];

  it('orchestrator Deployment gets BOOTSTRAP_NPM_REGISTRY env when npmRegistry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BOOTSTRAP_NPM_REGISTRY');
    expect(result.stdout).toContain('https://npm.internal.corp');
  });

  it('orchestrator Deployment has no BOOTSTRAP_NPM_REGISTRY env when npmRegistry is empty', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...baseArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('BOOTSTRAP_NPM_REGISTRY');
  });

  it('credential-broker ConfigMap gets mirror mapping when npmRegistry and secretRef are set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set', 'bootstrap.npmRegistryAuth.secretRef=my-npm-secret',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('id: npm-mirror');
    expect(result.stdout).toContain('npm.internal.corp');
    expect(result.stdout).toContain('my-npm-secret');
    expect(result.stdout).toContain('auth-token');
  });

  it('credential-broker ConfigMap has no mirror mapping when npmRegistry is empty', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...baseArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('id: npm-mirror');
  });

  it('bootstrap NetworkPolicy removes broad port-443 allow-all when mirror and Cilium enabled', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set', 'ciliumNetworkPolicy.enabled=true',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const sections = result.stdout.split('---');
    const bootstrapSection = sections.find(
      (s) => s.includes('kubeclaw-bootstrap-policy') && s.includes('kind: NetworkPolicy'),
    );
    expect(bootstrapSection, 'kubeclaw-bootstrap-policy not found').toBeTruthy();
    // Should have no port: 443 rule when Cilium handles it
    const portLines = (bootstrapSection ?? '').split('\n').filter(
      (l) => /^\s+port:\s+443\s*$/.test(l),
    );
    expect(portLines, 'Expected no port: 443 in bootstrap NetworkPolicy when Cilium+mirror active').toHaveLength(0);
  });

  it('bootstrap NetworkPolicy keeps broad port-443 rule when mirror set but Cilium disabled', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        // ciliumNetworkPolicy.enabled defaults to false
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const sections = result.stdout.split('---');
    const bootstrapSection = sections.find(
      (s) => s.includes('kubeclaw-bootstrap-policy') && s.includes('kind: NetworkPolicy'),
    );
    expect(bootstrapSection, 'kubeclaw-bootstrap-policy not found').toBeTruthy();
    expect(bootstrapSection).toContain('port: 443');
  });

  it('bootstrap NetworkPolicy keeps broad port-443 when npmRegistry is unset (backwards compat)', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...baseArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const sections = result.stdout.split('---');
    const bootstrapSection = sections.find(
      (s) => s.includes('kubeclaw-bootstrap-policy') && s.includes('kind: NetworkPolicy'),
    );
    expect(bootstrapSection, 'kubeclaw-bootstrap-policy not found').toBeTruthy();
    expect(bootstrapSection).toContain('port: 443');
  });

  it('CiliumNetworkPolicy kubeclaw-bootstrap-egress renders when cilium enabled and mirror set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'ciliumNetworkPolicy.enabled=true',
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // Look for the actual CiliumNetworkPolicy resource name declaration
    expect(result.stdout).toContain('name: kubeclaw-bootstrap-egress');
    expect(result.stdout).toContain('npm.internal.corp');
  });

  it('kubeclaw-bootstrap-egress CiliumNetworkPolicy does not render when cilium disabled', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        // ciliumNetworkPolicy.enabled defaults to false
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // Verify the actual K8s resource name is absent (comments may mention it)
    expect(result.stdout).not.toContain('name: kubeclaw-bootstrap-egress');
  });

  it('kubeclaw-bootstrap-egress CiliumNetworkPolicy does not render when mirror is unset', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'ciliumNetworkPolicy.enabled=true',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('name: kubeclaw-bootstrap-egress');
  });

  it('registry.npmjs.org does not appear as allowed matchName in Cilium bootstrap policy', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...baseArgs,
        '--set', 'ciliumNetworkPolicy.enabled=true',
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split('\n');
    const matchNameLines = lines.filter(
      (l) => l.includes('matchName') && l.includes('registry.npmjs.org'),
    );
    expect(matchNameLines, 'registry.npmjs.org must not appear as an allowed FQDN').toHaveLength(0);
  });
});
