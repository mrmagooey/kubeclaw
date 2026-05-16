export const OWNER_GROUP_ANNOTATION = 'kubeclaw.io/owner-group';

export interface PodSnapshot {
  uid: string;
  name: string;
  podIP: string;
  terminating: boolean;
  annotations: Record<string, string>;
}

export interface OwnerGroupResolution {
  ownerGroup: string;
  podUid: string;
}

export class PodInformer {
  private byUid = new Map<string, PodSnapshot>();
  private byIp = new Map<string, string>(); // ip → most recent uid

  upsert(pod: PodSnapshot): void {
    this.byUid.set(pod.uid, pod);
    this.byIp.set(pod.podIP, pod.uid);
  }

  delete(uid: string): void {
    const pod = this.byUid.get(uid);
    this.byUid.delete(uid);
    if (pod && this.byIp.get(pod.podIP) === uid) {
      this.byIp.delete(pod.podIP);
    }
  }

  private resolveFromPod(pod: PodSnapshot | undefined): OwnerGroupResolution | null {
    if (!pod) return null;
    if (pod.terminating) return null;
    const og = pod.annotations[OWNER_GROUP_ANNOTATION];
    if (!og) return null;
    return { ownerGroup: og, podUid: pod.uid };
  }

  resolveOwnerGroupByUID(uid: string): OwnerGroupResolution | null {
    return this.resolveFromPod(this.byUid.get(uid));
  }

  resolveOwnerGroupByIP(ip: string): OwnerGroupResolution | null {
    const uid = this.byIp.get(ip);
    if (!uid) return null;
    const pod = this.byUid.get(uid);
    // A1 cross-check: pod's recorded IP must equal the requested IP
    if (pod && pod.podIP !== ip) return null;
    return this.resolveFromPod(pod);
  }
}
