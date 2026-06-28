import { describe, it, expect, beforeEach } from 'vitest';
import { runToolSelection, type TsaDeps } from './agent.js';
import { _initTestDatabase, __resetDbForTest } from '../db.js';
import { getAutoTool } from './provenance.js';
import { getPendingDiscovered } from './pending-discovered.js';
import type { ToolSpec } from '../tools/types.js';

const exif: ToolSpec = {
  name: 'extract_metadata',
  description: 'Extract EXIF metadata from an image',
  parameters: {},
  image: 'kubeclaw/exiftool:latest',
  pattern: 'file',
  mount: 'group',
};
const imageSearch: ToolSpec = {
  name: 'image_search',
  description: 'Search the web for images',
  parameters: {},
  image: 'kubeclaw/image-search:latest',
  pattern: 'http',
  credentials: ['brave-search'],
  allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
};

function deps(over: Partial<TsaDeps> = {}): TsaDeps {
  return {
    chat: async () =>
      JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
    liveCatalog: () => [],
    library: () => [],
    catalogHostLookup: (id) =>
      id === 'brave-search' ? 'api.search.brave.com' : undefined,
    reconcile: async () => {},
    now: () => 1000,
    nonce: 'n',
    ...over,
  };
}

describe('runToolSelection', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('returns ready from the live catalog without registering', async () => {
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'exif',
      },
      deps({
        liveCatalog: () => [exif],
        chat: async () =>
          JSON.stringify({
            name: 'extract_metadata',
            confidence: 0.9,
            reason: 'ok',
          }),
      }),
    );
    expect(r.status).toBe('ready');
    expect(getAutoTool('extract_metadata')).toBeUndefined();
  });

  it('falls through to the library when the catalog match is low-confidence', async () => {
    // matchTool is called once per tier (catalog then library). The first
    // (catalog) call names the tool but at confidence 0.3 (< MIN_CONFIDENCE),
    // so it must fall through; the second (library) call confidently matches
    // the same credential-free tool, which should then be activated.
    let call = 0;
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'exif',
      },
      deps({
        liveCatalog: () => [exif],
        library: () => [exif],
        chat: async () => {
          call += 1;
          return JSON.stringify({
            name: 'extract_metadata',
            confidence: call === 1 ? 0.3 : 0.9,
            reason: 'match',
          });
        },
      }),
    );
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.tools[0].provenance).toBe('library');
    }
    expect(getAutoTool('extract_metadata')?.provenance).toBe('library');
  });

  it('activates a credential-free library tool and records provenance=library', async () => {
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'exif',
      },
      deps({
        library: () => [exif],
        chat: async () =>
          JSON.stringify({
            name: 'extract_metadata',
            confidence: 0.9,
            reason: 'ok',
          }),
      }),
    );
    expect(r.status).toBe('ready');
    expect(getAutoTool('extract_metadata')?.provenance).toBe('library');
  });

  it('returns pending_credential (and does NOT register) for a credentialed library tool', async () => {
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'image',
      },
      deps({
        library: () => [imageSearch],
        chat: async () =>
          JSON.stringify({
            name: 'image_search',
            confidence: 0.9,
            reason: 'ok',
          }),
      }),
    );
    expect(r.status).toBe('pending_credential');
    if (r.status === 'pending_credential') {
      expect(r.catalogId).toBe('brave-search');
      expect(r.host).toBe('api.search.brave.com');
      expect(r.approvalToken).toBeTruthy();
    }
    expect(getAutoTool('image_search')).toBeUndefined();
  });

  it('returns unavailable (not pending_credential) when the credential is not in the broker', async () => {
    const unknownCred: ToolSpec = {
      name: 'mystery_tool',
      description: 'Needs a credential the broker does not hold',
      parameters: {},
      image: 'kubeclaw/mystery:latest',
      pattern: 'http',
      credentials: ['unknown-cred'],
    };
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'mystery',
      },
      deps({
        library: () => [unknownCred],
        // Broker lookup resolves nothing for 'unknown-cred'.
        catalogHostLookup: () => undefined,
        chat: async () =>
          JSON.stringify({
            name: 'mystery_tool',
            confidence: 0.9,
            reason: 'ok',
          }),
      }),
    );
    expect(r.status).toBe('unavailable');
    expect(getAutoTool('mystery_tool')).toBeUndefined();
  });

  it('returns unavailable when nothing matches', async () => {
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'g',
        channel: 'http',
        taskDescription: 'xyz',
      },
      deps(),
    );
    expect(r.status).toBe('unavailable');
  });
});

import { finalizeCredentialApproval } from './agent.js';
import { mintApprovalToken } from './credential-gate.js';
import { putPendingDiscovered } from './pending-discovered.js';

