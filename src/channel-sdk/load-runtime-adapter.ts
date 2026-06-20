import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ChannelSdk, RuntimeAdapterRegister } from './index.js';

const DEFAULT_ENTRY = '/runtime/channel-entry.js';

/**
 * Load a runtime-delivered channel adapter and invoke its register(sdk).
 * Returns false if no adapter is present (the pod has only compiled-in
 * channels). Throws if the file exists but is not a valid adapter — a runtime
 * channel pod with a broken adapter must crash-loop with an actionable error,
 * not silently run nothing.
 */
export async function loadRuntimeChannelAdapter(
  sdk: ChannelSdk,
  entryPath: string = DEFAULT_ENTRY,
): Promise<boolean> {
  if (!existsSync(entryPath)) return false;
  const mod = (await import(pathToFileURL(entryPath).href)) as {
    default?: unknown;
  };
  const register = mod.default;
  if (typeof register !== 'function') {
    throw new Error(
      `Runtime channel adapter at ${entryPath}: default export must be a function register(sdk); got ${typeof register}`,
    );
  }
  (register as RuntimeAdapterRegister)(sdk);
  return true;
}
