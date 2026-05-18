# remove_channel Admin Shell Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `remove_channel` tool to the admin shell that idempotently deletes a channel's Deployment, Secret, and PVCs, and stamp a `kubeclaw-channel=<instance>` label on all resources created by `setup_channel` so AC5 label-selector cleanup verification works.

**Architecture:** Three-part change: (1) add `kubeclaw-channel` label to every resource `setup_channel` creates in `channel-setup.ts`; (2) new `channel-remove.ts` module that deletes the 3 resource kinds idempotently; (3) wire `remove_channel` into `admin-shell.ts` TOOLS array + executeTool switch. E2E test drives `executeTool` directly via `kubectl exec` (no LLM required). Unit tests mock the K8s client.

**Tech Stack:** TypeScript, `@kubernetes/client-node`, vitest, kind cluster `kubeclaw-e2e-istio`, helm.

---

## Root Cause Summary

The `e2e/remove-channel.test.ts` file does not exist — it must be created. The task prompt describes failures from a previous run where that test was generated but not committed. The test must call `executeTool()` directly via `kubectl exec` (not via the LLM agentic loop) because the kind cluster has no LLM endpoint.

Key naming conventions confirmed from reading `channel-setup.ts`:
- **Deployment:** `kubeclaw-channel-<instanceName>`
- **Secret:** `kubeclaw-<instanceName>-secrets`
- **PVCs:** `kubeclaw-channel-<instanceName>-groups`, `kubeclaw-channel-<instanceName>-store`, `kubeclaw-channel-<instanceName>-sessions`
- **Label not yet stamped:** `kubeclaw-channel: <instanceName>` — this is the gap AC5 requires.

---

## Pre-flight

Read before starting:
- `src/admin-shell.ts` — full file; understand `TOOLS` array shape and `executeTool` switch pattern
- `src/skills/orchestrator/channel-setup.ts` — full file; confirm exact resource names and metadata shapes
- `src/skills/orchestrator/types.ts` — `ChannelSetupInput`, `ChannelSetupResult`
- `e2e/specialist-catalog.test.ts` lines 430–468 — `sqliteQueryInOrchestrator` pattern for `kubectl exec` into the orchestrator pod
- `e2e/global-setup.ts` — understand `KUBECLAW_SKIP_HELM_INSTALL` flow

**Branch:** You should already be in an isolated worktree. Confirm with `git branch`.

**Cluster context:** `kind-kubeclaw-e2e-istio`. Namespace: `kubeclaw`.

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `src/skills/orchestrator/channel-setup.ts` | Modify | Add `kubeclaw-channel: <instanceName>` label to Secret, PVC, and Deployment metadata |
| `src/skills/orchestrator/channel-remove.ts` | Create | `removeChannel(instanceName)` — idempotent delete of Deployment + Secret + 3 PVCs |
| `src/skills/orchestrator/channel-remove.test.ts` | Create | Unit tests for `removeChannel` with K8s client mocked |
| `src/admin-shell.ts` | Modify | Add `remove_channel` to `TOOLS` array; add import and case to `executeTool` switch |
| `e2e/remove-channel.test.ts` | Create | E2E test: helm install, setup_channel via kubectl exec, wait for Ready, remove_channel, idempotent remove, label-selector verify |

---

## Task 1: Add `kubeclaw-channel` label to `channel-setup.ts`

**Files:**
- Modify: `src/skills/orchestrator/channel-setup.ts`

### Background

`setup_channel` creates 5 K8s resources. None carry a `kubeclaw-channel` label today. The e2e test (Task 4) will verify cleanup using `kubectl get deployment,secret,pvc -n kubeclaw -l kubeclaw-channel=<instance>`. Without the label, that command always returns nothing — making the verify step unreliable. We add the label so the test can distinguish "resources exist" from "resources absent".

Note: Deployment `spec.selector.matchLabels` is **immutable** after creation. If a test re-uses the same instance name against an existing Deployment, `createOrReplaceDeployment` will call `replaceNamespacedDeployment` which rejects the changed selector. The Deployment must be deleted and re-created if the selector changes. The test in Task 4 uses a unique random suffix to avoid this.

- [ ] **Step 1.1: Add label to Secret creation in `createOrPatchSecret`**

The `createOrPatchSecret` function does not receive `instanceName`, so we add a `labels` parameter. In `channel-setup.ts`, find:

```typescript
export async function createOrPatchSecret(
  name: string,
  data: Record<string, string>,
): Promise<string> {
```

Replace with:

