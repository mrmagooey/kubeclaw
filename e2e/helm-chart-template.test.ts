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
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'secrets.anthropicApiKey=test',
        '--set',
        'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    for (const kind of [
      'StatefulSet',
      'Deployment',
      'NetworkPolicy',
      'PersistentVolumeClaim',
      'ConfigMap',
      'Secret',
      'ServiceAccount',
      'Role',
      'RoleBinding',
    ]) {
      expect(result.stdout, `missing kind: ${kind}`).toContain(`kind: ${kind}`);
    }
  });

  it('imagePullPolicy is Always when image.registry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'image.registry=registry.example.com',
        '--set',
        'secrets.anthropicApiKey=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'registry.example.com/kubeclaw-orchestrator',
    );
    expect(result.stdout).toContain('imagePullPolicy: Always');
  });

  it('omits kubeclaw-secrets when existingSecret is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'secrets.existingSecret=my-secret',
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
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'networkPolicy.enabled=false',
        '--set',
        'secrets.anthropicApiKey=test',
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
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'storage.storageClass=efs-sc',
        '--set',
        'secrets.anthropicApiKey=test',
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
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'storage.accessMode=ReadWriteMany',
        '--set',
        'secrets.anthropicApiKey=test',
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
        'template',
        'my-release',
        CHART_DIR,
        '--set',
        'credentialInjection.mode=sidecar',
        '--set',
        'namespace=kubeclaw',
        '--set',
        'secrets.anthropicApiKey=test',
        '--set',
        'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'name: my-release-credential-broker-tokenreview',
    );
    expect(result.stdout).not.toContain(
      'name: kubeclaw-credential-broker-tokenreview',
    );
  });

  it('two different release names produce two different CRB names', () => {
    const renderAs = (releaseName: string) =>
      spawnSync(
        'helm',
        [
          'template',
          releaseName,
          CHART_DIR,
          '--set',
          'credentialInjection.mode=sidecar',
          '--set',
          'namespace=kubeclaw',
          '--set',
          'secrets.anthropicApiKey=test',
          '--set',
          'redis.password=test',
        ],
        { encoding: 'utf8' },
      );

    const alpha = renderAs('alpha-release');
    const beta = renderAs('beta-release');

    expect(alpha.status, alpha.stderr).toBe(0);
    expect(beta.status, beta.stderr).toBe(0);

    expect(alpha.stdout).toContain(
      'name: alpha-release-credential-broker-tokenreview',
    );
    expect(beta.stdout).toContain(
      'name: beta-release-credential-broker-tokenreview',
    );

    // The two CRB names must differ so sibling installs never collide.
    expect(alpha.stdout).not.toContain(
      'name: beta-release-credential-broker-tokenreview',
    );
    expect(beta.stdout).not.toContain(
      'name: alpha-release-credential-broker-tokenreview',
    );
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
        'template',
        'kubeclaw-helm-test',
        CHART_DIR,
        '--namespace',
        'foobar-test',
        '--set',
        'secrets.anthropicApiKey=test',
        '--set',
        'redis.password=test',
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
          'template',
          releaseName,
          CHART_DIR,
          '--namespace',
          ns,
          '--set',
          'secrets.anthropicApiKey=test',
          '--set',
          'redis.password=test',
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
    expect(out).toMatch(
      /caCertificates:\s*\/etc\/ssl\/certs\/ca-certificates\.crt/,
    );
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
    expect((out.match(/OPENAI_BASE_URL/g) ?? []).length).toBeGreaterThanOrEqual(
      2,
    );
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
      expect(out).toMatch(
        /test-mock-token:\s*"?(test-token-12345|dGVzdC10b2tlbi0xMjM0NQ==)"?/,
      );
    });

    it('does NOT render a DestinationRule for the mock (HTTP upstream)', () => {
      const out = renderWithFixture();
      expect(out).not.toContain(
        'kubeclaw-egress-tls-mock-upstream-kubeclaw-test',
      );
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
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'secrets.anthropicApiKey=test',
        '--set',
        'redis.password=test',
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
      '--set',
      'bootstrap.runtimePvc.accessModes[0]=ReadWriteMany',
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
      '--set',
      'bootstrap.runtimePvc.accessModes[0]=ReadWriteMany',
      '--set',
      'bootstrap.steadyState.defaultReplicas=3',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BOOTSTRAP_STEADY_STATE_REPLICAS');
    expect(result.stdout).toContain('"3"');
  });
});

