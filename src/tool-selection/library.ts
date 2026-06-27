import { readFileSync, watch, existsSync, type FSWatcher } from 'fs';
import { dirname } from 'path';
import { logger } from '../logger.js';
import { parseToolCatalog, type ToolSpec } from '../tools/types.js';

export class ToolLibraryLoader {
  private cache: ToolSpec[] = [];
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
      return;
    }
    try {
      const r = parseToolCatalog(readFileSync(this.path, 'utf-8'));
      if (!r.ok) {
        logger.warn({ error: r.error, path: this.path }, 'tool library parse failed; keeping cache');
        return;
      }
      this.cache = r.tools;
      logger.info({ count: r.tools.length }, 'tool library loaded');
    } catch (err) {
      logger.warn({ err, path: this.path }, 'tool library read failed; keeping cache');
    }
  }

  getAll(): ToolSpec[] {
    return this.cache;
  }
}
