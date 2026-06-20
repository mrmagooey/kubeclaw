// src/channel-sdk/index.test.ts
import { describe, it, expect } from 'vitest';
import { buildChannelSdk } from './index.js';
import { registerChannel } from '../channels/registry.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import {
  TIMEZONE,
  STORE_DIR,
  RATE_LIMIT_WINDOW_MS,
  TOOL_JOBS_RETENTION_DAYS,
  DEBUG_ENDPOINTS_ENABLED,
} from '../config.js';
import { DEFAULT_DIRECT_MODEL } from '../runtime/llm-client.js';

describe('buildChannelSdk', () => {
  it('exposes the resident singletons and assistant name', () => {
    const sdk = buildChannelSdk();
    expect(sdk.registerChannel).toBe(registerChannel);
    expect(sdk.logger).toBe(logger);
    expect(sdk.readEnvFile).toBe(readEnvFile);
    expect(sdk.assistantName).toBe(ASSISTANT_NAME);
    expect(sdk.groupsDir).toBe(GROUPS_DIR);
  });
});

describe('buildChannelSdk — data facade', () => {
  it('sdk.config has the 6 constants with correct values', () => {
    const sdk = buildChannelSdk();
    expect(sdk.config.timezone).toBe(TIMEZONE);
    expect(sdk.config.storeDir).toBe(STORE_DIR);
    expect(sdk.config.rateLimitWindowMs).toBe(RATE_LIMIT_WINDOW_MS);
    expect(sdk.config.toolJobsRetentionDays).toBe(TOOL_JOBS_RETENTION_DAYS);
    expect(sdk.config.defaultModel).toBe(DEFAULT_DIRECT_MODEL);
    expect(sdk.config.debugEndpointsEnabled).toBe(DEBUG_ENDPOINTS_ENABLED);
    // type checks
    expect(typeof sdk.config.rateLimitWindowMs).toBe('number');
    expect(typeof sdk.config.toolJobsRetentionDays).toBe('number');
    expect(typeof sdk.config.debugEndpointsEnabled).toBe('boolean');
  });

  it('sdk.history exposes the 12 facade methods', () => {
    const sdk = buildChannelSdk();
    expect(typeof sdk.history.getPage).toBe('function');
    expect(typeof sdk.history.getAll).toBe('function');
    expect(typeof sdk.history.getById).toBe('function');
    expect(typeof sdk.history.search).toBe('function');
    expect(typeof sdk.history.getOutboundSince).toBe('function');
    expect(typeof sdk.history.append).toBe('function');
    expect(typeof sdk.history.update).toBe('function');
    expect(typeof sdk.history.deleteById).toBe('function');
    expect(typeof sdk.history.deleteBefore).toBe('function');
    expect(typeof sdk.history.clear).toBe('function');
    expect(typeof sdk.history.storeOutbound).toBe('function');
    expect(typeof sdk.history.groupFolderForMessage).toBe('function');
  });

  it('sdk.tasks exposes 7 facade methods', () => {
    const sdk = buildChannelSdk();
    expect(typeof sdk.tasks.create).toBe('function');
    expect(typeof sdk.tasks.getForGroup).toBe('function');
    expect(typeof sdk.tasks.getById).toBe('function');
    expect(typeof sdk.tasks.deleteForGroup).toBe('function');
    expect(typeof sdk.tasks.pause).toBe('function');
    expect(typeof sdk.tasks.resume).toBe('function');
    expect(typeof sdk.tasks.getRunLogs).toBe('function');
  });

  it('sdk.jobs exposes 4 facade methods', () => {
    const sdk = buildChannelSdk();
    expect(typeof sdk.jobs.active).toBe('function');
    expect(typeof sdk.jobs.recentForGroup).toBe('function');
    expect(typeof sdk.jobs.byIdForGroup).toBe('function');
    expect(typeof sdk.jobs.insertForDebug).toBe('function');
  });

  it('sdk.audit exposes write and entries', () => {
    const sdk = buildChannelSdk();
    expect(typeof sdk.audit.write).toBe('function');
    expect(typeof sdk.audit.entries).toBe('function');
  });

  it('sdk.diag is a function', () => {
    const sdk = buildChannelSdk();
    expect(typeof sdk.diag).toBe('function');
  });

  it('sdk.skills exposes 5 pre-bound facade methods', () => {
    const sdk = buildChannelSdk();
    expect(typeof sdk.skills.listAccepted).toBe('function');
    expect(typeof sdk.skills.listCandidates).toBe('function');
    expect(typeof sdk.skills.listArchived).toBe('function');
    expect(typeof sdk.skills.accept).toBe('function');
    expect(typeof sdk.skills.reject).toBe('function');
  });
});
