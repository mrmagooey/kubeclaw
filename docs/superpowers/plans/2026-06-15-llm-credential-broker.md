# LLM Credential Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route channel-pod and agent-job LLM egress (OpenAI/Anthropic/OpenRouter + Voyage embeddings) through the credential broker via TLS origination, in both sidecar and istio modes, so those workloads no longer carry raw LLM keys.

**Architecture:** Make the LLM providers broker **catalog** entries (per-group + `allowOperatorFallback`) instead of legacy operator **mappings**; the workload sends a `KC_PH_…` placeholder in its auth header to Envoy over `http://`, Envoy substitutes the real key and originates TLS upstream. Channel pods (multi-group) use the operator-fallback sentinel; agent jobs (group-scoped) use per-group keys or fallback. The enabler is installing undici's `EnvHttpProxyAgent` so Node `fetch` honors the egress proxy in sidecar mode, with a complete `NO_PROXY` so in-cluster traffic bypasses it.

**Tech Stack:** TypeScript (ES2022/NodeNext), undici, OpenAI SDK + `@mariozechner/pi-ai`, Envoy ext_authz + Lua, Helm, Istio, vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-llm-credential-broker-design.md`

---

## Key facts for the implementer

- **Two packages:** main app `src/**` (root `package.json`); agent-runner `container/agent-runner/**` (own `package.json`). Run tests from repo root: `npx vitest run [file]`. Both tsc: `npx tsc --noEmit` and `cd container/agent-runner && npx tsc --noEmit && cd ../..`. Helm: `helm template helm/kubeclaw >/dev/null`.
- **Node 24 on PATH before `git commit`:** `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"`. Use explicit `git add <paths>` (never `git add -A`).
- **Injection is `off` by default** (`CREDENTIAL_INJECTION_MODE`), so most unit tests run in `off` mode and these changes are inert there — intermediate task states don't break the default suite.
- **The catalog → agent-job flow is already automatic:** `buildToolJobSpec` (`src/k8s/job-runner.ts:671`) passes `this.catalog.getCatalog()` (ALL broker catalog entries) as `spec.catalogEntries`; `generateJobManifest` runs `buildCatalogEnvs` over them when injection is on. So adding LLM entries to the broker catalog makes them flow to agent jobs automatically.
- **The catalog placeholder must SURVIVE to the SDK** (the SDK sends it; Envoy substitutes). This is the opposite of the old mappings model (which stripped the key and the broker *added* the header). So the old strip/substitute machinery (`STRIPPED_WHEN_INJECTED`, `applyIstioModeEnvSubstitution`, `ISTIO_API_KEY_PLACEHOLDER`) — which only ever handled the 4 LLM keys — becomes wrong for the catalog model and is removed (Task 3).
- **Cross-language constant:** `FALLBACK_SENTINEL_PREFIX = 'KC_PH_FALLBACK_'` (`src/k8s/job-runner.ts:250`). Channel-pod Helm must emit `KC_PH_FALLBACK_<id>` matching this exactly.
- **`buildCatalogEnvs`** (`src/k8s/job-runner.ts:262`) emits, per credentialField: the per-group placeholder (if `groupPlaceholders[id][field]` present) else `KC_PH_FALLBACK_<id>` (if `allowOperatorFallback`) else `injected-by-broker`; plus each `baseUrlEnvs` entry; and returns `coveredEnvNames` (used to strip the raw `secretKeyRef` envs of the same name).

## File structure

| File | Change | Task |
| --- | --- | --- |
| `helm/kubeclaw/templates/credential-broker-config.yaml` | Remove LLM `mappings`; (catalog comes from values) | 1 |
| `helm/kubeclaw/values.yaml` | Add openai/anthropic/openrouter/voyage `catalog` entries; ensure broker-config renders catalog | 1 |
| `helm/kubeclaw/templates/secrets.yaml` | Add id-keyed operator secret keys (openai/anthropic/openrouter/voyage) | 1 |
| `src/credential-broker/*.test.ts` | catalog supersedes mappings for LLM hosts | 1 |
| `src/runtime/proxy-dispatcher.ts` (new) | `installProxyDispatcher()` (undici EnvHttpProxyAgent) | 2 |
| `container/agent-runner/src/proxy-dispatcher.ts` (new) | same, agent-runner copy | 2 |
| `src/index.ts` / `src/channel-runner.ts` | call `installProxyDispatcher()` at startup | 2 |
| `container/agent-runner/src/index.ts` | call `installProxyDispatcher()` at startup | 2 |
| `package.json` + `container/agent-runner/package.json` | add `undici` dep | 2 |
| `src/credential-injection/workload-env.ts` | expand `NO_PROXY` | 2 |
| `helm/kubeclaw/templates/_helpers.tpl` | expand `kubeclaw.credentialSidecarEnv` `NO_PROXY` (sync) | 2 |
| `src/k8s/job-runner.ts` | remove `STRIPPED_WHEN_INJECTED`/`applyIstioModeEnvSubstitution`/`ISTIO_API_KEY_PLACEHOLDER` (now catalog-driven) | 3 |
| `src/k8s/job-runner.test.ts` | agent job gets LLM placeholders + base URLs, raw keys stripped | 3 |
| `helm/kubeclaw/templates/channel-pods.yaml` + `_helpers.tpl` | new `kubeclaw.llmBrokerEnv` helper (placeholder+http base URL, both modes); drop raw-key + istio-only base-URL for LLM | 4 |
| `e2e/minikube-live-llm-broker.test.ts` (new) | both-mode e2e | 5 |

---

## Task 1: Broker catalog entries for LLM providers (retire mappings)

**Files:** `helm/kubeclaw/values.yaml`, `helm/kubeclaw/templates/credential-broker-config.yaml`, `helm/kubeclaw/templates/secrets.yaml`, broker tests.

- [ ] **Step 1: Add the LLM catalog entries to `values.yaml`**

In `helm/kubeclaw/values.yaml`, under `credentialInjection.catalog` (after `google-places`, ~line 456), add:

```yaml
    - id: openai
      host: api.openai.com
      upstreamPort: 443
      credentialFields:
        - { name: api_key, envVar: OPENAI_API_KEY }
      baseUrlEnvs:
        OPENAI_BASE_URL: "http://api.openai.com/v1"
      allowOperatorFallback: true
      allowedPositions: [header]
      apiKeyShape: { prefix: "sk-", minLength: 20 }
    - id: anthropic
      host: api.anthropic.com
      upstreamPort: 443
      credentialFields:
        - { name: api_key, envVar: ANTHROPIC_API_KEY }
      baseUrlEnvs:
        ANTHROPIC_BASE_URL: "http://api.anthropic.com"
      allowOperatorFallback: true
      allowedPositions: [header]
      apiKeyShape: { prefix: "sk-ant-", minLength: 20 }
    - id: openrouter
      host: openrouter.ai
      upstreamPort: 443
      credentialFields:
        - { name: api_key, envVar: OPENROUTER_API_KEY }
      baseUrlEnvs:
        OPENROUTER_BASE_URL: "http://openrouter.ai/api/v1"
      allowOperatorFallback: true
      allowedPositions: [header]
      apiKeyShape: { prefix: "sk-or-", minLength: 20 }
    - id: voyage
      host: api.voyageai.com
      upstreamPort: 443
      credentialFields:
        - { name: api_key, envVar: VOYAGE_API_KEY }
      baseUrlEnvs:
        VOYAGE_BASE_URL: "http://api.voyageai.com"
      allowOperatorFallback: true
      allowedPositions: [header]
```

VERIFY during impl: the OpenAI Node SDK appends `/chat/completions` to `OPENAI_BASE_URL`, so the base URL must end at `/v1`. pi-ai's openai provider uses `${baseUrl}` similarly (`container/agent-runner/src/model.ts` defaults `https://api.openai.com/v1`). Confirm OpenRouter expects `/api/v1`, Anthropic bare host, Voyage bare host (the embedding client posts to `${VOYAGE_BASE_URL}/v1/embeddings` — so Voyage base must be bare host; check `src/runtime/embedding-client.ts`). Adjust the four `baseUrlEnvs` to match the actual SDK path-join before shipping.

- [ ] **Step 2: Remove the LLM `mappings` from the broker config template**

In `helm/kubeclaw/templates/credential-broker-config.yaml`, delete the four `mappings` entries (`anthropic`, `openai`, `openrouter`, `voyage`, ~lines 9-29). If that leaves `mappings:` empty, render it as `mappings: []` (the schema's `NullableArray` accepts empty/absent). Confirm the template still renders the `catalog:` from `.Values.credentialInjection.catalog` (it must — that's how brave/google reach the broker; if the template does NOT currently render `catalog`, add `catalog: {{ toYaml .Values.credentialInjection.catalog | nindent ... }}` so the new LLM entries reach the broker config too). Quote/verify the existing catalog rendering before editing.

- [ ] **Step 3: Add id-keyed operator secret keys**

In `helm/kubeclaw/templates/secrets.yaml` `stringData`, add keys named by catalog id (so `operatorSecretReader` → `kubeclaw-secrets[<id>]` resolves), populated from the existing values:

```yaml
  openai: {{ .Values.secrets.openaiApiKey | quote }}
  anthropic: {{ .Values.secrets.anthropicApiKey | quote }}
  openrouter: {{ .Values.secrets.openrouterApiKey | default "" | quote }}
  voyage: {{ .Values.secrets.voyageApiKey | default "" | quote }}
```

Add `openrouterApiKey` / `voyageApiKey` to the `secrets:` stanza in `values.yaml` (default `""`) if absent. Keep the existing hyphenated keys (`openai-api-key`, etc.) for backward compat / other readers. (Operator UX unchanged — same values, the chart just also writes id-keyed copies.)

- [ ] **Step 4: Render + unit-test the catalog supersedes mappings**

Run `helm template helm/kubeclaw | grep -A2 'id: openai'` → confirm openai/anthropic/openrouter/voyage appear in the rendered broker `config.yaml` `catalog` and NOT in `mappings`.
Add/extend a broker test (`src/credential-broker/resolver.test.ts` or `index.test.ts`): with a catalog entry for `api.openai.com` (allowOperatorFallback) and NO mapping, `resolveSubstitutionMapAsync({host:'api.openai.com', ownerGroup:null})` returns `status:'ok'`, `keySource:'operatorFallback'`, placeholder `KC_PH_FALLBACK_openai`. And a per-group case returns the group placeholder. Run it; expect PASS.

- [ ] **Step 5: Full suite + tsc + helm; commit**

```bash
npx vitest run && npx tsc --noEmit && helm template helm/kubeclaw >/dev/null && echo OK
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add helm/kubeclaw/values.yaml helm/kubeclaw/templates/credential-broker-config.yaml helm/kubeclaw/templates/secrets.yaml src/credential-broker/
git commit -m "feat(broker): LLM providers as catalog entries (retire operator mappings)"
```

---

## Task 2: Proxy dispatcher + NO_PROXY (the enabler)

**Files:** `src/runtime/proxy-dispatcher.ts` (new) + `container/agent-runner/src/proxy-dispatcher.ts` (new); the two entrypoints; both `package.json`; `src/credential-injection/workload-env.ts`; `helm/kubeclaw/templates/_helpers.tpl`; tests.

- [ ] **Step 1: Add `undici` dependency to both packages**

`cd /home/peter/projects/kubeclaw && npm install undici@^6` (root) and `cd container/agent-runner && npm install undici@^6 && cd ../..`. (Pin a version exposing `EnvHttpProxyAgent` + `setGlobalDispatcher`; v6 does.) Confirm both `package.json` files list it.

- [ ] **Step 2: Write the failing test for the dispatcher shim (runtime)**

Create `src/runtime/proxy-dispatcher.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';

const calls: string[] = [];
vi.mock('undici', () => ({
  EnvHttpProxyAgent: class { constructor() { calls.push('agent'); } },
  setGlobalDispatcher: () => calls.push('set'),
}));

import { installProxyDispatcher } from './proxy-dispatcher.js';

describe('installProxyDispatcher', () => {
  afterEach(() => { calls.length = 0; delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY; });

  it('installs EnvHttpProxyAgent when HTTPS_PROXY is set', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8443';
    installProxyDispatcher();
    expect(calls).toEqual(['agent', 'set']);
  });

  it('is a no-op when no proxy env is set', () => {
    installProxyDispatcher();
    expect(calls).toEqual([]);
  });
});
```

Run: `npx vitest run src/runtime/proxy-dispatcher.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the shim (runtime)**

Create `src/runtime/proxy-dispatcher.ts`:

```typescript
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { logger } from '../logger.js';

/**
 * When the credential sidecar sets HTTP(S)_PROXY, Node's global `fetch` does NOT
 * honor it by default. Install undici's EnvHttpProxyAgent as the global dispatcher
 * so all `fetch` egress (incl. the LLM SDK + pi-ai) routes through the in-pod Envoy,
 * which stamps broker credentials. EnvHttpProxyAgent honors NO_PROXY, so in-cluster
 * destinations listed there go direct. No-op when no proxy env is set (e.g. istio
 * mode is transparent, or injection is off).
 */
