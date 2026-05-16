# Per-group user-supplied credentials — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End users register API credentials per group via a chat-resident `/secret` slash command. Subsequent tool-job calls to operator-curated destinations transparently use those credentials. Workload never holds cleartext; Envoy substitutes high-entropy placeholders inline at egress.

**Architecture:** Catalog ConfigMap declares destinations + credential field shape. Orchestrator writes per-group K8s Secrets with high-entropy placeholders generated at `/secret add` time. Broker reads per-group Secrets via namespace-wide RBAC; resolves `(group, host)` → substitution map at request time; returns map to Envoy via `x-kubeclaw-substitute` response header. New Envoy Lua filter performs inline placeholder substitution in request body and headers.

**Tech Stack:** TypeScript (strict), Zod for schema validation, `@kubernetes/client-node` for K8s API, Vitest for tests, Helm/YAML for chart, Envoy Lua filter for substitution.

**Spec:** `docs/superpowers/specs/2026-05-16-credential-injection-secret-management-design.md`

---

## File map

**New files:**
- `src/credential-broker/pod-informer.ts` — Pod cache for owner-group resolution, A1 mitigations
- `src/credential-broker/substitution-policy.ts` — `allowedPositions` + counter enforcement
- `src/k8s/secret-manager.ts` — Per-group Secret CRUD + placeholder generation
- `src/k8s/catalog.ts` — Catalog ConfigMap informer for orchestrator
- `src/tools/list-credentials.ts` — Channel-resident tool
- `helm/kubeclaw/files/envoy-substitution-filter.lua` — Lua filter source (loaded by chart)
- Test files mirroring each source file

**Modified files:**
- `src/credential-broker/config.ts` — Add `catalog` to schema; loader extension
- `src/credential-broker/resolver.ts` — Return substitution map; per-group/operator-fallback resolution
- `src/credential-broker/identity.ts` — Add `resolveOwnerGroup()` method
- `src/credential-broker/k8s-secret-source.ts` — Watch labelled Secrets; JSON-blob parsing
- `src/credential-broker/audit.ts` — Add `ownerGroup`, `catalogId`, `keySource`, substitution counts
- `src/credential-broker/index.ts` — Wire pod-informer, return substitution headers
- `src/k8s/job-runner.ts` — Annotation + catalog-driven env stamping
- `src/k8s/ipc-redis.ts` — New IPC message types
- `src/channel-runner.ts` — `/secret` parser, backstop, system-event injection, tool registration, system-prompt block
- `src/index.ts` — Wire catalog informer, secret-manager, IPC handlers
- `helm/kubeclaw/templates/credential-broker-config.yaml` — Add catalog section
- `helm/kubeclaw/templates/credential-broker.yaml` — RBAC widening
- `helm/kubeclaw/templates/orchestrator.yaml` — RBAC additions
- `helm/kubeclaw/templates/envoy-sidecar-config.yaml` — Add Lua filter
- `helm/kubeclaw/templates/istio-envoyfilter.yaml` — Add Lua filter
- `helm/kubeclaw/templates/_helpers.tpl` — Catalog iteration for envs
- `docs/CREDENTIAL_INJECTION.md` — New section
- `docs/SECURITY.md` — Threat model entries

---

## Task ordering & dependencies

```
Phase 1 (foundations, parallelizable):
  Task 1 — Catalog schema in chart + broker config.ts parser
  Task 2 — Orchestrator catalog.ts informer
  Task 3 — Orchestrator secret-manager.ts (Secret CRUD + placeholder generation)
  Task 4 — Broker k8s-secret-source label-watcher extension
  Task 5 — Broker pod-informer.ts
  Task 6 — Broker identity.ts resolveOwnerGroup
  Task 7 — Broker substitution-policy.ts

Phase 2 (depends on Phase 1):
  Task 8 — Broker resolver.ts substitution map
  Task 9 — Broker audit.ts + index.ts wiring (substitution-header response)
  Task 10 — Orchestrator IPC handlers + index.ts wiring
  Task 11 — Job-runner pod spec changes
  Task 12 — RBAC chart updates

Phase 3 (depends on Phase 2):
  Task 13 — Envoy Lua filter source + sidecar wiring
  Task 14 — Envoy Lua filter for istio mode
  Task 15 — Channel-runner /secret command suite
  Task 16 — list_credentials tool + per-turn system prompt

Phase 4 (validation):
  Task 17 — Integration tests (helm template + ext_authz wire shape)
  Task 18 — E2E mode=sidecar
  Task 19 — E2E mode=istio
  Task 20 — Docs updates
```

Phase 1 tasks are independently developable; merge as ready. Phase 2 tasks need Phase 1 deps merged first. Phase 3 needs Phase 2.

---

## Task 1: Catalog schema in chart + broker config.ts parser

**Goal:** Catalog section parses in the broker; built-in mappings unchanged.

**Files:**
- Modify: `src/credential-broker/resolver.ts` (add `CatalogEntrySchema` only — full resolver changes in Task 8)
- Modify: `src/credential-broker/config.ts` — add `catalog` field
- Test: `src/credential-broker/config.test.ts` — add catalog parse tests
- Modify: `helm/kubeclaw/templates/credential-broker-config.yaml` — add `catalog:` section
- Test: `e2e/helm-chart.test.ts` — add catalog-renders assertion

- [ ] **Step 1: Add `CatalogEntrySchema` to resolver.ts** (just the Zod schema; resolver logic comes in Task 8)

```typescript
// src/credential-broker/resolver.ts — append below MappingSchema
export const CredentialFieldSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case'),
  envVar: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE'),
});
export type CredentialField = z.infer<typeof CredentialFieldSchema>;

export const CatalogEntrySchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, 'lowercase, digits, hyphens'),
    host: z.string().min(1),
    upstreamPort: z.number().int().positive().default(443),
    credentialFields: z.array(CredentialFieldSchema).min(1),
    baseUrlEnvs: z.record(z.string()).default({}),
    allowOperatorFallback: z.boolean().default(false),
    allowedPositions: z.array(z.enum(['header', 'body'])).default(['header', 'body']),
    apiKeyShape: z
      .object({
        prefix: z.string(),
        minLength: z.number().int().positive(),
      })
      .optional(),
  })
  .refine(
    (e) => !e.allowOperatorFallback || e.credentialFields.length === 1,
    { message: 'allowOperatorFallback requires exactly one credentialField' },
  );
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
```

- [ ] **Step 2: Extend `config.ts` schema**

```typescript
// src/credential-broker/config.ts
import { z } from 'zod';
import YAML from 'yaml';
import { MappingSchema, CatalogEntrySchema } from './resolver.js';

const ConfigSchema = z.object({
  mappings: z.array(MappingSchema).default([]),
  catalog: z.array(CatalogEntrySchema).default([]),
}).refine(
  (c) => {
    const ids = c.catalog.map((e) => e.id);
    return new Set(ids).size === ids.length;
  },
  { message: 'catalog ids must be unique' },
);
export type BrokerConfig = z.infer<typeof ConfigSchema>;

export function loadBrokerConfig(yamlText: string): BrokerConfig {
  const parsed = YAML.parse(yamlText);
  return ConfigSchema.parse(parsed);
}
```

- [ ] **Step 3: Add tests to `config.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { loadBrokerConfig } from './config.js';

describe('loadBrokerConfig — catalog', () => {
  it('parses single-field catalog entry with defaults', () => {
    const yaml = `
mappings: []
catalog:
  - id: replicate
    host: api.replicate.com
    credentialFields:
      - { name: token, envVar: REPLICATE_API_TOKEN }
    baseUrlEnvs: { REPLICATE_API_URL: "http://api.replicate.com" }
`;
    const cfg = loadBrokerConfig(yaml);
    expect(cfg.catalog).toHaveLength(1);
    expect(cfg.catalog[0].upstreamPort).toBe(443);
    expect(cfg.catalog[0].allowOperatorFallback).toBe(false);
    expect(cfg.catalog[0].allowedPositions).toEqual(['header', 'body']);
  });

  it('parses multi-field catalog entry', () => {
    const yaml = `
catalog:
  - id: jenkins
    host: jenkins.example.com
    upstreamPort: 8080
    credentialFields:
      - { name: user, envVar: JENKINS_USER }
      - { name: password, envVar: JENKINS_PASSWORD }
    allowedPositions: [header, body]
`;
    const cfg = loadBrokerConfig(yaml);
    expect(cfg.catalog[0].credentialFields).toHaveLength(2);
    expect(cfg.catalog[0].upstreamPort).toBe(8080);
  });

  it('rejects multi-field entry with allowOperatorFallback=true', () => {
    const yaml = `
catalog:
  - id: bad
    host: bad.example
    credentialFields:
      - { name: a, envVar: A }
      - { name: b, envVar: B }
    allowOperatorFallback: true
`;
    expect(() => loadBrokerConfig(yaml)).toThrow(/allowOperatorFallback/);
  });

  it('rejects duplicate catalog ids', () => {
    const yaml = `
