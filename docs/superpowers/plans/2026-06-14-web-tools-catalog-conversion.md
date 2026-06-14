# Web Tools → Catalog Conversion + Credential-Injection Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `web_fetch` and `web_search` from static in-process built-ins into stock-image `file`-bridge catalog tools in the channel path, and port the existing Envoy credential-injection machinery onto `createSidecarToolPodJob` (gated per-tool via a new `ToolSpec.credentials` field) so `web_search` (and any future authenticated stock tool) can get its API key stamped at egress without ever holding the secret.

**Architecture:** A tool declares `credentials: [<broker-catalog-id>]`. `createSidecarToolPodJob` resolves those ids against the orchestrator's live `CatalogInformer` snapshot, runs them through the existing `buildCatalogEnvs` to produce `KC_PH_…` placeholder envs on the **user-tool** container, and — mirroring `generateJobManifest` — attaches the Envoy `credential-sidecar` container + `sidecarVolumes()` + `workloadEnvForSidecar()` proxy env + `serviceAccountName: kubeclaw-tool-job` + the `kubeclaw.io/owner-group` annotation, **only when the tool declares credentials and `CREDENTIAL_INJECTION_MODE != off`**. `web_fetch`/`web_search` ship as Helm catalog baseline entries on a stock curl image and leave the static maps.

**Tech Stack:** TypeScript (Node 24), vitest, the sidecar bridge (`container/agent-runner/src/tool-server.ts`), the tool catalog (`src/tools/types.ts`), `src/k8s/job-runner.ts`, the credential-injection helpers (`src/credential-injection/*`), Helm. Spec: `docs/superpowers/specs/2026-06-14-web-tools-catalog-conversion-design.md`.

---

## Pre-flight notes for the implementer

- **Node/PATH:** `export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH` before every `npm`/`node`/`npx`/`helm`. The root `node_modules` is built against Node 24.
- **Husky:** the pre-commit hook runs `prettier --write "src/**/*.ts"` and needs `npm` on PATH — always `export PATH=…` in the same shell as `git commit`. Prettier reformatting is harmless; a leftover drift at the end is committed as a `style:` commit (Task 9).
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Single test file:** `npx vitest run src/path/file.test.ts`. Full suite: `npm test`. e2e: `--config vitest.e2e.config.ts`.
- **Build-green invariant:** each commit must compile (`npm run build`) and pass `npm test`.

