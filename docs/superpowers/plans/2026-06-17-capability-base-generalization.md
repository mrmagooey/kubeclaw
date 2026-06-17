# Capability Base Generalization (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the capability deployment layer so non-HTTP (TCP), GPU/scheduled, slow-starting, and stateful-with-volume capabilities can be declared in a spec, with byte-identical output when the new fields are omitted.

**Architecture:** All changes live in `src/capabilities/`. The shared renderer `builders/common.ts` gains pluggable probe/scheduling/security/GPU rendering driven by new optional fields on `CapabilityBase`/`CapabilityResources` (`types.ts`). `registry.ts` makes the discovery endpoint scheme configurable. Per-kind builders forward the new fields. No RAG, provider, or LLM-path code is touched (those are SP2+).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest (`npm run test`), the `yaml` package (`stringify` / `parseAllDocuments`), Kubernetes YAML rendered as template strings.

## Global Constraints

- Every new field on `CapabilityBase` / `CapabilityResources` is **optional**. When omitted, rendered YAML must be byte-identical to today (regression-tested).
- `healthPath` is retained as a deprecated alias; when `probe` is absent, derive the HTTP probe from `healthPath` exactly as today.
- Probe timing override semantics: a supplied timing field applies to **both** readiness and liveness; unset fields keep their current per-probe defaults (readiness `initialDelaySeconds: 5`/`periodSeconds: 10`; liveness `initialDelaySeconds: 15`/`periodSeconds: 30`).
- GPU is a dedicated `gpu?: number` on `CapabilityResources` rendering `nvidia.com/gpu` into **both** requests and limits.
- Container `securityContext` defaults remain `runAsUser: 1000` / `runAsGroup: 1000` / `runAsNonRoot: true` / `allowPrivilegeEscalation: false` unless `podSecurity` overrides them; `allowPrivilegeEscalation: false` is always emitted.
- Imports use the `.js` suffix (ESM). Tests are colocated `*.test.ts` files run with `npm run test`.
- No changes to RAG, providers, the preprocessor seam, Qdrant, or the LLM path.

---

### Task 1: Probe generalization (http/tcp + timing + startup)

**Files:**
- Modify: `src/capabilities/types.ts` (add `ProbeConfig`; add `probe?` to `CapabilityBase`)
- Modify: `src/capabilities/builders/common.ts` (probe rendering helpers + `CommonRenderArgs.probe`)
- Test: `src/capabilities/builders/common.test.ts` (new file)

**Interfaces:**
- Produces: `ProbeConfig` interface; `CommonRenderArgs.probe?: ProbeConfig`. `renderDeploymentAndService` now renders readiness/liveness (+ optional startup) probes per `probe`/`healthPath`.
- Consumes: existing `renderDeploymentAndService(a: CommonRenderArgs): string`.

- [ ] **Step 1: Add `ProbeConfig` to `types.ts` and `probe?` to `CapabilityBase`**

In `src/capabilities/types.ts`, add above `CapabilityBase`:

```ts
export interface ProbeConfig {
  /** Probe mechanism. Default 'http'. */
  type?: 'http' | 'tcp';
  /** HTTP path (http type only). Default '/health'. */
  path?: string;
  /** Probe port. Default: the container port. */
  port?: number;
  /** Applies to BOTH readiness and liveness; unset keeps per-probe defaults. */
  initialDelaySeconds?: number;
  periodSeconds?: number;
  failureThreshold?: number;
  timeoutSeconds?: number;
  /** Optional startupProbe — guards liveness/readiness during warm-up. */
  startup?: {
    initialDelaySeconds?: number;
    periodSeconds?: number;
    failureThreshold?: number;
  };
}
```

In `CapabilityBase`, replace the `healthPath` doc comment + field with:

```ts
  /**
   * @deprecated Use `probe.path`. HTTP path the orchestrator probes for
   * liveness. Default: '/health'. Honored only when `probe` is absent.
   */
  healthPath?: string;
  /** Probe configuration. Overrides `healthPath` when present. */
  probe?: ProbeConfig;
```

- [ ] **Step 2: Write the failing test**

Create `src/capabilities/builders/common.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { renderDeploymentAndService } from './common.js';
import type { CommonRenderArgs } from './common.js';

const base: CommonRenderArgs = {
  name: 'kubeclaw-cap-t',
  namespace: 'kubeclaw',
  component: 'capability-test',
  image: 'busybox:latest',
  port: 8080,
};

function deployment(yaml: string) {
  return parseAllDocuments(yaml)
    .map((d) => d.toJSON())
    .find((d) => d.kind === 'Deployment');
}
function container(yaml: string) {
  return deployment(yaml).spec.template.spec.containers[0];
}

describe('renderDeploymentAndService probes', () => {
  it('defaults to an httpGet probe on /health (no probe, no healthPath)', () => {
    const c = container(renderDeploymentAndService(base));
    expect(c.readinessProbe.httpGet.path).toBe('/health');
    expect(c.readinessProbe.httpGet.port).toBe(8080);
    expect(c.readinessProbe.initialDelaySeconds).toBe(5);
    expect(c.livenessProbe.initialDelaySeconds).toBe(15);
    expect(c.startupProbe).toBeUndefined();
  });

  it('derives the httpGet path from healthPath when probe is absent', () => {
    const c = container(renderDeploymentAndService({ ...base, healthPath: '/healthz' }));
    expect(c.readinessProbe.httpGet.path).toBe('/healthz');
    expect(c.livenessProbe.httpGet.path).toBe('/healthz');
  });

  it('renders a tcpSocket probe when type is tcp', () => {
    const c = container(
      renderDeploymentAndService({ ...base, probe: { type: 'tcp', port: 5432 } }),
    );
    expect(c.readinessProbe.tcpSocket.port).toBe(5432);
    expect(c.livenessProbe.tcpSocket.port).toBe(5432);
    expect(c.readinessProbe.httpGet).toBeUndefined();
  });

  it('applies timing overrides to both readiness and liveness', () => {
    const c = container(
      renderDeploymentAndService({
        ...base,
        probe: { initialDelaySeconds: 7, periodSeconds: 20, failureThreshold: 4, timeoutSeconds: 3 },
      }),
    );
    expect(c.readinessProbe.initialDelaySeconds).toBe(7);
    expect(c.livenessProbe.initialDelaySeconds).toBe(7);
    expect(c.readinessProbe.failureThreshold).toBe(4);
    expect(c.livenessProbe.timeoutSeconds).toBe(3);
  });

  it('renders a startupProbe when startup is set', () => {
    const c = container(
      renderDeploymentAndService({
        ...base,
        probe: { startup: { failureThreshold: 60, periodSeconds: 5 } },
      }),
    );
    expect(c.startupProbe.failureThreshold).toBe(60);
    expect(c.startupProbe.periodSeconds).toBe(5);
    expect(c.startupProbe.httpGet.path).toBe('/health');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/capabilities/builders/common.test.ts`
Expected: FAIL — `CommonRenderArgs` has no `probe`; tcp/startup/timing assertions fail.

- [ ] **Step 4: Implement probe rendering in `common.ts`**

In `src/capabilities/builders/common.ts`, update the import line and `CommonRenderArgs`:

```ts
import type { CapabilityResources, CapabilityStorage, ProbeConfig } from '../types.js';
```

Add to `CommonRenderArgs` (after `healthPath?: string;`):

```ts
  probe?: ProbeConfig;
```

Add these module-level helpers above `renderDeploymentAndService`:

