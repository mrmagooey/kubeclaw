# Story 140: Helm chart secrets — credentials render via Secret, not embedded in YAML

## Goal

Verify that the kubeclaw helm chart renders all credentials into Kubernetes `Secret` objects rather than embedding plaintext values in Pod manifests, and that a kubeclaw release installed from the chart can read those secrets at runtime.

## Architecture

Credentials are managed exclusively through `helm/kubeclaw/templates/secrets.yaml`, which generates two persistent `Secret` objects (`kubeclaw-secrets` and `kubeclaw-redis`) and one per-HTTP-channel secret (`kubeclaw-channel-<name>`).

**`kubeclaw-secrets`** holds the LLM API keys and OAuth tokens passed in via `values.yaml` (or `--set`/`--values` overrides):
- `anthropic-api-key`, `claude-code-oauth-token`, `openai-api-key`, `openai-base-url`, `embedding-*`, `direct-llm-model`
- Conditionally: `admin-http-password` (when `orchestrator.admin.enabled=true`), `test-mock-token` (when `credentialInjection.istio.testFixture.enabled=true`)

**`kubeclaw-redis`** holds the Redis admin password and per-role ACL passwords (`channel-password`, `agent-password`, `tool-server-password`, `adapter-password`). The template uses `lookup "v1" "Secret" ...` to preserve existing passwords across helm upgrades, falling back to `randAlphaNum` on first install.

Both secrets carry `helm.sh/resource-policy: keep` so they survive `helm uninstall` without data loss.

Pod manifests (orchestrator Deployment in `helm/kubeclaw/templates/orchestrator.yaml`, channel/capability pods in `channel-pods.yaml` and `capability-pods.yaml`) reference these secrets via `envFrom: secretRef` or `valueFrom.secretKeyRef`, never via `value:` inline strings.

## Tech Stack

- **Test runner:** vitest e2e (`npm run test:e2e -- helm-chart -t "secrets"`)
- **Cluster:** real minikube via `requireKubernetes()` + helm install in `beforeAll`
- **Helm CLI:** `helm install` (performed by the test harness before the describe block runs)
- **LLM dependence:** none

## File Structure

| Path | Role |
|------|------|
| `e2e/helm-chart.test.ts` | `describe('secrets', ...)` at line 345 — 2 `it()` tests |
| `helm/kubeclaw/templates/secrets.yaml` | Renders `kubeclaw-secrets` and `kubeclaw-redis` Secret objects |
| `helm/kubeclaw/templates/orchestrator.yaml` | Orchestrator Deployment; references secrets via `envFrom`/`secretKeyRef` |
| `helm/kubeclaw/values.yaml` | Default values for `secrets.*`, `redis.password`, and `channels.*` |

## Tasks (retrospective)

### AC 1 — `kubeclaw-secrets` contains `anthropic-api-key` and `claude-code-oauth-token`

`secrets.yaml` renders a `Secret` named `kubeclaw-secrets` in `stringData` with keys `anthropic-api-key` and `claude-code-oauth-token` sourced from `.Values.secrets.anthropicApiKey` and `.Values.secrets.claudeCodeOauthToken`. The e2e test calls `kubectl get secret kubeclaw-secrets -o json` and asserts both keys are present in `.data`.

### AC 2 — `kubeclaw-redis` contains `admin-password` matching the install value

`secrets.yaml` renders a `Secret` named `kubeclaw-redis` with `stringData.admin-password` set to `$redisPassword` (resolved from `--set redis.password=<TEST_REDIS_PASSWORD>` at install time, or from an existing Secret on upgrade, or from `randAlphaNum 32` on first install). The e2e test decodes the base64-encoded value and asserts it equals the password provided at `helm install` time (`TEST_REDIS_PASSWORD`).

### AC 3 — Pods reference secrets via `envFrom`/`valueFrom.secretKeyRef`, not inline `value:`

The orchestrator Deployment and channel/capability pod templates pull secret values via `envFrom: [{secretRef: {name: kubeclaw-secrets}}]` and equivalents. No credential plaintext appears in any rendered Deployment or Job manifest — only secret references.

### AC 4 — Secret values can be overridden via `--set` or `--values`

Both `kubeclaw-secrets` and `kubeclaw-redis` are templated from helm values, so `--set secrets.anthropicApiKey=<key>` and `--set redis.password=<pw>` fully control the rendered Secret content. The `redis.password` path is also tested by the `helm upgrade` describe block (Story 135 area), which verifies password preservation across upgrade.

### AC 5 — Helm install with provided secrets succeeds and pods can read them

The `beforeAll` block performs a full helm install into a dedicated namespace. The `secrets` describe block runs only after that install completes, ensuring the Secrets exist and are readable by `kubectl`.

## Verification

Run: `npm run test:e2e -- helm-chart -t "secrets"`

Expected: **2 / 2 tests pass** — requires a live cluster with kubeclaw helm-installed (KUBECLAW_SKIP_HELM_INSTALL not set). Completes in under 30 seconds.
