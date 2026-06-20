// src/channel-sdk/index.test.ts
import { describe, it, expect } from 'vitest';
import { buildChannelSdk } from './index.js';
import { registerChannel } from '../channels/registry.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';

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
