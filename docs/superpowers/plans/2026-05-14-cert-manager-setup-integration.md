# cert-manager Setup Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire cert-manager into the standard `npm run setup:minikube` flow and the e2e bootstrap so that fresh installs no longer require an out-of-band `helm install jetstack/cert-manager`. Production users with existing cert-manager get a no-op; an explicit `--skip-cert-manager` flag exists for advanced cases.

**Architecture:** Add a new phase in `setup/minikube.ts` modeled exactly on the existing `installFalco()` phase. Extract the installer body into `setup/cert-manager.ts` so the same routine runs from `e2e/global-setup.ts` before its helm-install branch. cert-manager is **not** added as a chart subchart dependency — that path collides with production clusters that already run cert-manager and triggers helm 3's CRD-ordering footguns.

**Tech Stack:** TypeScript (tsx + Vitest), Helm 3 (`jetstack/cert-manager` v1.16.2), Kubernetes (minikube driver=docker), Node `child_process.spawnSync` patterns already in use across `setup/*.ts`.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `setup/cert-manager.ts` | Shared idempotent installer + version constant | **Create** |
| `setup/cert-manager.test.ts` | Unit tests for `isCertManagerInstalled` + `installCertManager` paths | **Create** |
| `setup/k8s-utils.ts` | Add `waitForDeployment` helper (mirrors `waitForDaemonSet`) | Modify |
| `setup/minikube.ts` | Add `--skip-cert-manager` flag + Phase 3.5 wiring | Modify |
| `setup/minikube.test.ts` | Cover the new flag in `parseArgs` tests | Modify |
| `e2e/global-setup.ts` | Call `installCertManager` before the helm-install branch | Modify |
| `INSTALL.md` | Document the new phase + `--skip-cert-manager` | Modify |
| `docs/CREDENTIAL_INJECTION.md` | Replace manual cert-manager prereq with reference to setup | Modify |
| `README.md` | One-line update if it lists install prerequisites | Modify (conditional) |

No chart-side guard. I considered adding `{{- if not (.Capabilities.APIVersions.Has "cert-manager.io/v1") -}}{{ fail "..." }}{{- end -}}` to `templates/internal-ca.yaml`, but `.Capabilities.APIVersions` is empty during `helm template` runs (used by `e2e/helm-chart.test.ts`), which would break those tests. Helm's native "no matches for kind Certificate" error is sufficient once docs explain the fix.

---

## Pre-flight (one-time before starting any task)

- [ ] **Step 0a: Create a worktree off main**

```bash
git worktree add -b feat/cert-manager-setup ../kubeclaw-cert-manager main
cd ../kubeclaw-cert-manager
```

- [ ] **Step 0b: Confirm baseline checks pass**

Run: `npm run typecheck && npm run test -- setup/`
Expected: typecheck clean; existing `setup/*.test.ts` all green.

- [ ] **Step 0c: Confirm live cluster reachable (used by smoke test in Task 6)**

Run: `kubectl cluster-info`
Expected: control-plane URL and CoreDNS lines.

---

## Task 1: `waitForDeployment` helper

`installCertManager()` needs to poll the `cert-manager-webhook` Deployment until it reports Ready. `setup/k8s-utils.ts` already has `waitForDaemonSet` and `waitForPodRunning` — add a sibling.

**Files:**
- Modify: `setup/k8s-utils.ts` (append after `waitForDaemonSet`, ~line 98)
- Test:   `setup/k8s-utils.test.ts` (create — none exists today)

- [ ] **Step 1.1: Write the failing tests**

