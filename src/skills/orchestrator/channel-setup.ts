/**
 * Orchestrator skill: Channel setup.
 *
 * Creates K8s resources (Secret, PVCs, Deployment) for a new channel pod.
 * Extracted from admin-shell.ts handleSetupChannel() to be reusable by
 * both the admin shell and the orchestrator skill invocation path.
 */

import * as k8s from '@kubernetes/client-node';

import * as db from '../../db.js';
import { logger } from '../../logger.js';
import type { ChannelSetupInput, ChannelSetupResult } from './types.js';

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
const ORCHESTRATOR_DEPLOYMENT = 'kubeclaw-orchestrator';

// ---- Credential validation ----

/** Returns an error string if credentials are invalid, or null if valid. */
export async function validateChannelCredentials(
  type: string,
  secretData: Record<string, string>,
): Promise<string | null> {
  try {
    if (type === 'telegram') {
      const token = secretData['TELEGRAM_BOT_TOKEN'];
      if (!token) return 'TELEGRAM_BOT_TOKEN is required';
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) return json.description ?? 'Telegram rejected the token';
      return null;
    }

    if (type === 'discord') {
      const token = secretData['DISCORD_BOT_TOKEN'];
      if (!token) return 'DISCORD_BOT_TOKEN is required';
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return `Discord rejected the token (HTTP ${res.status})`;
      return null;
    }

    if (type === 'slack') {
      const token = secretData['SLACK_BOT_TOKEN'];
      if (!token) return 'SLACK_BOT_TOKEN is required';
      const res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) return json.error ?? 'Slack rejected the token';
      return null;
    }

    // IRC, WhatsApp, Signal, HTTP: no pre-flight validation possible
    return null;
  } catch (err) {
    return `Could not reach the channel API to validate credentials: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---- K8s resource helpers ----

export async function createOrPatchSecret(
  name: string,
  data: Record<string, string>,
): Promise<string> {
  const { coreV1 } = getK8sClients();
  try {
    await coreV1.readNamespacedSecret({ name, namespace: NAMESPACE });
    await coreV1.patchNamespacedSecret({
      name,
      namespace: NAMESPACE,
      body: { stringData: data },
    });
    return `Updated secret ${name}`;
  } catch {
    await coreV1.createNamespacedSecret({
      namespace: NAMESPACE,
      body: {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name, namespace: NAMESPACE },
        stringData: data,
      },
    });
    return `Created secret ${name}`;
  }
}

export async function createPvcIfNotExists(
  name: string,
  size: string,
): Promise<string> {
  const { coreV1 } = getK8sClients();
  try {
    await coreV1.readNamespacedPersistentVolumeClaim({
      name,
      namespace: NAMESPACE,
    });
    return `PVC ${name} already exists`;
  } catch {
    await coreV1.createNamespacedPersistentVolumeClaim({
      namespace: NAMESPACE,
      body: {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: { name, namespace: NAMESPACE },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: size } },
        },
      },
    });
    return `Created PVC ${name} (${size})`;
  }
}

async function getOrchestratorImage(): Promise<string> {
  const { appsV1 } = getK8sClients();
  const orchDeployment = await appsV1.readNamespacedDeployment({
    name: ORCHESTRATOR_DEPLOYMENT,
    namespace: NAMESPACE,
  });
  const orchContainer =
    orchDeployment.spec?.template?.spec?.containers?.find(
      (c) => c.name === 'orchestrator',
    ) ?? orchDeployment.spec?.template?.spec?.containers?.[0];
  return orchContainer?.image ?? 'kubeclaw-orchestrator:latest';
}

export async function createOrReplaceDeployment(
  name: string,
  body: k8s.V1Deployment,
): Promise<string> {
  const { appsV1 } = getK8sClients();
  try {
    await appsV1.readNamespacedDeployment({ name, namespace: NAMESPACE });
    await appsV1.replaceNamespacedDeployment({ name, namespace: NAMESPACE, body });
    return `Updated Deployment ${name}`;
  } catch {
    await appsV1.createNamespacedDeployment({ namespace: NAMESPACE, body });
    return `Created Deployment ${name}`;
  }
}

// ---- Main setup function ----

/** Build secret data from channel setup input. */
function buildSecretData(input: ChannelSetupInput): Record<string, string> {
  const { type } = input;
  const data: Record<string, string> = {};

  if (type === 'telegram' && input.token)
    data['TELEGRAM_BOT_TOKEN'] = input.token;
  if (type === 'discord' && input.token)
    data['DISCORD_BOT_TOKEN'] = input.token;
  if (type === 'slack' && input.token)
    data['SLACK_BOT_TOKEN'] = input.token;
  if (type === 'whatsapp' && input.phoneNumber)
    data['WHATSAPP_PHONE_NUMBER'] = input.phoneNumber;
  if (type === 'irc') {
    if (input.server) data['IRC_SERVER'] = input.server;
    if (input.nick) data['IRC_NICK'] = input.nick;
    if (input.channels) data['IRC_CHANNELS'] = input.channels;
  }
  if (type === 'http') {
    if (input.httpUsers) data['HTTP_CHANNEL_USERS'] = input.httpUsers;
    if (input.httpPort) data['HTTP_CHANNEL_PORT'] = String(input.httpPort);
  }
  if (type === 'signal' && input.phoneNumber)
    data['SIGNAL_PHONE_NUMBER'] = input.phoneNumber;

  return data;
}

function buildChannelEnvVars(
  instanceName: string,
  type: string,
  secretName: string,
  secretData: Record<string, string>,
): k8s.V1EnvVar[] {
  return [
    { name: 'KUBECLAW_MODE', value: 'channel' },
    { name: 'KUBECLAW_CHANNEL', value: instanceName },
    { name: 'KUBECLAW_CHANNEL_TYPE', value: type },
    {
      name: 'REDIS_URL',
      value: process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
    },
    {
      name: 'REDIS_ADMIN_PASSWORD',
      valueFrom: {
        secretKeyRef: { name: 'kubeclaw-redis', key: 'admin-password' },
      },
    },
    {
      name: 'OPENAI_API_KEY',
      valueFrom: {
        secretKeyRef: {
          name: 'kubeclaw-secrets',
          key: 'openai-api-key',
          optional: true,
        },
      },
    },
    {
      name: 'OPENAI_BASE_URL',
      valueFrom: {
        secretKeyRef: {
          name: 'kubeclaw-secrets',
          key: 'openai-base-url',
          optional: true,
        },
      },
    },
    {
      name: 'DIRECT_LLM_MODEL',
      valueFrom: {
        secretKeyRef: {
          name: 'kubeclaw-secrets',
          key: 'direct-llm-model',
          optional: true,
        },
      },
    },
    ...Object.keys(secretData).map((key) => ({
      name: key,
      valueFrom: { secretKeyRef: { name: secretName, key } },
    })),
  ];
}

/**
 * Set up a new channel: create K8s Secret, PVCs, and Deployment.
 * This is the canonical channel deployment function used by both the
 * admin shell and the orchestrator skill invocation path.
 */
export async function setupChannel(
  input: ChannelSetupInput,
): Promise<ChannelSetupResult> {
  const { type } = input;
  const instanceName = input.instanceName || type;
  const secretName = `kubeclaw-${instanceName}-secrets`;
  const deploymentName = `kubeclaw-channel-${instanceName}`;
  const log: string[] = [];

  const secretData = buildSecretData(input);
  if (Object.keys(secretData).length === 0) {
    return {
      success: false,
      log: [`No credentials provided for channel type "${type}".`],
      instanceName,
      deploymentName,
    };
  }

  // Validate credentials
  const validationError = await validateChannelCredentials(type, secretData);
  if (validationError) {
    return {
      success: false,
      log: [`Credential validation failed: ${validationError}`],
      instanceName,
      deploymentName,
    };
  }

  // Create or patch secret
  log.push(await createOrPatchSecret(secretName, secretData));

  // Create PVCs
  const pvcSizes: Record<string, string> = {
    groups: '2Gi',
    store: '1Gi',
    sessions: '1Gi',
  };
  for (const [suffix, size] of Object.entries(pvcSizes)) {
    const pvcName = `kubeclaw-channel-${instanceName}-${suffix}`;
    log.push(await createPvcIfNotExists(pvcName, size));
  }

  // Build and create Deployment
  const channelImage = await getOrchestratorImage();
  const envVars = buildChannelEnvVars(instanceName, type, secretName, secretData);

  const deploymentBody: k8s.V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: deploymentName, namespace: NAMESPACE },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: deploymentName } },
      template: {
        metadata: { labels: { app: deploymentName } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: { runAsUser: 1000, runAsGroup: 1000 },
          containers: [
            {
              name: 'channel',
              image: channelImage,
              command: ['node', 'dist/channel-runner.js'],
              env: envVars,
              volumeMounts: [
                { name: 'groups', mountPath: '/app/groups' },
                { name: 'store', mountPath: '/app/store' },
                { name: 'sessions', mountPath: '/data/sessions' },
              ],
              resources: {
                requests: { memory: '128Mi', cpu: '50m' },
                limits: { memory: '256Mi', cpu: '200m' },
              },
            },
          ],
          volumes: [
            {
              name: 'groups',
              persistentVolumeClaim: {
                claimName: `kubeclaw-channel-${instanceName}-groups`,
              },
            },
            {
              name: 'store',
              persistentVolumeClaim: {
                claimName: `kubeclaw-channel-${instanceName}-store`,
              },
            },
            {
              name: 'sessions',
              persistentVolumeClaim: {
                claimName: `kubeclaw-channel-${instanceName}-sessions`,
              },
            },
          ],
        },
      },
    },
  };

  log.push(await createOrReplaceDeployment(deploymentName, deploymentBody));
  log.push('Channel pod will start shortly — no orchestrator restart needed');

  // Auto-register group if requested
  if (
    input.registerGroup &&
    input.groupJid &&
    input.groupName &&
    input.groupFolder &&
    input.trigger
  ) {
    db.setRegisteredGroup(input.groupJid, {
      name: input.groupName,
      folder: input.groupFolder,
      trigger: input.trigger,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      containerConfig: { direct: true },
    });
    log.push(
      `Registered group "${input.groupName}" (${input.groupJid}) with direct LLM mode`,
    );
  }

  return { success: true, log, instanceName, deploymentName };
}