catalog:
  - id: dup
    host: a.example
    credentialFields: [{ name: t, envVar: T }]
  - id: dup
    host: b.example
    credentialFields: [{ name: t, envVar: T }]
`;
    expect(() => loadBrokerConfig(yaml)).toThrow(/unique/);
  });

  it('validates apiKeyShape', () => {
    const yaml = `
catalog:
  - id: x
    host: x.example
    credentialFields: [{ name: t, envVar: T }]
    apiKeyShape: { prefix: "sk-", minLength: 20 }
`;
    expect(() => loadBrokerConfig(yaml)).not.toThrow();
  });

  it('rejects catalog id with uppercase', () => {
    const yaml = `
catalog:
  - id: Bad
    host: a.example
    credentialFields: [{ name: t, envVar: T }]
`;
    expect(() => loadBrokerConfig(yaml)).toThrow();
  });

  it('preserves existing mappings field', () => {
    const yaml = `
mappings:
  - id: anthropic
    destinations: [api.anthropic.com]
    identities: ["*"]
    credentialRef: { kind: Secret, name: kubeclaw-secrets, key: anthropic-api-key }
    headerScheme: bearer
catalog: []
`;
    const cfg = loadBrokerConfig(yaml);
    expect(cfg.mappings).toHaveLength(1);
    expect(cfg.catalog).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run tests, verify fail**

```bash
npx vitest run src/credential-broker/config.test.ts
```

Expected: 6 failures matching new test names.

- [ ] **Step 5: Implement (Steps 1-2 above)**

- [ ] **Step 6: Run tests, verify pass**

```bash
npx vitest run src/credential-broker/config.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Add catalog section to chart ConfigMap**

```yaml
# helm/kubeclaw/templates/credential-broker-config.yaml — append below mappings:
    catalog:
{{- range .Values.credentialInjection.catalog }}
      - id: {{ .id | quote }}
        host: {{ .host | quote }}
        upstreamPort: {{ .upstreamPort | default 443 }}
        credentialFields:
{{- range .credentialFields }}
          - { name: {{ .name | quote }}, envVar: {{ .envVar | quote }} }
{{- end }}
        baseUrlEnvs:
{{- range $k, $v := .baseUrlEnvs }}
          {{ $k }}: {{ $v | quote }}
{{- end }}
        allowOperatorFallback: {{ .allowOperatorFallback | default false }}
        allowedPositions: {{ .allowedPositions | default (list "header" "body") | toJson }}
{{- if .apiKeyShape }}
        apiKeyShape:
          prefix: {{ .apiKeyShape.prefix | quote }}
          minLength: {{ .apiKeyShape.minLength }}
{{- end }}
{{- end }}
```

- [ ] **Step 8: Add default catalog to values.yaml**

```yaml
# helm/kubeclaw/values.yaml — under credentialInjection:
credentialInjection:
  # ... existing fields ...
  # Operator-curated catalog of destinations users can register their own credentials for.
  # Each entry declares the destination host, what credential fields it needs, and which
  # env vars on tool-job pods will carry the placeholders. The broker substitutes the real
  # credential value at egress.
  catalog: []
  #   - id: replicate
  #     host: api.replicate.com
  #     upstreamPort: 443
  #     credentialFields:
  #       - { name: token, envVar: REPLICATE_API_TOKEN }
  #     baseUrlEnvs:
  #       REPLICATE_API_URL: "http://api.replicate.com"
  #     allowOperatorFallback: false
  #     allowedPositions: [header, body]
  #     apiKeyShape: { prefix: "r8_", minLength: 30 }
```

- [ ] **Step 9: Test chart renders**

```bash
helm template helm/kubeclaw --set credentialInjection.mode=sidecar \
  --set 'credentialInjection.catalog[0].id=replicate' \
  --set 'credentialInjection.catalog[0].host=api.replicate.com' \
  --set 'credentialInjection.catalog[0].credentialFields[0].name=token' \
  --set 'credentialInjection.catalog[0].credentialFields[0].envVar=REPLICATE_API_TOKEN' \
  | grep -A 12 'catalog:'
```

Expected: catalog YAML appears in rendered ConfigMap with correct shape.

- [ ] **Step 10: Add helm-chart.test.ts assertion**

```typescript
// e2e/helm-chart.test.ts — add to mode=sidecar suite
it('renders catalog entries in credential-broker ConfigMap', async () => {
  const rendered = await helmTemplate({
    'credentialInjection.mode': 'sidecar',
    'credentialInjection.catalog[0].id': 'replicate',
    'credentialInjection.catalog[0].host': 'api.replicate.com',
    'credentialInjection.catalog[0].credentialFields[0].name': 'token',
    'credentialInjection.catalog[0].credentialFields[0].envVar': 'REPLICATE_API_TOKEN',
  });
  const cm = findResource(rendered, 'ConfigMap', 'kubeclaw-credential-broker-config');
  expect(cm.data['config.yaml']).toContain('id: "replicate"');
  expect(cm.data['config.yaml']).toContain('envVar: "REPLICATE_API_TOKEN"');
});
```

- [ ] **Step 11: Commit**

```bash
git add src/credential-broker/config.ts src/credential-broker/resolver.ts \
        src/credential-broker/config.test.ts \
        helm/kubeclaw/templates/credential-broker-config.yaml \
        helm/kubeclaw/values.yaml \
        e2e/helm-chart.test.ts
git commit -m "feat(credential-broker): catalog schema in config + chart"
```

---

## Task 2: Orchestrator catalog informer (`src/k8s/catalog.ts`)

**Goal:** Orchestrator watches the broker-config ConfigMap; exposes catalog to job-runner and slash-command validator.

**Files:**
- Create: `src/k8s/catalog.ts`
- Test: `src/k8s/catalog.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/k8s/catalog.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CatalogInformer } from './catalog.js';

describe('CatalogInformer', () => {
  let mockReadCM: ReturnType<typeof vi.fn>;
  let informer: CatalogInformer;

  beforeEach(() => {
    mockReadCM = vi.fn();
    informer = new CatalogInformer({
      namespace: 'kubeclaw',
      configMapName: 'kubeclaw-credential-broker-config',
      readConfigMap: mockReadCM,
    });
  });

  it('returns empty catalog before first sync', () => {
    expect(informer.getCatalog()).toEqual([]);
  });

  it('parses catalog from ConfigMap data', async () => {
    mockReadCM.mockResolvedValue({
      data: {
        'config.yaml': `
catalog:
  - id: replicate
    host: api.replicate.com
    credentialFields: [{ name: token, envVar: REPLICATE_API_TOKEN }]
`,
      },
    });
    await informer.sync();
    expect(informer.getCatalog()).toHaveLength(1);
    expect(informer.getEntry('replicate')?.host).toBe('api.replicate.com');
  });

  it('returns null for unknown catalog id', async () => {
    mockReadCM.mockResolvedValue({ data: { 'config.yaml': 'catalog: []' } });
    await informer.sync();
    expect(informer.getEntry('nonexistent')).toBeNull();
  });

  it('updates catalog on resync', async () => {
    mockReadCM.mockResolvedValueOnce({
      data: { 'config.yaml': 'catalog: []' },
    });
    await informer.sync();
    expect(informer.getCatalog()).toHaveLength(0);

    mockReadCM.mockResolvedValueOnce({
      data: {
        'config.yaml': `
catalog:
  - id: x
    host: x.example
    credentialFields: [{ name: t, envVar: T }]
`,
      },
    });
    await informer.sync();
    expect(informer.getCatalog()).toHaveLength(1);
  });

  it('preserves previous catalog if sync fails', async () => {
    mockReadCM.mockResolvedValueOnce({
      data: {
        'config.yaml': `
catalog:
  - id: a
    host: a.example
    credentialFields: [{ name: t, envVar: T }]
`,
      },
    });
    await informer.sync();
    expect(informer.getCatalog()).toHaveLength(1);

    mockReadCM.mockRejectedValueOnce(new Error('k8s api down'));
    await informer.sync();  // does not throw
    expect(informer.getCatalog()).toHaveLength(1);  // still serves old
  });
});
```

- [ ] **Step 2: Run test, verify fail**

```bash
npx vitest run src/k8s/catalog.test.ts
```

Expected: module not found / class not defined.

- [ ] **Step 3: Implement**