// ─── Story 183: air-gapped npm mirror ────────────────────────────────────────

describe('helm template — bootstrap.npmRegistry (Story 183)', () => {
  const baseArgs = [
    '--set',
    'secrets.anthropicApiKey=test',
    '--set',
    'redis.password=test',
  ];

  it('orchestrator Deployment gets BOOTSTRAP_NPM_REGISTRY env when npmRegistry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'bootstrap.npmRegistry=https://npm.internal.corp',
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
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set',
        'bootstrap.npmRegistryAuth.secretRef=my-npm-secret',
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
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set',
        'ciliumNetworkPolicy.enabled=true',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const sections = result.stdout.split('---');
    const bootstrapSection = sections.find(
      (s) =>
        s.includes('kubeclaw-bootstrap-policy') &&
        s.includes('kind: NetworkPolicy'),
    );
    expect(
      bootstrapSection,
      'kubeclaw-bootstrap-policy not found',
    ).toBeTruthy();
    // Should have no port: 443 rule when Cilium handles it
    const portLines = (bootstrapSection ?? '')
      .split('\n')
      .filter((l) => /^\s+port:\s+443\s*$/.test(l));
    expect(
      portLines,
      'Expected no port: 443 in bootstrap NetworkPolicy when Cilium+mirror active',
    ).toHaveLength(0);
  });

  it('bootstrap NetworkPolicy keeps broad port-443 rule when mirror set but Cilium disabled', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'bootstrap.npmRegistry=https://npm.internal.corp',
        // ciliumNetworkPolicy.enabled defaults to false
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const sections = result.stdout.split('---');
    const bootstrapSection = sections.find(
      (s) =>
        s.includes('kubeclaw-bootstrap-policy') &&
        s.includes('kind: NetworkPolicy'),
    );
    expect(
      bootstrapSection,
      'kubeclaw-bootstrap-policy not found',
    ).toBeTruthy();
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
      (s) =>
        s.includes('kubeclaw-bootstrap-policy') &&
        s.includes('kind: NetworkPolicy'),
    );
    expect(
      bootstrapSection,
      'kubeclaw-bootstrap-policy not found',
    ).toBeTruthy();
    expect(bootstrapSection).toContain('port: 443');
  });

  it('CiliumNetworkPolicy kubeclaw-bootstrap-egress renders when cilium enabled and mirror set', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'ciliumNetworkPolicy.enabled=true',
        '--set',
        'bootstrap.npmRegistry=https://npm.internal.corp',
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
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'bootstrap.npmRegistry=https://npm.internal.corp',
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
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'ciliumNetworkPolicy.enabled=true',
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
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'ciliumNetworkPolicy.enabled=true',
        '--set',
        'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split('\n');
    const matchNameLines = lines.filter(
      (l) => l.includes('matchName') && l.includes('registry.npmjs.org'),
    );
    expect(
      matchNameLines,
      'registry.npmjs.org must not appear as an allowed FQDN',
    ).toHaveLength(0);
  });
});