Create `setup/k8s-utils.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSpawnSync = vi.fn();
vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }));

function spawnResult(stdout: string, status = 0) {
  return { status, stdout, stderr: '', error: undefined };
}

describe('waitForDeployment', () => {
  let waitForDeployment: typeof import('./k8s-utils.js').waitForDeployment;

  beforeEach(async () => {
    mockSpawnSync.mockReset();
    const mod = await import('./k8s-utils.js');
    waitForDeployment = mod.waitForDeployment;
  });

  it('returns true immediately when readyReplicas matches replicas', async () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult('1/1'));
    const ok = await waitForDeployment('cert-manager', 'cert-manager-webhook', 5_000, 10);
    expect(ok).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('polls until readiness reached, then returns true', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('0/1'))
      .mockReturnValueOnce(spawnResult('0/1'))
      .mockReturnValueOnce(spawnResult('1/1'));
    const ok = await waitForDeployment('ns', 'dep', 5_000, 10);
    expect(ok).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
  });

  it('returns false when timeout elapses without readiness', async () => {
    mockSpawnSync.mockReturnValue(spawnResult('0/1'));
    const ok = await waitForDeployment('ns', 'dep', 80, 10);
    expect(ok).toBe(false);
  });

  it('treats kubectl non-zero exit as "not ready yet" and retries', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))
      .mockReturnValueOnce(spawnResult('1/1'));
    const ok = await waitForDeployment('ns', 'dep', 5_000, 10);
    expect(ok).toBe(true);
  });

  it('treats replicas=0 as not-ready (deployment scaled to zero shouldn\'t count as ready)', async () => {
    mockSpawnSync.mockReturnValue(spawnResult('0/0'));
    const ok = await waitForDeployment('ns', 'dep', 80, 10);
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `npm test -- setup/k8s-utils.test.ts`
Expected: FAIL — `waitForDeployment is not a function`.

- [ ] **Step 1.3: Implement `waitForDeployment`**

Append to `setup/k8s-utils.ts`:

```typescript
/**
 * Wait for a Deployment to have all desired replicas ready.
 * Returns true if ready within timeoutMs. Treats replicas=0 as not-ready so
 * a scaled-down deployment never satisfies the wait.
 */
export async function waitForDeployment(
  namespace: string,
  name: string,
  timeoutMs = 120_000,
  intervalMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'kubectl',
      [
        'get', 'deployment', name,
        '-n', namespace,
        '-o', 'jsonpath={.status.readyReplicas}/{.status.replicas}',
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (result.status === 0) {
      const [readyStr, desiredStr] = result.stdout.trim().split('/');
      const ready = Number(readyStr) || 0;
      const desired = Number(desiredStr) || 0;
      if (desired > 0 && ready >= desired) return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `npm test -- setup/k8s-utils.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add setup/k8s-utils.ts setup/k8s-utils.test.ts
git commit -m "feat(setup): add waitForDeployment helper for cert-manager integration"
```

---

## Task 2: `setup/cert-manager.ts` installer module

The shared installer used by both `setup/minikube.ts` and `e2e/global-setup.ts`. Idempotent: detects an existing cert-manager release and short-circuits to a no-op.

**Files:**
- Create: `setup/cert-manager.ts`
- Test:   `setup/cert-manager.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `setup/cert-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Intercept spawnSync (helm + kubectl calls).
const mockSpawnSync = vi.fn();
vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }));

// Silence logger output.
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub waitForDeployment so tests don't sleep.
const mockWaitForDeployment = vi.fn();
vi.mock('./k8s-utils.js', () => ({
  waitForDeployment: mockWaitForDeployment,
}));

function spawnResult(stdout = '', status = 0) {
  return { status, stdout, stderr: '', error: undefined };
}

describe('isCertManagerInstalled', () => {
  let isCertManagerInstalled: typeof import('./cert-manager.js').isCertManagerInstalled;

  beforeEach(async () => {
    mockSpawnSync.mockReset();
    const mod = await import('./cert-manager.js');
    isCertManagerInstalled = mod.isCertManagerInstalled;
  });

  it('returns true when helm status succeeds', () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult('STATUS: deployed', 0));
    expect(isCertManagerInstalled()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'helm',
      ['status', 'cert-manager', '--namespace', 'cert-manager'],
      { stdio: 'pipe' },
    );
  });

  it('returns false when helm status fails (no release)', () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult('Error: not found', 1));
    expect(isCertManagerInstalled()).toBe(false);
  });
});

