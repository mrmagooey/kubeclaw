import { describe, it, expect, vi, afterEach } from 'vitest';

const calls: string[] = [];
vi.mock('undici', () => ({
  EnvHttpProxyAgent: class {
    constructor() {
      calls.push('agent');
    }
  },
  setGlobalDispatcher: () => calls.push('set'),
}));

import { installProxyDispatcher } from './proxy-dispatcher.js';

describe('installProxyDispatcher', () => {
  afterEach(() => {
    calls.length = 0;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
  });

  it('installs EnvHttpProxyAgent when HTTPS_PROXY is set', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8443';
    installProxyDispatcher();
    expect(calls).toEqual(['agent', 'set']);
  });

  it('is a no-op when no proxy env is set', () => {
    installProxyDispatcher();
    expect(calls).toEqual([]);
  });
});