// ─── Story-174 regression: bootstrap RBAC namespace uses kubeclaw.namespace helper ───
//
// Before the fix, bootstrap-rbac.yaml used .Values.namespace directly, which
// renders as an empty string when --set namespace=... is omitted. This causes
// Role/RoleBinding/ServiceAccount to land in the wrong namespace.
// After the fix, the helper is used, falling back to .Release.Namespace.
describe('helm template — bootstrap RBAC namespace (story-174 regression)', () => {
  it('bootstrap ServiceAccount, Role, and RoleBinding render with the release namespace, not empty', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'kubeclaw',
        'helm/kubeclaw',
        '--namespace',
        'kubeclaw',
        '--set',
        'secrets.anthropicApiKey=test',
        '--set',
        'redis.password=test',
      ],
      { encoding: 'utf8', cwd: process.cwd() },
    );
    expect(result.status, result.stderr).toBe(0);

    // Parse the output into per-document blocks for precise assertions.
    const docs = result.stdout.split(/\n---\n/);

    const saDoc = docs.find(
      (d) =>
        d.includes('kind: ServiceAccount') &&
        d.includes('name: kubeclaw-bootstrap'),
    );
    expect(saDoc, 'kubeclaw-bootstrap ServiceAccount not found').toBeDefined();
    expect(saDoc).toContain('namespace: kubeclaw');
    expect(saDoc).not.toMatch(/namespace:\s*$/m);

    const roleDoc = docs.find(
      (d) =>
        d.includes('kind: Role') && d.includes('name: kubeclaw-bootstrap-role'),
    );
    expect(roleDoc, 'kubeclaw-bootstrap-role Role not found').toBeDefined();
    expect(roleDoc).toContain('namespace: kubeclaw');
    expect(roleDoc).not.toMatch(/namespace:\s*$/m);

    const rbDoc = docs.find(
      (d) =>
        d.includes('kind: RoleBinding') &&
        d.includes('name: kubeclaw-bootstrap-rolebinding'),
    );
    expect(
      rbDoc,
      'kubeclaw-bootstrap-rolebinding RoleBinding not found',
    ).toBeDefined();
    expect(rbDoc).toContain('namespace: kubeclaw');
    // The subjects[].namespace must also be set correctly.
    expect(rbDoc).not.toMatch(/namespace:\s*$/m);
  });

  it('bootstrap RBAC resources use .Release.Namespace when .Values.namespace is unset', () => {
    // When --namespace foobar is given but namespace= is NOT set via --set,
    // the helper must fall back to .Release.Namespace == foobar.
    const result = spawnSync(
      'helm',
      [
        'template',
        'kubeclaw',
        'helm/kubeclaw',
        '--namespace',
        'foobar',
        '--set',
        'secrets.anthropicApiKey=test',
        '--set',
        'redis.password=test',
        // NOTE: intentionally NOT setting --set namespace=...
      ],
      { encoding: 'utf8', cwd: process.cwd() },
    );
    expect(result.status, result.stderr).toBe(0);

    // No empty namespace: lines anywhere in the output.
    const emptyNsLines = result.stdout
      .split('\n')
      .filter((l) => /^\s+namespace:\s*$/.test(l));
    expect(
      emptyNsLines,
      `Found empty namespace: lines: ${JSON.stringify(emptyNsLines)}`,
    ).toHaveLength(0);

    // Bootstrap resources must all be in 'foobar'.
    const docs = result.stdout.split(/\n---\n/);
    for (const name of [
      'kubeclaw-bootstrap',
      'kubeclaw-bootstrap-role',
      'kubeclaw-bootstrap-rolebinding',
    ]) {
      const doc = docs.find((d) => d.includes(`name: ${name}`));
      expect(doc, `${name} document not found`).toBeDefined();
      expect(doc, `${name} should have namespace: foobar`).toContain(
        'namespace: foobar',
      );
    }
  });
});

// ─── SP2 Task 7: Qdrant StatefulSet removed from Helm chart ──────────────────
//
// Qdrant is now an installable capability, not baked into the chart.
// Verify that neither the default render nor --set rag.enabled=true resurrects it.

describe('helm template — no baked Qdrant StatefulSet (SP2 task 7)', () => {
  it('does not render a baked Qdrant StatefulSet', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'secrets.anthropicApiKey=test',
        '--set',
        'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('name: kubeclaw-qdrant');
    expect(result.stdout).not.toContain('QDRANT_URL');
  });

  it('rag.enabled=true no longer resurrects a baked Qdrant (value is gone)', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        '--set',
        'secrets.anthropicApiKey=test',
        '--set',
        'redis.password=test',
        '--set',
        'rag.enabled=true',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('name: kubeclaw-qdrant');
  });
});

