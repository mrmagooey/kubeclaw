/**
 * Helm render tests: channel-pod LLM broker env (Task 4).
 *
 * Verifies that channel pods get the correct LLM env vars depending on
 * credentialInjection.mode:
 *   - sidecar/istio (injection active, not auditOnly): operator-fallback
 *     sentinels + http:// base URLs from the catalog (kubeclaw.llmBrokerEnv).
 *   - mode=off: raw secretKeyRef env vars (legacy behavior).
 *
 * Also asserts that the sentinel prefix used in the Helm template matches
 * FALLBACK_SENTINEL_PREFIX defined in src/k8s/job-runner.ts.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const CHART_DIR = 'helm/kubeclaw';

// Base URL values from credentialInjection.catalog.baseUrlEnvs in values.yaml.
// These MUST stay in sync with the catalog entries.
const CATALOG_BASE_URLS = {
  OPENAI_BASE_URL: 'http://api.openai.com/v1',
  ANTHROPIC_BASE_URL: 'http://api.anthropic.com',
  OPENROUTER_BASE_URL: 'http://openrouter.ai/api/v1',
  VOYAGE_BASE_URL: 'http://api.voyageai.com',
} as const;

// Sentinel prefix MUST match FALLBACK_SENTINEL_PREFIX in src/k8s/job-runner.ts.
const FALLBACK_SENTINEL_PREFIX = 'KC_PH_FALLBACK_';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderChart(extraArgs: string[]): string {
  return execSync(
    [
      'helm', 'template', 'smoke', CHART_DIR,
      '--set', 'channels.http.enabled=true',
      ...extraArgs,
    ].join(' '),
    { encoding: 'utf8' },
  );
}

/** Extract channel-pod Deployment YAML documents from helm output. */
function channelDocs(out: string): string[] {
  return out.split(/\n?---\n/).filter(
    (doc) =>
      doc.includes('kind: Deployment') &&
      doc.includes('app: kubeclaw-channel-'),
  );
}

// ─── Sentinel parity with TS source ───────────────────────────────────────────

describe('FALLBACK_SENTINEL_PREFIX parity', () => {
  it('FALLBACK_SENTINEL_PREFIX in job-runner.ts equals the Helm sentinel prefix KC_PH_FALLBACK_', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/k8s/job-runner.ts'),
      'utf8',
    );
    // Extract: const FALLBACK_SENTINEL_PREFIX = 'KC_PH_FALLBACK_';
    const match = src.match(/const\s+FALLBACK_SENTINEL_PREFIX\s*=\s*['"]([^'"]+)['"]/);
    expect(match, 'FALLBACK_SENTINEL_PREFIX not found in job-runner.ts').toBeTruthy();
    const tsValue = match![1];
    expect(tsValue).toBe(FALLBACK_SENTINEL_PREFIX);
  });
});

// ─── mode=sidecar ─────────────────────────────────────────────────────────────

describe('helm channel-pod env — mode=sidecar', () => {
  let out: string;

  it('renders cleanly', () => {
    out = renderChart(['--set', 'credentialInjection.mode=sidecar']);
    expect(out).toBeTruthy();
  });

  it('channel pod env has OPENAI_API_KEY = KC_PH_FALLBACK_openai', () => {
    const docs = channelDocs(out);
    expect(docs.length, 'expected at least one channel Deployment').toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc).toContain(`name: OPENAI_API_KEY`);
      expect(doc).toContain(`value: "${FALLBACK_SENTINEL_PREFIX}openai"`);
    }
  });

  it('channel pod OPENAI_BASE_URL matches the catalog value', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${CATALOG_BASE_URLS.OPENAI_BASE_URL}"`);
    }
  });

  it('channel pod env has ANTHROPIC_API_KEY = KC_PH_FALLBACK_anthropic', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${FALLBACK_SENTINEL_PREFIX}anthropic"`);
    }
  });

  it('channel pod ANTHROPIC_BASE_URL matches the catalog value', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${CATALOG_BASE_URLS.ANTHROPIC_BASE_URL}"`);
    }
  });

  it('channel pod env has OPENROUTER_API_KEY = KC_PH_FALLBACK_openrouter', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${FALLBACK_SENTINEL_PREFIX}openrouter"`);
    }
  });

  it('channel pod OPENROUTER_BASE_URL matches the catalog value', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${CATALOG_BASE_URLS.OPENROUTER_BASE_URL}"`);
    }
  });

  it('channel pod env has VOYAGE_API_KEY = KC_PH_FALLBACK_voyage', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${FALLBACK_SENTINEL_PREFIX}voyage"`);
    }
  });

  it('channel pod VOYAGE_BASE_URL matches the catalog value', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${CATALOG_BASE_URLS.VOYAGE_BASE_URL}"`);
    }
  });

  it('channel pod env has NO secretKeyRef for openai-api-key', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).not.toContain('key: openai-api-key');
    }
  });
});

// ─── mode=istio ───────────────────────────────────────────────────────────────

describe('helm channel-pod env — mode=istio', () => {
  let out: string;

  it('renders cleanly', () => {
    out = renderChart(['--set', 'credentialInjection.mode=istio', '--set', 'namespace=kubeclaw']);
    expect(out).toBeTruthy();
  });

  it('channel pod env has OPENAI_API_KEY = KC_PH_FALLBACK_openai', () => {
    const docs = channelDocs(out);
    expect(docs.length, 'expected at least one channel Deployment').toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${FALLBACK_SENTINEL_PREFIX}openai"`);
    }
  });

  it('channel pod OPENAI_BASE_URL matches the catalog value (with /v1)', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).toContain(`value: "${CATALOG_BASE_URLS.OPENAI_BASE_URL}"`);
    }
  });

  it('channel pod env has NO secretKeyRef for openai-api-key', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).not.toContain('key: openai-api-key');
    }
  });
});

// ─── mode=off ─────────────────────────────────────────────────────────────────

describe('helm channel-pod env — mode=off', () => {
  let out: string;

  it('renders cleanly', () => {
    out = renderChart(['--set', 'credentialInjection.mode=off']);
    expect(out).toBeTruthy();
  });

  it('channel pod OPENAI_API_KEY uses raw secretKeyRef (not sentinel)', () => {
    const docs = channelDocs(out);
    expect(docs.length, 'expected at least one channel Deployment').toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc).toContain('key: openai-api-key');
      expect(doc).not.toContain(`KC_PH_FALLBACK_openai`);
    }
  });

  it('channel pod has no KC_PH_FALLBACK_openai sentinel value', () => {
    const docs = channelDocs(out);
    for (const doc of docs) {
      expect(doc).not.toContain('KC_PH_FALLBACK_openai');
    }
  });
});

// ─── auditOnly=true ───────────────────────────────────────────────────────────

describe('helm channel-pod env — mode=sidecar auditOnly=true', () => {
  let out: string;

  it('renders cleanly', () => {
    out = renderChart([
      '--set', 'credentialInjection.mode=sidecar',
      '--set', 'credentialInjection.auditOnly=true',
    ]);
    expect(out).toBeTruthy();
  });

  it('channel pod OPENAI_API_KEY uses raw secretKeyRef in auditOnly mode', () => {
    const docs = channelDocs(out);
    expect(docs.length, 'expected at least one channel Deployment').toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc).toContain('key: openai-api-key');
      expect(doc).not.toContain('KC_PH_FALLBACK_openai');
    }
  });
});
