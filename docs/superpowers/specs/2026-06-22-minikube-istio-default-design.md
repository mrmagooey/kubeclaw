# Minikube as the single cluster with Istio by default — Design Spec

**Date:** 2026-06-22
**Status:** Feasibility PROVEN; implementing.
**Goal:** Make Istio installed by default on the minikube cluster, run the credential-injection-istio suite on minikube, and remove the separate kind cluster entirely.

## Feasibility (proven before implementing)
On this host (~9.7 GB RAM): `minikube start --cpus=6 --memory=8192` + `istioctl install --set profile=minimal` + `minikube image load` of the test images → `credential-injection-istio.test.ts` passes **17/17** (1 `it.skip` by design), exit 0, no OOM (~3.8 GB used / ~5.8 GB free after setup). **8192 MB is the ceiling** — `--memory=10240` is rejected (>9.7 GB host limit). This is the reason the project historically used kind for istio: kind shares host RAM flexibly; minikube reserves a fixed block. 8 GB fits, so consolidation is viable.

## Design
1. **Istio install becomes part of minikube setup (idempotent).** After `minikube start`, run `istioctl install --set profile=minimal --set values.global.proxy.resources.requests.cpu=10m --set values.global.proxy.resources.requests.memory=40Mi -y` and wait for `istio-system` Ready — skipped if the `virtualservices.networking.istio.io` CRD already exists. Requires `istioctl` on PATH (add a download/version-pin step, matching the workflow: 1.24.3).
2. **Memory:** default minikube memory must be ≤ host limit and leave istio headroom → standardize on **8192 MB / 6 cpu** (8 GB is proven; do NOT request more — over-allocation hard-fails).
3. **The minikube creation paths** that need the istio step + the memory standard:
   - `setup/minikube.ts` (the `setup:minikube` script).
   - `e2e/Makefile` `setup-minikube` (+ `MINIKUBE_MEMORY`/`MINIKUBE_CPUS`).
   - `e2e/minikube-live-setup.ts` (recreates with **Cilium** for NetworkPolicy enforcement — see Risk below).
4. **The istio suite on minikube:** `credential-injection-istio.test.ts` is cluster-agnostic (drives kubectl/helm against the current context; `hasIstio` = the VirtualService CRD). It needs only: istio installed + the `kubeclaw-orchestrator:e2e-test` image loaded + `KUBECLAW_SKIP_HELM_INSTALL=true` (so global-setup's vanilla install doesn't trip `hasExistingRelease`). Update its header comment (it says "kind").
5. **Rewrite `.github/workflows/e2e-istio.yml` kind → minikube:** replace `kind create/load/delete` with `medyagh/setup-minikube` (memory 8192) + the istioctl install + `minikube image load` for the orchestrator + test images; run with `KUBECLAW_SKIP_HELM_INSTALL=true`. Keep the suite + log-collection steps.
6. **Remove all kind references** repo-wide (grep `kind create`, `kind load`, `kind delete`, `kubeclaw-e2e-istio`, the kind install step) — workflows, scripts, docs, test comments.
7. **Docs:** update the "minikube vs kind split" material (it's now one cluster); note istio is installed by default + the 8 GB sizing.

## Risk — Cilium + Istio on minikube-live (the one unproven combo)
`minikube-live-setup.ts` recreates minikube with **Cilium** (so NetworkPolicy is enforced for the netpol tests). The istio suite was proven on the **default CNI**, NOT with Cilium. Cilium CNI + Istio sidecar mesh coexist in principle but are finicky, and at 8 GB the combined footprint (Cilium + istiod + kubeclaw) is tighter. **Plan:** add the idempotent istio step to all three paths, then VALIDATE the minikube-live (Cilium) path with istio installed in a separate run before trusting it. If Cilium+istio doesn't fit/work at 8 GB, fall back: keep istio on the default-CNI minikube for the istio suite, and document that the netpol-enforcing minikube-live recreate is the one place istio may be absent (it doesn't run the istio suite anyway). Surface this to the user if it bites.

## Already done
- Kind cluster `kubeclaw-e2e-istio` deleted (user requested removal; also freed RAM — the host can't run kind + minikube simultaneously at 9.7 GB).

## Verification
After codifying: run the script-built minikube (via the updated setup) → `istioctl` present, istio Ready → the istio suite passes 17/18. Then (separately) the Cilium+istio minikube-live validation.