describe('installCertManager', () => {
  let installCertManager: typeof import('./cert-manager.js').installCertManager;

  beforeEach(async () => {
    mockSpawnSync.mockReset();
    mockWaitForDeployment.mockReset();
    const mod = await import('./cert-manager.js');
    installCertManager = mod.installCertManager;
  });

  it('returns "skipped" when opts.skip is true and makes no helm/kubectl calls', async () => {
    const result = await installCertManager({ skip: true });
    expect(result).toBe('skipped');
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockWaitForDeployment).not.toHaveBeenCalled();
  });

  it('returns "present" when cert-manager release already exists', async () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult('STATUS: deployed', 0)); // helm status
    const result = await installCertManager();
    expect(result).toBe('present');
    // Only the status check should have been called.
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockWaitForDeployment).not.toHaveBeenCalled();
  });

  it('installs cert-manager when absent and waits for webhook readiness', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))      // helm status -> not found
      .mockReturnValueOnce(spawnResult('', 0))      // helm repo add
      .mockReturnValueOnce(spawnResult('', 0))      // helm repo update
      .mockReturnValueOnce(spawnResult('', 0));     // helm upgrade --install
    mockWaitForDeployment.mockResolvedValueOnce(true);

    const result = await installCertManager();
    expect(result).toBe('installed');

    // Verify the install command included the pinned version + crds.enabled.
    const installCall = mockSpawnSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === 'upgrade',
    );
    expect(installCall).toBeDefined();
    expect(installCall![1]).toContain('--version');
    const versionIdx = installCall![1].indexOf('--version');
    expect(installCall![1][versionIdx + 1]).toMatch(/^v1\.16\./);
    expect(installCall![1]).toContain('--set');
    expect(installCall![1]).toContain('crds.enabled=true');
    expect(installCall![1]).toContain('--wait');

    expect(mockWaitForDeployment).toHaveBeenCalledWith(
      'cert-manager', 'cert-manager-webhook', 60_000,
    );
  });

  it('throws cert_manager_install_failed when helm install returns non-zero', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))      // helm status
      .mockReturnValueOnce(spawnResult('', 0))      // repo add
      .mockReturnValueOnce(spawnResult('', 0))      // repo update
      .mockReturnValueOnce(spawnResult('', 1));     // helm install fails

    await expect(installCertManager()).rejects.toThrow('cert_manager_install_failed');
    expect(mockWaitForDeployment).not.toHaveBeenCalled();
  });

  it('throws cert_manager_webhook_not_ready when webhook never becomes Ready', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))
      .mockReturnValueOnce(spawnResult('', 0))
      .mockReturnValueOnce(spawnResult('', 0))
      .mockReturnValueOnce(spawnResult('', 0));
    mockWaitForDeployment.mockResolvedValueOnce(false);

    await expect(installCertManager()).rejects.toThrow('cert_manager_webhook_not_ready');
  });

  it('throws cert_manager_repo_add_failed when helm repo add fails', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))   // helm status -> not installed
      .mockReturnValueOnce(spawnResult('', 1));  // helm repo add fails

    await expect(installCertManager()).rejects.toThrow('cert_manager_repo_add_failed');
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `npm test -- setup/cert-manager.test.ts`
Expected: FAIL — `Cannot find module './cert-manager.js'`.

- [ ] **Step 2.3: Implement `setup/cert-manager.ts`**

Create `setup/cert-manager.ts`:

