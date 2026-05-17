import { describe, it, expect } from 'vitest';
import {
  renderDeployment,
  renderService,
  renderNetworkPolicy,
  COMMON_LABELS_KEYS,
} from './k8s-objects.js';
import type { CapabilitySpec } from '../capabilities/types.js';

const baseSpec: CapabilitySpec = {
  name: 'filesystem',
  kind: 'mcp',
  image: 'ghcr.io/x/bundle:1.0',
  scope: 'group',
  volumeFromGroupPvc: true,
  credentialsFrom: 'none',
};

const ctx = {
  groupFolder: 'Family',
  groupHash: 'abc1234567',
  namespace: 'kubeclaw',
  groupsPvcName: 'kubeclaw-groups-pvc',
};

describe('renderDeployment', () => {
  it('produces expected metadata, labels, and replicas:0', () => {
    const dep = renderDeployment(baseSpec, ctx);
    expect(dep.metadata?.name).toBe('mcp-filesystem-abc1234567');
    expect(dep.metadata?.namespace).toBe('kubeclaw');
    expect(dep.spec?.replicas).toBe(0);
    expect(dep.metadata?.labels?.['kubeclaw.io/capability']).toBe('filesystem');
    expect(dep.metadata?.labels?.['kubeclaw.io/group-hash']).toBe('abc1234567');
    expect(dep.metadata?.labels?.['kubeclaw.io/scope']).toBe('group');
  });

  it('mounts group PVC subPath when volumeFromGroupPvc is true', () => {
    const dep = renderDeployment(baseSpec, ctx);
    const container = dep.spec!.template.spec!.containers[0];
    const mount = container.volumeMounts?.find(m => m.name === 'groups');
    expect(mount?.mountPath).toBe('/data');
    expect(mount?.subPath).toBe('groups/Family');
    const vol = dep.spec!.template.spec!.volumes?.find(v => v.name === 'groups');
    expect(vol?.persistentVolumeClaim?.claimName).toBe('kubeclaw-groups-pvc');
  });

  it('omits PVC volume when volumeFromGroupPvc is false', () => {
    const spec = { ...baseSpec, volumeFromGroupPvc: false };
    const dep = renderDeployment(spec, ctx);
    const container = dep.spec!.template.spec!.containers[0];
    expect(container.volumeMounts ?? []).toEqual([]);
  });

  it('injects envFrom Secret when credentialsFrom=secret', () => {
    const spec: CapabilitySpec = { ...baseSpec, credentialsFrom: 'secret' };
    const dep = renderDeployment(spec, ctx);
    const container = dep.spec!.template.spec!.containers[0];
    expect(container.envFrom?.[0].secretRef?.name).toBe('mcp-filesystem-abc1234567-creds');
  });
});

describe('renderService', () => {
  it('exposes container port', () => {
    const svc = renderService(baseSpec, ctx);
    expect(svc.metadata?.name).toBe('mcp-filesystem-abc1234567');
    expect(svc.spec?.ports?.[0].targetPort).toBe(3000);
    expect(svc.spec?.selector?.['kubeclaw.io/capability']).toBe('filesystem');
  });
});

describe('renderNetworkPolicy', () => {
  it('restricts ingress to channel+orchestrator pods on port 3000', () => {
    const np = renderNetworkPolicy(baseSpec, ctx);
    const ingress = np.spec?.ingress?.[0];
    const sources = ingress?._from ?? [];
    expect(sources.length).toBe(2);
    const roles = sources.map(s => s.podSelector?.matchLabels?.['kubeclaw.io/role']).sort();
    expect(roles).toEqual(['channel', 'orchestrator']);
    expect(ingress?.ports?.[0].port).toBe(3000);
  });

  it('allows egress to redis and DNS', () => {
    const np = renderNetworkPolicy(baseSpec, ctx);
    const egress = np.spec?.egress ?? [];
    expect(egress.length).toBeGreaterThanOrEqual(2);
  });
});

describe('COMMON_LABELS_KEYS', () => {
  it('lists exactly the kubeclaw labels we manage', () => {
    expect(COMMON_LABELS_KEYS).toEqual([
      'kubeclaw.io/scope',
      'kubeclaw.io/capability',
      'kubeclaw.io/group-hash',
      'kubeclaw.io/managed-by',
    ]);
  });
});
