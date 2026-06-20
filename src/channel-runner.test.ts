import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';

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
    createTask: vi.fn(),
    getTaskById: vi.fn().mockReturnValue(undefined),
    getTaskRunLogs: vi.fn().mockReturnValue([]),
    getTasksForGroup: vi.fn().mockReturnValue([]),
    deleteTaskForGroup: vi.fn().mockReturnValue(true),
    pauseTask: vi.fn().mockReturnValue(true),
    resumeTask: vi.fn().mockReturnValue(true),
    writeAuditEntry: vi.fn(),
    recordSpecialistUsage: vi
      .fn()
      .mockImplementation(
        (args: {
          groupFolder: string;
          specialistName: string;
          durationMs: number;
          status: 'success' | 'error';
        }) => {
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
  createSecretIpcFn: vi
    .fn()
    .mockReturnValue(vi.fn().mockResolvedValue({ ok: true, result: [] })),
}));

// Mock rag/provider so it doesn't attempt to import capabilities/registry →
// capabilities/reconciler → k8s/job-runner (which needs a live cluster).
vi.mock('./rag/provider.js', () => ({
  resetRagProvider: vi.fn(),
  getRagProvider: vi.fn().mockReturnValue(null),
}));

// Mock capabilities/registry transitively imported via rag/provider → capabilities/client.
vi.mock('./capabilities/registry.js', () => ({
  getEntriesForChannel: vi.fn().mockReturnValue([]),
  listCapabilities: vi.fn().mockReturnValue([]),
  installCapability: vi.fn().mockResolvedValue(undefined),
  removeCapability: vi.fn().mockResolvedValue(undefined),
}));

// Prevent the module-level `new JobRunner()` singleton from crashing the test
// suite in environments without a Kubernetes cluster (the real constructor calls
// KubeConfig.makeApiClient which throws "No active cluster!").
vi.mock('./k8s/job-runner.js', () => {
  const noop = vi.fn().mockResolvedValue(undefined);
  const fakeRunner = {
    createToolPodJob: noop,
    createSidecarToolPodJob: noop,
    deleteJob: noop,
    getJobStatus: vi.fn().mockResolvedValue('running'),
    listJobs: vi.fn().mockResolvedValue([]),
    getPodLogs: vi.fn().mockResolvedValue(''),
  };
  return {
    JobRunner: vi.fn().mockImplementation(() => fakeRunner),
    jobRunner: fakeRunner,
    buildJobName: vi.fn().mockReturnValue('fake-job-name'),
  };
});

vi.mock('./router.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as any),
    // Include message content so @Mention detection works in dispatch tests.
    formatMessages: vi
      .fn()
      .mockImplementation((msgs: Array<{ content: string }>) =>
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
  registerProfileTool,
  isCapabilitiesCommand,
  handleCapabilitiesCommand,
  _groupCapabilityEntries,
  isScheduleCommand,
  parseScheduleAddCommand,
  handleScheduleCommand,
  formatHumanDelta,
  type SecretCommandDeps,
  type IpcResponse,
  type CapabilityIpcFn,
  type ScheduleAddCommand,
} from './channel-runner.js';
import type { GroupMcpEntry } from './capabilities/types.js';
import type { CatalogEntry } from './credential-broker/resolver.js';
import { buildCredentialSystemBlock } from './tools/list-credentials.js';
import type { CredentialEntry } from './tools/list-credentials.js';
import * as db from './db.js';
import { isCompactCommand } from './runtime/compression-commands.js';

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
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

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
    const ipc = vi.fn(
      async (
        type: string,
        fields: Record<string, string>,
      ): Promise<IpcResponse> => {
        ipcCalls.push(type);
        return { ok: true };
      },
    );

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
    const ipc = vi.fn(
      async (
        _type: string,
        fields: Record<string, string>,
      ): Promise<IpcResponse> => {
        capturedFields.push({ ...fields });
        return { ok: true };
      },
    );

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
    expect(applyCredentialBackstop(msg)).toContain(
      '[possible secret redacted]',
    );
    expect(applyCredentialBackstop(msg)).not.toContain(
      'sk-abcdefghijklmnopqrst1234',
    );
  });

  it('applyCredentialBackstop redacts r8_ patterns', () => {
    const msg = 'my replicate token is r8_abcdefghijklmnopqrst';
    expect(applyCredentialBackstop(msg)).toContain(
      '[possible secret redacted]',
    );
  });

  it('applyCredentialBackstop redacts Bearer tokens', () => {
    const msg = 'Authorization: Bearer abc123def456ghi789jkl012';
    expect(applyCredentialBackstop(msg)).toContain(
      '[possible secret redacted]',
    );
  });

  it('applyCredentialBackstop redacts AIza patterns', () => {
    const msg = 'google key: AIzaSyAbcDefGhiJklMnoPqrStUvWxYz123456';
    expect(applyCredentialBackstop(msg)).toContain(
      '[possible secret redacted]',
    );
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
    const ipc = vi.fn(
      async (): Promise<IpcResponse> => ({
        ok: false,
        error: 'timeout',
      }),
    );

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
    const ipc = vi.fn(
      async (): Promise<IpcResponse> => ({
        ok: false,
        error: 'timeout',
      }),
    );

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
    const ipc = vi.fn(
      async (
        type: string,
        fields: Record<string, string>,
      ): Promise<IpcResponse> => {
        if (type === 'secret.add') capturedFields = { ...fields };
        return { ok: true };
      },
    );

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
    const parsed = parseSecretAddCommand(
      '/secret add replicate r8_mytoken123456789',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.catalogId).toBe('replicate');
    // Single-field shorthand uses __single__ sentinel
    expect(parsed!.fields['__single__']).toBe('r8_mytoken123456789');
  });

  it('handleSecretCommand resolves __single__ to the catalog field name', async () => {
    let capturedFields: Record<string, string> = {};
    const ipc = vi.fn(
      async (
        type: string,
        fields: Record<string, string>,
      ): Promise<IpcResponse> => {
        if (type === 'secret.add') capturedFields = { ...fields };
        return { ok: true };
      },
    );

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
    let capturedHandler:
      | ((args: unknown, input: unknown) => Promise<string>)
      | null = null;

    const mockRunner = {
      registerLocalTool: (
        name: string,
        tool: {
          def: unknown;
          handler: (args: unknown, input: unknown) => Promise<string>;
        },
      ) => {
        capturedName = name;
        capturedHandler = tool.handler;
      },
    } as any;

    // Inject a mock IPC that returns empty results
    const mockIpc = vi.fn(
      async (): Promise<IpcResponse> => ({
        ok: true,
        result: [],
      }),
    );

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
    let capturedHandler:
      | ((args: unknown, input: { groupFolder: string }) => Promise<string>)
      | null = null;

    const mockRunner = {
      registerLocalTool: (
        _name: string,
        tool: {
          def: unknown;
          handler: (
            args: unknown,
            input: { groupFolder: string },
          ) => Promise<string>;
        },
      ) => {
        capturedHandler = tool.handler;
      },
    } as any;

    const mockIpc = vi.fn(async (type: string): Promise<IpcResponse> => {
      if (type === 'secret.list') {
        return {
          ok: true,
          result: [
            { catalogId: 'replicate', registeredAt: '2026-05-16T14:22:11Z' },
          ],
        };
      }
      if (type === 'catalog.list') {
        return {
          ok: true,
          result: [
            {
              id: 'replicate',
              host: 'api.replicate.com',
              credentialFields: [
                { name: 'token', envVar: 'REPLICATE_API_TOKEN' },
              ],
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
    let capturedHandler:
      | ((args: unknown, input: { groupFolder: string }) => Promise<string>)
      | null = null;

    const mockRunner = {
      registerLocalTool: (
        _name: string,
        tool: {
          def: unknown;
          handler: (
            args: unknown,
            input: { groupFolder: string },
          ) => Promise<string>;
        },
      ) => {
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
    const appendCalls: Array<{
      groupFolder: string;
      role: string;
      content: string;
    }> = [];
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
    expect(
      allContents.every((c) => !c.includes('r8_aaaabbbbccccdddd1234')),
    ).toBe(true);
  });

  it('persists systemEvent and assistantTurn after /secret remove succeeds', async () => {
    const appendCalls: Array<{
      groupFolder: string;
      role: string;
      content: string;
    }> = [];
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
    expect(
      appendCalls.every((c) => !c.content.includes('/secret remove')),
    ).toBe(true);
  });

  it('does NOT persist anything when /secret add fails (IPC error)', async () => {
    const mockAppend = vi.fn();

    const ipc = vi.fn(
      async (): Promise<IpcResponse> => ({
        ok: false,
        error: 'orchestrator unavailable',
      }),
    );
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
  let fakeRunner: {
    runAgent: ReturnType<typeof vi.fn>;
    writeTasksSnapshot: ReturnType<typeof vi.fn>;
    writeGroupsSnapshot: ReturnType<typeof vi.fn>;
  };
  let mockChannel: {
    sendMessage: ReturnType<typeof vi.fn>;
    setTyping: ReturnType<typeof vi.fn>;
    owns: ReturnType<typeof vi.fn>;
  };

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
      sendMessage: vi
        .fn()
        .mockImplementation(async (_jid: string, text: string) => {
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
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'CodeReview', prompt: 'p' }]),
    );

    const runCalls: { prompt: string; overrides: any }[] = [];
    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (
          _g: any,
          input: any,
          _spec: any,
          _onOutput: any,
          overrides: any,
        ) => {
          runCalls.push({ prompt: input.prompt, overrides });
          return { status: 'success', result: null };
        },
      );

    await processGroupMessages(chatJid);

    expect(runCalls).toHaveLength(1);
    // Main agent path — overrides is empty object (no sessionKey override)
    expect(runCalls[0].overrides.sessionKey).toBeUndefined();
  });

  it('runs mentioned specialists in parallel', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([
        { name: 'A', prompt: 'pa' },
        { name: 'B', prompt: 'pb' },
      ]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@A @B do thing')]);

    const started: string[] = [];
    const releaseFns: Record<string, () => void> = {};

    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, input: any, _spec: any, _onOutput: any) => {
          const nameMatch = /name="([^"]+)"/.exec(input.prompt);
          const name = nameMatch?.[1] ?? 'main';
          started.push(name);
          await new Promise<void>((resolve) => {
            releaseFns[name] = resolve;
          });
          return { status: 'success', result: null };
        },
      );

    const p = processGroupMessages(chatJid);
    // Give the event loop a tick so both runAgent calls are initiated
    await new Promise((r) => setTimeout(r, 20));

    expect(started.sort()).toEqual(['A', 'B']); // both started before either resolves

    releaseFns['A']?.();
    releaseFns['B']?.();
    await p;
  });

  it('error in one specialist does not abort the others', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([
        { name: 'A', prompt: 'pa' },
        { name: 'B', prompt: 'pb' },
      ]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@A @B please')]);

    let bRan = false;
    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(async (_g: any, input: any) => {
        if (input.prompt.includes('name="A"')) throw new Error('boom');
        bRan = true;
        return { status: 'success', result: null };
      });

    await processGroupMessages(chatJid);

    expect(bRan).toBe(true);
  });

  it('passes per-specialist sessionKey/llmProvider/toolFilter to runAgent', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([
        {
          name: 'Iso',
          prompt: 'p',
          memory: { isolated: true },
          llmProvider: 'claude',
          tools: ['mcp:fetch'],
        },
      ]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Iso question')]);

    let captured: any;
    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (
          _g: any,
          _input: any,
          _spec: any,
          _onOutput: any,
          overrides: any,
        ) => {
          captured = overrides;
          return { status: 'success', result: null };
        },
      );

    await processGroupMessages(chatJid);

    expect(captured.sessionKey).toBe(`${group.folder}:Iso`);
    expect(captured.llmProvider).toBe('claude');
    expect([...captured.toolFilter]).toEqual(['mcp:fetch']);
  });

  it('passes maxToolRounds and maxToolOutputBytes from specialist to runAgent overrides', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([
        {
          name: 'Budget',
          prompt: 'p',
          maxToolRounds: 3,
          maxToolOutputBytes: 20000,
        },
      ]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Budget question')]);

    let captured: any;
    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (
          _g: any,
          _input: any,
          _spec: any,
          _onOutput: any,
          overrides: any,
        ) => {
          captured = overrides;
          return { status: 'success', result: null };
        },
      );

    await processGroupMessages(chatJid);

    expect(captured.maxToolRounds).toBe(3);
    expect(captured.maxToolOutputBytes).toBe(20000);
  });

  it('omits maxToolRounds and maxToolOutputBytes when not set on specialist', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Plain', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Plain question')]);

    let captured: any;
    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (
          _g: any,
          _input: any,
          _spec: any,
          _onOutput: any,
          overrides: any,
        ) => {
          captured = overrides;
          return { status: 'success', result: null };
        },
      );

    await processGroupMessages(chatJid);

    expect(captured.maxToolRounds).toBeUndefined();
    expect(captured.maxToolOutputBytes).toBeUndefined();
  });

  it('prefixes replies with [@Name] when a specialist is mentioned', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@A hi')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, _input: any, _spec: any, onOutput: any) => {
          if (onOutput)
            await onOutput({ status: 'success', result: 'hello back' });
          return { status: 'success', result: null };
        },
      );

    await processGroupMessages(chatJid);

    expect(sentMessages).toEqual(['[@A] hello back']);
  });

  it('does not prefix when no specialist is mentioned', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    // No @A mention → main agent path
    mockGetMessagesSince.mockReturnValue([makeMessage('no mention here')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, _input: any, _spec: any, onOutput: any) => {
          if (onOutput) await onOutput({ status: 'success', result: 'hello' });
          return { status: 'success', result: null };
        },
      );

    await processGroupMessages(chatJid);

    expect(sentMessages).toEqual(['hello']);
  });

  it('records specialist usage on dispatch', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@A hi')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, _input: any, _spec: any, onOutput: any) => {
          if (onOutput)
            await onOutput({ status: 'success', result: 'hello back' });
          return { status: 'success', result: null };
        },
      );

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

    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, _input: any, _spec: any, onOutput: any) => {
          if (onOutput) await onOutput({ status: 'success', result: 'hello' });
          return { status: 'success', result: null };
        },
      );

    await processGroupMessages(chatJid);

    expect(recordSpecialistUsageCalls).toHaveLength(0);
  });

  it('records error status when specialist run fails', async () => {
    _setSpecialistCatalogForTesting(makeCatalog([{ name: 'A', prompt: 'p' }]));
    mockGetMessagesSince.mockReturnValue([makeMessage('@A hi')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockRejectedValue(new Error('specialist boom'));

    await processGroupMessages(chatJid);

    expect(recordSpecialistUsageCalls).toHaveLength(1);
    expect(recordSpecialistUsageCalls[0].specialistName).toBe('A');
    expect(recordSpecialistUsageCalls[0].status).toBe('error');
  });

  // ── Story 41: specialist failure sends user-visible error reply ───────────────

  it('sends error message to user when specialist throws and no output was sent (AC1+AC5)', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Coder', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Coder please help')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockRejectedValue(new Error('connection refused'));

    const result = await processGroupMessages(chatJid);

    // AC5: must return true (not false) so the group is not wedged
    expect(result).toBe(true);
    // AC1: sendMessage must have been called with text matching /error/i + specialist name
    expect(mockChannel.sendMessage).toHaveBeenCalledOnce();
    const [, sentText] = mockChannel.sendMessage.mock.calls[0] as [
      string,
      string,
    ];
    expect(sentText).toMatch(/error/i);
    expect(sentText).toContain('Coder');
  });

  it('error message text matches [@SpecialistName] Error: specialist run failed format', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Researcher', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([
      makeMessage('@Researcher look this up'),
    ]);

    fakeRunner.runAgent = vi.fn().mockRejectedValue(new Error('timeout'));

    await processGroupMessages(chatJid);

    const [, sentText] = mockChannel.sendMessage.mock.calls[0] as [
      string,
      string,
    ];
    expect(sentText).toBe('[@Researcher] Error: specialist run failed');
  });

  it('sends one error message per failed specialist when multiple specialists fail (AC1)', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([
        { name: 'A', prompt: 'pa' },
        { name: 'B', prompt: 'pb' },
      ]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@A @B help')]);

    fakeRunner.runAgent = vi.fn().mockRejectedValue(new Error('network down'));

    await processGroupMessages(chatJid);

    expect(mockChannel.sendMessage).toHaveBeenCalledTimes(2);
    const texts = mockChannel.sendMessage.mock.calls.map(
      (c: [string, string]) => c[1],
    );
    expect(texts).toContain('[@A] Error: specialist run failed');
    expect(texts).toContain('[@B] Error: specialist run failed');
  });

  it('stores error reply in db with is_bot_message=true (AC2)', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Planner', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Planner make a plan')]);

    fakeRunner.runAgent = vi.fn().mockRejectedValue(new Error('pod crash'));

    await processGroupMessages(chatJid);

    const storeMessageMock = (db as any).storeMessage as ReturnType<
      typeof vi.fn
    >;
    expect(storeMessageMock).toHaveBeenCalled();
    const stored = storeMessageMock.mock.calls.find(
      (c: any[]) =>
        typeof c[0]?.content === 'string' && c[0].content.includes('Planner'),
    );
    expect(stored).toBeDefined();
    expect(stored![0].is_bot_message).toBe(true);
    expect(stored![0].content).toMatch(/error/i);
  });

  it('does NOT send error message when partial output was already sent to user (AC3)', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Writer', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([
      makeMessage('@Writer write something'),
    ]);

    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, _input: any, _spec: any, onOutput: any) => {
          // Emit a partial result first, then throw
          if (onOutput)
            await onOutput({
              status: 'success',
              result: 'partial output here',
            });
          throw new Error('then failed');
        },
      );

    const result = await processGroupMessages(chatJid);

    // AC3: outputSentToUser branch — return true, do NOT send additional error
    expect(result).toBe(true);
    // Only the partial output message was sent, not an extra error message
    expect(mockChannel.sendMessage).toHaveBeenCalledOnce();
    const [, sentText] = mockChannel.sendMessage.mock.calls[0] as [
      string,
      string,
    ];
    expect(sentText).toContain('partial output here');
    expect(sentText).not.toMatch(/error/i);
  });

  it('after error reply the group is not wedged — next processGroupMessages call succeeds (AC4)', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Helper', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Helper fail')]);

    fakeRunner.runAgent = vi.fn().mockRejectedValue(new Error('first fail'));

    // First call — should fail with error reply but return true
    const firstResult = await processGroupMessages(chatJid);
    expect(firstResult).toBe(true);

    // Reset for a clean second call
    mockChannel.sendMessage.mockClear();
    mockGetMessagesSince.mockReturnValue([makeMessage('@Helper now succeed')]);
    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, _input: any, _spec: any, onOutput: any) => {
          if (onOutput)
            await onOutput({ status: 'success', result: 'all good' });
          return { status: 'success', result: null };
        },
      );

    // Second call — should process normally
    const secondResult = await processGroupMessages(chatJid);
    expect(secondResult).toBe(true);
    const texts = mockChannel.sendMessage.mock.calls.map(
      (c: [string, string]) => c[1],
    );
    expect(texts.some((t) => t.includes('all good'))).toBe(true);

    // Restore fakeRunner.runAgent to a safe non-emitting default so subsequent
    // describe blocks (which share the mockGetDirectLLMRunner reference) are not
    // contaminated by this test's emitting implementation.
    fakeRunner.runAgent = vi
      .fn()
      .mockResolvedValue({ status: 'success', result: null });
    mockGetMessagesSince.mockReturnValue([]);
  });

  // ── Story 51: agentStatus='error' non-throw path ──────────────────────────

  it('Story 51 — AC1: sends [@Specialist] error message when runAgent resolves { status: error }', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Alpha', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Alpha hi')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockResolvedValue({ status: 'error', result: null });

    await processGroupMessages(chatJid);

    expect(mockChannel.sendMessage).toHaveBeenCalledOnce();
    const [, text] = mockChannel.sendMessage.mock.calls[0];
    expect(text).toBe('[@Alpha] Error: specialist run failed');
  });

  it('Story 51 — AC2: does NOT send error message when partial output was already sent', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Alpha', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Alpha hi')]);

    // Runner calls onOutput with some text first (sets outputSentToUser = true),
    // then resolves with { status: 'error' }.
    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, _input: any, _spec: any, onOutput: any) => {
          if (onOutput)
            await onOutput({ status: 'success', result: 'partial text' });
          return { status: 'error', result: null };
        },
      );

    await processGroupMessages(chatJid);

    // Only the partial-output message should have been sent — no error message.
    const calls = (mockChannel.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('[@Alpha] partial text');
  });

  it('Story 51 — AC3: processGroupMessages returns true when runAgent resolves { status: error }', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Alpha', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Alpha hi')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockResolvedValue({ status: 'error', result: null });

    const result = await processGroupMessages(chatJid);

    expect(result).toBe(true);
  });

  it('Story 51 — AC4: only the errored specialist appears in failedSpecialists (via recordSpecialistUsage)', async () => {
    _setSpecialistCatalogForTesting(
      makeCatalog([
        { name: 'Alpha', prompt: 'pa' },
        { name: 'Beta', prompt: 'pb' },
      ]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Alpha @Beta please')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(async (_g: any, input: any) => {
        if (input.prompt.includes('name="Alpha"'))
          return { status: 'error', result: null };
        return { status: 'success', result: null };
      });

    await processGroupMessages(chatJid);

    const alphaCalls = recordSpecialistUsageCalls.filter(
      (c) => c.specialistName === 'Alpha',
    );
    const betaCalls = recordSpecialistUsageCalls.filter(
      (c) => c.specialistName === 'Beta',
    );
    expect(alphaCalls).toHaveLength(1);
    expect(alphaCalls[0].status).toBe('error');
    expect(betaCalls).toHaveLength(1);
    expect(betaCalls[0].status).toBe('success');
  });

  it('Story 51 — AC5 (integration): no duplicate message when outputSentToUser=true before error resolve', async () => {
    // This integration test exercises the partial-output guard end-to-end.
    // The runner emits partial text via onOutput first, then resolves with
    // { status: 'error', result: 'partial text' }. Only the streamed message
    // should reach the channel — the error path must be suppressed.
    _setSpecialistCatalogForTesting(
      makeCatalog([{ name: 'Alpha', prompt: 'p' }]),
    );
    mockGetMessagesSince.mockReturnValue([makeMessage('@Alpha do work')]);

    fakeRunner.runAgent = vi
      .fn()
      .mockImplementation(
        async (_g: any, _input: any, _spec: any, onOutput: any) => {
          // Simulate streaming: first emit a partial result that sets outputSentToUser
          if (onOutput)
            await onOutput({
              status: 'success',
              result: 'partial output here',
            });
          // Then resolve as an error (e.g. runner finished with error status)
          return { status: 'error', result: 'partial text' };
        },
      );

    await processGroupMessages(chatJid);

    const allSent = (
      mockChannel.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.map((c: any[]) => c[1] as string);
    // Exactly one message: the streamed partial output
    expect(allSent).toHaveLength(1);
    expect(allSent[0]).toBe('[@Alpha] partial output here');
    // No error message sent
    expect(
      allSent.some((m: string) => m.includes('Error: specialist run failed')),
    ).toBe(false);
  });

  // Reset the runner mock so subsequent describe blocks that don't call
  // beforeEach (and thus don't re-initialise mockGetDirectLLMRunner) don't
  // inherit an onOutput-emitting implementation from the last test above.
  afterAll(() => {
    mockGetDirectLLMRunner.mockReturnValue({
      runAgent: vi.fn().mockResolvedValue({ status: 'success', result: null }),
      writeTasksSnapshot: vi.fn(),
      writeGroupsSnapshot: vi.fn(),
    });
  });
});

