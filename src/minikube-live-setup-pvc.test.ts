/**
 * Unit tests for the stuckTerminatingPvcNames() pure helper exported from
 * e2e/minikube-live-setup.ts.
 *
 * This file lives in src/ so it is included by vitest.config.ts (the default
 * project, no globalSetup). It must NOT appear under e2e/minikube-live*.test.ts
 * because that glob triggers vitest.minikube-live.config.ts which has a
 * globalSetup that spins up a real cluster.
 *
 * minikube-live-setup.ts has no top-level side effects — all cluster work
 * happens inside the exported setup() function — so importing the pure helper
 * from it is safe in a unit-test context.
 */
import { describe, it, expect } from 'vitest';
import { stuckTerminatingPvcNames } from '../e2e/minikube-live-setup.js';

// Helper to build a minimal kubectl-get-pvc JSON response.
function makePvcList(
  pvcs: Array<{ name: string; deletionTimestamp?: string | null }>,
): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'List',
    items: pvcs.map(({ name, deletionTimestamp }) => ({
      metadata: {
        name,
        ...(deletionTimestamp !== undefined ? { deletionTimestamp } : {}),
      },
    })),
  });
}

describe('stuckTerminatingPvcNames', () => {
  it('returns the name of a PVC that has deletionTimestamp set', () => {
    const json = makePvcList([
      { name: 'pvc-terminating', deletionTimestamp: '2026-06-16T00:00:00Z' },
      { name: 'pvc-healthy' },
    ]);
    expect(stuckTerminatingPvcNames(json)).toEqual(['pvc-terminating']);
  });

  it('returns empty array when no PVCs are terminating', () => {
    const json = makePvcList([
      { name: 'pvc-a' },
      { name: 'pvc-b' },
    ]);
    expect(stuckTerminatingPvcNames(json)).toEqual([]);
  });

  it('returns empty array when items list is empty', () => {
    const json = makePvcList([]);
    expect(stuckTerminatingPvcNames(json)).toEqual([]);
  });

  it('returns empty array for malformed JSON — never throws', () => {
    expect(stuckTerminatingPvcNames('not valid json {')).toEqual([]);
  });

  it('returns empty array for an empty string — never throws', () => {
    expect(stuckTerminatingPvcNames('')).toEqual([]);
  });

  it('does not include a PVC with deletionTimestamp: null', () => {
    const json = makePvcList([
      { name: 'pvc-null-ts', deletionTimestamp: null },
      { name: 'pvc-absent' },
    ]);
    expect(stuckTerminatingPvcNames(json)).toEqual([]);
  });

  it('returns both names when multiple PVCs are terminating', () => {
    const json = makePvcList([
      { name: 'pvc-one', deletionTimestamp: '2026-06-16T00:00:00Z' },
      { name: 'pvc-two', deletionTimestamp: '2026-06-16T00:01:00Z' },
      { name: 'pvc-healthy' },
    ]);
    expect(stuckTerminatingPvcNames(json)).toEqual(['pvc-one', 'pvc-two']);
  });
});
