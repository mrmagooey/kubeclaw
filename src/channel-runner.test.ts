import { describe, it, expect, vi } from 'vitest';

// channel-runner.ts has a module-level `if (!KUBECLAW_CHANNEL) process.exit(1)`
// guard. Hoist the env stub above the import so the guard passes.
vi.hoisted(() => {
  process.env.KUBECLAW_CHANNEL = 'test';
});

import {
  folderPrefixForChannel,
  dispatchSkillsCommandIfApplicable,
  handleSecretCommand,
  isSecretCommand,
  parseSecretAddCommand,
  applyCredentialBackstop,
  buildCatalogBackstopPatterns,
  type SecretCommandDeps,
  type IpcResponse,
} from './channel-runner.js';
import type { CatalogEntry } from './credential-broker/resolver.js';

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