**Verified current shapes (do not re-derive):**
- `src/credential-injection/mode.ts`: `getInjectionMode(): 'off'|'sidecar'|'istio'` and `getAuditOnly(): boolean`. **Both are re-exported from `src/config.ts`**; `job-runner.ts` imports them from `'../config.js'`. The job-runner test mocks them inside `vi.mock('../config.js', …)`.
- `src/credential-injection/sidecar-spec.ts`: `sidecarContainerSpec({ image, port }): V1Container` (returns a container named `'credential-sidecar'`); `sidecarVolumes(): V1Volume[]` (3 volumes: `envoy-config` ConfigMap, `broker-token` projected SA token aud `kubeclaw-credential-broker`, `egress-ca` Secret).
- `src/credential-injection/workload-env.ts`: `workloadEnvForSidecar({ port }): Array<{name,value}>` → `HTTPS_PROXY`,`HTTP_PROXY`,`NO_PROXY`,`NODE_EXTRA_CA_CERTS`,`SSL_CERT_FILE` (CA path `/etc/ssl/certs/kubeclaw-egress-ca.crt`).
- `src/k8s/job-runner.ts`: `buildCatalogEnvs(catalogEntries: CatalogEntry[], groupPlaceholders: Record<string,Record<string,string>>): { envs: Array<{name,value}>; coveredEnvNames: Set<string> }`. `CatalogEntry` (from `src/credential-broker/resolver.ts`) = `{ id, host, upstreamPort, credentialFields: {name,envVar}[], baseUrlEnvs, allowOperatorFallback, allowedPositions, apiKeyShape? }`. `JobRunner` holds `this.catalog?: CatalogInformer` (`src/k8s/catalog.ts`, method `getCatalog(): CatalogEntry[]`) and `this.secretManager?` (method `getGroupPlaceholders(groupFolder): Promise<Record<string,Record<string,string>>>`). Config constants `CREDENTIAL_SIDECAR_IMAGE`, `CREDENTIAL_SIDECAR_PORT` come from `'../config.js'`.
- `generateJobManifest` injection block (`src/k8s/job-runner.ts` ~1005–1153): reads `injectionMode`/`auditOnly`; if `spec.catalogEntries?.length && mode!=='off' && !auditOnly` → `buildCatalogEnvs` then filter+merge into env; sidecar mode → append `sidecarContainerSpec`/`sidecarVolumes`, `workloadEnvForSidecar`, strip `STRIPPED_WHEN_INJECTED`; `serviceAccountName = mode!=='off' ? 'kubeclaw-tool-job' : ''`; `automountServiceAccountToken:false`; pod-template annotation `{'kubeclaw.io/owner-group': spec.ownerGroup}` when `spec.ownerGroup && !auditOnly`.
- `createSidecarToolPodJob` (`src/k8s/job-runner.ts` ~1714–1960): builds `bridgeEnv` (~1767), `userEnv` (~1876, `PORT` + file-bridge `KUBECLAW_TOOL_RUN`/`WORKDIR`), `containers` array (~1904: `[kubeclaw-tool-bridge, user-tool]`), `volumes`. Pod template metadata (~1899) has labels only — **no** `serviceAccountName`, `automountServiceAccountToken`, `annotations`, or sidecar. Method is `async` on `JobRunner` (so `this.catalog`/`this.secretManager` are available; `await` is fine).
- `SidecarToolPodJobSpec` (`src/k8s/types.ts` ~179): `{ agentJobId, groupFolder, toolName, toolSpec, timeout, groupsPvc?, sessionsPvc? }`. `groupFolder` is the owner-group value. No `catalogEntries`/`groupPlaceholders`/`ownerGroup` — resolve those inside the method.
- `src/tools/types.ts`: `ALLOWED_KEYS` set (~74) lists existing keys incl. `mount`,`mountReadOnly`,`run`; `validateTool(t): {ok:true}|{ok:false,error}` (~154, success `return {ok:true}` ~289); `RESERVED_NAMES` set has `web_fetch`,`web_search`,`browser`,`places_search`,`execution`.
- `src/runtime/direct-llm-runner.ts`: `TOOLS` `web_fetch` (~139–153) + `web_search` (~154–171); `TOOL_SERVER_NAME` `web_fetch:'webFetch'`(~440)/`web_search:'webSearch'`(~441); `TOOL_CATEGORY` `web_fetch:'browser'`(~448)/`web_search:'browser'`(~449).
- `helm/kubeclaw/templates/networkpolicies-injection.yaml` (~43–65): the `kubeclaw-workload-egress-restricted-sidecar-tool` NetworkPolicy (rendered only when `networkPolicy.enabled && credentialInjection.mode=='sidecar'`) **already allows egress to TCP 443 + 80 (`to: []`)**, plus DNS/Redis/broker.
- `src/k8s/job-runner.test.ts`: mocks `'../config.js'` incl. `getInjectionMode`/`getAuditOnly` (driven by `process.env.CREDENTIAL_INJECTION_MODE`), `CREDENTIAL_SIDECAR_IMAGE`,`CREDENTIAL_SIDECAR_PORT`,`assertGroupMountAllowed`,`getContainerImage`. `describe('createSidecarToolPodJob')` (~1361) has `baseSpec` (~1371, http tool `home_control`) + `fileSpec(mount?, extra)` (~1665). Credential-injection helpers are NOT mocked (real impls; tests assert manifest shape). Assertions read `mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec.template.spec`.

**Three-level test mapping:** Unit — `src/tools/types.test.ts`, `src/k8s/job-runner.test.ts`. Integration — `e2e/sidecar-tool-pod.test.ts` (real bridge + real wrapper running the actual `curl`-style `run` template against a local HTTP server). E2E — `e2e/minikube-live-web-tools.test.ts` (new; `createSidecarToolPodJob` manifest assertions on the live cluster, gated on `kubectl get nodes`).

---

### Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 0.1: Verify clean state + HEAD**

```bash
cd /home/peter/projects/kubeclaw
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
git status --porcelain   # Expected: empty
git rev-parse HEAD       # Cut the branch from here (has the committed spec + this plan)
```

- [ ] **Step 0.2: Branch** — the executor's worktree skill handles this; in-place fallback: `git checkout -b feat/web-tools-catalog`. Expected: on the feature branch.

---

### Task 1: `ToolSpec.credentials` field + validation

**Files:**
- Modify: `src/tools/types.ts`
- Test: `src/tools/types.test.ts`

- [ ] **Step 1.1: Write the failing tests** — add to `src/tools/types.test.ts` (reuse the existing `base` http fixture and `validateTool`):

```typescript
describe('validateTool — credentials', () => {
  it('accepts a credentials string array', () => {
    expect(validateTool({ ...base, credentials: ['brave-search'] })).toEqual({ ok: true });
  });
  it('accepts an absent credentials field', () => {
    expect(validateTool(base)).toEqual({ ok: true });
  });
  it('rejects a non-array credentials', () => {
    expect(validateTool({ ...base, credentials: 'brave-search' }).ok).toBe(false);
  });
  it('rejects a non-string element', () => {
    expect(validateTool({ ...base, credentials: ['ok', 123] }).ok).toBe(false);
  });
  it('rejects an empty-string element', () => {
    expect(validateTool({ ...base, credentials: [''] }).ok).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/tools/types.test.ts
```

