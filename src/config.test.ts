import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getContainerImage,
  validateProvider,
  validateOpenRouterConfig,
  sanitizeProvider,
} from './config.js';
import { logger } from './logger.js';

describe('getContainerImage', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLAUDE_CONTAINER_IMAGE;
    delete process.env.OPENROUTER_CONTAINER_IMAGE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns claude image for claude provider', () => {
    const result = getContainerImage('claude');
    expect(result).toBe('kubeclaw-agent:claude');
  });

  it('returns openrouter image for openrouter provider', () => {
    const result = getContainerImage('openrouter');
    expect(result).toBe('kubeclaw-agent:openrouter');
  });

  it('uses env override for claude provider', () => {
    process.env.CLAUDE_CONTAINER_IMAGE = 'custom-claude:latest';
    const result = getContainerImage('claude');
    expect(result).toBe('custom-claude:latest');
  });

  it('uses env override for openrouter provider', () => {
    process.env.OPENROUTER_CONTAINER_IMAGE = 'custom-openrouter:latest';
    const result = getContainerImage('openrouter');
    expect(result).toBe('custom-openrouter:latest');
  });
});

describe('validateProvider', () => {
  it('returns claude for valid claude provider', () => {
    const result = validateProvider('claude');
    expect(result).toBe('claude');
  });

  it('returns openrouter for valid openrouter provider', () => {
    const result = validateProvider('openrouter');
    expect(result).toBe('openrouter');
  });

  it('returns null for null input', () => {
    const result = validateProvider(null);
    expect(result).toBeNull();
  });

  it('returns null for undefined input', () => {
    const result = validateProvider(undefined);
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = validateProvider('');
    expect(result).toBeNull();
  });

  it('returns the provider for any non-empty string', () => {
    const result = validateProvider('invalid');
    expect(result).toBe('invalid');
  });
});

describe('validateOpenRouterConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns invalid when no API key is set', () => {
    const result = validateOpenRouterConfig();
    expect(result.valid).toBe(false);
    expect(result.hasKey).toBe(false);
    expect(result.warnings).toContain('OPENROUTER_API_KEY is not set');
  });

  it('returns valid when API key is set', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-abc123';
    const result = validateOpenRouterConfig();
    expect(result.valid).toBe(true);
    expect(result.hasKey).toBe(true);
    expect(result.warnings).not.toContain('OPENROUTER_API_KEY is not set');
  });

  it('returns warning for invalid key format', () => {
    process.env.OPENROUTER_API_KEY = 'sk-wrong-format';
    const result = validateOpenRouterConfig();
    expect(result.hasKey).toBe(true);
    expect(result.warnings).toContain(
      'OPENROUTER_API_KEY has unexpected format (should start with sk-or-v1-)',
    );
  });

  it('returns warning for invalid model format (no slash)', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-abc123';
    process.env.OPENROUTER_MODEL = 'gpt-4o';
    const result = validateOpenRouterConfig();
    expect(result.warnings).toContain(
      'OPENROUTER_MODEL "gpt-4o" should use "provider/model-name" format (e.g., "openai/gpt-4o")',
    );
  });

  it('returns no warning for valid model format', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-abc123';
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o';
    const result = validateOpenRouterConfig();
    expect(result.warnings).not.toContain(
      expect.stringContaining('OPENROUTER_MODEL'),
    );
  });
});

describe('sanitizeProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns valid provider unchanged', () => {
    const result = sanitizeProvider('claude');
    expect(result).toBe('claude');
  });

  it('returns openrouter for valid openrouter provider', () => {
    const result = sanitizeProvider('openrouter');
    expect(result).toBe('openrouter');
  });

  it('returns default for null input', () => {
    const result = sanitizeProvider(null);
    expect(result).toBe('openai');
  });

  it('returns default for undefined input', () => {
    const result = sanitizeProvider(undefined);
    expect(result).toBe('openai');
  });

  it('returns default for empty string', () => {
    const result = sanitizeProvider('');
    expect(result).toBe('openai');
  });

  it('returns any non-empty string as-is (open provider)', () => {
    vi.mocked(logger.warn).mockClear();
    const result = sanitizeProvider('invalid-provider');
    expect(result).toBe('invalid-provider');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns non-empty string unchanged regardless of default', () => {
    const result = sanitizeProvider('custom-llm', 'openrouter');
    expect(result).toBe('custom-llm');
  });
});
