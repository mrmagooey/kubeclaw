import { readFileSync, watch, existsSync, FSWatcher } from 'fs';
import { dirname } from 'path';
import { logger } from '../logger.js';
import { GlobalSpecialist, parseSpecialists } from './types.js';

export class SpecialistCatalogLoader {
  private cache: GlobalSpecialist[] = [];
  private generation = 0;
  private watcher?: FSWatcher;

  constructor(private readonly path: string) {}

  start(): void {
    this.load();
    // Watch the parent dir so kubelet's atomic symlink swap (..data → new) is observed.
    const dir = dirname(this.path);
    if (!existsSync(dir)) return;
    this.watcher = watch(dir, { persistent: false }, () => {
      // Debounce by always re-reading; load() is idempotent on no change.
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
    try { json = readFileSync(this.path, 'utf-8'); }
    catch (err) { logger.warn({ err, path: this.path }, 'specialist catalog read failed; keeping cache'); return; }
    const r = parseSpecialists(json);
    if (!r.ok) { logger.warn({ error: r.error, path: this.path }, 'specialist catalog parse failed; keeping cache'); return; }
    if (r.generation === this.generation && this.cache.length === r.specialists.length) return; // no-op
    this.cache = r.specialists;
    this.generation = r.generation;
    logger.info({ count: r.specialists.length, generation: r.generation }, 'specialist catalog loaded');
  }

  getAll(): GlobalSpecialist[] {
    return this.cache;
  }

  findByMention(name: string): GlobalSpecialist | undefined {
    const lower = name.toLowerCase();
    return this.cache.find(s =>
      s.name.toLowerCase() === lower ||
      (s.triggers ?? []).some(t => t.toLowerCase() === lower),
    );
  }
}