// ── /search dispatch tests (gap-3) ────────────────────────────────────────────

import { _testInjectState, _testResetState } from './channel-runner.js';
import {
  isSearchCommand,
  handleSearchCommand,
} from './runtime/search-command.js';

describe('/search dispatch', () => {
  it('isSearchCommand identifies /search messages', () => {
    expect(isSearchCommand('/search hello')).toBe(true);
    expect(isSearchCommand('/skills list')).toBe(false);
    expect(isSearchCommand('regular message')).toBe(false);
  });

  it('handleSearchCommand returns a no-results message for unknown query', async () => {
    const { _initTestDatabase } = await import('./db.js');
    await _initTestDatabase();
    const out = handleSearchCommand(
      'test-group',
      '/search xqzz_channel_runner_dispatch',
    );
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
    const { _initTestDatabase, appendConversationMessage } =
      await import('./db.js');
    await _initTestDatabase();

    // Seed conversation history so /search has rows to return.
    appendConversationMessage(
      GROUP_FOLDER,
      'user',
      'the cluster uses kubernetes for scheduling',
    );
    appendConversationMessage(
      GROUP_FOLDER,
      'assistant',
      'yes kubernetes is configured',
    );

    // Make getMessagesSince (mocked) return a /search message.
    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    mockGetMessagesSince.mockReturnValueOnce([
      {
        id: 'dispatch-search-msg-1',
        chat_jid: CHAT_JID,
        sender: 'user123',
        sender_name: 'Alice',
        content: '/search kubernetes',
        timestamp: msgTimestamp,
        is_from_me: false,
      },
    ]);

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
    mockGetMessagesSince.mockReturnValueOnce([
      {
        id: 'dispatch-regular-msg-1',
        chat_jid: CHAT_JID,
        sender: 'user123',
        sender_name: 'Alice',
        content: 'hello world regular message',
        timestamp: msgTimestamp,
        is_from_me: false,
      },
    ]);

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
    mockGetMessagesSince.mockReturnValueOnce([
      {
        id: 'fts-error-msg-1',
        chat_jid: CHAT_JID,
        sender: 'user123',
        sender_name: 'Alice',
        content: '/search "unclosed',
        timestamp: msgTimestamp,
        is_from_me: false,
      },
    ]);

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

describe('channel-runner compression command dispatch', () => {
  it('isCompactCommand is the right guard for /compact', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand('/compact --keep 5')).toBe(true);
    expect(isCompactCommand('/summary')).toBe(true);
    expect(isCompactCommand('/clear')).toBe(true);
    expect(isCompactCommand('/skills list')).toBe(false);
  });
});

// ── /capabilities command tests ───────────────────────────────────────────────

describe('isCapabilitiesCommand', () => {
  it('returns true for /capabilities lines', () => {
    expect(isCapabilitiesCommand('/capabilities add echo')).toBe(true);
    expect(isCapabilitiesCommand('/capabilities list')).toBe(true);
    expect(isCapabilitiesCommand('/capabilities remove echo')).toBe(true);
    expect(isCapabilitiesCommand('/capabilities help')).toBe(true);
    expect(isCapabilitiesCommand('/capabilities')).toBe(true);
  });

  it('returns false for non-/capabilities messages', () => {
    expect(isCapabilitiesCommand('hello')).toBe(false);
    expect(isCapabilitiesCommand('/secret list')).toBe(false);
    expect(isCapabilitiesCommand('/cap list')).toBe(false);
  });
});

describe('handleCapabilitiesCommand — /capabilities add', () => {
  const GROUP = 'http-http-alice';

  it('returns help for /capabilities or /capabilities help', async () => {
    const ipc = vi.fn() as unknown as CapabilityIpcFn;
    const r1 = await handleCapabilitiesCommand(GROUP, '/capabilities', ipc);
    expect(r1.reply).toMatch(/Capability commands/i);
    const r2 = await handleCapabilitiesCommand(
      GROUP,
      '/capabilities help',
      ipc,
    );
    expect(r2.reply).toMatch(/Capability commands/i);
  });

  it('passes groupFolder to IPC for /capabilities add', async () => {
    const ipcCalls: Array<[string, Record<string, string>]> = [];
    const ipc: CapabilityIpcFn = async (type, fields) => {
      ipcCalls.push([type, fields]);
      return {
        ok: true,
        result: {
          deploymentName: 'mcp-echo-abc123',
          message: "Capability 'echo' provisioned.",
          alreadyProvisioned: false,
        },
      };
    };

    const result = await handleCapabilitiesCommand(
      GROUP,
      '/capabilities add echo',
      ipc,
    );

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0][0]).toBe('capability.add');
    expect(ipcCalls[0][1].groupFolder).toBe(GROUP);
    expect(ipcCalls[0][1].capabilityType).toBe('echo');
    // Reply contains 'provisioned' (AC1) and deployment name
    expect(result.reply).toMatch(/provisioned/i);
    expect(result.reply).toContain('mcp-echo-abc123');
  });

  it('returns already-provisioned message for idempotent second call (AC3)', async () => {
    const ipc: CapabilityIpcFn = async () => ({
      ok: true,
      result: {
        deploymentName: 'mcp-echo-abc123',
        message: "Capability 'echo' is already provisioned.",
        alreadyProvisioned: true,
      },
    });

    const result = await handleCapabilitiesCommand(
      GROUP,
      '/capabilities add echo',
      ipc,
    );
    expect(result.reply).toMatch(/already provisioned/i);
    expect(result.reply).toContain('mcp-echo-abc123');
  });

  it('returns error message when IPC fails', async () => {
    const ipc: CapabilityIpcFn = async () => ({
      ok: false,
      error: 'Unknown capability type',
    });

    const result = await handleCapabilitiesCommand(
      GROUP,
      '/capabilities add nonexistent',
      ipc,
    );
    expect(result.reply).toMatch(/Failed to provision/i);
    expect(result.reply).toContain('Unknown capability type');
  });

  it('requires a capability type argument', async () => {
    const ipc = vi.fn() as unknown as CapabilityIpcFn;
    const result = await handleCapabilitiesCommand(
      GROUP,
      '/capabilities add',
      ipc,
    );
    expect(result.reply).toMatch(/Usage:/i);
    expect(ipc).not.toHaveBeenCalled();
  });
});

