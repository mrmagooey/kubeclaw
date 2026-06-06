# Story 176: Manifest Hash Mismatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the advisory agent-reported hash check in `commit_channel_config` with an orchestrator-side independent PVC read, so a compromised or buggy bootstrap agent cannot bypass supply-chain integrity by reporting its own post-deviate hash.

**Architecture:** A long-lived inspector sidecar (same image as the bootstrap container) is added to every bootstrap Job spec; it mounts the runtime PVC at `/runtime-inspect` and runs `sleep infinity`. When `commit_channel_config` arrives, the orchestrator `kubectl exec`-es into the sidecar to `cat` both package files, feeds the content to the existing `computeManifestHash`, compares against the ConfigMap's stored hash, and hard-rejects on mismatch before any Secret or Deployment is created.

**Tech Stack:** TypeScript, Node.js, `@kubernetes/client-node`, prom-client (Counter), Redis pub/sub (ioredis), Vitest.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/k8s/bootstrap-runner.ts` | Modify | Add `inspector` sidecar + `sidecarImage` opt to bootstrap Job spec |
| `src/k8s/ipc-redis-bootstrap.ts` | Modify | Add `readPvcFiles`, `deleteJob`, `recordMismatch` deps; implement rejection cascade |
| `src/metrics/orchestrator.ts` | Modify | Add `recordBootstrapManifestMismatch` to interface + counter impl |
| `src/index.ts` | Modify | Wire `readPvcFiles`, `deleteJob`, `recordMismatch` into `registerBootstrapDeps` call |
| `src/k8s/ipc-redis-bootstrap.test.ts` | Modify | Add mismatch unit tests (6 new cases) |
| `src/k8s/bootstrap-hash-validation.integration.test.ts` | Create | Integration tests for `computeManifestHash` determinism |
| `e2e/minikube-live-bootstrap-hash-mismatch.test.ts` | Create | Deferred e2e placeholder (skip.todo) |

---

## Task 1: Add `recordBootstrapManifestMismatch` metric to orchestrator metrics

**Files:**
- Modify: `src/metrics/orchestrator.ts`

- [ ] **Step 1: Write the failing test (metrics interface)**

  Add to `src/metrics/orchestrator.test.ts`:

  ```typescript
  describe('recordBootstrapManifestMismatch', () => {
    it('increments kubeclaw_bootstrap_manifest_mismatch_total{channel_type} counter', async () => {
      const registry = new Registry();
      const metrics = createOrchestratorMetrics(registry);
      metrics.recordBootstrapManifestMismatch({ channel_type: 'telegram' });
      const text = await registry.metrics();
      expect(text).toMatch(
        /kubeclaw_bootstrap_manifest_mismatch_total\{channel_type="telegram"\} 1/,
      );
    });

    it('counter appears at 0 in scrape output even before any mismatch', async () => {
      const registry = new Registry();
      createOrchestratorMetrics(registry);
      const text = await registry.metrics();
      // prom-client emits 0-valued counters once declared
      expect(text).toMatch(/kubeclaw_bootstrap_manifest_mismatch_total/);
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  ```bash
  npx vitest run src/metrics/orchestrator.test.ts --reporter=verbose
  ```
  Expected: FAIL — `recordBootstrapManifestMismatch is not a function`

- [ ] **Step 3: Implement in `src/metrics/orchestrator.ts`**

  Add to the `OrchestratorMetrics` interface:
  ```typescript
  recordBootstrapManifestMismatch(labels: { channel_type: string }): void;
  ```

  Add counter inside `createOrchestratorMetrics`:
  ```typescript
  const bootstrapManifestMismatch = new Counter({
    name: 'kubeclaw_bootstrap_manifest_mismatch_total',
    help: 'Total bootstrap commits rejected due to runtime PVC hash diverging from the channel manifest',
    labelNames: ['channel_type'] as const,
    registers: [registry],
  });
  ```

  Add to the returned object:
  ```typescript
  recordBootstrapManifestMismatch({ channel_type }) {
    bootstrapManifestMismatch.inc({ channel_type });
  },
  ```

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run src/metrics/orchestrator.test.ts --reporter=verbose
  ```
  Expected: all pass

- [ ] **Step 5: Commit**

  ```bash
  git add src/metrics/orchestrator.ts src/metrics/orchestrator.test.ts
  git commit -m "feat(metrics): add kubeclaw_bootstrap_manifest_mismatch_total counter (Story 176)"
  ```

---

## Task 2: Add inspector sidecar to bootstrap Job spec

**Files:**
- Modify: `src/k8s/bootstrap-runner.ts`

The bootstrap Job gets a second container `inspector` running the same image with `command: ['sleep', 'infinity']` and the runtime PVC mounted at `/runtime-inspect`. This container stays alive for the entire bootstrap duration so the orchestrator can `kubectl exec` into it.

- [ ] **Step 1: Write the failing test**

  Add to `src/k8s/bootstrap-runner.test.ts` in the `bootstrapChannelFromSkill` describe block:

  ```typescript
  it('bootstrap Job spec includes an inspector sidecar mounting runtime PVC at /runtime-inspect', async () => {
    const coreV1 = makeCoreV1();
    const batchV1 = makeBatchV1();
    await bootstrapChannelFromSkill({
      skillName: 'bootstrap-telegram',
      channelType: 'telegram',
      instanceName: 'my-telegram',
      k8sDeps: { coreV1, batchV1 },
      namespace: 'kubeclaw-test',
      channelBaseImage: 'kubeclaw-channel-base:latest',
      activeBootstraps: new Map(),
    });
    const jobBody = (batchV1.createNamespacedJob as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    const containers = jobBody.spec.template.spec.containers as Array<{
      name: string;
      command?: string[];
      volumeMounts?: Array<{ mountPath: string }>;
    }>;
    const inspector = containers.find((c) => c.name === 'inspector');
    expect(inspector).toBeTruthy();
    expect(inspector?.command).toEqual(['sleep', 'infinity']);
    expect(inspector?.volumeMounts?.some((m) => m.mountPath === '/runtime-inspect')).toBe(true);
  });
  ```

  _(Note: `makeCoreV1` and `makeBatchV1` are existing helpers in `bootstrap-runner.test.ts` — check the existing file for their exact signatures and adapt accordingly.)_

- [ ] **Step 2: Run to verify it fails**

  ```bash
  npx vitest run src/k8s/bootstrap-runner.test.ts --reporter=verbose 2>&1 | grep -E "FAIL|inspector|✓|✗"
  ```
  Expected: new test FAIL

- [ ] **Step 3: Add inspector sidecar to `bootstrapChannelFromSkill`**

  In `src/k8s/bootstrap-runner.ts`, inside `bootstrapChannelFromSkill`, extend the `containers` array in `jobBody.spec.template.spec`:

  ```typescript
  // After the existing 'bootstrap' container entry:
  {
    name: 'inspector',
    image: channelBaseImage,
    imagePullPolicy: 'IfNotPresent',
    command: ['sleep', 'infinity'],
    volumeMounts: [
      { name: 'runtime', mountPath: '/runtime-inspect' },
    ],
  },
  ```

  The volumes array already has `runtime` (the PVC) — no change needed there.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  npx vitest run src/k8s/bootstrap-runner.test.ts --reporter=verbose
  ```
  Expected: all pass (including the new inspector test)

- [ ] **Step 5: Commit**

  ```bash
  git add src/k8s/bootstrap-runner.ts src/k8s/bootstrap-runner.test.ts
  git commit -m "feat(bootstrap): add inspector sidecar to bootstrap Job for orchestrator PVC read (Story 176)"
  ```

---

## Task 3: Extend `CommitChannelConfigDeps` with mismatch-path operations

**Files:**
- Modify: `src/k8s/ipc-redis-bootstrap.ts`

Add three new deps:
- `readPvcFiles(instanceName: string): Promise<{ packageJson: string; packageLockJson: string }>` — reads actual files from the runtime PVC via the inspector sidecar
- `deleteJob(jobName: string): Promise<void>` — deletes the bootstrap Job on mismatch (idempotent)
- `recordMismatch(labels: { channel_type: string }): void` — increments the metric

Also add `deletePvc(pvcName: string): Promise<void>` which is needed for the mismatch path (was already needed by Story 175 cleanup but not in this dep set).

- [ ] **Step 1: Update the `CommitChannelConfigDeps` interface**

  In `src/k8s/ipc-redis-bootstrap.ts`, update the interface:

  ```typescript
  export interface CommitChannelConfigDeps {
    /** Create or update a K8s Secret (creates if not exists, patches if exists) */
    createSecret(name: string, data: Record<string, string>): Promise<void>;
    /** Create or replace a K8s Deployment */
    createDeployment(body: V1Deployment): Promise<void>;
    /** Publish a reply to the bootstrap pod's reply channel */
    publishReply(
      replyChannel: string,
      payload: { ok: boolean; error?: string },
    ): Promise<void>;
    /** Publish a message to the admin's SSE stream via Redis */
    publishSse(topic: string, text: string): Promise<void>;
    /** Look up the expected manifest hash for a channel type from the ConfigMap (null if unknown) */
    getManifestHash(channelType: string): Promise<string | null>;
    /** Remove the instance name from the activeBootstraps Map */
    releaseBootstrap(instanceName: string): void;
    /**
     * Independently read package.json and package-lock.json from the runtime PVC
     * by exec-ing into the inspector sidecar of the bootstrap Job pod.
     * Story 176: this is the TOCTOU-closing independent read — never use the
     * agent's self-reported hash for comparison.
     */
    readPvcFiles(instanceName: string): Promise<{
      packageJson: string;
      packageLockJson: string;
    }>;
    /** Delete the bootstrap Job by name (NotFound → return normally) */
    deleteJob(jobName: string): Promise<void>;
    /** Delete the runtime PVC by name (NotFound → return normally) */
    deletePvc(pvcName: string): Promise<void>;
    /** Increment kubeclaw_bootstrap_manifest_mismatch_total{channel_type} */
    recordMismatch(labels: { channel_type: string }): void;
  }
  ```

  This is a breaking interface change — existing test's `makeDeps` will need updating in Task 4.

- [ ] **Step 2: Implement the rejection cascade logic in `processCommitChannelConfig`**

  Replace the existing advisory hash-check block and the `try` body in `processCommitChannelConfig`. The full new logic:

  ```typescript
  // Import computeManifestHash from bootstrap-runner at the top of the file:
  import { computeManifestHash } from './bootstrap-runner.js';

  // Inside processCommitChannelConfig, after the field-validation guard:

  logger.info(
    { bootstrapJobId, channel_type, instance_name, advisory_hash: runtime_pvc_lock_hash },
    'commit_channel_config received — independently verifying PVC hash',
  );

  try {
    // ── Step 1: Get expected hash from ConfigMap ──────────────────────────────
    const expectedHash = await deps.getManifestHash(channel_type);

    // ── Step 2: Independently read PVC contents via inspector sidecar ─────────
    // NOTE: runtime_pvc_lock_hash from the agent payload is logged above as
    // advisory only and is never used for comparison (TOCTOU defense, Story 176 AC1).
    let actualHash: string | null = null;
    if (expectedHash !== null) {
      const { packageJson: actualPkgJson, packageLockJson: actualLockJson } =
        await deps.readPvcFiles(instance_name);
      actualHash = computeManifestHash(actualPkgJson, actualLockJson);

      logger.info(
        { channel_type, instance_name, expectedHash, actualHash },
        'commit_channel_config: PVC hash computed',
      );

      // ── Step 3: Hard-reject on mismatch ──────────────────────────────────────
      if (actualHash !== expectedHash) {
        logger.warn(
          { channel_type, instance_name, expectedHash, actualHash },
          'commit_channel_config: MANIFEST_DIVERGENCE — rejecting commit',
        );

        const divergenceError = JSON.stringify({
          code: 'MANIFEST_DIVERGENCE',
          expected_hash: expectedHash,
          actual_hash: actualHash,
          channel_type,
        });

        // (a) Reply to bootstrap pod with structured error
        await deps
          .publishReply(replyChannel, { ok: false, error: divergenceError })
          .catch((e) => logger.warn({ e }, 'Failed to publish divergence reply'));

        // (b) Delete runtime PVC — idempotent
        await deps
          .deletePvc(pvcName)
          .catch((e) => logger.warn({ e, pvcName }, 'Failed to delete PVC on mismatch'));

        // (c) Terminate the bootstrap Job — idempotent
        const jobName = `kubeclaw-bootstrap-${instance_name}`;
        await deps
          .deleteJob(jobName)
          .catch((e) => logger.warn({ e, jobName }, 'Failed to delete Job on mismatch'));

        // (d) Increment metric
        deps.recordMismatch({ channel_type });

        // (e) Emit SSE message to admin
        const sseText = [
          `Bootstrap rejected: runtime PVC packages don't match the \`${channel_type}\` manifest.`,
          `Expected hash \`${expectedHash}\`, got \`${actualHash}\`.`,
          `No channel was created.`,
        ].join(' ');
        await deps
          .publishSse(sseTopic, sseText)
          .catch((e) => logger.warn({ e }, 'Failed to publish mismatch SSE'));

        // (f) Release instance name so retry works
        deps.releaseBootstrap(instance_name);

        // (g) Return early — no Secret or Deployment created
        return;
      }
    }

    // ── Hash matched (or no manifest registered) — proceed with happy path ────
    // 1. Create credentials Secret
    await deps.createSecret(secretName, secret_data);
    logger.info({ secretName, instance_name }, 'Channel credentials Secret created');

    // 2. Build steady-state Deployment spec
    const deployment: V1Deployment = {
      // ... (unchanged from Story 174 implementation)
    };

    // 3. Create steady-state Deployment
    await deps.createDeployment(deployment);
    logger.info({ deploymentName, channelBaseImage, instance_name }, 'Steady-state Deployment created');

    // 4. Release instance name from active bootstraps
    deps.releaseBootstrap(instance_name);

    // 5. Reply success to bootstrap pod
    await deps.publishReply(replyChannel, { ok: true });

    // 6. Notify admin via SSE
    await deps.publishSse(
      sseTopic,
      `Channel ${channel_type}/${instance_name} ready. Steady-state Deployment "${deploymentName}" created.`,
    );

    logger.info(
      { deploymentName, bootstrapJobId, channel_type, instance_name },
      'commit_channel_config: channel deployed successfully',
    );
  } catch (err) {
    // ... (unchanged error path)
  }
  ```

  **Important**: Keep the existing Deployment spec body exactly as it is from Story 174 — only the hash-check block and the `try` preamble change.

- [ ] **Step 3: Run typecheck to verify interface is consistent**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```
  Expected: errors at call sites (`src/index.ts`, `src/k8s/ipc-redis-bootstrap.test.ts`) because the new deps are not yet wired. That is expected — Task 4 and 5 fix those.

---

## Task 4: Add mismatch unit tests and update existing test helpers

**Files:**
- Modify: `src/k8s/ipc-redis-bootstrap.test.ts`

- [ ] **Step 1: Update `makeDeps` to include new dep stubs**

  Update the `makeDeps` factory:

  ```typescript
  function makeDeps(
    overrides: Partial<CommitChannelConfigDeps> = {},
  ): CommitChannelConfigDeps {
    // Default package.json/lock that produce a hash matching EXPECTED_HASH
    const matchingPkgJson = JSON.stringify({ name: 'test', dependencies: {} });
    const matchingLockJson = JSON.stringify({ lockfileVersion: 3, packages: {} });

    return {
      createSecret: vi.fn().mockResolvedValue(undefined),
      createDeployment: vi.fn().mockResolvedValue(undefined),
      publishReply: vi.fn().mockResolvedValue(undefined),
      publishSse: vi.fn().mockResolvedValue(undefined),
      getManifestHash: vi.fn().mockResolvedValue(null),
      releaseBootstrap: vi.fn(),
      readPvcFiles: vi.fn().mockResolvedValue({
        packageJson: matchingPkgJson,
        packageLockJson: matchingLockJson,
      }),
      deleteJob: vi.fn().mockResolvedValue(undefined),
      deletePvc: vi.fn().mockResolvedValue(undefined),
      recordMismatch: vi.fn(),
      ...overrides,
    };
  }
  ```

- [ ] **Step 2: Add a helper to compute the expected hash for tests**

  ```typescript
  import { computeManifestHash } from './bootstrap-runner.js';

  // Canonical content used as the "approved manifest" in mismatch tests
  const APPROVED_PKG_JSON = JSON.stringify({ name: 'test', dependencies: {} });
  const APPROVED_LOCK_JSON = JSON.stringify({ lockfileVersion: 3, packages: {} });
  const APPROVED_HASH = computeManifestHash(APPROVED_PKG_JSON, APPROVED_LOCK_JSON);

  // Content that differs (simulates extra npm install)
  const DEVIATED_PKG_JSON = JSON.stringify({ name: 'test', dependencies: { 'left-pad': '1.3.0' } });
  const DEVIATED_LOCK_JSON = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/left-pad': { version: '1.3.0' } } });
  ```

- [ ] **Step 3: Write the RED mismatch tests**

  ```typescript
  describe('processCommitChannelConfig — manifest hash mismatch (Story 176)', () => {
    it('returns MANIFEST_DIVERGENCE error when PVC hash does not match ConfigMap hash', async () => {
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
        readPvcFiles: vi.fn().mockResolvedValue({
          packageJson: DEVIATED_PKG_JSON,
          packageLockJson: DEVIATED_LOCK_JSON,
        }),
      });
      await processCommitChannelConfig(
        validPayload,
        deps,
        'kubeclaw-test',
        'kubeclaw-channel-base:latest',
      );
      expect(deps.publishReply).toHaveBeenCalledWith(
        'kubeclaw:bootstrap-reply:job-abc-123',
        expect.objectContaining({ ok: false }),
      );
      const replyArg = (deps.publishReply as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const errorObj = JSON.parse(replyArg.error);
      expect(errorObj.code).toBe('MANIFEST_DIVERGENCE');
      expect(errorObj.channel_type).toBe('telegram');
      expect(typeof errorObj.expected_hash).toBe('string');
      expect(typeof errorObj.actual_hash).toBe('string');
      expect(errorObj.expected_hash).not.toBe(errorObj.actual_hash);
    });

    it('does NOT create Secret or Deployment on mismatch', async () => {
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
        readPvcFiles: vi.fn().mockResolvedValue({
          packageJson: DEVIATED_PKG_JSON,
          packageLockJson: DEVIATED_LOCK_JSON,
        }),
      });
      await processCommitChannelConfig(validPayload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      expect(deps.createSecret).not.toHaveBeenCalled();
      expect(deps.createDeployment).not.toHaveBeenCalled();
    });

    it('deletes PVC and Job on mismatch', async () => {
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
        readPvcFiles: vi.fn().mockResolvedValue({
          packageJson: DEVIATED_PKG_JSON,
          packageLockJson: DEVIATED_LOCK_JSON,
        }),
      });
      await processCommitChannelConfig(validPayload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      expect(deps.deletePvc).toHaveBeenCalledWith('kubeclaw-channel-my-telegram-runtime');
      expect(deps.deleteJob).toHaveBeenCalledWith('kubeclaw-bootstrap-my-telegram');
    });

    it('records the mismatch metric with channel_type on mismatch', async () => {
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
        readPvcFiles: vi.fn().mockResolvedValue({
          packageJson: DEVIATED_PKG_JSON,
          packageLockJson: DEVIATED_LOCK_JSON,
        }),
      });
      await processCommitChannelConfig(validPayload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      expect(deps.recordMismatch).toHaveBeenCalledWith({ channel_type: 'telegram' });
    });

    it('publishes an SSE rejection message on mismatch', async () => {
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
        readPvcFiles: vi.fn().mockResolvedValue({
          packageJson: DEVIATED_PKG_JSON,
          packageLockJson: DEVIATED_LOCK_JSON,
        }),
      });
      await processCommitChannelConfig(validPayload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      expect(deps.publishSse).toHaveBeenCalledWith(
        'kubeclaw:bootstrap:job-abc-123',
        expect.stringContaining('Bootstrap rejected'),
      );
      const sseText = (deps.publishSse as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(sseText).toContain('telegram');
      expect(sseText).toContain('No channel was created');
    });

    it('releases the instance name from activeBootstraps on mismatch', async () => {
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
        readPvcFiles: vi.fn().mockResolvedValue({
          packageJson: DEVIATED_PKG_JSON,
          packageLockJson: DEVIATED_LOCK_JSON,
        }),
      });
      await processCommitChannelConfig(validPayload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      expect(deps.releaseBootstrap).toHaveBeenCalledWith('my-telegram');
    });

    it('proceeds with happy path when PVC hash matches ConfigMap hash', async () => {
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
        readPvcFiles: vi.fn().mockResolvedValue({
          packageJson: APPROVED_PKG_JSON,
          packageLockJson: APPROVED_LOCK_JSON,
        }),
      });
      await processCommitChannelConfig(validPayload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      expect(deps.createSecret).toHaveBeenCalled();
      expect(deps.createDeployment).toHaveBeenCalled();
      expect(deps.recordMismatch).not.toHaveBeenCalled();
      expect(deps.deletePvc).not.toHaveBeenCalled();
      expect(deps.deleteJob).not.toHaveBeenCalled();
    });

    it('skips PVC read and proceeds to happy path when no manifest hash is registered (null)', async () => {
      // No manifest registered (null) → hash check is skipped, happy path runs
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(null),
      });
      await processCommitChannelConfig(validPayload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      expect(deps.readPvcFiles).not.toHaveBeenCalled();
      expect(deps.createSecret).toHaveBeenCalled();
      expect(deps.createDeployment).toHaveBeenCalled();
    });

    it('publishes failure reply and does NOT create resources when readPvcFiles throws', async () => {
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH),
        readPvcFiles: vi.fn().mockRejectedValue(new Error('kubectl exec failed')),
      });
      await processCommitChannelConfig(validPayload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      expect(deps.publishReply).toHaveBeenCalledWith(
        'kubeclaw:bootstrap-reply:job-abc-123',
        expect.objectContaining({ ok: false }),
      );
      expect(deps.createSecret).not.toHaveBeenCalled();
      expect(deps.createDeployment).not.toHaveBeenCalled();
    });

    it('TOCTOU: rejects even when agent passes the correct post-deviate hash', async () => {
      // The agent computed its own hash after the extra install and passed that in.
      // The orchestrator still rejects because it reads the PVC independently.
      const agentComputedDeviatedHash = computeManifestHash(DEVIATED_PKG_JSON, DEVIATED_LOCK_JSON);
      const payload = { ...validPayload, runtime_pvc_lock_hash: agentComputedDeviatedHash };
      const deps = makeDeps({
        getManifestHash: vi.fn().mockResolvedValue(APPROVED_HASH), // ConfigMap has the original approved hash
        readPvcFiles: vi.fn().mockResolvedValue({
          packageJson: DEVIATED_PKG_JSON,
          packageLockJson: DEVIATED_LOCK_JSON,
        }),
      });
      await processCommitChannelConfig(payload, deps, 'kubeclaw-test', 'kubeclaw-channel-base:latest');
      // Orchestrator should still reject — TOCTOU is closed
      expect(deps.createSecret).not.toHaveBeenCalled();
      const replyArg = (deps.publishReply as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const errorObj = JSON.parse(replyArg.error);
      expect(errorObj.code).toBe('MANIFEST_DIVERGENCE');
    });
  });
  ```

- [ ] **Step 4: Run the failing tests**

  ```bash
  npx vitest run src/k8s/ipc-redis-bootstrap.test.ts --reporter=verbose
  ```
  Expected: 9 new tests FAIL (existing 11 may also fail due to `makeDeps` missing new fields — that's fine at this stage)

- [ ] **Step 5: Commit the RED tests**

  ```bash
  git add src/k8s/ipc-redis-bootstrap.test.ts
  git commit -m "test(176): RED — mismatch unit tests for processCommitChannelConfig"
  ```

---

## Task 5: Implement the rejection cascade in `processCommitChannelConfig`

**Files:**
- Modify: `src/k8s/ipc-redis-bootstrap.ts`

- [ ] **Step 1: Add the import for `computeManifestHash`**

  At the top of `src/k8s/ipc-redis-bootstrap.ts`, add:
  ```typescript
  import { computeManifestHash } from './bootstrap-runner.js';
  ```

- [ ] **Step 2: Replace the advisory hash check with the full rejection cascade**

  Replace the existing `processCommitChannelConfig` function body with the full logic from Task 3 Step 2. The key sections:

  **Before the `try` block** — keep field validation as-is.

  **Inside the `try` block** — replace the existing advisory check:
  ```typescript
  // OLD (advisory only — delete this):
  // const expectedHash = await deps.getManifestHash(channel_type);
  // if (expectedHash && runtime_pvc_lock_hash && runtime_pvc_lock_hash !== expectedHash) {
  //   logger.warn(...);
  // }

  // NEW:
  const expectedHash = await deps.getManifestHash(channel_type);

  // Log the agent-supplied hash as advisory — never used for comparison (Story 176 AC1)
  logger.info(
    { bootstrapJobId, channel_type, instance_name, advisory_hash: runtime_pvc_lock_hash },
    'commit_channel_config: runtime_pvc_lock_hash is advisory only; orchestrator reads PVC independently',
  );

  if (expectedHash !== null) {
    const { packageJson: actualPkgJson, packageLockJson: actualLockJson } =
      await deps.readPvcFiles(instance_name);
    const actualHash = computeManifestHash(actualPkgJson, actualLockJson);

    logger.info(
      { channel_type, instance_name, expectedHash, actualHash },
      'commit_channel_config: independently computed PVC hash',
    );

    if (actualHash !== expectedHash) {
      logger.warn(
        { channel_type, instance_name, expectedHash, actualHash },
        'commit_channel_config: MANIFEST_DIVERGENCE — hard-rejecting commit',
      );

      const divergenceError = JSON.stringify({
        code: 'MANIFEST_DIVERGENCE',
        expected_hash: expectedHash,
        actual_hash: actualHash,
        channel_type,
      });

      await deps
        .publishReply(replyChannel, { ok: false, error: divergenceError })
        .catch((e) => logger.warn({ e }, 'Failed to publish MANIFEST_DIVERGENCE reply'));

      await deps
        .deletePvc(pvcName)
        .catch((e) => logger.warn({ e, pvcName }, 'Failed to delete PVC on mismatch; continuing'));

      const jobName = `kubeclaw-bootstrap-${instance_name}`;
      await deps
        .deleteJob(jobName)
        .catch((e) => logger.warn({ e, jobName }, 'Failed to delete Job on mismatch; continuing'));

      deps.recordMismatch({ channel_type });

      const sseText = [
        `Bootstrap rejected: runtime PVC packages don't match the \`${channel_type}\` manifest.`,
        `Expected hash \`${expectedHash}\`, got \`${actualHash}\`.`,
        `No channel was created.`,
      ].join(' ');
      await deps
        .publishSse(sseTopic, sseText)
        .catch((e) => logger.warn({ e }, 'Failed to publish mismatch SSE'));

      deps.releaseBootstrap(instance_name);
      return;
    }
  }

  // Hash matched (or no manifest registered) — happy path continues below:
  // 1. Create credentials Secret
  await deps.createSecret(secretName, secret_data);
  // ... rest of happy path unchanged
  ```

- [ ] **Step 3: Run tests to verify they pass**

  ```bash
  npx vitest run src/k8s/ipc-redis-bootstrap.test.ts --reporter=verbose
  ```
  Expected: all 20 tests pass (11 existing + 9 new)

- [ ] **Step 4: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | grep -E "ipc-redis-bootstrap|bootstrap-runner"
  ```
  Expected: errors in `src/index.ts` only (wired in Task 6)

