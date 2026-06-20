import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db.js', () => ({
  setRegisteredGroup: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    makeApiClient() {
      return {};
    }
  },
  CoreV1Api: class {},
  AppsV1Api: class {},
}));

import {
  buildSecretData,
  validateChannelCredentials,
} from './channel-setup.js';

// ─── Story 181: patchRuntimePvc + waitForDeploymentRollout ───────────────────

import { patchRuntimePvc, waitForDeploymentRollout } from './channel-setup.js';

describe('patchRuntimePvc', () => {
  it('calls patchNamespacedDeployment with the correct volume claimName', async () => {
    const patchFn = vi.fn().mockResolvedValue({});
    const fakeAppsV1 = {
      patchNamespacedDeployment: patchFn,
    } as any;

    await patchRuntimePvc(
      'my-telegram',
      'kubeclaw-channel-my-telegram-runtime-v2',
      {
        appsV1: fakeAppsV1,
        namespace: 'kubeclaw-test',
      },
    );

    expect(patchFn).toHaveBeenCalledOnce();
    const call = patchFn.mock.calls[0][0];
    expect(call.name).toBe('kubeclaw-channel-my-telegram');
    expect(call.namespace).toBe('kubeclaw-test');
    const body = call.body;
    const volumes = body.spec.template.spec.volumes;
    expect(volumes).toContainEqual({
      name: 'runtime',
      persistentVolumeClaim: {
        claimName: 'kubeclaw-channel-my-telegram-runtime-v2',
      },
    });
  });
});

describe('waitForDeploymentRollout', () => {
  it('resolves immediately when deployment is already updated and available', async () => {
    const readFn = vi.fn().mockResolvedValue({
      spec: { replicas: 1 },
      status: { updatedReplicas: 1, availableReplicas: 1 },
    });
    const fakeAppsV1 = { readNamespacedDeployment: readFn } as any;

    await expect(
      waitForDeploymentRollout('kubeclaw-channel-my-telegram', {
        appsV1: fakeAppsV1,
        namespace: 'kubeclaw-test',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
    expect(readFn).toHaveBeenCalledTimes(1);
  });

  it('rejects on timeout if deployment never becomes fully available', async () => {
    const readFn = vi.fn().mockResolvedValue({
      spec: { replicas: 2 },
      status: { updatedReplicas: 1, availableReplicas: 1 },
    });
    const fakeAppsV1 = { readNamespacedDeployment: readFn } as any;

    await expect(
      waitForDeploymentRollout('kubeclaw-channel-my-telegram', {
        appsV1: fakeAppsV1,
        namespace: 'kubeclaw-test',
        pollIntervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/rollout timeout/i);
  });
});

// ─── buildSecretData — non-webchat channel types ──────────────────────────────

describe('buildSecretData — non-webchat channel types', () => {
  it('telegram: maps token to TELEGRAM_BOT_TOKEN', () => {
    const data = buildSecretData({ type: 'telegram', token: 'tok123' });
    expect(data).toEqual({ TELEGRAM_BOT_TOKEN: 'tok123' });
  });

  it('discord: maps token to DISCORD_BOT_TOKEN', () => {
    const data = buildSecretData({ type: 'discord', token: 'disc456' });
    expect(data).toEqual({ DISCORD_BOT_TOKEN: 'disc456' });
  });

  it('slack: maps token to SLACK_BOT_TOKEN', () => {
    const data = buildSecretData({ type: 'slack', token: 'xoxb-789' });
    expect(data).toEqual({ SLACK_BOT_TOKEN: 'xoxb-789' });
  });

  it('whatsapp: maps phoneNumber to WHATSAPP_PHONE_NUMBER', () => {
    const data = buildSecretData({
      type: 'whatsapp',
      phoneNumber: '+15551234567',
    });
    expect(data).toEqual({ WHATSAPP_PHONE_NUMBER: '+15551234567' });
  });

  it('signal: maps phoneNumber to SIGNAL_PHONE_NUMBER', () => {
    const data = buildSecretData({
      type: 'signal',
      phoneNumber: '+15559876543',
    });
    expect(data).toEqual({ SIGNAL_PHONE_NUMBER: '+15559876543' });
  });

  it('unknown type: returns empty object', () => {
    const data = buildSecretData({ type: 'unknown-channel' });
    expect(data).toEqual({});
  });

  it('telegram with no token: returns empty object', () => {
    const data = buildSecretData({ type: 'telegram' });
    expect(data).toEqual({});
  });
});

// ─── validateChannelCredentials — non-webchat types ──────────────────────────

describe('validateChannelCredentials — non-webchat types', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('telegram missing token: returns TELEGRAM_BOT_TOKEN is required', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const result = await validateChannelCredentials('telegram', {});
    expect(result).toBe('TELEGRAM_BOT_TOKEN is required');
  });

  it('telegram with valid token and ok response: returns null', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('telegram', {
      TELEGRAM_BOT_TOKEN: 'valid-token',
    });
    expect(result).toBeNull();
  });

  it('telegram with token and non-ok response: returns rejection description', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('telegram', {
      TELEGRAM_BOT_TOKEN: 'bad-token',
    });
    expect(result).toBe('Unauthorized');
  });

  it('discord missing token: returns DISCORD_BOT_TOKEN is required', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const result = await validateChannelCredentials('discord', {});
    expect(result).toBe('DISCORD_BOT_TOKEN is required');
  });

  it('discord with valid token and ok response: returns null', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('discord', {
      DISCORD_BOT_TOKEN: 'valid-disc',
    });
    expect(result).toBeNull();
  });

  it('discord with token and non-ok response: returns error string containing status', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('discord', {
      DISCORD_BOT_TOKEN: 'bad-disc',
    });
    expect(result).toContain('Discord');
    expect(result).toContain('401');
  });

  it('slack missing token: returns SLACK_BOT_TOKEN is required', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const result = await validateChannelCredentials('slack', {});
    expect(result).toBe('SLACK_BOT_TOKEN is required');
  });

  it('slack with valid token and ok JSON: returns null', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('slack', {
      SLACK_BOT_TOKEN: 'xoxb-valid',
    });
    expect(result).toBeNull();
  });

  it('slack with token and failed JSON (ok=false): returns error string containing Slack', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, error: 'invalid_auth' }),
    })) as unknown as typeof fetch;
    const result = await validateChannelCredentials('slack', {
      SLACK_BOT_TOKEN: 'xoxb-bad',
    });
    expect(result).toBe('invalid_auth');
  });

  it('http: returns null without calling fetch', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const result = await validateChannelCredentials('http', {
      HTTP_CHANNEL_PORT: '8080',
    });
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('signal: returns null without calling fetch', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const result = await validateChannelCredentials('signal', {
      SIGNAL_PHONE_NUMBER: '+15551234567',
    });
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('unknown type: returns null without calling fetch', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const result = await validateChannelCredentials('unknown-type', {});
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ─── validateChannelCredentials — outer catch path ───────────────────────────

describe('validateChannelCredentials — outer catch path', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns "Could not reach the channel API" when fetch throws synchronously for telegram', async () => {
    globalThis.fetch = (() => {
      throw new Error('network error');
    }) as unknown as typeof fetch;
    const result = await validateChannelCredentials('telegram', {
      TELEGRAM_BOT_TOKEN: 'some-token',
    });
    expect(result).toContain('Could not reach the channel API');
    expect(result).toContain('network error');
  });
});