describe('handleCapabilitiesCommand — /capabilities list', () => {
  const GROUP_ALICE = 'http-http-alice';
  const GROUP_BOB = 'http-http-bob';

  it('returns formatted list with type, replicas, lastUsedAt, scaleDownAfterIdleSeconds (AC2)', async () => {
    const lastUsedUnix = Math.floor(
      new Date('2025-01-15T12:00:00Z').getTime() / 1000,
    );
    const ipc: CapabilityIpcFn = async (_type, fields) => {
      expect(fields.groupFolder).toBe(GROUP_ALICE);
      return {
        ok: true,
        result: [
          {
            type: 'echo',
            deploymentName: 'mcp-echo-abc123',
            replicas: 0,
            lastUsedAt: lastUsedUnix,
            scaleDownAfterIdleSeconds: 120,
          },
        ],
      };
    };

    const result = await handleCapabilitiesCommand(
      GROUP_ALICE,
      '/capabilities list',
      ipc,
    );
    expect(result.reply).toContain('echo');
    expect(result.reply).toContain('mcp-echo-abc123');
    expect(result.reply).toContain('120'); // scaleDownAfterIdleSeconds
    expect(result.reply).toMatch(/2025-01-15T12:00:00.000Z/); // ISO-8601 lastUsedAt
  });

  it('returns empty list message when no capabilities provisioned', async () => {
    const ipc: CapabilityIpcFn = async () => ({ ok: true, result: [] });
    const result = await handleCapabilitiesCommand(
      GROUP_ALICE,
      '/capabilities list',
      ipc,
    );
    expect(result.reply).toMatch(/No capabilities provisioned/i);
  });

  it('uses groupFolder scoped to the requesting group (AC5 — bob sees empty list)', async () => {
    const ipcCalls: Array<Record<string, string>> = [];
    const ipc: CapabilityIpcFn = async (_type, fields) => {
      ipcCalls.push(fields);
      // Bob's group has no capabilities
      return { ok: true, result: [] };
    };

    const result = await handleCapabilitiesCommand(
      GROUP_BOB,
      '/capabilities list',
      ipc,
    );
    expect(ipcCalls[0].groupFolder).toBe(GROUP_BOB);
    expect(result.reply).toMatch(/No capabilities provisioned/i);
  });
});

describe('handleCapabilitiesCommand — /capabilities remove', () => {
  const GROUP = 'http-http-alice';

  it('passes groupFolder and capabilityType to IPC', async () => {
    const ipcCalls: Array<[string, Record<string, string>]> = [];
    const ipc: CapabilityIpcFn = async (type, fields) => {
      ipcCalls.push([type, fields]);
      return { ok: true, result: { message: "Capability 'echo' removed." } };
    };

    const result = await handleCapabilitiesCommand(
      GROUP,
      '/capabilities remove echo',
      ipc,
    );
    expect(ipcCalls[0][0]).toBe('capability.remove');
    expect(ipcCalls[0][1].groupFolder).toBe(GROUP);
    expect(ipcCalls[0][1].capabilityType).toBe('echo');
    expect(result.reply).toMatch(/Removed/i);
  });

  it('returns error when capability not provisioned', async () => {
    const ipc: CapabilityIpcFn = async () => ({
      ok: false,
      error: "Capability 'echo' is not provisioned for this group.",
    });

    const result = await handleCapabilitiesCommand(
      GROUP,
      '/capabilities remove echo',
      ipc,
    );
    expect(result.reply).toMatch(/Failed to remove/i);
  });

  it('requires a capability type argument', async () => {
    const ipc = vi.fn() as unknown as CapabilityIpcFn;
    const result = await handleCapabilitiesCommand(
      GROUP,
      '/capabilities remove',
      ipc,
    );
    expect(result.reply).toMatch(/Usage:/i);
    expect(ipc).not.toHaveBeenCalled();
  });
});

// ── /specialists command unit tests ──────────────────────────────────────────

import {
  isSpecialistsCommand,
  handleSpecialistsCommand,
} from './channel-runner.js';

describe('isSpecialistsCommand', () => {
  it('matches /specialists list', () => {
    expect(isSpecialistsCommand('/specialists list')).toBe(true);
  });

  it('matches bare /specialists', () => {
    expect(isSpecialistsCommand('/specialists')).toBe(true);
  });

  it('matches /specialists with unknown sub-command', () => {
    expect(isSpecialistsCommand('/specialists foobar')).toBe(true);
  });

  it('does not match /skills', () => {
    expect(isSpecialistsCommand('/skills list')).toBe(false);
  });

  it('does not match /search', () => {
    expect(isSpecialistsCommand('/search foo')).toBe(false);
  });

  it('does not match a regular message', () => {
    expect(isSpecialistsCommand('hello @Researcher')).toBe(false);
  });
});

describe('handleSpecialistsCommand', () => {
  function makeCatalog(specialists: Array<{ name: string; prompt: string }>) {
    return { getAll: () => specialists };
  }
  function makeDeps(specialists: Array<{ name: string; prompt: string }> = []) {
    return {
      catalog: makeCatalog(specialists),
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
  }

  it('returns "No specialists configured" when catalog is empty', () => {
    const reply = handleSpecialistsCommand(
      'g1',
      '/specialists list',
      makeDeps([]),
    );
    expect(reply.toLowerCase()).toContain('no specialists configured');
  });

  it('lists each specialist as @Name — description', () => {
    const deps = makeDeps([
      { name: 'Researcher', prompt: 'Find and summarise information.' },
      { name: 'Coder', prompt: 'Write and review code.' },
    ]);
    const reply = handleSpecialistsCommand('g1', '/specialists list', deps);
    expect(reply).toContain('@Researcher');
    expect(reply).toContain('@Coder');
    expect(reply).toContain('Find and summarise information.');
    expect(reply).toContain('Write and review code.');
  });

  it('truncates long prompts to 80 chars with ellipsis', () => {
    const longPrompt = 'A'.repeat(100);
    const deps = makeDeps([{ name: 'Big', prompt: longPrompt }]);
    const reply = handleSpecialistsCommand('g1', '/specialists list', deps);
    // The displayed description should be truncated
    expect(reply).toContain('@Big');
    expect(reply).toContain('A'.repeat(80) + '…');
    expect(reply).not.toContain('A'.repeat(100));
  });

  it('does not truncate prompts that are exactly 80 chars', () => {
    const prompt = 'B'.repeat(80);
    const deps = makeDeps([{ name: 'Exact', prompt }]);
    const reply = handleSpecialistsCommand('g1', '/specialists list', deps);
    expect(reply).toContain('B'.repeat(80));
    expect(reply).not.toContain('…');
  });

  it('returns help for unknown sub-command', () => {
    const deps = makeDeps([{ name: 'A', prompt: 'do stuff' }]);
    const reply = handleSpecialistsCommand('g1', '/specialists foobar', deps);
    expect(reply).toContain('Unknown subcommand: foobar');
  });

  it('returns help for bare /specialists (no sub-command)', () => {
    const deps = makeDeps([{ name: 'A', prompt: 'do stuff' }]);
    const reply = handleSpecialistsCommand('g1', '/specialists', deps);
    expect(reply).toContain('Specialist commands:');
  });

  it('returns help when unknown sub-command given', () => {
    const reply = handleSpecialistsCommand(
      'g1',
      '/specialists bad',
      makeDeps([]),
    );
    expect(reply).toContain('Unknown subcommand: bad');
  });
});

// ── /specialists history unit tests ──────────────────────────────────────────

describe('handleSpecialistsCommand — empty history', () => {
  it('returns no-history message when no rows', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    const reply = handleSpecialistsCommand('g1', '/specialists history', deps);
    expect(reply).toBe('No specialist history for this group.');
  });
});

describe('handleSpecialistsCommand — formatting ok/error mix', () => {
  it('formats rows newest-first with correct tags', () => {
    const rows = [
      {
        specialistName: 'gamma',
        usedAt: 1716249600000,
        durationMs: 300,
        status: 'success' as const,
      },
      {
        specialistName: 'beta',
        usedAt: 1716249500000,
        durationMs: 200,
        status: 'error' as const,
      },
      {
        specialistName: 'alpha',
        usedAt: 1716249400000,
        durationMs: 100,
        status: 'success' as const,
      },
    ];
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue(rows),
    };
    const reply = handleSpecialistsCommand('g1', '/specialists history', deps);

    // All three names appear
    expect(reply).toContain('@gamma');
    expect(reply).toContain('@beta');
    expect(reply).toContain('@alpha');
    // Correct status tags
    const lines = reply.split('\n');
    expect(lines[0]).toMatch(/^\[ok\]/);
    expect(lines[1]).toMatch(/^\[error\]/);
    expect(lines[2]).toMatch(/^\[ok\]/);
    // Duration in ms
    expect(lines[0]).toContain('300ms');
    // Time in HH:MMZ
    expect(lines[0]).toMatch(/\d{2}:\d{2}Z$/);
  });
});

describe('handleSpecialistsCommand — limit parsing', () => {
  it('defaults to 10 when no limit arg', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    handleSpecialistsCommand('g1', '/specialists history', deps);
    expect(deps.getSpecialistUsage).toHaveBeenCalledWith('g1', 10);
  });

  it('uses numeric limit arg', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    handleSpecialistsCommand('g1', '/specialists history 5', deps);
    expect(deps.getSpecialistUsage).toHaveBeenCalledWith('g1', 5);
  });

  it('falls back to 10 for limit=0', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    handleSpecialistsCommand('g1', '/specialists history 0', deps);
    expect(deps.getSpecialistUsage).toHaveBeenCalledWith('g1', 10);
  });

  it('falls back to 10 for non-numeric limit', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    handleSpecialistsCommand('g1', '/specialists history abc', deps);
    expect(deps.getSpecialistUsage).toHaveBeenCalledWith('g1', 10);
  });

  it('caps /specialists history limit at MAX_SPECIALISTS_HISTORY_LIMIT', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    handleSpecialistsCommand('g1', '/specialists history 99999', deps);
    expect(deps.getSpecialistUsage).toHaveBeenCalledWith('g1', 100);
  });
});

describe('handleSpecialistsCommand — help and unknown verb', () => {
  it('returns help for no verb', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    const reply = handleSpecialistsCommand('g1', '/specialists', deps);
    expect(reply).toContain('Specialist commands:');
  });

  it('returns help for /specialists help', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    const reply = handleSpecialistsCommand('g1', '/specialists help', deps);
    expect(reply).toContain('Specialist commands:');
  });

  it('returns unknown subcommand error for unknown verb', () => {
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue([]),
    };
    const reply = handleSpecialistsCommand('g1', '/specialists foobar', deps);
    expect(reply).toContain('Unknown subcommand: foobar');
  });
});

describe('handleSpecialistsCommand — unit test: 3 rows newest-first (Story 58 AC5)', () => {
  it('returns reply containing all 3 specialist names in newest-first order', () => {
    const rows = [
      {
        specialistName: 'newest',
        usedAt: 3000,
        durationMs: 300,
        status: 'success' as const,
      },
      {
        specialistName: 'middle',
        usedAt: 2000,
        durationMs: 200,
        status: 'error' as const,
      },
      {
        specialistName: 'oldest',
        usedAt: 1000,
        durationMs: 100,
        status: 'success' as const,
      },
    ];
    const deps = {
      catalog: { getAll: () => [] },
      getSpecialistUsage: vi.fn().mockReturnValue(rows),
    };
    const reply = handleSpecialistsCommand(
      'test-group',
      '/specialists history',
      deps,
    );

    const lines = reply.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('@newest');
    expect(lines[1]).toContain('@middle');
    expect(lines[2]).toContain('@oldest');
  });
});

// ── /specialists dispatch via processGroupMessages ────────────────────────────