- [ ] **Step 5: Commit**

  ```bash
  git add src/k8s/ipc-redis-bootstrap.ts
  git commit -m "feat(176): implement MANIFEST_DIVERGENCE rejection cascade in processCommitChannelConfig"
  ```

---

## Task 6: Wire new deps in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

The `registerBootstrapDeps` call must be extended with three new fields: `readPvcFiles`, `deleteJob`, `deletePvc`.

- [ ] **Step 1: Add `readPvcFiles` implementation**

  The production implementation uses `kubectl exec` into the inspector sidecar. In `src/index.ts`, inside the `registerBootstrapDeps({...})` call, add:

  ```typescript
  readPvcFiles: async (instanceName: string) => {
    const { execSync } = await import('node:child_process');
    const jobPodName = await (async () => {
      // Find the running pod for the bootstrap Job
      const podListJson = execSync(
        `kubectl get pods -n ${KUBECLAW_NAMESPACE} ` +
          `-l kubeclaw-channel=${instanceName},kubeclaw.io/role=bootstrap ` +
          `--field-selector=status.phase=Running -o json`,
        { encoding: 'utf8' },
      );
      const podList = JSON.parse(podListJson) as { items: Array<{ metadata: { name: string } }> };
      if (podList.items.length === 0) {
        throw new Error(`No running bootstrap pod found for instance ${instanceName}`);
      }
      return podList.items[0].metadata.name;
    })();

    const exec = (file: string): string =>
      execSync(
        `kubectl exec -n ${KUBECLAW_NAMESPACE} ${jobPodName} -c inspector -- cat /runtime-inspect/${file}`,
        { encoding: 'utf8' },
      );

    const packageJson = exec('package.json');
    const packageLockJson = exec('package-lock.json');
    return { packageJson, packageLockJson };
  },
  ```

  > **Note:** `execSync` is used here for simplicity because this is an infrequent operation (once per `commit_channel_config`). For a future improvement, migrate to the `@kubernetes/client-node` `Exec` API.

