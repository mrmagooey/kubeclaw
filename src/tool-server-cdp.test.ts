/**
 * Unit tests for executeToolBridgeCdp in tool-server.ts.
 * Uses the same vi.hoisted env + vi.mock('redis') preamble as
 * tool-server-mapping.test.ts so the module import is inert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.KUBECLAW_TOOL_JOB_ID = 'test-job-id';
  process.env.KUBECLAW_CATEGORY = 'browser';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.KUBECLAW_TOOL_MODE = 'cdp-bridge';
});

vi.mock('redis', () => {
  const mockRedis = {
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    xAdd: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  };
  return { createClient: vi.fn(() => mockRedis) };
});

const page = {
  url: vi.fn(() => 'https://example.com/'),
  title: vi.fn(async () => 'Example'),
  goto: vi.fn(async () => {}),
  goBack: vi.fn(async () => {}),
  evaluate: vi.fn(async () => '[e1] button "Login"'),
  innerText: vi.fn(async () => 'hello world'),
  keyboard: { press: vi.fn(async () => {}) },
  waitForSelector: vi.fn(async () => {}),
  waitForTimeout: vi.fn(async () => {}),
  isClosed: vi.fn(() => false),
  locator: vi.fn(() => ({
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
  })),
};
const context = {
  pages: vi.fn(() => [page]),
  newPage: vi.fn(async () => page),
};
const browser = {
  isConnected: vi.fn(() => true),
  contexts: vi.fn(() => [context]),
  newContext: vi.fn(async () => context),
};
vi.mock('playwright-core', () => ({
  chromium: { connectOverCDP: vi.fn(async () => browser) },
}));

import { executeToolBridgeCdp } from '../container/agent-runner/src/tool-server.js';

describe('executeToolBridgeCdp', () => {
  beforeEach(() => {
    process.env.KUBECLAW_CDP_URL = 'http://localhost:9222';
    // Reset page mock state so each test starts fresh
    page.goto.mockClear();
    page.goto.mockResolvedValue(undefined);
    page.locator.mockClear();
    page.locator.mockReturnValue({
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
    });
    page.isClosed.mockReturnValue(false);
    browser.isConnected.mockReturnValue(true);
  });

  it('navigate returns the new URL + title', async () => {
    const r = await executeToolBridgeCdp('browser', {
      action: 'navigate',
      url: 'https://example.com',
    });
    expect(String(r)).toContain('example.com');
    expect(page.goto).toHaveBeenCalled();
  });

  it('snapshot returns URL/title + interactive elements with refs', async () => {
    const r = await executeToolBridgeCdp('browser', { action: 'snapshot' });
    expect(String(r)).toContain('e1');
    expect(String(r)).toContain('Login');
  });

  it('click targets the data-kc-ref locator', async () => {
    await executeToolBridgeCdp('browser', { action: 'click', ref: 'e1' });
    expect(page.locator).toHaveBeenCalledWith('[data-kc-ref="e1"]');
  });

  it('type fills then optionally submits', async () => {
    const loc = {
      click: vi.fn(),
      fill: vi.fn(async () => {}),
      press: vi.fn(async () => {}),
    };
    page.locator.mockReturnValueOnce(loc as any);
    await executeToolBridgeCdp('browser', {
      action: 'type',
      ref: 'e1',
      text: 'hi',
      submit: true,
    });
    expect(loc.fill).toHaveBeenCalledWith('hi', expect.anything());
    expect(loc.press).toHaveBeenCalledWith('Enter');
  });

  it('unknown action returns a clean error listing valid actions', async () => {
    const r = await executeToolBridgeCdp('browser', { action: 'teleport' });
    expect(String(r)).toMatch(/unknown action/i);
    expect(String(r)).toContain('navigate');
  });

  it('a Playwright failure is returned as a string, not thrown', async () => {
    page.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const r = await executeToolBridgeCdp('browser', {
      action: 'navigate',
      url: 'https://nope.invalid',
    });
    expect(String(r)).toMatch(/error:/i);
  });
});
