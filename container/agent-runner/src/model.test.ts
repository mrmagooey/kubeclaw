/**
 * Unit tests for buildModel() and getApiKeyForProvider() in model.ts.
 *
 * Uses vi.stubEnv / manual process.env save-restore to control env vars.
 * No real network calls or module-level side-effects.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildModel, getApiKeyForProvider } from './model.js';

describe('buildModel()', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Snapshot all env vars we may mutate so we can restore them after each test.
    savedEnv = {
      KUBECLAW_LLM_PROVIDER: process.env.KUBECLAW_LLM_PROVIDER,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
      OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
      OLLAMA_MODEL: process.env.OLLAMA_MODEL,
      OLLAMA_HOST: process.env.OLLAMA_HOST,
      OPENAI_MODEL: process.env.OPENAI_MODEL,
      DIRECT_LLM_MODEL: process.env.DIRECT_LLM_MODEL,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    };
    // Start each test from a clean slate.
    for (const key of Object.keys(savedEnv)) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original values.
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // ── provider=claude ────────────────────────────────────────────────────────

  describe("provider 'claude'", () => {
    beforeEach(() => {
      process.env.KUBECLAW_LLM_PROVIDER = 'claude';
    });

    it("returns api 'anthropic-messages'", () => {
      expect(buildModel().api).toBe('anthropic-messages');
    });

    it("returns provider 'anthropic'", () => {
      expect(buildModel().provider).toBe('anthropic');
    });

    it('uses default baseUrl when ANTHROPIC_BASE_URL is unset', () => {
      expect(buildModel().baseUrl).toBe('https://api.anthropic.com');
    });

    it('uses default model id when ANTHROPIC_MODEL is unset', () => {
      expect(buildModel().id).toBe('claude-sonnet-4-5');
    });

    it('honours ANTHROPIC_MODEL override', () => {
      process.env.ANTHROPIC_MODEL = 'claude-opus-4-5';
      expect(buildModel().id).toBe('claude-opus-4-5');
    });

    it('honours ANTHROPIC_BASE_URL override', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://my-proxy.example.com';
      expect(buildModel().baseUrl).toBe('https://my-proxy.example.com');
    });
  });

  // ── provider=anthropic (alias) ─────────────────────────────────────────────

  describe("provider 'anthropic' (alias)", () => {
    beforeEach(() => {
      process.env.KUBECLAW_LLM_PROVIDER = 'anthropic';
    });

    it("returns api 'anthropic-messages'", () => {
      expect(buildModel().api).toBe('anthropic-messages');
    });

    it("returns provider 'anthropic'", () => {
      expect(buildModel().provider).toBe('anthropic');
    });

    it('uses default baseUrl', () => {
      expect(buildModel().baseUrl).toBe('https://api.anthropic.com');
    });

    it('uses default model id', () => {
      expect(buildModel().id).toBe('claude-sonnet-4-5');
    });
  });

  // ── provider=openrouter ───────────────────────────────────────────────────

  describe("provider 'openrouter'", () => {
    beforeEach(() => {
      process.env.KUBECLAW_LLM_PROVIDER = 'openrouter';
    });

    it("returns api 'openai-completions'", () => {
      expect(buildModel().api).toBe('openai-completions');
    });

    it("returns provider 'openrouter'", () => {
      expect(buildModel().provider).toBe('openrouter');
    });

    it('uses the openrouter baseUrl', () => {
      expect(buildModel().baseUrl).toBe('https://openrouter.ai/api/v1');
    });

    it('honours OPENROUTER_MODEL override', () => {
      process.env.OPENROUTER_MODEL = 'mistralai/mistral-7b-instruct';
      expect(buildModel().id).toBe('mistralai/mistral-7b-instruct');
    });

    it('honours OPENROUTER_BASE_URL override', () => {
      process.env.OPENROUTER_BASE_URL = 'https://custom-router.example.com/v1';
      expect(buildModel().baseUrl).toBe('https://custom-router.example.com/v1');
    });
  });

  // ── provider=ollama ───────────────────────────────────────────────────────

  describe("provider 'ollama'", () => {
    beforeEach(() => {
      process.env.KUBECLAW_LLM_PROVIDER = 'ollama';
    });

    it('baseUrl ends with /v1', () => {
      expect(buildModel().baseUrl).toMatch(/\/v1$/);
    });

    it('uses default ollama host when OLLAMA_HOST is unset', () => {
      expect(buildModel().baseUrl).toBe('http://ollama:11434/v1');
    });

    it('honours OLLAMA_HOST override', () => {
      process.env.OLLAMA_HOST = 'http://localhost:11434';
      expect(buildModel().baseUrl).toBe('http://localhost:11434/v1');
    });
  });

  // ── default / provider=openai ─────────────────────────────────────────────

  describe('default provider (openai)', () => {
    it('uses openai baseUrl when no provider is set', () => {
      expect(buildModel().baseUrl).toBe('https://api.openai.com/v1');
    });

    it("returns provider 'openai'", () => {
      expect(buildModel().provider).toBe('openai');
    });

    it("uses default model id 'gpt-4o'", () => {
      expect(buildModel().id).toBe('gpt-4o');
    });

    it("provider 'openai' explicit also returns openai baseUrl", () => {
      process.env.KUBECLAW_LLM_PROVIDER = 'openai';
      expect(buildModel().baseUrl).toBe('https://api.openai.com/v1');
    });
  });
});

// ── getApiKeyForProvider() ─────────────────────────────────────────────────

describe('getApiKeyForProvider()', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("'claude' returns ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(getApiKeyForProvider('claude')).toBe('sk-ant-test');
  });

  it("'anthropic' returns ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-alias';
    expect(getApiKeyForProvider('anthropic')).toBe('sk-ant-alias');
  });

  it("'openrouter' returns OPENROUTER_API_KEY", () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(getApiKeyForProvider('openrouter')).toBe('sk-or-test');
  });

  it("'ollama' returns the literal string 'ollama'", () => {
    expect(getApiKeyForProvider('ollama')).toBe('ollama');
  });

  it("default provider returns OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    expect(getApiKeyForProvider('openai')).toBe('sk-openai-test');
  });

  it("'claude' returns undefined when ANTHROPIC_API_KEY is not set", () => {
    expect(getApiKeyForProvider('claude')).toBeUndefined();
  });
});
