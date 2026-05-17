import { db } from '../db.js';

export interface PerGroupInstanceRow {
  groupFolder: string;
  capabilityName: string;
  groupHash: string;
  deploymentName: string;
  serviceName: string;
  currentReplicas: number;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface UpsertInstanceInput {
  groupFolder: string;
  capabilityName: string;
  groupHash: string;
  deploymentName: string;
  serviceName: string;
}

function rowToInstance(r: Record<string, unknown>): PerGroupInstanceRow {
  return {
    groupFolder: r.group_folder as string,
    capabilityName: r.capability_name as string,
    groupHash: r.group_hash as string,
    deploymentName: r.deployment_name as string,
    serviceName: r.service_name as string,
    currentReplicas: r.current_replicas as number,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    createdAt: r.created_at as number,
  };
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

export function upsertInstance(input: UpsertInstanceInput): void {
  const now = Math.floor(Date.now() / 1000);
  run(
    `INSERT INTO per_group_capability_instances
       (group_folder, capability_name, group_hash, deployment_name, service_name, current_replicas, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT(group_folder, capability_name) DO UPDATE SET
       group_hash = excluded.group_hash,
       deployment_name = excluded.deployment_name,
       service_name = excluded.service_name`,
    [input.groupFolder, input.capabilityName, input.groupHash,
     input.deploymentName, input.serviceName, now],
  );
}

export function getInstance(groupFolder: string, capabilityName: string): PerGroupInstanceRow | null {
  const rows = all(
    `SELECT * FROM per_group_capability_instances WHERE group_folder=? AND capability_name=?`,
    [groupFolder, capabilityName],
  );
  return rows[0] ? rowToInstance(rows[0]) : null;
}

export function listInstances(groupFolder: string): PerGroupInstanceRow[] {
  return all(
    `SELECT * FROM per_group_capability_instances WHERE group_folder=?`,
    [groupFolder],
  ).map(rowToInstance);
}

export function listAllInstances(): PerGroupInstanceRow[] {
  return all(`SELECT * FROM per_group_capability_instances`).map(rowToInstance);
}

export function listInstancesAtReplicas(replicas: number): PerGroupInstanceRow[] {
  return all(
    `SELECT * FROM per_group_capability_instances WHERE current_replicas=?`,
    [replicas],
  ).map(rowToInstance);
}

export function setReplicas(groupFolder: string, capabilityName: string, replicas: number): void {
  run(
    `UPDATE per_group_capability_instances SET current_replicas=? WHERE group_folder=? AND capability_name=?`,
    [replicas, groupFolder, capabilityName],
  );
}

export function touchLastUsed(groupFolder: string, capabilityName: string, unixSeconds: number): void {
  run(
    `UPDATE per_group_capability_instances SET last_used_at=? WHERE group_folder=? AND capability_name=?`,
    [unixSeconds, groupFolder, capabilityName],
  );
}

export function deleteInstancesByGroup(groupFolder: string): void {
  run(`DELETE FROM per_group_capability_instances WHERE group_folder=?`, [groupFolder]);
}

export function deleteInstance(groupFolder: string, capabilityName: string): void {
  run(
    `DELETE FROM per_group_capability_instances WHERE group_folder=? AND capability_name=?`,
    [groupFolder, capabilityName],
  );
}
