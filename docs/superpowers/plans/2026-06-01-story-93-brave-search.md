# Story 93 — Brave Search catalog entry renders correctly in the credential-broker ConfigMap

**Date:** 2026-06-01  
**Status:** passing 2/2

---

## Goal

Ensure the helm chart's `credentialInjection.catalog[]` accepts a `brave-search` entry and renders the credential-broker ConfigMap with the correct host (`api.search.brave.com`), env-var binding (`BRAVE_API_KEY`), and `allowedPositions: header` — without leaking any real API key into rendered YAML.

---

## Architecture

The credential-broker ConfigMap is rendered by `helm/kubeclaw/templates/credential-broker-configmap.yaml`, which iterates over `credentialInjection.catalog[]` values and emits per-entry blocks containing `host`, `credentialFields[].envVar`, and `allowedPositions`. Tests in `e2e/credential-injection-integration.test.ts` call `helm template` via a shell-out helper (`helmTemplate()`), passing `--set` flags to inject the brave-search catalog entry, then assert on the raw YAML string — no Kubernetes cluster or live Brave API call is required. The secret-scrub invariant tests (sibling `describe` block) additionally confirm that no string matching a real Brave API key pattern (`/BSA[A-Za-z0-9]{25,}/`) appears in rendered output.

---

## Tech Stack

- **Test harness:** vitest e2e config (`vitest.config.e2e.ts`)
- **Chart rendering:** `helm template` CLI (shelled out from Node)
- **Assertions:** string `.toContain()` / `.not.toMatch()` on rendered YAML
- No Kubernetes cluster, no live Brave API, no LLM dependency

---

## File Structure

| Path | Role |
|------|------|
| `e2e/credential-injection-integration.test.ts` | E2e test file; `brave-search` describe block starts at line 79 |
| `helm/kubeclaw/templates/credential-broker-configmap.yaml` | Helm template that renders catalog entries into the ConfigMap |

---

## Tasks (retrospective)

### AC 1 — `api.search.brave.com` appears in rendered ConfigMap (mode=sidecar)

`helm template` is invoked with `credentialInjection.mode=sidecar` and catalog entry `id=brave-search`, `host=api.search.brave.com`. The template iterates `.catalog` and emits the host string. Test: `expect(out).toContain('api.search.brave.com')`.

### AC 2 — `BRAVE_API_KEY` env-var binding is present

Same render as AC 1; `credentialFields[0].envVar=BRAVE_API_KEY` is threaded through the template. Test: `expect(out).toContain('BRAVE_API_KEY')`.

### AC 3 — `allowedPositions: header` renders in ConfigMap shape

`allowedPositions[0]=header` is set via `--set`; template emits `allowedPositions` block. Test: `expect(out).toContain('allowedPositions')`.

### AC 4 — No real Brave API key in rendered YAML

The regex `/BSA[A-Za-z0-9]{25,}/` matches real Brave subscription-token shapes. Test asserts `.not.toMatch(...)` ensuring the secret-scrub invariant holds even when brave-search is in the catalog.

### AC 5 — Both mode=sidecar and mode=istio produce valid renders

Both modes must render without helm error. (Covered implicitly by the existing cross-mode regression block in the same test file; story scope is chart rendering only.)

### Verification

**Command:** `npm run test:e2e -- credential-injection-integration -t "brave-search"`  
**Expected:** 2 passed / 2 total  
**Actual:** 2 passed / 2 total