```typescript
export async function createOrPatchSecret(
  name: string,
  data: Record<string, string>,
  labels?: Record<string, string>,
): Promise<string> {
```

In the `createNamespacedSecret` call, change the body to:

```typescript
body: {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name, namespace: NAMESPACE, labels },
  stringData: data,
},
```

(The patch path does not need to update labels — it's safe to not retroactively label existing secrets since the test always starts from a clean state.)

- [ ] **Step 1.2: Add label to PVC creation in `createPvcIfNotExists`**

```typescript
export async function createPvcIfNotExists(
  name: string,
  size: string,
  labels?: Record<string, string>,
): Promise<string> {
```

In the `createNamespacedPersistentVolumeClaim` call:

```typescript
body: {
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: { name, namespace: NAMESPACE, labels },
  spec: {
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: size } },
  },
},
```

- [ ] **Step 1.3: Add label to Deployment in `setupChannel`**

In the `setupChannel` function, define a label map after `instanceName` is resolved:

```typescript
const channelLabel: Record<string, string> = {
  'kubeclaw-channel': instanceName,
};
```

Pass it when calling `createOrPatchSecret`:

```typescript
log.push(await createOrPatchSecret(secretName, secretData, channelLabel));
```

Pass it for each PVC:

```typescript
for (const [suffix, size] of Object.entries(pvcSizes)) {
  const pvcName = `kubeclaw-channel-${instanceName}-${suffix}`;
  log.push(await createPvcIfNotExists(pvcName, size, channelLabel));
}
```

In the `deploymentBody` object, update the three metadata/label locations:

```typescript
const deploymentBody: k8s.V1Deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: deploymentName,
    namespace: NAMESPACE,
    labels: { ...channelLabel, app: deploymentName },
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: { app: deploymentName },
    },
    template: {
      metadata: {
        labels: { app: deploymentName, ...channelLabel },
      },
      spec: {
        // ... rest unchanged
```

Important: `spec.selector.matchLabels` keeps only `{ app: deploymentName }` to avoid immutability issues on updates. The `kubeclaw-channel` label goes on `metadata.labels` and `template.metadata.labels` only.

- [ ] **Step 1.4: Verify TypeScript compiles**

```bash
cd /home/peter/projects/kubeclaw/.claude/worktrees/agent-a6825d327ab88f77d
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 1.5: Run existing channel-setup unit tests**

```bash
npx vitest run src/skills/orchestrator/channel-setup.test.ts
```

Expected: all tests pass (they test `buildSecretData` and `validateChannelCredentials`, which are unaffected).

- [ ] **Step 1.6: Commit**

```bash
git add src/skills/orchestrator/channel-setup.ts
git commit -m "feat(channel-setup): stamp kubeclaw-channel=<instance> label on Secret, PVCs, and Deployment"
```

---

## Task 2: Create `channel-remove.ts`

**Files:**
- Create: `src/skills/orchestrator/channel-remove.ts`

### Background

`removeChannel` must:
1. Delete Deployment `kubeclaw-channel-<instanceName>`
2. Delete Secret `kubeclaw-<instanceName>-secrets`
3. Delete PVCs `kubeclaw-channel-<instanceName>-groups`, `-store`, `-sessions`

All deletes treat HTTP 404 ("not found") as success (idempotent). Other errors propagate. Returns a human-readable summary listing what was deleted vs already absent.

- [ ] **Step 2.1: Write `src/skills/orchestrator/channel-remove.ts`**

```typescript
/**
 * Orchestrator skill: Channel removal.
 *
 * Idempotently removes all K8s resources created by setup_channel:
 *   - Deployment kubeclaw-channel-<instance>
 *   - Secret     kubeclaw-<instance>-secrets
 *   - PVCs       kubeclaw-channel-<instance>-{groups,store,sessions}
 */
import * as k8s from '@kubernetes/client-node';

// Lazy K8s client initialization — avoids loadFromCluster() at import time
// which throws outside a K8s cluster (e.g. during builds or tests).
let coreV1: k8s.CoreV1Api;
let appsV1: k8s.AppsV1Api;
function getK8sClients() {
  if (!coreV1) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster();
    coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  }
  return { coreV1, appsV1 };
}

const NAMESPACE = process.env.KUBECLAW_NAMESPACE || 'kubeclaw';

export interface ChannelRemoveResult {
  deleted: string[];
  alreadyAbsent: string[];
  summary: string;
}

/**
 * Returns true if the error from the K8s client is a 404 (resource not found).
 */