```ts
const TARGET_INDENT = '            '; // 12 spaces (under <probe>: at 10)
const PROBE_INDENT = '          '; // 10 spaces (container-level)

function renderProbeTarget(
  probe: ProbeConfig | undefined,
  healthPath: string | undefined,
  containerPort: number,
): string {
  const port = probe?.port ?? containerPort;
  if ((probe?.type ?? 'http') === 'tcp') {
    return `${TARGET_INDENT}tcpSocket:\n${TARGET_INDENT}  port: ${port}`;
  }
  const path = probe?.path ?? healthPath ?? '/health';
  return `${TARGET_INDENT}httpGet:\n${TARGET_INDENT}  path: ${path}\n${TARGET_INDENT}  port: ${port}`;
}

function renderTiming(
  probe: ProbeConfig | undefined,
  fallback: { initialDelaySeconds: number; periodSeconds: number },
): string {
  const lines = [
    `${TARGET_INDENT}initialDelaySeconds: ${probe?.initialDelaySeconds ?? fallback.initialDelaySeconds}`,
    `${TARGET_INDENT}periodSeconds: ${probe?.periodSeconds ?? fallback.periodSeconds}`,
  ];
  if (probe?.failureThreshold !== undefined)
    lines.push(`${TARGET_INDENT}failureThreshold: ${probe.failureThreshold}`);
  if (probe?.timeoutSeconds !== undefined)
    lines.push(`${TARGET_INDENT}timeoutSeconds: ${probe.timeoutSeconds}`);
  return lines.join('\n');
}

function renderProbes(
  probe: ProbeConfig | undefined,
  healthPath: string | undefined,
  containerPort: number,
): string {
  const target = renderProbeTarget(probe, healthPath, containerPort);
  const readiness =
    `${PROBE_INDENT}readinessProbe:\n${target}\n` +
    renderTiming(probe, { initialDelaySeconds: 5, periodSeconds: 10 });
  const liveness =
    `${PROBE_INDENT}livenessProbe:\n${target}\n` +
    renderTiming(probe, { initialDelaySeconds: 15, periodSeconds: 30 });
  let startup = '';
  if (probe?.startup) {
    const s = probe.startup;
    const t = [
      `${TARGET_INDENT}initialDelaySeconds: ${s.initialDelaySeconds ?? 0}`,
      `${TARGET_INDENT}periodSeconds: ${s.periodSeconds ?? 10}`,
      `${TARGET_INDENT}failureThreshold: ${s.failureThreshold ?? 30}`,
    ].join('\n');
    startup = `\n${PROBE_INDENT}startupProbe:\n${target}\n${t}`;
  }
  return `${readiness}\n${liveness}${startup}`;
}
```

Then in `renderDeploymentAndService`, delete the `const healthPath = a.healthPath ?? '/health';` line, and replace the hardcoded probe block. The current template fragment:

```
${volumeMounts}          readinessProbe:
            httpGet:
              path: ${healthPath}
              port: ${a.port}
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: ${healthPath}
              port: ${a.port}
            initialDelaySeconds: 15
            periodSeconds: 30
          securityContext:
```

becomes:

```
${volumeMounts}${renderProbes(a.probe, a.healthPath, a.port)}
          securityContext:
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/capabilities/builders/common.test.ts`
Expected: PASS (all probe cases).

- [ ] **Step 6: Run the existing builder tests (regression)**

Run: `npm run test -- src/capabilities/builders`
Expected: PASS — `mcp.test.ts`, `http.test.ts`, `rag-qdrant.test.ts` (asserts `path: /healthz`), `rag-lightrag.test.ts` unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/types.ts src/capabilities/builders/common.ts src/capabilities/builders/common.test.ts
git commit -m "feat(capabilities): http/tcp probes with tunable timing + startupProbe"
```

---

### Task 2: GPU, scheduling, and pod-security rendering

**Files:**
- Modify: `src/capabilities/types.ts` (`CapabilityScheduling`, `CapabilityPodSecurity`; `gpu?` on `CapabilityResources`; `scheduling?`/`podSecurity?` on `CapabilityBase`)
- Modify: `src/capabilities/builders/common.ts` (pod-level + container-security + GPU rendering; `CommonRenderArgs` additions; `stringify` import)
- Test: `src/capabilities/builders/common.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `CommonRenderArgs`, `renderProbes`.
- Produces: `CapabilityScheduling`, `CapabilityPodSecurity`; `CommonRenderArgs.scheduling?`, `CommonRenderArgs.podSecurity?`; `CapabilityResources.gpu?`. `renderDeploymentAndService` emits `nodeSelector`/`tolerations`/`runtimeClassName`/pod-`fsGroup`/container-security overrides/`nvidia.com/gpu`.

