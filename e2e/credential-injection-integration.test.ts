/**
 * Spec invariant tests for the credential-injection per-group secret-management feature.
 *
 * These are purely static helm-template checks — no live cluster required.
 * They verify two invariants:
 *
 *   1. Cross-mode regression — mode=sidecar must NOT render EnvoyFilter;
 *      mode=istio MUST render EnvoyFilter containing the Lua substitution filter.
 *
 *   2. Secret-scrub invariant — rendering the full chart in either mode with a
 *      non-empty catalog must not leak any user-supplied secret values into the
 *      YAML output.  The catalog carries only metadata (ids, hosts, field names);
 *      actual credential values live in per-group K8s Secrets that the chart
 *      never renders.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

// Patterns that look like real API keys.  If any match appears in rendered chart
// YAML the test fails — the chart should never embed these.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,   // OpenAI / Anthropic style
  /r8_[A-Za-z0-9]{20,}/,   // Replicate style
];

/** Run `helm template` and return the rendered YAML.  Throws on non-zero exit. */
function helmTemplate(extraArgs: string): string {
  return execSync(
    `helm template smoke helm/kubeclaw --set namespace=kubeclaw --set secrets.anthropicApiKey=test --set secrets.claudeCodeOauthToken=test --set redis.password=test ${extraArgs}`,
    { encoding: 'utf8' },
  );
}

/** A catalog with one entry so the broker ConfigMap is non-trivially populated. */
const CATALOG_ARGS =
  `--set 'credentialInjection.catalog[0].id=replicate'` +
  ` --set 'credentialInjection.catalog[0].host=api.replicate.com'` +
  ` --set 'credentialInjection.catalog[0].credentialFields[0].name=token'` +
  ` --set 'credentialInjection.catalog[0].credentialFields[0].envVar=REPLICATE_API_TOKEN'`;

// ─── 1. Cross-mode regression ─────────────────────────────────────────────────

describe('cross-mode regression: EnvoyFilter presence', () => {
  it('mode=sidecar does NOT render any EnvoyFilter resource', () => {
    const out = helmTemplate(`--set credentialInjection.mode=sidecar ${CATALOG_ARGS}`);
    expect(out).not.toContain('kind: EnvoyFilter');
  });

  it('mode=istio DOES render an EnvoyFilter with the Lua substitution filter', () => {
    const out = helmTemplate(`--set credentialInjection.mode=istio ${CATALOG_ARGS}`);
    expect(out).toContain('kind: EnvoyFilter');
    // The EnvoyFilter must embed the Lua substitution filter
    expect(out).toContain('envoy.filters.http.lua');
    expect(out).toContain('x-kubeclaw-substitutions');
  });
});

// ─── 2. Secret-scrub invariant ────────────────────────────────────────────────

describe('secret-scrub invariant: no user-supplied secrets in rendered YAML', () => {
  for (const mode of ['sidecar', 'istio'] as const) {
    it(`mode=${mode}: rendered chart contains no patterns matching real API keys`, () => {
      const out = helmTemplate(`--set credentialInjection.mode=${mode} ${CATALOG_ARGS}`);

      for (const pattern of SECRET_PATTERNS) {
        const match = out.match(pattern);
        expect(
          match,
          `Found a string matching ${pattern} in rendered chart output for mode=${mode}: "${match?.[0]}"`,
        ).toBeNull();
      }
    });
  }
});

// ─── 3. Brave Search catalog entry ───────────────────────────────────────────

describe('brave-search catalog entry renders correctly', () => {
  const BRAVE_CATALOG_ARGS =
    `--set 'credentialInjection.catalog[0].id=brave-search'` +
    ` --set 'credentialInjection.catalog[0].host=api.search.brave.com'` +
    ` --set 'credentialInjection.catalog[0].upstreamPort=443'` +
    ` --set 'credentialInjection.catalog[0].credentialFields[0].name=api_key'` +
    ` --set 'credentialInjection.catalog[0].credentialFields[0].envVar=BRAVE_API_KEY'` +
    ` --set 'credentialInjection.catalog[0].allowOperatorFallback=true'` +
    ` --set 'credentialInjection.catalog[0].allowedPositions[0]=header'`;

  it('renders the broker ConfigMap with brave-search host', () => {
    const out = helmTemplate(`--set credentialInjection.mode=sidecar ${BRAVE_CATALOG_ARGS}`);
    expect(out).toContain('api.search.brave.com');
    expect(out).toContain('BRAVE_API_KEY');
  });

  it('brave-search entry parses with allowedPositions: header', () => {
    const out = helmTemplate(`--set credentialInjection.mode=sidecar ${BRAVE_CATALOG_ARGS}`);
    expect(out).toContain('allowedPositions');
    // The rendered ConfigMap must not embed any real key
    expect(out).not.toMatch(/BSA[A-Za-z0-9]{25,}/);
  });
});