export function installProxyDispatcher(): void {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    logger.info(
      { noProxy: process.env.NO_PROXY },
      'installed EnvHttpProxyAgent global dispatcher (egress via credential sidecar)',
    );
  }
}
```

Run: `npx vitest run src/runtime/proxy-dispatcher.test.ts` → PASS.

- [ ] **Step 4: Call it at the runtime entrypoint(s)**

In `src/index.ts` (orchestrator/channel entrypoint) and/or `src/channel-runner.ts` startup — add at the very top of the main async entry, before any LLM/HTTP work:

```typescript
import { installProxyDispatcher } from './runtime/proxy-dispatcher.js';
// ... first line of startup:
installProxyDispatcher();
```

Read the two entrypoints first; install it once per process at the earliest point (before `getDirectLLMRunner()` / before any `fetch`). If both files run in the same process, call it in the shared earliest entry only.

- [ ] **Step 5: Agent-runner copy + call**

Create `container/agent-runner/src/proxy-dispatcher.ts` (same body, but log via `process.stderr.write` or the agent-runner's `log()` since it has no `../logger.js`):

```typescript
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';

export function installProxyDispatcher(): void {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
}
```

In `container/agent-runner/src/index.ts`, import it and call `installProxyDispatcher()` as the first statement of `main()` (before `buildModel()`/any LLM call). Add a sibling test `container/agent-runner/src/proxy-dispatcher.test.ts` mirroring Step 2.

- [ ] **Step 6: Expand `NO_PROXY` (both sources, in sync)**

The global dispatcher proxies ALL `fetch`; in-cluster HTTP destinations must be in `NO_PROXY`: Ollama (`ollama`), Qdrant (`kubeclaw-qdrant`), the broker (`kubeclaw-credential-broker`), Redis (`kubeclaw-redis`), per-group + cluster capability services (FQDNs `*.svc.cluster.local`), and any embedding endpoint. Use short-names + cluster-domain suffixes.

In `src/credential-injection/workload-env.ts`, change the `NO_PROXY` value to:

```typescript
      value:
        'localhost,127.0.0.1,kubeclaw-redis,kubeclaw-credential-broker,ollama,kubeclaw-qdrant,.svc,.svc.cluster.local,.cluster.local',
