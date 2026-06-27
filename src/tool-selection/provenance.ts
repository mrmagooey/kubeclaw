import { db } from '../db.js';
import type { AutoToolMeta, Provenance } from './types.js';

export function recordAutoTool(meta: {
  name: string;
  provenance: Provenance;
  scopeGroup: string | null;
  sourceDigest?: string | null;
  transcript?: string | null;
  now: number;
}): void {
  db.run(
    `INSERT OR REPLACE INTO auto_tool_meta
       (name, provenance, scope_group, source_digest, acquired_at, last_used_at, transcript)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.name,
      meta.provenance,
      meta.scopeGroup,
      meta.sourceDigest ?? null,
      meta.now,
      meta.now,
      meta.transcript ?? null,
    ],
  );
}

export function touchAutoTool(name: string, now: number): void {
  db.run(`UPDATE auto_tool_meta SET last_used_at = ? WHERE name = ?`, [
    now,
    name,
  ]);
}

function rowToMeta(row: unknown[]): AutoToolMeta {
  return {
    name: row[0] as string,
    provenance: row[1] as Provenance,
    scopeGroup: (row[2] as string | null) ?? null,
    sourceDigest: (row[3] as string | null) ?? null,
    acquiredAt: row[4] as number,
    lastUsedAt: row[5] as number,
    transcript: (row[6] as string | null) ?? null,
  };
}

export function getAutoTool(name: string): AutoToolMeta | undefined {
  const rows = db.exec(`SELECT * FROM auto_tool_meta WHERE name = ?`, [name]);
  if (rows.length === 0 || rows[0].values.length === 0) return undefined;
  return rowToMeta(rows[0].values[0]);
}

export function listAutoTools(): AutoToolMeta[] {
  const rows = db.exec(`SELECT * FROM auto_tool_meta ORDER BY name`);
  if (rows.length === 0) return [];
  return rows[0].values.map(rowToMeta);
}

export function pruneStaleAutoTools(now: number, ttlMs: number): string[] {
  const rows = db.exec(
    `SELECT name FROM auto_tool_meta WHERE (? - last_used_at) > ?`,
    [now, ttlMs],
  );
  if (rows.length === 0 || rows[0].values.length === 0) return [];
  const names = rows[0].values.map((r) => r[0] as string);
  for (const n of names) {
    db.run(`DELETE FROM auto_tool_meta WHERE name = ?`, [n]);
  }
  return names;
}
