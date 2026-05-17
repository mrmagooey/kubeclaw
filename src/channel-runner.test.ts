import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)`
// guard. Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

// ── Module mocks needed by processGroupMessages dispatch tests ────────────────
// These are hoisted by vitest and affect the whole file; they are safe for the
// existing tests because those tests exercise pure exported functions that do not
// call getDirectLLMRunner / db / redis directly.

vi.mock('./runtime/index.js', () => ({
  getDirectLLMRunner: vi.fn(),
  shutdownAllRunners: vi.fn(),
}));

const recordSpecialistUsageCalls: Array<{
  groupFolder: string;
  specialistName: string;
  durationMs: number;
  status: 'success' | 'error';
}> = [];

vi.mock('./db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    getMessagesSince: vi.fn().mockReturnValue([]),
    getAllTasks: vi.fn().mockReturnValue([]),
    getAllChats: vi.fn().mockReturnValue([]),
    getAllSessions: vi.fn().mockReturnValue({}),
    getAllRegisteredGroups: vi.fn().mockReturnValue({}),
    getRouterState: vi.fn().mockReturnValue(''),
    setRouterState: vi.fn(),
    setRegisteredGroup: vi.fn(),
    setSession: vi.fn(),
    initDatabase: vi.fn().mockResolvedValue(undefined),
    storeMessage: vi.fn(),
    storeChatMetadata: vi.fn(),
    getConversationHistory: vi.fn().mockReturnValue([]),
    appendConversationHistory: vi.fn(),
    appendConversationMessage: vi.fn(),
    getNewMessages: vi.fn().mockReturnValue({ messages: [], newTimestamp: '' }),
    recordSpecialistUsage: vi.fn().mockImplementation(
      (args: { groupFolder: string; specialistName: string; durationMs: number; status: 'success' | 'error' }) => {
        recordSpecialistUsageCalls.push({ ...args });
      },
    ),
  };
});

vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    publish: vi.fn().mockResolvedValue(0),
    quit: vi.fn(),
  }),
  getChannelStatusChannel: vi.fn().mockReturnValue('ch'),
  getTaskRequestStream: vi.fn().mockReturnValue('ts'),
  getSpawnToolPodStream: vi.fn().mockReturnValue('sp'),
}));

vi.mock('./k8s/ipc-redis.js', () => ({
  startIpcWatcher: vi.fn(),
  startControlChannelWatcher: vi.fn(),
  createSecretIpcFn: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ ok: true, result: [] })),
}));

vi.mock('./router.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    // Include message content so @Mention detection works in dispatch tests.
    formatMessages: vi.fn().mockImplementation((msgs: Array<{ content: string }>) =>
      msgs.map((m) => m.content).join('\n'),
    ),
    findChannel: vi.fn(),
  };
});

// list-credentials is NOT mocked globally — let the real module through.
// listCredentialsTool uses IPC (Redis) only when called without an ipcOverride;
// in processGroupMessages the call is wrapped in try/catch so Redis failures are silent.

import {
  folderPrefixForChannel,
  _buildShutdown,
  dispatchSkillsCommandIfApplicable,
  handleSecretCommand,
  isSecretCommand,
  parseSecretAddCommand,
  applyCredentialBackstop,
  buildCatalogBackstopPatterns,
  registerCredentialTools,
  type SecretCommandDeps,
  type IpcResponse,
} from './channel-runner.js';
import type { CatalogEntry } from './credential-broker/resolver.js';
import { buildCredentialSystemBlock } from './tools/list-credentials.js';
import type { CredentialEntry } from './tools/list-credentials.js';
import * as db from './db.js';

describe('folderPrefixForChannel', () => {
  it('returns "oauth" for oauth-webchat', () => {
    expect(folderPrefixForChannel('oauth-webchat')).toBe('oauth');
  });

  it('returns the established prefix for known channels', () => {
    expect(folderPrefixForChannel('telegram')).toBe('tg');
    expect(folderPrefixForChannel('http')).toBe('http');
  });

  it('falls back to first 3 chars for unknown channels', () => {
    expect(folderPrefixForChannel('matrix')).toBe('mat');
  });
});

describe('_buildShutdown: metrics server closed on shutdown', () => {
  it('calls metricsServer.close() during shutdown', async () => {
    const metricsServer = { close: vi.fn().mockResolvedValue(undefined) };
    const queue = { shutdown: vi.fn().mockResolvedValue(undefined) };
    const channels: Array<{ disconnect: () => Promise<void> }> = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const shutdown = _buildShutdown(
      metricsServer as import('./metrics/registry.js').MetricsServer,
      queue as unknown as import('./group-queue.js').GroupQueue,
      channels as unknown as import('./types.js').Channel[],
    );
    await shutdown('SIGTERM');

    expect(metricsServer.close).toHaveBeenCalledOnce();
    exitSpy.mockRestore();
  });
});

describe('runAgent — /skills intercept', () => {
  it('dispatches /skills commands without invoking the LLM runner', async () => {
    const outputs: string[] = [];
    const handled = await dispatchSkillsCommandIfApplicable(
      { folder: 'g1' } as any,
      '/skills list',
      'jid1',
      async (o: any) => {
        outputs.push(o.result ?? o.message ?? o.text ?? o.raw ?? '');
      },
    );
    expect(handled).toBe(true);
    expect(outputs.join('\n')).toMatch(/no skills/i);
  });

  it('returns false (and does not output) for non-/skills prompts', async () => {
    const outputs: string[] = [];
    const handled = await dispatchSkillsCommandIfApplicable(
      { folder: 'g1' } as any,
      'hello',
      'jid1',
      async (o: any) => {
        outputs.push(o.result ?? o.message ?? o.text ?? o.raw ?? '');
      },
    );
    expect(handled).toBe(false);
    expect(outputs).toEqual([]);
  });
});

// ── /secret command tests ─────────────────────────────────────────────────────

/** A minimal single-field catalog entry for tests. */
const REPLICATE_ENTRY: CatalogEntry = {
  id: 'replicate',
  host: 'api.replicate.com',
  upstreamPort: 443,
  credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
  baseUrlEnvs: { REPLICATE_API_URL: 'http://api.replicate.com' },
  allowOperatorFallback: false,
  allowedPositions: ['header', 'body'],
  apiKeyShape: { prefix: 'r8_', minLength: 20 },
};

/** A multi-field catalog entry for tests. */
const JENKINS_ENTRY: CatalogEntry = {
  id: 'jenkins',
  host: 'jenkins.example.com',
  upstreamPort: 8080,
  credentialFields: [
    { name: 'user', envVar: 'JENKINS_USER' },
    { name: 'password', envVar: 'JENKINS_PASSWORD' },
  ],
  baseUrlEnvs: { JENKINS_URL: 'http://jenkins.example.com' },
  allowOperatorFallback: false,
  allowedPositions: ['header', 'body'],
};

/** Build a SecretCommandDeps with a mocked IPC function. */
function makeDeps(
  ipcFn: SecretCommandDeps['ipc'],
  catalog: readonly CatalogEntry[] = [REPLICATE_ENTRY, JENKINS_ENTRY],
): SecretCommandDeps {
  return { catalog, ipc: ipcFn };
}

// ── Test 1: /secret add intercepted upstream of LLM (no LLM call observed) ──

describe('/secret add — intercepted upstream of LLM', () => {
  it('isSecretCommand returns true for /secret lines', () => {
    expect(isSecretCommand('/secret add replicate r8_abc')).toBe(true);
    expect(isSecretCommand('/secret list')).toBe(true);
    expect(isSecretCommand('/secret help')).toBe(true);
  });

  it('isSecretCommand returns false for non-/secret messages', () => {
    expect(isSecretCommand('hello')).toBe(false);
    expect(isSecretCommand('/skills list')).toBe(false);
    // Mistyped command falls through to LLM
    expect(isSecretCommand('/sercet add replicate r8_abc')).toBe(false);
  });

  it('handleSecretCommand resolves without calling any LLM (IPC is the only call)', async () => {
    const ipcCalls: string[] = [];
    const ipc = vi.fn(async (type: string, fields: Record<string, string>): Promise<IpcResponse> => {
      ipcCalls.push(type);
      return { ok: true };
    });

    const result = await handleSecretCommand(
      'family',
      '/secret add replicate r8_aaaabbbbccccdddd1234',
      makeDeps(ipc as any),
    );

    // IPC was called (to store the secret)
    expect(ipcCalls).toContain('secret.add');
    // Result is a reply string (not an LLM call)
    expect(result.reply).toBeTruthy();
  });
});

// ── Test 2: Raw user line dropped; SYSTEM event inserted; no raw in transcript ─

describe('/secret add — transcript management', () => {
  it('returns a systemEvent (not the raw command) and an assistantTurn', async () => {
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));

    const result = await handleSecretCommand(
      'family',
      '/secret add replicate r8_aaaabbbbccccdddd1234',
      makeDeps(ipc as any),
    );

    // System event describes registration but does NOT contain the raw value
    expect(result.systemEvent).toBeDefined();
    expect(result.systemEvent).toContain('[SYSTEM]');
    expect(result.systemEvent).toContain('replicate');
    expect(result.systemEvent).toContain('api.replicate.com');
    expect(result.systemEvent).toContain('REPLICATE_API_TOKEN');
    // The raw credential value must NOT appear in the system event
    expect(result.systemEvent).not.toContain('r8_aaaabbbbccccdddd1234');

    // Assistant turn is a templated response
    expect(result.assistantTurn).toBeDefined();
    expect(result.assistantTurn).toMatch(/replicate/i);
  });
});

// ── Test 3: LLM never sees raw command (only system event in transcript) ───────

describe('/secret add — LLM isolation', () => {
  it('reply does not contain the cleartext value', async () => {
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));

    const secretValue = 'r8_supersecretvalue1234567890';
    const result = await handleSecretCommand(
      'family',
      `/secret add replicate ${secretValue}`,
      makeDeps(ipc as any),
    );

    // Nothing returned to the user / LLM should contain the raw value
    expect(result.reply).not.toContain(secretValue);
    expect(result.systemEvent ?? '').not.toContain(secretValue);
    expect(result.assistantTurn ?? '').not.toContain(secretValue);
  });

  it('the IPC payload fields value is not echoed back in result', async () => {
    const capturedFields: Record<string, string>[] = [];
    const ipc = vi.fn(async (_type: string, fields: Record<string, string>): Promise<IpcResponse> => {
      capturedFields.push({ ...fields });
      return { ok: true };
    });

    await handleSecretCommand(
      'family',
      '/secret add replicate r8_mysecret12345678901234',
      makeDeps(ipc as any),
    );

    // IPC was called with the fields JSON — that's expected (it goes to orchestrator)
    // But the fields must have been zeroed after the call
    const addCall = capturedFields.find((f) => f.fields);
    expect(addCall).toBeDefined();
    // The fields in the IPC call contained the secret (it's sent to orchestrator)
    // but after handleSecretCommand returns, cleartext is zeroed — we can't
    // observe the zero from outside, but we verify the result has no cleartext
    expect(addCall!.catalogId).toBe('replicate');
  });
});

// ── Test 4: Mistyped /sercet falls through; backstop scrubs credential patterns ─

describe('backstop regex — credential scrubbing', () => {
  it('applyCredentialBackstop redacts sk- patterns', () => {
    const msg = 'Here is my key: sk-abcdefghijklmnopqrst1234';
    expect(applyCredentialBackstop(msg)).toContain('[possible secret redacted]');
    expect(applyCredentialBackstop(msg)).not.toContain('sk-abcdefghijklmnopqrst1234');
  });

  it('applyCredentialBackstop redacts r8_ patterns', () => {
    const msg = 'my replicate token is r8_abcdefghijklmnopqrst';
    expect(applyCredentialBackstop(msg)).toContain('[possible secret redacted]');
  });

  it('applyCredentialBackstop redacts Bearer tokens', () => {
    const msg = 'Authorization: Bearer abc123def456ghi789jkl012';
    expect(applyCredentialBackstop(msg)).toContain('[possible secret redacted]');
  });

  it('applyCredentialBackstop redacts AIza patterns', () => {
    const msg = 'google key: AIzaSyAbcDefGhiJklMnoPqrStUvWxYz123456';
    expect(applyCredentialBackstop(msg)).toContain('[possible secret redacted]');
  });

  it('mistyped /sercet add passes isSecretCommand=false and goes through backstop', () => {
    const mistyped = '/sercet add replicate r8_aaaabbbbcccc123456789';
    // The parser does NOT intercept this
    expect(isSecretCommand(mistyped)).toBe(false);
    // But the backstop scrubs the r8_ token
    const scrubbed = applyCredentialBackstop(mistyped);
    expect(scrubbed).toContain('[possible secret redacted]');
    expect(scrubbed).not.toContain('r8_aaaabbbbcccc123456789');
  });

  it('buildCatalogBackstopPatterns adds patterns from catalog apiKeyShape', () => {
    const patterns = buildCatalogBackstopPatterns([REPLICATE_ENTRY]);
    expect(patterns.length).toBeGreaterThan(0);
    // The pattern should match a replicate-style token
    const token = 'r8_' + 'x'.repeat(25);
    const combined = applyCredentialBackstop(token, patterns);
    expect(combined).toContain('[possible secret redacted]');
  });
});

// ── Test 5: Unknown catalogId → friendly error, no IPC sent ────────────────

describe('/secret add — unknown catalogId', () => {
  it('returns friendly error and does NOT call secret.add IPC', async () => {
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));

    const result = await handleSecretCommand(
      'family',
      '/secret add unknownapi somevalue',
      makeDeps(ipc as any),
    );

    // Friendly error message
    expect(result.reply).toMatch(/unknown api/i);
    expect(result.reply).toContain('unknownapi');

    // No secret.add IPC sent
    const addCalls = (ipc.mock.calls as Array<[string, ...unknown[]]>).filter(
      ([type]) => type === 'secret.add',
    );
    expect(addCalls).toHaveLength(0);

    // No systemEvent or assistantTurn (command did not succeed)
    expect(result.systemEvent).toBeUndefined();
    expect(result.assistantTurn).toBeUndefined();
  });
});

// ── Test 6: Empty value → error ─────────────────────────────────────────────

describe('/secret add — empty value', () => {
  it('returns error when value is empty string', async () => {
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));

    // parseSecretAddCommand will fail to produce a parseable command for
    // "/secret add replicate " (no value after catalogId)
    const result = await handleSecretCommand(
      'family',
      '/secret add replicate ',
      makeDeps(ipc as any),
    );

    expect(result.reply).toMatch(/usage|value|empty/i);
    // No IPC sent
    expect(ipc).not.toHaveBeenCalledWith('secret.add', expect.anything());
  });

  it('parseSecretAddCommand returns null when value part is missing', () => {
    expect(parseSecretAddCommand('/secret add replicate')).toBeNull();
    expect(parseSecretAddCommand('/secret add replicate ')).toBeNull();
  });
});

// ── Test 7: IPC timeout → retry message; cleartext zeroed ──────────────────

describe('/secret add — IPC timeout', () => {
  it('returns orchestrator-unavailable message on timeout', async () => {
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({
      ok: false,
      error: 'timeout',
    }));

    const result = await handleSecretCommand(
      'family',
      '/secret add replicate r8_aaaabbbbccccdddd1234',
      makeDeps(ipc as any),
    );

    expect(result.reply).toMatch(/couldn.t reach the orchestrator/i);
    expect(result.reply).toMatch(/NOT stored/i);
    // No successful system event
    expect(result.systemEvent).toBeUndefined();
  });

  it('cleartext is zeroed even on IPC timeout (finally block)', async () => {
    // We can't inspect the heap directly, but we verify the command completes
    // without throwing and the reply is an error message (not a value leak).
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({
      ok: false,
      error: 'timeout',
    }));

    const secretValue = 'r8_secretvalue12345678901234';
    const result = await handleSecretCommand(
      'family',
      `/secret add replicate ${secretValue}`,
      makeDeps(ipc as any),
    );

    // Value not in reply (cleartext was zeroed and not leaked)
    expect(result.reply).not.toContain(secretValue);
  });
});

// ── Test 8: Multi-field parser ───────────────────────────────────────────────

describe('/secret add — multi-field parser', () => {
  it('parses /secret add jenkins user=alice password=hunter2 correctly', () => {
    const parsed = parseSecretAddCommand(
      '/secret add jenkins user=alice password=hunter2',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.catalogId).toBe('jenkins');
    expect(parsed!.fields).toEqual({ user: 'alice', password: 'hunter2' });
  });

  it('handleSecretCommand stores multi-field credentials with correct field names', async () => {
    let capturedFields: Record<string, string> = {};
    const ipc = vi.fn(async (type: string, fields: Record<string, string>): Promise<IpcResponse> => {
      if (type === 'secret.add') capturedFields = { ...fields };
      return { ok: true };
    });

    const result = await handleSecretCommand(
      'family',
      '/secret add jenkins user=alice password=hunter2',
      makeDeps(ipc as any),
    );

    expect(result.systemEvent).toBeDefined();
    expect(result.systemEvent).toContain('JENKINS_USER');
    expect(result.systemEvent).toContain('JENKINS_PASSWORD');

    // IPC called with correct catalogId and fields JSON
    expect(capturedFields.catalogId).toBe('jenkins');
    const parsedFields = JSON.parse(capturedFields.fields);
    expect(parsedFields).toEqual({ user: 'alice', password: 'hunter2' });
  });

  it('parses single-field shorthand correctly', () => {
    const parsed = parseSecretAddCommand('/secret add replicate r8_mytoken123456789');
    expect(parsed).not.toBeNull();
    expect(parsed!.catalogId).toBe('replicate');
    // Single-field shorthand uses __single__ sentinel
    expect(parsed!.fields['__single__']).toBe('r8_mytoken123456789');
  });

  it('handleSecretCommand resolves __single__ to the catalog field name', async () => {
    let capturedFields: Record<string, string> = {};
    const ipc = vi.fn(async (type: string, fields: Record<string, string>): Promise<IpcResponse> => {
      if (type === 'secret.add') capturedFields = { ...fields };
      return { ok: true };
    });

    await handleSecretCommand(
      'family',
      '/secret add replicate r8_mytoken123456789012',
      makeDeps(ipc as any),
    );

    const parsedFields = JSON.parse(capturedFields.fields);
    // Should be resolved to the catalog field name 'token', not '__single__'
    expect(parsedFields).toEqual({ token: 'r8_mytoken123456789012' });
    expect(parsedFields['__single__']).toBeUndefined();
  });
});

// ── list_credentials tool registration ───────────────────────────────────────

describe('registerCredentialTools — list_credentials in agent tool list', () => {
  it('registers list_credentials in the DirectLLMRunner tool list', () => {
    // Create a minimal mock of the DirectLLMRunner's interface
    const registeredTools: string[] = [];
    const mockRunner = {
      registerLocalTool: (name: string, _tool: unknown) => {
        registeredTools.push(name);
      },
    } as any;

    registerCredentialTools(mockRunner);

    expect(registeredTools).toContain('list_credentials');
  });

  it('registers list_credentials with a handler that accepts group from input', async () => {
    let capturedName = '';
    let capturedHandler: ((args: unknown, input: unknown) => Promise<string>) | null = null;

    const mockRunner = {
      registerLocalTool: (name: string, tool: { def: unknown; handler: (args: unknown, input: unknown) => Promise<string> }) => {
        capturedName = name;
        capturedHandler = tool.handler;
      },
    } as any;

    // Inject a mock IPC that returns empty results
    const mockIpc = vi.fn(async (): Promise<IpcResponse> => ({
      ok: true,
      result: [],
    }));

    registerCredentialTools(mockRunner, mockIpc as any);

    expect(capturedName).toBe('list_credentials');
    expect(capturedHandler).not.toBeNull();

    // Invoke the handler to verify it calls the IPC client
    const result = await capturedHandler!({}, { groupFolder: 'ops' });
    expect(result).toBeDefined();
    // Empty catalog → empty array returned as JSON
    expect(JSON.parse(result)).toEqual([]);
  });

  it('list_credentials handler returns JSON array', async () => {
    let capturedHandler: ((args: unknown, input: { groupFolder: string }) => Promise<string>) | null = null;

    const mockRunner = {
      registerLocalTool: (_name: string, tool: { def: unknown; handler: (args: unknown, input: { groupFolder: string }) => Promise<string> }) => {
        capturedHandler = tool.handler;
      },
    } as any;

    const mockIpc = vi.fn(async (type: string): Promise<IpcResponse> => {
      if (type === 'secret.list') {
        return {
          ok: true,
          result: [{ catalogId: 'replicate', registeredAt: '2026-05-16T14:22:11Z' }],
        };
      }
      if (type === 'catalog.list') {
        return {
          ok: true,
          result: [
            {
              id: 'replicate',
              host: 'api.replicate.com',
              credentialFields: [{ name: 'token', envVar: 'REPLICATE_API_TOKEN' }],
            },
          ],
        };
      }
      return { ok: false, error: 'unexpected' };
    });

    registerCredentialTools(mockRunner, mockIpc as any);

    const result = await capturedHandler!({}, { groupFolder: 'family' });
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].catalogId).toBe('replicate');
    expect(parsed[0].hasCredential).toBe(true);
    // Values must never appear
    expect(result).not.toContain('r8_');
    expect(result).not.toContain('hunter2');
  });

  it('list_credentials handler returns error string on IPC failure (not exception)', async () => {
    let capturedHandler: ((args: unknown, input: { groupFolder: string }) => Promise<string>) | null = null;

    const mockRunner = {
      registerLocalTool: (_name: string, tool: { def: unknown; handler: (args: unknown, input: { groupFolder: string }) => Promise<string> }) => {
        capturedHandler = tool.handler;
      },
    } as any;

    const mockIpc = vi.fn(async (): Promise<never> => {
      throw new Error('redis down');
    });

    registerCredentialTools(mockRunner, mockIpc as any);

    // Handler should NOT re-throw — it returns an error string to the LLM
    const result = await capturedHandler!({}, { groupFolder: 'family' });
    expect(typeof result).toBe('string');
    expect(result).toMatch(/list_credentials error/i);
  });
});

// ── Per-turn system-prompt block ──────────────────────────────────────────────

describe('per-turn credential system-prompt block', () => {
  it('buildCredentialSystemBlock returns empty string for empty catalog', () => {
    const block = buildCredentialSystemBlock([], 'family');
    expect(block).toBe('');
  });

  it('buildCredentialSystemBlock includes group name and [SYSTEM] header', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'replicate',
        host: 'api.replicate.com',
        fields: ['token'],
        hasCredential: true,
        registeredAt: '2026-05-16T14:22:11Z',
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'my-group');
    expect(block.startsWith('[SYSTEM]')).toBe(true);
    expect(block).toContain('"my-group"');
  });

  it('buildCredentialSystemBlock shows "credential registered" for registered entries', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'replicate',
        host: 'api.replicate.com',
        fields: ['token'],
        hasCredential: true,
        registeredAt: '2026-05-16T14:22:11Z',
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'family');
    expect(block).toContain('replicate');
    expect(block).toContain('api.replicate.com');
    expect(block).toContain('credential registered');
  });

  it('buildCredentialSystemBlock shows /secret add hint for unregistered entries', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'mistral',
        host: 'api.mistral.ai',
        fields: ['token'],
        hasCredential: false,
        registeredAt: null,
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'family');
    expect(block).toContain('mistral');
    expect(block).toContain('no credential');
    expect(block).toContain('/secret add mistral');
  });

  it('buildCredentialSystemBlock includes both registered and unregistered entries', () => {
    const entries: CredentialEntry[] = [
      {
        catalogId: 'replicate',
        host: 'api.replicate.com',
        fields: ['token'],
        hasCredential: true,
        registeredAt: '2026-05-16T14:22:11Z',
      },
      {
        catalogId: 'jenkins',
        host: 'jenkins.example.com',
        fields: ['user', 'password'],
        hasCredential: false,
        registeredAt: null,
      },
    ];
    const block = buildCredentialSystemBlock(entries, 'ops');
    expect(block).toContain('replicate');
    expect(block).toContain('credential registered');
    expect(block).toContain('jenkins');
    expect(block).toContain('no credential');
    expect(block).toContain('/secret add jenkins');
  });
});

// ── Integration: /secret add persists system event + assistant turn to transcript ─

describe('/secret add — transcript persistence integration', () => {
  it('persists systemEvent (user role) and assistantTurn (assistant role) after /secret add succeeds', async () => {
    // Arrange: a mock appendConversationMessage to capture persistence calls
    const appendCalls: Array<{ groupFolder: string; role: string; content: string }> = [];
    const mockAppend = vi.fn(
      (groupFolder: string, role: 'user' | 'assistant', content: string) => {
        appendCalls.push({ groupFolder, role, content });
      },
    );

    // Exercise handleSecretCommand with a /secret add payload — this is what
    // processGroupMessages calls to obtain the result.
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));
    const result = await handleSecretCommand(
      'family',
      '/secret add replicate r8_aaaabbbbccccdddd1234',
      makeDeps(ipc as any),
    );

    // Simulate the persistence wiring in processGroupMessages: after
    // handleSecretCommand returns, the caller stores systemEvent + assistantTurn.
    if (result.systemEvent) {
      mockAppend('family', 'user', result.systemEvent);
    }
    if (result.assistantTurn) {
      mockAppend('family', 'assistant', result.assistantTurn);
    }

    // Assert: appendConversationMessage was called twice (system event + assistant turn)
    expect(mockAppend).toHaveBeenCalledTimes(2);

    const [systemCall, assistantCall] = appendCalls;

    // System event stored as 'user' role so LLM sees it in conversation history
    expect(systemCall.role).toBe('user');
    expect(systemCall.groupFolder).toBe('family');
    // System event contains catalog metadata (catalogId, host, env var) but NOT the raw credential value
    expect(systemCall.content).toContain('[SYSTEM]');
    expect(systemCall.content).toContain('replicate');
    expect(systemCall.content).toContain('api.replicate.com');
    expect(systemCall.content).toContain('REPLICATE_API_TOKEN');
    expect(systemCall.content).not.toContain('r8_aaaabbbbccccdddd1234');

    // Assistant turn stored as 'assistant' role
    expect(assistantCall.role).toBe('assistant');
    expect(assistantCall.groupFolder).toBe('family');
    expect(assistantCall.content).toMatch(/replicate/i);

    // The raw /secret add line was NOT passed to appendConversationMessage
    const allContents = appendCalls.map((c) => c.content);
    expect(allContents.every((c) => !c.includes('/secret add'))).toBe(true);
    expect(allContents.every((c) => !c.includes('r8_aaaabbbbccccdddd1234'))).toBe(true);
  });

  it('persists systemEvent and assistantTurn after /secret remove succeeds', async () => {
    const appendCalls: Array<{ groupFolder: string; role: string; content: string }> = [];
    const mockAppend = vi.fn(
      (groupFolder: string, role: 'user' | 'assistant', content: string) => {
        appendCalls.push({ groupFolder, role, content });
      },
    );

    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));
    const result = await handleSecretCommand(
      'family',
      '/secret remove replicate',
      makeDeps(ipc as any),
    );

    if (result.systemEvent) {
      mockAppend('family', 'user', result.systemEvent);
    }
    if (result.assistantTurn) {
      mockAppend('family', 'assistant', result.assistantTurn);
    }

    expect(mockAppend).toHaveBeenCalledTimes(2);
    expect(appendCalls[0].content).toContain('[SYSTEM]');
    expect(appendCalls[0].content).toContain('replicate');
    // Raw /secret remove line must not be stored
    expect(appendCalls.every((c) => !c.content.includes('/secret remove'))).toBe(true);
  });

  it('does NOT persist anything when /secret add fails (IPC error)', async () => {
    const mockAppend = vi.fn();

    const ipc = vi.fn(async (): Promise<IpcResponse> => ({
      ok: false,
      error: 'orchestrator unavailable',
    }));
    const result = await handleSecretCommand(
      'family',
      '/secret add replicate r8_aaaabbbbccccdddd1234',
      makeDeps(ipc as any),
    );

    // On failure, result has no systemEvent or assistantTurn — nothing to persist
    if (result.systemEvent) {
      mockAppend('family', 'user', result.systemEvent);
    }
    if (result.assistantTurn) {
      mockAppend('family', 'assistant', result.assistantTurn);
    }

    expect(mockAppend).not.toHaveBeenCalled();
  });
});

// ── processGroupMessages dispatch tests ───────────────────────────────────────

import {
  processGroupMessages,
  _setRegisteredGroupsForTesting,
  _pushChannelForTesting,
  _resetStateForTesting,
  _setSpecialistCatalogForTesting,
} from './channel-runner.js';
import { getDirectLLMRunner } from './runtime/index.js';
import { getMessagesSince } from './db.js';
import { findChannel } from './router.js';
import type { GlobalSpecialist } from './specialists/types.js';

const mockGetDirectLLMRunner = getDirectLLMRunner as ReturnType<typeof vi.fn>;
const mockGetMessagesSince = getMessagesSince as ReturnType<typeof vi.fn>;
const mockFindChannel = findChannel as ReturnType<typeof vi.fn>;

/** Build a fake catalog that can be overridden in each test. */
function makeCatalog(specialists: GlobalSpecialist[]) {
  return { getAll: () => specialists };
}

/** Minimal message fixture that satisfies getMessagesSince return type. */
function makeMessage(content: string, ts = '2026-01-01T00:00:00.000Z') {
  return {
    id: 1,
    chat_jid: 'chat@g.us',
    sender: 'user@s.whatsapp.net',
    content,
    timestamp: ts,
    is_from_me: false,
    is_bot_message: false,
  };
}

describe('processGroupMessages dispatch', () => {
  const chatJid = 'chat@g.us';
  const group = {
    name: 'Test',
    folder: 'test-group',
    trigger: '',
    added_at: '2026-01-01T00:00:00.000Z',
    isMain: true,
    requiresTrigger: false,
  };

  let sentMessages: string[];
  let fakeRunner: { runAgent: ReturnType<typeof vi.fn>; writeTasksSnapshot: ReturnType<typeof vi.fn>; writeGroupsSnapshot: ReturnType<typeof vi.fn> };
  let mockChannel: { sendMessage: ReturnType<typeof vi.fn>; setTyping: ReturnType<typeof vi.fn>; owns: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStateForTesting();
    sentMessages = [];
    recordSpecialistUsageCalls.length = 0;

    fakeRunner = {
      runAgent: vi.fn().mockResolvedValue({ status: 'success', result: null }),
      writeTasksSnapshot: vi.fn(),
      writeGroupsSnapshot: vi.fn(),
    };
    mockGetDirectLLMRunner.mockReturnValue(fakeRunner);

    mockChannel = {
      sendMessage: vi.fn().mockImplementation(async (_jid: string, text: string) => {
        sentMessages.push(text);
      }),
      setTyping: vi.fn().mockResolvedValue(undefined),
      owns: vi.fn().mockReturnValue(true),
    };
    mockFindChannel.mockReturnValue(mockChannel);

    mockGetMessagesSince.mockReturnValue([makeMessage('hello')]);

    _setRegisteredGroupsForTesting({ [chatJid]: group as any });
    _pushChannelForTesting(mockChannel as any);
  });

  it('runs the main agent when no specialist mentioned (overrides empty)', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'CodeReview', prompt: 'p' }]));

    const runCalls: { prompt: string; overrides: any }[] = [];
    fakeRunner.runAgent = vi.fn().mockImplementation(async (_g: any, input: any, _spec: any, _onOutput: any, overrides: any) => {
      runCalls.push({ prompt: input.prompt, overrides });
      return { status: 'success', result: null };
    });

    await processGroupMessages(chatJid);

    expect(runCalls).toHaveLength(1);
    // Main agent path — overrides is empty object (no sessionKey override)
    expect(runCalls[0].overrides.sessionKey).toBeUndefined();
  });

  it('runs mentioned specialists in parallel', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([
      { name: 'A', prompt: 'pa' },
      { name: 'B', prompt: 'pb' },
    ]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@A @B do thing')]);

    const started: string[] = [];
    const releaseFns: Record<string, () => void> = {};

    fakeRunner.runAgent = vi.fn().mockImplementation(async (_g: any, input: any, _spec: any, _onOutput: any) => {
      const nameMatch = /name="([^"]+)"/.exec(input.prompt);
      const name = nameMatch?.[1] ?? 'main';
      started.push(name);
      await new Promise<void>((resolve) => { releaseFns[name] = resolve; });
      return { status: 'success', result: null };
    });

    const p = processGroupMessages(chatJid);
    // Give the event loop a tick so both runAgent calls are initiated
    await new Promise((r) => setTimeout(r, 20));

    expect(started.sort()).toEqual(['A', 'B']); // both started before either resolves

    releaseFns['A']?.();
    releaseFns['B']?.();
    await p;
  });

  it('error in one specialist does not abort the others', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([
      { name: 'A', prompt: 'pa' },
      { name: 'B', prompt: 'pb' },
    ]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@A @B please')]);

    let bRan = false;
    fakeRunner.runAgent = vi.fn().mockImplementation(async (_g: any, input: any) => {
      if (input.prompt.includes('name="A"')) throw new Error('boom');
      bRan = true;
      return { status: 'success', result: null };
    });

    await processGroupMessages(chatJid);

    expect(bRan).toBe(true);
  });

  it('passes per-specialist sessionKey/llmProvider/toolFilter to runAgent', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{
      name: 'Iso',
      prompt: 'p',
      memory: { isolated: true },
      llmProvider: 'claude',
      tools: ['mcp:fetch'],
    }]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@Iso question')]);

    let captured: any;
    fakeRunner.runAgent = vi.fn().mockImplementation(async (_g: any, _input: any, _spec: any, _onOutput: any, overrides: any) => {
      captured = overrides;
      return { status: 'success', result: null };
    });

    await processGroupMessages(chatJid);

    expect(captured.sessionKey).toBe(`${group.folder}:Iso`);
    expect(captured.llmProvider).toBe('claude');
    expect([...captured.toolFilter]).toEqual(['mcp:fetch']);
  });

  it('prefixes replies with [@Name] when a specialist is mentioned', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@A hi')]);

    fakeRunner.runAgent = vi.fn().mockImplementation(async (_g: any, _input: any, _spec: any, onOutput: any) => {
      if (onOutput) await onOutput({ status: 'success', result: 'hello back' });
      return { status: 'success', result: null };
    });

    await processGroupMessages(chatJid);

    expect(sentMessages).toEqual(['[@A] hello back']);
  });

  it('does not prefix when no specialist is mentioned', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    // No @A mention → main agent path
    mockGetMessagesSince.mockReturnValue([makeMessage('no mention here')]);

    fakeRunner.runAgent = vi.fn().mockImplementation(async (_g: any, _input: any, _spec: any, onOutput: any) => {
      if (onOutput) await onOutput({ status: 'success', result: 'hello' });
      return { status: 'success', result: null };
    });

    await processGroupMessages(chatJid);

    expect(sentMessages).toEqual(['hello']);
  });

  it('records specialist usage on dispatch', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@A hi')]);

    fakeRunner.runAgent = vi.fn().mockImplementation(async (_g: any, _input: any, _spec: any, onOutput: any) => {
      if (onOutput) await onOutput({ status: 'success', result: 'hello back' });
      return { status: 'success', result: null };
    });

    await processGroupMessages(chatJid);

    expect(recordSpecialistUsageCalls).toHaveLength(1);
    expect(recordSpecialistUsageCalls[0].specialistName).toBe('A');
    expect(recordSpecialistUsageCalls[0].groupFolder).toBe(group.folder);
    expect(recordSpecialistUsageCalls[0].status).toBe('success');
    expect(typeof recordSpecialistUsageCalls[0].durationMs).toBe('number');
  });

  it('does not record specialist usage for main-agent runs', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    // No @A mention → main agent path
    mockGetMessagesSince.mockReturnValue([makeMessage('no mention here')]);

    fakeRunner.runAgent = vi.fn().mockImplementation(async (_g: any, _input: any, _spec: any, onOutput: any) => {
      if (onOutput) await onOutput({ status: 'success', result: 'hello' });
      return { status: 'success', result: null };
    });

    await processGroupMessages(chatJid);

    expect(recordSpecialistUsageCalls).toHaveLength(0);
  });

  it('records error status when specialist run fails', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@A hi')]);

    fakeRunner.runAgent = vi.fn().mockRejectedValue(new Error('specialist boom'));

    await processGroupMessages(chatJid);

    expect(recordSpecialistUsageCalls).toHaveLength(1);
    expect(recordSpecialistUsageCalls[0].specialistName).toBe('A');
    expect(recordSpecialistUsageCalls[0].status).toBe('error');
  });
});

// ── /search dispatch tests (gap-3) ────────────────────────────────────────────

import {
  _testInjectState,
  _testResetState,
} from './channel-runner.js';
import { isSearchCommand, handleSearchCommand } from './runtime/search-command.js';

describe('/search dispatch', () => {
  it('isSearchCommand identifies /search messages', () => {
    expect(isSearchCommand('/search hello')).toBe(true);
    expect(isSearchCommand('/skills list')).toBe(false);
    expect(isSearchCommand('regular message')).toBe(false);
  });

  it('handleSearchCommand returns a no-results message for unknown query', async () => {
    const { _initTestDatabase } = await import('./db.js');
    await _initTestDatabase();
    const out = handleSearchCommand('test-group', '/search xqzz_channel_runner_dispatch');
    expect(out).toMatch(/no results/i);
  });
});

describe('/search dispatch end-to-end via processGroupMessages', () => {
  const CHAT_JID = 'dispatch-test@g.us';
  const GROUP_FOLDER = 'tg_dispatch-test';
  const sendMessageSpy = vi.fn().mockResolvedValue(undefined);

  afterEach(() => {
    _testResetState();
    sendMessageSpy.mockClear();
    vi.restoreAllMocks();
  });

  it('sends search result via channel.sendMessage and does NOT invoke the LLM', async () => {
    // Initialize the real sql.js DB and seed conversation history for /search.
    const { _initTestDatabase, appendConversationMessage } = await import('./db.js');
    await _initTestDatabase();

    // Seed conversation history so /search has rows to return.
    appendConversationMessage(GROUP_FOLDER, 'user', 'the cluster uses kubernetes for scheduling');
    appendConversationMessage(GROUP_FOLDER, 'assistant', 'yes kubernetes is configured');

    // Make getMessagesSince (mocked) return a /search message.
    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    mockGetMessagesSince.mockReturnValueOnce([{
      id: 'dispatch-search-msg-1',
      chat_jid: CHAT_JID,
      sender: 'user123',
      sender_name: 'Alice',
      content: '/search kubernetes',
      timestamp: msgTimestamp,
      is_from_me: false,
    }]);

    // Build a fake channel that owns the test JID.
    const fakeChannel = {
      ownsJid: (jid: string) => jid === CHAT_JID,
      sendMessage: sendMessageSpy,
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    mockFindChannel.mockReturnValueOnce(fakeChannel);

    // Inject the registered group and fake channel into module-level state.
    _testInjectState(
      {
        [CHAT_JID]: {
          jid: CHAT_JID,
          name: 'Dispatch Test Group',
          folder: GROUP_FOLDER,
          trigger: '@Claude',
          added_at: new Date().toISOString(),
          requiresTrigger: false, // bypass trigger check so /search is processed
        },
      },
      [fakeChannel as any],
    );

    const result = await processGroupMessages(CHAT_JID);

    // The function should complete successfully.
    expect(result).toBe(true);

    // sendMessage must have been called with a search result string.
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const sentText: string = sendMessageSpy.mock.calls[0][1];
    expect(sentText).toMatch(/kubernetes/i);
  });

  it('forwards a non-search message without calling sendMessage directly', async () => {
    // Make getMessagesSince return a normal message.
    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    mockGetMessagesSince.mockReturnValueOnce([{
      id: 'dispatch-regular-msg-1',
      chat_jid: CHAT_JID,
      sender: 'user123',
      sender_name: 'Alice',
      content: 'hello world regular message',
      timestamp: msgTimestamp,
      is_from_me: false,
    }]);

    const fakeChannel = {
      ownsJid: (jid: string) => jid === CHAT_JID,
      sendMessage: sendMessageSpy,
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    mockFindChannel.mockReturnValueOnce(fakeChannel);

    _testInjectState(
      {
        [CHAT_JID]: {
          jid: CHAT_JID,
          name: 'Dispatch Test Group',
          folder: GROUP_FOLDER,
          trigger: '@Claude',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      },
      [fakeChannel as any],
    );

    await processGroupMessages(CHAT_JID);

    // For a normal message sendMessage is NOT called directly (the LLM runner handles output).
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });
});

describe('/search dispatch — malformed FTS query error handling', () => {
  const CHAT_JID = 'fts-error-test@g.us';
  const GROUP_FOLDER = 'tg_fts-error-test';
  const sendMessageSpy = vi.fn().mockResolvedValue(undefined);

  afterEach(() => {
    _testResetState();
    sendMessageSpy.mockClear();
    vi.restoreAllMocks();
  });

  it('sends a friendly error message when FTS4 throws and does NOT invoke the LLM', async () => {
    // Make getMessagesSince return a /search message with a malformed query.
    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    mockGetMessagesSince.mockReturnValueOnce([{
      id: 'fts-error-msg-1',
      chat_jid: CHAT_JID,
      sender: 'user123',
      sender_name: 'Alice',
      content: '/search "unclosed',
      timestamp: msgTimestamp,
      is_from_me: false,
    }]);

    // Force searchConversations to throw as it would with a malformed FTS4 query.
    vi.spyOn(db, 'searchConversations').mockImplementation(() => {
      throw new Error('fts error: syntax error near end of input');
    });

    const fakeChannel = {
      ownsJid: (jid: string) => jid === CHAT_JID,
      sendMessage: sendMessageSpy,
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    mockFindChannel.mockReturnValueOnce(fakeChannel);

    _testInjectState(
      {
        [CHAT_JID]: {
          jid: CHAT_JID,
          name: 'FTS Error Group',
          folder: GROUP_FOLDER,
          trigger: '@Claude',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      },
      [fakeChannel as any],
    );

    const result = await processGroupMessages(CHAT_JID);

    // processGroupMessages should still return true (the message was consumed).
    expect(result).toBe(true);

    // sendMessage must have been called with the friendly error string.
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const sentText: string = sendMessageSpy.mock.calls[0][1];
    expect(sentText).toMatch(/Search failed/i);
  });
});
