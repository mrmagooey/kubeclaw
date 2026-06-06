/**
 * Story 183: Air-gapped bootstrap — npm mirror via credential broker.
 *
 * AC1, AC2, AC5 require a Verdaccio in-cluster mirror pre-seeded with
 * @kubeclaw/channel-* packages. These are marked it.todo pending the
 * Verdaccio fixture (follow-on work: e2e/fixtures/verdaccio.yaml + npm publish init job).
 *
 * AC3 + AC4 are exercised here as helm-template assertions (no live cluster required).
 * Live kubectl exec assertions are also it.todo pending the Verdaccio fixture.
 *
 * Pattern: e2e/minikube-live-admin-shell.test.ts for cluster setup, kubectl helpers.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

const CHART_DIR = './helm/kubeclaw';
const BASE_HELM_ARGS = [
  '--set', 'secrets.anthropicApiKey=test',
  '--set', 'secrets.claudeCodeOauthToken=test',
  '--set', 'redis.password=test',
];

// ─── AC1: bootstrap pod env carries NPM_CONFIG_REGISTRY ──────────────────────

describe('AC1: bootstrap pod npm config points at mirror (helm template assertion)', () => {
  it('orchestrator env carries BOOTSTRAP_NPM_REGISTRY when bootstrap.npmRegistry is set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('BOOTSTRAP_NPM_REGISTRY');
    expect(result.stdout).toContain('https://npm.internal.corp');
  });

  it('BOOTSTRAP_NPM_REGISTRY is absent from orchestrator env when bootstrap.npmRegistry is empty (backwards compat)', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...BASE_HELM_ARGS],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('BOOTSTRAP_NPM_REGISTRY');
  });

  // TODO(Story 183 follow-on): Verdaccio-based live test.
  // Requires: Verdaccio Deployment + Service in test namespace, pre-seeded
  // with @kubeclaw/channel-* tarballs, and a K8s Secret with auth-token.
  // Run: helm upgrade --set bootstrap.npmRegistry=http://verdaccio.<ns>.svc:4873 ...
  it.todo('AC1 live: npm ci log from bootstrap pod SSE stream contains info reify registry: https://<mirror>');
});

// ─── AC2: credential broker stamps Authorization: Bearer ─────────────────────

describe('AC2: credential-broker ConfigMap contains mirror mapping', () => {
  it('ConfigMap renders npm-mirror mapping when npmRegistry and secretRef are set', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
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
    expect(result.stdout).toContain('headerScheme: bearer');
  });

  it('ConfigMap has no npm-mirror mapping when npmRegistry is empty', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...BASE_HELM_ARGS],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('id: npm-mirror');
  });

  // TODO(Story 183 follow-on): Verdaccio-based live test.
  // Assert: credential_broker_authz_total{destination="<mirror>",status="200"} >= 1
  // Pattern: e2e/credential-broker-authz.test.ts metric assertion via curl /metrics
  it.todo('AC2 live: broker metric credential_broker_authz_total{destination="<mirror>",status="200"} increments');
});

// ─── AC3: bootstrap pod NetworkPolicy ────────────────────────────────────────

describe('AC3: bootstrap NetworkPolicy restricts egress when mirror is configured', () => {
  it('bootstrap NetworkPolicy removes broad port-443 allow-all when mirror and Cilium enabled', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
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
    // With Cilium handling FQDN egress, the standard NetworkPolicy must not include port: 443
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
        ...BASE_HELM_ARGS,
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

  it('CiliumNetworkPolicy kubeclaw-bootstrap-egress renders with mirror host in toFQDNs', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
        '--set', 'ciliumNetworkPolicy.enabled=true',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('name: kubeclaw-bootstrap-egress');
    expect(result.stdout).toContain('npm.internal.corp');
    // registry.npmjs.org must not appear as a matchName (allowed FQDN)
    const lines = result.stdout.split('\n');
    const matchNameLines = lines.filter(
      (l) => l.includes('matchName') && l.includes('registry.npmjs.org'),
    );
    expect(
      matchNameLines,
      'registry.npmjs.org must not be in the Cilium bootstrap FQDN allowlist',
    ).toHaveLength(0);
  });

  // TODO(Story 183 follow-on): live cluster assertion via kubectl exec
  it.todo('AC3 live: curl registry.npmjs.org from bootstrap pod times out (NetworkPolicy block)');
  it.todo('AC3 live: curl <mirror-host>/ from bootstrap pod succeeds (HTTP reachable)');
});

// ─── AC4: steady-state channel pod NetworkPolicy denies registries ───────────

describe('AC4: steady-state channel pod NetworkPolicy denies npm registries', () => {
  it('Cilium channel policy excludes registry.npmjs.org from allowlist when mirror configured', () => {
    const result = spawnSync(
      'helm',
      [
        'template', 'smoke', CHART_DIR,
        ...BASE_HELM_ARGS,
        '--set', 'ciliumNetworkPolicy.enabled=true',
        '--set', 'bootstrap.npmRegistry=https://npm.internal.corp',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // registry.npmjs.org and registry.yarnpkg.com must not appear as matchName
    // allowed FQDNs in any Cilium policy section
    const lines = result.stdout.split('\n');
    const allowedFqdnMatchLines = lines.filter(
      (l) =>
        l.includes('matchName') &&
        (l.includes('registry.npmjs.org') || l.includes('registry.yarnpkg.com')),
    );
    expect(
      allowedFqdnMatchLines,
      'registry.npmjs.org / registry.yarnpkg.com must not be allowed FQDNs in any Cilium policy',
    ).toHaveLength(0);
  });

  it('channel policy comment documents hostname-deny limitation of standard K8s NetworkPolicy', () => {
    const result = spawnSync(
      'helm',
      ['template', 'smoke', CHART_DIR, ...BASE_HELM_ARGS],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    // The channel NetworkPolicy must include a comment explaining the limitation
    expect(result.stdout).toContain('hostname-based deny rules');
  });

  // TODO(Story 183 follow-on): live cluster assertion via kubectl exec
  it.todo('AC4 live: curl registry.npmjs.org from channel pod fails (NetworkPolicy block)');
  it.todo('AC4 live: curl <mirror-host>/ from channel pod fails (channel pod blocked from mirror)');
});

// ─── AC5: no traffic to registry.npmjs.org during full bootstrap ─────────────

describe('AC5: no public registry traffic during bootstrap with mirror (Verdaccio)', () => {
  // All ACs here require a live Verdaccio in-cluster mirror.
  // Follow-on work: e2e/fixtures/verdaccio.yaml + npm publish init job.
  // Pattern: e2e/credential-broker.test.ts buildBrokerImage + per-test cluster.
  it.todo('AC5a live: credential_broker_authz_total{destination="registry.npmjs.org"} stays at 0');
  it.todo('AC5b live: credential_broker_authz_total{destination="<verdaccio>",status="200"} >= 1');
  it.todo('AC5c live: /runtime/node_modules/ contains @kubeclaw/channel-<type> after install');
  it.todo('AC5d live: npm ci integrity passes (xfail on EINTEGRITY with Verdaccio misconfiguration note)');
});
