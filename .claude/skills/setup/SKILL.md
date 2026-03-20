---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure

## 3. Kubernetes Setup

NanoClaw runs exclusively on Kubernetes. Check KUBERNETES status from step 2.

**Prerequisites check:**

- If KUBERNETES=not_found: kubectl is not installed. Install it:
  - macOS: `brew install kubectl`
  - Linux: Follow official Kubernetes docs for installation
- If KUBERNETES=installed_no_cluster: kubectl is installed but not connected to a cluster. Guide user to:
  - Set up a local cluster (e.g., kind, minikube, Docker Desktop Kubernetes)
  - Or connect to an existing remote cluster
- Verify kubectl is connected: `kubectl cluster-info`
- Check for required storage class: `kubectl get storageclass`
- If no ReadWriteMany storage class exists, warn user that multi-node clusters may not work properly

**AskUserQuestion:** Kubernetes configuration options

- Namespace (default: `nanoclaw`)
- Storage class to use (optional — will auto-detect if not specified)
- Container registry (optional — for pushing images, e.g., `your-registry.com/nanoclaw`)

**Build and Deploy:**

By default, images are expected to be pre-built or pulled from a registry. To build images locally during setup, pass the `--build` flag:

```bash
# Using pre-built images (default) - images must already exist in the cluster or registry
npx tsx setup/index.ts --step kubernetes -- --namespace <namespace> [--storage-class <class>] [--registry <registry>]

# Build images locally during setup
npx tsx setup/index.ts --step kubernetes -- --namespace <namespace> --build [--registry <registry>]
```

**If SECRETS_CONFIGURED=false:** The orchestrator needs API credentials. Guide user to create secrets:

```bash
kubectl create secret generic nanoclaw-secrets \
  --from-literal=anthropic-api-key=$ANTHROPIC_API_KEY \
  --from-literal=claude-code-oauth-token=$CLAUDE_CODE_OAUTH_TOKEN \
  -n <namespace>
```

**If IMAGES_BUILT=false:** Images couldn't be built/pushed. This is OK if using a pre-built registry image. If you need to build images, re-run with the `--build` flag.

**If DEPLOYMENT_READY=false:** Check pod status:

```bash
kubectl get pods -n <namespace>
kubectl describe deployment nanoclaw-orchestrator -n <namespace>
```

**Skip to Step 5 (channels)** — Kubernetes doesn't need local service setup.

#### Troubleshooting

**PVC stuck in Pending:**

- Check `STORAGE_STATUS` and `PVC_EVENTS` from the status block.
- If events mention "no persistent volumes available" or "storageclass not found": ask user whether they are on minikube/single-node (use `20-storage-minikube.yaml`) or production (need RWX storage class). Re-run the storage step with the correct manifest.
- If events mention "quota exceeded": ask user to check namespace resource quotas.

**Redis not ready:**

- Check `REDIS_POD_STATUS` and `REDIS_POD_EVENTS`.
- If pod is in `Pending`: likely a storage or scheduling issue — check node resources (`kubectl describe nodes`).
- If pod is in `CrashLoopBackOff`: check pod logs (`kubectl logs nanoclaw-redis-0 -n nanoclaw`).

**Orchestrator rollout timeout:**

- Check `DEPLOYMENT_EVENTS` and `POD_EVENTS`.
- Common causes: image pull failure (check `imagePullPolicy` and registry access), missing secrets (check `nanoclaw-secrets` exists), resource limits exceeded (check node capacity).
- If image pull error: guide user to push images to registry or load into cluster (`kind load docker-image ...`).

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?

- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:

1. Install the channel code (via `apply-skill`)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, continue to step 6.

## 6. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 7. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

- KUBERNETES_DEPLOYMENT=running → Service is up
- KUBERNETES_DEPLOYMENT=deployed_not_ready → Check pod logs: `kubectl logs -n nanoclaw deployment/nanoclaw-orchestrator`
- KUBERNETES_DEPLOYMENT=not_deployed → Re-run step 3
- KUBERNETES_DEPLOYMENT=not_found → kubectl not connected to cluster

If STATUS=failed, fix each:

- SERVICE=stopped → Restart deployment: `kubectl rollout restart deployment/nanoclaw-orchestrator -n nanoclaw`
- SERVICE=not_found → re-run step 3
- CREDENTIALS=missing → re-run step 4
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `kubectl logs -n nanoclaw deployment/nanoclaw-orchestrator -f`

## Troubleshooting

**Service not starting:** Check pod logs: `kubectl logs -n nanoclaw deployment/nanoclaw-orchestrator`. Common: missing secrets (re-run step 3), missing channel credentials (re-invoke channel skill).

**Container agent fails:** Check container logs: `kubectl logs -n nanoclaw deployment/nanoclaw-orchestrator`. Check agent logs in mounted volume or S3 depending on storage configuration.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check pod logs.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the deployment after any `.env` change: `kubectl rollout restart deployment/nanoclaw-orchestrator -n nanoclaw`

**Stop service:** `kubectl delete deployment nanoclaw-orchestrator -n nanoclaw`
