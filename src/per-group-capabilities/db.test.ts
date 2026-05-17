import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import {
  upsertInstance,
  getInstance,
  listInstances,
  deleteInstancesByGroup,
  setReplicas,
  touchLastUsed,
  listInstancesAtReplicas,
} from './db.js';

beforeAll(async () => {
  await _initTestDatabase();
});

beforeEach(() => {
  __resetDbForTest();
});

describe('per_group_capability_instances', () => {
  it('upsert + get round-trip', () => {
    upsertInstance({
      groupFolder: 'Family', capabilityName: 'filesystem',
      groupHash: 'abc1234567', deploymentName: 'mcp-filesystem-abc1234567',
      serviceName: 'mcp-filesystem-abc1234567',
    });
    const row = getInstance('Family', 'filesystem');
    expect(row?.deploymentName).toBe('mcp-filesystem-abc1234567');
    expect(row?.currentReplicas).toBe(0);
  });

  it('listInstances returns rows for a group', () => {
    upsertInstance({ groupFolder: 'A', capabilityName: 'x',
      groupHash: 'h1111', deploymentName: 'd1', serviceName: 'd1' });
    upsertInstance({ groupFolder: 'A', capabilityName: 'y',
      groupHash: 'h2222', deploymentName: 'd2', serviceName: 'd2' });
    upsertInstance({ groupFolder: 'B', capabilityName: 'x',
      groupHash: 'h3333', deploymentName: 'd3', serviceName: 'd3' });
    expect(listInstances('A')).toHaveLength(2);
    expect(listInstances('B')).toHaveLength(1);
  });

  it('setReplicas + touchLastUsed update fields', () => {
    upsertInstance({ groupFolder: 'A', capabilityName: 'x',
      groupHash: 'h1', deploymentName: 'd', serviceName: 'd' });
    setReplicas('A', 'x', 1);
    touchLastUsed('A', 'x', 1747500000);
    const row = getInstance('A', 'x');
    expect(row?.currentReplicas).toBe(1);
    expect(row?.lastUsedAt).toBe(1747500000);
  });

  it('deleteInstancesByGroup cascades all caps for the group', () => {
    upsertInstance({ groupFolder: 'A', capabilityName: 'x',
      groupHash: 'h1', deploymentName: 'd1', serviceName: 'd1' });
    upsertInstance({ groupFolder: 'A', capabilityName: 'y',
      groupHash: 'h2', deploymentName: 'd2', serviceName: 'd2' });
    deleteInstancesByGroup('A');
    expect(listInstances('A')).toEqual([]);
  });

  it('listInstancesAtReplicas filters by current_replicas', () => {
    upsertInstance({ groupFolder: 'A', capabilityName: 'x',
      groupHash: 'h1', deploymentName: 'd1', serviceName: 'd1' });
    upsertInstance({ groupFolder: 'B', capabilityName: 'y',
      groupHash: 'h2', deploymentName: 'd2', serviceName: 'd2' });
    setReplicas('A', 'x', 1);
    const at1 = listInstancesAtReplicas(1);
    expect(at1.map(r => r.groupFolder)).toEqual(['A']);
  });
});
