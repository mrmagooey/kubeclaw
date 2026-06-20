/**
 * Channel SDK — the curated, stable surface the single generic image exposes to
 * runtime-delivered channel adapters. The host (channel-runner) injects an
 * instance of ChannelSdk into an adapter's default-exported register(sdk)
 * function; the adapter calls sdk.registerChannel(...) exactly as a compiled-in
 * channel does. Adapters depend ONLY on this surface from the image; everything
 * else is their own npm dependency.
 */
import { registerChannel } from '../channels/registry.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';

export interface ChannelSdk {
  registerChannel: typeof registerChannel;
  logger: typeof logger;
  readEnvFile: typeof readEnvFile;
  assistantName: string;
  groupsDir: string;
}

/** Signature an adapter module must default-export. */
export type RuntimeAdapterRegister = (sdk: ChannelSdk) => void;

export function buildChannelSdk(): ChannelSdk {
  return {
    registerChannel,
    logger,
    readEnvFile,
    assistantName: ASSISTANT_NAME,
    groupsDir: GROUPS_DIR,
  };
}