describe('finalizeCredentialApproval — library path', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('registers the credentialed tool when the token is valid', async () => {
    const token = mintApprovalToken('image_search', 'brave-search', 'n', 1);
    const r = await finalizeCredentialApproval(
      {
        toolName: 'image_search',
        catalogId: 'brave-search',
        approvalToken: token,
      },
      {
        library: () => [imageSearch],
        catalogHostLookup: () => 'api.search.brave.com',
        reconcile: async () => {},
        now: () => 1,
        nonce: 'n',
      },
    );
    expect(r.status).toBe('ready');
    expect(getAutoTool('image_search')?.provenance).toBe('library');
  });

  it('rejects an invalid token without registering', async () => {
    const r = await finalizeCredentialApproval(
      {
        toolName: 'image_search',
        catalogId: 'brave-search',
        approvalToken: 'bad',
      },
      {
        library: () => [imageSearch],
        catalogHostLookup: () => 'api.search.brave.com',
        reconcile: async () => {},
        now: () => 1,
        nonce: 'n',
      },
    );
    expect(r.status).toBe('unavailable');
    expect(getAutoTool('image_search')).toBeUndefined();
  });
});

describe('finalizeCredentialApproval — discovered path (end-to-end)', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  const discoveredSpec: ToolSpec = {
    name: 'smart_search',
    description: 'Web search via brave',
    parameters: {},
    image: 'kubeclaw/smart-search:latest@sha256:abc123def',
    pattern: 'http',
    credentials: ['brave-search'],
    allowedEgress: [{ host: 'api.search.brave.com', ports: [443] }],
    channels: ['http'],
  };

  it('drive end-to-end: pending_credential → finalise → ready with provenance=discovered', async () => {
    // R1: runToolSelection returns pending_credential AND persists the draft.
    const r1 = await runToolSelection(
      {
        requestId: 'r1',
        groupFolder: 'team-a',
        channel: 'http',
        taskDescription: 'search the web',
      },
      deps({
        liveCatalog: () => [],
        library: () => [],
        chat: async () =>
          JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
        searchRegistry: async () => discoveredSpec,
        catalogHostLookup: (id) =>
          id === 'brave-search' ? 'api.search.brave.com' : undefined,
        now: () => 1000,
        nonce: 'n',
      }),
    );
    expect(r1.status).toBe('pending_credential');

    const pending = getPendingDiscovered('smart_search');
    expect(pending).toBeDefined();
    expect(pending!.scopeGroup).toBe('team-a');

    // R2: finaliseCredentialApproval looks up the pending row and registers it.
    const token = (r1 as { approvalToken: string }).approvalToken;
    const r2 = await finalizeCredentialApproval(
      {
        toolName: 'smart_search',
        catalogId: 'brave-search',
        approvalToken: token,
      },
      {
        library: () => [], // library is empty — must come from pending-discovered
        catalogHostLookup: (id) =>
          id === 'brave-search' ? 'api.search.brave.com' : undefined,
        reconcile: async () => {},
        now: () => 2000,
        nonce: 'n',
      },
    );
    expect(r2.status).toBe('ready');
    if (r2.status === 'ready') {
      expect(r2.tools[0].provenance).toBe('discovered');
      expect(r2.tools[0].name).toBe('smart_search');
    }
    const meta = getAutoTool('smart_search');
    expect(meta?.provenance).toBe('discovered');
    expect(meta?.scopeGroup).toBe('team-a');
    // Pending row must be deleted after successful finalization.
    expect(getPendingDiscovered('smart_search')).toBeUndefined();
  });

  it('falls through to library when no pending-discovered row exists', async () => {
    // Seed only the library, no pending-discovered row.
    const token = mintApprovalToken('image_search', 'brave-search', 'n', 1);
    const r = await finalizeCredentialApproval(
      {
        toolName: 'image_search',
        catalogId: 'brave-search',
        approvalToken: token,
      },
      {
        library: () => [imageSearch],
        catalogHostLookup: () => 'api.search.brave.com',
        reconcile: async () => {},
        now: () => 1,
        nonce: 'n',
      },
    );
    expect(r.status).toBe('ready');
    expect(getAutoTool('image_search')?.provenance).toBe('library');
  });

  it('registers pending-discovered spec directly (seed via putPendingDiscovered)', async () => {
    putPendingDiscovered({
      name: 'smart_search',
      spec: discoveredSpec,
      scopeGroup: 'team-b',
      catalogId: 'brave-search',
      now: 1000,
    });

    const token = mintApprovalToken('smart_search', 'brave-search', 'n', 2000);
    const r = await finalizeCredentialApproval(
      {
        toolName: 'smart_search',
        catalogId: 'brave-search',
        approvalToken: token,
      },
      {
        library: () => [],
        catalogHostLookup: (id) =>
          id === 'brave-search' ? 'api.search.brave.com' : undefined,
        reconcile: async () => {},
        now: () => 2000,
        nonce: 'n',
      },
    );
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.tools[0].provenance).toBe('discovered');
    }
    const meta = getAutoTool('smart_search');
    expect(meta?.provenance).toBe('discovered');
    expect(meta?.scopeGroup).toBe('team-b');
    expect(getPendingDiscovered('smart_search')).toBeUndefined();
  });

  it('does NOT register the pending spec when catalogId mismatches the approval', async () => {
    // Seed a pending-discovered row for smart_search with catalogId='google-maps'.
    const googleMapsSpec: ToolSpec = {
      name: 'smart_search',
      description: 'Maps search via Google',
      parameters: {},
      image: 'kubeclaw/google-maps:latest@sha256:aabbcc',
      pattern: 'http',
      credentials: ['google-maps'],
      allowedEgress: [{ host: 'maps.googleapis.com', ports: [443] }],
      channels: ['http'],
    };
    putPendingDiscovered({
      name: 'smart_search',
      spec: googleMapsSpec,
      scopeGroup: 'team-a',
      catalogId: 'google-maps',
      now: 1000,
    });

    // Approve with a VALID token for brave-search (different catalogId).
    const token = mintApprovalToken('smart_search', 'brave-search', 'n', 1000);
    const r = await finalizeCredentialApproval(
      {
        toolName: 'smart_search',
        catalogId: 'brave-search',
        approvalToken: token,
      },
      {
        library: () => [], // empty library — falls through to unavailable
        catalogHostLookup: (id) =>
          id === 'brave-search' ? 'api.search.brave.com' : undefined,
        reconcile: async () => {},
        now: () => 1000,
        nonce: 'n',
      },
    );
    // The google-maps spec must NOT be registered.
    expect(getAutoTool('smart_search')).toBeUndefined();
    // Falls through to an empty library → unavailable.
    expect(r.status).toBe('unavailable');
  });
});

