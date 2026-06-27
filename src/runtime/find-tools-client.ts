import crypto from 'node:crypto';
import {
  getRedisClient,
  getFindToolsStream,
  getFindToolsResultStream,
} from '../k8s/redis-client.js';
import type { FindToolsResult } from '../tool-selection/types.js';

const FIND_TOOLS_TIMEOUT_MS = 120_000;

export function formatFindToolsResult(json: string): string {
  let r: FindToolsResult;
  try {
    r = JSON.parse(json) as FindToolsResult;
  } catch {
    return 'Tool search failed: malformed result.';
  }
  if (r.status === 'ready') {
    const names = r.tools
      .map((t) => `${t.name} (${t.provenance}): ${t.description}`)
      .join('; ');
    return `status=ready. ${r.message} Now available: ${names}. Call the tool by name.`;
  }
  if (r.status === 'pending_credential') {
    return (
      `status=pending_credential. ${r.message} ` +
      `Ask the user to approve using the "${r.catalogId}" credential (host ${r.host}) for tool "${r.toolName}". ` +
      `If they agree, call approve_tool_credential with tool_name="${r.toolName}", catalog_id="${r.catalogId}", approval_token="${r.approvalToken}".`
    );
  }
  return `status=unavailable. ${r.message}`;
}

async function awaitFindToolsResult(requestId: string): Promise<string> {
  const redis = getRedisClient();
  const resultsStream = getFindToolsResultStream(requestId);
  const deadline = Date.now() + FIND_TOOLS_TIMEOUT_MS;
  let lastId = '0-0';
  while (Date.now() < deadline) {
    const blockMs = Math.min(deadline - Date.now(), 5000);
    const resp = await redis.xread(
      'COUNT',
      10,
      'BLOCK',
      blockMs,
      'STREAMS',
      resultsStream,
      lastId,
    );
    if (!resp) continue;
    for (const [, messages] of resp as [string, [string, string[]][]][]) {
      for (const [msgId, fields] of messages) {
        lastId = msgId;
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        if (obj.result) return formatFindToolsResult(obj.result);
      }
    }
  }
  return 'Tool search timed out.';
}

export async function requestFindTools(args: {
  groupFolder: string;
  channel: string;
  taskDescription: string;
}): Promise<string> {
  const requestId = crypto.randomUUID();
  await getRedisClient().xadd(
    getFindToolsStream(),
    '*',
    'requestId',
    requestId,
    'groupFolder',
    args.groupFolder,
    'channel',
    args.channel,
    'taskDescription',
    args.taskDescription,
  );
  return awaitFindToolsResult(requestId);
}

export async function requestCredentialApproval(args: {
  groupFolder: string;
  channel: string;
  toolName: string;
  catalogId: string;
  approvalToken: string;
}): Promise<string> {
  const requestId = crypto.randomUUID();
  await getRedisClient().xadd(
    getFindToolsStream(),
    '*',
    'requestId',
    requestId,
    'kind',
    'approve',
    'groupFolder',
    args.groupFolder,
    'channel',
    args.channel,
    'toolName',
    args.toolName,
    'catalogId',
    args.catalogId,
    'approvalToken',
    args.approvalToken,
  );
  return awaitFindToolsResult(requestId);
}