```typescript
/**
 * Shared cert-manager installer used by setup/minikube.ts and e2e/global-setup.ts.
 *
 * cert-manager provides the cert-manager.io/v1 Issuer + Certificate CRDs
 * the kubeclaw chart uses to mint kubeclaw-egress-ca for credential-injection
 * sidecar TLS interception. Without it, `helm install kubeclaw` (default
 * mode=sidecar) fails with "no matches for kind Certificate".
 *
 * Idempotent: when cert-manager is already installed (helm release present
 * in the cert-manager namespace), this is a no-op so production clusters
 * with their own cert-manager are unaffected. Pass {skip: true} to bypass
 * entirely when the operator has cert-manager installed elsewhere or
 * declines auto-management.
 */
import { spawnSync } from 'child_process';
import { logger } from '../src/logger.js';
import { waitForDeployment } from './k8s-utils.js';

export const CERT_MANAGER_VERSION = 'v1.16.2';
const NAMESPACE = 'cert-manager';
const RELEASE = 'cert-manager';

export interface InstallCertManagerOptions {
  /** Caller-driven opt-out (e.g. --skip-cert-manager flag). */
  skip?: boolean;
  /** Helm install timeout. Default '3m'. */
  timeout?: string;
}

export function isCertManagerInstalled(): boolean {
  const r = spawnSync(
    'helm',
    ['status', RELEASE, '--namespace', NAMESPACE],
    { stdio: 'pipe' },
  );
  return r.status === 0;
}

export async function installCertManager(
  opts: InstallCertManagerOptions = {},
): Promise<'installed' | 'present' | 'skipped'> {
  if (opts.skip) {
    logger.info('Skipping cert-manager install (caller opt-out)');
    return 'skipped';
  }

  if (isCertManagerInstalled()) {
    logger.info('cert-manager already installed — skipping');
    return 'present';
  }

  logger.info('Adding jetstack helm repo');
  const repoAdd = spawnSync(
    'helm',
    ['repo', 'add', 'jetstack', 'https://charts.jetstack.io', '--force-update'],
    { stdio: 'inherit' },
  );
  if (repoAdd.status !== 0) throw new Error('cert_manager_repo_add_failed');

  const repoUpdate = spawnSync('helm', ['repo', 'update'], { stdio: 'inherit' });
  if (repoUpdate.status !== 0) throw new Error('cert_manager_repo_update_failed');

  logger.info(
    `Installing cert-manager ${CERT_MANAGER_VERSION} ` +
      '(provides Issuer/Certificate CRDs for credentialInjection internal CA)',
  );
  const timeout = opts.timeout ?? '3m';
  const install = spawnSync(
    'helm',
    [
      'upgrade', '--install', RELEASE, 'jetstack/cert-manager',
      '--namespace', NAMESPACE,
      '--create-namespace',
      '--version', CERT_MANAGER_VERSION,
      '--set', 'crds.enabled=true',
      '--timeout', timeout,
      '--wait',
    ],
    { stdio: 'inherit' },
  );
  if (install.status !== 0) throw new Error('cert_manager_install_failed');

  // The admission webhook must be Ready before any Certificate/Issuer
  // can be created — helm --wait usually covers this but CI has seen
  // a webhook briefly serving without its TLS cert mounted. Belt-and-
  // suspenders polling.
  const ready = await waitForDeployment(NAMESPACE, 'cert-manager-webhook', 60_000);
  if (!ready) throw new Error('cert_manager_webhook_not_ready');

  logger.info('cert-manager ready');
  return 'installed';
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `npm test -- setup/cert-manager.test.ts`
Expected: PASS — 8 tests green.

- [ ] **Step 2.5: Run typecheck**

Run: `npm run typecheck`
Expected: clean — no new errors.

- [ ] **Step 2.6: Commit**

```bash
git add setup/cert-manager.ts setup/cert-manager.test.ts
git commit -m "feat(setup): add shared cert-manager installer with idempotent detection"
```

---

## Task 3: Wire into `setup/minikube.ts`

Add the `--skip-cert-manager` flag, run cert-manager install between Falco (Phase 3) and KubeClaw deploy (Phase 4), and surface the result via `emitStatus`.

**Files:**
- Modify: `setup/minikube.ts` (header doc comment, imports, `MinikubeOpts`, `parseArgs`, main flow)
- Modify: `setup/minikube.test.ts` (extend `parseArgs` tests)

- [ ] **Step 3.1: Extend `parseArgs` tests with the new flag (failing first)**

In `setup/minikube.test.ts`, at the top of the `parseArgs` describe (after the existing `parses --skip-falco flag` test, ~line 101), update the type alias at line 67–72 to include `skipCertManager: boolean`, update the "returns defaults" assertion at line 86 to also assert `expect(opts.skipCertManager).toBe(false);`, and add this test:

```typescript
  it('parses --skip-cert-manager flag', () => {
    expect(parseArgs(['--skip-cert-manager']).skipCertManager).toBe(true);
  });

  it('parses --skip-cert-manager alongside other skip flags', () => {
    const opts = parseArgs(['--skip-falco', '--skip-cert-manager', '--skip-build']);
    expect(opts.skipFalco).toBe(true);
    expect(opts.skipCertManager).toBe(true);
    expect(opts.skipBuild).toBe(true);
  });
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `npm test -- setup/minikube.test.ts`
Expected: FAIL — `opts.skipCertManager` is `undefined`.