// ─── channel Service independent of networkPolicy (bug-fix regression) ────────
//
// Before the fix, the channel Service and metrics Service were nested inside
// {{- if and $cfg.httpPort $.Values.networkPolicy.enabled }}, so disabling
// networkPolicy deleted the channel Service and made the channel unreachable.
// After the fix: only the ingress NetworkPolicy depends on networkPolicy.enabled;
// the channel Service renders whenever httpPort is set; the metrics Service
// always renders (per enabled channel).

describe('channel Service independent of networkPolicy', () => {
  const baseArgs = [
    '--set',
    'secrets.anthropicApiKey=test',
    '--set',
    'redis.password=test',
    '--set',
    'channels.http.enabled=true',
    '--set',
    'channels.http.type=http',
    '--set',
    'channels.http.httpPort=8080',
  ];

  it('with networkPolicy.enabled=false: renders channel Service and metrics Service, no ingress NetworkPolicy', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'networkPolicy.enabled=false',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);

    // Assert the channel Service document exists (kind:Service + name match),
    // not just the name string which also appears on Deployment/SA/Secret.
    const docs = result.stdout.split(/\n---\n/);
    const channelSvcDoc = docs.find(
      (d) =>
        /^kind: Service$/m.test(d) &&
        /^\s+name: kubeclaw-channel-http$/m.test(d),
    );
    expect(
      channelSvcDoc,
      'channel Service (kind: Service, name: kubeclaw-channel-http) not found',
    ).toBeDefined();
    // The channel Service must expose the http port mapping.
    expect(channelSvcDoc).toContain('port: 80');
    expect(channelSvcDoc).toContain('targetPort: http');

    expect(result.stdout).toContain('name: kubeclaw-channel-http-metrics');
    expect(result.stdout).not.toContain('name: kubeclaw-channel-http-ingress');
    expect(result.stdout).not.toContain('kind: NetworkPolicy');
  });

  it('with networkPolicy.enabled=true: renders channel Service, metrics Service, AND ingress NetworkPolicy', () => {
    const result = spawnSync(
      'helm',
      [
        'template',
        'smoke',
        CHART_DIR,
        ...baseArgs,
        '--set',
        'networkPolicy.enabled=true',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);

    // Assert the channel Service document exists (kind:Service + name match),
    // not just the name string which also appears on Deployment/SA/Secret.
    const docs = result.stdout.split(/\n---\n/);
    const channelSvcDoc = docs.find(
      (d) =>
        /^kind: Service$/m.test(d) &&
        /^\s+name: kubeclaw-channel-http$/m.test(d),
    );
    expect(
      channelSvcDoc,
      'channel Service (kind: Service, name: kubeclaw-channel-http) not found',
    ).toBeDefined();
    // The channel Service must expose the http port mapping.
    expect(channelSvcDoc).toContain('port: 80');
    expect(channelSvcDoc).toContain('targetPort: http');

    expect(result.stdout).toContain('name: kubeclaw-channel-http-metrics');
    expect(result.stdout).toContain('name: kubeclaw-channel-http-ingress');
    expect(result.stdout).toContain('kind: NetworkPolicy');
  });

  it('channel pod renders stage-runtime init container, channel-src volume, and /runtime mount', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...baseArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);

    // Find the channel Deployment document.
    const docs = result.stdout.split(/\n---\n/);
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-http$/m.test(d),
    );
    expect(
      deployDoc,
      'channel Deployment (kind: Deployment, name: kubeclaw-channel-http) not found',
    ).toBeDefined();

    // (a) stage-runtime init container must be present.
    expect(deployDoc).toContain('name: stage-runtime');

    // (b) channel-src volume must reference the kubeclaw-channel-src ConfigMap.
    expect(deployDoc).toContain('name: channel-src');
    expect(deployDoc).toContain('name: kubeclaw-channel-src');

    // (c) main container must mount /runtime.
    expect(deployDoc).toContain('mountPath: /runtime');
  });
});

