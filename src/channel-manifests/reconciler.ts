/**
 * Channel Manifests Reconciler — Story 178.
 *
 * Mirrors `src/specialists/reconciler.ts` for the `kubeclaw-channel-manifests`
 * ConfigMap. Merges Helm baseline entries with SQLite admin overrides (admin
 * entry wins on channel_type collision) and applies the result to the live
 * ConfigMap.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { listChannelManifestOverrides, type SidecarSpec } from '../skills/orchestrator/channel-manifest-registry.js';
import { logger } from '../logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChannelManifestEntry {
  channel_type: string;
  package_name: string;
  package_version: string;
  manifest_hash: string;
  source: 'helm-baseline' | 'admin-registered';
  registered_at: string;
  registered_by: string;
  /** Raw package.json string — present for baseline and admin entries. */
  package_json?: string;
  /** Raw package-lock.json string — present for baseline and admin entries. */
  package_lock_json?: string;
  /** Determines the pod command for the resident channel host. Default 'standalone'. */
  hostMode?: 'standalone' | 'channel-runner';
  /** The channel's HTTP port if it serves HTTP traffic (e.g. 4080). Optional — omitted when not set. */
  httpPort?: number;
  /** Optional sidecar container spec; only valid when hostMode === 'channel-runner'. */
  sidecar?: SidecarSpec;
}

/** Shape of each per-channel-type JSON file in the baseline ConfigMap mount. */
interface BaselineFileContent {
  packageJson: string;
  packageLockJson: string;
  manifestHash: string;
  hostMode?: 'standalone' | 'channel-runner';
  httpPort?: number;
  sidecar?: SidecarSpec;
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge Helm baseline entries with admin override entries.
 * Admin entry wins on `channel_type` key collision.
 * Output is sorted by `channel_type`.
 */
export function mergeManifests(
  baseline: ChannelManifestEntry[],
  overrides: ChannelManifestEntry[],
): ChannelManifestEntry[] {
  const byType = new Map<string, ChannelManifestEntry>();
  for (const e of baseline) byType.set(e.channel_type, e);
  for (const e of overrides) byType.set(e.channel_type, e); // override wins
  return [...byType.values()].sort((a, b) =>
    a.channel_type.localeCompare(b.channel_type),
  );
}

// ─── Baseline loader ─────────────────────────────────────────────────────────

const BASELINE_DIR = '/etc/kubeclaw/channel-manifests-baseline';

/**
 * Load Helm-supplied baseline manifests from the mounted ConfigMap directory.
 * Each file is named `<channel_type>.json` and contains a BaselineFileContent.
 * Returns an empty array if the directory does not exist or files cannot be parsed.
 */
export function loadBaselineFromDisk(
  dir = BASELINE_DIR,
): ChannelManifestEntry[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    logger.warn({ err, dir }, 'channel-manifests baseline dir read failed');
    return [];
  }
  const entries: ChannelManifestEntry[] = [];
  for (const file of files) {
    const channel_type = file.replace(/\.json$/, '');
    try {
      const raw = readFileSync(`${dir}/${file}`, 'utf-8');
      const content = JSON.parse(raw) as BaselineFileContent;
      const pkg = JSON.parse(content.packageJson) as {
        name?: string;
        version?: string;
      };
      entries.push({
        channel_type,
        package_name: pkg.name ?? channel_type,
        package_version: pkg.version ?? '0.0.0',
        manifest_hash: content.manifestHash,
        source: 'helm-baseline',
        registered_at: new Date(0).toISOString(),
        registered_by: 'helm',
        package_json: content.packageJson,
        package_lock_json: content.packageLockJson,
        hostMode: content.hostMode,
        httpPort: content.httpPort,
        ...(content.sidecar !== undefined ? { sidecar: content.sidecar } : {}),
      });
    } catch (err) {
      logger.warn(
        { err, file },
        'channel-manifests baseline file parse failed',
      );
    }
  }
  return entries;
}