```

In `helm/kubeclaw/templates/_helpers.tpl` `kubeclaw.credentialSidecarEnv` (~line 106-112), set the same `NO_PROXY` value (keep the two in exact sync). Add a comment in both pointing at each other.

- [ ] **Step 7: Test NO_PROXY coverage**

Add to `src/credential-injection/workload-env.test.ts`: assert the `NO_PROXY` value includes each of `kubeclaw-redis`, `kubeclaw-credential-broker`, `ollama`, `kubeclaw-qdrant`, `.svc.cluster.local`. Add a Helm render test (or extend an existing `_helpers`/sidecar render test) asserting the Helm `NO_PROXY` equals the TS one. Run them → PASS.

- [ ] **Step 8: Full suite + both tsc + helm; commit**

```bash
npx vitest run && npx tsc --noEmit && (cd container/agent-runner && npx tsc --noEmit) && helm template helm/kubeclaw >/dev/null && echo OK
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add src/runtime/proxy-dispatcher.ts src/runtime/proxy-dispatcher.test.ts container/agent-runner/src/proxy-dispatcher.ts container/agent-runner/src/proxy-dispatcher.test.ts src/index.ts src/channel-runner.ts container/agent-runner/src/index.ts package.json package-lock.json container/agent-runner/package.json container/agent-runner/package-lock.json src/credential-injection/workload-env.ts src/credential-injection/workload-env.test.ts helm/kubeclaw/templates/_helpers.tpl
git commit -m "feat(runtime): honor egress proxy for fetch (undici dispatcher) + complete NO_PROXY"
```

---

## Task 3: Agent-job wiring — let the catalog drive LLM keys; remove dead mappings-era code

**Files:** `src/k8s/job-runner.ts`, `src/k8s/job-runner.test.ts`.

Because `buildToolJobSpec` already passes all broker catalog entries (now incl. LLM) and `buildCatalogEnvs` stamps them, agent jobs gain the LLM placeholder + `http://` base URL automatically when injection is on, and `coveredEnvNames` strips the raw `secretKeyRef` LLM envs. The old `STRIPPED_WHEN_INJECTED` filter + `applyIstioModeEnvSubstitution` (which only handled the 4 LLM keys via the mappings model) now conflict — they'd strip/overwrite the catalog placeholder. Remove them.

