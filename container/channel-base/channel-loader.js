/**
 * KubeClaw channel-base entrypoint — channel-loader.js
 *
 * Branches on KUBECLAW_BOOTSTRAP_SKILL:
 *   Set     → Bootstrap mode: run agent loop with commit_channel_config tool
 *   Not set → Steady-state mode: load /runtime/channel-entry.js from PVC
 *
 * This file uses CommonJS-compatible dynamic imports so it works with
 * the ESM packages in node_modules without requiring a build step.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BOOTSTRAP_SKILL = process.env.KUBECLAW_BOOTSTRAP_SKILL;
const BOOTSTRAP_JOB_ID = process.env.KUBECLAW_BOOTSTRAP_JOB_ID;
const BOOTSTRAP_INSTANCE = process.env.KUBECLAW_BOOTSTRAP_INSTANCE;
const BOOTSTRAP_CHANNEL_TYPE = process.env.KUBECLAW_BOOTSTRAP_CHANNEL_TYPE;
const REDIS_URL = process.env.REDIS_URL || 'redis://kubeclaw-redis:6379';
const REDIS_USERNAME = process.env.REDIS_USERNAME;
const REDIS_ADMIN_PASSWORD = process.env.REDIS_ADMIN_PASSWORD;

function log(msg) {
  process.stderr.write(`[channel-loader] ${msg}\n`);
}

function buildRedisUrl(base, username, password) {
  if (!password) return base;
  if (base.includes('@')) return base;
  const userPart = username ? encodeURIComponent(username) : '';
  return base.replace(/^(redis:\/\/)/, `$1${userPart}:${encodeURIComponent(password)}@`);
}

async function connectRedis() {
  const { createClient } = await import('redis');
  const url = buildRedisUrl(REDIS_URL, REDIS_USERNAME, REDIS_ADMIN_PASSWORD);
  const client = createClient({ url });
  client.on('error', (err) => log(`Redis error: ${err.message}`));
  await client.connect();
  return client;
}

async function runBootstrapMode() {
  log(`Bootstrap mode: skill=${BOOTSTRAP_SKILL}, instance=${BOOTSTRAP_INSTANCE}, type=${BOOTSTRAP_CHANNEL_TYPE}, jobId=${BOOTSTRAP_JOB_ID}`);

  if (!BOOTSTRAP_SKILL || !BOOTSTRAP_JOB_ID || !BOOTSTRAP_INSTANCE) {
    log('ERROR: KUBECLAW_BOOTSTRAP_SKILL, KUBECLAW_BOOTSTRAP_JOB_ID, KUBECLAW_BOOTSTRAP_INSTANCE are required');
    process.exit(1);
  }

  const skillPath = `/workspace/skills/${BOOTSTRAP_SKILL}.md`;
  if (!existsSync(skillPath)) {
    log(`ERROR: Skill file not found: ${skillPath}`);
    process.exit(1);
  }
  const skillMarkdown = readFileSync(skillPath, 'utf-8');

  const redis = await connectRedis();
  const bootstrapTopic = `kubeclaw:bootstrap:${BOOTSTRAP_JOB_ID}`;
  const taskChannel = `kubeclaw:bootstrap-task:${BOOTSTRAP_JOB_ID}`;
  const replyChannel = `kubeclaw:bootstrap-reply:${BOOTSTRAP_JOB_ID}`;

  async function publishToAdmin(text) {
    try {
      await redis.publish(bootstrapTopic, JSON.stringify({ type: 'agent', text }));
    } catch (err) {
      log(`Warning: failed to publish to admin: ${err.message}`);
    }
  }

  await publishToAdmin(
    `Bootstrap started for channel ${BOOTSTRAP_CHANNEL_TYPE}/${BOOTSTRAP_INSTANCE}. Loading skill: ${BOOTSTRAP_SKILL}`,
  );

  // Import pi-agent-core
  const { Agent } = await import('@mariozechner/pi-agent-core');
  const piAi = await import('@mariozechner/pi-ai');
  const { Type } = piAi;

  // commit_channel_config tool — sends to orchestrator, waits for reply
  const commitTool = {
    name: 'commit_channel_config',
    description:
      'Hand off the configured channel to the orchestrator. Call this after all credentials are gathered and validated, and after npm ci has completed successfully.',
    parameters: Type.Object({
      channel_type: Type.String({ description: 'The channel type (e.g. "telegram")' }),
      instance_name: Type.String({ description: 'The instance name' }),
      secret_data: Type.Record(Type.String(), Type.String(), {
        description: 'Credential key-value pairs to store in a K8s Secret',
      }),
      runtime_pvc_lock_hash: Type.String({
        description: 'sha256 of package-lock.json after npm ci (advisory; orchestrator independently verifies)',
      }),
    }),
    execute: async (args) => {
      log(`commit_channel_config called for ${args.channel_type}/${args.instance_name}`);
      await publishToAdmin(
        `Requesting hand-off for ${args.channel_type}/${args.instance_name}...`,
      );

      try {
        await redis.publish(
          taskChannel,
          JSON.stringify({
            type: 'commit_channel_config',
            bootstrapJobId: BOOTSTRAP_JOB_ID,
            channel_type: args.channel_type,
            instance_name: args.instance_name,
            secret_data: args.secret_data,
            runtime_pvc_lock_hash: args.runtime_pvc_lock_hash,
          }),
        );

        return await waitForCommitReply();
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  };

  function waitForCommitReply(timeoutMs = 60_000) {
    return new Promise((resolve) => {
      let resolved = false;

      const sub = redis.duplicate();
      sub.connect().then(() => {
        sub.subscribe(replyChannel, (msg) => {
          if (resolved) return;
          resolved = true;
          const data = JSON.parse(msg);
          sub.unsubscribe(replyChannel).catch(() => {});
          sub.quit().catch(() => {});
          if (data.ok) {
            resolve(`Channel ${BOOTSTRAP_CHANNEL_TYPE}/${BOOTSTRAP_INSTANCE} is ready. Bootstrap complete.`);
          } else {
            resolve(`Error from orchestrator: ${data.error}`);
          }
        });
      });

      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        sub.unsubscribe(replyChannel).catch(() => {});
        sub.quit().catch(() => {});
        resolve('Timeout waiting for orchestrator reply (60s).');
      }, timeoutMs);
    });
  }

  // System prompt from skill markdown
  const systemPrompt = [
    skillMarkdown,
    '',
    `## Bootstrap context`,
    `Channel type: ${BOOTSTRAP_CHANNEL_TYPE}`,
    `Instance name: ${BOOTSTRAP_INSTANCE}`,
    `Bootstrap job ID: ${BOOTSTRAP_JOB_ID}`,
    '',
    `## Mounted paths`,
    `  /workspace/skills/  — skill files`,
    `  /workspace/manifests/ — channel manifests (package.json + package-lock.json per type)`,
    `  /runtime — writable runtime PVC (install npm packages here with npm ci)`,
    '',
    `## Required npm install command`,
    `  local_bash("cp /workspace/manifests/${BOOTSTRAP_CHANNEL_TYPE}/package.json /workspace/manifests/${BOOTSTRAP_CHANNEL_TYPE}/package-lock.json /runtime/ && cd /runtime && npm ci --omit=dev --ignore-scripts 2>&1")`,
    '',
    `When all credentials are gathered, validated, and npm ci has succeeded, call commit_channel_config.`,
  ].join('\n');

  const model = process.env.DIRECT_LLM_MODEL || 'gpt-4o-mini';
  const apiKey = process.env.OPENAI_API_KEY || 'no-key';
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  // local_bash tool (KUBECLAW_SUPERUSER=true allows this)
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const localBashTool = {
    name: 'local_bash',
    description: 'Run a bash command in the bootstrap container. Use for npm ci, credential validation, file operations.',
    parameters: Type.Object({
      command: Type.String({ description: 'Bash command to run' }),
    }),
    execute: async (args) => {
      try {
        const { stdout, stderr } = await execFileAsync('bash', ['-c', args.command], {
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        });
        return (stdout + stderr).trim() || '(no output)';
      } catch (err) {
        return `Error (exit ${err.code}): ${err.stderr || err.message}`;
      }
    },
  };

  const api = Type.openai({ apiKey, baseUrl });

  const agent = new Agent({
    model: { api, model },
    systemPrompt,
    tools: [commitTool, localBashTool],
  });

  const initialPrompt = `Please set up the ${BOOTSTRAP_CHANNEL_TYPE} channel for instance "${BOOTSTRAP_INSTANCE}". Follow the skill instructions: first install npm packages, then gather required credentials, validate them, and call commit_channel_config.`;

  // Run the agent loop, publishing output to admin SSE
  for await (const event of agent.run(initialPrompt)) {
    if (event.type === 'assistantMessage') {
      const text = event.message.content
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (text) await publishToAdmin(text);
    }
  }

  await redis.quit();
  log('Bootstrap agent loop complete');
}

async function runSteadyStateMode() {
  log('Steady-state mode: loading /runtime/channel-entry.js');
  const entryPath = '/runtime/channel-entry.js';
  if (!existsSync(entryPath)) {
    log(`ERROR: ${entryPath} not found. Has the channel been bootstrapped?`);
    process.exit(1);
  }
  await import(entryPath);
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (BOOTSTRAP_SKILL) {
  runBootstrapMode().catch((err) => {
    log(`Fatal error in bootstrap mode: ${err.stack || err.message}`);
    process.exit(1);
  });
} else {
  runSteadyStateMode().catch((err) => {
    log(`Fatal error in steady-state mode: ${err.stack || err.message}`);
    process.exit(1);
  });
}
