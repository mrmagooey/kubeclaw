import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { logger } from './logger.js';

describe('logger', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates a pino logger with all required methods', () => {
    expect(logger).toBeDefined();
    expect(logger.debug).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();
    expect(logger.fatal).toBeDefined();
  });

  it('logger has debug method that can be called', () => {
    logger.debug('test message');
    expect(logger.debug).toHaveBeenCalledWith('test message');
  });

  it('logger has info method that can be called', () => {
    logger.info('test message');
    expect(logger.info).toHaveBeenCalledWith('test message');
  });

  it('logger has warn method that can be called', () => {
    logger.warn('test message');
    expect(logger.warn).toHaveBeenCalledWith('test message');
  });

  it('logger has error method that can be called', () => {
    logger.error('test message');
    expect(logger.error).toHaveBeenCalledWith('test message');
  });

  it('logger has fatal method that can be called', () => {
    logger.fatal('test message');
    expect(logger.fatal).toHaveBeenCalledWith('test message');
  });

  it('logger methods support structured logging with object', () => {
    logger.info({ key: 'value' }, 'message');
    expect(logger.info).toHaveBeenCalledWith({ key: 'value' }, 'message');
  });
});
