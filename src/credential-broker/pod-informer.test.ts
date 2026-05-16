import { describe, it, expect } from 'vitest';
import { PodInformer, type PodSnapshot } from './pod-informer.js';

const mkPod = (over: Partial<PodSnapshot>): PodSnapshot => ({
  uid: 'uid-1',
  name: 'pod-1',
  podIP: '10.0.0.1',
  terminating: false,
  annotations: { 'kubeclaw.io/owner-group': 'family' },
  ...over,
});

describe('PodInformer', () => {
  it('lookupByIP returns annotation for live pod', () => {
    const inf = new PodInformer();
    inf.upsert(mkPod({}));
    const result = inf.resolveOwnerGroupByIP('10.0.0.1');
    expect(result).toEqual({ ownerGroup: 'family', podUid: 'uid-1' });
  });

  it('lookupByIP returns null for terminating pod', () => {
    const inf = new PodInformer();
    inf.upsert(mkPod({ terminating: true }));
    expect(inf.resolveOwnerGroupByIP('10.0.0.1')).toBeNull();
  });

  it('lookupByIP returns null when no pod has that IP', () => {
    const inf = new PodInformer();
    expect(inf.resolveOwnerGroupByIP('192.168.0.99')).toBeNull();
  });

  it('lookupByIP returns null when pod lacks owner-group annotation', () => {
    const inf = new PodInformer();
    inf.upsert(mkPod({ annotations: {} }));
    expect(inf.resolveOwnerGroupByIP('10.0.0.1')).toBeNull();
  });

  it('lookupByUID returns annotation for live pod', () => {
    const inf = new PodInformer();
    inf.upsert(mkPod({}));
    expect(inf.resolveOwnerGroupByUID('uid-1')).toEqual({
      ownerGroup: 'family',
      podUid: 'uid-1',
    });
  });

  it('lookupByUID returns null for terminating', () => {
    const inf = new PodInformer();
    inf.upsert(mkPod({ terminating: true }));
    expect(inf.resolveOwnerGroupByUID('uid-1')).toBeNull();
  });

  it('delete evicts', () => {
    const inf = new PodInformer();
    inf.upsert(mkPod({}));
    inf.delete('uid-1');
    expect(inf.resolveOwnerGroupByIP('10.0.0.1')).toBeNull();
    expect(inf.resolveOwnerGroupByUID('uid-1')).toBeNull();
  });

  it('IP-recycle: latest upsert wins on same IP', () => {
    const inf = new PodInformer();
    inf.upsert(mkPod({ uid: 'old', annotations: { 'kubeclaw.io/owner-group': 'group-a' } }));
    inf.upsert(mkPod({ uid: 'new', annotations: { 'kubeclaw.io/owner-group': 'group-b' } }));
    // Both pods at 10.0.0.1 simultaneously is a degenerate state, but the
    // last upsert should win for IP lookup
    const r = inf.resolveOwnerGroupByIP('10.0.0.1');
    expect(r?.ownerGroup).toBe('group-b');
  });
});