- [ ] **Step 1: Failing test — agent job carries LLM placeholder + base URL, no raw key**

In `src/k8s/job-runner.test.ts`, add a test (reuse the existing generateJobManifest harness + a fake catalog/secretManager): with `injectionMode='sidecar'` (set `process.env.CREDENTIAL_INJECTION_MODE='sidecar'`), a catalog containing the `openai` entry, and no group placeholder, the produced agent container env contains `OPENAI_API_KEY=KC_PH_FALLBACK_openai` and `OPENAI_BASE_URL=http://api.openai.com/v1`, and does NOT contain a raw `OPENAI_API_KEY` `secretKeyRef`. Repeat asserting istio mode produces the SAME placeholder + base URL (NOT `injected-by-broker`). Run → FAIL (today istio yields `injected-by-broker` and sidecar strips the key).

- [ ] **Step 2: Remove the mappings-era strip/substitute machinery**

In `src/k8s/job-runner.ts`:
- Delete `STRIPPED_WHEN_INJECTED` (line ~197-202), `ISTIO_API_KEY_PLACEHOLDER` (~211), and `applyIstioModeEnvSubstitution` (~233-...).
- In the env-finalization block (~1040-1055), simplify so that for BOTH istio and sidecar (and not auditOnly), `finalEnv = baseEnvVars` (which already has catalog placeholders + base URLs from `buildCatalogEnvs`) plus, for sidecar mode only, `...workloadEnvForSidecar(...)`. istio mode adds no proxy env (transparent). auditOnly keeps real keys + adds proxy env (unchanged intent). Concretely:

```typescript
let finalEnv: Array<{ name: string; value?: string; valueFrom?: object }>;
if (injectionMode === 'sidecar') {
  finalEnv = [...baseEnvVars, ...workloadEnvForSidecar({ port: CREDENTIAL_SIDECAR_PORT })];
} else {
  // istio (transparent) or off
  finalEnv = baseEnvVars;
}
```

(`baseEnvVars` already had the raw keys stripped via `coveredEnvNames` and the placeholders appended when injection is on + not auditOnly. In auditOnly, `buildCatalogEnvs` didn't run, so raw keys remain for observation; sidecar still gets the proxy env — preserved by the branch above.) Verify the `ISTIO_API_KEY_PLACEHOLDER` is not referenced elsewhere (`buildCatalogEnvs` uses it as the no-fallback literal — KEEP that one usage by inlining the string `'injected-by-broker'` there, or keep a local const scoped to buildCatalogEnvs). Grep before deleting.

- [ ] **Step 3: Run the test → PASS; full suite + tsc**

`npx vitest run src/k8s/job-runner.test.ts` then `npx vitest run && npx tsc --noEmit`.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add src/k8s/job-runner.ts src/k8s/job-runner.test.ts
git commit -m "refactor(jobs): drive agent-job LLM keys from the catalog; remove mappings-era strip/substitute"
```

---

## Task 4: Channel-pod Helm wiring

**Files:** `helm/kubeclaw/templates/_helpers.tpl`, `helm/kubeclaw/templates/channel-pods.yaml`, a helm render test.

Channel pods are multi-group → operator fallback. They are Helm-rendered (not `buildCatalogEnvs`), so add a helper that emits the LLM placeholder envs (`KC_PH_FALLBACK_<id>`) + `http://` base URLs for BOTH sidecar and istio modes, replacing the off/audit-gated raw-key block and the istio-only base-URL helper for LLM providers.

- [ ] **Step 1: Add the `kubeclaw.llmBrokerEnv` helper**

In `_helpers.tpl`:

```yaml
{{/*
kubeclaw.llmBrokerEnv — LLM provider envs when credential injection is active.
Channel pods are multi-group, so they use the operator-fallback sentinel
(KC_PH_FALLBACK_<id>, must match FALLBACK_SENTINEL_PREFIX in src/k8s/job-runner.ts)
plus http:// base URLs (TLS origination via the sidecar/egress gateway).
*/}}
{{- define "kubeclaw.llmBrokerEnv" -}}
- { name: OPENAI_API_KEY,     value: "KC_PH_FALLBACK_openai" }
- { name: OPENAI_BASE_URL,    value: "http://api.openai.com/v1" }
- { name: ANTHROPIC_API_KEY,  value: "KC_PH_FALLBACK_anthropic" }
- { name: ANTHROPIC_BASE_URL, value: "http://api.anthropic.com" }
- { name: OPENROUTER_API_KEY, value: "KC_PH_FALLBACK_openrouter" }
- { name: OPENROUTER_BASE_URL, value: "http://openrouter.ai/api/v1" }
- { name: VOYAGE_API_KEY,     value: "KC_PH_FALLBACK_voyage" }
- { name: VOYAGE_BASE_URL,    value: "http://api.voyageai.com" }
{{- end -}}
```

(Match the base-URL paths to whatever Task 1 Step 1 settled on — keep them identical to the catalog `baseUrlEnvs`.)

- [ ] **Step 2: Rewire `channel-pods.yaml`**

In `helm/kubeclaw/templates/channel-pods.yaml`:
- Replace the off/audit-gated raw `OPENAI_API_KEY`/`OPENAI_BASE_URL` block (~78-91) and the VOYAGE raw block (~126-132) so that: when `mode == "off"` OR `auditOnly` → keep the existing raw `secretKeyRef` envs (unchanged); ELSE (sidecar or istio, not audit) → `{{- include "kubeclaw.llmBrokerEnv" $ | nindent 12 }}`.
- Remove the istio-only `kubeclaw.istioBaseUrlEnv` include for LLM (the new helper covers base URLs in both modes). If `istioBaseUrlEnv` is used for anything else, leave that; otherwise retire it.
- Leave `DIRECT_LLM_MODEL` and non-LLM envs untouched. The sidecar container/volumes + `credentialSidecarEnv` (proxy + NO_PROXY) includes stay as-is.

- [ ] **Step 3: Helm render test**

Add/extend a helm render test (`e2e/web-tools-manifest.test.ts` style, or a `helm-chart` render test) OR a vitest that runs `helm template` and asserts: with `credentialInjection.mode=sidecar`, a channel pod env has `OPENAI_API_KEY=KC_PH_FALLBACK_openai` + `OPENAI_BASE_URL=http://api.openai.com/v1` and NO `secretKeyRef` for `openai-api-key`; with `mode=off`, the raw `secretKeyRef` is present and the placeholder is absent. Assert the sentinel literal matches `FALLBACK_SENTINEL_PREFIX`.

- [ ] **Step 4: helm render + suite + commit**

```bash
helm template helm/kubeclaw --set credentialInjection.mode=sidecar | grep -A1 OPENAI_API_KEY
npx vitest run && helm template helm/kubeclaw >/dev/null && echo OK
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add helm/kubeclaw/templates/_helpers.tpl helm/kubeclaw/templates/channel-pods.yaml e2e/
git commit -m "feat(helm): channel pods get broker-injected LLM keys (operator fallback, both modes)"
```

---

## Task 5: End-to-end (both modes)

**Files:** `e2e/minikube-live-llm-broker.test.ts` (new).

- [ ] **Step 1: Study the harness**

Read `e2e/minikube-live-setup.ts`, `vitest.minikube-live.config.ts`, and an existing broker/credential e2e (`e2e/credential-injection.test.ts`, `e2e/credential-broker-live-reload.test.ts`, `e2e/credential-injection-istio.test.ts`). Note the `provisioned` gate, how injection mode is set for the test deploy, and how the broker **audit log** is read (the broker emits audit records — find how an e2e inspects them, e.g. broker pod logs / a metrics endpoint).

- [ ] **Step 2: Write the e2e**

Create `e2e/minikube-live-llm-broker.test.ts` following the harness. Gate on `provisioned`. For BOTH sidecar and istio mode deployments (or two it() blocks if the cluster runs one mode — document which), assert that a channel-pod (or agent-job) LLM call to `api.openai.com` is **broker-stamped**: verify via the broker audit log a `200` decision with `catalogId=openai` and `keySource=operatorFallback` (or `groupSecret`) for destination `api.openai.com`, and/or a mock upstream that asserts the real key arrived and the `KC_PH_FALLBACK_openai` placeholder did NOT leak. Also assert an in-cluster call (e.g. Ollama or the RAG store) still succeeds (NO_PROXY bypass) — proving the global dispatcher didn't break in-cluster traffic. Use a mock/test fixture for the upstream where the harness supports it (mirror `credential-injection-istio.test.ts`'s `testFixture`); do NOT require a real OpenAI key.