- [ ] **Step 3.3: Add `skipCertManager` to `MinikubeOpts` and `parseArgs`**

In `setup/minikube.ts`:

1. Update the header doc comment (~line 15, near `--skip-falco`) to add a line:

```typescript
 *   npm run setup:minikube -- --skip-cert-manager   # skip cert-manager install
```

2. Update the `MinikubeOpts` interface (line 31–40) to add `skipCertManager: boolean;` after `skipFalco`:

```typescript
export interface MinikubeOpts {
  cpus: number;
  memory: number; // MiB
  disk: string;
  reset: boolean;
  skipBuild: boolean;
  skipFalco: boolean;
  skipCertManager: boolean;
  profile: string;
  cni: CniMode;
}
```

3. In `parseArgs` (line 42–79), add a `skipCertManager` local, parse the flag, and include it in the return:

```typescript
  let skipCertManager = false;
```

after the existing `let skipFalco = false;`.

```typescript
    else if (args[i] === '--skip-cert-manager') skipCertManager = true;
```

after the existing `--skip-falco` clause.

```typescript
  return { cpus, memory, disk, reset, skipBuild, skipFalco, skipCertManager, profile, cni };
```

replacing the existing return.

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `npm test -- setup/minikube.test.ts`
Expected: PASS — all `parseArgs` tests green including the two new ones.

- [ ] **Step 3.5: Import the installer and wire it into the phase ordering**

In `setup/minikube.ts`:

1. Add import after the existing `import { runKubectl, truncateText, waitForDaemonSet, waitForPodRunning } from './k8s-utils.js';` (line 27):

```typescript
import { installCertManager } from './cert-manager.js';
```

2. Insert a new "Phase 3.5: cert-manager" block immediately after the Falco phase. The Falco phase ends around line 503 (`emitStatus('SETUP_MINIKUBE_FALCO', { STATUS: 'skipped' });`). Insert right before "Phase 4: deploy" (~line 505):

```typescript
  // Phase 3.5: cert-manager
  // Required by the kubeclaw chart's credentialInjection internal-CA template
  // (Issuer + Certificate CRDs). The installer is idempotent: production
  // clusters with cert-manager already installed get a no-op.
  try {
    const certManagerResult = await installCertManager({
      skip: opts.skipCertManager,
    });
    emitStatus('SETUP_MINIKUBE_CERT_MANAGER', {
      STATUS: certManagerResult === 'skipped' ? 'skipped' : 'ok',
      RESULT: certManagerResult,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const diag = runKubectl(['get', 'pods', '-n', 'cert-manager'], 10);
    emitStatus('SETUP_MINIKUBE_CERT_MANAGER', {
      STATUS: 'failed',
      ERROR: msg,
      ...(diag ? { CERT_MANAGER_PODS: truncateText(diag) } : {}),
    });
    process.exit(1);
  }
```

- [ ] **Step 3.6: Run full setup-suite tests**

Run: `npm test -- setup/`
Expected: PASS — everything still green.

- [ ] **Step 3.7: Run typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3.8: Commit**

```bash
git add setup/minikube.ts setup/minikube.test.ts
git commit -m "feat(setup): install cert-manager as Phase 3.5 of minikube setup

Required by credentialInjection internal-CA (cert-manager.io/v1 Issuer +
Certificate). Idempotent — skipped when an existing release is detected.
Add --skip-cert-manager flag for operators with cert-manager installed
out-of-band."
```

---

## Task 4: Wire into `e2e/global-setup.ts`

The e2e suite installs the chart on a fresh cluster (or reuses an existing release). When installing fresh with `credentialInjection.mode=sidecar` (the default), cert-manager must already be present. Call the same shared installer before the helm-install branch.

**Files:**
- Modify: `e2e/global-setup.ts`

- [ ] **Step 4.1: Import the installer**

In `e2e/global-setup.ts`, after the existing imports, add:

```typescript
import { installCertManager } from '../setup/cert-manager.js';
```

