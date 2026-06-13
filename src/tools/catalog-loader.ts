import { readFileSync, watch, existsSync, FSWatcher } from 'fs';
import { dirname } from 'path';
import { logger } from '../logger.js';
import { ToolSpec, parseToolCatalog } from './types.js';

export class ToolCatalogLoader {
  private cache: ToolSpec[] = [];
  private generation = 0;
  private watcher?: FSWatcher;

  constructor(private readonly path: string) {}

  start(): void {
    this.load();
    const dir = dirname(this.path);
    if (!existsSync(dir)) return;
    this.watcher = watch(dir, { persistent: false }, () => {
      setTimeout(() => this.load(), 50);
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.cache = [];
      this.generation = 0;
      return;
    }
    let json: string;
    try {
      json = readFileSync(this.path, 'utf-8');
    } catch (err) {
      logger.warn(
        { err, path: this.path },
        'tool catalog read failed; keeping cache',
      );
      return;
    }
    const r = parseToolCatalog(json);
    if (!r.ok) {
      logger.warn(
        { error: r.error, path: this.path },
        'tool catalog parse failed; keeping cache',
      );
      return;
    }
    if (
      r.generation === this.generation &&
      this.cache.length === r.tools.length
    )
      return;
    this.cache = r.tools;
    this.generation = r.generation;
    logger.info(
      { count: r.tools.length, generation: r.generation },
      'tool catalog loaded',
    );
  }

  getAll(): ToolSpec[] {
    return this.cache;
  }

  /** Tools visible to `channelName`: those with empty/absent `channels` or that list it. */
  getForChannel(channelName: string): ToolSpec[] {
    return this.cache.filter(
      (t) => !t.channels?.length || t.channels.includes(channelName),
    );
  }
}
