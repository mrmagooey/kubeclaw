import { db } from '../db.js';
import type { ToolSpec } from '../tools/types.js';

export function putPendingDiscovered(args: {
  name: string;
  spec: ToolSpec;
  scopeGroup: string | null;
  catalogId: string;
  now: number;
}): void {
  db.run(
    `INSERT OR REPLACE INTO pending_discovered_tools
       (name, spec_json, scope_group, catalog_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      args.name,
      JSON.stringify(args.spec),
      args.scopeGroup,
      args.catalogId,
      args.now,
    ],
  );
}

export function getPendingDiscovered(name: string):
  | {
      spec: ToolSpec;
      scopeGroup: string | null;
      catalogId: string;
      createdAt: number;
    }
  | undefined {
  const rows = db.exec(
    `SELECT spec_json, scope_group, catalog_id, created_at
     FROM pending_discovered_tools
     WHERE name = ?`,
    [name],
  );
  if (rows.length === 0 || rows[0].values.length === 0) return undefined;
  const row = rows[0].values[0];
  return {
    spec: JSON.parse(row[0] as string) as ToolSpec,
    scopeGroup: (row[1] as string | null) ?? null,
    catalogId: row[2] as string,
    createdAt: row[3] as number,
  };
}

export function deletePendingDiscovered(name: string): void {
  db.run(`DELETE FROM pending_discovered_tools WHERE name = ?`, [name]);
}

/** Delete rows older than ttlMs, return the removed names. */
export function prunePendingDiscovered(now: number, ttlMs: number): string[] {
  const rows = db.exec(
    `SELECT name FROM pending_discovered_tools WHERE (? - created_at) > ?`,
    [now, ttlMs],
  );
  if (rows.length === 0 || rows[0].values.length === 0) return [];
  const names = rows[0].values.map((r) => r[0] as string);
  for (const n of names) {
    db.run(`DELETE FROM pending_discovered_tools WHERE name = ?`, [n]);
  }
  return names;
}
