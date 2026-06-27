export type Provenance = 'catalog' | 'library' | 'discovered';

export interface ToolCandidate {
  name: string;
  description: string;
  provenance: Provenance;
}

export interface FindToolsRequest {
  requestId: string;
  groupFolder: string;
  channel: string;
  taskDescription: string;
}

export type FindToolsResult =
  | { status: 'ready'; tools: ToolCandidate[]; message: string }
  | {
      status: 'pending_credential';
      toolName: string;
      catalogId: string;
      host: string;
      approvalToken: string;
      message: string;
    }
  | { status: 'unavailable'; message: string };

export interface AutoToolMeta {
  name: string;
  provenance: Provenance;
  scopeGroup: string | null;
  sourceDigest: string | null;
  acquiredAt: number;
  lastUsedAt: number;
  transcript: string | null;
}

export function isReadyResult(
  r: FindToolsResult,
): r is Extract<FindToolsResult, { status: 'ready' }> {
  return r.status === 'ready';
}