- [ ] **Step 4.2: Call the installer before the helm-install branch**

Find the block currently around line 176 that begins with `// ── Install kubeclaw via Helm ─────`. Insert immediately *before* the `existingRelease` lookup:

```typescript
  // Ensure cert-manager is available before the kubeclaw helm install. The
  // chart's credentialInjection internal-CA template references
  // cert-manager.io/v1 CRDs; without them, `helm install` fails with
  // "no matches for kind Certificate". Idempotent — a no-op if cert-manager
  // is already installed (the common case after `npm run setup:minikube`).
  try {
    await installCertManager();
  } catch (err) {
    console.warn(
      `⚠️  cert-manager install/check failed: ${err}\n` +
        '   The kubeclaw helm install may fail if credentialInjection.mode ' +
        '!= off and the chart references Certificate/Issuer resources.\n',
    );
  }
```

The `try/catch` here mirrors the agent-image build block — surface a warning but don't abort: this preserves the existing path where the e2e suite is run against a pre-installed kubeclaw release (where cert-manager may already be present from setup, or where the operator has explicitly chosen `mode=off`).

- [ ] **Step 4.3: Smoke-run the e2e setup against the live cluster**

Pre-condition: minikube `kubeclaw` profile running, cert-manager already installed from prior work.

Run: `CI=true npx vitest run --config vitest.e2e.config.ts e2e/credential-injection-istio.test.ts --reporter=default`
Expected: global-setup logs `cert-manager already installed — skipping`; istio test file reports `7 tests | 7 skipped` (the `describe.skipIf` from the previous session); no errors.

- [ ] **Step 4.4: Commit**

```bash
git add e2e/global-setup.ts
git commit -m "test(e2e): ensure cert-manager is present in global-setup before helm install"
```

---

## Task 5: Documentation updates

The user-facing change is "you no longer need to install cert-manager yourself". Three docs reference the install flow and need updating.

**Files:**
- Modify: `INSTALL.md`
- Modify: `docs/CREDENTIAL_INJECTION.md`
- Modify: `README.md` (only if a prerequisites list mentions cert-manager)

- [ ] **Step 5.1: Update `INSTALL.md`**

Find the section that describes `npm run setup:minikube` and the phases it runs. Add a bullet describing the cert-manager phase. Concrete addition (drop into the existing phase list — adapt wording to match local prose):

```markdown
- **cert-manager** (Phase 3.5) — installs `jetstack/cert-manager` v1.16.x into
  the `cert-manager` namespace. Provides the Issuer/Certificate CRDs used by
  KubeClaw's credentialInjection internal CA. Idempotent: skipped if
  cert-manager is already present in the cluster. Use `--skip-cert-manager`
  to bypass entirely (e.g. when running with `credentialInjection.mode=off`,
  or when cert-manager is managed by another team/tool).
```

- [ ] **Step 5.2: Update `docs/CREDENTIAL_INJECTION.md`**

Search for the existing "Prerequisites" or "Operator setup" section. Replace any "You must install cert-manager" prose with:

```markdown
### cert-manager

The default `credentialInjection.mode=sidecar` (and `mode=istio`) requires
cert-manager to mint the internal egress CA. KubeClaw's setup script
(`npm run setup:minikube`) installs cert-manager v1.16.x automatically in
Phase 3.5; production deployments typically already have cert-manager
cluster-wide, in which case the setup step is a no-op.

If you want to manage cert-manager outside of KubeClaw's setup flow:

1. Install cert-manager separately (any v1.13+ works).
2. Run KubeClaw's setup with `--skip-cert-manager`, *or* deploy the chart
   directly with `helm install`.

To bypass cert-manager entirely (env-var injection of API keys instead of
broker/sidecar TLS interception):

```bash
helm upgrade kubeclaw helm/kubeclaw -n kubeclaw \
  --set credentialInjection.mode=off
```
```

- [ ] **Step 5.3: Update `README.md` if it lists install prereqs**

```bash
grep -n 'cert-manager\|prerequisites\|prereq' README.md
```

If a prerequisites list mentions cert-manager as a manual step, remove the line and replace with a one-liner: "cert-manager is installed automatically by the setup script — see `INSTALL.md`." If no mention exists, no change.