// ─── Channel manifest sidecar rendering ─────────────────────────────────────
//
// When a channel type's manifest declares a `sidecar`, the Helm chart must:
//   1. Add the aux-backend container to the channel Deployment
//   2. Add the auxsession PVC to storage.yaml
//   3. Add a per-channel sidecar-egress NetworkPolicy
//   4. Inject fsGroup: 1000 into the pod securityContext
//   5. Leave channels WITHOUT a sidecar unchanged (1 container, no auxsession)

describe('channel manifest sidecar rendering', () => {
  // Build helm args that inject a sidecar manifest for the "signal" channel type.
  // Using --set for nested objects requires escaping; easier as individual --set flags.
  const sidecarArgs = [
    '--set', 'channels.signal.enabled=true',
    '--set', 'channels.signal.type=signal',
    '--set', 'bootstrap.channelManifests.signal.packageJson={"name":"runtime"}',
    '--set', 'bootstrap.channelManifests.signal.packageLockJson={}',
    '--set', 'bootstrap.channelManifests.signal.manifestHash=testhash',
    '--set', 'bootstrap.channelManifests.signal.hostMode=channel-runner',
    '--set', 'bootstrap.channelManifests.signal.sidecar.image=registry.example.com/signal-backend:latest',
    '--set', 'bootstrap.channelManifests.signal.sidecar.port=8080',
    '--set', 'bootstrap.channelManifests.signal.sidecar.sessionMountPath=/root/.local/share/signal-cli',
    '--set', 'bootstrap.channelManifests.signal.sidecar.sessionStorageGi=2',
    '--set', 'bootstrap.channelManifests.signal.sidecar.healthPath=/.well-known/health',
    '--set', 'bootstrap.channelManifests.signal.sidecar.apiUrlEnv=SIGNAL_CLI_REST_API_URL',
    '--set', 'bootstrap.channelManifests.signal.sidecar.egressPorts[0]=8080',
    '--set', 'networkPolicy.enabled=true',
    '--set', 'secrets.anthropicApiKey=test',
    '--set', 'redis.password=test',
  ];

  let rendered: string;
  let docs: string[];

  beforeAll(() => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...sidecarArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, `helm template failed: ${result.stderr}`).toBe(0);
    rendered = result.stdout;
    docs = rendered.split(/\n---\n/);
  });

  it('renders the aux-backend container in the channel Deployment', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc, 'channel signal Deployment not found').toBeDefined();
    expect(deployDoc).toContain('name: signal-backend');
    expect(deployDoc).toContain('image: registry.example.com/signal-backend:latest');
    expect(deployDoc).toContain('containerPort: 8080');
  });

  it('aux-backend container has hardened securityContext; without runAsUser, omits runAsNonRoot', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc).toBeDefined();
    // Always-present hardening fields
    expect(deployDoc).toContain('allowPrivilegeEscalation: false');
    expect(deployDoc).toContain('readOnlyRootFilesystem: false');
    // When runAsUser is NOT set in the sidecar spec → neither runAsUser nor runAsNonRoot
    // should appear in the backend container's securityContext section.
    const backendStart = deployDoc!.indexOf('name: signal-backend');
    const backendSection = deployDoc!.slice(backendStart, backendStart + 800);
    expect(backendSection).not.toContain('runAsUser');
    expect(backendSection).not.toContain('runAsNonRoot');
  });

  it('aux-backend container has readiness and liveness probes when healthPath set', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc).toBeDefined();
    expect(deployDoc).toContain('readinessProbe');
    expect(deployDoc).toContain('livenessProbe');
    expect(deployDoc).toContain('path: /.well-known/health');
  });

  it('auxsession volume is added to the Deployment pod volumes', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc).toBeDefined();
    expect(deployDoc).toContain('name: auxsession');
    expect(deployDoc).toContain('claimName: kubeclaw-channel-signal-auxsession');
  });

  it('pod securityContext has fsGroup: 1000 when sidecar is present', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc).toBeDefined();
    expect(deployDoc).toContain('fsGroup: 1000');
  });

  it('apiUrlEnv is injected into the channel container env', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc).toBeDefined();
    expect(deployDoc).toContain('SIGNAL_CLI_REST_API_URL');
    expect(deployDoc).toContain('http://localhost:8080');
  });

  it('auxsession PVC is rendered in storage.yaml', () => {
    const pvcDoc = docs.find(
      (d) =>
        /^kind: PersistentVolumeClaim$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal-auxsession$/m.test(d),
    );
    expect(pvcDoc, 'auxsession PVC not found').toBeDefined();
    expect(pvcDoc).toContain('2Gi');
    expect(pvcDoc).toContain('ReadWriteOnce');
  });

  it('per-channel sidecar-egress NetworkPolicy is rendered with declared egressPorts', () => {
    const npDoc = docs.find(
      (d) =>
        /^kind: NetworkPolicy$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal-sidecar-egress$/m.test(d),
    );
    expect(npDoc, 'sidecar-egress NetworkPolicy not found').toBeDefined();
    expect(npDoc).toContain('port: 8080');
    expect(npDoc).toContain('policyTypes');
    expect(npDoc).toContain('Egress');
  });

  it('channel WITHOUT a sidecar renders 1 container and no auxsession PVC', () => {
    // Use the existing http channel base args — no sidecar manifest set for "http"
    const noSidecarArgs = [
      '--set', 'channels.http.enabled=true',
      '--set', 'channels.http.type=http',
      '--set', 'channels.http.httpPort=8080',
      '--set', 'secrets.anthropicApiKey=test',
      '--set', 'redis.password=test',
    ];
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...noSidecarArgs],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);

    const allDocs = result.stdout.split(/\n---\n/);

    // No auxsession PVC
    const auxPvc = allDocs.find(
      (d) =>
        /^kind: PersistentVolumeClaim$/m.test(d) &&
        d.includes('auxsession'),
    );
    expect(auxPvc, 'auxsession PVC should not be rendered for channel without sidecar').toBeUndefined();

    // No sidecar-egress NetworkPolicy
    const sidecarNetpol = allDocs.find(
      (d) =>
        /^kind: NetworkPolicy$/m.test(d) &&
        d.includes('sidecar-egress'),
    );
    expect(sidecarNetpol, 'sidecar-egress NetworkPolicy should not render without sidecar').toBeUndefined();

    // No fsGroup in pod securityContext
    const deployDoc = allDocs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-http$/m.test(d),
    );
    expect(deployDoc, 'http channel Deployment not found').toBeDefined();
    expect(deployDoc).not.toContain('fsGroup');

    // Only one named container (not counting credential-sidecar in off mode)
    // channel container present, no backend container
    expect(deployDoc).not.toContain('-backend');
  });
});