- [ ] **Step 2: Add `deleteJob` and `deletePvc` implementations**

  Still inside the same `registerBootstrapDeps({...})` call, add:

  ```typescript
  deleteJob: async (name: string) => {
    try {
      await batchApi.deleteNamespacedJob({
        name,
        namespace: KUBECLAW_NAMESPACE,
        gracePeriodSeconds: 0,
      });
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.body?.code === 404) return;
      throw err;
    }
  },
  deletePvc: async (name: string) => {
    try {
      await coreApi.deleteNamespacedPersistentVolumeClaim({
        name,
        namespace: KUBECLAW_NAMESPACE,
        gracePeriodSeconds: 0,
      });
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.body?.code === 404) return;
      throw err;
    }
  },
  ```

- [ ] **Step 3: Add `recordMismatch` implementation**

  ```typescript
  recordMismatch: ({ channel_type }: { channel_type: string }) => {
    orchestratorMetrics?.recordBootstrapManifestMismatch({ channel_type });
  },
  ```

  > **Note:** `orchestratorMetrics` is the existing `OrchestratorMetrics` instance used elsewhere in `src/index.ts`. Verify the variable name by grepping `orchestratorMetrics` in `index.ts`.

- [ ] **Step 4: Run typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```
  Expected: no errors (or only pre-existing unrelated errors)

- [ ] **Step 5: Commit**

  ```bash
  git add src/index.ts
  git commit -m "feat(176): wire readPvcFiles/deleteJob/deletePvc/recordMismatch into registerBootstrapDeps"
  ```

---

## Task 7: Integration tests for `computeManifestHash` determinism

**Files:**
- Create: `src/k8s/bootstrap-hash-validation.integration.test.ts`

These tests exercise `computeManifestHash` directly — no K8s, no mocks.

- [ ] **Step 1: Write the integration tests**

  ```typescript
  /**
   * Integration tests for Story 176: computeManifestHash determinism.
   * These tests verify the hash algorithm produces stable, canonical results
   * that match what a bootstrap pod would independently compute.
   */
  import { describe, it, expect } from 'vitest';
  import { computeManifestHash, canonicalJson } from './bootstrap-runner.js';

  const PKG_JSON_A = JSON.stringify({
    name: 'kubeclaw-telegram',
    version: '1.0.0',
    dependencies: { grammy: '^1.21.3' },
  });

  const LOCK_JSON_A = JSON.stringify({
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'kubeclaw-telegram', version: '1.0.0', dependencies: { grammy: '^1.21.3' } },
      'node_modules/grammy': { version: '1.21.3', resolved: 'https://registry.npmjs.org/grammy/-/grammy-1.21.3.tgz' },
    },
  });

  // Deviated: extra package added
  const LOCK_JSON_DEVIATED = JSON.stringify({
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'kubeclaw-telegram', version: '1.0.0', dependencies: { grammy: '^1.21.3', 'left-pad': '^1.3.0' } },
      'node_modules/grammy': { version: '1.21.3', resolved: 'https://registry.npmjs.org/grammy/-/grammy-1.21.3.tgz' },
      'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz' },
    },
  });

  describe('computeManifestHash — Story 176 integration', () => {
    it('produces a 64-character hex sha256 string', () => {
      const hash = computeManifestHash(PKG_JSON_A, LOCK_JSON_A);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic: same inputs always yield the same hash', () => {
      const h1 = computeManifestHash(PKG_JSON_A, LOCK_JSON_A);
      const h2 = computeManifestHash(PKG_JSON_A, LOCK_JSON_A);
      expect(h1).toBe(h2);
    });

    it('is key-order independent: JSON with different key order hashes identically', () => {
      const pkgA = '{"name":"test","dependencies":{"grammy":"1.0.0"}}';
      const pkgB = '{"dependencies":{"grammy":"1.0.0"},"name":"test"}';
      const lock = '{"lockfileVersion":3,"packages":{}}';
      expect(computeManifestHash(pkgA, lock)).toBe(computeManifestHash(pkgB, lock));
    });

    it('produces different hashes when package-lock.json differs (deviate simulation)', () => {
      const hashOriginal = computeManifestHash(PKG_JSON_A, LOCK_JSON_A);
      const hashDeviated = computeManifestHash(PKG_JSON_A, LOCK_JSON_DEVIATED);
      expect(hashOriginal).not.toBe(hashDeviated);
    });

    it('produces different hashes when package.json differs', () => {
      const pkgB = JSON.stringify({ name: 'kubeclaw-telegram', version: '2.0.0', dependencies: { grammy: '^1.21.3' } });
      expect(computeManifestHash(PKG_JSON_A, LOCK_JSON_A)).not.toBe(
        computeManifestHash(pkgB, LOCK_JSON_A),
      );
    });

    it('canonicalJson sorts keys recursively', () => {
      const result = canonicalJson({ b: 2, a: 1 });
      expect(result).toBe('{"a":1,"b":2}');
    });

    it('canonicalJson preserves array order', () => {
      const result = canonicalJson([3, 1, 2]);
      expect(result).toBe('[3,1,2]');
    });
  });
  ```

- [ ] **Step 2: Run to verify they all pass (these are pure function tests — no network needed)**

  ```bash
  npx vitest run src/k8s/bootstrap-hash-validation.integration.test.ts --reporter=verbose
  ```
  Expected: 7/7 pass

- [ ] **Step 3: Commit**

  ```bash
  git add src/k8s/bootstrap-hash-validation.integration.test.ts
  git commit -m "test(176): integration tests for computeManifestHash determinism"
  ```

---

## Task 8: Deferred e2e placeholder

**Files:**
- Create: `e2e/minikube-live-bootstrap-hash-mismatch.test.ts`

E2e tests require a minikube cluster + live LLM + a mismatch skill ConfigMap. These are out of scope for this implementation session. Create a placeholder with `it.skip` blocks so the suite is documented.

- [ ] **Step 1: Create the placeholder**

  ```typescript
  /**
   * E2E tests for Story 176: Manifest hash mismatch rejection.
   *
   * DEFERRED: Requires minikube cluster, live LLM (LIVE_LLM_BASE_URL env var),
   * and a mismatch-skill ConfigMap fixture. See Story 176 AC5 + notes for setup.
   *
   * When implementing:
   * 1. Seed a "mismatch skill" ConfigMap that runs `npm install left-pad` after `npm ci`
   *    to shift the lockfile hash.
   * 2. The mismatch skill should also compute sha256(post-deviate lock) and pass it
   *    as runtime_pvc_lock_hash to verify the TOCTOU defense (orchestrator still rejects).
   * 3. Assert via SSE stream that the rejection message arrives.
   * 4. Assert kubectl: no PVC, no Job, no Deployment, no Secret for the instance.
   * 5. Assert metric: curl localhost:9091/metrics | grep kubeclaw_bootstrap_manifest_mismatch_total
   * 6. Assert retry: bootstrap_channel_from_skill with same instance_name succeeds.
   */
  import { describe, it } from 'vitest';

  const SKIP_REASON =
    'Story 176 e2e deferred: requires minikube + live LLM + mismatch-skill fixture';

  describe('Story 176: manifest hash mismatch e2e', () => {
    it.skip(SKIP_REASON, 'mismatch triggers MANIFEST_DIVERGENCE SSE message', () => {});
    it.skip(SKIP_REASON, 'no PVC, Job, Deployment, or Secret exist after rejection', () => {});
    it.skip(SKIP_REASON, 'kubeclaw_bootstrap_manifest_mismatch_total increments to 1', () => {});
    it.skip(SKIP_REASON, 'instance name freed: second bootstrap_channel_from_skill with same name succeeds', () => {});
    it.skip(SKIP_REASON, 'TOCTOU: agent-supplied correct post-deviate hash still causes rejection', () => {});
  });
  ```

- [ ] **Step 2: Verify placeholder runs cleanly**

  ```bash
  npx vitest run e2e/minikube-live-bootstrap-hash-mismatch.test.ts --reporter=verbose
  ```
  Expected: 5 skipped, 0 failed

- [ ] **Step 3: Commit**

  ```bash
  git add e2e/minikube-live-bootstrap-hash-mismatch.test.ts
  git commit -m "test(176): deferred e2e placeholder for hash mismatch minikube tests"
  ```

---

## Task 9: Format, typecheck, full test run

- [ ] **Step 1: Format**

  ```bash
  npm run format
  git diff --name-only  # review any changes
  git add -A && git commit -m "style: prettier format pass for Story 176 changes"
  ```

- [ ] **Step 2: Typecheck**

  ```bash
  npx tsc --noEmit 2>&1 | grep -v "^$"
  ```
  Expected: no errors (or pre-existing unrelated errors only — check baseline with `git stash` if uncertain)

- [ ] **Step 3: Full test run**

  ```bash
  npx vitest run --reporter=verbose 2>&1 | tail -10
  ```
  Expected: existing pass count + new tests passing; no regressions

- [ ] **Step 4: Final commit if format introduced changes**

  Already handled in Step 1. If typecheck required fixes, commit them:
  ```bash
  git add -A && git commit -m "fix(types): resolve typecheck errors from Story 176 interface changes"
  ```

---

## Self-Review Checklist

### Spec coverage

| AC | Task |
|----|------|
| AC1: orchestrator independently reads PVC, agent hash is advisory | Tasks 2, 3, 5 |
| AC2a: structured MANIFEST_DIVERGENCE reply | Task 5 |
| AC2b: delete PVC | Task 5 |
| AC2c: terminate Job | Task 5 |
| AC2d: increment metric | Tasks 1, 5, 6 |
| AC2e: SSE message | Task 5 |
| AC3: happy path unaffected | Task 4 (happy-path unit test) |
| AC4: metric declared in orchestrator.ts with correct labelNames | Task 1 |
| AC5: instance freed for retry | Task 4 (releaseBootstrap test), Task 5 |
| TOCTOU: agent-supplied correct post-deviate hash still rejected | Task 4 (TOCTOU test) |

### Placeholder scan

- No TBD, TODO, "fill in", or "similar to Task N" patterns present.
- All code blocks are complete.
- All type names are consistent across tasks.

### Type consistency

- `CommitChannelConfigDeps` is defined once in Task 3 and used consistently in Tasks 4, 5, 6.
- `recordBootstrapManifestMismatch` in `OrchestratorMetrics` (Task 1) matches `recordMismatch` call in `CommitChannelConfigDeps` via the closure in Task 6 Step 3.
- `computeManifestHash` imported from `./bootstrap-runner.js` in both Task 5 (implementation) and Task 4 (test helper) — consistent.