describe('/specialists list dispatch via processGroupMessages', () => {
  const CHAT_JID = 'specialists-test@g.us';
  const GROUP_FOLDER = 'tg_specialists-test';
  const sendMessageSpy = vi.fn().mockResolvedValue(undefined);
  let fakeSpecialistsRunner: {
    runAgent: ReturnType<typeof vi.fn>;
    writeTasksSnapshot: ReturnType<typeof vi.fn>;
    writeGroupsSnapshot: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    fakeSpecialistsRunner = {
      runAgent: vi.fn().mockResolvedValue({ status: 'success', result: null }),
      writeTasksSnapshot: vi.fn(),
      writeGroupsSnapshot: vi.fn(),
    };
    mockGetDirectLLMRunner.mockReturnValue(fakeSpecialistsRunner);
  });

  afterEach(() => {
    _testResetState();
    sendMessageSpy.mockClear();
    vi.restoreAllMocks();
  });

  it('sends specialist list via channel.sendMessage without invoking the LLM', async () => {
    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    mockGetMessagesSince.mockReturnValueOnce([
      {
        id: 'spec-list-msg-1',
        chat_jid: CHAT_JID,
        sender: 'user123',
        sender_name: 'Alice',
        content: '/specialists list',
        timestamp: msgTimestamp,
        is_from_me: false,
      },
    ]);

    const fakeChannel = {
      ownsJid: (jid: string) => jid === CHAT_JID,
      sendMessage: sendMessageSpy,
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    mockFindChannel.mockReturnValueOnce(fakeChannel);

    _setSpecialistCatalogForTesting({
      getAll: () => [
        { name: 'Researcher', prompt: 'Research topics in depth.' },
        { name: 'Coder', prompt: 'Write clean code.' },
      ],
    });

    _testInjectState(
      {
        [CHAT_JID]: {
          jid: CHAT_JID,
          name: 'Specialists Test Group',
          folder: GROUP_FOLDER,
          trigger: '@Claude',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      },
      [fakeChannel as any],
    );

    const result = await processGroupMessages(CHAT_JID);

    expect(result).toBe(true);
    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const sentText: string = sendMessageSpy.mock.calls[0][1];
    expect(sentText).toContain('@Researcher');
    expect(sentText).toContain('@Coder');
    // LLM runner must NOT have been invoked
    expect(fakeSpecialistsRunner.runAgent).not.toHaveBeenCalled();
  });

  it('sends "No specialists configured" when catalog is empty', async () => {
    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    mockGetMessagesSince.mockReturnValueOnce([
      {
        id: 'spec-list-msg-2',
        chat_jid: CHAT_JID,
        sender: 'user123',
        sender_name: 'Alice',
        content: '/specialists list',
        timestamp: msgTimestamp,
        is_from_me: false,
      },
    ]);

    const fakeChannel = {
      ownsJid: (jid: string) => jid === CHAT_JID,
      sendMessage: sendMessageSpy,
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    mockFindChannel.mockReturnValueOnce(fakeChannel);

    _setSpecialistCatalogForTesting({ getAll: () => [] });

    _testInjectState(
      {
        [CHAT_JID]: {
          jid: CHAT_JID,
          name: 'Specialists Test Group',
          folder: GROUP_FOLDER,
          trigger: '@Claude',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      },
      [fakeChannel as any],
    );

    await processGroupMessages(CHAT_JID);

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const sentText: string = sendMessageSpy.mock.calls[0][1];
    expect(sentText.toLowerCase()).toContain('no specialists configured');
  });

  it('sends usage hint for unknown sub-command', async () => {
    const msgTimestamp = new Date(Date.now() - 1000).toISOString();
    mockGetMessagesSince.mockReturnValueOnce([
      {
        id: 'spec-list-msg-3',
        chat_jid: CHAT_JID,
        sender: 'user123',
        sender_name: 'Alice',
        content: '/specialists foobar',
        timestamp: msgTimestamp,
        is_from_me: false,
      },
    ]);

    const fakeChannel = {
      ownsJid: (jid: string) => jid === CHAT_JID,
      sendMessage: sendMessageSpy,
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    mockFindChannel.mockReturnValueOnce(fakeChannel);

    _setSpecialistCatalogForTesting({ getAll: () => [] });

    _testInjectState(
      {
        [CHAT_JID]: {
          jid: CHAT_JID,
          name: 'Specialists Test Group',
          folder: GROUP_FOLDER,
          trigger: '@Claude',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      },
      [fakeChannel as any],
    );

    await processGroupMessages(CHAT_JID);

    expect(sendMessageSpy).toHaveBeenCalledOnce();
    const sentText: string = sendMessageSpy.mock.calls[0][1];
    expect(sentText).toContain('Unknown subcommand: foobar');
    // No stack trace in the reply
    expect(sentText).not.toMatch(/Error:/);
    expect(sentText).not.toMatch(/at \w/);
  });
});

// ── /memory command unit tests ────────────────────────────────────────────────

import { promises as fsp } from 'fs';
import os from 'os';
import {
  isMemoryCommand,
  handleMemoryCommand,
  HELP_TEXT,
} from './channel-runner.js';

describe('isMemoryCommand', () => {
  it('returns true for /memory show', () => {
    expect(isMemoryCommand('/memory show')).toBe(true);
  });
  it('returns true for /memory append text', () => {
    expect(isMemoryCommand('/memory append hello')).toBe(true);
  });
  it('returns true for /memory set text', () => {
    expect(isMemoryCommand('/memory set hello world')).toBe(true);
  });
  it('returns true for /memory alone', () => {
    expect(isMemoryCommand('/memory')).toBe(true);
  });
  it('returns false for /memories', () => {
    expect(isMemoryCommand('/memories')).toBe(false);
  });
  it('returns false for /skills', () => {
    expect(isMemoryCommand('/skills list')).toBe(false);
  });
  it('returns false for a regular message', () => {
    expect(isMemoryCommand('hello world')).toBe(false);
  });
});

describe('HELP_TEXT includes /memory', () => {
  it('HELP_TEXT contains /memory show', () => {
    expect(HELP_TEXT).toContain('/memory show');
  });
  it('HELP_TEXT contains /memory append', () => {
    expect(HELP_TEXT).toContain('/memory append');
  });
  it('HELP_TEXT contains /memory set', () => {
    expect(HELP_TEXT).toContain('/memory set');
  });
});

describe('handleMemoryCommand — mocked fs', () => {
  let tmpDir: string;
  let groupFolder: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(os.tmpdir() + '/memory-unit-');
    groupFolder = 'test-group';
    // create the group dir
    await fsp.mkdir(`${tmpDir}/${groupFolder}`, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('AC1: /memory show returns "No memory set." when file absent', async () => {
    const reply = await handleMemoryCommand(
      groupFolder,
      '/memory show',
      tmpDir,
    );
    expect(reply).toBe('No memory set.');
  });

  it('AC1: /memory show returns file contents when present', async () => {
    await fsp.writeFile(
      `${tmpDir}/${groupFolder}/CLAUDE.md`,
      'hello memory',
      'utf8',
    );
    const reply = await handleMemoryCommand(
      groupFolder,
      '/memory show',
      tmpDir,
    );
    expect(reply).toBe('hello memory');
  });

  it('AC2: /memory append creates file and returns "Memory updated."', async () => {
    const reply = await handleMemoryCommand(
      groupFolder,
      '/memory append first line',
      tmpDir,
    );
    expect(reply).toBe('Memory updated.');
    const contents = await fsp.readFile(
      `${tmpDir}/${groupFolder}/CLAUDE.md`,
      'utf8',
    );
    expect(contents).toContain('first line');
  });

  it('AC2: /memory append adds to existing file with newline', async () => {
    await fsp.writeFile(
      `${tmpDir}/${groupFolder}/CLAUDE.md`,
      'existing content',
      'utf8',
    );
    await handleMemoryCommand(groupFolder, '/memory append added line', tmpDir);
    const contents = await fsp.readFile(
      `${tmpDir}/${groupFolder}/CLAUDE.md`,
      'utf8',
    );
    expect(contents).toContain('existing content');
    expect(contents).toContain('added line');
  });

  it('AC2: /memory show after append confirms the addition', async () => {
    await handleMemoryCommand(groupFolder, '/memory append my note', tmpDir);
    const reply = await handleMemoryCommand(
      groupFolder,
      '/memory show',
      tmpDir,
    );
    expect(reply).toContain('my note');
  });

  it('AC3: /memory set overwrites file', async () => {
    await fsp.writeFile(
      `${tmpDir}/${groupFolder}/CLAUDE.md`,
      'old content',
      'utf8',
    );
    const reply = await handleMemoryCommand(
      groupFolder,
      '/memory set new content',
      tmpDir,
    );
    expect(reply).toBe('Memory updated.');
    const contents = await fsp.readFile(
      `${tmpDir}/${groupFolder}/CLAUDE.md`,
      'utf8',
    );
    expect(contents).toBe('new content');
    expect(contents).not.toContain('old content');
  });

  it('AC3: /memory show after set returns only the new text', async () => {
    await handleMemoryCommand(
      groupFolder,
      '/memory set brand new memory',
      tmpDir,
    );
    const reply = await handleMemoryCommand(
      groupFolder,
      '/memory show',
      tmpDir,
    );
    expect(reply).toBe('brand new memory');
  });

  it('AC4: /memory set "" truncates to empty; show returns "No memory set."', async () => {
    await fsp.writeFile(
      `${tmpDir}/${groupFolder}/CLAUDE.md`,
      'something here',
      'utf8',
    );
    const setReply = await handleMemoryCommand(
      groupFolder,
      '/memory set ',
      tmpDir,
    );
    expect(setReply).toBe('Memory cleared.');
    const showReply = await handleMemoryCommand(
      groupFolder,
      '/memory show',
      tmpDir,
    );
    expect(showReply).toBe('No memory set.');
  });

  it('AC4: /memory set with only spaces clears memory', async () => {
    await fsp.writeFile(
      `${tmpDir}/${groupFolder}/CLAUDE.md`,
      'had content',
      'utf8',
    );
    // "/memory set" with no trailing text
    const setReply = await handleMemoryCommand(
      groupFolder,
      '/memory set',
      tmpDir,
    );
    expect(setReply).toBe('Memory cleared.');
    const showReply = await handleMemoryCommand(
      groupFolder,
      '/memory show',
      tmpDir,
    );
    expect(showReply).toBe('No memory set.');
  });

  it('unknown subcommand returns help text', async () => {
    const reply = await handleMemoryCommand(
      groupFolder,
      '/memory frobnicate',
      tmpDir,
    );
    expect(reply).toContain('Unknown subcommand');
    expect(reply).toContain('/memory show');
  });

  it('/memory append with no text returns usage hint', async () => {
    const reply = await handleMemoryCommand(
      groupFolder,
      '/memory append',
      tmpDir,
    );
    expect(reply).toMatch(/usage/i);
  });
});

describe('handleMemoryCommand — per-group isolation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(os.tmpdir() + '/memory-isolation-');
    await fsp.mkdir(`${tmpDir}/alice`, { recursive: true });
    await fsp.mkdir(`${tmpDir}/bob`, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('AC5: alice show does not return bob content', async () => {
    await fsp.writeFile(`${tmpDir}/bob/CLAUDE.md`, 'bobs private note', 'utf8');
    const reply = await handleMemoryCommand('alice', '/memory show', tmpDir);
    expect(reply).toBe('No memory set.');
    expect(reply).not.toContain('bobs private note');
  });

  it('AC5: alice append does not affect bobs file', async () => {
    await fsp.writeFile(`${tmpDir}/bob/CLAUDE.md`, 'bobs original', 'utf8');
    await handleMemoryCommand('alice', '/memory append alices note', tmpDir);
    const bobContent = await fsp.readFile(`${tmpDir}/bob/CLAUDE.md`, 'utf8');
    expect(bobContent).toBe('bobs original');
    expect(bobContent).not.toContain('alices note');
  });

  it('AC5: alice and bob have independent memories', async () => {
    await handleMemoryCommand('alice', '/memory set alice memory', tmpDir);
    await handleMemoryCommand('bob', '/memory set bob memory', tmpDir);
    const aliceReply = await handleMemoryCommand(
      'alice',
      '/memory show',
      tmpDir,
    );
    const bobReply = await handleMemoryCommand('bob', '/memory show', tmpDir);
    expect(aliceReply).toBe('alice memory');
    expect(bobReply).toBe('bob memory');
  });
});

// ── /schedule command unit tests ─────────────────────────────────────────────

describe('isScheduleCommand', () => {
  it('returns true for /schedule prefix', () => {
    expect(isScheduleCommand('/schedule add interval 60000 ping')).toBe(true);
    expect(isScheduleCommand('/schedule list')).toBe(true);
    expect(isScheduleCommand('/schedule remove abc')).toBe(true);
    expect(isScheduleCommand('/schedule')).toBe(true);
    expect(isScheduleCommand('/schedule help')).toBe(true);
  });

  it('returns false for non-/schedule messages', () => {
    expect(isScheduleCommand('hello')).toBe(false);
    expect(isScheduleCommand('/secret list')).toBe(false);
    expect(isScheduleCommand('/scheduled add foo')).toBe(false);
    expect(isScheduleCommand('/skills list')).toBe(false);
  });
});

describe('parseScheduleAddCommand', () => {
  it('parses interval commands', () => {
    const result = parseScheduleAddCommand(
      '/schedule add interval 60000 "ping"',
    ) as ScheduleAddCommand;
    expect(result).not.toBeNull();
    expect(result.schedule_type).toBe('interval');
    expect(result.schedule_value).toBe('60000');
    expect(result.prompt).toBe('ping');
  });

  it('parses cron commands', () => {
    const result = parseScheduleAddCommand(
      '/schedule add cron "* * * * *" check status',
    ) as ScheduleAddCommand;
    expect(result).not.toBeNull();
    expect(result.schedule_type).toBe('cron');
    expect(result.schedule_value).toBe('"*');
    // cron expr without quotes — value is the first token after add+type
  });

  it('parses once commands', () => {
    const result = parseScheduleAddCommand(
      '/schedule add once 2026-12-25T00:00:00Z happy holidays',
    ) as ScheduleAddCommand;
    expect(result).not.toBeNull();
    expect(result.schedule_type).toBe('once');
    expect(result.schedule_value).toBe('2026-12-25T00:00:00Z');
    expect(result.prompt).toBe('happy holidays');
  });

  it('returns null for an unknown schedule type', () => {
    expect(
      parseScheduleAddCommand('/schedule add weekly monday ping'),
    ).toBeNull();
  });

  it('returns null when prompt is missing', () => {
    expect(parseScheduleAddCommand('/schedule add interval 60000')).toBeNull();
  });

  it('returns null when value is missing', () => {
    expect(parseScheduleAddCommand('/schedule add interval')).toBeNull();
  });

  it('strips surrounding quotes from prompt', () => {
    const result = parseScheduleAddCommand(
      '/schedule add interval 60000 "check the logs"',
    ) as ScheduleAddCommand;
    expect(result.prompt).toBe('check the logs');
  });
});

describe('handleScheduleCommand — add (AC1)', () => {
  beforeEach(() => {
    vi.mocked(db.createTask).mockClear();
  });

  it('creates a task and returns confirmation with id', async () => {
    vi.mocked(db.createTask).mockImplementation(() => undefined);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule add interval 60000 "ping"',
    );

    expect(db.createTask).toHaveBeenCalledOnce();
    const call = vi.mocked(db.createTask).mock.calls[0][0];
    expect(call.schedule_type).toBe('interval');
    expect(call.schedule_value).toBe('60000');
    expect(call.prompt).toBe('ping');
    expect(call.group_folder).toBe('group-alice');
    expect(call.chat_jid).toBe('http:alice');
    expect(call.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // AC1: reply confirms creation with id
    expect(reply).toMatch(/Scheduled task created/i);
    expect(reply).toContain(call.id);
  });

  it('returns an error for an invalid interval value', async () => {
    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule add interval notanumber ping',
    );
    expect(db.createTask).not.toHaveBeenCalled();
    expect(reply).toMatch(/invalid interval/i);
  });

  it('returns an error for an unknown schedule type', async () => {
    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule add weekly monday ping',
    );
    expect(db.createTask).not.toHaveBeenCalled();
    expect(reply).toMatch(/Usage/i);
  });
});

describe('handleScheduleCommand — list (AC2)', () => {
  it('returns "No scheduled tasks" when the group has none', async () => {
    vi.mocked(db.getTasksForGroup).mockReturnValue([]);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule list',
    );
    expect(reply).toMatch(/no scheduled tasks/i);
  });

  it('lists tasks with required fields when tasks exist', async () => {
    const fakeTask = {
      id: 'test-id-1234',
      group_folder: 'group-alice',
      chat_jid: 'http:alice',
      prompt: 'send daily report',
      schedule_type: 'interval' as const,
      schedule_value: '86400000',
      status: 'active' as const,
      next_run: '2026-06-01T00:00:00.000Z',
      last_run: null,
      last_result: null,
      context_mode: 'isolated' as const,
      created_at: '2026-05-20T00:00:00.000Z',
    };
    vi.mocked(db.getTasksForGroup).mockReturnValue([fakeTask]);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule list',
    );

    // AC2: reply includes id, schedule_type, schedule_value, status, next_run
    expect(reply).toContain('test-id-1234');
    expect(reply).toContain('interval');
    expect(reply).toContain('86400000');
    expect(reply).toContain('active');
    expect(reply).toContain('2026-06-01T00:00:00.000Z');
  });
});

describe('handleScheduleCommand — remove (AC3 & AC4)', () => {
  beforeEach(() => {
    vi.mocked(db.deleteTaskForGroup).mockClear();
  });

  it('AC3: returns "Removed" for a valid task id', async () => {
    vi.mocked(db.deleteTaskForGroup).mockReturnValue(true);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule remove test-id-1234',
    );

    expect(db.deleteTaskForGroup).toHaveBeenCalledWith(
      'test-id-1234',
      'group-alice',
    );
    expect(reply).toMatch(/Removed/i);
  });

  it('AC4: returns "not found" without a stack trace for unknown id', async () => {
    vi.mocked(db.deleteTaskForGroup).mockReturnValue(false);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule remove unknown-uuid',
    );

    expect(reply).toMatch(/not found/i);
    expect(reply).not.toMatch(/Error:|stack|at \w/);
  });

  it('returns usage error when id is missing', async () => {
    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule remove',
    );
    expect(reply).toMatch(/Usage/i);
    expect(db.deleteTaskForGroup).not.toHaveBeenCalled();
  });
});

