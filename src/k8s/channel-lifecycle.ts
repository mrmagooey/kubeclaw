/**
 * Channel lifecycle manager — orchestrator side.
 *
 * Watches for channel pod status events (ready, configured, error)
 * and drives the channel setup flow: after a blank pod reports 'ready',
 * the orchestrator sends a 'configure' command with the channel skill
 * document and dependency list.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import {
  getRedisSubscriber,
  getChannelStatusChannel,
} from './redis-client.js';
import { publishControlCommand } from './ipc-redis.js';

export interface ChannelStatusEvent {
  status: 'ready' | 'configured' | 'error';
  detail?: string;
}

type StatusCallback = (channelName: string, event: ChannelStatusEvent) => void;

const statusCallbacks: StatusCallback[] = [];

/**
 * Register a callback for channel status events.
 */
export function onChannelStatus(cb: StatusCallback): void {
  statusCallbacks.push(cb);
}

/**
 * Start watching for channel status events on all known channel names.
 * Called once during orchestrator startup.
 */
export function startChannelStatusWatcher(channelNames: string[]): void {
  const subscriber = getRedisSubscriber();

  for (const name of channelNames) {
    const channel = getChannelStatusChannel(name);
    subscriber.subscribe(channel, (err) => {
      if (err)
        logger.error({ err, channel }, 'Failed to subscribe to channel status');
      else
        logger.info({ channel }, 'Subscribed to channel status');
    });
  }

  subscriber.on('message', (ch, message) => {
    // Extract channel name from the Redis channel: kubeclaw:channel-status:{name}
    const prefix = 'kubeclaw:channel-status:';
    if (!ch.startsWith(prefix)) return;
    const channelName = ch.slice(prefix.length);

    try {
      const event = JSON.parse(message) as ChannelStatusEvent;
      logger.info({ channelName, ...event }, 'Channel status event');
      for (const cb of statusCallbacks) {
        cb(channelName, event);
      }
    } catch (err) {
      logger.error({ err, ch }, 'Failed to parse channel status event');
    }
  });
}

/**
 * Subscribe to a specific channel's status events dynamically.
 * Used when a new channel is created at runtime.
 */
export function watchChannelStatus(channelName: string): void {
  const subscriber = getRedisSubscriber();
  const channel = getChannelStatusChannel(channelName);
  subscriber.subscribe(channel, (err) => {
    if (err)
      logger.error({ err, channel }, 'Failed to subscribe to channel status');
    else
      logger.info({ channel }, 'Dynamically subscribed to channel status');
  });
}

/**
 * Load a channel skill document from the skills/channel/ directory.
 */
function loadChannelSkill(channelType: string): string | null {
  for (const base of [
    path.join(process.cwd(), 'skills', 'channel'),
    '/app/skills/channel',
  ]) {
    const p = path.join(base, `${channelType}.md`);
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch {
      /* not found */
    }
  }
  return null;
}

/**
 * Parse the frontmatter of a channel skill document to extract dependencies.
 */
function parseDependencies(skillDoc: string): string[] {
  const match = skillDoc.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const frontmatter = match[1];
  const depsMatch = frontmatter.match(/dependencies:\n((?:\s+-\s+.+\n?)*)/);
  if (!depsMatch) return [];
  return depsMatch[1]
    .split('\n')
    .map((line) => line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

/**
 * Send a configure command to a channel pod.
 *
 * Loads the channel skill document, parses dependencies, and publishes
 * the configure command via the control channel.
 */
export async function configureChannel(
  instanceName: string,
  channelType: string,
): Promise<void> {
  const skillDoc = loadChannelSkill(channelType);
  const dependencies = skillDoc ? parseDependencies(skillDoc) : [];

  await publishControlCommand(instanceName, {
    command: 'configure',
    channelType,
    dependencies: dependencies.length > 0 ? dependencies : undefined,
    skillDocument: skillDoc || undefined,
  });

  logger.info(
    { instanceName, channelType, deps: dependencies },
    'Sent configure command to channel pod',
  );
}

/**
 * Wait for a channel pod to reach a specific status.
 * Returns the event or null on timeout.
 */
export function waitForChannelStatus(
  channelName: string,
  targetStatus: 'ready' | 'configured',
  timeoutMs = 60_000,
): Promise<ChannelStatusEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const handler: StatusCallback = (name, event) => {
      if (name === channelName && event.status === targetStatus) {
        cleanup();
        resolve(event);
      } else if (name === channelName && event.status === 'error') {
        cleanup();
        resolve(event);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      const idx = statusCallbacks.indexOf(handler);
      if (idx >= 0) statusCallbacks.splice(idx, 1);
    };

    statusCallbacks.push(handler);
  });
}
