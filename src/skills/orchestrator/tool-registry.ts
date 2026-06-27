import { logger } from '../../logger.js';
import { db } from '../../db.js';
import { ToolSpec, validateTool } from '../../tools/types.js';
import { checkEgressCredentialCoherence } from '../../k8s/egress/coherence.js';

export type Result = { ok: true } | { ok: false; error: string };
export type ReconcileFn = () => Promise<void>;

export function registerTool(
  t: ToolSpec,
  reconcile?: ReconcileFn,
  catalogHostLookup?: (id: string) => string | undefined,
): Result {
  const v = validateTool(t);
  if (!v.ok) return v;
  if (catalogHostLookup) {
    const c = checkEgressCredentialCoherence(t, catalogHostLookup);
    if (!c.ok) return { ok: false, error: c.error ?? 'egress/credential coherence failed' };
  }

  const existing = db.exec(`SELECT 1 FROM tool_overrides WHERE name = ?`, [
    t.name,
  ]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    return { ok: false, error: `tool already registered: ${t.name}` };
  }

  const now = Date.now();
  db.run(
    `INSERT INTO tool_overrides (name, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [t.name, JSON.stringify(t), now, now],
  );
  reconcile?.().catch((err) => {
    // Log but do not surface — mutation already succeeded
    logger.warn({ err }, 'reconcile after tool mutation failed');
  });
  return { ok: true };
}

export function editTool(
  args: { name: string; patch: Partial<ToolSpec> },
  reconcile?: ReconcileFn,
  catalogHostLookup?: (id: string) => string | undefined,
): Result {
  const rows = db.exec(`SELECT spec_json FROM tool_overrides WHERE name = ?`, [
    args.name,
  ]);
  if (rows.length === 0 || rows[0].values.length === 0) {
    return { ok: false, error: `no override registered: ${args.name}` };
  }

  const specJson = rows[0].values[0][0] as string;
  const merged: ToolSpec = {
    ...(JSON.parse(specJson) as ToolSpec),
    ...args.patch,
    name: args.name,
  };

  const v = validateTool(merged);
  if (!v.ok) return v;
  if (catalogHostLookup) {
    const c = checkEgressCredentialCoherence(merged, catalogHostLookup);
    if (!c.ok) return { ok: false, error: c.error ?? 'egress/credential coherence failed' };
  }

  db.run(
    `UPDATE tool_overrides SET spec_json = ?, updated_at = ? WHERE name = ?`,
    [JSON.stringify(merged), Date.now(), args.name],
  );
  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after tool mutation failed');
  });
  return { ok: true };
}

export function removeTool(
  args: { name: string },
  reconcile?: ReconcileFn,
): Result {
  const existing = db.exec(`SELECT 1 FROM tool_overrides WHERE name = ?`, [
    args.name,
  ]);
  if (existing.length === 0 || existing[0].values.length === 0) {
    return { ok: false, error: `no such override: ${args.name}` };
  }

  db.run(`DELETE FROM tool_overrides WHERE name = ?`, [args.name]);
  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after tool mutation failed');
  });
  return { ok: true };
}

export function listToolOverrides(): ToolSpec[] {
  const rows = db.exec(`SELECT spec_json FROM tool_overrides ORDER BY name`);
  if (rows.length === 0) return [];
  return rows[0].values.map((row) => JSON.parse(row[0] as string) as ToolSpec);
}