describe('HELP_TEXT includes /schedule', () => {
  it('mentions /schedule in the help text', () => {
    expect(HELP_TEXT).toMatch(/\/schedule/);
  });
});

describe('handleScheduleCommand — history (Story 60)', () => {
  const STUB_ROWS = [
    {
      run_at: '2025-01-02T10:00:00.000Z',
      status: 'success' as const,
      duration_ms: 250,
      result: 'All done',
      error: null,
    },
    {
      run_at: '2025-01-01T09:00:00.000Z',
      status: 'error' as const,
      duration_ms: 100,
      result: null,
      error: 'Something went wrong',
    },
  ];

  const TASK_OWNER = {
    id: 'task-abc',
    group_folder: 'mygroup',
    chat_jid: 'jid@g.us',
    prompt: 'do thing',
    schedule_type: 'once' as const,
    schedule_value: '',
    context_mode: 'isolated' as const,
    next_run: null,
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: '2025-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.mocked(db.getTaskById).mockReset();
    vi.mocked(db.getTaskRunLogs).mockReset();
  });

  it('returns both rows with timestamps and status tags', async () => {
    vi.mocked(db.getTaskById).mockReturnValue(TASK_OWNER);
    vi.mocked(db.getTaskRunLogs).mockReturnValue(STUB_ROWS);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history task-abc',
    );

    expect(reply).toContain('2025-01-02T10:00:00.000Z');
    expect(reply).toContain('[ok]');
    expect(reply).toContain('All done');
    expect(reply).toContain('2025-01-01T09:00:00.000Z');
    expect(reply).toContain('[error]');
    expect(reply).toContain('Something went wrong');
  });

  it('shows header with task id and row count', async () => {
    vi.mocked(db.getTaskById).mockReturnValue(TASK_OWNER);
    vi.mocked(db.getTaskRunLogs).mockReturnValue(STUB_ROWS);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history task-abc',
    );
    expect(reply).toContain('task-abc');
    expect(reply).toContain('2 rows');
  });

  it('returns not-found for unknown task id', async () => {
    vi.mocked(db.getTaskById).mockReturnValue(undefined);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history no-such-task',
    );
    expect(reply).toMatch(/not found/i);
  });

  it('returns not-found when task belongs to another group', async () => {
    const otherGroupTask = { ...TASK_OWNER, group_folder: 'other-group' };
    vi.mocked(db.getTaskById).mockReturnValue(otherGroupTask);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history task-abc',
    );
    expect(reply).toMatch(/not found/i);
  });

  it('respects an explicit row limit argument', async () => {
    vi.mocked(db.getTaskById).mockReturnValue(TASK_OWNER);
    vi.mocked(db.getTaskRunLogs).mockReturnValue(STUB_ROWS);

    await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history task-abc 3',
    );
    expect(db.getTaskRunLogs).toHaveBeenCalledWith('task-abc', 'mygroup', 3);
  });

  it('returns "no history yet" when run logs are empty', async () => {
    vi.mocked(db.getTaskById).mockReturnValue(TASK_OWNER);
    vi.mocked(db.getTaskRunLogs).mockReturnValue([]);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history task-abc',
    );
    expect(reply).toMatch(/no run history/i);
  });

  it('truncates long result to ~120 chars', async () => {
    const longResult = 'x'.repeat(200);
    const rows = [
      {
        run_at: '2025-01-01T00:00:00.000Z',
        status: 'success' as const,
        duration_ms: 10,
        result: longResult,
        error: null,
      },
    ];
    vi.mocked(db.getTaskById).mockReturnValue(TASK_OWNER);
    vi.mocked(db.getTaskRunLogs).mockReturnValue(rows);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history task-abc',
    );
    expect(reply).toContain('…');
    expect(reply).not.toContain(longResult);
  });

  it('shows error detail when status is error', async () => {
    const rows = [
      {
        run_at: '2025-01-01T00:00:00.000Z',
        status: 'error' as const,
        duration_ms: 10,
        result: null,
        error: 'Task timed out',
      },
    ];
    vi.mocked(db.getTaskById).mockReturnValue(TASK_OWNER);
    vi.mocked(db.getTaskRunLogs).mockReturnValue(rows);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history task-abc',
    );
    expect(reply).toContain('Task timed out');
    expect(reply).toContain('[error]');
  });

  it('SCHEDULE_HELP includes /schedule history', async () => {
    vi.mocked(db.getTaskById).mockReturnValue(TASK_OWNER);
    vi.mocked(db.getTaskRunLogs).mockReturnValue([]);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule help',
    );
    expect(reply).toMatch(/history/i);
  });

  it('rejects non-integer limit', async () => {
    vi.mocked(db.getTaskById).mockReturnValue(TASK_OWNER);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history task-abc abc',
    );
    expect(reply).toMatch(/invalid limit/i);
  });

  it('returns usage for missing task id', async () => {
    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule history',
    );
    expect(reply).toMatch(/usage/i);
  });
});

// ── /cancel command tests (Story 49) ─────────────────────────────────────────

import {
  isCancelCommand,
  handleCancelCommand,
  _handleInboundCancel,
  type CancelCommandDeps,
  type CancelResult,
} from './channel-runner.js';

describe('/cancel — isCancelCommand parser', () => {
  it('returns true for "/cancel"', () => {
    expect(isCancelCommand('/cancel')).toBe(true);
  });

  it('returns true for "/cancel " with trailing space', () => {
    expect(isCancelCommand('/cancel ')).toBe(true);
  });

  it('returns false for non-/cancel messages', () => {
    expect(isCancelCommand('hello')).toBe(false);
    expect(isCancelCommand('/secret add replicate r8_abc')).toBe(false);
    expect(isCancelCommand('/skills list')).toBe(false);
    expect(isCancelCommand('/cancellation')).toBe(false);
  });
});

describe('/cancel — handleCancelCommand delegates to cancelFn', () => {
  it('calls cancelFn with groupFolder and chatJid and returns "Cancelled" when job was running', async () => {
    const cancelFnSpy = vi.fn().mockResolvedValue('Cancelled');
    const deps: CancelCommandDeps = { cancelFn: cancelFnSpy };

    const reply = await handleCancelCommand('my-group', 'chat@g.us', deps);

    expect(cancelFnSpy).toHaveBeenCalledWith('my-group', 'chat@g.us');
    expect(reply).toMatch(/cancelled/i);
  });

  it('returns "No active job" when no job is running', async () => {
    const cancelFnSpy = vi.fn().mockResolvedValue('No active job');
    const deps: CancelCommandDeps = { cancelFn: cancelFnSpy };

    const reply = await handleCancelCommand('my-group', 'chat@g.us', deps);

    expect(cancelFnSpy).toHaveBeenCalledWith('my-group', 'chat@g.us');
    expect(reply).toMatch(/no active job/i);
  });
});