describe('runToolSelection tier-3', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('registers a discovered credential-free tool group-scoped with provenance=discovered', async () => {
    const discovered: ToolSpec = {
      name: 'extract_metadata',
      description: 'EXIF',
      parameters: { type: 'object' },
      image: 'r@sha256:abc',
      pattern: 'file',
      mount: 'group',
      allowedEgress: [],
    };
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'team-a',
        channel: 'http',
        taskDescription: 'exif',
      },
      deps({
        liveCatalog: () => [],
        library: () => [],
        chat: async () =>
          JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
        searchRegistry: async () => discovered,
      }),
    );
    expect(r.status).toBe('ready');
    const meta = getAutoTool('extract_metadata');
    expect(meta?.provenance).toBe('discovered');
    expect(meta?.scopeGroup).toBe('team-a');
  });

  it('returns pending_credential (and does NOT register) for a credentialed discovered tool', async () => {
    const discoveredCredentialed: ToolSpec = {
      name: 'smart_search',
      description: 'Web search via brave',
      parameters: {},
      image: 'kubeclaw/smart-search:latest@sha256:def',
      pattern: 'http',
      credentials: ['brave-search'],
      allowedEgress: [{ host: 'api.search.brave.com' }],
    };
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'team-a',
        channel: 'http',
        taskDescription: 'search',
      },
      deps({
        liveCatalog: () => [],
        library: () => [],
        chat: async () =>
          JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
        searchRegistry: async () => discoveredCredentialed,
      }),
    );
    expect(r.status).toBe('pending_credential');
    if (r.status === 'pending_credential') {
      expect(r.catalogId).toBe('brave-search');
      expect(r.approvalToken).toBeTruthy();
    }
    expect(getAutoTool('smart_search')).toBeUndefined();
  });

  it('persists pending-discovered spec when returning pending_credential', async () => {
    const discoveredCredentialed: ToolSpec = {
      name: 'smart_search',
      description: 'Web search via brave',
      parameters: {},
      image: 'kubeclaw/smart-search:latest@sha256:def',
      pattern: 'http',
      credentials: ['brave-search'],
      allowedEgress: [{ host: 'api.search.brave.com' }],
    };
    const r = await runToolSelection(
      {
        requestId: 'r',
        groupFolder: 'team-a',
        channel: 'http',
        taskDescription: 'search',
      },
      deps({
        liveCatalog: () => [],
        library: () => [],
        chat: async () =>
          JSON.stringify({ name: null, confidence: 0, reason: 'no' }),
        searchRegistry: async () => discoveredCredentialed,
      }),
    );
    expect(r.status).toBe('pending_credential');
    // Pending-discovered row must exist with the scoped spec.
    const pending = getPendingDiscovered('smart_search');
    expect(pending).toBeDefined();
    expect(pending!.scopeGroup).toBe('team-a');
    expect(pending!.catalogId).toBe('brave-search');
    expect(pending!.spec.channels).toContain('http');
  });
});
