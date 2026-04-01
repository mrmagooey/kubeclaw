/**
 * MCP Server Registry
 *
 * Manages the lifecycle of MCP server pods: deploy, remove, list.
 * Generates Kubernetes Deployment + Service YAML and applies via JobRunner.
 * Notifies channel pods of MCP config changes via Redis control channel.
 */

import { KUBECLAW_NAMESPACE } from './config.js';
import {
  getAllMcpServers,
  setMcpServer,
  deleteMcpServer as dbDeleteMcpServer,
} from './db.js';
import { jobRunner } from './k8s/job-runner.js';
import { getRedisClient, getControlChannel } from './k8s/redis-client.js';
import { logger } from './logger.js';
import type { McpServerSpec, McpServerStatus } from './types.js';

const DEFAULT_PORT = 3000;
const DEFAULT_PATH = '/mcp';

function deploymentName(name: string): string {
  return `kubeclaw-mcp-${name}`;
}

function buildYaml(spec: McpServerSpec): string {
  const name = deploymentName(spec.name);
  const port = spec.port ?? DEFAULT_PORT;
  const ns = KUBECLAW_NAMESPACE;

  const envBlock = spec.env
    ? Object.entries(spec.env)
        .map(([k, v]) => `            - name: ${k}\n              value: ${JSON.stringify(v)}`)
        .join('\n')
    : '';

  const commandBlock = spec.command
    ? `          command: ${JSON.stringify(spec.command)}`
    : '';

  const memReq = spec.resources?.memoryRequest ?? '128Mi';
  const memLim = spec.resources?.memoryLimit ?? '256Mi';
  const cpuReq = spec.resources?.cpuRequest ?? '50m';
  const cpuLim = spec.resources?.cpuLimit ?? '500m';

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
    kubeclaw-component: mcp-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
        kubeclaw-component: mcp-server
    spec:
      automountServiceAccountToken: false
      containers:
        - name: mcp-server
          image: ${spec.image}
${commandBlock ? commandBlock + '\n' : ''}          ports:
            - containerPort: ${port}
              name: mcp
          env:
${envBlock ? envBlock + '\n' : ''}          resources:
            requests:
              memory: ${memReq}
              cpu: ${cpuReq}
            limits:
              memory: ${memLim}
              cpu: ${cpuLim}
          readinessProbe:
            tcpSocket:
              port: ${port}
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: ${port}
            initialDelaySeconds: 10
            periodSeconds: 30
          securityContext:
            runAsUser: 1000
            runAsGroup: 1000
            runAsNonRoot: true
            allowPrivilegeEscalation: false
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
    kubeclaw-component: mcp-server
spec:
  type: ClusterIP
  selector:
    app: ${name}
  ports:
    - port: ${port}
      targetPort: mcp
      protocol: TCP
`;
}

function specToStatus(spec: McpServerSpec): McpServerStatus {
  const port = spec.port ?? DEFAULT_PORT;
  const urlPath = spec.path ?? DEFAULT_PATH;
  return {
    name: spec.name,
    url: `http://${deploymentName(spec.name)}:${port}${urlPath}`,
    allowedTools: spec.allowedTools,
  };
}

/**
 * Deploy an MCP server as a Kubernetes Deployment + Service.
 */
export async function deployMcpServer(spec: McpServerSpec): Promise<void> {
  const yaml = buildYaml(spec);
  await jobRunner.applyYamlToK8s(yaml);
  setMcpServer(spec);
  logger.info({ name: spec.name, image: spec.image }, 'MCP server deployed');
  await notifyAllChannels();
}

/**
 * Remove an MCP server's Deployment + Service and DB record.
 */
export async function removeMcpServer(name: string): Promise<void> {
  const depName = deploymentName(name);
  const ns = KUBECLAW_NAMESPACE;

  // Delete via K8s API - use applyYamlToK8s to create a zero-replica deployment
  // then delete. Actually, we need to delete directly.
  // Import K8s client from job-runner's exports isn't available, so we'll
  // create a minimal deployment with 0 replicas first, then the orchestrator
  // can clean up. For a proper delete, we use the jobRunner's K8s API.
  try {
    // Use the jobRunner to delete the resources by applying an empty spec
    // Actually, we need to use the K8s API directly for deletion.
    // The jobRunner exposes appsApi and coreApi indirectly through applyYamlToK8s.
    // For deletion, we'll need to add a method or use the client directly.
    await jobRunner.deleteDeployment(depName, ns);
    await jobRunner.deleteService(depName, ns);
  } catch (err) {
    logger.warn({ name, err }, 'Error deleting MCP server K8s resources (may already be gone)');
  }

  dbDeleteMcpServer(name);
  logger.info({ name }, 'MCP server removed');
  await notifyAllChannels();
}

/**
 * List all registered MCP servers.
 */
export function listMcpServers(): McpServerSpec[] {
  return getAllMcpServers();
}

/**
 * Get MCP server statuses filtered for a specific channel.
 */
export function getServersForChannel(channelName: string): McpServerStatus[] {
  const specs = getAllMcpServers();
  return specs
    .filter((s) => !s.channels?.length || s.channels.includes(channelName))
    .map(specToStatus);
}

/**
 * Notify all channel pods about their available MCP servers.
 */
export async function notifyAllChannels(): Promise<void> {
  const redis = getRedisClient();
  const specs = getAllMcpServers();

  // Gather unique channel names from specs
  const allChannels = new Set<string>();
  for (const spec of specs) {
    if (spec.channels?.length) {
      for (const ch of spec.channels) allChannels.add(ch);
    }
  }

  // If any server has no channel restriction, we need to notify all known channels.
  // We don't have a registry of all channel names, so we broadcast to any channel
  // that has at least one server, plus a wildcard set of common channels.
  const hasUnrestricted = specs.some((s) => !s.channels?.length);
  if (hasUnrestricted) {
    // Add common channel names - channel pods that don't exist will just ignore it
    for (const ch of ['http', 'telegram', 'discord', 'slack', 'whatsapp', 'irc', 'signal', 'gmail']) {
      allChannels.add(ch);
    }
  }

  for (const channelName of allChannels) {
    const servers = getServersForChannel(channelName);
    const msg = JSON.stringify({ command: 'mcp_update', servers: JSON.stringify(servers) });
    await redis.publish(getControlChannel(channelName), msg);
    logger.debug({ channel: channelName, serverCount: servers.length }, 'Published mcp_update');
  }
}

/**
 * Sync MCP servers from values.yaml config on startup.
 * Deploys any servers from config that aren't already in the DB.
 */
export async function syncFromValues(specs: McpServerSpec[]): Promise<void> {
  const existing = new Set(getAllMcpServers().map((s) => s.name));

  for (const spec of specs) {
    if (!existing.has(spec.name)) {
      logger.info({ name: spec.name }, 'Deploying MCP server from values.yaml');
      await deployMcpServer(spec);
    } else {
      // Update spec in DB (image/config may have changed)
      setMcpServer(spec);
      logger.debug({ name: spec.name }, 'Updated MCP server spec from values.yaml');
    }
  }
}