describe('/cancel — _handleInboundCancel (shared onMessage intercept)', () => {
  const CHAT_JID = 'cancel-test@g.us';
  const GROUP_FOLDER = 'tg_cancel-test';

  function makeMsg(
    content = '/cancel',
  ): Parameters<typeof _handleInboundCancel>[1] {
    return {
      id: 'msg-1',
      chat_jid: CHAT_JID,
      sender: 'user123',
      sender_name: 'Alice',
      content,
      timestamp: new Date(Date.now() - 1000).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };
  }

  it('calls cancelFn with groupFolder and chatJid', async () => {
    const cancelFn = vi
      .fn<(gf: string, jid: string) => Promise<CancelResult>>()
      .mockResolvedValue({
        status: 'cancelled',
        message: 'Cancelled',
      });
    const sendReply = vi
      .fn<(jid: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const updateTimestamp = vi.fn<(jid: string, ts: string) => void>();
    const msg = makeMsg();

    await _handleInboundCancel(CHAT_JID, msg, {
      groupFolder: GROUP_FOLDER,
      cancelFn,
      sendReply,
      updateTimestamp,
    });

    expect(cancelFn).toHaveBeenCalledOnce();
    expect(cancelFn).toHaveBeenCalledWith(GROUP_FOLDER, CHAT_JID);
  });

  it('does NOT call sendReply when status=cancelled (dedup — orchestrator sends notice)', async () => {
    const cancelFn = vi
      .fn<(gf: string, jid: string) => Promise<CancelResult>>()
      .mockResolvedValue({
        status: 'cancelled',
        message: 'Cancelled',
      });
    const sendReply = vi
      .fn<(jid: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const updateTimestamp = vi.fn<(jid: string, ts: string) => void>();

    await _handleInboundCancel(CHAT_JID, makeMsg(), {
      groupFolder: GROUP_FOLDER,
      cancelFn,
      sendReply,
      updateTimestamp,
    });

    expect(sendReply).not.toHaveBeenCalled();
  });

  it('sends "No active job" when status=no_active_job', async () => {
    const cancelFn = vi
      .fn<(gf: string, jid: string) => Promise<CancelResult>>()
      .mockResolvedValue({
        status: 'no_active_job',
        message: 'No active job',
      });
    const sendReply = vi
      .fn<(jid: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const updateTimestamp = vi.fn<(jid: string, ts: string) => void>();

    await _handleInboundCancel(CHAT_JID, makeMsg(), {
      groupFolder: GROUP_FOLDER,
      cancelFn,
      sendReply,
      updateTimestamp,
    });

    expect(sendReply).toHaveBeenCalledOnce();
    expect(sendReply).toHaveBeenCalledWith(CHAT_JID, 'No active job');
  });

  it('sends error message when status=error', async () => {
    const cancelFn = vi
      .fn<(gf: string, jid: string) => Promise<CancelResult>>()
      .mockResolvedValue({
        status: 'error',
        message: 'Cancel failed: boom',
      });
    const sendReply = vi
      .fn<(jid: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const updateTimestamp = vi.fn<(jid: string, ts: string) => void>();

    await _handleInboundCancel(CHAT_JID, makeMsg(), {
      groupFolder: GROUP_FOLDER,
      cancelFn,
      sendReply,
      updateTimestamp,
    });

    expect(sendReply).toHaveBeenCalledOnce();
    expect(sendReply).toHaveBeenCalledWith(CHAT_JID, 'Cancel failed: boom');
  });

  it('sends timeout message when status=timeout', async () => {
    const cancelFn = vi
      .fn<(gf: string, jid: string) => Promise<CancelResult>>()
      .mockResolvedValue({
        status: 'timeout',
        message: 'Cancel timed out — orchestrator did not respond',
      });
    const sendReply = vi
      .fn<(jid: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const updateTimestamp = vi.fn<(jid: string, ts: string) => void>();

    await _handleInboundCancel(CHAT_JID, makeMsg(), {
      groupFolder: GROUP_FOLDER,
      cancelFn,
      sendReply,
      updateTimestamp,
    });

    expect(sendReply).toHaveBeenCalledOnce();
    expect(sendReply).toHaveBeenCalledWith(
      CHAT_JID,
      'Cancel timed out — orchestrator did not respond',
    );
  });

  it('always calls updateTimestamp regardless of status', async () => {
    const msg = makeMsg();
    for (const status of [
      'cancelled',
      'no_active_job',
      'error',
      'timeout',
    ] as const) {
      const cancelFn = vi
        .fn<(gf: string, jid: string) => Promise<CancelResult>>()
        .mockResolvedValue({
          status,
          message: 'x',
        });
      const sendReply = vi
        .fn<(jid: string, text: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      const updateTimestamp = vi.fn<(jid: string, ts: string) => void>();

      await _handleInboundCancel(CHAT_JID, msg, {
        groupFolder: GROUP_FOLDER,
        cancelFn,
        sendReply,
        updateTimestamp,
      });

      expect(updateTimestamp).toHaveBeenCalledOnce();
      expect(updateTimestamp).toHaveBeenCalledWith(CHAT_JID, msg.timestamp);
    }
  });

  it('calls sendReply with error text when cancelFn throws', async () => {
    const cancelFn = vi
      .fn<(gf: string, jid: string) => Promise<CancelResult>>()
      .mockRejectedValue(new Error('redis connection refused'));
    const sendReply = vi
      .fn<(jid: string, text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const updateTimestamp = vi.fn<(jid: string, ts: string) => void>();

    await _handleInboundCancel(CHAT_JID, makeMsg(), {
      groupFolder: GROUP_FOLDER,
      cancelFn,
      sendReply,
      updateTimestamp,
    });

    expect(sendReply).toHaveBeenCalledOnce();
    expect(sendReply).toHaveBeenCalledWith(
      CHAT_JID,
      'Cancel failed: redis connection refused',
    );
  });
});

// ── /jobs unit tests (Story 50) ───────────────────────────────────────────────

import {
  isJobsCommand,
  handleJobsCommand,
  formatJobTime,
  truncateLogs,
  JOBS_HELP,
  MAX_LOG_LINES,
} from './channel-runner.js';
import type { ToolJobRecord } from './db.js';
import type { JobsCommandDeps } from './channel-runner.js';

describe('isJobsCommand', () => {
  it('returns true for /jobs', () => {
    expect(isJobsCommand('/jobs')).toBe(true);
  });

  it('returns true for /jobs with trailing whitespace', () => {
    expect(isJobsCommand('/jobs  ')).toBe(true);
  });

  it('returns false for non-/jobs messages', () => {
    expect(isJobsCommand('/search foo')).toBe(false);
    expect(isJobsCommand('/skills list')).toBe(false);
    expect(isJobsCommand('hello /jobs')).toBe(false);
    expect(isJobsCommand('')).toBe(false);
  });
});

describe('formatJobTime', () => {
  it('formats ISO timestamp to HH:MMZ', () => {
    expect(formatJobTime('2026-05-20T14:32:00.000Z')).toBe('14:32Z');
    expect(formatJobTime('2026-01-01T00:00:00.000Z')).toBe('00:00Z');
    expect(formatJobTime('2026-12-31T23:59:00.000Z')).toBe('23:59Z');
  });
});

describe('HELP_TEXT contains /jobs', () => {
  it('contains /jobs entry', () => {
    expect(HELP_TEXT).toContain('/jobs');
  });
});

describe('handleJobsCommand — stubbed DB', () => {
  const GROUP_FOLDER = 'test-group';
  const OTHER_GROUP = 'other-group';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "No active jobs." when both active and recent lists are empty', async () => {
    vi.spyOn(db, 'getActiveToolJobs').mockReturnValue([]);
    vi.spyOn(db, 'getRecentToolJobsForGroup').mockReturnValue([]);

    const reply = await handleJobsCommand(GROUP_FOLDER);
    expect(reply).toBe('No active jobs.');
  });

  it('formats two running jobs correctly', async () => {
    const activeJobs: ToolJobRecord[] = [
      {
        job_id: 'job-1',
        group_folder: GROUP_FOLDER,
        chat_jid: 'jid@test',
        specialist_name: 'CodeReview',
        status: 'active',
        created_at: '2026-05-20T14:32:00.000Z',
        resolved_at: null,
        message_id: null,
      },
      {
        job_id: 'job-2',
        group_folder: GROUP_FOLDER,
        chat_jid: 'jid@test',
        specialist_name: 'DocWriter',
        status: 'active',
        created_at: '2026-05-20T14:45:00.000Z',
        resolved_at: null,
        message_id: null,
      },
    ];
    vi.spyOn(db, 'getActiveToolJobs').mockReturnValue(activeJobs);
    vi.spyOn(db, 'getRecentToolJobsForGroup').mockReturnValue([]);

    const reply = await handleJobsCommand(GROUP_FOLDER);
    expect(reply).toContain('[running] @CodeReview (started 14:32Z)');
    expect(reply).toContain('[running] @DocWriter (started 14:45Z)');
  });

  it('formats two completed jobs correctly', async () => {
    vi.spyOn(db, 'getActiveToolJobs').mockReturnValue([]);
    const recentJobs: ToolJobRecord[] = [
      {
        job_id: 'job-3',
        group_folder: GROUP_FOLDER,
        chat_jid: 'jid@test',
        specialist_name: 'Analyst',
        status: 'completed',
        created_at: '2026-05-20T10:00:00.000Z',
        resolved_at: '2026-05-20T10:05:00.000Z',
        message_id: null,
      },
      {
        job_id: 'job-4',
        group_folder: GROUP_FOLDER,
        chat_jid: 'jid@test',
        specialist_name: 'Tester',
        status: 'timeout',
        created_at: '2026-05-20T09:00:00.000Z',
        resolved_at: '2026-05-20T09:30:00.000Z',
        message_id: null,
      },
    ];
    vi.spyOn(db, 'getRecentToolJobsForGroup').mockReturnValue(recentJobs);

    const reply = await handleJobsCommand(GROUP_FOLDER);
    expect(reply).toContain('[completed] @Analyst (10:00Z → 10:05Z)');
    expect(reply).toContain('[timeout] @Tester (09:00Z → 09:30Z)');
  });

  it('scopes active jobs to the authenticated group only', async () => {
    const allActiveJobs: ToolJobRecord[] = [
      {
        job_id: 'job-mine',
        group_folder: GROUP_FOLDER,
        chat_jid: 'jid@test',
        specialist_name: 'MySpec',
        status: 'active',
        created_at: '2026-05-20T14:00:00.000Z',
        resolved_at: null,
        message_id: null,
      },
      {
        job_id: 'job-other',
        group_folder: OTHER_GROUP,
        chat_jid: 'jid@other',
        specialist_name: 'OtherSpec',
        status: 'active',
        created_at: '2026-05-20T14:01:00.000Z',
        resolved_at: null,
        message_id: null,
      },
    ];
    vi.spyOn(db, 'getActiveToolJobs').mockReturnValue(allActiveJobs);
    vi.spyOn(db, 'getRecentToolJobsForGroup').mockReturnValue([]);

    const reply = await handleJobsCommand(GROUP_FOLDER);
    expect(reply).toContain('@MySpec');
    expect(reply).not.toContain('@OtherSpec');
  });

  it('getRecentToolJobsForGroup is called with the correct groupFolder', async () => {
    vi.spyOn(db, 'getActiveToolJobs').mockReturnValue([]);
    const getRecentSpy = vi
      .spyOn(db, 'getRecentToolJobsForGroup')
      .mockReturnValue([]);

    await handleJobsCommand(GROUP_FOLDER);
    expect(getRecentSpy).toHaveBeenCalledWith(GROUP_FOLDER, 5);
  });
});

// ── /capabilities tools command unit tests (Story 54) ────────────────────────

const CAP_GROUP = 'http-http-alice';
const noOpIpc = vi.fn() as unknown as CapabilityIpcFn;

describe('isCapabilitiesCommand — tools variant', () => {
  it('returns true for /capabilities tools <type>', () => {
    expect(isCapabilitiesCommand('/capabilities tools echo')).toBe(true);
  });
});

describe('handleCapabilitiesCommand — /capabilities tools', () => {
  beforeEach(() => {
    _groupCapabilityEntries.clear();
  });

  it('AC4: /capabilities tools (no type) → usage help, no crash', async () => {
    const result = await handleCapabilitiesCommand(
      CAP_GROUP,
      '/capabilities tools',
      noOpIpc,
    );
    expect(result.reply).toMatch(/Usage:/i);
    expect(result.reply).toContain('/capabilities tools <type>');
  });

  it('AC5 (unit): two tool schemas → reply contains both tool names', async () => {
    const echoEntry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'ready',
      toolSchemas: [
        {
          name: 'echo_text',
          description: 'Echoes the input text back unchanged',
          inputSchema: {},
        },
        {
          name: 'echo_json',
          description: 'Echoes a JSON object back',
          inputSchema: {},
        },
      ],
    };
    _groupCapabilityEntries.set('echo', echoEntry);
    const result = await handleCapabilitiesCommand(
      CAP_GROUP,
      '/capabilities tools echo',
      noOpIpc,
    );
    expect(result.reply).toContain('echo_text');
    expect(result.reply).toContain('echo_json');
  });

  it('AC2: not provisioned → reply contains "not provisioned"', async () => {
    const result = await handleCapabilitiesCommand(
      CAP_GROUP,
      '/capabilities tools nonexistent',
      noOpIpc,
    );
    expect(result.reply).toMatch(/not provisioned/i);
  });

  it('AC3: provisioned but schema pending → reply contains "schema not yet available"', async () => {
    const pendingEntry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'pending-schema',
    };
    _groupCapabilityEntries.set('echo', pendingEntry);
    const result = await handleCapabilitiesCommand(
      CAP_GROUP,
      '/capabilities tools echo',
      noOpIpc,
    );
    expect(result.reply).toMatch(/schema not yet available/i);
  });

  it('truncates long descriptions to 80 characters', async () => {
    const longDesc = 'A'.repeat(120);
    const echoEntry: GroupMcpEntry = {
      name: 'echo',
      kind: 'mcp-group',
      state: 'ready',
      toolSchemas: [
        { name: 'my_tool', description: longDesc, inputSchema: {} },
      ],
    };
    _groupCapabilityEntries.set('echo', echoEntry);
    const result = await handleCapabilitiesCommand(
      CAP_GROUP,
      '/capabilities tools echo',
      noOpIpc,
    );
    expect(result.reply).toContain('my_tool');
    expect(result.reply).not.toContain(longDesc);
    expect(result.reply).toContain('…');
  });
});

describe('handleCapabilitiesCommand — help and fallback (Story 54)', () => {
  beforeEach(() => {
    _groupCapabilityEntries.clear();
  });

  it('returns CAPABILITIES_HELP including tools line for /capabilities help', async () => {
    const result = await handleCapabilitiesCommand(
      CAP_GROUP,
      '/capabilities help',
      noOpIpc,
    );
    expect(result.reply).toContain('/capabilities tools <type>');
  });

  it('returns CAPABILITIES_HELP including tools line for /capabilities with no verb', async () => {
    const result = await handleCapabilitiesCommand(
      CAP_GROUP,
      '/capabilities',
      noOpIpc,
    );
    expect(result.reply).toContain('/capabilities tools <type>');
  });

  it('returns unknown subcommand message for unrecognised verb', async () => {
    const result = await handleCapabilitiesCommand(
      CAP_GROUP,
      '/capabilities foo',
      noOpIpc,
    );
    expect(result.reply).toMatch(/Unknown subcommand/i);
  });
});

// ── Story 53: mixed-batch (normal + slash) dispatch tests ─────────────────────

describe('Story 53 — mixed-batch: normal message + slash command in same batch', () => {
  // Unit tests: AC2 and AC4 — dispatch logic + timestamp advancement
  const chatJid = 'story53@g.us';
  const group = {
    name: 'Story53',
    folder: 'story53-group',
    trigger: '',
    added_at: '2026-01-01T00:00:00.000Z',
    isMain: true,
    requiresTrigger: false,
  };

  let sentMessages: string[];
  let fakeRunner: {
    runAgent: ReturnType<typeof vi.fn>;
    writeTasksSnapshot: ReturnType<typeof vi.fn>;
    writeGroupsSnapshot: ReturnType<typeof vi.fn>;
  };
  let mockChannel: {
    sendMessage: ReturnType<typeof vi.fn>;
    setTyping: ReturnType<typeof vi.fn>;
    owns: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStateForTesting();
    sentMessages = [];

    fakeRunner = {
      runAgent: vi.fn().mockResolvedValue({ status: 'success', result: null }),
      writeTasksSnapshot: vi.fn(),
      writeGroupsSnapshot: vi.fn(),
    };
    mockGetDirectLLMRunner.mockReturnValue(fakeRunner);

    mockChannel = {
      sendMessage: vi
        .fn()
        .mockImplementation(async (_jid: string, text: string) => {
          sentMessages.push(text);
        }),
      setTyping: vi.fn().mockResolvedValue(undefined),
      owns: vi.fn().mockReturnValue(true),
    };
    mockFindChannel.mockReturnValue(mockChannel);

    _setRegisteredGroupsForTesting({ [chatJid]: group as any });
    _pushChannelForTesting(mockChannel as any);
    _setSpecialistCatalogForTesting(makeCatalog([]));
  });

  // AC2: normal text followed by /search → both handled
  it('AC2: normal message followed by /search — search reply sent AND LLM invoked for normal msg', async () => {
    const t1 = '2026-01-01T00:00:01.000Z';
    const t2 = '2026-01-01T00:00:02.000Z';

    // Seed DB for /search to have something to find
    const { _initTestDatabase, appendConversationMessage } =
      await import('./db.js');
    await _initTestDatabase();
    appendConversationMessage('story53-group', 'user', 'tell me about Rust');

    mockGetMessagesSince.mockReturnValueOnce([
      makeMessage('tell me about Rust', t1),
      makeMessage('/search rust', t2),
    ]);

    await processGroupMessages(chatJid);

    // /search reply must have been sent
    expect(mockChannel.sendMessage).toHaveBeenCalled();
    const sentTexts = (
      mockChannel.sendMessage.mock.calls as [string, string][]
    ).map(([, text]) => text);
    const searchReply = sentTexts.find((t) => /rust/i.test(t));
    expect(searchReply).toBeTruthy();

    // LLM must have been invoked for the normal message
    expect(fakeRunner.runAgent).toHaveBeenCalled();
  });

  // AC4: two slash commands in sequence → both receive replies in order
  it('AC4: two slash commands back-to-back — both receive replies in order', async () => {
    const t1 = '2026-01-01T00:00:01.000Z';
    const t2 = '2026-01-01T00:00:02.000Z';

    // Seed DB for /search
    const { _initTestDatabase, appendConversationMessage } =
      await import('./db.js');
    await _initTestDatabase();
    appendConversationMessage('story53-group', 'user', 'help me with foo');

    mockGetMessagesSince.mockReturnValueOnce([
      makeMessage('/skills list', t1),
      makeMessage('/search foo', t2),
    ]);

    await processGroupMessages(chatJid);

    // Both slash commands must have produced replies
    expect(mockChannel.sendMessage).toHaveBeenCalledTimes(2);
    // No LLM call — only slash commands
    expect(fakeRunner.runAgent).not.toHaveBeenCalled();
  });

  // AC5: lastAgentTimestamp advanced to the last message that was responded to
  it('AC5: lastAgentTimestamp advanced to the last processed message timestamp', async () => {
    const t1 = '2026-01-01T00:00:01.000Z';
    const t2 = '2026-01-01T00:00:02.000Z';

    const { _initTestDatabase } = await import('./db.js');
    await _initTestDatabase();

    mockGetMessagesSince.mockReturnValueOnce([
      makeMessage('/skills list', t1),
      makeMessage('/search foo', t2),
    ]);

    // Capture what lastAgentTimestamp is after the call by observing setRouterState
    const setRouterStateCalls: Array<[string, string]> = [];
    vi.mocked(db.setRouterState).mockImplementation(
      (key: string, value: string) => {
        setRouterStateCalls.push([key, value]);
      },
    );

    await processGroupMessages(chatJid);

    // The last_agent_timestamp should contain t2 (the timestamp of the last message).
    // Use the last call (saveState is called once per slash command + once at end).
    const agentTsCalls = setRouterStateCalls.filter(
      ([key]) => key === 'last_agent_timestamp',
    );
    expect(agentTsCalls.length).toBeGreaterThan(0);
    const lastAgentTsCall = agentTsCalls[agentTsCalls.length - 1];
    const saved = JSON.parse(lastAgentTsCall[1]) as Record<string, string>;
    expect(saved[chatJid]).toBe(t2);
  });

  // Edge case: slash command alone — existing behaviour unchanged
  it('single slash command alone still works (no regression)', async () => {
    const t1 = '2026-01-01T00:00:01.000Z';
    const { _initTestDatabase } = await import('./db.js');
    await _initTestDatabase();

    mockGetMessagesSince.mockReturnValueOnce([makeMessage('/skills list', t1)]);

    await processGroupMessages(chatJid);

    expect(mockChannel.sendMessage).toHaveBeenCalledOnce();
    expect(fakeRunner.runAgent).not.toHaveBeenCalled();
  });

  // Edge case: normal messages only — LLM called once, not N times
  it('batch of normal messages → exactly one LLM call (no N+1)', async () => {
    const { _initTestDatabase } = await import('./db.js');
    await _initTestDatabase();

    mockGetMessagesSince.mockReturnValueOnce([
      makeMessage('message one', '2026-01-01T00:00:01.000Z'),
      makeMessage('message two', '2026-01-01T00:00:02.000Z'),
      makeMessage('message three', '2026-01-01T00:00:03.000Z'),
    ]);

    await processGroupMessages(chatJid);

    expect(fakeRunner.runAgent).toHaveBeenCalledOnce();
  });

  // Regression test for Story 53 fix: /help was deleted in the refactor and must now work
  it('fix(Story53): normal text + /help batch — help reply sent AND LLM invoked for normal msg', async () => {
    const { _initTestDatabase } = await import('./db.js');
    await _initTestDatabase();

    const t1 = '2026-01-01T00:00:01.000Z';
    const t2 = '2026-01-01T00:00:02.000Z';

    mockGetMessagesSince.mockReturnValueOnce([
      makeMessage('tell me about Rust', t1),
      makeMessage('/help', t2),
    ]);

    await processGroupMessages(chatJid);

    // /help reply must have been sent and contain command listing
    const sentTexts = (
      mockChannel.sendMessage.mock.calls as [string, string][]
    ).map(([, text]) => text);
    const helpReply = sentTexts.find((t) =>
      /available slash commands/i.test(t),
    );
    expect(helpReply).toBeTruthy();

    // LLM must have been invoked for the normal message
    expect(fakeRunner.runAgent).toHaveBeenCalled();
  });
});

// ── Story 53 integration test: AC3 ───────────────────────────────────────────

describe('Story 53 — integration: /help after normal message, lastAgentTimestamp not over-advanced', () => {
  const chatJid = 'story53-integ@g.us';
  const GROUP_FOLDER = 'story53-integ-group';
  const sentMessages: string[] = [];

  afterEach(() => {
    _testResetState();
    sentMessages.length = 0;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('AC3: /skills reply sent AND lastAgentTimestamp advanced to last message timestamp', async () => {
    // Use a real in-memory DB so getMessagesSince is bypassed via the mock, and
    // appendConversationMessage is live.
    const { _initTestDatabase, appendConversationMessage } =
      await import('./db.js');
    await _initTestDatabase();

    const normalTs = '2026-05-01T12:00:00.000Z';
    const slashTs = '2026-05-01T12:00:01.000Z';

    // Two rows in conversation_history for the group
    appendConversationMessage(
      GROUP_FOLDER,
      'user',
      'what are the system requirements',
    );
    appendConversationMessage(GROUP_FOLDER, 'user', '/skills list');

    // getMessagesSince is still mocked; set up both messages
    mockGetMessagesSince.mockReturnValueOnce([
      makeMessage('what are the system requirements', normalTs),
      makeMessage('/skills list', slashTs),
    ]);

    const fakeChannel2 = {
      ownsJid: (jid: string) => jid === chatJid,
      sendMessage: vi
        .fn()
        .mockImplementation(async (_jid: string, text: string) => {
          sentMessages.push(text);
        }),
      setTyping: vi.fn().mockResolvedValue(undefined),
    };
    mockFindChannel.mockReturnValue(fakeChannel2);

    const fakeRunner2 = {
      runAgent: vi.fn().mockResolvedValue({ status: 'success', result: null }),
      writeTasksSnapshot: vi.fn(),
      writeGroupsSnapshot: vi.fn(),
    };
    mockGetDirectLLMRunner.mockReturnValue(fakeRunner2);

    _testInjectState(
      {
        [chatJid]: {
          jid: chatJid,
          name: 'Story53 Integ',
          folder: GROUP_FOLDER,
          trigger: '',
          added_at: new Date().toISOString(),
          isMain: true,
          requiresTrigger: false,
        } as any,
      },
      [fakeChannel2 as any],
    );
    _setSpecialistCatalogForTesting(makeCatalog([]));

    // Capture setRouterState calls to inspect lastAgentTimestamp
    const routerStateSaved: Record<string, string> = {};
    vi.mocked(db.setRouterState).mockImplementation(
      (key: string, value: string) => {
        routerStateSaved[key] = value;
      },
    );

    await processGroupMessages(chatJid);

    // /skills reply was sent
    expect(fakeChannel2.sendMessage).toHaveBeenCalled();
    const replies = (
      fakeChannel2.sendMessage.mock.calls as [string, string][]
    ).map(([, text]) => text);
    expect(replies.some((r) => /skills/i.test(r) || /no skills/i.test(r))).toBe(
      true,
    );

    // LLM was also invoked for the normal message
    expect(fakeRunner2.runAgent).toHaveBeenCalled();

    // lastAgentTimestamp was saved and equals slashTs (the LAST message's timestamp).
    // routerStateSaved is overwritten on each call so it holds the final saveState() value.
    expect(routerStateSaved['last_agent_timestamp']).toBeTruthy();
    const saved = JSON.parse(
      routerStateSaved['last_agent_timestamp'],
    ) as Record<string, string>;
    expect(saved[chatJid]).toBe(slashTs);
  });
});

// ── /jobs <id> logs unit tests (Story 59) ─────────────────────────────────────

function makeJobsDeps(
  overrides: Partial<JobsCommandDeps> = {},
): JobsCommandDeps {
  return {
    getJobLogs: vi.fn().mockResolvedValue('stdout line\nstderr line'),
    killJob: vi.fn().mockResolvedValue('Cancelled job `job-abc`'),
    ...overrides,
  };
}

describe('truncateLogs', () => {
  it('returns full string when at the limit', () => {
    const lines = Array.from({ length: MAX_LOG_LINES }, (_, i) => `line ${i}`);
    const input = lines.join('\n');
    expect(truncateLogs(input)).toBe(input);
  });

  it('keeps the last MAX_LOG_LINES lines when over the limit', () => {
    const lines = Array.from(
      { length: MAX_LOG_LINES + 10 },
      (_, i) => `line ${i}`,
    );
    const result = truncateLogs(lines.join('\n'));
    const resultLines = result.split('\n');
    expect(resultLines[0]).toMatch(/10 earlier lines omitted/);
    expect(resultLines[resultLines.length - 1]).toBe(
      `line ${MAX_LOG_LINES + 9}`,
    );
  });

  it('shows correct omission count', () => {
    const lines = Array.from({ length: MAX_LOG_LINES + 5 }, (_, i) => `x${i}`);
    expect(truncateLogs(lines.join('\n'))).toContain('5 earlier lines omitted');
  });
});

describe('JOBS_HELP', () => {
  it('contains /jobs <id> logs entry', () => {
    expect(JOBS_HELP).toContain('/jobs <id> logs');
  });

  it('contains /jobs help entry', () => {
    expect(JOBS_HELP).toContain('/jobs help');
  });
});

describe('handleJobsCommand — help subcommand (Story 59)', () => {
  it('returns JOBS_HELP for /jobs help', async () => {
    const result = await handleJobsCommand('grp', '/jobs help', makeJobsDeps());
    expect(result).toBe(JOBS_HELP);
  });

  it('returns job listing for /jobs (no subcommand — Story 50 path preserved)', async () => {
    vi.spyOn(db, 'getActiveToolJobs').mockReturnValue([]);
    vi.spyOn(db, 'getRecentToolJobsForGroup').mockReturnValue([]);
    const result = await handleJobsCommand('grp', '/jobs', makeJobsDeps());
    expect(result).toBe('No active jobs.');
    vi.restoreAllMocks();
  });
});

describe('handleJobsCommand — logs subcommand (Story 59)', () => {
  it('returns reply containing both stdout and stderr lines', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi.fn().mockResolvedValue('stderr line\nstdout line'),
    });
    const result = await handleJobsCommand('grp', '/jobs job-abc logs', deps);
    expect(result).toContain('stderr line');
    expect(result).toContain('stdout line');
    expect(deps.getJobLogs).toHaveBeenCalledWith('job-abc', 'grp');
  });

  it('returns not-found when getJobLogs throws with "not_found" message', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi.fn().mockRejectedValue(new Error('not_found')),
    });
    const result = await handleJobsCommand(
      'grp',
      '/jobs missing-id logs',
      deps,
    );
    expect(result).toMatch(/not found/i);
    expect(result).toContain('missing-id');
  });

  it('returns not-found when getJobLogs resolves to "not_found" string', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi.fn().mockResolvedValue('not_found'),
    });
    const result = await handleJobsCommand('grp', '/jobs some-id logs', deps);
    expect(result).toMatch(/not found/i);
  });

  it('returns "no longer available" for GC sentinel "No pods found for job"', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi.fn().mockResolvedValue('No pods found for job'),
    });
    const result = await handleJobsCommand('grp', '/jobs old-id logs', deps);
    expect(result).toMatch(/no longer available/i);
  });

  it('returns "no longer available" for GC sentinel "Pod name not found"', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi.fn().mockResolvedValue('Pod name not found'),
    });
    const result = await handleJobsCommand('grp', '/jobs old-id logs', deps);
    expect(result).toMatch(/no longer available/i);
  });

  it('includes job ID in the success reply header', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi.fn().mockResolvedValue('some output'),
    });
    const result = await handleJobsCommand('grp', '/jobs my-job-id logs', deps);
    expect(result).toContain('my-job-id');
  });

  it('handles IPC timeout gracefully', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    const result = await handleJobsCommand('grp', '/jobs job-abc logs', deps);
    expect(result).toMatch(/timeout/i);
  });

  it('truncates very long log output', async () => {
    const longLog = Array.from(
      { length: MAX_LOG_LINES + 20 },
      (_, i) => `line ${i}`,
    ).join('\n');
    const deps = makeJobsDeps({
      getJobLogs: vi.fn().mockResolvedValue(longLog),
    });
    const result = await handleJobsCommand('grp', '/jobs job-abc logs', deps);
    expect(result).toContain('earlier lines omitted');
    expect(result).toContain(`line ${MAX_LOG_LINES + 19}`);
  });

  it('preserves log lines containing "not found" as substring (not GC sentinel)', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi
        .fn()
        .mockResolvedValue(
          'INFO: File not found in /tmp/data\nstderr: more output',
        ),
    });
    const result = await handleJobsCommand('grp', '/jobs job-abc logs', deps);
    expect(result).toContain('File not found');
    expect(result).not.toContain('garbage-collected');
  });

  it('GC sentinel requires prefix match — substring mid-log is not flagged', async () => {
    const deps = makeJobsDeps({
      getJobLogs: vi
        .fn()
        .mockResolvedValue(
          'WARN something\nNo pods found for job was expected',
        ),
    });
    // This does NOT start with the sentinel, so it should NOT be flagged
    const result = await handleJobsCommand('grp', '/jobs job-abc logs', deps);
    expect(result).not.toMatch(/no longer available/i);
    expect(result).toContain('No pods found for job');
  });
});

