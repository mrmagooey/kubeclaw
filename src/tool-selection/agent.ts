import type { ToolSpec } from '../tools/types.js';
import { registerTool } from '../skills/orchestrator/tool-registry.js';
import { matchTool, type ChatFn } from './matcher.js';
import {
  evaluateGate,
  mintApprovalToken,
  verifyApprovalToken,
} from './credential-gate.js';
import { recordAutoTool } from './provenance.js';
import type {
  FindToolsRequest,
  FindToolsResult,
  ToolCandidate,
} from './types.js';
import { logger } from '../logger.js';

const MIN_CONFIDENCE = 0.5;

export interface TsaDeps {
  chat: ChatFn;
  liveCatalog: () => ToolSpec[];
  library: () => ToolSpec[];
  catalogHostLookup: (id: string) => string | undefined;
  reconcile: () => Promise<void>;
  now: () => number;
  nonce: string;
  searchRegistry?: (task: string) => Promise<ToolSpec | null>;
}

function candidate(
  spec: ToolSpec,
  provenance: ToolCandidate['provenance'],
): ToolCandidate {
  return { name: spec.name, description: spec.description, provenance };
}

export async function runToolSelection(
  req: FindToolsRequest,
  deps: TsaDeps,
): Promise<FindToolsResult> {
  // Tier 1: live catalog.
  const live = deps.liveCatalog();
  const m1 = await matchTool(req.taskDescription, live, deps.chat);
  if (m1.name && m1.confidence >= MIN_CONFIDENCE) {
    const spec = live.find((s) => s.name === m1.name)!;
    return {
      status: 'ready',
      tools: [candidate(spec, 'catalog')],
      message: `Using existing tool ${spec.name}.`,
    };
  }

  // Tier 2: curated library.
  const lib = deps.library();
  const m2 = await matchTool(req.taskDescription, lib, deps.chat);
  if (m2.name && m2.confidence >= MIN_CONFIDENCE) {
    const spec = lib.find((s) => s.name === m2.name)!;
    const gate = evaluateGate(spec, deps.catalogHostLookup);
    if (gate.needsApproval) {
      // Do not offer approval for a credential the broker does not hold: if the
      // broker catalog lookup did not resolve a host for this credential id, no
      // amount of user approval can make the tool work.
      if (!gate.host) {
        return {
          status: 'unavailable',
          message: `Tool ${spec.name} needs a credential (${gate.catalogId}) that is not configured in the broker; an administrator must set it up.`,
        };
      }
      const token = mintApprovalToken(spec.name, gate.catalogId!, deps.nonce);
      return {
        status: 'pending_credential',
        toolName: spec.name,
        catalogId: gate.catalogId!,
        host: gate.host,
        approvalToken: token,
        message: `Tool ${spec.name} needs your ${gate.catalogId} credential. Approve to enable it.`,
      };
    }
    const reg = registerTool(spec, undefined, deps.catalogHostLookup);
    if (!reg.ok)
      return {
        status: 'unavailable',
        message: `Could not register ${spec.name}: ${reg.error}`,
      };
    await deps.reconcile();
    recordAutoTool({
      name: spec.name,
      provenance: 'library',
      scopeGroup: null,
      now: deps.now(),
    });
    return {
      status: 'ready',
      tools: [candidate(spec, 'library')],
      message: `Activated ${spec.name} from the library.`,
    };
  }

  // Tier 3: open discovery (Phase 3 injects searchRegistry).
  if (deps.searchRegistry) {
    try {
      const discovered = await deps.searchRegistry(req.taskDescription);
      if (discovered) {
        const scoped: ToolSpec = { ...discovered, channels: [req.channel] };
        const gate = evaluateGate(scoped, deps.catalogHostLookup);
        if (gate.needsApproval) {
          if (!gate.host) {
            return {
              status: 'unavailable',
              message: `Discovered tool ${scoped.name} needs a credential (${gate.catalogId}) that is not configured in the broker; an administrator must set it up.`,
            };
          }
          const token = mintApprovalToken(scoped.name, gate.catalogId!, deps.nonce);
          return {
            status: 'pending_credential',
            toolName: scoped.name,
            catalogId: gate.catalogId!,
            host: gate.host,
            approvalToken: token,
            message: `Discovered tool ${scoped.name} needs your ${gate.catalogId} credential. Approve to enable it.`,
          };
        }
        const reg = registerTool(scoped, undefined, deps.catalogHostLookup);
        if (!reg.ok)
          return {
            status: 'unavailable',
            message: `Could not register discovered ${scoped.name}: ${reg.error}`,
          };
        await deps.reconcile();
        recordAutoTool({
          name: scoped.name,
          provenance: 'discovered',
          scopeGroup: req.groupFolder,
          sourceDigest: scoped.image.split('@')[1] ?? null,
          now: deps.now(),
        });
        return {
          status: 'ready',
          tools: [candidate(scoped, 'discovered')],
          message: `Discovered and enabled ${scoped.name} (this group only).`,
        };
      }
    } catch (err) {
      logger.warn(
        { err, requestId: req.requestId },
        'registry discovery failed',
      );
    }
  }

  return { status: 'unavailable', message: 'No suitable tool found.' };
}

export interface ApprovalDeps {
  library: () => ToolSpec[];
  catalogHostLookup: (id: string) => string | undefined;
  reconcile: () => Promise<void>;
  now: () => number;
  nonce: string;
}

export async function finalizeCredentialApproval(
  args: { toolName: string; catalogId: string; approvalToken: string },
  deps: ApprovalDeps,
): Promise<FindToolsResult> {
  if (
    !verifyApprovalToken(
      args.approvalToken,
      args.toolName,
      args.catalogId,
      deps.nonce,
    )
  ) {
    return { status: 'unavailable', message: 'Invalid or expired approval.' };
  }
  // NOTE: credentialed *discovered* tools cannot be finalized here — they are not
  // in library() and the approve message can't reconstruct the drafted spec.
  // Completing them needs a pending-discovered-spec store (future work; see Phase 3 plan Task 7).
  const spec = deps.library().find((s) => s.name === args.toolName);
  if (!spec)
    return {
      status: 'unavailable',
      message: `Tool ${args.toolName} no longer available.`,
    };
  const reg = registerTool(spec, undefined, deps.catalogHostLookup);
  if (!reg.ok)
    return {
      status: 'unavailable',
      message: `Could not register ${spec.name}: ${reg.error}`,
    };
  await deps.reconcile();
  recordAutoTool({
    name: spec.name,
    provenance: 'library',
    scopeGroup: null,
    now: deps.now(),
  });
  return {
    status: 'ready',
    tools: [candidate(spec, 'library')],
    message: `Enabled ${spec.name}.`,
  };
}