function isNotFound(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // @kubernetes/client-node throws objects with a `statusCode` field
    if (e['statusCode'] === 404) return true;
    // Some versions nest it under response
    const resp = e['response'] as Record<string, unknown> | undefined;
    if (resp && resp['statusCode'] === 404) return true;
  }
  return false;
}

async function tryDeleteDeployment(name: string): Promise<'deleted' | 'absent'> {
  const { appsV1 } = getK8sClients();
  try {
    await appsV1.deleteNamespacedDeployment({ name, namespace: NAMESPACE });
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

async function tryDeleteSecret(name: string): Promise<'deleted' | 'absent'> {
  const { coreV1 } = getK8sClients();
  try {
    await coreV1.deleteNamespacedSecret({ name, namespace: NAMESPACE });
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

async function tryDeletePvc(name: string): Promise<'deleted' | 'absent'> {
  const { coreV1 } = getK8sClients();
  try {
    await coreV1.deleteNamespacedPersistentVolumeClaim({ name, namespace: NAMESPACE });
    return 'deleted';
  } catch (err) {
    if (isNotFound(err)) return 'absent';
    throw err;
  }
}

/**
 * Remove all K8s resources associated with a channel instance.
 * Idempotent: treats 404 as success.
 */
export async function removeChannel(instanceName: string): Promise<ChannelRemoveResult> {
  const deploymentName = `kubeclaw-channel-${instanceName}`;
  const secretName = `kubeclaw-${instanceName}-secrets`;
  const pvcNames = [
    `kubeclaw-channel-${instanceName}-groups`,
    `kubeclaw-channel-${instanceName}-store`,
    `kubeclaw-channel-${instanceName}-sessions`,
  ];

  const deleted: string[] = [];
  const alreadyAbsent: string[] = [];

  function record(name: string, outcome: 'deleted' | 'absent'): void {
    if (outcome === 'deleted') deleted.push(name);
    else alreadyAbsent.push(name);
  }

  record(deploymentName, await tryDeleteDeployment(deploymentName));
  record(secretName, await tryDeleteSecret(secretName));
  for (const pvc of pvcNames) {
    record(pvc, await tryDeletePvc(pvc));
  }

  const deletedLines =
    deleted.length > 0
      ? `Deleted:\n${deleted.map((n) => `  - ${n}`).join('\n')}`
      : 'Nothing deleted.';
  const absentLines =
    alreadyAbsent.length > 0
      ? `Already absent:\n${alreadyAbsent.map((n) => `  - ${n}`).join('\n')}`
      : '';

  const summary = [deletedLines, absentLines].filter(Boolean).join('\n');

  return { deleted, alreadyAbsent, summary };
}
```

- [ ] **Step 2.2: Verify TypeScript compiles**

```bash
cd /home/peter/projects/kubeclaw/.claude/worktrees/agent-a6825d327ab88f77d
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2.3: Commit**

```bash
git add src/skills/orchestrator/channel-remove.ts
git commit -m "feat(channel-remove): new module — idempotent removal of channel Deployment, Secret, and PVCs"
```

---

## Task 3: Unit tests for `channel-remove.ts`

**Files:**
- Create: `src/skills/orchestrator/channel-remove.test.ts`

### Background

Mock the K8s client. Test three scenarios: (a) all resources exist → all deleted; (b) nothing exists → all absent; (c) some exist, some don't → mixed result. Also test that non-404 errors propagate (don't get swallowed).

- [ ] **Step 3.1: Write `src/skills/orchestrator/channel-remove.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── K8s mock ──────────────────────────────────────────────────────────────────
const mockDeleteDeployment = vi.fn();
const mockDeleteSecret = vi.fn();
const mockDeletePvc = vi.fn();

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    makeApiClient(cls: unknown) {
      if (cls === MockAppsV1Api) {
        return { deleteNamespacedDeployment: mockDeleteDeployment };
      }
      return {
        deleteNamespacedSecret: mockDeleteSecret,
        deleteNamespacedPersistentVolumeClaim: mockDeletePvc,
      };
    }
  },
  CoreV1Api: class MockCoreV1Api {},
  AppsV1Api: class MockAppsV1Api {},
}));

// Must import AFTER mock registration.
const { removeChannel } = await import('./channel-remove.js');

// Helper: simulate a K8s 404 error
function notFound() {
  const e: Record<string, unknown> = new Error('not found');
  e['statusCode'] = 404;
  return e;
}

describe('removeChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports deleted when all resources exist', async () => {
    mockDeleteDeployment.mockResolvedValue({});
    mockDeleteSecret.mockResolvedValue({});
    mockDeletePvc.mockResolvedValue({});

    const result = await removeChannel('test-instance');

    expect(result.deleted).toEqual([
      'kubeclaw-channel-test-instance',
      'kubeclaw-test-instance-secrets',
      'kubeclaw-channel-test-instance-groups',
      'kubeclaw-channel-test-instance-store',
      'kubeclaw-channel-test-instance-sessions',
    ]);
    expect(result.alreadyAbsent).toEqual([]);
    expect(result.summary).toContain('Deleted:');
    expect(result.summary).toContain('kubeclaw-channel-test-instance');
  });

  it('reports already-absent when no resources exist (idempotent)', async () => {
    mockDeleteDeployment.mockRejectedValue(notFound());
    mockDeleteSecret.mockRejectedValue(notFound());
    mockDeletePvc.mockRejectedValue(notFound());

    const result = await removeChannel('ghost-instance');

    expect(result.deleted).toEqual([]);
    expect(result.alreadyAbsent).toHaveLength(5);
    expect(result.summary).toContain('Already absent:');
    expect(result.summary).not.toContain('Deleted:\n');
  });

  it('handles mixed: deployment exists, everything else absent', async () => {
    mockDeleteDeployment.mockResolvedValue({});
    mockDeleteSecret.mockRejectedValue(notFound());
    mockDeletePvc.mockRejectedValue(notFound());

    const result = await removeChannel('partial-instance');

    expect(result.deleted).toEqual(['kubeclaw-channel-partial-instance']);
    expect(result.alreadyAbsent).toHaveLength(4);
  });

  it('propagates non-404 errors', async () => {
    const serverError = Object.assign(new Error('internal server error'), {
      statusCode: 500,
    });
    mockDeleteDeployment.mockRejectedValue(serverError);

    await expect(removeChannel('bad-instance')).rejects.toThrow(
      'internal server error',
    );
  });

  it('passes the correct resource names to the K8s client', async () => {
    mockDeleteDeployment.mockResolvedValue({});
    mockDeleteSecret.mockResolvedValue({});
    mockDeletePvc.mockResolvedValue({});

    await removeChannel('my-channel');

    expect(mockDeleteDeployment).toHaveBeenCalledWith({
      name: 'kubeclaw-channel-my-channel',
      namespace: 'kubeclaw',
    });
    expect(mockDeleteSecret).toHaveBeenCalledWith({
      name: 'kubeclaw-my-channel-secrets',
      namespace: 'kubeclaw',
    });
    expect(mockDeletePvc).toHaveBeenNthCalledWith(1, {
      name: 'kubeclaw-channel-my-channel-groups',
      namespace: 'kubeclaw',
    });
    expect(mockDeletePvc).toHaveBeenNthCalledWith(2, {
      name: 'kubeclaw-channel-my-channel-store',
      namespace: 'kubeclaw',
    });
    expect(mockDeletePvc).toHaveBeenNthCalledWith(3, {
      name: 'kubeclaw-channel-my-channel-sessions',
      namespace: 'kubeclaw',
    });
  });
});
```

- [ ] **Step 3.2: Run the unit tests to confirm they pass**

```bash
cd /home/peter/projects/kubeclaw/.claude/worktrees/agent-a6825d327ab88f77d
npx vitest run src/skills/orchestrator/channel-remove.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 3.3: Commit**

```bash
git add src/skills/orchestrator/channel-remove.test.ts
git commit -m "test(channel-remove): unit tests for removeChannel — all-deleted, all-absent, mixed, error propagation"
```

---

## Task 4: Wire `remove_channel` into `admin-shell.ts`

**Files:**
- Modify: `src/admin-shell.ts`

### Background

Two additions:
1. A new entry in the `TOOLS` array (OpenAI function schema).
2. A new `case 'remove_channel':` in `executeTool` + a handler function `handleRemoveChannel`.

Import `removeChannel` at the top of the file.

- [ ] **Step 4.1: Add import to `src/admin-shell.ts`**

After the existing orchestrator-skill imports, add:

```typescript
import { removeChannel } from './skills/orchestrator/channel-remove.js';
```

(It goes near the `import { setupChannel }` line.)

- [ ] **Step 4.2: Add `remove_channel` to the `TOOLS` array**

After the `setup_channel` tool definition (around line 245), add:

```typescript
  {
    type: 'function',
    function: {
      name: 'remove_channel',
      description:
        'Remove a channel instance and all its associated K8s resources (Deployment, Secret, and PersistentVolumeClaims). Idempotent — safe to call even if resources are already absent.',
      parameters: {
        type: 'object',
        properties: {
          instanceName: {
            type: 'string',
            description:
              'The channel instance name passed to setup_channel (e.g. "http", "telegram", "http-staging").',
          },
        },
        required: ['instanceName'],
      },
    },
  },
```

- [ ] **Step 4.3: Add handler function `handleRemoveChannel`**

Near the `handleSetupChannel` function (in the "K8s channel setup handlers" section), add:

```typescript
async function handleRemoveChannel(input: ToolInput): Promise<string> {
  const instanceName = input.instanceName as string | undefined;
  if (!instanceName) return 'Error: instanceName is required.';
  const result = await removeChannel(instanceName);
  return result.summary;
}
```

- [ ] **Step 4.4: Add case to `executeTool` switch**

In the `executeTool` function, after `case 'setup_channel':`, add:

```typescript
    case 'remove_channel':
      return handleRemoveChannel(input);
```

- [ ] **Step 4.5: Verify TypeScript compiles**

```bash
cd /home/peter/projects/kubeclaw/.claude/worktrees/agent-a6825d327ab88f77d
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4.6: Commit**

```bash
git add src/admin-shell.ts
git commit -m "feat(admin-shell): add remove_channel tool — wires removeChannel into TOOLS + executeTool switch"
```

---

## Task 5: Create `e2e/remove-channel.test.ts`

**Files:**
- Create: `e2e/remove-channel.test.ts`

### Background

This is an integration-level e2e test that requires a running Kubernetes cluster (`kind-kubeclaw-e2e-istio`). It does NOT need a live LLM — it calls `executeTool` directly via `kubectl exec` into the orchestrator pod.

Test flow:
1. `beforeAll`: ensure kubeclaw is installed in the kind cluster (helm install if absent, with the e2e image `kubeclaw-orchestrator:e2e-test`). Wait for orchestrator pod to be Ready.
2. **Test "setup_channel creates Deployment, Secret, and PVCs"**: call `executeTool('setup_channel', ...)` via `kubectl exec`. Wait for resources to exist. Assert all 5 exist.
3. **Test "channel Deployment becomes Ready"**: poll until Deployment has `readyReplicas >= 1`.
4. **Test "AC1/AC2: remove_channel tool exists and deletes resources"**: call `executeTool('remove_channel', {instanceName})`. Assert response contains "Deleted:" listing the deployment, secret, and PVCs.
5. **Test "AC3: idempotent second call"**: call `executeTool('remove_channel', {instanceName})` again. Assert response contains "Already absent:" and no error.
6. **Test "AC5: label selector finds no resources"**: run `kubectl get deployment,secret,pvc -n kubeclaw -l kubeclaw-channel=<instance>` and assert empty.

The instance name uses a random suffix to avoid collisions with other tests: `http-removetest-<randomSuffix>`.

The `kubectl exec` script uses dynamic import of the compiled `admin-shell.js` and calls `executeTool` directly. The script must be inline JavaScript (node -e) because the orchestrator runs compiled JS in `/app/dist/`.

- [ ] **Step 5.1: Write `e2e/remove-channel.test.ts`**

```typescript
/**
 * E2E: remove_channel admin shell tool
 *
 * Tests that the remove_channel tool in admin-shell.ts correctly removes
 * a channel's Deployment, Secret, and PersistentVolumeClaims.
 *
 * Requires: kind cluster `kubeclaw-e2e-istio` with kubeclaw installed.
 * Does NOT require a live LLM — calls executeTool() directly via kubectl exec.
 *
 * Run:
 *   kubectl config use-context kind-kubeclaw-e2e-istio
 *   KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run --config vitest.e2e.config.ts remove-channel
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from 'vitest';
import { spawnSync } from 'node:child_process';

// ── Constants ──────────────────────────────────────────────────────────────────

const KUBE_CONTEXT = 'kind-kubeclaw-e2e-istio';
const NAMESPACE = 'kubeclaw';
const CHART_DIR = './helm/kubeclaw';
const RELEASE = 'kubeclaw';
// Use a unique instance name per test run to avoid Deployment selector conflicts
const INSTANCE_SUFFIX = Math.random().toString(36).slice(2, 7);
const INSTANCE_NAME = `http-removetest-${INSTANCE_SUFFIX}`;
const DEPLOYMENT_NAME = `kubeclaw-channel-${INSTANCE_NAME}`;
const SECRET_NAME = `kubeclaw-${INSTANCE_NAME}-secrets`;
const PVC_NAMES = [
  `kubeclaw-channel-${INSTANCE_NAME}-groups`,
  `kubeclaw-channel-${INSTANCE_NAME}-store`,
  `kubeclaw-channel-${INSTANCE_NAME}-sessions`,
];

// Timeout constants
const RESOURCE_READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run kubectl with --context=KUBE_CONTEXT and return result. */
function kc(
  args: string[],
  opts: { timeout?: number } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(
    'kubectl',
    ['--context', KUBE_CONTEXT, ...args],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: opts.timeout ?? 30_000,
    },
  );
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/**
 * Call executeTool inside the orchestrator pod via kubectl exec.
 * Uses dynamic import of the compiled admin-shell.js — no LLM required.
 */
function runAdminTool(toolName: string, input: Record<string, unknown>): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const script = `
    import('/app/dist/admin-shell.js').then(async m => {
      const result = await m.executeTool(${JSON.stringify(toolName)}, ${JSON.stringify(input)});
      process.stdout.write(result + '\\n');
    }).catch(e => {
      process.stderr.write(String(e) + '\\n');
      process.exit(1);
    });
  `;
  return spawnSync(
    'kubectl',
    [
      '--context', KUBE_CONTEXT,
      '-n', NAMESPACE,
      'exec',
      `deployment/kubeclaw-orchestrator`,
      '-c', 'orchestrator',
      '--',
      'node', '--input-type=module', '-e', script,
    ],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
    },
  ) as { ok: boolean; stdout: string; stderr: string };
}

/**
 * Poll until the given condition returns true, or throw on timeout.
 */
async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ── Suite setup ────────────────────────────────────────────────────────────────

let helmInstalledByTest = false;

beforeAll(async () => {
  // Check if kubeclaw is already installed in the kind cluster
  const helmStatus = spawnSync(
    'helm',
    ['--kube-context', KUBE_CONTEXT, 'status', RELEASE, '--namespace', NAMESPACE],
    { encoding: 'utf8', stdio: 'pipe' },
  );

  if (helmStatus.status !== 0) {
    // Install kubeclaw. The caller is expected to have pre-loaded
    // kubeclaw-orchestrator:e2e-test into the kind cluster.
    console.log(`Installing kubeclaw into ${KUBE_CONTEXT}...`);
    spawnSync('kubectl', ['--context', KUBE_CONTEXT, 'create', 'namespace', NAMESPACE], {
      encoding: 'utf8', stdio: 'pipe',
    });
    const install = spawnSync(
      'helm',
      [
        '--kube-context', KUBE_CONTEXT,
        'upgrade', '--install',
        RELEASE, CHART_DIR,
        '--namespace', NAMESPACE,
        '--timeout', '120s',
        '--set', `namespace=${NAMESPACE}`,
        '--set', 'secrets.anthropicApiKey=test-key',
        '--set', 'secrets.claudeCodeOauthToken=test-token',
        '--set', 'redis.password=e2e-test-pass',
        '--set', 'image.tag=e2e-test',
        '--set', 'image.pullPolicy=Never',
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 180_000 },
    );
    if (install.status !== 0) {
      throw new Error(`helm install failed:\n${install.stderr}`);
    }
    helmInstalledByTest = true;
  }

  // Wait for orchestrator pod to be Ready
  console.log('Waiting for kubeclaw-orchestrator to be Ready...');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const r = kc([
      'get', 'deployment', 'kubeclaw-orchestrator',
      '-n', NAMESPACE,
      '-o', 'jsonpath={.status.readyReplicas}',
    ]);
    if (r.ok && r.stdout.trim() === '1') break;
    await sleep(3_000);
  }
  const finalCheck = kc([
    'get', 'deployment', 'kubeclaw-orchestrator',
    '-n', NAMESPACE,
    '-o', 'jsonpath={.status.readyReplicas}',
  ]);
  if (!finalCheck.ok || finalCheck.stdout.trim() !== '1') {
    throw new Error('kubeclaw-orchestrator not Ready after 120s');
  }
  console.log('kubeclaw-orchestrator is Ready');
}, 180_000);

afterAll(() => {
  // Clean up test channel resources regardless of test outcome
  const resources = [DEPLOYMENT_NAME, ...PVC_NAMES.map(p => `pvc/${p}`)];
  for (const r of resources) {
    kc(['delete', r, '-n', NAMESPACE, '--ignore-not-found']);
  }
  kc(['delete', 'secret', SECRET_NAME, '-n', NAMESPACE, '--ignore-not-found']);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('remove_channel admin shell tool', () => {
  it('setup_channel creates Deployment, Secret, and PVCs', async () => {
    // Call setup_channel via executeTool directly (no LLM needed)
    const result = runAdminTool('setup_channel', {
      type: 'http',
      instanceName: INSTANCE_NAME,
      httpUsers: 'testuser:testpass',
      httpPort: 4080,
    });

    expect(result.ok, `setup_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(true);
    expect(result.stdout).toMatch(/Created|Updated/);

    // Wait for Deployment to appear
    await waitUntil(
      () => {
        const r = kc(['get', 'deployment', DEPLOYMENT_NAME, '-n', NAMESPACE]);
        return r.ok;
      },
      RESOURCE_READY_TIMEOUT_MS,
      `Deployment ${DEPLOYMENT_NAME} to exist`,
    );

    // Verify Secret exists
    const secretCheck = kc(['get', 'secret', SECRET_NAME, '-n', NAMESPACE]);
    expect(secretCheck.ok, `Secret ${SECRET_NAME} not found`).toBe(true);

    // Verify all 3 PVCs exist
    for (const pvc of PVC_NAMES) {
      const pvcCheck = kc(['get', 'pvc', pvc, '-n', NAMESPACE]);
      expect(pvcCheck.ok, `PVC ${pvc} not found`).toBe(true);
    }
  }, RESOURCE_READY_TIMEOUT_MS + 30_000);

  it('channel Deployment becomes Ready', async () => {
    await waitUntil(
      () => {
        const r = kc([
          'get', 'deployment', DEPLOYMENT_NAME,
          '-n', NAMESPACE,
          '-o', 'jsonpath={.status.readyReplicas}',
        ]);
        return r.ok && r.stdout.trim() === '1';
      },
      RESOURCE_READY_TIMEOUT_MS,
      `Deployment ${DEPLOYMENT_NAME} to have readyReplicas=1`,
    );
  }, RESOURCE_READY_TIMEOUT_MS + 10_000);

  it('AC1/AC2: remove_channel tool exists and deletes Deployment, Secret, and PVCs', async () => {
    const result = runAdminTool('remove_channel', { instanceName: INSTANCE_NAME });

    expect(
      result.ok,
      `remove_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(true);

    const output = result.stdout;
    expect(output).toContain('Deleted:');
    expect(output).toContain(DEPLOYMENT_NAME);
    expect(output).toContain(SECRET_NAME);
    for (const pvc of PVC_NAMES) {
      expect(output).toContain(pvc);
    }

    // Verify resources are actually gone
    await waitUntil(
      () => {
        const r = kc(['get', 'deployment', DEPLOYMENT_NAME, '-n', NAMESPACE]);
        return !r.ok;
      },
      30_000,
      `Deployment ${DEPLOYMENT_NAME} to be deleted`,
    );
  }, 60_000);

  it('AC3: idempotent — second remove_channel call succeeds with already-absent summary', async () => {
    const result = runAdminTool('remove_channel', { instanceName: INSTANCE_NAME });

    expect(
      result.ok,
      `second remove_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(true);

    const output = result.stdout;
    expect(output).toContain('Already absent:');
    // Should NOT report any deletions
    expect(output).not.toContain('Deleted:\n');
  }, 30_000);

  it('AC5: kubectl label selector finds no resources after remove', () => {
    const result = kc([
      'get', 'deployment,secret,pvc',
      '-n', NAMESPACE,
      '-l', `kubeclaw-channel=${INSTANCE_NAME}`,
      '--ignore-not-found',
      '-o', 'name',
    ]);

    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe('');
  });
});
```

- [ ] **Step 5.2: Verify TypeScript compiles (e2e file is included in tsconfig)**

```bash
cd /home/peter/projects/kubeclaw/.claude/worktrees/agent-a6825d327ab88f77d
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5.3: Commit**

