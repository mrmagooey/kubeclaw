import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

/**
 * Context object passed to a channel plugin's default export at load time.
 *
 * A plugin file must export a single default function that receives this
 * context and uses it to register one or more channels:
 *
 * ```js
 * // mychannel.plugin.js
 * export default function(ctx) {
 *   ctx.registerChannel('mychannel', (opts) => {
 *     const token = process.env.MYCHANNEL_TOKEN;
 *     if (!token) return null;
 *     return new MyChannel(token, opts);
 *   });
 * }
 * ```
 *
 * The factory passed to `registerChannel` follows the same contract as a
 * TypeScript source channel: it receives `ChannelOpts`, must return a `Channel`
 * instance on success, or `null` when credentials are missing (which disables
 * the channel silently).
 */
export interface ChannelPluginContext {
  registerChannel: (name: string, factory: ChannelFactory) => void;
}

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
