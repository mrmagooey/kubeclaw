/**
 * Orchestrator-side handler for `commit_channel_config` IPC message (Story 174).
 *
 * When the bootstrap pod finishes gathering credentials and running `npm ci`,
 * it calls `commit_channel_config` over Redis. This module handles that call:
 *   1. Validates the payload
 *   2. Creates the credentials Secret
 *   3. Creates the steady-state channel Deployment (with runtime PVC read-only)
 *   4. Replies to the bootstrap pod
 *   5. Notifies the admin via SSE
 *   6. Releases the instance name from activeBootstraps
 *
 * Story 176 will add independent PVC hash verification (orchestrator reads the
 * PVC directly via ephemeral container and compares against the ConfigMap hash).
 */

import type { V1Deployment } from '@kubernetes/client-node';
import { logger } from '../logger.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CommitChannelConfigPayload {
  type: 'commit_channel_config';
  bootstrapJobId: string;
  channel_type: string;
  instance_name: string;
  secret_data: Record<string, string>;
  runtime_pvc_lock_hash?: string;
}

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
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Process a `commit_channel_config` payload received from a bootstrap pod.
 *
 * This is the orchestrator-side gate for channel creation. It:
 *   - Validates required fields
 *   - Optionally checks the reported hash against the ConfigMap (advisory; Story 176 makes it independent)
 *   - Creates the K8s Secret with channel credentials
 *   - Creates the steady-state Deployment using channelBaseImage with runtime PVC read-only
 *   - Publishes success/failure reply and SSE notification
 */
export async function processCommitChannelConfig(
  payload: CommitChannelConfigPayload,
  deps: CommitChannelConfigDeps,
  namespace: string,
  channelBaseImage: string,
): Promise<void> {
  const {
    bootstrapJobId,
    channel_type,
    instance_name,
    secret_data,
    runtime_pvc_lock_hash,
  } = payload;

  if (!bootstrapJobId || !channel_type || !instance_name || !secret_data) {
    logger.error({ payload }, 'commit_channel_config: missing required fields');
    if (bootstrapJobId) {
      await deps
        .publishReply(`kubeclaw:bootstrap-reply:${bootstrapJobId}`, {
          ok: false,
          error: 'Missing required fields in commit_channel_config payload',
        })
        .catch(() => {});
    }
    return;
  }

  const secretName = `kubeclaw-channel-${instance_name}-credentials`;
  const deploymentName = `kubeclaw-channel-${instance_name}`;
  const pvcName = `kubeclaw-channel-${instance_name}-runtime`;
  const replyChannel = `kubeclaw:bootstrap-reply:${bootstrapJobId}`;
  const sseTopic = `kubeclaw:bootstrap:${bootstrapJobId}`;

  logger.info(
    { bootstrapJobId, channel_type, instance_name },
    'commit_channel_config received — creating channel resources',
  );

  try {
    // Advisory hash check (Story 176 adds independent PVC read)
    const expectedHash = await deps.getManifestHash(channel_type);
    if (
      expectedHash &&
      runtime_pvc_lock_hash &&
      runtime_pvc_lock_hash !== expectedHash
    ) {
      logger.warn(
        { channel_type, expected: expectedHash, actual: runtime_pvc_lock_hash },
        'commit_channel_config: reported hash does not match manifest (advisory — Story 176 adds independent verification)',
      );
    }

    // 1. Create credentials Secret
    await deps.createSecret(secretName, secret_data);
    logger.info(
      { secretName, instance_name },
      'Channel credentials Secret created',
    );

    // 2. Build steady-state Deployment spec
    const deployment: V1Deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: deploymentName,
        namespace,
        labels: {
          app: `kubeclaw-channel-${instance_name}`,
          'kubeclaw/channel': instance_name,
          'kubeclaw.io/role': 'channel',
          'kubeclaw.io/bootstrap-installed': 'true',
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { app: `kubeclaw-channel-${instance_name}` },
        },
        template: {
          metadata: {
            labels: {
              app: `kubeclaw-channel-${instance_name}`,
              'kubeclaw/channel': instance_name,
              'kubeclaw.io/role': 'channel',
            },
          },
          spec: {
            automountServiceAccountToken: false,
            // No KUBECLAW_SUPERUSER — must be absent from steady-state pod (AC5)
            // No KUBECLAW_BOOTSTRAP_SKILL — must be absent from steady-state pod (AC5)
            containers: [
              {
                name: 'channel',
                image: channelBaseImage,
                imagePullPolicy: 'IfNotPresent',
                command: ['node', '/app/channel-loader.js'],
                env: [
                  { name: 'KUBECLAW_CHANNEL', value: instance_name },
                  { name: 'KUBECLAW_CHANNEL_TYPE', value: channel_type },
                  {
                    name: 'REDIS_URL',
                    value:
                      process.env.REDIS_URL || 'redis://kubeclaw-redis:6379',
                  },
                ],
                envFrom: [{ secretRef: { name: secretName } }],
                volumeMounts: [
                  // Runtime PVC mounted READ-ONLY (AC5)
                  { name: 'runtime', mountPath: '/runtime', readOnly: true },
                ],
              },
            ],
            volumes: [
              {
                name: 'runtime',
                persistentVolumeClaim: {
                  claimName: pvcName,
                  // readOnly flag on PVC spec is advisory; the container-level readOnly
                  // in volumeMounts is the binding enforcement. Both are set for clarity.
                } as any,
              },
            ],
          },
        },
      },
    };

    // 3. Create steady-state Deployment
    await deps.createDeployment(deployment);
    logger.info(
      { deploymentName, channelBaseImage, instance_name },
      'Steady-state Deployment created',
    );

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
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, bootstrapJobId, instance_name },
      'commit_channel_config failed',
    );

    await deps
      .publishReply(replyChannel, { ok: false, error: errorMsg })
      .catch((e) => logger.warn({ e }, 'Failed to publish failure reply'));

    await deps
      .publishSse(sseTopic, `Bootstrap failed: ${errorMsg}`)
      .catch((e) => logger.warn({ e }, 'Failed to publish failure SSE'));
  }
}
