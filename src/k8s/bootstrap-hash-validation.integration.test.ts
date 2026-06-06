/**
 * Integration tests for Story 176: computeManifestHash determinism.
 *
 * These tests verify that the hash algorithm used by the orchestrator to
 * independently verify PVC contents produces stable, canonical results.
 * No K8s, no mocks — purely deterministic function tests.
 */
import { describe, it, expect } from 'vitest';
import { computeManifestHash, canonicalJson } from './bootstrap-runner.js';

const PKG_JSON_A = JSON.stringify({
  name: 'kubeclaw-telegram',
  version: '1.0.0',
  dependencies: { grammy: '^1.21.3' },
});

const LOCK_JSON_A = JSON.stringify({
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'kubeclaw-telegram',
      version: '1.0.0',
      dependencies: { grammy: '^1.21.3' },
    },
    'node_modules/grammy': {
      version: '1.21.3',
      resolved: 'https://registry.npmjs.org/grammy/-/grammy-1.21.3.tgz',
    },
  },
});

// Deviated: extra package added (simulates an extra `npm install` after `npm ci`)
const LOCK_JSON_DEVIATED = JSON.stringify({
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'kubeclaw-telegram',
      version: '1.0.0',
      dependencies: { grammy: '^1.21.3', 'left-pad': '^1.3.0' },
    },
    'node_modules/grammy': {
      version: '1.21.3',
      resolved: 'https://registry.npmjs.org/grammy/-/grammy-1.21.3.tgz',
    },
    'node_modules/left-pad': {
      version: '1.3.0',
      resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
    },
  },
});

describe('computeManifestHash — Story 176 integration', () => {
  it('produces a 64-character hex sha256 string', () => {
    const hash = computeManifestHash(PKG_JSON_A, LOCK_JSON_A);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: same inputs always yield the same hash', () => {
    const h1 = computeManifestHash(PKG_JSON_A, LOCK_JSON_A);
    const h2 = computeManifestHash(PKG_JSON_A, LOCK_JSON_A);
    expect(h1).toBe(h2);
  });

  it('is key-order independent: JSON with different key order hashes identically', () => {
    // Same logical content but with keys in different order
    const pkgA =
      '{"name":"kubeclaw-telegram","dependencies":{"grammy":"^1.21.3"},"version":"1.0.0"}';
    const pkgB =
      '{"version":"1.0.0","name":"kubeclaw-telegram","dependencies":{"grammy":"^1.21.3"}}';
    const lock = '{"lockfileVersion":3,"packages":{}}';
    expect(computeManifestHash(pkgA, lock)).toBe(
      computeManifestHash(pkgB, lock),
    );
  });

  it('produces different hashes when package-lock.json differs (extra install simulation)', () => {
    const hashOriginal = computeManifestHash(PKG_JSON_A, LOCK_JSON_A);
    const hashDeviated = computeManifestHash(PKG_JSON_A, LOCK_JSON_DEVIATED);
    expect(hashOriginal).not.toBe(hashDeviated);
  });

  it('produces different hashes when package.json differs', () => {
    const pkgB = JSON.stringify({
      name: 'kubeclaw-telegram',
      version: '2.0.0',
      dependencies: { grammy: '^1.21.3' },
    });
    expect(computeManifestHash(PKG_JSON_A, LOCK_JSON_A)).not.toBe(
      computeManifestHash(pkgB, LOCK_JSON_A),
    );
  });

  it('canonicalJson sorts object keys recursively', () => {
    const result = canonicalJson({ b: 2, a: 1, z: { y: 'last', x: 'first' } });
    expect(result).toBe('{"a":1,"b":2,"z":{"x":"first","y":"last"}}');
  });

  it('canonicalJson preserves array element order', () => {
    const result = canonicalJson([3, 1, 2, { b: 1, a: 0 }]);
    expect(result).toBe('[3,1,2,{"a":0,"b":1}]');
  });

  it('concatenates canonical forms with \\n separator', () => {
    // Verify the two-part structure: canonical(pkg) + '\n' + canonical(lock)
    const pkg = '{"name":"test"}';
    const lock = '{"lockfileVersion":3}';
    const hash = computeManifestHash(pkg, lock);
    // Compute manually to verify separator
    const { createHash } = require('node:crypto');
    const canonical =
      canonicalJson(JSON.parse(pkg)) + '\n' + canonicalJson(JSON.parse(lock));
    const expected = createHash('sha256').update(canonical).digest('hex');
    expect(hash).toBe(expected);
  });
});
