import { randomBytes } from 'node:crypto';
import type { CatalogInformer } from './catalog.js';

export const GROUP_SECRETS_LABEL = 'kubeclaw.io/group-secrets';
export const SECRET_NAME_PREFIX = 'kubeclaw-group-secrets-';
export const PLACEHOLDER_PREFIX = 'KC_PH_';
const MAX_VALUE_LEN = 4096;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export interface K8sSecretClient {
  readSecret: (name: string) => Promise<{
    data?: Record<string, string>;
    metadata?: { labels?: Record<string, string> };
  }>;
  createSecret: (body: unknown) => Promise<unknown>;
  patchSecret: (name: string, patch: unknown) => Promise<unknown>;
  deleteSecret: (name: string) => Promise<unknown>;
}

export interface SecretManagerOpts {
  namespace: string;
  catalog: CatalogInformer;
  k8s: K8sSecretClient;
}

interface CredentialBlob {
  fields: Record<string, { value: string; placeholder: string }>;
  registeredAt: string;
}

export class SecretManager {
  constructor(private readonly opts: SecretManagerOpts) {}

  private secretName(group: string): string {
    return SECRET_NAME_PREFIX + group;
  }

  private generatePlaceholder(fieldName: string): string {
    return `${PLACEHOLDER_PREFIX}${fieldName}_${randomBytes(32).toString('hex')}`;
  }

  private validateValue(v: string): void {
    if (v.length === 0) throw new Error('value is empty');
    if (v.length > MAX_VALUE_LEN) throw new Error('value too long');
    if (CONTROL_CHAR_RE.test(v))
      throw new Error('value contains invalid characters');
  }

  async setGroupSecret(
    group: string,
    catalogId: string,
    fieldValues: Record<string, string>,
  ): Promise<void> {
    const entry = this.opts.catalog.getEntry(catalogId);
    if (!entry) throw new Error('unknown_catalog_entry');

    for (const field of entry.credentialFields) {
      if (!(field.name in fieldValues)) {
        throw new Error(`missing field: ${field.name}`);
      }
      this.validateValue(fieldValues[field.name]);
    }

    const blob: CredentialBlob = {
      fields: Object.fromEntries(
        entry.credentialFields.map((f) => [
          f.name,
          {
            value: fieldValues[f.name],
            placeholder: this.generatePlaceholder(f.name),
          },
        ]),
      ),
      registeredAt: new Date().toISOString(),
    };
    const encoded = Buffer.from(JSON.stringify(blob)).toString('base64');

    let exists = true;
    try {
      await this.opts.k8s.readSecret(this.secretName(group));
    } catch (err: unknown) {
      const e = err as {
        statusCode?: number;
        code?: number;
        response?: { statusCode?: number };
      };
      if (e?.statusCode === 404 || e?.response?.statusCode === 404 || e?.code === 404)
        exists = false;
      else throw err;
    }

    if (!exists) {
      await this.opts.k8s.createSecret({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: this.secretName(group),
          namespace: this.opts.namespace,
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        type: 'Opaque',
        data: { [catalogId]: encoded },
      });
    } else {
      await this.opts.k8s.patchSecret(this.secretName(group), {
        data: { [catalogId]: encoded },
      });
    }
  }

  async deleteGroupSecret(group: string, catalogId: string): Promise<void> {
    const secret = await this.opts.k8s.readSecret(this.secretName(group));
    const data = secret.data ?? {};
    const remaining = Object.keys(data).filter((k) => k !== catalogId);
    if (remaining.length === 0) {
      await this.opts.k8s.deleteSecret(this.secretName(group));
    } else {
      // JSON-Merge-Patch: setting a key to null removes it.
      await this.opts.k8s.patchSecret(this.secretName(group), {
        data: { [catalogId]: null },
      });
    }
  }

  async listGroupSecrets(
    group: string,
  ): Promise<Array<{ catalogId: string; registeredAt: string }>> {
    let secret: { data?: Record<string, string> };
    try {
      secret = await this.opts.k8s.readSecret(this.secretName(group));
    } catch (err: unknown) {
      const e = err as {
        statusCode?: number;
        code?: number;
        response?: { statusCode?: number };
      };
      if (e?.statusCode === 404 || e?.response?.statusCode === 404 || e?.code === 404) return [];
      throw err;
    }
    return Object.entries(secret.data ?? {}).map(([catalogId, b64]) => {
      const blob: CredentialBlob = JSON.parse(
        Buffer.from(b64, 'base64').toString('utf8'),
      );
      return { catalogId, registeredAt: blob.registeredAt };
    });
  }

  /**
   * Returns placeholders only (never values) for all registered catalog entries
   * of the given group.
   *
   * Shape: `{ [catalogId]: { [fieldName]: placeholderString } }`
   *
   * Returns an empty object `{}` when the group has no registered credentials
   * or when the Secret does not exist.
   */
  async getGroupPlaceholders(
    group: string,
  ): Promise<Record<string, Record<string, string>>> {
    let secret: { data?: Record<string, string> };
    try {
      secret = await this.opts.k8s.readSecret(this.secretName(group));
    } catch (err: unknown) {
      const e = err as {
        statusCode?: number;
        code?: number;
        response?: { statusCode?: number };
      };
      if (e?.statusCode === 404 || e?.response?.statusCode === 404 || e?.code === 404) return {};
      throw err;
    }
    const result: Record<string, Record<string, string>> = {};
    for (const [catalogId, b64] of Object.entries(secret.data ?? {})) {
      const blob: CredentialBlob = JSON.parse(
        Buffer.from(b64, 'base64').toString('utf8'),
      );
      result[catalogId] = Object.fromEntries(
        Object.entries(blob.fields).map(([fieldName, { placeholder }]) => [
          fieldName,
          placeholder,
        ]),
      );
    }
    return result;
  }
}