```bash
git add e2e/remove-channel.test.ts
git commit -m "test(e2e): add remove-channel e2e test — setup_channel + remove_channel + idempotency + label selector verify"
```

---

## Task 6: Build image, load into kind, run the test

### Background

The kind cluster (`kind-kubeclaw-e2e-istio`) cannot pull images from Docker Hub; images must be loaded manually. The sequence is: build → save → load. `kind load docker-image` fails with multi-arch manifests, so we use `docker save | kind load image-archive`.

- [ ] **Step 6.1: Build and load the image**

```bash
cd /home/peter/projects/kubeclaw/.claude/worktrees/agent-a6825d327ab88f77d
docker build -t kubeclaw-orchestrator:e2e-test .
docker save kubeclaw-orchestrator:e2e-test -o /tmp/orch.tar
kind load image-archive /tmp/orch.tar --name kubeclaw-e2e-istio
```

Expected: each command exits 0. Final line of `kind load` should be `Image: "kubeclaw-orchestrator:e2e-test" with ID ... loaded.`

- [ ] **Step 6.2: Delete existing kubeclaw namespace to start clean**

```bash
kubectl --context kind-kubeclaw-e2e-istio delete namespace kubeclaw --ignore-not-found --timeout=60s
kubectl config use-context kind-kubeclaw-e2e-istio
```