// ─── Per-type ConfigMap rendering ──────────────────────────────────────────────

/** Minimal shape needed to render a manifest into the per-type ConfigMap value. */
export type RenderableManifest = Pick<
  ChannelManifestEntry,
  'channel_type' | 'package_json' | 'package_lock_json' | 'manifest_hash' | 'hostMode' | 'httpPort' | 'sidecar'
>;

/**
 * Build the live `kubeclaw-channel-manifests` ConfigMap `data` map: one key per
 * channel type (`<channel_type>.json`) whose value is the JSON the orchestrator
 * reads at commit time (packageJson, packageLockJson, manifestHash, hostMode).
 *
 * `hostMode` MUST be included: getChannelHostMode reads it to choose the
 * steady-state pod command (channel-runner vs standalone). Entries missing
 * package files are skipped (nothing to install/deliver).
 */
export function renderChannelManifestConfigMapData(
  manifests: RenderableManifest[],
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const m of manifests) {
    if (m.package_json && m.package_lock_json) {
      data[`${m.channel_type}.json`] = JSON.stringify({
        packageJson: m.package_json,
        packageLockJson: m.package_lock_json,
        manifestHash: m.manifest_hash,
        hostMode: m.hostMode ?? 'standalone',
        ...(m.httpPort !== undefined ? { httpPort: m.httpPort } : {}),
        ...(m.sidecar !== undefined ? { sidecar: m.sidecar } : {}),
      });
    }
  }
  return data;
}

// ─── Reconciler ───────────────────────────────────────────────────────────────

export interface ReconcilerDeps {
  /** Loads the Helm-supplied baseline manifests. */
  baselineLoader: () => ChannelManifestEntry[];
  /** Server-side apply the rendered JSON to the kubeclaw-channel-manifests ConfigMap. */
  configMapApply: (rendered: string) => Promise<void>;
}

export class ChannelManifestReconciler {
  private generation = 0;
  private applyChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReconcilerDeps) {}

  async apply(): Promise<void> {
    // Chain _applyOnce after the previous apply; swallow errors on the chain
    // so a failure does not permanently poison subsequent applies.
    const next = this.applyChain.then(() => this._applyOnce());
    this.applyChain = next.catch(() => {});
    return next;
  }

  private async _applyOnce(): Promise<void> {
    const baseline = this.deps.baselineLoader();
    const rawOverrides = listChannelManifestOverrides();

    // Convert SQLite rows to ChannelManifestEntry shape
    const overrides: ChannelManifestEntry[] = rawOverrides.map((row) => {
      const pkg = JSON.parse(row.package_json) as {
        name?: string;
        version?: string;
      };
      return {
        channel_type: row.channel_type,
        package_name: pkg.name ?? row.channel_type,
        package_version: pkg.version ?? '0.0.0',
        manifest_hash: row.manifest_hash,
        source: 'admin-registered' as const,
        registered_at: row.registered_at,
        registered_by: row.registered_by,
        package_json: row.package_json,
        package_lock_json: row.package_lock_json,
        hostMode: (row.host_mode as 'standalone' | 'channel-runner' | undefined) ?? 'standalone',
        ...(row.http_port !== undefined ? { httpPort: row.http_port as number } : {}),
        ...(row.sidecar !== undefined ? { sidecar: row.sidecar } : {}),
      };
    });

    const merged = mergeManifests(baseline, overrides).map((entry) => ({
      ...entry,
      hostMode: entry.hostMode ?? 'standalone',
    }));
    this.generation += 1;
    const rendered = JSON.stringify(
      { version: 1, generation: this.generation, manifests: merged },
      null,
      2,
    );

    try {
      await this.deps.configMapApply(rendered);
      logger.info(
        { generation: this.generation, count: merged.length },
        'channel-manifests ConfigMap applied',
      );
    } catch (err) {
      logger.error({ err }, 'channel-manifests ConfigMap apply failed');
      this.generation -= 1; // do not bump on failure
      throw err;
    }
  }
}