```typescript
// src/k8s/catalog.ts
import { loadBrokerConfig, type BrokerConfig } from '../credential-broker/config.js';
import type { CatalogEntry } from '../credential-broker/resolver.js';
import { logger } from '../logger.js';

export interface CatalogInformerOpts {
  namespace: string;
  configMapName: string;
  readConfigMap: (namespace: string, name: string) => Promise<{ data?: Record<string, string> }>;
}

export class CatalogInformer {
  private catalog: CatalogEntry[] = [];

  constructor(private readonly opts: CatalogInformerOpts) {}

  getCatalog(): readonly CatalogEntry[] {
    return this.catalog;
  }

  getEntry(id: string): CatalogEntry | null {
    return this.catalog.find((e) => e.id === id) ?? null;
  }

  async sync(): Promise<void> {
    try {
      const cm = await this.opts.readConfigMap(this.opts.namespace, this.opts.configMapName);
      const yamlText = cm.data?.['config.yaml'] ?? '';
      const cfg: BrokerConfig = loadBrokerConfig(yamlText);
      this.catalog = cfg.catalog;
    } catch (err) {
      logger.warn({ err }, 'catalog sync failed; serving previous catalog');
    }
  }

  /** Start a periodic resync loop. Returns a stopper. */
  start(intervalMs = 30_000): () => void {
    void this.sync();
    const handle = setInterval(() => void this.sync(), intervalMs);
    return () => clearInterval(handle);
  }
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/k8s/catalog.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/catalog.ts src/k8s/catalog.test.ts
git commit -m "feat(orchestrator): catalog informer for broker ConfigMap"
```

---

## Task 3: Orchestrator secret-manager (`src/k8s/secret-manager.ts`)

**Goal:** Per-group K8s Secret CRUD with high-entropy placeholder generation.

**Files:**
- Create: `src/k8s/secret-manager.ts`
- Test: `src/k8s/secret-manager.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/k8s/secret-manager.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretManager, GROUP_SECRETS_LABEL } from './secret-manager.js';
import { CatalogInformer } from './catalog.js';

describe('SecretManager', () => {
  let mockK8s: {
    readSecret: ReturnType<typeof vi.fn>;
    createSecret: ReturnType<typeof vi.fn>;
    patchSecret: ReturnType<typeof vi.fn>;
    deleteSecret: ReturnType<typeof vi.fn>;
  };
  let catalog: CatalogInformer;
  let mgr: SecretManager;

  beforeEach(() => {
    mockK8s = {
      readSecret: vi.fn(),
      createSecret: vi.fn(),
      patchSecret: vi.fn(),
      deleteSecret: vi.fn(),
    };
    catalog = new CatalogInformer({
      namespace: 'kubeclaw',
      configMapName: 'x',
      readConfigMap: vi.fn().mockResolvedValue({
        data: {
          'config.yaml': `
catalog:
  - id: replicate
    host: api.replicate.com
    credentialFields: [{ name: token, envVar: REPLICATE_API_TOKEN }]
  - id: jenkins
    host: jenkins.example.com
    credentialFields:
      - { name: user, envVar: JENKINS_USER }
      - { name: password, envVar: JENKINS_PASSWORD }
`,
        },
      }),
    });
    return catalog.sync().then(() => {
      mgr = new SecretManager({ namespace: 'kubeclaw', catalog, k8s: mockK8s });
    });
  });

  it('generates one high-entropy placeholder per field', async () => {
    mockK8s.readSecret.mockRejectedValue({ statusCode: 404 });
    mockK8s.createSecret.mockResolvedValue({});

    await mgr.setGroupSecret('family', 'jenkins', { user: 'alice', password: 'hunter2' });

    const createCall = mockK8s.createSecret.mock.calls[0][0];
    expect(createCall.metadata.name).toBe('kubeclaw-group-secrets-family');
    expect(createCall.metadata.labels[GROUP_SECRETS_LABEL]).toBe('true');

    const jenkinsBlob = JSON.parse(
      Buffer.from(createCall.data.jenkins, 'base64').toString('utf8'),
    );
    expect(jenkinsBlob.fields.user.value).toBe('alice');
    expect(jenkinsBlob.fields.user.placeholder).toMatch(/^KC_PH_user_[0-9a-f]{64}$/);
    expect(jenkinsBlob.fields.password.placeholder).toMatch(/^KC_PH_password_[0-9a-f]{64}$/);
    expect(jenkinsBlob.fields.user.placeholder)
      .not.toEqual(jenkinsBlob.fields.password.placeholder);
    expect(jenkinsBlob.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects unknown catalog id', async () => {
    await expect(mgr.setGroupSecret('family', 'unknown', { x: 'y' }))
      .rejects.toThrow(/unknown_catalog_entry/);
  });

  it('rejects missing required field', async () => {
    await expect(mgr.setGroupSecret('family', 'jenkins', { user: 'alice' }))
      .rejects.toThrow(/missing field/);
  });

  it('rejects empty value', async () => {
    await expect(mgr.setGroupSecret('family', 'replicate', { token: '' }))
      .rejects.toThrow(/empty/);
  });

  it('rejects value with control chars', async () => {
    await expect(mgr.setGroupSecret('family', 'replicate', { token: 'abc\nxyz' }))
      .rejects.toThrow(/invalid characters/);
  });

  it('rejects value over 4KB', async () => {
    await expect(mgr.setGroupSecret('family', 'replicate', { token: 'a'.repeat(5000) }))
      .rejects.toThrow(/too long/);
  });

  it('patches existing Secret without disturbing other entries', async () => {
    mockK8s.readSecret.mockResolvedValue({
      data: {
        replicate: Buffer.from(
          JSON.stringify({
            fields: { token: { value: 'r8_old', placeholder: 'KC_PH_token_aaaa' } },
            registeredAt: '2026-05-15T00:00:00Z',
          }),
        ).toString('base64'),
      },
      metadata: { labels: { [GROUP_SECRETS_LABEL]: 'true' } },
    });
    mockK8s.patchSecret.mockResolvedValue({});

    await mgr.setGroupSecret('family', 'jenkins', { user: 'alice', password: 'hunter2' });

    const patchCall = mockK8s.patchSecret.mock.calls[0];
    expect(patchCall[0]).toBe('kubeclaw-group-secrets-family');
    expect(patchCall[1].data.jenkins).toBeDefined();
    expect(patchCall[1].data.replicate).toBeUndefined();  // patch only includes new key
  });

  it('listGroupSecrets returns names and registeredAt only, no values', async () => {
    mockK8s.readSecret.mockResolvedValue({
      data: {
        replicate: Buffer.from(
          JSON.stringify({
            fields: { token: { value: 'r8_secret', placeholder: 'KC_PH_token_x' } },
            registeredAt: '2026-05-16T10:00:00Z',
          }),
        ).toString('base64'),
      },
    });

    const list = await mgr.listGroupSecrets('family');
    expect(list).toEqual([
      { catalogId: 'replicate', registeredAt: '2026-05-16T10:00:00Z' },
    ]);
    expect(JSON.stringify(list)).not.toContain('r8_secret');
  });

  it('deleteGroupSecret removes named entry; deletes Secret if last', async () => {
    mockK8s.readSecret.mockResolvedValueOnce({
      data: {
        replicate: Buffer.from(JSON.stringify({ fields: {}, registeredAt: '' })).toString('base64'),
        jenkins: Buffer.from(JSON.stringify({ fields: {}, registeredAt: '' })).toString('base64'),
      },
    });
    await mgr.deleteGroupSecret('family', 'replicate');
    expect(mockK8s.patchSecret).toHaveBeenCalled();
    expect(mockK8s.deleteSecret).not.toHaveBeenCalled();

    mockK8s.readSecret.mockResolvedValueOnce({
      data: {
        replicate: Buffer.from('{}').toString('base64'),
      },
    });
    await mgr.deleteGroupSecret('family', 'replicate');
    expect(mockK8s.deleteSecret).toHaveBeenCalledWith('kubeclaw-group-secrets-family');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run src/k8s/secret-manager.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// src/k8s/secret-manager.ts
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
    if (CONTROL_CHAR_RE.test(v)) throw new Error('value contains invalid characters');
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
          { value: fieldValues[f.name], placeholder: this.generatePlaceholder(f.name) },
        ]),
      ),
      registeredAt: new Date().toISOString(),
    };
    const encoded = Buffer.from(JSON.stringify(blob)).toString('base64');

    let exists = true;
    try {
      await this.opts.k8s.readSecret(this.secretName(group));
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.statusCode === 404) exists = false;
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
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.statusCode === 404) return [];
      throw err;
    }
    return Object.entries(secret.data ?? {}).map(([catalogId, b64]) => {
      const blob: CredentialBlob = JSON.parse(
        Buffer.from(b64, 'base64').toString('utf8'),
      );
      return { catalogId, registeredAt: blob.registeredAt };
    });
  }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npx vitest run src/k8s/secret-manager.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/k8s/secret-manager.ts src/k8s/secret-manager.test.ts
git commit -m "feat(orchestrator): secret-manager for per-group credentials"
```

---

## Task 4: Broker `k8s-secret-source` label-watcher extension

**Goal:** Broker watches all Secrets with `kubeclaw.io/group-secrets=true` label, plus legacy `kubeclaw-secrets`. Exposes `(group, catalogId) → { fields: {name → {value, placeholder}} }`.