// ─── Signal channel: per-channel sidecar migration ───────────────────────────
//
// After migrating Signal off the shared kubeclaw-signal-cli StatefulSet:
//   1. The signal manifest's sidecar field causes the channel pod to include
//      a signal-backend container + auxsession PVC + 443 egress netpol.
//   2. NO kubeclaw-signal-cli StatefulSet or Service is rendered anywhere.
//   3. SIGNAL_API_URL is injected as http://localhost:8080 (apiUrlEnv).
//
// We render with values-minikube.yaml (which includes the full signal sidecar
// manifest) plus channels.signal.enabled=true to activate the channel.

describe('signal channel: per-channel sidecar migration (no shared StatefulSet)', () => {
  // Use values-minikube.yaml which has the full signal sidecar manifest defined.
  const MINIKUBE_VALUES = './helm/kubeclaw/values-minikube.yaml';

  let rendered: string;
  let docs: string[];

  beforeAll(() => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        '-f', MINIKUBE_VALUES,
        '--set', 'channels.signal.enabled=true',
        '--set', 'channels.signal.type=signal',
        '--set', 'networkPolicy.enabled=true',
        '--set', 'secrets.anthropicApiKey=test',
        '--set', 'redis.password=test',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, `helm template failed: ${result.stderr}`).toBe(0);
    rendered = result.stdout;
    docs = rendered.split(/\n---\n/);
  });

  it('renders NO kubeclaw-signal-cli StatefulSet', () => {
    const signalCliSS = docs.find(
      (d) =>
        /^kind: StatefulSet$/m.test(d) &&
        d.includes('kubeclaw-signal-cli'),
    );
    expect(signalCliSS, 'kubeclaw-signal-cli StatefulSet must not exist').toBeUndefined();
  });

  it('renders NO kubeclaw-signal-cli Service', () => {
    const signalCliSvc = docs.find(
      (d) =>
        /^kind: Service$/m.test(d) &&
        /^\s+name: kubeclaw-signal-cli$/m.test(d),
    );
    expect(signalCliSvc, 'kubeclaw-signal-cli Service must not exist').toBeUndefined();
  });

  it('renders the signal-backend sidecar container in the channel Deployment', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc, 'signal channel Deployment not found').toBeDefined();
    expect(deployDoc).toContain('name: signal-backend');
    expect(deployDoc).toContain('image: bbernhard/signal-cli-rest-api:0.93');
  });

  it('injects SIGNAL_API_URL=http://localhost:8080 into the channel container env', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc, 'signal channel Deployment not found').toBeDefined();
    expect(deployDoc).toContain('SIGNAL_API_URL');
    expect(deployDoc).toContain('http://localhost:8080');
  });

  it('renders the auxsession PVC for the signal channel', () => {
    const pvcDoc = docs.find(
      (d) =>
        /^kind: PersistentVolumeClaim$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal-auxsession$/m.test(d),
    );
    expect(pvcDoc, 'signal auxsession PVC not found').toBeDefined();
    expect(pvcDoc).toContain('5Gi');
  });

  it('renders a per-channel sidecar-egress NetworkPolicy allowing port 443', () => {
    const npDoc = docs.find(
      (d) =>
        /^kind: NetworkPolicy$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal-sidecar-egress$/m.test(d),
    );
    expect(npDoc, 'signal sidecar-egress NetworkPolicy not found').toBeDefined();
    expect(npDoc).toContain('port: 443');
  });

  it('renders fsGroup: 1000 in pod securityContext', () => {
    const deployDoc = docs.find(
      (d) =>
        /^kind: Deployment$/m.test(d) &&
        /^\s+name: kubeclaw-channel-signal$/m.test(d),
    );
    expect(deployDoc).toBeDefined();
    expect(deployDoc).toContain('fsGroup: 1000');
  });
});