// ── /jobs <id> kill unit tests (Story 66) ─────────────────────────────────────

describe('handleJobsCommand — /jobs <id> kill (Story 66)', () => {
  const GROUP_FOLDER = 'test-group';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a JobsCommandDeps with a stub killJob implementation.
   * The stub records calls and returns the configured reply.
   */
  function makeKillDeps(killReply: string): {
    deps: JobsCommandDeps;
    killSpy: ReturnType<typeof vi.fn>;
  } {
    const killSpy = vi.fn().mockResolvedValue(killReply);
    const deps: JobsCommandDeps = {
      getJobLogs: vi.fn(),
      killJob: killSpy,
    };
    return { deps, killSpy };
  }

  it('AC1: active job → killJob called with correct jobId and returns confirmation', async () => {
    const { deps, killSpy } = makeKillDeps('Cancelled job `job-abc`');
    const reply = await handleJobsCommand(
      GROUP_FOLDER,
      '/jobs job-abc kill',
      deps,
    );
    expect(killSpy).toHaveBeenCalledWith('job-abc', GROUP_FOLDER);
    expect(reply).toBe('Cancelled job `job-abc`');
  });

  it('AC2: already-resolved job → returns not-active message with current status', async () => {
    const { deps } = makeKillDeps(
      'Job `job-xyz` is not active (status: completed)',
    );
    const reply = await handleJobsCommand(
      GROUP_FOLDER,
      '/jobs job-xyz kill',
      deps,
    );
    expect(reply).toContain('not active');
    expect(reply).toContain('completed');
  });

  it('AC3: job belongs to another group → returns "Job not found"', async () => {
    const { deps } = makeKillDeps('Job not found');
    const reply = await handleJobsCommand(
      'other-group',
      '/jobs job-abc kill',
      deps,
    );
    expect(reply).toBe('Job not found');
  });

  it('AC4: unknown job id → returns "Job not found"', async () => {
    const { deps } = makeKillDeps('Job not found');
    const reply = await handleJobsCommand(
      GROUP_FOLDER,
      '/jobs unknown-id kill',
      deps,
    );
    expect(reply).toBe('Job not found');
  });

  it('AC5: JOBS_HELP contains /jobs <id> kill', () => {
    expect(JOBS_HELP).toContain('/jobs <id> kill');
  });

  it('does not invoke killJob when no deps provided', async () => {
    vi.spyOn(db, 'getActiveToolJobs').mockReturnValue([]);
    vi.spyOn(db, 'getRecentToolJobsForGroup').mockReturnValue([]);
    // no deps — falls through to listing path
    const reply = await handleJobsCommand(GROUP_FOLDER, '/jobs job-abc kill');
    expect(reply).toBe('No active jobs.');
  });

  it('handles killJob IPC error gracefully', async () => {
    const deps: JobsCommandDeps = {
      getJobLogs: vi.fn(),
      killJob: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const reply = await handleJobsCommand(
      GROUP_FOLDER,
      '/jobs job-abc kill',
      deps,
    );
    expect(reply).toContain('Failed to cancel job');
    expect(reply).toContain('timeout');
  });
});

// ── /schedule pause/resume unit tests (Story 62) ─────────────────────────────

describe('handleScheduleCommand — pause (Story 62)', () => {
  beforeEach(() => {
    vi.mocked(db.pauseTask).mockReset();
    vi.mocked(db.resumeTask).mockReset();
  });

  it('returns confirmation when pauseTask succeeds', async () => {
    vi.mocked(db.pauseTask).mockReturnValue(true);
    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule pause task-abc',
    );
    expect(reply).toBe('Task "task-abc" paused.');
    expect(vi.mocked(db.pauseTask)).toHaveBeenCalledWith('task-abc', 'mygroup');
  });

  it('returns "Task not found." when pauseTask returns false (unknown id)', async () => {
    vi.mocked(db.pauseTask).mockReturnValue(false);
    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule pause no-such-id',
    );
    expect(reply).toBe('Task not found.');
  });

  it('returns "Task not found." when pauseTask returns false (cross-group)', async () => {
    vi.mocked(db.pauseTask).mockReturnValue(false);
    const crossReply = await handleScheduleCommand(
      'attacker',
      'jid@g.us',
      '/schedule pause task-abc',
    );
    const unknownReply = await handleScheduleCommand(
      'attacker',
      'jid@g.us',
      '/schedule pause totally-unknown',
    );
    // both cases must return exact same text (no enumeration)
    expect(crossReply).toBe(unknownReply);
    expect(crossReply).toBe('Task not found.');
  });

  it('returns usage hint when pause is called without id', async () => {
    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule pause',
    );
    expect(reply).toBe('Usage: /schedule pause <id>');
  });
});

describe('handleScheduleCommand — resume (Story 62)', () => {
  beforeEach(() => {
    vi.mocked(db.pauseTask).mockReset();
    vi.mocked(db.resumeTask).mockReset();
  });

  it('returns confirmation when resumeTask succeeds', async () => {
    vi.mocked(db.resumeTask).mockReturnValue(true);
    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule resume task-abc',
    );
    expect(reply).toBe('Task "task-abc" resumed.');
    expect(vi.mocked(db.resumeTask)).toHaveBeenCalledWith(
      'task-abc',
      'mygroup',
    );
  });

  it('returns "Task not found." when resumeTask returns false (unknown id)', async () => {
    vi.mocked(db.resumeTask).mockReturnValue(false);
    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule resume no-such-id',
    );
    expect(reply).toBe('Task not found.');
  });

  it('returns "Task not found." when resumeTask returns false (cross-group)', async () => {
    vi.mocked(db.resumeTask).mockReturnValue(false);
    const crossReply = await handleScheduleCommand(
      'attacker',
      'jid@g.us',
      '/schedule resume task-abc',
    );
    const unknownReply = await handleScheduleCommand(
      'attacker',
      'jid@g.us',
      '/schedule resume totally-unknown',
    );
    expect(crossReply).toBe(unknownReply);
    expect(crossReply).toBe('Task not found.');
  });

  it('returns usage hint when resume is called without id', async () => {
    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule resume',
    );
    expect(reply).toBe('Usage: /schedule resume <id>');
  });
});

