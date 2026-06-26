import { describe, it, expect } from 'vitest';
import { renderPersistentVolumeClaim, pvcName } from './pvc.js';
import type { McpCapabilitySpec } from '../capabilities/types.js';

const ctx = {
  namespace: 'kubeclaw',
  groupFolder: 'alice',
  groupHash: 'abc123',
  groupsPvcName: 'kubeclaw-groups',
};

const dbSpec: McpCapabilitySpec = {
  name: 'database', kind: 'mcp', image: 'pg-mcp:1', scope: 'group',
  storage: { sizeGi: 5, mountPath: '/var/lib/postgresql/data', container: 'postgres' },
};

describe('renderPersistentVolumeClaim', () => {
  it('returns null when no storage declared', () => {
    expect(renderPersistentVolumeClaim({ ...dbSpec, storage: undefined }, ctx)).toBeNull();
  });

  it('renders an RWO PVC named <instance>-data with the requested size', () => {
    const pvc = renderPersistentVolumeClaim(dbSpec, ctx)!;
    expect(pvc.metadata?.name).toBe(pvcName('database', 'abc123'));
    expect(pvc.metadata?.name).toBe('mcp-database-abc123-data');
    expect(pvc.spec?.accessModes).toEqual(['ReadWriteOnce']);
    expect(pvc.spec?.resources?.requests?.storage).toBe('5Gi');
    expect(pvc.metadata?.namespace).toBe('kubeclaw');
  });

  it('carries the group-hash label and a retain annotation', () => {
    const pvc = renderPersistentVolumeClaim(dbSpec, ctx)!;
    expect(pvc.metadata?.labels?.['kubeclaw.io/group-hash']).toBe('abc123');
    expect(pvc.metadata?.annotations?.['kubeclaw.io/retain']).toBe('true');
  });
});
