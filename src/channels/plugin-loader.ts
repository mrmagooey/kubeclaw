import fs from 'fs';
import { pathToFileURL } from 'url';

import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import type { ChannelPluginContext } from './registry.js';

const pluginContext: ChannelPluginContext = { registerChannel };

export async function loadChannelPlugins(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(`${dir}/${file}`).href);
      if (typeof mod.default === 'function') {
        mod.default(pluginContext);
        logger.info({ plugin: file }, 'Channel plugin loaded');
      }
    } catch (err) {
      logger.error({ plugin: file, err }, 'Failed to load channel plugin');
    }
  }
}