- [ ] **Step 1: Add types**

In `src/capabilities/types.ts`, add to `CapabilityResources`:

```ts
  /** Whole-number GPUs; renders nvidia.com/gpu into requests AND limits. */
  gpu?: number;
```

Add new interfaces near `CapabilityResources`:

```ts
export interface CapabilityScheduling {
  nodeSelector?: Record<string, string>;
  /** Raw K8s toleration objects, rendered verbatim. */
  tolerations?: Array<Record<string, unknown>>;
  runtimeClassName?: string;
}

export interface CapabilityPodSecurity {
  runAsUser?: number;
  runAsGroup?: number;
  /** Pod-level fsGroup — required for stateful images to own a mounted PVC. */
  fsGroup?: number;
  runAsNonRoot?: boolean;
}
```

Add to `CapabilityBase`:

```ts
  /** Pod scheduling controls (GPU nodes, taints, runtime class). */
  scheduling?: CapabilityScheduling;
  /** Pod/container security context overrides. */
  podSecurity?: CapabilityPodSecurity;
```

- [ ] **Step 2: Write the failing test**

Append to `src/capabilities/builders/common.test.ts`:

```ts
function podSpec(yaml: string) {
  return deployment(yaml).spec.template.spec;
}

describe('renderDeploymentAndService scheduling/security/gpu', () => {
  it('omits scheduling, fsGroup, and gpu by default', () => {
    const ps = podSpec(renderDeploymentAndService(base));
    expect(ps.nodeSelector).toBeUndefined();
    expect(ps.tolerations).toBeUndefined();
    expect(ps.runtimeClassName).toBeUndefined();
    expect(ps.securityContext).toBeUndefined();
    const c = ps.containers[0];
    expect(c.securityContext).toEqual({
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
    });
    expect(c.resources.requests['nvidia.com/gpu']).toBeUndefined();
  });

  it('renders gpu into requests and limits', () => {
    const c = podSpec(renderDeploymentAndService({ ...base, resources: { gpu: 2 } })).containers[0];
    expect(c.resources.requests['nvidia.com/gpu']).toBe(2);
    expect(c.resources.limits['nvidia.com/gpu']).toBe(2);
  });

  it('renders nodeSelector, tolerations, and runtimeClassName', () => {
    const ps = podSpec(
      renderDeploymentAndService({
        ...base,
        scheduling: {
          nodeSelector: { 'nvidia.com/gpu.present': 'true' },
          tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }],
          runtimeClassName: 'nvidia',
        },
      }),
    );
    expect(ps.nodeSelector['nvidia.com/gpu.present']).toBe('true');
    expect(ps.tolerations[0]).toEqual({ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' });
    expect(ps.runtimeClassName).toBe('nvidia');
  });

  it('renders pod fsGroup and overrides container security context', () => {
    const ps = podSpec(
      renderDeploymentAndService({
        ...base,
        podSecurity: { fsGroup: 999, runAsUser: 999, runAsGroup: 999, runAsNonRoot: false },
      }),
    );
    expect(ps.securityContext.fsGroup).toBe(999);
    expect(ps.containers[0].securityContext).toEqual({
      runAsUser: 999,
      runAsGroup: 999,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/capabilities/builders/common.test.ts`