- [ ] **Step 3: Run (or clean gate) + tsc + commit**

Run via the minikube config; expect PASS on a cluster or the standard provisioned-gate failure here. `npx tsc --noEmit`. Confirm the default suite is unaffected.

```bash
export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"
git add e2e/minikube-live-llm-broker.test.ts
git commit -m "test(e2e): LLM egress is broker-stamped in sidecar + istio modes"
```

---

## Final verification

- [ ] `npx vitest run` green; `npx tsc --noEmit` + agent-runner tsc clean; `helm template helm/kubeclaw >/dev/null` OK.
- [ ] `helm template helm/kubeclaw --set credentialInjection.mode=sidecar` → channel pod + (sample) agent job carry `KC_PH_FALLBACK_<id>` placeholders + `http://` base URLs, no raw LLM `secretKeyRef`; `mode=off` keeps raw keys.
- [ ] Broker rendered `config.yaml`: LLM hosts in `catalog`, not `mappings`.
- [ ] `NO_PROXY` identical in `workload-env.ts` and `_helpers.tpl`, covering redis/broker/ollama/qdrant/`.svc.cluster.local`.
- [ ] Orchestrator unchanged (still reads keys directly); Ollama path unchanged.
- [ ] grep: no remaining `STRIPPED_WHEN_INJECTED` / `applyIstioModeEnvSubstitution` references.