// ─── Task 9: database capability wiring ───────────────────────────────────────
//
// Verifies that the `capabilities.database` entry in values.yaml carries all
// required fields for the postgres-mcp capability.

describe('helm values — database capability declared correctly', () => {
  it('renders a database capability: group-scoped, pinned, postgres sidecar, read-only by default', () => {
    // Load values.yaml directly and assert on the structured values object.
    // This avoids a full helm template render and keeps the test fast.
    const { execSync } = require('child_process');
    const yaml = require('js-yaml');
    const fs = require('fs');
    const valuesRaw = fs.readFileSync('./helm/kubeclaw/values.yaml', 'utf-8');
    const values = yaml.load(valuesRaw) as Record<string, unknown>;
    const db = (values.capabilities as Record<string, unknown>).database as Record<string, unknown>;
    expect(db.kind).toBe('mcp');
    expect(db.scope).toBe('group');
    expect(db.pinned).toBe(true);
    expect(db.credentialsFrom).toBe('secret');
    const sidecars = db.sidecars as Array<Record<string, unknown>>;
    expect(sidecars?.[0]?.name).toBe('postgres');
    const storage = db.storage as Record<string, unknown>;
    expect(storage?.container).toBe('postgres');
    expect(db.allowedTools).toEqual(['query']);
    const env = db.env as Record<string, unknown>;
    expect(env?.PG_RO_USER).toBe('kubeclaw_ro');
  });
});