- [ ] **Step 5.4: Commit**

```bash
git add INSTALL.md docs/CREDENTIAL_INJECTION.md README.md
git commit -m "docs: document automatic cert-manager install in setup flow"
```

---

## Task 6: End-to-end smoke test on live minikube

Validate the full setup-to-deploy flow on a real minikube cluster. This is a manual test — fast enough to do as part of the plan execution.

- [ ] **Step 6.1: Snapshot the current cluster state**

```bash
kubectl get pods -n kubeclaw
kubectl get pods -n cert-manager
helm list -A
```

Record what's currently deployed so you can revert if needed.

- [ ] **Step 6.2: Tear down the existing kubeclaw release (preserves cluster)**

```bash
helm uninstall kubeclaw -n kubeclaw
helm uninstall cert-manager -n cert-manager
kubectl delete ns kubeclaw --wait=false
kubectl delete ns cert-manager --wait=false
```

Wait ~30 s for namespaces to finalize.

- [ ] **Step 6.3: Run setup end-to-end**

```bash
npm run setup:minikube -- --profile kubeclaw --skip-build
```

`--skip-build` reuses the existing `kubeclaw-orchestrator:latest` / `kubeclaw-agent:latest` images so the smoke test focuses on cert-manager wiring rather than re-rebuilding images.

Expected output: structured status emits including `SETUP_MINIKUBE_CERT_MANAGER` with `STATUS: ok` and `RESULT: installed`.

- [ ] **Step 6.4: Verify cluster state**

```bash
kubectl get deploy -n cert-manager        # expect 3/3 Ready
kubectl get certificate -n kubeclaw kubeclaw-egress-ca  # expect Ready=True
kubectl get secret -n kubeclaw kubeclaw-egress-ca-tls   # expect type kubernetes.io/tls
kubectl get pods -n kubeclaw              # expect orchestrator + redis Running
```

- [ ] **Step 6.5: Re-run setup to verify idempotency**

```bash
npm run setup:minikube -- --profile kubeclaw --skip-build
```

Expected: `SETUP_MINIKUBE_CERT_MANAGER` emits `STATUS: ok` with `RESULT: present`, no helm repo/install actions performed.

- [ ] **Step 6.6: Run the e2e suite**

```bash
npm run test:e2e -- --reporter=default
```

Expected: `credential-injection.test.ts` (suite-level), `credential-broker.test.ts`, `helm-chart.test.ts`, `mock-onboarding.test.ts` now pass. Total failure count should drop from 6 (current baseline) to ≤2 (remaining failures are tool-pod tests that need real API keys, unrelated to this change).

- [ ] **Step 6.7: Final commit if any further doc tweaks emerged**

If running the smoke test surfaced a documentation gap, capture it now:

```bash
git add docs/ INSTALL.md README.md
git commit -m "docs: clarifications from cert-manager smoke test" || echo "nothing to commit"
```

---

## Out of scope

- **Chart subchart dependency**: rejected for the reasons in the Architecture section.
- **Cert-manager version bumps**: tracked via the `CERT_MANAGER_VERSION` constant in `setup/cert-manager.ts`. A future bump is one line + a re-run of Task 6.
- **`setup/kubernetes.ts`** (non-minikube install path): currently uses raw `kubectl apply` of `k8s/*.yaml` manifests rather than the helm chart, so it doesn't need cert-manager. If/when that path is migrated to helm, this same `installCertManager` helper applies.
- **Chart-side `{{ fail }}` guard**: rejected — would break `helm template`-based tests because `.Capabilities.APIVersions` is empty during template render.
- **Istio CRD installer** (for `credentialInjection.mode=istio`): out of scope; Istio is a much heavier dependency and the istio test file is already gated with `describe.skipIf` from prior work.

## Estimated total time

- Tasks 1-2: ~25 min (small modules + tests)
- Task 3: ~15 min (wiring + flag tests)
- Task 4: ~10 min (single insertion + smoke run)
- Task 5: ~15 min (docs)
- Task 6: ~20 min (manual smoke including waiting for helm)

**Total: ~85 min** end-to-end.