- [ ] **Step 6.3: Run the test**

```bash
cd /home/peter/projects/kubeclaw/.claude/worktrees/agent-a6825d327ab88f77d
KUBECLAW_SKIP_HELM_INSTALL=true npx vitest run --config vitest.e2e.config.ts remove-channel 2>&1 | tee /tmp/remove-channel-final.log
```

Expected: `5/5 tests passed`.

- [ ] **Step 6.4: If tests fail, diagnose**

Common failure modes and fixes:

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot find module '/app/dist/admin-shell.js'` | Image didn't include compiled JS | Confirm `Dockerfile` runs `npm run build`; rebuild image |
| `Error: The admin shell can only be run inside the orchestrator pod` | `KUBERNETES_SERVICE_HOST` not set inside exec | Add `KUBERNETES_SERVICE_HOST=1` env override in the node -e script OR check if admin-shell guards against import (it should — `isDirectRun` check) |
| `setup_channel failed: No credentials provided` | input field mismatch | Verify `httpUsers` is the correct field name in `ChannelSetupInput` |
| `Deployment not Ready after 120s` | Channel pod can't start (missing Redis, etc.) | Check `kubectl logs deployment/kubeclaw-channel-... -n kubeclaw` |
| `remove_channel: Unknown tool` | Admin-shell case missing | Verify Task 4 changes are in the built image |

**Checking the `isDirectRun` guard:**

The `main()` function in `admin-shell.ts` is gated by `isDirectRun`. The `executeTool` function is exported and has no such guard. However, `admin-shell.ts` imports from modules that call `kc.loadFromCluster()` lazily (the `getK8sClients()` pattern), so `import()` is safe from outside a cluster. The `KUBERNETES_SERVICE_HOST` check only runs in `main()`, not at module level.

- [ ] **Step 6.5: Commit test results log (optional, for CI traceability)**

Not needed — the log is at `/tmp/remove-channel-final.log`.

---

## Self-Review

### Spec coverage check

| Acceptance Criterion | Covered by |
|---------------------|-----------|
| AC1: admin shell exposes `remove_channel` tool accepting instance name | Task 4 — `TOOLS` array entry |
| AC2: deletes Deployment + Secret + PVC | Task 2 `removeChannel` + Task 4 handler; Task 5 test "AC1/AC2" |
| AC3: idempotent — succeeds when resources absent | Task 2 `isNotFound` + Task 5 test "AC3" |
| AC4: human-readable summary listing deleted vs absent | Task 2 `summary` field + Task 5 asserts "Deleted:" / "Already absent:" |
| AC5: label selector returns empty after remove | Task 1 labels + Task 5 test "AC5" |

All 5 ACs have corresponding test coverage.

### Placeholder scan

No TBDs, TODOs, or "implement later" in this plan. All code blocks are complete and compilable.

### Type consistency

- `removeChannel(instanceName: string)` defined in Task 2, called in Task 4 (`handleRemoveChannel`) — consistent.
- `ChannelRemoveResult` interface defined in Task 2, not referenced outside Task 2 — consistent.
- `createOrPatchSecret(name, data, labels?)` signature changed in Task 1, call site updated in same task — consistent.
- `createPvcIfNotExists(name, size, labels?)` signature changed in Task 1, call site updated in same task — consistent.
- `executeTool` switch case `'remove_channel'` → `handleRemoveChannel(input)` — matches async function signature.

### Edge cases verified

- The `spec.selector.matchLabels` on the Deployment keeps only `{ app: deploymentName }` to avoid the immutable selector constraint when `createOrReplaceDeployment` calls `replaceNamespacedDeployment`.
- `isNotFound` checks `statusCode === 404` directly on the thrown object (the `@kubernetes/client-node` pattern) — not relying on `instanceof Error`.
- `runAdminTool` uses `--input-type=module` flag so dynamic `import()` works in the node -e inline script.