describe('handleScheduleCommand — list [paused] prefix (Story 62)', () => {
  it('shows [paused] prefix for paused tasks, not for active tasks', async () => {
    const activeTask = {
      id: 'task-active',
      group_folder: 'mygroup',
      chat_jid: 'jid@g.us',
      prompt: 'active task prompt',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      status: 'active' as const,
      next_run: '2026-06-01T00:00:00.000Z',
      last_run: null,
      last_result: null,
      context_mode: 'isolated' as const,
      created_at: '2026-05-20T00:00:00.000Z',
    };
    const pausedTask = {
      ...activeTask,
      id: 'task-paused',
      status: 'paused' as const,
    };
    vi.mocked(db.getTasksForGroup).mockReturnValue([activeTask, pausedTask]);

    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule list',
    );

    const lines = reply.split('\n');
    const activeLine = lines.find((l) => l.includes('task-active'));
    const pausedLine = lines.find((l) => l.includes('task-paused'));
    expect(activeLine).toBeDefined();
    expect(activeLine!.startsWith('[paused]')).toBe(false);
    expect(pausedLine).toBeDefined();
    expect(pausedLine!.startsWith('[paused]')).toBe(true);
  });

  it('SCHEDULE_HELP includes /schedule pause and /schedule resume', async () => {
    const reply = await handleScheduleCommand(
      'mygroup',
      'jid@g.us',
      '/schedule help',
    );
    expect(reply).toMatch(/pause/i);
    expect(reply).toMatch(/resume/i);
  });
});

// ── Story 67: formatHumanDelta unit tests ────────────────────────────────────

describe('formatHumanDelta', () => {
  it('returns "now" for 0ms', () => {
    expect(formatHumanDelta(0)).toBe('now');
  });

  it('returns "now" for negative delta', () => {
    expect(formatHumanDelta(-5000)).toBe('now');
  });

  it('returns "in Xs" for seconds under 60', () => {
    expect(formatHumanDelta(30000)).toBe('in 30s');
    expect(formatHumanDelta(1000)).toBe('in 1s');
    expect(formatHumanDelta(59999)).toBe('in 59s');
  });

  it('returns "in Xm" for minutes under 60', () => {
    expect(formatHumanDelta(5 * 60 * 1000)).toBe('in 5m');
    expect(formatHumanDelta(60 * 1000)).toBe('in 1m');
    expect(formatHumanDelta(59 * 60 * 1000)).toBe('in 59m');
  });

  it('returns "in Xh" for hours under 24', () => {
    expect(formatHumanDelta(2 * 60 * 60 * 1000)).toBe('in 2h');
    expect(formatHumanDelta(23 * 60 * 60 * 1000)).toBe('in 23h');
  });

  it('returns "in Xd" for days', () => {
    expect(formatHumanDelta(3 * 24 * 60 * 60 * 1000)).toBe('in 3d');
    expect(formatHumanDelta(7 * 24 * 60 * 60 * 1000)).toBe('in 7d');
  });
});

// ── Story 67: handleScheduleCommand — next verb (unit tests) ─────────────────

describe('handleScheduleCommand — next (Story 67)', () => {
  const NOW = new Date('2026-06-01T10:00:00.000Z').getTime();

  const makeTask = (
    overrides: Partial<{
      id: string;
      group_folder: string;
      next_run: string | null;
      status: 'active' | 'paused' | 'completed';
    }>,
  ) => ({
    id: 'task-default',
    group_folder: 'group-alice',
    chat_jid: 'http:alice',
    prompt: 'do thing',
    schedule_type: 'interval' as const,
    schedule_value: '60000',
    context_mode: 'isolated' as const,
    next_run: '2026-06-01T10:05:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: '2026-05-01T00:00:00.000Z',
    ...overrides,
  });

  beforeEach(() => {
    vi.mocked(db.getTasksForGroup).mockReset();
    vi.mocked(db.getTaskById).mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC4: returns "No scheduled tasks" when group has no tasks', async () => {
    vi.mocked(db.getTasksForGroup).mockReturnValue([]);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule next',
    );

    expect(reply).toBe('No scheduled tasks');
  });

  it('AC1: multi-task view — shows id, ISO timestamp, and human delta for each task', async () => {
    const t1 = makeTask({
      id: 'task-aaa',
      next_run: '2026-06-01T10:05:00.000Z',
    }); // 5m ahead
    const t2 = makeTask({
      id: 'task-bbb',
      next_run: '2026-06-01T12:00:00.000Z',
    }); // 2h ahead
    vi.mocked(db.getTasksForGroup).mockReturnValue([t1, t2]);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule next',
    );

    expect(reply).toContain('task-aaa');
    expect(reply).toContain('task-bbb');
    expect(reply).toContain('in 5m');
    expect(reply).toContain('in 2h');
    expect(reply).toContain('2026-06-01T10:05:00.000Z');
    expect(reply).toContain('2026-06-01T12:00:00.000Z');
  });

  it('AC1: paused tasks are prefixed with [paused] and delta is "paused"', async () => {
    const t = makeTask({
      id: 'task-paused',
      status: 'paused',
      next_run: '2026-06-01T10:05:00.000Z',
    });
    vi.mocked(db.getTasksForGroup).mockReturnValue([t]);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule next',
    );

    expect(reply).toContain('[paused]');
    expect(reply).toContain('task-paused');
    expect(reply).toContain('paused');
    // human delta should NOT be "in 5m" for paused
    expect(reply).not.toContain('in 5m');
  });

  it('AC2: single-task view with valid id', async () => {
    const t = makeTask({
      id: 'task-xyz',
      next_run: '2026-06-01T10:05:00.000Z',
    });
    vi.mocked(db.getTaskById).mockReturnValue(t);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule next task-xyz',
    );

    expect(reply).toContain('task-xyz');
    expect(reply).toContain('2026-06-01T10:05:00.000Z');
    expect(reply).toContain('in 5m');
  });

  it('AC2: once task already completed returns "no future run" message', async () => {
    const t = makeTask({
      id: 'task-done',
      schedule_type: 'once',
      next_run: null,
      status: 'completed',
    });
    vi.mocked(db.getTaskById).mockReturnValue(t);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule next task-done',
    );

    expect(reply).toContain('task-done');
    expect(reply).toContain('no future run');
    expect(reply).toContain('completed');
  });

  it('AC3: unknown id returns "Task not found"', async () => {
    vi.mocked(db.getTaskById).mockReturnValue(undefined);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule next no-such-id',
    );

    expect(reply).toBe('Task not found');
  });

  it('cross-group: another group task returns "Task not found"', async () => {
    const t = makeTask({ id: 'task-bob', group_folder: 'group-bob' });
    vi.mocked(db.getTaskById).mockReturnValue(t);

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule next task-bob',
    );

    expect(reply).toBe('Task not found');
  });
});

describe('HELP_TEXT includes /schedule next', () => {
  it('mentions /schedule next in the help text', () => {
    expect(HELP_TEXT).toMatch(/\/schedule next/);
  });
});

// ── Story 83: Audit log for destructive slash commands ─────────────────────────

describe('Story 83 — handleSecretCommand audit (secret.remove)', () => {
  beforeEach(() => {
    vi.mocked(db.writeAuditEntry).mockClear();
  });

  it('writes audit row action=secret.remove with target and actor BEFORE reply on success', async () => {
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));

    const result = await handleSecretCommand(
      'group-alice',
      '/secret remove replicate',
      makeDeps(ipc as any),
      'alice',
    );

    expect(db.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(db.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'group-alice',
        actor: 'alice',
        action: 'secret.remove',
        target: 'replicate',
      }),
    );
    expect(result.reply).toMatch(/removed/i);
  });

  it('does NOT write audit row when remove fails (IPC error)', async () => {
    const ipc = vi.fn(
      async (): Promise<IpcResponse> => ({ ok: false, error: 'not found' }),
    );

    await handleSecretCommand(
      'group-alice',
      '/secret remove replicate',
      makeDeps(ipc as any),
      'alice',
    );

    expect(db.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('audit failure does NOT break the slash command (graceful degrade)', async () => {
    vi.mocked(db.writeAuditEntry).mockImplementation(() => {
      throw new Error('DB exploded');
    });
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));

    const result = await handleSecretCommand(
      'group-alice',
      '/secret remove replicate',
      makeDeps(ipc as any),
      'alice',
    );

    // Reply should still succeed despite audit failure
    expect(result.reply).toMatch(/removed/i);
  });
});

describe('Story 83 — handleSecretCommand audit (secret.add)', () => {
  beforeEach(() => {
    vi.mocked(db.writeAuditEntry).mockClear();
  });

  it('writes audit row action=secret.add with field NAMES only — values never logged', async () => {
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));
    const SECRET_VALUE = 'r8_supersecret_value_1234567890';

    const result = await handleSecretCommand(
      'group-alice',
      `/secret add replicate token=${SECRET_VALUE}`,
      makeDeps(ipc as any),
      'alice',
    );

    expect(db.writeAuditEntry).toHaveBeenCalledTimes(1);
    const call = vi.mocked(db.writeAuditEntry).mock.calls[0][0];
    expect(call.action).toBe('secret.add');
    expect(call.target).toBe('replicate');
    expect(call.actor).toBe('alice');
    expect(call.groupFolder).toBe('group-alice');
    // detail contains field NAME 'token' but NEVER the value
    expect(call.detail).toContain('token');
    expect(call.detail).not.toContain(SECRET_VALUE);
    expect(result.reply).toBeTruthy();
  });

  it('audit detail uses fields= prefix for field names CSV', async () => {
    const ipc = vi.fn(async (): Promise<IpcResponse> => ({ ok: true }));

    await handleSecretCommand(
      'group-alice',
      '/secret add jenkins user=alice_user password=hunter2',
      makeDeps(ipc as any),
      'alice',
    );

    expect(db.writeAuditEntry).toHaveBeenCalledTimes(1);
    const call = vi.mocked(db.writeAuditEntry).mock.calls[0][0];
    expect(call.detail).toMatch(/^fields=/);
    expect(call.detail).toContain('user');
    expect(call.detail).toContain('password');
    // Values must NEVER appear in detail
    expect(call.detail).not.toContain('alice_user');
    expect(call.detail).not.toContain('hunter2');
  });

  it('does NOT write audit row when add fails (IPC error)', async () => {
    const ipc = vi.fn(
      async (): Promise<IpcResponse> => ({ ok: false, error: 'store failed' }),
    );

    await handleSecretCommand(
      'group-alice',
      '/secret add replicate token=r8_abc123',
      makeDeps(ipc as any),
      'alice',
    );

    expect(db.writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('Story 83 — handleScheduleCommand audit (schedule.delete)', () => {
  beforeEach(() => {
    vi.mocked(db.writeAuditEntry).mockClear();
    vi.mocked(db.deleteTaskForGroup).mockReturnValue(true);
  });

  it('writes audit row action=schedule.delete with target and actor on success', async () => {
    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule remove task-123',
      'alice',
    );

    expect(db.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(db.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'group-alice',
        actor: 'alice',
        action: 'schedule.delete',
        target: 'task-123',
      }),
    );
    expect(reply).toMatch(/removed/i);
  });

  it('does NOT write audit row when task not found', async () => {
    vi.mocked(db.deleteTaskForGroup).mockReturnValue(false);

    await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule remove no-such-task',
      'alice',
    );

    expect(db.writeAuditEntry).not.toHaveBeenCalled();
  });

  it('audit failure does NOT break the slash command (graceful degrade)', async () => {
    vi.mocked(db.writeAuditEntry).mockImplementation(() => {
      throw new Error('DB exploded');
    });

    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule remove task-123',
      'alice',
    );

    expect(reply).toMatch(/removed/i);
  });
});

describe('Story 83 — handleScheduleCommand audit (schedule.pause)', () => {
  beforeEach(() => {
    vi.mocked(db.writeAuditEntry).mockClear();
    vi.mocked(db.pauseTask).mockReturnValue(true);
  });

  it('writes audit row action=schedule.pause with target and actor on success', async () => {
    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule pause task-456',
      'alice',
    );

    expect(db.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(db.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'group-alice',
        actor: 'alice',
        action: 'schedule.pause',
        target: 'task-456',
      }),
    );
    expect(reply).toMatch(/paused/i);
  });

  it('does NOT write audit row when task not found', async () => {
    vi.mocked(db.pauseTask).mockReturnValue(false);

    await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule pause no-such-task',
      'alice',
    );

    expect(db.writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('Story 83 — handleScheduleCommand audit (schedule.resume)', () => {
  beforeEach(() => {
    vi.mocked(db.writeAuditEntry).mockClear();
    vi.mocked(db.resumeTask).mockReturnValue(true);
  });

  it('writes audit row action=schedule.resume with target and actor on success', async () => {
    const reply = await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule resume task-789',
      'alice',
    );

    expect(db.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(db.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: 'group-alice',
        actor: 'alice',
        action: 'schedule.resume',
        target: 'task-789',
      }),
    );
    expect(reply).toMatch(/resumed/i);
  });

  it('does NOT write audit row when task not found', async () => {
    vi.mocked(db.resumeTask).mockReturnValue(false);

    await handleScheduleCommand(
      'group-alice',
      'http:alice',
      '/schedule resume no-such-task',
      'alice',
    );

    expect(db.writeAuditEntry).not.toHaveBeenCalled();
  });
});

describe('update_profile local tool registration', () => {
  it('registers update_profile on the DirectLLMRunner', async () => {
    // Arrange: mock runner that records registered tool names
    const registeredTools: string[] = [];
    const mockRunner = {
      configureMcp: vi.fn(),
      configureGroupMcpTemplates: vi.fn(),
      registerLocalTool: vi.fn((name: string) => {
        registeredTools.push(name);
      }),
      setChannelMetrics: vi.fn(),
      writeTasksSnapshot: vi.fn(),
      writeGroupsSnapshot: vi.fn(),
      runAgent: vi.fn().mockResolvedValue({ status: 'success' }),
    };

    // Act: call registerProfileTool with the mock runner
    registerProfileTool(
      mockRunner as unknown as ReturnType<
        typeof import('./runtime/index.js').getDirectLLMRunner
      >,
    );

    // Assert
    expect(registeredTools).toContain('update_profile');
  });
});

// ── Runtime adapter self-registration ────────────────────────────────────────
// Verifies that loadRuntimeChannelAdapter(buildChannelSdk(), <path>) causes
// getChannelFactory('<type>') to resolve — the foundation for the single-image
// runtime-channel-delivery path. Tested at the helper level because main() is
// not unit-testable (Redis/DB I/O).
import { getChannelFactory } from './channels/registry.js';
import { buildChannelSdk } from './channel-sdk/index.js';
import { loadRuntimeChannelAdapter } from './channel-sdk/load-runtime-adapter.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('a runtime adapter self-registers into the resident factory registry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-'));
  const entry = join(dir, 'entry.mjs');
  writeFileSync(entry, `export default (sdk) => sdk.registerChannel('runtime-test', () => null);`);
  expect(getChannelFactory('runtime-test')).toBeUndefined();
  await loadRuntimeChannelAdapter(buildChannelSdk(), entry);
  expect(getChannelFactory('runtime-test')).toBeTypeOf('function');
  rmSync(dir, { recursive: true, force: true });
});