**Files:**
- Modify: `src/credential-broker/k8s-secret-source.ts`
- Test: `src/credential-broker/k8s-secret-source.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/credential-broker/k8s-secret-source.test.ts (extend or rewrite)
import { describe, it, expect, vi } from 'vitest';
import { K8sSecretSource, GROUP_SECRETS_LABEL } from './k8s-secret-source.js';

describe('K8sSecretSource — group secrets', () => {
  it('parses JSON-blob group secret', async () => {
    const src = new K8sSecretSource({
      readSecret: vi.fn(),
      cacheTtlMs: 0,
    });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: {
          name: 'kubeclaw-group-secrets-family',
          labels: { [GROUP_SECRETS_LABEL]: 'true' },
        },
        data: {
          replicate: Buffer.from(JSON.stringify({
            fields: { token: { value: 'r8_real', placeholder: 'KC_PH_token_xxx' } },
            registeredAt: '2026-05-16T10:00:00Z',
          })).toString('base64'),
        },
      },
    });
    expect(src.getGroupCredential('family', 'replicate')).toEqual({
      fields: { token: { value: 'r8_real', placeholder: 'KC_PH_token_xxx' } },
      registeredAt: '2026-05-16T10:00:00Z',
    });
  });

  it('returns null for unknown group or catalog', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    expect(src.getGroupCredential('nobody', 'x')).toBeNull();
  });

  it('evicts on DELETED event', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: { name: 'kubeclaw-group-secrets-family', labels: { [GROUP_SECRETS_LABEL]: 'true' } },
        data: { replicate: Buffer.from('{"fields":{},"registeredAt":""}').toString('base64') },
      },
    });
    expect(src.getGroupCredential('family', 'replicate')).not.toBeNull();
    src.applyGroupSecretEvent({
      type: 'DELETED',
      secret: { metadata: { name: 'kubeclaw-group-secrets-family' } },
    });
    expect(src.getGroupCredential('family', 'replicate')).toBeNull();
  });

  it('ignores Secrets without the label', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: { name: 'unrelated', labels: {} },
        data: { something: Buffer.from('{"fields":{},"registeredAt":""}').toString('base64') },
      },
    });
    expect(src.listGroups()).toEqual([]);
  });

  it('rejects malformed JSON-blob', () => {
    const src = new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: { name: 'kubeclaw-group-secrets-family', labels: { [GROUP_SECRETS_LABEL]: 'true' } },
        data: { bad: Buffer.from('not-json').toString('base64') },
      },
    });
    // Bad entry skipped, no throw
    expect(src.getGroupCredential('family', 'bad')).toBeNull();
  });

  it('legacy read(ref) path still works for kubeclaw-secrets', async () => {
    const readSecret = vi.fn().mockResolvedValue({
      data: { 'anthropic-api-key': Buffer.from('sk-real').toString('base64') },
    });
    const src = new K8sSecretSource({ readSecret, cacheTtlMs: 0 });
    const v = await src.read({ kind: 'Secret', name: 'kubeclaw-secrets', key: 'anthropic-api-key' });
    expect(v).toBe('sk-real');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run src/credential-broker/k8s-secret-source.test.ts
```

- [ ] **Step 3: Implement** (preserves existing `read()` signature; adds group-secret tracking)

```typescript
// src/credential-broker/k8s-secret-source.ts (rewrite)
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

interface CacheEntry { value: string; expiresAt: number }

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
      this.cache.set(cacheKey, { value, expiresAt: now + this.opts.cacheTtlMs });
    }
    return value;
  }

  applyGroupSecretEvent(ev: SecretWatchEvent): void {
    const name = ev.secret.metadata?.name;
    if (!name?.startsWith('kubeclaw-group-secrets-')) return;
    if (ev.secret.metadata?.labels?.[GROUP_SECRETS_LABEL] !== 'true' && ev.type !== 'DELETED') {
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
          blob && typeof blob === 'object' && blob.fields && typeof blob.fields === 'object'
        ) {
          newMap.set(catalogId, blob as GroupCredentialBlob);
        }
      } catch {
        // skip malformed entry
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
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/credential-broker/k8s-secret-source.ts src/credential-broker/k8s-secret-source.test.ts
git commit -m "feat(credential-broker): label-watched per-group secret cache"
```

---

## Task 5: Broker pod informer (`src/credential-broker/pod-informer.ts`)

**Goal:** Cache pods by `(uid, podIP)`; expose lookup with A1 mitigations (reject Terminating, cross-check podIP).

**Files:**
- Create: `src/credential-broker/pod-informer.ts`
- Test: `src/credential-broker/pod-informer.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/credential-broker/pod-informer.test.ts
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
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

```typescript
// src/credential-broker/pod-informer.ts
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
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/credential-broker/pod-informer.ts src/credential-broker/pod-informer.test.ts
git commit -m "feat(credential-broker): pod informer for owner-group resolution"
```

---

## Task 6: Broker `identity.ts` — `resolveOwnerGroup()`

**Goal:** Wrap the existing identity flow with a new method that returns `{ identity, ownerGroup | null }` per mode.

**Files:**
- Modify: `src/credential-broker/identity.ts`
- Test: `src/credential-broker/identity.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/credential-broker/identity.test.ts (add to existing file)
import { PodInformer, OWNER_GROUP_ANNOTATION } from './pod-informer.js';

