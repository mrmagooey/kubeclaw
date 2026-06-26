import { randomBytes } from 'node:crypto';
import type { PerGroupK8sClient } from './k8s-client.js';
import {
  readGroupCredential,
  setGroupCredential,
  ensureGroupMcpToken,
} from './credentials.js';

export interface EnsureGroupDbCredentialsArgs {
  client: PerGroupK8sClient;
  namespace: string;
  groupFolder: string;
  capabilityName: string;
}

/**
 * Idempotently provision all per-group credentials required by the database
 * capability:
 *
 * - `KUBECLAW_MCP_TOKEN` — MCP bearer token (reuses `ensureGroupMcpToken`).
 * - `POSTGRES_PASSWORD` — rw Postgres role password (24 random bytes → 48 hex chars).
 * - `PGPASSWORD`        — same value as `POSTGRES_PASSWORD` (Postgres env alias).
 * - `PG_RO_PASSWORD`    — ro Postgres role password (distinct 24 random bytes).
 *
 * Each key is read first; only missing keys are generated and written.
 * The rw password is generated once and written to BOTH `POSTGRES_PASSWORD`
 * and `PGPASSWORD` to avoid them diverging on a second call.
 */
export async function ensureGroupDbCredentials(
  args: EnsureGroupDbCredentialsArgs,
): Promise<void> {
  const base = {
    client: args.client,
    namespace: args.namespace,
    groupFolder: args.groupFolder,
    capabilityName: args.capabilityName,
  };

  // 1. MCP bearer token — reuse the existing helper (generates 32 bytes → 64 hex).
  await ensureGroupMcpToken(base);

  // 2. rw password: POSTGRES_PASSWORD and PGPASSWORD hold the SAME value.
  //    Read POSTGRES_PASSWORD to determine whether a rw password has been set.
  let rwPassword = await readGroupCredential({
    ...base,
    envName: 'POSTGRES_PASSWORD',
  });
  if (!rwPassword) {
    rwPassword = randomBytes(24).toString('hex');
    await setGroupCredential({ ...base, envName: 'POSTGRES_PASSWORD', value: rwPassword });
    await setGroupCredential({ ...base, envName: 'PGPASSWORD', value: rwPassword });
  }

  // 3. ro password: distinct from rw, 24 random bytes.
  const roPassword = await readGroupCredential({
    ...base,
    envName: 'PG_RO_PASSWORD',
  });
  if (!roPassword) {
    await setGroupCredential({
      ...base,
      envName: 'PG_RO_PASSWORD',
      value: randomBytes(24).toString('hex'),
    });
  }
}
