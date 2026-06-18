# Testing

KubeClaw has three test levels:

- **Unit** — individual functions/classes with dependencies stubbed. Fast,
  no cluster.
- **Integration** — multiple components against real collaborators in-process
  (SQLite, fakes, `helm template`). No cluster.
- **End-to-end (e2e)** — the full system on a real Kubernetes cluster
  (minikube), exercised through its outermost interfaces (HTTP channel, IPC).

## Unit + integration

```bash
npm test            # vitest run — unit + integration suites
npm run test:watch  # watch mode
```

Unit/integration suites live next to the code as `*.test.ts` and
`*.integration.test.ts`. They require no cluster.

> The `container/agent-runner/` subpackage has its **own** `node_modules`.
> If its `*.test.ts` files fail to import (`Cannot find package
'@mariozechner/pi-agent-core'`), run `npm install` inside
> `container/agent-runner/` (or symlink that nested `node_modules` into your
> worktree).

## End-to-end (minikube)

The e2e suites run against a real cluster via:

```bash
npm run test:e2e -- e2e/<file>.test.ts
```

`e2e/global-setup.ts` runs once per invocation and:

1. Ensures minikube is up and `kubectl` points at it.
2. Builds the container images into the **minikube** Docker daemon (see below).
3. Ensures cert-manager is installed (needed by `credentialInjection`).
4. Installs a baseline `kubeclaw` release into the `kubeclaw` namespace —
   **unless** one already exists (it reuses the live release) or
   `KUBECLAW_SKIP_HELM_INSTALL=true` is set.

Most suites that need their own isolated cluster use the per-namespace helper
`e2e/lib/per-test-cluster.ts` (`setupTestCluster`), which installs a release in
its own namespace and tears it down afterward.

### Images and rebuilds

e2e pods use locally-built images in the minikube daemon (`pullPolicy: Never`,
tag `latest`). Build them with:

```bash
eval "$(minikube docker-env)"
./container/build.sh --all      # kubeclaw-agent, -orchestrator, -mcp-bundle (:latest)
```

`global-setup` rebuilds the **orchestrator** image automatically when anything
under `src/` (or `package*.json` / `tsconfig.json` / `Dockerfile`) is newer than
the existing image — so a source change is never silently tested against a stale
image. The `agent` and `mock-llm` images are built only if absent.

The repo ships a `.dockerignore` so `docker build` works from a git worktree
(without it the worktree's symlinked `node_modules` breaks `COPY . .`).

### e2e environment variables

| Variable                          | Effect                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `KC_E2E_REBUILD=1`                | Force `global-setup` to rebuild the orchestrator image even if it looks up to date.                             |
| `KC_E2E_SKIP_BUILD=1`             | Skip per-suite image builds/tagging; use whatever is already in the daemon.                                     |
| `KUBECLAW_SKIP_HELM_INSTALL=true` | `global-setup` does **not** install the baseline `kubeclaw` release; the calling suite manages its own install. |
| `KUBECLAW_MINIKUBE_PROFILE`       | Use a non-default minikube profile for `docker-env`.                                                            |

## Credential-injection e2e (sidecar vs istio)

`credentialInjection` runs in `off`, `sidecar`, or `istio` mode. The two live
suites cannot share cluster state and must be run **separately**, in order.

### 1. Sidecar mode

```bash
eval "$(minikube docker-env)"
./container/build.sh --all
docker tag kubeclaw-orchestrator:latest kubeclaw-orchestrator:e2e-injection  # broker tag the suite expects

KC_E2E_SKIP_BUILD=1 npm run test:e2e -- \
  e2e/credential-injection.test.ts \
  e2e/credential-injection-integration.test.ts
```

The sidecar suite's per-group cases layer on the baseline `kubeclaw` release
that `global-setup` installs (chart-default mode = sidecar). The integration
file is static `helm template` checks (no cluster work).

### 2. Istio mode

The istio suite installs its **own** `mode=istio` release into the `kubeclaw`
namespace, so that namespace must be empty first, and `global-setup` must not
install the baseline release. It expects images tagged `:e2e-test`.

```bash
# Istio must be installed in the cluster (istiod running in istio-system).

eval "$(minikube docker-env)"
./container/build.sh --all
for img in orchestrator agent mcp-bundle; do
  docker tag "kubeclaw-${img}:latest" "kubeclaw-${img}:e2e-test"
done

# Clean the kubeclaw namespace so the suite can do its own istio install.
helm uninstall kubeclaw -n kubeclaw 2>/dev/null || true
kubectl delete namespace kubeclaw --wait=true 2>/dev/null || true

KUBECLAW_SKIP_HELM_INSTALL=true KC_E2E_SKIP_BUILD=1 \
  npm run test:e2e -- e2e/credential-injection-istio.test.ts
```

The suite labels the namespace `istio-injection=enabled`, deploys the egress
gateway + broker + a `mock-upstream` fixture, and verifies broker-stamped egress
and per-group catalog credentials. In CI it runs on a dedicated kind cluster via
`.github/workflows/e2e-istio.yml`.

> One istio case (identity-mismatch) self-skips on minikube/kind when the
> pod-informer IP-lookup it depends on doesn't resolve in time — a known timing
> edge covered by `src/k8s/pod-informer.test.ts` and `identity.test.ts`.

After the istio run the suite tears down its `kubeclaw` namespace; reinstall a
baseline release if you want a running install:

```bash
helm upgrade --install kubeclaw ./helm/kubeclaw -n kubeclaw \
  --set namespace=kubeclaw --set secrets.anthropicApiKey=<key> \
  --set credentialInjection.broker.image=kubeclaw-orchestrator:latest
```

See [CREDENTIAL_INJECTION.md](CREDENTIAL_INJECTION.md) for what each mode does.
