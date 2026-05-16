export const GROUP_SECRETS_LABEL = 'kubeclaw.io/group-secrets';

export interface SecretRef {
  kind: 'Secret';
  name: string;
  key: string;
}

export interface RawSecret {
  metadata?: { name?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
}

export interface GroupCredentialBlob {
  fields: Record<string, { value: string; placeholder: string }>;
  registeredAt: string;
}

export interface SecretWatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
  secret: RawSecret;
}

export interface K8sSecretSourceOpts {
  readSecret: (name: string) => Promise<RawSecret>;
  cacheTtlMs: number;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class K8sSecretSource {
  private cache = new Map<string, CacheEntry>();
  // groupName → catalogId → blob
  private groupCreds = new Map<string, Map<string, GroupCredentialBlob>>();

  constructor(private readonly opts: K8sSecretSourceOpts) {}

  async read(ref: SecretRef): Promise<string> {
    const cacheKey = `${ref.name}/${ref.key}`;
    const now = Date.now();
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.value;

    const secret = await this.opts.readSecret(ref.name);
    const b64 = secret.data?.[ref.key];
    if (b64 === undefined) {
      throw new Error(`secret ${ref.name} has no key "${ref.key}"`);
    }
    const value = Buffer.from(b64, 'base64').toString('utf8');
    if (this.opts.cacheTtlMs > 0) {
      this.cache.set(cacheKey, {
        value,
        expiresAt: now + this.opts.cacheTtlMs,
      });
    }
    return value;
  }

  applyGroupSecretEvent(ev: SecretWatchEvent): void {
    const name = ev.secret.metadata?.name;
    if (!name?.startsWith('kubeclaw-group-secrets-')) return;
    if (
      ev.secret.metadata?.labels?.[GROUP_SECRETS_LABEL] !== 'true' &&
      ev.type !== 'DELETED'
    ) {
      return;
    }
    const group = name.slice('kubeclaw-group-secrets-'.length);

    if (ev.type === 'DELETED') {
      this.groupCreds.delete(group);
      return;
    }

    const newMap = new Map<string, GroupCredentialBlob>();
    for (const [catalogId, b64] of Object.entries(ev.secret.data ?? {})) {
      try {
        const blob = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        if (
          blob &&
          typeof blob === 'object' &&
          blob.fields &&
          typeof blob.fields === 'object'
        ) {
          newMap.set(catalogId, blob as GroupCredentialBlob);
        }
      } catch {
        // skip malformed entry — metric increment wired in Task 9
      }
    }
    this.groupCreds.set(group, newMap);
  }

  getGroupCredential(group: string, catalogId: string): GroupCredentialBlob | null {
    return this.groupCreds.get(group)?.get(catalogId) ?? null;
  }

  listGroups(): string[] {
    return Array.from(this.groupCreds.keys());
  }
}
