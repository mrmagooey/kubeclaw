import {
  V1Deployment, V1Service, V1NetworkPolicy, V1Secret,
  KubeConfig, AppsV1Api, CoreV1Api, NetworkingV1Api,
} from '@kubernetes/client-node';

export interface PerGroupK8sClient {
  applyDeployment(d: V1Deployment): Promise<void>;
  applyService(s: V1Service): Promise<void>;
  applyNetworkPolicy(p: V1NetworkPolicy): Promise<void>;
  applySecret(s: V1Secret): Promise<void>;
  readDeployment(namespace: string, name: string): Promise<V1Deployment | null>;
  readService(namespace: string, name: string): Promise<V1Service | null>;
  readSecret(namespace: string, name: string): Promise<V1Secret | null>;
  patchDeploymentReplicas(namespace: string, name: string, replicas: number): Promise<void>;
  deleteByLabel(namespace: string, labelSelector: string): Promise<void>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  waitForReady(namespace: string, name: string, timeoutMs: number): Promise<void>;
  listDeploymentsByLabel(namespace: string, labelSelector: string): Promise<V1Deployment[]>;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return e.code === 404 || e.statusCode === 404 || e.response?.statusCode === 404;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class RealPerGroupK8sClient implements PerGroupK8sClient {
  private apps: AppsV1Api;
  private core: CoreV1Api;
  private net: NetworkingV1Api;

  constructor(kc?: KubeConfig) {
    const cfg = kc ?? (() => { const k = new KubeConfig(); k.loadFromDefault(); return k; })();
    this.apps = cfg.makeApiClient(AppsV1Api);
    this.core = cfg.makeApiClient(CoreV1Api);
    this.net = cfg.makeApiClient(NetworkingV1Api);
  }

  async applyDeployment(d: V1Deployment): Promise<void> {
    const ns = d.metadata!.namespace!;
    const name = d.metadata!.name!;
    const existing = await this.readDeployment(ns, name);
    if (existing) {
      d.metadata = { ...d.metadata, resourceVersion: existing.metadata?.resourceVersion };
      await this.apps.replaceNamespacedDeployment({ name, namespace: ns, body: d });
    } else {
      await this.apps.createNamespacedDeployment({ namespace: ns, body: d });
    }
  }

  async applyService(s: V1Service): Promise<void> {
    const ns = s.metadata!.namespace!;
    const name = s.metadata!.name!;
    const existing = await this.readService(ns, name);
    if (existing) {
      // Service replace requires preserving clusterIP and resourceVersion.
      s.metadata = { ...s.metadata, resourceVersion: existing.metadata?.resourceVersion };
      if (existing.spec?.clusterIP && s.spec) {
        s.spec.clusterIP = existing.spec.clusterIP;
      }
      await this.core.replaceNamespacedService({ name, namespace: ns, body: s });
    } else {
      await this.core.createNamespacedService({ namespace: ns, body: s });
    }
  }

  async applyNetworkPolicy(p: V1NetworkPolicy): Promise<void> {
    const ns = p.metadata!.namespace!;
    const name = p.metadata!.name!;
    try {
      const existing = await this.net.readNamespacedNetworkPolicy({ name, namespace: ns });
      p.metadata = { ...p.metadata, resourceVersion: existing.metadata?.resourceVersion };
      await this.net.replaceNamespacedNetworkPolicy({ name, namespace: ns, body: p });
    } catch (err) {
      if (isNotFound(err)) {
        await this.net.createNamespacedNetworkPolicy({ namespace: ns, body: p });
      } else throw err;
    }
  }

  async applySecret(s: V1Secret): Promise<void> {
    const ns = s.metadata!.namespace!;
    const name = s.metadata!.name!;
    const existing = await this.readSecret(ns, name);
    if (existing) {
      s.metadata = { ...s.metadata, resourceVersion: existing.metadata?.resourceVersion };
      await this.core.replaceNamespacedSecret({ name, namespace: ns, body: s });
    } else {
      await this.core.createNamespacedSecret({ namespace: ns, body: s });
    }
  }

  async readDeployment(namespace: string, name: string): Promise<V1Deployment | null> {
    try { return await this.apps.readNamespacedDeployment({ name, namespace }); }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }

  async readService(namespace: string, name: string): Promise<V1Service | null> {
    try { return await this.core.readNamespacedService({ name, namespace }); }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }

  async readSecret(namespace: string, name: string): Promise<V1Secret | null> {
    try { return await this.core.readNamespacedSecret({ name, namespace }); }
    catch (err) { if (isNotFound(err)) return null; throw err; }
  }

  async patchDeploymentReplicas(namespace: string, name: string, replicas: number): Promise<void> {
    // Use the scale subresource to update replicas only — no resourceVersion conflicts.
    await this.apps.patchNamespacedDeploymentScale({
      name, namespace, body: { spec: { replicas } },
    });
  }

  async deleteByLabel(namespace: string, labelSelector: string): Promise<void> {
    await this.apps.deleteCollectionNamespacedDeployment({ namespace, labelSelector });
    await this.core.deleteCollectionNamespacedService({ namespace, labelSelector });
    await this.net.deleteCollectionNamespacedNetworkPolicy({ namespace, labelSelector });
    await this.core.deleteCollectionNamespacedSecret({ namespace, labelSelector });
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    try { await this.core.deleteNamespacedSecret({ name, namespace }); }
    catch (err) { if (!isNotFound(err)) throw err; }
  }

  async waitForReady(namespace: string, name: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const d = await this.readDeployment(namespace, name);
      const ready = d?.status?.readyReplicas ?? 0;
      const desired = d?.spec?.replicas ?? 0;
      if (desired > 0 && ready >= desired) return;
      await sleep(500);
    }
    throw new Error(`waitForReady: timeout after ${timeoutMs}ms for ${namespace}/${name}`);
  }

