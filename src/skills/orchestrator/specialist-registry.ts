import { logger } from '../../logger.js';
import { db } from '../../db.js';
import {
  GlobalSpecialist,
  validateSpecialist,
} from '../../specialists/types.js';

export type Result = { ok: true } | { ok: false; error: string };
export type ReconcileFn = () => Promise<void>;

export function registerSpecialist(
  s: GlobalSpecialist,
  reconcile?: ReconcileFn,
): Result {
  const v = validateSpecialist(s);
  if (!v.ok) return v;

  const existing = db.exec(
    `SELECT 1 FROM specialist_overrides WHERE name = ?`,
    [s.name],
  );
  if (existing.length > 0 && existing[0].values.length > 0) {
    return { ok: false, error: `specialist already registered: ${s.name}` };
  }

  const now = Date.now();
  db.run(
    `INSERT INTO specialist_overrides (name, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    [s.name, JSON.stringify(s), now, now],
  );
  reconcile?.().catch((err) => {
    // Log but do not surface — mutation already succeeded
    logger.warn({ err }, 'reconcile after specialist mutation failed');
  });
  return { ok: true };
}

export function editSpecialist(
  args: { name: string; patch: Partial<GlobalSpecialist> },
  reconcile?: ReconcileFn,
): Result {
  const rows = db.exec(
    `SELECT spec_json FROM specialist_overrides WHERE name = ?`,
    [args.name],
  );
  if (rows.length === 0 || rows[0].values.length === 0) {
    return { ok: false, error: `no override registered: ${args.name}` };
  }

  const specJson = rows[0].values[0][0] as string;
  const merged: GlobalSpecialist = {
    ...(JSON.parse(specJson) as GlobalSpecialist),
    ...args.patch,
    name: args.name,
  };

  const v = validateSpecialist(merged);
  if (!v.ok) return v;

  db.run(
    `UPDATE specialist_overrides SET spec_json = ?, updated_at = ? WHERE name = ?`,
    [JSON.stringify(merged), Date.now(), args.name],
  );
  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after specialist mutation failed');
  });
  return { ok: true };
}

export function removeSpecialist(
  args: { name: string },
  reconcile?: ReconcileFn,
): Result {
  const existing = db.exec(
    `SELECT 1 FROM specialist_overrides WHERE name = ?`,
    [args.name],
  );
  if (existing.length === 0 || existing[0].values.length === 0) {
    return { ok: false, error: `no such override: ${args.name}` };
  }

  db.run(`DELETE FROM specialist_overrides WHERE name = ?`, [args.name]);
  reconcile?.().catch((err) => {
    logger.warn({ err }, 'reconcile after specialist mutation failed');
  });
  return { ok: true };
}

export function listSpecialistOverrides(): GlobalSpecialist[] {
  const rows = db.exec(
    `SELECT spec_json FROM specialist_overrides ORDER BY name`,
  );
  if (rows.length === 0) return [];
  return rows[0].values.map(
    (row) => JSON.parse(row[0] as string) as GlobalSpecialist,
  );
}
