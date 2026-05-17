import { db } from '../db.js';

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: unknown;
}

function all(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  stmt.bind(params as never);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql: string, params: unknown[] = []): void {
  db.run(sql, params as never);
}

export function cacheSchemas(
  capabilityName: string,
  image: string,
  schemas: McpToolSchema[],
): void {
  const now = Math.floor(Date.now() / 1000);
  run(
    `INSERT INTO capability_tool_schemas
       (capability_name, image, schemas_json, scraped_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(capability_name, image) DO UPDATE SET
       schemas_json = excluded.schemas_json,
       scraped_at   = excluded.scraped_at`,
    [capabilityName, image, JSON.stringify(schemas), now],
  );
}

export function getCachedSchemas(
  capabilityName: string,
  image: string,
): McpToolSchema[] | null {
  const rows = all(
    `SELECT schemas_json FROM capability_tool_schemas
     WHERE capability_name=? AND image=?`,
    [capabilityName, image],
  );
  if (rows.length === 0) return null;
  return JSON.parse(rows[0].schemas_json as string) as McpToolSchema[];
}

export function clearCachedSchemas(
  capabilityName: string,
  image: string,
): void {
  run(
    `DELETE FROM capability_tool_schemas
     WHERE capability_name=? AND image=?`,
    [capabilityName, image],
  );
}

export function listAllCachedSchemas(): Array<{
  capabilityName: string;
  image: string;
  schemas: McpToolSchema[];
  scrapedAt: number;
}> {
  return all(`SELECT * FROM capability_tool_schemas`).map((r) => ({
    capabilityName: r.capability_name as string,
    image: r.image as string,
    schemas: JSON.parse(r.schemas_json as string) as McpToolSchema[],
    scrapedAt: r.scraped_at as number,
  }));
}