Expected: the new tests FAIL (`credentials` not an allowed key → the unknown-key guard rejects, OR no validation yet — either way they fail meaningfully).

- [ ] **Step 1.3: Add the field** — in `src/tools/types.ts`, add to the `ToolSpec` interface (after `run?` or near the other optional fields):

```typescript
  /** Broker-catalog ids whose credentials this tool needs injected at egress.
   *  Each id resolves (orchestrator-side) to a placeholder env var on the
   *  user-tool container; the in-pod Envoy + broker substitute the real value at
   *  egress. Presence of any id triggers credential-sidecar attachment. */
  credentials?: string[];
```

Add `'credentials'` to `ALLOWED_KEYS`.

- [ ] **Step 1.4: Add validation** — in `validateTool`, before the final `return { ok: true };`, add (adapt the accessor name to the function's actual variable, e.g. `obj`):

```typescript
  if (obj.credentials !== undefined) {
    if (!Array.isArray(obj.credentials)) {
      return { ok: false, error: 'credentials must be an array of strings' };
    }
    for (const c of obj.credentials) {
      if (typeof c !== 'string' || c.length === 0) {
        return { ok: false, error: 'each credentials entry must be a non-empty string' };
      }
    }
  }
```

- [ ] **Step 1.5: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/tools/types.test.ts
```

Expected: build clean; all pass.

- [ ] **Step 1.6: Commit**

```bash
git add src/tools/types.ts src/tools/types.test.ts
git commit -m "feat(tools): ToolSpec.credentials field + validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Credential-injection port onto `createSidecarToolPodJob`

This is the load-bearing task. Mirror `generateJobManifest`'s mode-specific injection branching, scoped per-tool, applied to the **user-tool** container + pod template, **gated on `toolSpec.credentials?.length` and `mode !== 'off'`**. Read `generateJobManifest` (~1005–1153) first to mirror its exact branching.

**Files:**
- Modify: `src/k8s/job-runner.ts`
- Test: `src/k8s/job-runner.test.ts`

- [ ] **Step 2.1: Write the failing tests** — in `src/k8s/job-runner.test.ts`, inside `describe('createSidecarToolPodJob', …)`. First ensure the test's `JobRunner` has a catalog that returns a `brave-search` entry and a secret manager that returns no group placeholders. READ how the test constructs `JobRunner` (the `beforeEach`/instantiation) and how `this.catalog`/`this.secretManager` are provided. If the existing test builds `JobRunner` without a catalog, inject stubs — either via the constructor options the real `JobRunner` accepts, or by assigning `(jobRunner as any).catalog = fakeCatalog; (jobRunner as any).secretManager = fakeSecrets;` in a local `beforeEach` for these tests. Use this brave fixture + stubs:

```typescript
    const BRAVE_ENTRY = {
      id: 'brave-search',
      host: 'api.search.brave.com',
      upstreamPort: 443,
      credentialFields: [{ name: 'api_key', envVar: 'BRAVE_API_KEY' }],
      baseUrlEnvs: {},
      allowOperatorFallback: true,
      allowedPositions: ['header', 'body'] as Array<'header' | 'body'>,
    };
    const fakeCatalog = { getCatalog: () => [BRAVE_ENTRY] };
    const fakeSecrets = { getGroupPlaceholders: async () => ({}) };

    const credToolSpec = (extra: Record<string, unknown> = {}) => ({
      ...baseSpec,
      toolSpec: {
        ...baseSpec.toolSpec,
        pattern: 'file' as const,
        image: 'curlimages/curl:latest',
        run: 'curl -sS "$(cat "$INPUT_DIR/query")"',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        credentials: ['brave-search'],
        ...extra,
      },
    });
```

Wire `(jobRunner as any).catalog = fakeCatalog; (jobRunner as any).secretManager = fakeSecrets;` in a `beforeEach` (or per test) for this describe. Then add:

```typescript
    it('mode=sidecar + credentials: attaches the credential sidecar and placeholder/proxy env on user-tool only', async () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      await jobRunner.createSidecarToolPodJob(credToolSpec());
      const podSpec = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec.template.spec;
      const names = podSpec.containers.map((c: any) => c.name);
      expect(names).toContain('credential-sidecar');
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      const userEnvMap = Object.fromEntries(user.env.map((e: any) => [e.name, e.value]));
      expect(userEnvMap.BRAVE_API_KEY).toMatch(/^(KC_PH_|injected-by-broker)/);
      expect(userEnvMap.HTTPS_PROXY).toBeDefined();
      expect(userEnvMap.SSL_CERT_FILE).toBe('/etc/ssl/certs/kubeclaw-egress-ca.crt');
      // bridge container must NOT get cred/proxy env
      const bridge = podSpec.containers.find((c: any) => c.name === 'kubeclaw-tool-bridge');
      const bridgeEnvMap = Object.fromEntries(bridge.env.map((e: any) => [e.name, e.value]));
      expect(bridgeEnvMap.BRAVE_API_KEY).toBeUndefined();
      expect(bridgeEnvMap.HTTPS_PROXY).toBeUndefined();
      // pod identity
      expect(podSpec.serviceAccountName).toBe('kubeclaw-tool-job');
      const annotations = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec.template.metadata.annotations;
      expect(annotations['kubeclaw.io/owner-group']).toBe(baseSpec.groupFolder);
      // sidecar volumes present
      expect(podSpec.volumes.map((v: any) => v.name)).toEqual(expect.arrayContaining(['envoy-config', 'broker-token', 'egress-ca']));
      delete process.env.CREDENTIAL_INJECTION_MODE;
    });

    it('mode=off: a credentials-declaring tool gets NO injection (unchanged)', async () => {
      delete process.env.CREDENTIAL_INJECTION_MODE; // → 'off'
      await jobRunner.createSidecarToolPodJob(credToolSpec());
      const podSpec = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec.template.spec;
      expect(podSpec.containers.map((c: any) => c.name)).not.toContain('credential-sidecar');
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.env.map((e: any) => e.name)).not.toContain('BRAVE_API_KEY');
      expect(podSpec.serviceAccountName).toBeFalsy();
    });

    it('mode=sidecar + NO credentials: no injection (gating)', async () => {
      process.env.CREDENTIAL_INJECTION_MODE = 'sidecar';
      await jobRunner.createSidecarToolPodJob(credToolSpec({ credentials: undefined }));
      const podSpec = mockBatchApi.createNamespacedJob.mock.calls.at(-1)![0].body.spec.template.spec;
      expect(podSpec.containers.map((c: any) => c.name)).not.toContain('credential-sidecar');
      const user = podSpec.containers.find((c: any) => c.name === 'user-tool');
      expect(user.env.map((e: any) => e.name)).not.toContain('BRAVE_API_KEY');
      delete process.env.CREDENTIAL_INJECTION_MODE;
    });
```

(Adapt `mockBatchApi`/`baseSpec` names to the file's actual identifiers. If `template.metadata.annotations` is undefined when expected present, that's a real failure to fix in Step 2.3, not a test bug.)

- [ ] **Step 2.2: Run to verify failure**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npx vitest run src/k8s/job-runner.test.ts
```

Expected: the three new tests FAIL.

- [ ] **Step 2.3: Implement** — in `src/k8s/job-runner.ts`. Ensure these are imported (some already are — confirm, don't duplicate): from `'../config.js'`: `getInjectionMode`, `getAuditOnly`, `CREDENTIAL_SIDECAR_IMAGE`, `CREDENTIAL_SIDECAR_PORT`; from `'../credential-injection/sidecar-spec.js'`: `sidecarContainerSpec`, `sidecarVolumes`; from `'../credential-injection/workload-env.js'`: `workloadEnvForSidecar`. `buildCatalogEnvs` is in this file already.

In `createSidecarToolPodJob`, BEFORE `userEnv` and the `containers`/`volumes`/template are assembled, compute the gated credential additions (mirror `generateJobManifest`'s mode branching):

```typescript
    // --- Credential injection (gated on the tool declaring credentials) ---
    const injectionMode = getInjectionMode();
    const wantsCreds = (toolSpec.credentials?.length ?? 0) > 0 && injectionMode !== 'off';
    const credEnv: { name: string; value: string }[] = [];
    let credServiceAccount: string | undefined;
    let credAnnotations: Record<string, string> | undefined;
    const credContainers: unknown[] = [];
    const credVolumes: unknown[] = [];
    if (wantsCreds) {
      const ids = new Set(toolSpec.credentials);
      const entries = (this.catalog?.getCatalog() ?? []).filter((e) => ids.has(e.id));
      let groupPlaceholders: Record<string, Record<string, string>> = {};
      if (this.secretManager) {
        try {
          groupPlaceholders = await this.secretManager.getGroupPlaceholders(spec.groupFolder);
        } catch (err) {
          logger.warn({ err }, 'getGroupPlaceholders failed for sidecar tool pod; using empty');
        }
      }
      const { envs } = buildCatalogEnvs(entries, groupPlaceholders);
      credEnv.push(...envs);
      credServiceAccount = 'kubeclaw-tool-job';
      credAnnotations = { 'kubeclaw.io/owner-group': spec.groupFolder };
      if (injectionMode === 'sidecar') {
        credEnv.push(...workloadEnvForSidecar({ port: CREDENTIAL_SIDECAR_PORT }));
        credContainers.push(
          sidecarContainerSpec({ image: CREDENTIAL_SIDECAR_IMAGE, port: CREDENTIAL_SIDECAR_PORT }),
        );
        credVolumes.push(...sidecarVolumes());
      }
      // istio mode: mirror generateJobManifest's istio handling for the proxy/base-url env
      // if it differs from sidecar. If generateJobManifest applies workloadEnvForSidecar or a
      // base-url substitution for istio, replicate that exact behavior here. (Read ~1031-1041.)
    }
```

Then merge into the existing assembly:
- Append `...credEnv` to `userEnv` (the user-tool container env). `userEnv` is currently a `const` array literal — append after constructing it, e.g. `const userEnv = [ … ]; userEnv.push(...credEnv);` (or spread `...credEnv` into the literal). Do NOT add `credEnv` to `bridgeEnv`.
- Append `...credContainers` to the `containers` array (after `user-tool`).
- Append `...credVolumes` to the `volumes` array.
- On the pod **template**: set `serviceAccountName: credServiceAccount ?? ''`, `automountServiceAccountToken: false`, and `...(credAnnotations && { annotations: credAnnotations })` on `template.metadata`. Match the exact `template`/`template.metadata`/`template.spec` object the method builds (~1899–1903). Example shape:

```typescript
        template: {
          metadata: {
            labels: { app: 'kubeclaw-sidecar-tool' },
            ...(credAnnotations && { annotations: credAnnotations }),
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: credServiceAccount ?? '',
            automountServiceAccountToken: false,
            containers, // [...existing two, ...credContainers]
            volumes,    // [...existing, ...credVolumes]
          },
        },
```

(If `restartPolicy`/other fields already exist, keep them. The key additions are `serviceAccountName`, `automountServiceAccountToken`, conditional `annotations`, and the appended containers/volumes.)

- [ ] **Step 2.4: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/k8s/job-runner.test.ts
npx vitest run src/k8s/ 2>&1 | grep -E "Test Files|Tests "
```

Expected: PASS, no regressions (the existing `generateJobManifest` injection tests must still pass — shared helpers untouched).

- [ ] **Step 2.5: Commit**

```bash
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "feat(tools): credential-injection port on createSidecarToolPodJob (gated by ToolSpec.credentials)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Remove web_fetch/web_search from the static surface

**Files:**
- Modify: `src/runtime/direct-llm-runner.ts`
- Modify: `src/tools/types.ts` (unreserve the two names)
- Test: `src/runtime/direct-llm-runner.test.ts` (adjust if it asserts on these as static tools)

- [ ] **Step 3.1: Check for affected tests**

```bash
cd /home/peter/projects/kubeclaw
grep -n "web_fetch\|web_search" src/runtime/direct-llm-runner.test.ts src/direct-llm-runner.description.test.ts 2>/dev/null | head
```

Note any test asserting `web_fetch`/`web_search` appear in the static `TOOLS`/`TOOL_CATEGORY`/`TOOL_SERVER_NAME` — those expectations change.

- [ ] **Step 3.2: Remove from the maps** — in `src/runtime/direct-llm-runner.ts`:
- Delete the `web_fetch` and `web_search` entry objects from the `TOOLS` array (~139–171).
- Delete `web_fetch: 'webFetch'` and `web_search: 'webSearch'` from `TOOL_SERVER_NAME`.
- Delete `web_fetch: 'browser'` and `web_search: 'browser'` from `TOOL_CATEGORY`.

Leave `browser` and `places_search` untouched in all three maps.

- [ ] **Step 3.3: Unreserve the names** — in `src/tools/types.ts`, remove `'web_fetch'` and `'web_search'` from `RESERVED_NAMES`. Keep `'browser'`, `'places_search'`, `'execution'`. If a test asserts these two are reserved, update it.

- [ ] **Step 3.4: Fix affected tests** — update any test from Step 3.1 that enumerated the static tool names to drop `web_fetch`/`web_search` (mirror how `bash` was handled in the prior conversion). Be surgical.

- [ ] **Step 3.5: Build + test**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
npx vitest run src/runtime/direct-llm-runner.test.ts src/direct-llm-runner.description.test.ts src/tools/types.test.ts
npx vitest run src/runtime/ 2>&1 | grep -E "Test Files|Tests "
```

Expected: build clean; tests pass; `browser`/`places_search` still present (grep to confirm).

- [ ] **Step 3.6: Commit**

```bash
git add src/runtime/direct-llm-runner.ts src/tools/types.ts src/runtime/direct-llm-runner.test.ts
git commit -m "refactor(tools): remove web_fetch/web_search from static maps; unreserve names (now catalog tools)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Helm — web_fetch + web_search catalog baseline

**Files:**
- Modify: `helm/kubeclaw/values.yaml`
- Modify: `helm/kubeclaw/values-minikube.yaml` (only if it overrides `tools:`)

- [ ] **Step 4.1: Add the two baseline tools** — in `helm/kubeclaw/values.yaml`, append to the existing `tools:` list (which already has `bash`/`bash_persist`):

```yaml
  - name: web_fetch
    description: Fetch the raw content of a URL over HTTP(S).
    parameters:
      type: object
      properties:
        url: { type: string }
      required: [url]
    image: curlimages/curl:latest
    pattern: file
    mount: none
    run: 'curl -sSL -A "Mozilla/5.0 KubeClaw/1.0" "$(cat "$INPUT_DIR/url")"'
  - name: web_search
    description: Search the web via the Brave Search API. Returns the raw Brave JSON response (up to 10 results).
    parameters:
      type: object
      properties:
        query: { type: string }
      required: [query]
    image: curlimages/curl:latest
    pattern: file
    mount: none
    credentials: [brave-search]
    run: 'curl -sS -G -H "X-Subscription-Token: $BRAVE_API_KEY" --data-urlencode "q=$(cat "$INPUT_DIR/query")" --data-urlencode "count=10" "https://api.search.brave.com/res/v1/web/search"'
```

- [ ] **Step 4.2: minikube values** — inspect `helm/kubeclaw/values-minikube.yaml`. If it overrides `tools:` (replacing the base list), add the same two entries there too. If it does not mention `tools`, the base default applies — no change. Report what you found/did.

- [ ] **Step 4.3: Verify Helm renders + fields survive**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
helm template kubeclaw helm/kubeclaw | grep -E 'web_fetch|web_search|brave-search|credentials' | head
helm template kubeclaw helm/kubeclaw >/dev/null && echo "helm OK"
helm template kubeclaw helm/kubeclaw -f helm/kubeclaw/values-minikube.yaml >/dev/null && echo "helm minikube OK"
```

Expected: both tools render in the tools ConfigMap with `credentials`/`run` intact (the ConfigMap template uses `toJson`, so all fields survive); helm renders with both value files.

- [ ] **Step 4.4: Commit**

```bash
git add helm/kubeclaw/values.yaml helm/kubeclaw/values-minikube.yaml
git commit -m "feat(tools): ship web_fetch + web_search catalog baseline (stock curl image)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Egress NetworkPolicy — verify, widen only if needed

The `kubeclaw-sidecar-tool` egress policy already allows TCP 443 + 80 (`to: []`) in sidecar mode. This task confirms web tools can egress in all relevant modes and only changes policy if a real gap exists.

**Files:**
- Inspect: `helm/kubeclaw/templates/networkpolicies-injection.yaml`, any general `helm/kubeclaw/templates/networkpolicies.yaml`, and any `k8s/` raw NetworkPolicy.

- [ ] **Step 5.1: Inventory the sidecar-tool egress**

```bash
cd /home/peter/projects/kubeclaw
grep -rln "kubeclaw-sidecar-tool" helm/kubeclaw/templates k8s 2>/dev/null
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
# Render in sidecar mode and inspect the sidecar-tool egress:
helm template kubeclaw helm/kubeclaw --set credentialInjection.mode=sidecar --set networkPolicy.enabled=true | grep -B2 -A30 'kubeclaw-sidecar-tool' | head -60
# Render in off mode — is there ANY egress policy selecting app: kubeclaw-sidecar-tool?
helm template kubeclaw helm/kubeclaw --set networkPolicy.enabled=true | grep -B2 -A30 'app: kubeclaw-sidecar-tool' | head -60
```

- [ ] **Step 5.2: Decide + act**
  - If, in every mode where a NetworkPolicy selects `app: kubeclaw-sidecar-tool`, egress to TCP 443 + 80 (`to: []`) is allowed (as the injection policy already does), then **no change** — web_fetch (direct) and web_search (via Envoy) can egress. Record this finding in the commit message / report and make no NetworkPolicy edit.
  - If a mode applies a restrictive sidecar-tool egress policy WITHOUT 443/80 (a real gap), add an egress rule allowing TCP 443 + 80 to `to: []` (mirroring the injection policy's existing rule) in that policy, excluding nothing beyond the existing convention.

- [ ] **Step 5.3: Commit (only if a change was made; otherwise note "no change needed" in the Task 9 report)**

```bash
git add helm/kubeclaw/templates/networkpolicies*.yaml
git commit -m "fix(netpol): allow outbound 80/443 for sidecar tool pods (web tools egress)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Integration test — real bridge + wrapper running the curl `run` template

Prove the `web_fetch`/`web_search` `run` templates are correct end-to-end at the bridge+wrapper level: the wrapper runs the actual `curl` command against a local HTTP server and returns the body. (Credential *substitution* is broker/Envoy and is covered by the credential-broker unit tests + Task 2 manifest assertions — not re-proven here; here we prove the `run` template shape and the file-bridge round trip with a real HTTP client.)

**Files:**
- Modify: `e2e/sidecar-tool-pod.test.ts`

- [ ] **Step 6.1: Read the harness** — re-read `e2e/sidecar-tool-pod.test.ts`: how it spawns the compiled bridge in `file-bridge` mode over a temp `/shared`, runs the real `tool-wrapper.sh` (extracted from `k8s/35-configmaps.yaml` with the `S=/shared` root rewritten), seeds toolcalls, reads toolresults. Confirm `curl` is available on the test host (`which curl`); if not, use a `node -e`/`printf`-based `run` that still exercises the wrapper + a local server. Prefer real `curl`.

- [ ] **Step 6.2: Add the tests** — start a tiny local HTTP server (Node `http.createServer`) on a dynamic port that echoes the request path + a chosen header, then:
  1. **web_fetch shape:** `KUBECLAW_TOOL_RUN='curl -sSL "$(cat "$INPUT_DIR/url")"'`, `KUBECLAW_TOOL_FIELDS=url`; seed a call with `{ url: 'http://127.0.0.1:<port>/hello' }`; assert the toolresult contains the server's body for `/hello`.
  2. **web_search shape:** `KUBECLAW_TOOL_RUN='curl -sS -G -H "X-Subscription-Token: $BRAVE_API_KEY" --data-urlencode "q=$(cat "$INPUT_DIR/query")" "http://127.0.0.1:<port>/search"'` with `BRAVE_API_KEY=test-token-123` exported to the wrapper subprocess and `KUBECLAW_TOOL_FIELDS=query`; seed `{ query: 'cats & dogs' }`; have the server echo back the received `X-Subscription-Token` header and the `q` query param; assert the toolresult shows `X-Subscription-Token: test-token-123` and the URL-encoded `q=cats+%26+dogs` (or `cats%20%26%20dogs`) — proving the header carries the (here non-placeholder) token and `--data-urlencode` encoded the query safely.

Use the existing dynamic-port/cleanup conventions; run the REAL wrapper script. Ensure the local server + any spawned procs are torn down in `afterEach`/`finally`.

- [ ] **Step 6.3: Run**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
cd container/agent-runner && npm run build && cd ../..
npx vitest run e2e/sidecar-tool-pod.test.ts --config vitest.e2e.config.ts 2>&1 | tail -10
```

Expected: PASS (new web-tool tests + existing file-bridge/http tests green).

- [ ] **Step 6.4: Commit**

```bash
git add e2e/sidecar-tool-pod.test.ts
git commit -m "test(tools): integration coverage for web_fetch/web_search run templates via real wrapper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end (minikube-live) — web_search/web_fetch manifest assertions

Prove a `credentials`-declaring catalog tool produces a real Job with the credential sidecar + placeholder/proxy env + identity, and a non-cred tool does not, on the live cluster. Call `createSidecarToolPodJob` directly (deployed orchestrator may predate this branch), constructing a `JobRunner` with a stub catalog so `brave-search` resolves.

**Files:**
- Create: `e2e/minikube-live-web-tools.test.ts`
- Gated on `kubectl get nodes`.

- [ ] **Step 7.1: Read the live harness** — read `e2e/minikube-live-bash-data-pvc.test.ts` (the model): the `isOrchestratorReady()`/cluster-gate skip pattern, the conditional `process.env.KUBECLAW_NAMESPACE` set before the dynamic `import('../src/k8s/job-runner.js')`, the `kubectl get jobs -o json` read-back, the `afterAll` job cleanup, and how it constructs the `JobRunner`. Note: this test sets `process.env.CREDENTIAL_INJECTION_MODE='sidecar'` at module top (before the dynamic import) so `getInjectionMode()` returns `sidecar`; restore it in `afterAll`.

- [ ] **Step 7.2: Write the test** — mirror the bash-data-pvc structure. Construct `JobRunner` and assign a stub catalog returning the `brave-search` entry (same `BRAVE_ENTRY` fixture as Task 2.1) and a stub secret manager returning `{}` (so the placeholder is the operator-fallback form). Two sub-tests, each creating a real Job, reading it back, asserting, then deleting it in `afterAll`:
  1. **web_search (credentials: ['brave-search'], mode=sidecar):** Job has a `credential-sidecar` container; the `user-tool` container env has `BRAVE_API_KEY` (matching `/^(KC_PH_|injected-by-broker)/`) + `HTTPS_PROXY` + `SSL_CERT_FILE`; pod `serviceAccountName == 'kubeclaw-tool-job'`; pod annotation `kubeclaw.io/owner-group` == the group; the `kubeclaw-tool-bridge` container has neither `BRAVE_API_KEY` nor `HTTPS_PROXY`; volumes include `envoy-config`/`broker-token`/`egress-ca`.
  2. **web_fetch (no credentials):** Job has NO `credential-sidecar` container; `user-tool` env has no `BRAVE_API_KEY`/`HTTPS_PROXY`.

Use unique `agentJobId`s (timestamp via `args`/`Date.now()` is unavailable in workflow scripts but fine in a vitest test) and clean up every created Job in `afterAll` via `kubectl delete job … --ignore-not-found=true`.

- [ ] **Step 7.3: Run (if cluster available)**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build
kubectl get nodes >/dev/null 2>&1 && npx vitest run e2e/minikube-live-web-tools.test.ts --config vitest.e2e.config.ts 2>&1 | tail -12 || echo "NO CLUSTER — note in report"
kubectl get jobs -n kubeclaw 2>/dev/null | grep -E "e2e-web" || echo "no leaked web jobs"
```

Expected if cluster present: PASS, no leaked jobs. If skipped, say so explicitly.

- [ ] **Step 7.4: Commit**

```bash
git add e2e/minikube-live-web-tools.test.ts
git commit -m "test(tools): minikube-live manifest coverage for credential-injected web_search + plain web_fetch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Docs

**Files:**
- Modify: `docs/TOOL_BRIDGE.md`

- [ ] **Step 8.1: Document** — add sections to `docs/TOOL_BRIDGE.md` (verify every claim against the code first):
  - **`ToolSpec.credentials`:** a list of broker-catalog ids; declaring any triggers credential-sidecar attachment (sidecar mode) and a per-tool placeholder env; least-privilege (a tool only receives the placeholder it declares).
  - **Credential-injected sidecar tool pods:** when a tool declares `credentials` and `CREDENTIAL_INJECTION_MODE != off`, `createSidecarToolPodJob` attaches the Envoy `credential-sidecar` + `HTTPS_PROXY`/`SSL_CERT_FILE` proxy env + `serviceAccountName: kubeclaw-tool-job` + the `kubeclaw.io/owner-group` annotation onto the **user-tool** container/pod; the bridge container never gets the secret/proxy. The real key is substituted by the broker at egress — the container holds only a `KC_PH_…` placeholder.
  - **Worked examples:** the `web_fetch` (no creds, direct egress) and `web_search` (`credentials: [brave-search]`, egress via Envoy, raw Brave JSON) catalog entries on stock `curlimages/curl`.
  - **Note:** `browser` remains a built-in (its own follow-on spec); the legacy agent-runner keeps `web_fetch`/`web_search` as in-process built-ins (dual existence, like bash).

- [ ] **Step 8.2: Commit**

```bash
git add docs/TOOL_BRIDGE.md
git commit -m "docs: ToolSpec.credentials + credential-injected web tools

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Full verification + final review

- [ ] **Step 9.1: Clean builds + full unit suite**

```bash
export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH
npm run build && cd container/agent-runner && npm run build && cd ../..
npm test 2>&1 | grep -E "Test Files|Tests "
```

Expected: all pass.

- [ ] **Step 9.2: Integration + (if cluster) minikube-live**

```bash
npx vitest run e2e/sidecar-tool-pod.test.ts --config vitest.e2e.config.ts 2>&1 | tail -4
kubectl get nodes >/dev/null 2>&1 && npx vitest run e2e/minikube-live-web-tools.test.ts --config vitest.e2e.config.ts 2>&1 | tail -4 || echo "No cluster — skipped"
```

- [ ] **Step 9.3: Helm + raw YAML**

```bash
helm template kubeclaw helm/kubeclaw >/dev/null && echo "helm OK"
helm template kubeclaw helm/kubeclaw -f helm/kubeclaw/values-minikube.yaml >/dev/null && echo "helm minikube OK"
```

- [ ] **Step 9.4: Commit any prettier drift**

```bash
git checkout -- e2e/results/ 2>/dev/null; git status --porcelain
# if only prettier reformats remain:
git add -A && git commit -m "style(tools): apply prettier formatting left by pre-commit hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 9.5: Two-stage review** — run spec-compliance then code-quality review per project policy before reporting complete.

---

## Out of scope (do not do these here)

- **`browser`** conversion (its own spec — cdp-primitives or Playwright-MCP). `browser` stays a static built-in; do not touch it in `direct-llm-runner.ts`, `RESERVED_NAMES`, or `BUILTIN_CATEGORIES`.
- **In-process local-path removal** (`executeToolLocal`, `createToolPodJob`, `BUILTIN_CATEGORIES`, the `execution`/`browser` machinery) — gated on retiring the legacy agent-runner; a separate migration. `web_fetch`/`web_search` keep their dual existence.
- **Istio-mode deep validation** — port sidecar mode fully and tested; mirror `generateJobManifest`'s istio handling structurally, but full istio end-to-end validation is a follow-on (no istio test harness here).
- Changing where the Brave key is provisioned, or the broker's catalog/policy model.