Expected: FAIL — gpu/scheduling/podSecurity not rendered.

- [ ] **Step 4: Implement in `common.ts`**

Add the `yaml` import at the top:

```ts
import { stringify } from 'yaml';
```

Extend the types import:

```ts
import type {
  CapabilityResources,
  CapabilityStorage,
  ProbeConfig,
  CapabilityScheduling,
  CapabilityPodSecurity,
} from '../types.js';
```

Add to `CommonRenderArgs`:

```ts
  scheduling?: CapabilityScheduling;
  podSecurity?: CapabilityPodSecurity;
```

Add helpers above `renderDeploymentAndService`:

```ts
function renderPodLevel(
  scheduling: CapabilityScheduling | undefined,
  podSecurity: CapabilityPodSecurity | undefined,
): string {
  let out = '';
  if (podSecurity?.fsGroup !== undefined) {
    out += `      securityContext:\n        fsGroup: ${podSecurity.fsGroup}\n`;
  }
  if (scheduling?.runtimeClassName) {
    out += `      runtimeClassName: ${scheduling.runtimeClassName}\n`;
  }
  if (scheduling?.nodeSelector && Object.keys(scheduling.nodeSelector).length) {
    out += '      nodeSelector:\n';
    for (const [k, v] of Object.entries(scheduling.nodeSelector)) {
      out += `        ${JSON.stringify(k)}: ${JSON.stringify(v)}\n`;
    }
  }
  if (scheduling?.tolerations?.length) {
    out += '      tolerations:\n';
    for (const line of stringify(scheduling.tolerations).trimEnd().split('\n')) {
      out += `        ${line}\n`;
    }
  }
  return out;
}

function renderContainerSecurity(ps: CapabilityPodSecurity | undefined): string {
  return `          securityContext:
            runAsUser: ${ps?.runAsUser ?? 1000}
            runAsGroup: ${ps?.runAsGroup ?? 1000}
            runAsNonRoot: ${ps?.runAsNonRoot ?? true}
            allowPrivilegeEscalation: false`;
}
```

In `renderDeploymentAndService`, add a GPU fragment near the other `const … = a.…` blocks:

```ts
  const gpuLine = a.resources?.gpu
    ? `\n              nvidia.com/gpu: ${a.resources.gpu}`
    : '';
```

Insert the pod-level block between `automountServiceAccountToken: false` and `containers:`. The current fragment:

```
      automountServiceAccountToken: false
      containers:
```

becomes:

```
      automountServiceAccountToken: false
${renderPodLevel(a.scheduling, a.podSecurity)}      containers:
```

Append `${gpuLine}` after each `cpu:` line in resources:

```
            requests:
              memory: ${memReq}
              cpu: ${cpuReq}${gpuLine}
            limits:
              memory: ${memLim}
              cpu: ${cpuLim}${gpuLine}
```

