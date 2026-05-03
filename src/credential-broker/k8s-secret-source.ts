export interface SecretRef { kind: 'Secret'; name: string; key: string }
export interface RawSecret { data?: Record<string, string> }

export interface K8sSecretSourceOpts {
  readSecret: (name: string) => Promise<RawSecret>;
  cacheTtlMs: number;
}

interface CacheEntry { value: string; expiresAt: number }

export class K8sSecretSource {
  private cache = new Map<string, CacheEntry>();

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
      this.cache.set(cacheKey, { value, expiresAt: now + this.opts.cacheTtlMs });
    }
    return value;
  }
}