## Self-review notes (author)

- **Spec coverage:** §2 catalog → Task 1; §3 operator-key/retire-mappings → Task 1; §4 origination (http base URLs) → Tasks 1+4; §5 proxy dispatcher → Task 2; §6 NO_PROXY → Task 2; §7 channel/agent wiring → Tasks 3+4; testing § → each task + Task 5.
- **Constant consistency:** `KC_PH_FALLBACK_<id>` in the Helm `llmBrokerEnv` helper must equal `FALLBACK_SENTINEL_PREFIX='KC_PH_FALLBACK_'` (Task 1/4 + a render test assert this).
- **Catalog `baseUrlEnvs` path values** (`/v1` vs bare host) are flagged in Task 1 Step 1 as a per-SDK verification gate, kept identical between the catalog (agent jobs) and the Helm helper (channel pods).
- **Order safety:** injection is `off` by default, so Tasks 1-4 are inert in the default test suite; intermediate commits don't break tests. The live behavior only engages when an operator sets `CREDENTIAL_INJECTION_MODE`.
- **Gated deletion:** Task 3 greps for `ISTIO_API_KEY_PLACEHOLDER`/`STRIPPED_WHEN_INJECTED` before removal; the one surviving `'injected-by-broker'` literal inside `buildCatalogEnvs` is preserved.
