import { db, saveDatabase } from '../db.js';
import type {
  CapabilitySpec,
  CapabilityKind,
  CapabilityStatus,
  CapabilityLifecycle,
} from './types.js';

export function setCapability(spec: CapabilitySpec): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO capabilities (name, kind, spec, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       kind = excluded.kind,
       spec = excluded.spec,
       updated_at = excluded.updated_at`,
    [spec.name, spec.kind, JSON.stringify(spec), now, now],
  );
  saveDatabase();
}

export function getCapability(name: string): CapabilitySpec | undefined {
  const stmt = db.prepare(`SELECT spec FROM capabilities WHERE name = ?`);
  stmt.bind([name]);
  if (!stmt.step()) {
    stmt.free();
    return undefined;
  }
  const row = stmt.getAsObject() as { spec: string };
  stmt.free();
  return JSON.parse(row.spec) as CapabilitySpec;
}

export function getAllCapabilities(): CapabilitySpec[] {
  const result = db.exec(`SELECT spec FROM capabilities ORDER BY created_at`);
  if (result.length === 0) return [];
  return result[0].values.map(
    (row: unknown[]) => JSON.parse(row[0] as string) as CapabilitySpec,
  );
}

export function getCapabilitiesByKind(kind: CapabilityKind): CapabilitySpec[] {
  return getAllCapabilities().filter((c) => c.kind === kind);
}

export function deleteCapability(name: string): void {
  db.run(`DELETE FROM capabilities WHERE name = ?`, [name]);
  saveDatabase();
}

export interface StatusUpdate {
  lifecycle: CapabilityLifecycle;
  lastProbeAt: string | null;
  lastError: string | null;
}

export function updateCapabilityStatus(
  name: string,
  update: StatusUpdate,
): void {
  db.run(
    `UPDATE capabilities
       SET lifecycle = ?, last_probe_at = ?, last_error = ?, updated_at = ?
     WHERE name = ?`,
    [
      update.lifecycle,
      update.lastProbeAt,
      update.lastError,
      new Date().toISOString(),
      name,
    ],
  );
  saveDatabase();
}

export function getCapabilityStatus(
  name: string,
): CapabilityStatus | undefined {
  const stmt = db.prepare(
    `SELECT name, lifecycle, last_probe_at, last_error
       FROM capabilities WHERE name = ?`,
  );
  stmt.bind([name]);
  if (!stmt.step()) {
    stmt.free();
    return undefined;
  }
  const row = stmt.getAsObject() as {
    name: string;
    lifecycle: CapabilityLifecycle;
    last_probe_at: string | null;
    last_error: string | null;
  };
  stmt.free();
  return {
    name: row.name,
    lifecycle: row.lifecycle,
    lastProbeAt: row.last_probe_at,
    lastError: row.last_error,
  };
}
