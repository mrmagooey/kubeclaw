/**
 * Step: verify — End-to-end health check for Kubernetes deployment.
 * Replaces 09-verify.sh
 *
 * Kubernetes-only: checks orchestrator deployment, Redis pod, K8s Secrets,
 * channel auth, registered groups, and mount allowlist.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

// Helper to get a value from K8s Secret
function getK8sSecretValue(key: string): string | undefined {
  // Validate key against allowlist to prevent command injection
  if (!/^[A-Z0-9_]+$/.test(key)) {
    logger.warn({ key }, 'Invalid K8s secret key name — skipping');
    return undefined;
  }
  try {
    const output = execSync(
      `kubectl get secret nanoclaw-secrets -n nanoclaw -o jsonpath={.data.${key}}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const encoded = output.trim();
    if (!encoded) return undefined;
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8').trim();
    return decoded || undefined;
  } catch {
    return undefined;
  }
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const homeDir = os.homedir();

  logger.info('Starting verification');

  // 1. Check Kubernetes orchestrator deployment
  let orchestrator:
    | 'running'
    | 'deployed_not_ready'
    | 'not_deployed'
    | 'not_found' = 'not_found';
  try {
    const output = execSync(
      'kubectl get deployment nanoclaw-orchestrator -n nanoclaw -o jsonpath={.status.readyReplicas}',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const readyReplicas = parseInt(output.trim(), 10);
    if (!isNaN(readyReplicas) && readyReplicas > 0) {
      orchestrator = 'running';
    } else {
      orchestrator = 'deployed_not_ready';
    }
  } catch (error: unknown) {
    // Check if the error is because deployment doesn't exist vs kubectl not available
    try {
      execSync('kubectl get deployment nanoclaw-orchestrator -n nanoclaw', {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Deployment exists but readyReplicas check failed
      orchestrator = 'deployed_not_ready';
    } catch {
      // Check if kubectl is available
      try {
        execSync('kubectl version', { stdio: 'ignore' });
        orchestrator = 'not_deployed';
      } catch {
        orchestrator = 'not_found';
      }
    }
  }
  logger.info({ orchestrator }, 'Orchestrator status');

  // 2. Check Redis pod readiness
  let redis: 'running' | 'not_ready' | 'not_found' = 'not_found';
  try {
    const output = execSync(
      'kubectl get pods -n nanoclaw -l app=nanoclaw-redis -o jsonpath={.items[0].status.phase}',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const phase = output.trim();
    if (phase === 'Running') {
      redis = 'running';
    } else if (phase) {
      redis = 'not_ready';
    }
  } catch {
    redis = 'not_found';
  }
  logger.info({ redis }, 'Redis status');

  // 3. Check Kubernetes Secrets for credentials
  let credentials: 'configured' | 'missing' = 'missing';
  try {
    execSync('kubectl get secret nanoclaw-secrets -n nanoclaw', {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    credentials = 'configured';
  } catch {
    credentials = 'missing';
  }
  logger.info({ credentials }, 'Credentials status');

  // 4. Check channel auth (detect configured channels by credentials)
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
  ]);

  const channelAuth: Record<string, string> = {};

  // WhatsApp: check for auth credentials on disk
  const authDir = path.join(projectRoot, 'store', 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    channelAuth.whatsapp = 'authenticated';
  }

  // Token-based channels: check .env and K8s Secrets as fallback
  const telegramToken =
    process.env.TELEGRAM_BOT_TOKEN ||
    envVars.TELEGRAM_BOT_TOKEN ||
    getK8sSecretValue('TELEGRAM_BOT_TOKEN');
  if (telegramToken) {
    channelAuth.telegram = 'configured';
  }

  const slackBotToken =
    process.env.SLACK_BOT_TOKEN ||
    envVars.SLACK_BOT_TOKEN ||
    getK8sSecretValue('SLACK_BOT_TOKEN');
  const slackAppToken =
    process.env.SLACK_APP_TOKEN ||
    envVars.SLACK_APP_TOKEN ||
    getK8sSecretValue('SLACK_APP_TOKEN');
  if (slackBotToken && slackAppToken) {
    channelAuth.slack = 'configured';
  }

  const discordToken =
    process.env.DISCORD_BOT_TOKEN ||
    envVars.DISCORD_BOT_TOKEN ||
    getK8sSecretValue('DISCORD_BOT_TOKEN');
  if (discordToken) {
    channelAuth.discord = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const anyChannelConfigured = configuredChannels.length > 0;

  // 5. Check registered groups (using better-sqlite3, not sqlite3 CLI)
  let registeredGroups = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_groups')
        .get() as { count: number };
      registeredGroups = row.count;
      db.close();
    } catch {
      // Table might not exist
    }
  }

  // 6. Check mount allowlist
  let mountAllowlist: 'configured' | 'missing' = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  // Determine overall status
  const status: 'success' | 'failed' =
    orchestrator === 'running' &&
    redis === 'running' &&
    credentials === 'configured' &&
    anyChannelConfigured &&
    registeredGroups > 0
      ? 'success'
      : 'failed';

  logger.info({ status, channelAuth }, 'Verification complete');

  emitStatus('VERIFY', {
    ORCHESTRATOR: orchestrator,
    REDIS: redis,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: mountAllowlist,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