Replace the hardcoded container `securityContext:` block (the four lines from Task 1's edit) with `${renderContainerSecurity(a.podSecurity)}`. The fragment from Task 1:

```
          securityContext:
            runAsUser: 1000
            runAsGroup: 1000
            runAsNonRoot: true
            allowPrivilegeEscalation: false
${volumes}---
```

becomes:

```
${renderContainerSecurity(a.podSecurity)}
${volumes}---
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/capabilities/builders/common.test.ts`
Expected: PASS (all scheduling/security/gpu cases + Task 1 cases).

- [ ] **Step 6: Regression — full builder suite + typecheck**

Run: `npm run test -- src/capabilities/builders && npm run build`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/capabilities/types.ts src/capabilities/builders/common.ts src/capabilities/builders/common.test.ts
git commit -m "feat(capabilities): GPU, scheduling, and pod-security rendering"
```

---

### Task 3: Configurable discovery-endpoint scheme

**Files:**
- Modify: `src/capabilities/types.ts` (`endpointScheme?` on `CapabilityBase`)
- Modify: `src/capabilities/registry.ts:50-52` (`endpointFor`)
- Test: `src/capabilities/registry.test.ts` (add a scheme case)

**Interfaces:**
- Consumes: existing `specToDiscoveryEntry(spec): CapabilityDiscoveryEntry`, private `endpointFor(spec)`.
- Produces: discovery `endpoint` carries `spec.endpointScheme` (default `'http'`).

- [ ] **Step 1: Add `endpointScheme?` to `CapabilityBase`**

In `src/capabilities/types.ts`, add to `CapabilityBase`:

```ts
  /** URL scheme for the discovery endpoint. Default 'http'. */
  endpointScheme?: string;
```

- [ ] **Step 2: Write the failing test**

Add to `src/capabilities/registry.test.ts` (inside an existing `describe`, or a new one — it imports `getEntriesForChannel` already; this test uses `specToDiscoveryEntry`, so add it to the imports from `./registry.js`):

```ts
describe('endpoint scheme', () => {
  it('defaults to http://', () => {
    const entry = specToDiscoveryEntry({
      kind: 'http', name: 'web', image: 'nginx', port: 8080,
    });
    expect(entry.endpoint).toBe('http://kubeclaw-cap-web:8080');
  });

  it('honors endpointScheme', () => {
    const entry = specToDiscoveryEntry({
      kind: 'http', name: 'maindb', image: 'postgres:16', port: 5432,
      endpointScheme: 'postgresql',
    });
    expect(entry.endpoint).toBe('postgresql://kubeclaw-cap-maindb:5432');
  });
});
```

If `specToDiscoveryEntry` is not already imported in this test file, add it to the existing `import { … } from './registry.js';`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -- src/capabilities/registry.test.ts`
Expected: FAIL — `endpoint` is `http://kubeclaw-cap-maindb:5432` for the scheme case.

- [ ] **Step 4: Implement in `registry.ts`**

Replace `endpointFor` (lines 50-52):

```ts
function endpointFor(spec: CapabilitySpec): string {
  const scheme = spec.endpointScheme ?? 'http';
  return `${scheme}://${deploymentName(spec.name)}:${defaultPort(spec)}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/capabilities/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/types.ts src/capabilities/registry.ts src/capabilities/registry.test.ts
git commit -m "feat(capabilities): configurable discovery-endpoint scheme"
```

---

### Task 4: Thread new fields through the per-kind builders

**Files:**
- Modify: `src/capabilities/builders/mcp.ts`, `http.ts`, `rag-qdrant.ts`, `rag-lightrag.ts`
- Test: `src/capabilities/builders/mcp.test.ts` (add a forwarding case)

**Interfaces:**
- Consumes: `CommonRenderArgs.probe`/`scheduling`/`podSecurity` (Tasks 1–2). `resources` is already forwarded, so `gpu` rides along with no extra wiring.
- Produces: every cluster builder forwards `probe`, `scheduling`, `podSecurity` from its spec to `renderDeploymentAndService`.

- [ ] **Step 1: Write the failing test**

Add to `src/capabilities/builders/mcp.test.ts`:

```ts
it('forwards probe, scheduling, and podSecurity to the renderer', () => {
  const yaml = buildMcpYaml({
    kind: 'mcp', name: 'm', image: 'img', port: 3000,
    probe: { type: 'tcp', port: 3000 },
    scheduling: { runtimeClassName: 'nvidia' },
    podSecurity: { fsGroup: 1000 },
  });
  expect(yaml).toContain('tcpSocket:');
  expect(yaml).toContain('runtimeClassName: nvidia');
  expect(yaml).toContain('fsGroup: 1000');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/capabilities/builders/mcp.test.ts`
Expected: FAIL — builder drops the new fields; YAML lacks `tcpSocket:`/`runtimeClassName`/`fsGroup`.

- [ ] **Step 3: Forward the fields in each builder**

In `mcp.ts`, `http.ts`, `rag-qdrant.ts`, and `rag-lightrag.ts`, add these three lines to the `renderDeploymentAndService({ … })` call (alongside the existing `resources`/`storage` forwarding):

```ts
    probe: spec.probe,
    scheduling: spec.scheduling,
    podSecurity: spec.podSecurity,
```

For `mcp.ts` and `http.ts`, which pass `healthPath: spec.healthPath`, keep that line (it remains the back-compat alias). For `rag-qdrant.ts`/`rag-lightrag.ts`, which pass `healthPath: spec.healthPath ?? DEFAULT_HEALTH_PATH`, keep it — when `spec.probe` is set it overrides; when absent the default health path still applies.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/capabilities/builders/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression — full builder suite**

Run: `npm run test -- src/capabilities/builders`
Expected: PASS (all four builders + common).

- [ ] **Step 6: Commit**

```bash
git add src/capabilities/builders/mcp.ts src/capabilities/builders/http.ts src/capabilities/builders/rag-qdrant.ts src/capabilities/builders/rag-lightrag.ts src/capabilities/builders/mcp.test.ts
git commit -m "feat(capabilities): forward probe/scheduling/podSecurity through builders"
```

---

### Task 5: Integration test — reconciler renders valid K8s for a TCP/GPU/stateful spec

**Files:**
- Test: `src/capabilities/reconciler.test.ts` (add a case; or a new `src/capabilities/base-generalization.integration.test.ts`)

**Interfaces:**
- Consumes: `buildYaml(spec)` from `./builders/index.js` (the reconciler's renderer) and `parseAllDocuments` from `yaml`.

- [ ] **Step 1: Write the failing/▶ test**

Add to `src/capabilities/reconciler.test.ts` (it already constructs specs; import `buildYaml` from `./builders/index.js` and `parseAllDocuments` from `yaml`):

```ts
describe('base generalization renders valid K8s', () => {
  it('renders a TCP-probed, GPU, fsGroup, scheduled http capability', () => {
    const yaml = buildYaml({
      kind: 'http',
      name: 'maindb',
      image: 'postgres:16',
      port: 5432,
      endpointScheme: 'postgresql',
      probe: { type: 'tcp', port: 5432, startup: { failureThreshold: 60 } },
      scheduling: {
        nodeSelector: { 'gpu.present': 'true' },
        tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists' }],
        runtimeClassName: 'nvidia',
      },
      podSecurity: { fsGroup: 999, runAsNonRoot: false, runAsUser: 999 },
      resources: { gpu: 1 },
      storage: { sizeGi: 10, mountPath: '/var/lib/postgresql/data' },
    });

    const docs = parseAllDocuments(yaml).map((d) => d.toJSON());
    const dep = docs.find((d) => d.kind === 'Deployment');
    const podSpec = dep.spec.template.spec;
    const c = podSpec.containers[0];

    expect(docs.map((d) => d.kind).sort()).toEqual(
      ['Deployment', 'PersistentVolumeClaim', 'Service'].sort(),
    );
    expect(c.readinessProbe.tcpSocket.port).toBe(5432);
    expect(c.startupProbe.failureThreshold).toBe(60);
    expect(c.resources.limits['nvidia.com/gpu']).toBe(1);
    expect(podSpec.runtimeClassName).toBe('nvidia');
    expect(podSpec.securityContext.fsGroup).toBe(999);
    expect(c.securityContext.runAsNonRoot).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test -- src/capabilities/reconciler.test.ts`
Expected: PASS (it exercises code already implemented in Tasks 1–4; this test locks the wiring together end-to-end at the render layer).

- [ ] **Step 3: Commit**

```bash
git add src/capabilities/reconciler.test.ts
git commit -m "test(capabilities): integration render of tcp/gpu/stateful capability"
```

---

### Task 6: E2E — a TCP-probed capability reaches Ready in minikube

**Files:**
- Test: `e2e/minikube-live-capabilities.test.ts` (add a case following the existing `install_capability` XADD pattern)

**Interfaces:**
- Consumes: the existing e2e harness — `redis.xadd('kubeclaw:task-requests', '*', 'type', 'install_capability', 'spec', JSON.stringify(spec))`, `waitForPod(labelSelector, timeoutMs)`, and the `remove_capability` XADD cleanup pattern already in this file. Read the existing install/remove cases in this file before writing (lines ~242 and ~697) to match the exact helper usage and `isMain` string convention.

- [ ] **Step 1: Add the e2e test**

Following the existing `install_capability` pattern in `e2e/minikube-live-capabilities.test.ts`, add a case that installs an `http` capability backed by a TCP image with a TCP probe, then asserts readiness:

```ts
it('deploys a TCP-probed capability and it becomes Ready', async () => {
  const spec = {
    kind: 'http',
    name: 'tcp-probe-e2e',
    image: 'redis:7-alpine',
    port: 6379,
    probe: { type: 'tcp', port: 6379, initialDelaySeconds: 2 },
  };
  await redis!.xadd(
    'kubeclaw:task-requests',
    '*',
    'type', 'install_capability',
    'spec', JSON.stringify(spec),
  );

  // tcpSocket readiness must pass for the pod to report Ready.
  await waitForPod('app=kubeclaw-cap-tcp-probe-e2e', 120_000);

  // cleanup
  await redis!.xadd(
    'kubeclaw:task-requests',
    '*',
    'type', 'remove_capability',
    'name', 'tcp-probe-e2e',
  );
});
```

Match the surrounding tests' exact field ordering / `isMain` argument if this file's install helper requires it (see the existing case near line 242).

- [ ] **Step 2: Run the e2e (requires a running minikube-live env)**

Run: `npm run test:minikube-live -- -t 'TCP-probed capability'`
Expected: PASS — the redis pod (`app=kubeclaw-cap-tcp-probe-e2e`) reaches Ready via its tcpSocket probe within 120s. If no minikube-live cluster is available, this confirms the deployment-layer change end-to-end once the env is up; note that in the PR.

- [ ] **Step 3: Commit**

```bash
git add e2e/minikube-live-capabilities.test.ts
git commit -m "test(e2e): tcp-probed capability reaches Ready"
```

---

## Self-Review

**1. Spec coverage** (against `2026-06-17-capability-base-generalization-design.md`):
- §1 Probes (http/tcp + timing + startup, healthPath alias) → Task 1. ✅
- §2 Endpoint scheme → Task 3. ✅
- §3 Scheduling (nodeSelector/tolerations/runtimeClassName) + GPU → Task 2. ✅
- §4 Pod security overrides (fsGroup/runAsUser/…) → Task 2. ✅
- §5 Builder threading → Task 4 (resources/gpu already threaded; noted). ✅
- §6 Tests: unit → Tasks 1–4; integration → Task 5; e2e → Task 6. ✅
- Back-compat byte-identical-when-omitted → regression tests in Tasks 1 (Step 6) & 2 (Step 6), default-case assertions in Tasks 1–2. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; e2e references the existing harness pattern with the concrete spec + assertion (the one unavoidable "read the existing case" is harness glue, not omitted logic). ✅

**3. Type consistency:** `ProbeConfig`, `CapabilityScheduling`, `CapabilityPodSecurity`, `CapabilityResources.gpu`, `endpointScheme` are defined once in `types.ts` (Tasks 1–3) and consumed by `common.ts`/builders/`registry.ts` under the same names. `CommonRenderArgs` field names (`probe`, `scheduling`, `podSecurity`) match the builder-forwarding lines in Task 4. Helper names (`renderProbes`, `renderProbeTarget`, `renderTiming`, `renderPodLevel`, `renderContainerSecurity`) are consistent across Tasks 1–2. ✅