  async listDeploymentsByLabel(namespace: string, labelSelector: string): Promise<V1Deployment[]> {
    const res = await this.apps.listNamespacedDeployment({ namespace, labelSelector });
    return res.items ?? [];
  }
}

// ----- Fake (for tests) ---------------------------------------------------

interface FakeStore {
  deployments: Map<string, V1Deployment>;
  services: Map<string, V1Service>;
  policies: Map<string, V1NetworkPolicy>;
  secrets: Map<string, V1Secret>;
  ready: Set<string>;
}

function fakeKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

function labelMatch(labels: Record<string, string> | undefined, selector: string): boolean {
  if (!labels) return false;
  const [k, v] = selector.split('=');
  return labels[k] === v;
}

export class FakePerGroupK8sClient implements PerGroupK8sClient {
  store: FakeStore = {
    deployments: new Map(), services: new Map(),
    policies: new Map(), secrets: new Map(), ready: new Set(),
  };

  async applyDeployment(d: V1Deployment): Promise<void> {
    this.store.deployments.set(fakeKey(d.metadata!.namespace!, d.metadata!.name!), structuredClone(d));
  }

  async applyService(s: V1Service): Promise<void> {
    this.store.services.set(fakeKey(s.metadata!.namespace!, s.metadata!.name!), structuredClone(s));
  }

  async applyNetworkPolicy(p: V1NetworkPolicy): Promise<void> {
    this.store.policies.set(fakeKey(p.metadata!.namespace!, p.metadata!.name!), structuredClone(p));
  }

  async applySecret(s: V1Secret): Promise<void> {
    this.store.secrets.set(fakeKey(s.metadata!.namespace!, s.metadata!.name!), structuredClone(s));
  }

  async readDeployment(ns: string, name: string): Promise<V1Deployment | null> {
    return this.store.deployments.get(fakeKey(ns, name)) ?? null;
  }

  async readService(ns: string, name: string): Promise<V1Service | null> {
    return this.store.services.get(fakeKey(ns, name)) ?? null;
  }

  async readSecret(ns: string, name: string): Promise<V1Secret | null> {
    return this.store.secrets.get(fakeKey(ns, name)) ?? null;
  }

  async patchDeploymentReplicas(ns: string, name: string, replicas: number): Promise<void> {
    const d = this.store.deployments.get(fakeKey(ns, name));
    if (!d) throw new Error(`patchDeploymentReplicas: not found ${ns}/${name}`);
    if (!d.spec) d.spec = {} as never;
    d.spec!.replicas = replicas;
  }

  async deleteByLabel(namespace: string, labelSelector: string): Promise<void> {
    const maps: Array<Map<string, { metadata?: { namespace?: string; labels?: Record<string, string> } }>> = [
      this.store.deployments as never, this.store.services as never,
      this.store.policies as never, this.store.secrets as never,
    ];
    for (const map of maps) {
      for (const [k, v] of map.entries()) {
        if (v.metadata?.namespace !== namespace) continue;
        if (labelMatch(v.metadata?.labels, labelSelector)) map.delete(k);
      }
    }
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.store.secrets.delete(fakeKey(namespace, name));
  }

  async waitForReady(ns: string, name: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.store.ready.has(fakeKey(ns, name))) return;
      await sleep(5);
    }
    throw new Error(`waitForReady: timeout after ${timeoutMs}ms for ${ns}/${name}`);
  }

  markReady(ns: string, name: string): void {
    this.store.ready.add(fakeKey(ns, name));
  }

  async listDeploymentsByLabel(namespace: string, labelSelector: string): Promise<V1Deployment[]> {
    const out: V1Deployment[] = [];
    for (const d of this.store.deployments.values()) {
      if (d.metadata?.namespace === namespace && labelMatch(d.metadata?.labels, labelSelector)) {
        out.push(d);
      }
    }
    return out;
  }
}