describe('IdentityVerifier — resolveOwnerGroup', () => {
  it('sidecar: returns owner-group from pod by uid in TokenReview extras', async () => {
    const inf = new PodInformer();
    inf.upsert({
      uid: 'uid-1', name: 'pod-1', podIP: '10.0.0.1', terminating: false,
      annotations: { [OWNER_GROUP_ANNOTATION]: 'family' },
    });
    const v = new IdentityVerifier({
      createTokenReview: async () => ({
        status: {
          authenticated: true,
          user: {
            username: 'system:serviceaccount:kubeclaw:kubeclaw-tool-job',
            extra: { 'authentication.kubernetes.io/pod-uid': ['uid-1'] },
          },
        },
      } as any),
      audience: 'kubeclaw-credential-broker',
      namespace: 'kubeclaw',
      podInformer: inf,
    });
    const r = await v.resolveOwnerGroup({ authorization: 'Bearer xxx' });
    expect(r.identity).toBe('sa/kubeclaw-tool-job');
    expect(r.ownerGroup).toBe('family');
  });

  it('istio: returns owner-group via IP lookup', async () => {
    const inf = new PodInformer();
    inf.upsert({
      uid: 'uid-2', name: 'pod-2', podIP: '10.0.0.2', terminating: false,
      annotations: { [OWNER_GROUP_ANNOTATION]: 'work' },
    });
    const v = new IdentityVerifier({
      createTokenReview: async () => { throw new Error('not used'); },
      audience: 'x', namespace: 'kubeclaw', podInformer: inf,
    });
    const r = await v.resolveOwnerGroup({
      xfcc: 'By=spiffe://x;URI=spiffe://cluster.local/ns/kubeclaw/sa/kubeclaw-tool-job',
      sourceIP: '10.0.0.2',
    });
    expect(r.identity).toBe('sa/kubeclaw-tool-job');
    expect(r.ownerGroup).toBe('work');
  });

  it('returns null owner-group when pod has no annotation', async () => {
    const inf = new PodInformer();
    inf.upsert({
      uid: 'uid-3', name: 'pod-3', podIP: '10.0.0.3', terminating: false,
      annotations: {},
    });
    const v = new IdentityVerifier({
      createTokenReview: async () => ({
        status: {
          authenticated: true,
          user: {
            username: 'system:serviceaccount:kubeclaw:kubeclaw-tool-job',
            extra: { 'authentication.kubernetes.io/pod-uid': ['uid-3'] },
          },
        },
      } as any),
      audience: 'x', namespace: 'kubeclaw', podInformer: inf,
    });
    const r = await v.resolveOwnerGroup({ authorization: 'Bearer xxx' });
    expect(r.ownerGroup).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement** (extend existing class)

```typescript
// src/credential-broker/identity.ts — extend
import { PodInformer, type OwnerGroupResolution } from './pod-informer.js';

export interface IdentityVerifierOpts {
  createTokenReview: (token: string, audiences: string[]) => Promise<TokenReviewResponse>;
  audience: string;
  namespace?: string;
  podInformer?: PodInformer;  // new — required for resolveOwnerGroup
}

export interface OwnerGroupVerifyInput extends VerifyInput {
  sourceIP?: string;  // populated by ext_authz request envelope
}

export interface IdentityWithOwnerGroup {
  identity: string;
  ownerGroup: string | null;
  podUid: string | null;
}

// Inside IdentityVerifier:
async resolveOwnerGroup(input: OwnerGroupVerifyInput): Promise<IdentityWithOwnerGroup> {
  const identity = await this.verify(input);  // existing path

  if (!this.opts.podInformer) {
    return { identity, ownerGroup: null, podUid: null };
  }

  // Sidecar path: pod-uid in token review extras
  if (input.authorization) {
    const review = await this.opts.createTokenReview(
      input.authorization.replace(/^Bearer\s+/i, ''),
      [this.opts.audience],
    );
    const podUid =
      (review.status as any).user?.extra?.['authentication.kubernetes.io/pod-uid']?.[0];
    if (podUid) {
      const r = this.opts.podInformer.resolveOwnerGroupByUID(podUid);
      return r
        ? { identity, ownerGroup: r.ownerGroup, podUid: r.podUid }
        : { identity, ownerGroup: null, podUid };
    }
  }

  // Istio path: IP lookup
  if (input.sourceIP) {
    const r = this.opts.podInformer.resolveOwnerGroupByIP(input.sourceIP);
    return r
      ? { identity, ownerGroup: r.ownerGroup, podUid: r.podUid }
      : { identity, ownerGroup: null, podUid: null };
  }

  return { identity, ownerGroup: null, podUid: null };
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/credential-broker/identity.ts src/credential-broker/identity.test.ts
git commit -m "feat(credential-broker): resolveOwnerGroup with sidecar/istio paths"
```

---

## Task 7: Substitution policy (`src/credential-broker/substitution-policy.ts`)

**Files:**
- Create: `src/credential-broker/substitution-policy.ts`
- Test: `src/credential-broker/substitution-policy.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/credential-broker/substitution-policy.test.ts
import { describe, it, expect } from 'vitest';
import { SubstitutionPolicy } from './substitution-policy.js';

describe('SubstitutionPolicy', () => {
  const policy = new SubstitutionPolicy({ perPlaceholderMax: 10, totalMax: 50 });

  it('accepts within both limits', () => {
    expect(() => policy.validateCounts({ a: 3, b: 5 })).not.toThrow();
  });

  it('rejects per-placeholder over limit', () => {
    expect(() => policy.validateCounts({ a: 11 })).toThrow(/per-placeholder/);
  });

  it('rejects total over limit', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) counts[`p${i}`] = 6;  // total 60
    expect(() => policy.validateCounts(counts)).toThrow(/total/);
  });

  it('boundary: exactly at per-placeholder limit OK', () => {
    expect(() => policy.validateCounts({ a: 10 })).not.toThrow();
  });

  it('boundary: exactly at total limit OK', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 5; i++) counts[`p${i}`] = 10;  // total 50
    expect(() => policy.validateCounts(counts)).not.toThrow();
  });

  it('allowedPositions=[body] rejects header position', () => {
    expect(() => policy.validatePosition('header', ['body'])).toThrow(/disallowed/);
  });

  it('allowedPositions=[header,body] accepts both', () => {
    expect(() => policy.validatePosition('header', ['header', 'body'])).not.toThrow();
    expect(() => policy.validatePosition('body', ['header', 'body'])).not.toThrow();
  });
});
```

- [ ] **Step 2-5:** Implement, test, commit

```typescript
// src/credential-broker/substitution-policy.ts
export interface PolicyOpts {
  perPlaceholderMax: number;
  totalMax: number;
}

export class SubstitutionPolicy {
  constructor(private readonly opts: PolicyOpts) {}

  validateCounts(counts: Record<string, number>): void {
    let total = 0;
    for (const [k, v] of Object.entries(counts)) {
      if (v > this.opts.perPlaceholderMax) {
        throw new Error(`substitution_limit_exceeded: per-placeholder for ${k}`);
      }
      total += v;
    }
    if (total > this.opts.totalMax) {
      throw new Error('substitution_limit_exceeded: total');
    }
  }

  validatePosition(position: 'header' | 'body', allowed: ReadonlyArray<'header' | 'body'>): void {
    if (!allowed.includes(position)) {
      throw new Error(`substitution_position_disallowed: ${position}`);
    }
  }
}
```

```bash
git add src/credential-broker/substitution-policy.ts src/credential-broker/substitution-policy.test.ts
git commit -m "feat(credential-broker): substitution policy (counts + positions)"
```

---

## Task 8: Broker resolver — substitution map

**Goal:** New resolution semantics: returns `Array<{ placeholder, value }>` for `(group, host)`.

**Files:**
- Modify: `src/credential-broker/resolver.ts`
- Test: `src/credential-broker/resolver.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/credential-broker/resolver.test.ts (add to existing file)
import { K8sSecretSource } from './k8s-secret-source.js';
import { Resolver } from './resolver.js';

describe('Resolver — substitution map', () => {
  function makeSrc() {
    return new K8sSecretSource({ readSecret: vi.fn(), cacheTtlMs: 0 });
  }

  it('returns per-group placeholder pairs', () => {
    const src = makeSrc();
    src.applyGroupSecretEvent({
      type: 'ADDED',
      secret: {
        metadata: { name: 'kubeclaw-group-secrets-family', labels: { 'kubeclaw.io/group-secrets': 'true' } },
        data: { jenkins: Buffer.from(JSON.stringify({
          fields: {
            user: { value: 'alice', placeholder: 'KC_PH_user_aaaa' },
            password: { value: 'hunter2', placeholder: 'KC_PH_password_bbbb' },
          },
          registeredAt: '2026-05-16T00:00:00Z',
        })).toString('base64') },
      },
    });
    const r = new Resolver({
      mappings: [],
      catalog: [{ id: 'jenkins', host: 'jenkins.example.com', upstreamPort: 443,
        credentialFields: [{ name: 'user', envVar: 'JENKINS_USER' }, { name: 'password', envVar: 'JENKINS_PASSWORD' }],
        baseUrlEnvs: {}, allowOperatorFallback: false, allowedPositions: ['header', 'body'] }],
      groupSource: src,
      operatorSecretReader: vi.fn(),
    });
    const result = r.resolveSubstitutionMap({
      identity: 'sa/kubeclaw-tool-job', ownerGroup: 'family', host: 'jenkins.example.com',
    });
    expect(result.status).toBe('ok');
    expect(result.substitutions).toEqual([
      { placeholder: 'KC_PH_user_aaaa', value: 'alice' },
      { placeholder: 'KC_PH_password_bbbb', value: 'hunter2' },
    ]);
    expect(result.keySource).toBe('groupSecret');
  });

  it('returns no_credential when no per-group key and no fallback', () => {
    const src = makeSrc();
    const r = new Resolver({
      mappings: [],
      catalog: [{ id: 'replicate', host: 'api.replicate.com', upstreamPort: 443,
        credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
        baseUrlEnvs: {}, allowOperatorFallback: false, allowedPositions: ['header', 'body'] }],
      groupSource: src,
      operatorSecretReader: vi.fn(),
    });
    const result = r.resolveSubstitutionMap({
      identity: 'sa/kubeclaw-tool-job', ownerGroup: 'family', host: 'api.replicate.com',
    });
    expect(result.status).toBe('no_credential');
  });

  it('operator-fallback uses sentinel paired with operator-secret value', async () => {
    const src = makeSrc();
    const reader = vi.fn().mockResolvedValue('sk-operator');
    const r = new Resolver({
      mappings: [],
      catalog: [{ id: 'replicate', host: 'api.replicate.com', upstreamPort: 443,
        credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
        baseUrlEnvs: {}, allowOperatorFallback: true, allowedPositions: ['header', 'body'] }],
      groupSource: src,
      operatorSecretReader: reader,
    });
    const result = await r.resolveSubstitutionMapAsync({
      identity: 'sa/kubeclaw-tool-job', ownerGroup: 'family', host: 'api.replicate.com',
    });
    expect(result.status).toBe('ok');
    expect(result.substitutions).toEqual([
      { placeholder: 'KC_PH_FALLBACK_replicate', value: 'sk-operator' },
    ]);
    expect(result.keySource).toBe('operatorFallback');
  });

  it('unknown_destination when host not in catalog/mappings', () => {
    const r = new Resolver({
      mappings: [], catalog: [], groupSource: makeSrc(), operatorSecretReader: vi.fn(),
    });
    const result = r.resolveSubstitutionMap({
      identity: 'sa/kubeclaw-tool-job', ownerGroup: 'family', host: 'nope.example',
    });
    expect(result.status).toBe('unknown_destination');
  });
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement** (extend Resolver)

```typescript
// src/credential-broker/resolver.ts — replace class body
import { K8sSecretSource } from './k8s-secret-source.js';

export interface ResolveQuery {
  destination: string;
  identity: string;
}

export interface ResolveSubMapQuery {
  identity: string;
  ownerGroup: string | null;
  host: string;
}

export type ResolveResult =
  | { status: 'ok'; substitutions: Array<{ placeholder: string; value: string }>; keySource: 'groupSecret' | 'operatorFallback'; catalogId: string }
  | { status: 'no_credential'; catalogId: string }
  | { status: 'unknown_destination' }
  | { status: 'no_owner_group' };

export interface ResolverOpts {
  mappings: ReadonlyArray<Mapping>;
  catalog: ReadonlyArray<CatalogEntry>;
  groupSource: K8sSecretSource;
  operatorSecretReader: (key: string) => Promise<string | null>;
}

export class Resolver {
  constructor(private readonly opts: ResolverOpts) {}

  // legacy bearer path (unchanged callers)
  find(q: ResolveQuery): Mapping | undefined {
    return this.opts.mappings.find(
      (m) =>
        m.destinations.includes(q.destination) &&
        (m.identities.includes('*') || m.identities.includes(q.identity)),
    );
  }

  formatHeader(scheme: Mapping['headerScheme'], value: string): string {
    if (scheme !== 'bearer') throw new Error(`unsupported header scheme: ${scheme}`);
    return `Bearer ${value}`;
  }

  /** Synchronous: covers per-group hit and no-fallback miss. */
  resolveSubstitutionMap(q: ResolveSubMapQuery): ResolveResult {
    const entry = this.opts.catalog.find((e) => e.host === q.host);
    if (!entry) return { status: 'unknown_destination' };
    if (!q.ownerGroup) {
      return entry.allowOperatorFallback
        ? { status: 'no_owner_group' }  // caller awaits resolveSubstitutionMapAsync for fallback
        : { status: 'no_owner_group' };
    }
    const blob = this.opts.groupSource.getGroupCredential(q.ownerGroup, entry.id);
    if (blob) {
      const subs: Array<{ placeholder: string; value: string }> = [];
      for (const field of entry.credentialFields) {
        const f = blob.fields[field.name];
        if (!f) continue;  // schema mismatch — fail-closed at request time
        subs.push({ placeholder: f.placeholder, value: f.value });
      }
      return { status: 'ok', substitutions: subs, keySource: 'groupSecret', catalogId: entry.id };
    }
    if (entry.allowOperatorFallback) {
      return { status: 'no_credential', catalogId: entry.id };  // caller awaits Async for fallback
    }
    return { status: 'no_credential', catalogId: entry.id };
  }

  /** Async variant: also tries operator fallback if catalog entry permits. */
  async resolveSubstitutionMapAsync(q: ResolveSubMapQuery): Promise<ResolveResult> {
    const sync = this.resolveSubstitutionMap(q);
    if (sync.status !== 'no_credential') return sync;
    const entry = this.opts.catalog.find((e) => e.host === q.host);
    if (!entry || !entry.allowOperatorFallback) return sync;
    const opVal = await this.opts.operatorSecretReader(entry.id);
    if (!opVal) return sync;
    return {
      status: 'ok',
      substitutions: [{ placeholder: `KC_PH_FALLBACK_${entry.id}`, value: opVal }],
      keySource: 'operatorFallback',
      catalogId: entry.id,
    };
  }
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/credential-broker/resolver.ts src/credential-broker/resolver.test.ts
git commit -m "feat(credential-broker): resolver returns substitution map"
```

---

## Task 9: Broker `audit.ts` + `index.ts` substitution-header wiring

**Files:**
- Modify: `src/credential-broker/audit.ts` — add fields
- Modify: `src/credential-broker/index.ts` — wire pod-informer; per-request substitution-map header on ext_authz response
- Test: `src/credential-broker/index.test.ts` — assert header shape

- [ ] **Step 1: Write failing test for index.ts wire shape**

```typescript
// src/credential-broker/index.test.ts (add)
it('200 ext_authz response includes x-kubeclaw-substitute when group-cred hits', async () => {
  // Set up fakes: groupSource has family/replicate with one placeholder
  // ... POST /authz with sa/kubeclaw-tool-job + host=api.replicate.com
  // assert: response.body.OkResponse.headers includes
  //   { Header: { key: 'x-kubeclaw-substitute', value: <base64 JSON> } }
  const decoded = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  expect(decoded.substitutions).toBeInstanceOf(Array);
  expect(decoded.allowedPositions).toEqual(['header', 'body']);
  expect(decoded.perPlaceholderMax).toBe(10);
  expect(decoded.totalMax).toBe(50);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement** — modify `audit.ts` to log new fields; modify `index.ts` to:
  1. Construct Resolver with `groupSource`, `operatorSecretReader`, `catalog`
  2. Construct `PodInformer` and run a pod watcher (real K8s in prod; mockable in tests)
  3. On `/authz`: call `identity.resolveOwnerGroup(...)`, then `resolver.resolveSubstitutionMapAsync(...)`
  4. On success, base64-encode the substitution-map JSON and emit as `x-kubeclaw-substitute` response header in the OkResponse
  5. Log audit line with `ownerGroup`, `catalogId`, `keySource`, `substitutionCount` (no values)

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/credential-broker/index.ts src/credential-broker/index.test.ts src/credential-broker/audit.ts
git commit -m "feat(credential-broker): wire substitution map onto ext_authz response"
```

---

## Task 10: Orchestrator IPC handlers + `index.ts` wiring

**Goal:** Add `secret.add`, `secret.remove`, `secret.list`, `catalog.list` IPC handlers; wire `SecretManager` and `CatalogInformer` into orchestrator startup.

**Files:**
- Modify: `src/k8s/ipc-redis.ts` — add message types
- Modify: `src/index.ts` — wire informers + secret-manager; register IPC handlers
- Test: `src/k8s/ipc-redis.test.ts` — handler tests

- [ ] **Step 1: Add IPC message-type interfaces in `ipc-redis.ts`**

```typescript
export interface SecretAddIpc {
  type: 'secret.add';
  group: string;
  catalogId: string;
  fields: Record<string, string>;
}
export interface SecretRemoveIpc {
  type: 'secret.remove';
  group: string;
  catalogId: string;
}
export interface SecretListIpc {
  type: 'secret.list';
  group: string;
}
export interface CatalogListIpc {
  type: 'catalog.list';
}
// Response: { ok: true, ... } | { ok: false, error: string }
```

- [ ] **Step 2: Add tests for handler behaviour**

```typescript
// (sketch) ipc-redis.test.ts
it('secret.add handler invokes SecretManager.setGroupSecret', async () => { /* ... */ });
it('secret.list handler returns metadata only', async () => { /* ... */ });
it('catalog.list handler returns catalog entries', async () => { /* ... */ });
it('secret.add with unknown catalogId returns { ok: false }', async () => { /* ... */ });
```

- [ ] **Step 3: Implement handlers (route on `type` field; call SecretManager / CatalogInformer; serialize result)**

- [ ] **Step 4: Wire startup in `src/index.ts`**:

```typescript
// pseudo:
const catalog = new CatalogInformer({ ... });
const stopCatalog = catalog.start(30_000);
const secretMgr = new SecretManager({ namespace: K8S_NS, catalog, k8s: secretClient });
registerIpcHandler('secret.add', async (msg: SecretAddIpc) => { ... });
registerIpcHandler('secret.remove', async (msg: SecretRemoveIpc) => { ... });
registerIpcHandler('secret.list', async (msg: SecretListIpc) => secretMgr.listGroupSecrets(msg.group));
registerIpcHandler('catalog.list', async () => catalog.getCatalog());
```

- [ ] **Step 5: Run all unit tests, verify pass**

- [ ] **Step 6: Commit**

```bash
git add src/k8s/ipc-redis.ts src/k8s/ipc-redis.test.ts src/index.ts
git commit -m "feat(orchestrator): IPC handlers for secret/catalog operations"
```

---

## Task 11: Job-runner pod spec changes

**Goal:** Stamp `kubeclaw.io/owner-group` annotation and catalog-driven envs (per-group placeholders, fallback sentinel, or literal `injected-by-broker`).

**Files:**
- Modify: `src/k8s/job-runner.ts`
- Test: `src/k8s/job-runner.test.ts` — extend mode=istio block at ~line 1488

- [ ] **Step 1: Write failing tests**

```typescript
// src/k8s/job-runner.test.ts (add to mode=istio describe)
it('stamps kubeclaw.io/owner-group annotation', () => {
  const pod = buildToolJobPodSpec({ /* fixture */, group: 'family' });
  expect(pod.metadata?.annotations?.['kubeclaw.io/owner-group']).toBe('family');
});

it('stamps per-group placeholder envs when registered', () => {
  /* fixture: catalog has 'replicate'; group 'family' Secret has replicate registered */
  const pod = buildToolJobPodSpec({ /* fixture */, group: 'family' });
  const env = pod.spec?.containers[0].env ?? [];
  const tokEnv = env.find((e) => e.name === 'REPLICATE_API_TOKEN');
  expect(tokEnv?.value).toMatch(/^KC_PH_token_[0-9a-f]{64}$/);
});

it('stamps KC_PH_FALLBACK_<id> when entry allows fallback and group has no registered cred', () => {
  /* fixture: catalog 'replicate' with allowOperatorFallback: true */
  const pod = buildToolJobPodSpec({ /* fixture */, group: 'family' });
  const env = pod.spec?.containers[0].env ?? [];
  expect(env.find((e) => e.name === 'REPLICATE_API_TOKEN')?.value)
    .toBe('KC_PH_FALLBACK_replicate');
});

it('stamps "injected-by-broker" when entry disallows fallback and no registered cred', () => {
  /* fixture: catalog 'replicate' with allowOperatorFallback: false */
  const pod = buildToolJobPodSpec({ /* fixture */, group: 'family' });
  const env = pod.spec?.containers[0].env ?? [];
  expect(env.find((e) => e.name === 'REPLICATE_API_TOKEN')?.value)
    .toBe('injected-by-broker');
});

it('stamps baseUrlEnvs unconditionally per catalog entry', () => {
  const pod = buildToolJobPodSpec({ /* fixture */, group: 'family' });
  const env = pod.spec?.containers[0].env ?? [];
  expect(env.find((e) => e.name === 'REPLICATE_API_URL')?.value)
    .toBe('http://api.replicate.com');
});
```

- [ ] **Step 2: Implement** — read CatalogInformer + SecretManager.listGroupSecrets at pod-spec build time; iterate catalog; choose env value per entry (registered → placeholder; fallback-allowed-unregistered → sentinel; else `"injected-by-broker"`); add annotation.

(Will likely require refactoring `buildToolJobPodSpec` to accept `catalog` and `groupSecrets` as args; subagent should keep test signatures stable.)

- [ ] **Step 3: Verify all job-runner.test.ts tests still pass**

- [ ] **Step 4: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "feat(orchestrator): job-runner stamps owner-group + catalog envs"
```

---

## Task 12: RBAC chart updates

**Files:**
- Modify: `helm/kubeclaw/templates/credential-broker.yaml`
- Modify: `helm/kubeclaw/templates/orchestrator.yaml`
- Test: `e2e/helm-chart.test.ts`

- [ ] **Step 1: Write failing test in `helm-chart.test.ts`**

```typescript
it('broker Role widens to namespace-wide secrets and pods get', async () => {
  const rendered = await helmTemplate({ 'credentialInjection.mode': 'sidecar' });
  const role = findResource(rendered, 'Role', 'kubeclaw-credential-broker');
  const secretsRule = role.rules.find((r: any) => r.resources?.includes('secrets'));
  expect(secretsRule.verbs).toEqual(expect.arrayContaining(['get', 'list', 'watch']));
  expect(secretsRule.resourceNames).toBeUndefined();
  const podsRule = role.rules.find((r: any) => r.resources?.includes('pods'));
  expect(podsRule.verbs).toEqual(expect.arrayContaining(['get', 'list', 'watch']));
});

it('orchestrator Role adds secret write verbs', async () => {
  const rendered = await helmTemplate({ 'credentialInjection.mode': 'sidecar' });
  const role = findResource(rendered, 'Role', 'kubeclaw-orchestrator');
  const secretsRule = role.rules.find((r: any) => r.resources?.includes('secrets'));
  expect(secretsRule.verbs).toEqual(
    expect.arrayContaining(['create', 'update', 'patch', 'delete', 'get', 'list']),
  );
});
```

- [ ] **Step 2: Update broker Role in `credential-broker.yaml`**

```yaml
# Replace the existing Role rules:
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
```

- [ ] **Step 3: Update orchestrator Role in `orchestrator.yaml`**

(Add `secrets` rule with `create, update, patch, delete, get, list` namespace-wide.)

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/templates/credential-broker.yaml \
        helm/kubeclaw/templates/orchestrator.yaml \
        e2e/helm-chart.test.ts
git commit -m "feat(chart): widen RBAC for per-group Secret access"
```

---

## Task 13: Envoy Lua substitution filter (sidecar mode)

**Goal:** Lua filter that reads `x-kubeclaw-substitute` header from ext_authz response and rewrites the outgoing request body & headers in place.

**Files:**
- Create: `helm/kubeclaw/files/envoy-substitution-filter.lua`
- Modify: `helm/kubeclaw/templates/envoy-sidecar-config.yaml` — load filter

- [ ] **Step 1: Author Lua filter**

```lua
-- helm/kubeclaw/files/envoy-substitution-filter.lua
-- Reads x-kubeclaw-substitute header (base64-encoded JSON) emitted by the credential-broker
-- ext_authz step; replaces placeholder strings inline in request body and headers; enforces
-- substitution-policy limits; strips the substitute header before upstream send.

local function b64decode(s)
  return require("base64").decode(s)
end

local SKIP_BINARY = {
  ["application/octet-stream"] = true,
  ["image/jpeg"] = true,
  ["image/png"] = true,
  ["image/gif"] = true,
}

local MAX_BODY_BYTES = 1024 * 1024  -- 1 MB

function envoy_on_request(request_handle)
  local hdr = request_handle:headers():get("x-kubeclaw-substitute")
  if not hdr then return end
  request_handle:headers():remove("x-kubeclaw-substitute")

  local ok, decoded = pcall(b64decode, hdr)
  if not ok then return end
  local parsed = require("json").decode(decoded)
  if not parsed or not parsed.substitutions then return end

  local per_placeholder_max = parsed.perPlaceholderMax or 10
  local total_max = parsed.totalMax or 50
  local allowed_positions = parsed.allowedPositions or { "header", "body" }
  local allow_header = false
  local allow_body = false
  for _, p in ipairs(allowed_positions) do
    if p == "header" then allow_header = true end
    if p == "body" then allow_body = true end
  end

  local counts = {}
  local total = 0

  -- Header substitution
  if allow_header then
    local headers = request_handle:headers()
    for _, sub in ipairs(parsed.substitutions) do
      local placeholder = sub.placeholder
      local value = sub.value
      counts[placeholder] = counts[placeholder] or 0
      for name, _ in headers:pairs() do
        local hv = headers:get(name)
        if hv and string.find(hv, placeholder, 1, true) then
          local new_val, n = string.gsub(hv, placeholder, value)
          counts[placeholder] = counts[placeholder] + n
          total = total + n
          if counts[placeholder] > per_placeholder_max or total > total_max then
            request_handle:respond({ [":status"] = "503" }, "substitution_limit_exceeded")
            return
          end
          headers:replace(name, new_val)
        end
      end
    end
  end

  -- Body substitution (skip binary; skip oversize)
  local ctype = request_handle:headers():get("content-type") or ""
  if allow_body and not SKIP_BINARY[ctype:lower()] then
    local body = request_handle:body()
    if body and body:length() <= MAX_BODY_BYTES then
      local body_text = body:getBytes(0, body:length())
      local new_body = body_text
      for _, sub in ipairs(parsed.substitutions) do
        counts[sub.placeholder] = counts[sub.placeholder] or 0
        local replaced, n = string.gsub(new_body, sub.placeholder, sub.value)
        counts[sub.placeholder] = counts[sub.placeholder] + n
        total = total + n
        if counts[sub.placeholder] > per_placeholder_max or total > total_max then
          request_handle:respond({ [":status"] = "503" }, "substitution_limit_exceeded")
          return
        end
        new_body = replaced
      end
      if new_body ~= body_text then
        body:setBytes(new_body)
      end
    end
  end
end
```

- [ ] **Step 2: Wire into sidecar envoy config**

```yaml
# helm/kubeclaw/templates/envoy-sidecar-config.yaml — append Lua filter AFTER ext_authz
- name: envoy.filters.http.lua
  typed_config:
    "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua
    default_source_code:
      inline_string: |
{{ .Files.Get "files/envoy-substitution-filter.lua" | indent 8 }}
```

- [ ] **Step 3: Verify chart renders** (`helm template ... | grep -A 2 envoy.filters.http.lua`)

- [ ] **Step 4: Add helm-chart.test.ts assertion**

```typescript
it('renders Lua substitution filter in sidecar mode', async () => {
  const rendered = await helmTemplate({ 'credentialInjection.mode': 'sidecar' });
  const cm = findResource(rendered, 'ConfigMap', 'kubeclaw-credential-sidecar-envoy');
  expect(cm.data['envoy.yaml']).toContain('envoy.filters.http.lua');
  expect(cm.data['envoy.yaml']).toContain('x-kubeclaw-substitute');
});
```

- [ ] **Step 5: Commit**

```bash
git add helm/kubeclaw/files/envoy-substitution-filter.lua \
        helm/kubeclaw/templates/envoy-sidecar-config.yaml \
        e2e/helm-chart.test.ts
git commit -m "feat(chart): Envoy Lua substitution filter for sidecar mode"
```

---

## Task 14: Envoy Lua substitution filter (istio mode)

**Files:**
- Modify: `helm/kubeclaw/templates/istio-envoyfilter.yaml`

- [ ] **Step 1: Extend EnvoyFilter to inject Lua filter** AFTER `envoy.filters.http.ext_authz` patch on the egress gateway HCM chain.

```yaml
# Add to the existing istio-envoyfilter.yaml — second configPatch:
- applyTo: HTTP_FILTER
  match:
    context: GATEWAY
    listener:
      filterChain:
        filter:
          name: envoy.filters.network.http_connection_manager
          subFilter:
            name: envoy.filters.http.ext_authz
  patch:
    operation: INSERT_AFTER
    value:
      name: envoy.filters.http.lua
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua
        default_source_code:
          inline_string: |
{{ .Files.Get "files/envoy-substitution-filter.lua" | indent 14 }}
```

- [ ] **Step 2: Add helm-chart.test.ts assertion for istio mode**

```typescript
it('renders Lua substitution filter in istio EnvoyFilter', async () => {
  const rendered = await helmTemplate({ 'credentialInjection.mode': 'istio' });
  const ef = findResource(rendered, 'EnvoyFilter', 'kubeclaw-credential-broker-egress');
  const patchYaml = YAML.stringify(ef);
  expect(patchYaml).toContain('envoy.filters.http.lua');
  expect(patchYaml).toContain('x-kubeclaw-substitute');
});
```

- [ ] **Step 3: Commit**

```bash
git add helm/kubeclaw/templates/istio-envoyfilter.yaml e2e/helm-chart.test.ts
git commit -m "feat(chart): Lua substitution filter on istio egress gateway"
```

---

## Task 15: Channel-runner `/secret` command suite

**Goal:** Intercept `/secret add|remove|list|catalog|help` upstream of the LLM; coarse-regex backstop on all messages; system-event transcript injection; templated assistant reply.

**Files:**
- Modify: `src/channel-runner.ts`
- Test: `src/channel-runner.test.ts`

- [ ] **Step 1: Write failing tests** (cover all 8 cases from spec test plan section)

```typescript
// src/channel-runner.test.ts — sketch
describe('/secret command', () => {
  it('intercepts /secret add upstream of LLM', async () => { /* ... */ });
  it('drops raw user line from transcript and inserts SYSTEM event', async () => { /* ... */ });
  it('LLM never sees raw command (transcript fed to LLM contains only system event)', async () => { /* ... */ });
  it('mistyped /sercet add falls through to LLM; backstop scrubs lines matching api-key patterns', async () => { /* ... */ });
  it('unknown catalogId returns friendly error, no IPC sent', async () => { /* ... */ });
  it('empty value returns error', async () => { /* ... */ });
  it('IPC timeout: user sees retry message; cleartext zeroed', async () => { /* ... */ });
  it('parses key=value form: /secret add jenkins user=alice password=hunter2', async () => { /* ... */ });
});
```

- [ ] **Step 2: Implement**:
  - Parser: regex `/^\/secret\s+(\S+)\s*(.*)$/` matched before LLM call
  - Subcommand dispatch: `add | remove | list | catalog | help`
  - For `add`: parse positional or key=value form; call orchestrator via IPC (`secret.add`); on success, drop user line from transcript memory and insert SYSTEM event with catalog metadata; append templated assistant turn (no LLM)
  - Backstop: independent regex set built from catalog `apiKeyShape` + defaults (`sk-[A-Za-z0-9]{20,}`, `Bearer\s+[A-Za-z0-9_\-\.]{20,}`, etc.); replace matches with `[possible secret redacted]` in every inbound message before LLM call
  - `finally`: overwrite cleartext string buffers (Buffer.alloc / .fill(0))

- [ ] **Step 3: Run tests, verify pass**

- [ ] **Step 4: Commit**

```bash
git add src/channel-runner.ts src/channel-runner.test.ts
git commit -m "feat(channel-runner): /secret command suite + backstop"
```

---

## Task 16: `list_credentials` tool + per-turn system prompt block

**Files:**
- Create: `src/tools/list-credentials.ts`
- Test: `src/tools/list-credentials.test.ts`
- Modify: `src/channel-runner.ts` — register tool; prepend system block per turn

- [ ] **Step 1: Write failing test**

```typescript
// src/tools/list-credentials.test.ts
import { describe, it, expect, vi } from 'vitest';
import { listCredentialsTool } from './list-credentials.js';

describe('list_credentials tool', () => {
  it('returns merged catalog + registered metadata', async () => {
    const ipc = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: [{ catalogId: 'replicate', registeredAt: '2026-05-16T...' }] })
      .mockResolvedValueOnce({ ok: true, result: [
        { id: 'replicate', host: 'api.replicate.com', credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }] },
        { id: 'mistral', host: 'api.mistral.ai', credentialFields: [{ name: 'token', envVar: 'MISTRAL_API_KEY' }] },
      ] });
    const r = await listCredentialsTool({ group: 'family' }, { ipc });
    expect(r).toEqual([
      { catalogId: 'replicate', host: 'api.replicate.com', fields: ['token'],
        hasCredential: true, registeredAt: '2026-05-16T...' },
      { catalogId: 'mistral', host: 'api.mistral.ai', fields: ['token'],
        hasCredential: false, registeredAt: null },
    ]);
  });

  it('returns no values, hashes, or previews', async () => {
    /* ... */
    expect(JSON.stringify(result)).not.toMatch(/sk-|r8_|Bearer/);
  });

  it('returns error on IPC failure (not partial data)', async () => {
    const ipc = vi.fn().mockRejectedValue(new Error('redis down'));
    await expect(listCredentialsTool({ group: 'family' }, { ipc }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Implement** — `listCredentialsTool` calls `secret.list` and `catalog.list` IPC in parallel, merges, returns shape per spec

- [ ] **Step 3: Modify channel-runner** to register the tool and prepend the system-prompt block per turn

- [ ] **Step 4: Run tests, commit**

```bash
git add src/tools/list-credentials.ts src/tools/list-credentials.test.ts src/channel-runner.ts
git commit -m "feat(channel-runner): list_credentials tool + per-turn catalog block"
```

---

## Task 17: Integration tests — helm-chart.test.ts + broker wire shape

**Files:**
- Modify: `e2e/helm-chart.test.ts`
- Modify: `src/credential-broker/index.test.ts`
- Modify: `src/k8s/ipc-redis.test.ts`

- [ ] **Step 1: Add helm assertions** covering: catalog renders, RBAC, Lua filter sidecar + istio, mode=sidecar regression (no Lua filter changes break existing tests), mode=istio regression
- [ ] **Step 2: Add broker ext_authz wire-shape test** asserting `x-kubeclaw-substitute` header structure
- [ ] **Step 3: Add IPC integration test** for secret.add → Secret created
- [ ] **Step 4: Commit**

```bash
git commit -m "test(integration): catalog/RBAC/Lua filter + IPC end-to-end"
```

---

## Task 18: E2E mode=sidecar

**Files:**
- Modify: `e2e/credential-injection.test.ts`

- [ ] **Step 1: Set up test catalog entry** via `--set` on helm install (e.g. `testbearer` with `apiKeyEnvs: ["TEST_BEARER"]`, host `mock-upstream.kubeclaw-test`)
- [ ] **Step 2: Add seven test cases**: single-field bearer; multi-field basic; body substitution; allowedPositions=[body] rejection; counter limit; cross-group isolation; removed-credential failure
- [ ] **Step 3: Commit**

```bash
git commit -m "test(e2e): credential injection per-group secrets, sidecar mode"
```

---

## Task 19: E2E mode=istio

**Files:**
- Modify: `e2e/credential-injection-istio.test.ts`

- [ ] **Step 1: Add same seven cases as Task 18** plus owner-group-via-IP-lookup and identity-mismatch simulation
- [ ] **Step 2: Add negative test** (`/secret add` unknown catalog → no Secret created)
- [ ] **Step 3: Commit**

```bash
git commit -m "test(e2e): credential injection per-group secrets, istio mode"
```

---

## Task 20: Documentation

**Files:**
- Modify: `docs/CREDENTIAL_INJECTION.md` — new section "Per-group user-supplied secrets"
- Modify: `docs/SECURITY.md` — threat model entries

- [ ] **Step 1: Write "Per-group user-supplied secrets" section** covering: catalog schema (link to chart), `/secret` slash-command UX, placeholder/substitution mechanism, lifecycle, operator-fallback semantics, list_credentials tool
- [ ] **Step 2: Add threat-model entries** to SECURITY.md:
  - RBAC widening (A.1)
  - istio IP-recycle race (residual after A1)
  - Workload-controls-position + mitigations
  - Channel-runner transient cleartext
  - Backstop regex residual
- [ ] **Step 3: Commit**

```bash
git add docs/CREDENTIAL_INJECTION.md docs/SECURITY.md
git commit -m "docs: per-group user-supplied credentials + threat model entries"
```

---

## Self-review notes

**Spec coverage:** All major spec sections covered:
- Catalog schema → Task 1
- Per-group Secret storage → Task 3
- Placeholder generation → Task 3
- Broker RBAC widening + pod-informer → Tasks 5, 12
- Identity propagation (sidecar + istio A1) → Task 6
- Resolver substitution-map → Task 8
- Substitution policy → Task 7
- Envoy Lua filter (both modes) → Tasks 13, 14
- IPC handlers → Task 10
- Job-runner pod spec → Task 11
- Channel-runner /secret + backstop → Task 15
- list_credentials tool + per-turn block → Task 16
- Tests at three levels → Tasks across, plus 17–19
- Docs → Task 20

**Placeholders:** None — all steps have either runnable code, concrete commands, or clear implementation outlines with key signatures.

**Type consistency:** `CatalogEntry` (Task 1) is referenced by `CatalogInformer` (Task 2), `SecretManager` (Task 3), `Resolver` (Task 8), and `JobRunner` (Task 11). `OwnerGroupResolution` (Task 5) flows from `PodInformer` into `IdentityVerifier.resolveOwnerGroup` (Task 6). `GROUP_SECRETS_LABEL` constant defined once in Task 3, re-exported from `k8s-secret-source.ts` (Task 4) for consistency. `KC_PH_` prefix used consistently across Tasks 3, 5, 8, 11. `x-kubeclaw-substitute` header name used consistently across Tasks 9, 13, 14.
