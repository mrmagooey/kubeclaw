/**
 * E2E test: Redis ACL isolation per tool-job (Story 5)
 *
 * Acceptance criteria (one `it()` per AC):
 *   AC1 – After createJobACL, ACL LIST contains scoped entry `sidecar-<jobId>` with
 *          read on `kubeclaw:input:<jobId>` and publish on `kubeclaw:messages:<groupFolder>`.
 *   AC2 – Job credentials work for XREAD on own input stream + PUBLISH to own group channel.
 *   AC3 – Same credentials get NOPERM when accessing another job's input or another group's channel.
 *   AC4 – After revokeJobACL, ACL LIST no longer contains the entry; revoked creds get WRONGPASS/NOAUTH.
 *   AC5 – SQLite job_acls table records status='active' then 'revoked' in sync with Redis.
 *
 * Infrastructure assumptions
 * --------------------------
 * • Kind cluster: kubeclaw-e2e-istio.  Context is whatever kubectl currently points to.
 * • `KUBECLAW_SKIP_HELM_INSTALL=true` — this suite manages its own Helm release in an
 *   isolated namespace so it never collides with global-setup's release.
 * • Redis 7-alpine is pre-loaded in the kind node (verified before writing this test).
 * • redis-cli is invoked via `kubectl exec` into the kubeclaw-redis-0 pod so no extra
 *   image pull is required.
 * • ACLManager methods are invoked via `kubectl exec … node -e '…'` against the
 *   orchestrator pod — the same approach the production code takes.
 * • SQLite reads are done via `kubectl exec … sqlite3 /data/kubeclaw.db`.
 *
 * The test installs a minimal kubeclaw Helm release (no channels, orchestrator replicas=1,
 * Redis StatefulSet) into an isolated namespace and tears it down in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'child_process';

// ── Constants ────────────────────────────────────────────────────────────────

const NS = 'kubeclaw-e2e-redisacl';
const RELEASE = 'ke2e-redisacl';

// Stable IDs for the two jobs used across all ACs.
const JOB_A = 'e2e-acl-job-a';
const JOB_B = 'e2e-acl-job-b';
const GROUP_A = 'group-alice';
const GROUP_B = 'group-bob';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Run kubectl inside the test namespace; returns trimmed stdout. */
function k(args: string, opts: { allowFail?: boolean; timeout?: number } = {}): string {
  try {
    return execSync(`kubectl --namespace ${NS} ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 30_000,
    }).trim();
  } catch (e: any) {
    if (opts.allowFail) return (e.stdout ?? '').trim();
    throw e;
  }
}

/** Retrieve the Redis admin password from the kubeclaw-redis Secret. */
function getRedisAdminPassword(): string {
  const b64 = execSync(
    `kubectl -n ${NS} get secret kubeclaw-redis -o jsonpath={.data.admin-password}`,
    { encoding: 'utf8' },
  ).trim();
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Run a redis-cli command inside the kubeclaw-redis-0 pod as a given user.
 * Returns trimmed stdout (stderr suppressed).
 *
 * auth: optional { username, password } — omit to run as the admin user whose
 * password is read from the kubeclaw-redis Secret.
 */
function redisCli(
  cmd: string,
  auth?: { username: string; password: string },
  opts: { allowFail?: boolean } = {},
): string {
  const adminPwd = getRedisAdminPassword();

  // Passwords are alphanumeric (Helm randAlphaNum) or base64url (job ACLs),
  // so they never contain shell-special characters.  We pass the entire
  // shellCmd through JSON.stringify so it arrives as a double-quoted string to
  // sh -c.  This avoids the single-quote quoting problem that arises when cmd
  // contains redis-cli argument literals like '*' (used by XADD auto-ID).
  const username = auth ? auth.username : 'orchestrator';
  const password = auth ? auth.password : adminPwd;
  const authFlags = `--user ${username} -a ${password}`;

  const shellCmd = `redis-cli --no-auth-warning ${authFlags} ${cmd}`;

  try {
    return execSync(
      `kubectl -n ${NS} exec kubeclaw-redis-0 -- sh -c ${JSON.stringify(shellCmd)}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 },
    ).trim();
  } catch (e: any) {
    if (opts.allowFail) return ((e.stdout ?? '') + (e.stderr ?? '')).trim();
    throw e;
  }
}

/**
 * Invoke an ACLManager method inside the orchestrator pod via `kubectl exec node -e`.
 *
 * The script snippet must import and use getACLManager() from the compiled dist.
 * We wrap it in a top-level async IIFE so `await` works.
 */
function orchestratorNode(script: string, timeout = 30_000): string {
  // The orchestrator runs the compiled JS at /app/dist/index.js.
  // We target the same node binary and module resolution context.
  //
  // IMPORTANT: the script must be single-line when passed to the shell via
  // JSON.stringify — the shell does NOT expand \n in double-quoted strings to
  // actual newlines, so literal backslash-n sequences in source text would cause
  // SyntaxError. We strip newlines and leading whitespace so statements
  // (already terminated with `;`) run safely on one line.
  const oneLiner = script.replace(/\n\s*/g, ' ');
  const wrapped = `(async () => { ${oneLiner} })().catch(e => { process.stderr.write(String(e)); process.exit(1); });`;
  return execSync(
    `kubectl -n ${NS} exec deploy/kubeclaw-orchestrator -- node --input-type=module -e ${JSON.stringify(wrapped)}`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout },
  ).trim();
}

/**
 * Read a single column value from SQLite inside the orchestrator pod using Node.js.
 * The sql.js database is used instead of the sqlite3 CLI (not available in the image).
 * Returns the first column of the first row, or empty string if no rows.
 */
function sqliteQuery(sql: string): string {
  const raw = orchestratorNode(
    `const dbModule = await import('/app/dist/db.js');
     await dbModule.initDatabase();
     const result = dbModule.db.exec(${JSON.stringify(sql)});
     const value = result.length > 0 && result[0].values.length > 0 ? String(result[0].values[0][0]) : '';
     process.stdout.write('SQLRESULT:' + value);
     process.exit(0);`,
    15_000,
  );
  const marker = 'SQLRESULT:';
  // Find the marker in raw output (may be mixed with log lines)
  const idx = raw.indexOf(marker);
  if (idx === -1) {
    throw new Error(`sqliteQuery: no SQLRESULT marker in output: ${raw}`);
  }
  return raw.slice(idx + marker.length).trim();
}

/**
 * Invoke createJobACL(jobId, groupFolder) on the ACLManager running inside the orchestrator.
 * The orchestrator pod has all env vars (REDIS_URL, REDIS_ADMIN_PASSWORD, ACL_ENCRYPTION_KEY)
 * already set — we just import the manager and call the method.
 *
 * Note: dynamic import() is used because the script runs inside an async IIFE where
 * top-level static `import` declarations are not permitted. initDatabase() must be
 * called before ACL operations because the fresh node process starts without it.
 */
function createJobACL(jobId: string, groupFolder: string): void {
  orchestratorNode(
    `const { initDatabase } = await import('/app/dist/db.js');
     const { getACLManager } = await import('/app/dist/k8s/acl-manager.js');
     await initDatabase();
     await getACLManager().createJobACL(${JSON.stringify(jobId)}, ${JSON.stringify(groupFolder)});
     process.stdout.write('ok');
     await getACLManager().close();
     process.exit(0);`,
    60_000,
  );
}

/**
 * Invoke revokeJobACL(jobId) on the ACLManager inside the orchestrator.
 */
function revokeJobACL(jobId: string): void {
  orchestratorNode(
    `const { initDatabase } = await import('/app/dist/db.js');
     const { getACLManager } = await import('/app/dist/k8s/acl-manager.js');
     await initDatabase();
     await getACLManager().revokeJobACL(${JSON.stringify(jobId)});
     process.stdout.write('ok');
     await getACLManager().close();
     process.exit(0);`,
    30_000,
  );
}

/**
 * Retrieve the plaintext credentials for a job via the ACLManager inside the orchestrator.
 * Returns { username, password } or throws if not found.
 */
function getJobCredentials(jobId: string): { username: string; password: string } {
  const raw = orchestratorNode(
    `const { initDatabase } = await import('/app/dist/db.js');
     const { getACLManager } = await import('/app/dist/k8s/acl-manager.js');
     await initDatabase();
     const creds = getACLManager().getJobCredentials(${JSON.stringify(jobId)});
     process.stdout.write('CREDS:' + JSON.stringify(creds));
     await getACLManager().close();
     process.exit(0);`,
    15_000,
  );
  // Strip pino log lines (contain "level":) and find the CREDS: marker line.
  const credsLine = raw.split('\n').find((l) => l.startsWith('CREDS:'));
  if (!credsLine) {
    throw new Error(`getJobCredentials(${jobId}): no CREDS marker in output: ${raw}`);
  }
  const parsed = JSON.parse(credsLine.slice('CREDS:'.length));
  if (!parsed || !parsed.username || !parsed.password) {
    throw new Error(`getJobCredentials(${jobId}) returned null`);
  }
  return parsed;
}

/**
 * Poll `condition()` until it returns true or `timeoutMs` elapses.
 * Returns true on success, false on timeout.
 */
function poll(
  condition: () => boolean,
  timeoutMs: number = 30_000,
  intervalMs: number = 1_000,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    execSync(`sleep ${intervalMs / 1000}`);
  }
  return false;
}

// ── Suite ────────────────────────────────────────────────────────────────────

// Guard: skip entire suite if the active kubectl cluster is not reachable.
const clusterReachable =
  spawnSync('kubectl', ['cluster-info'], {
    stdio: 'pipe',
  }).status === 0;

describe.skipIf(!clusterReachable)(
  'Redis ACL isolation per tool-job (Story 5)',
  { timeout: 15 * 60 * 1000 },
  () => {
    let helmInstalled = false;

    // ── beforeAll: install kubeclaw into isolated namespace ─────────────────
    beforeAll(() => {
      // No explicit context switch — rely on whatever kubectl currently points to.

      // Tear down any leftover namespace from a previous run and wait for it to go away.
      execSync(`kubectl delete ns ${NS} --wait=false 2>/dev/null || true`, { stdio: 'pipe' });
      execSync(
        `kubectl wait --for=delete ns/${NS} --timeout=120s 2>/dev/null || true`,
        { stdio: 'pipe' },
      );
      execSync(`kubectl create ns ${NS}`, { stdio: 'inherit' });

      // Pre-create kubeclaw-secrets so the orchestrator starts cleanly.
      execSync(
        `kubectl -n ${NS} create secret generic kubeclaw-secrets ` +
          `--from-literal=anthropic-api-key=sk-ant-placeholder ` +
          `--from-literal=anthropic-model=placeholder ` +
          `--from-literal=openai-api-key=placeholder ` +
          `--from-literal=openai-base-url="" ` +
          `--from-literal=embedding-base-url="" ` +
          `--from-literal=embedding-dim=1536 ` +
          `--from-literal=embedding-model=placeholder ` +
          `--from-literal=direct-llm-model=placeholder ` +
          `--dry-run=client -o yaml | kubectl apply -f -`,
        { stdio: 'inherit' },
      );

      // Install kubeclaw — orchestrator only, no channels.
      // We skip the StorageClass spec to avoid PVC provisioner issues in kind;
      // the StatefulSet uses whatever the cluster default is.
      execSync(
        [
          'helm upgrade --install',
          RELEASE,
          './helm/kubeclaw',
          `-n ${NS}`,
          '--create-namespace',
          `--set namespace=${NS}`,
          '--set image.tag=e2e-test',
          '--set image.pullPolicy=IfNotPresent',
          '--set orchestrator.replicas=1',
          '--set orchestrator.admin.enabled=false',
          '--set credentialInjection.mode=off',
          // Tell helm the secrets were pre-created so it doesn't try to own them.
          '--set secrets.existingSecret=kubeclaw-secrets',
          // Null out resource requests so the test can schedule on a resource-saturated cluster.
          '--set-json \'orchestrator.resources=null\'',
          '--set-json \'redis.resources=null\'',
          // No channels — keeps the install lean.
        ].join(' '),
        { stdio: 'inherit', timeout: 5 * 60 * 1000 },
      );
      helmInstalled = true;

      // Wait for Redis StatefulSet to be ready.
      execSync(
        `kubectl -n ${NS} rollout status statefulset/kubeclaw-redis --timeout=180s`,
        { stdio: 'inherit' },
      );

      // Wait for orchestrator Deployment to be ready.
      execSync(
        `kubectl -n ${NS} rollout status deployment/kubeclaw-orchestrator --timeout=180s`,
        { stdio: 'inherit' },
      );

      // Clean up any leftover ACL users from a prior test run (idempotent).
      for (const jobId of [JOB_A, JOB_B]) {
        redisCli(`ACL DELUSER sidecar-${jobId}`, undefined, { allowFail: true });
      }
    }, 8 * 60 * 1000);

    // ── afterAll: tear down ──────────────────────────────────────────────────
    afterAll(() => {
      if (!helmInstalled) return;

      // Best-effort cleanup — do not let failures here block test reporting.
      try {
        execSync(`helm uninstall ${RELEASE} -n ${NS} 2>/dev/null || true`, { stdio: 'pipe' });
      } catch (_) { /* ignored */ }
      try {
        execSync(`kubectl delete ns ${NS} --wait=false 2>/dev/null || true`, { stdio: 'pipe' });
      } catch (_) { /* ignored */ }
    }, 120_000);

    // ── AC1: ACL LIST contains scoped entry for sidecar-<jobId> ─────────────
    it(
      'AC1: createJobACL creates scoped ACL entry in Redis with correct key/channel patterns',
      () => {
        // Create ACL for job A.
        createJobACL(JOB_A, GROUP_A);

        // ACL LIST returns one line per user. Find the line for sidecar-JOB_A.
        const aclList = redisCli('ACL LIST');
        const lines = aclList.split('\n');
        const userLine = lines.find((l) => l.includes(`sidecar-${JOB_A}`));

        expect(
          userLine,
          `ACL LIST must contain an entry for sidecar-${JOB_A}`,
        ).toBeDefined();

        // The entry must include the read-only key pattern for the job's input stream.
        // RedisACLManager uses `%R~kubeclaw:input:<jobId>` (read-only key selector).
        expect(
          userLine,
          'ACL entry must restrict key access to own input stream (read-only)',
        ).toContain(`kubeclaw:input:${JOB_A}`);

        // The entry must include the channel grant for the group's output channel.
        // RedisACLManager uses `&kubeclaw:messages:<groupFolder>`.
        expect(
          userLine,
          'ACL entry must grant publish access to own group messages channel',
        ).toContain(`kubeclaw:messages:${GROUP_A}`);

        // The user must be enabled ('on').
        expect(userLine, 'ACL entry must be enabled').toContain(' on ');
      },
      60_000,
    );

    // ── AC2: Job credentials work for XREAD + PUBLISH ───────────────────────
    it(
      'AC2: job credentials allow XREAD on own input stream and PUBLISH to own group channel',
      () => {
        // Ensure job A's ACL exists (AC1 may have run first, but tests are independent).
        createJobACL(JOB_A, GROUP_A);

        // Retrieve plaintext credentials via the ACLManager (decrypts from SQLite).
        const creds = getJobCredentials(JOB_A);
        expect(creds.username).toBe(`sidecar-${JOB_A}`);
        expect(creds.password).toBeTruthy();

        // ── XREAD on own input stream ──────────────────────────────────────
        // First write a test entry as admin, then read it as the sidecar user.
        const inputKey = `kubeclaw:input:${JOB_A}`;
        redisCli(`XADD ${inputKey} '*' type test payload hello`);

        const xreadOut = redisCli(
          `XREAD COUNT 1 STREAMS ${inputKey} 0`,
          creds,
        );
        // XREAD returns the stream name and entries on success; NOPERM on failure.
        expect(xreadOut, 'sidecar user must be able to XREAD own input stream').not.toMatch(
          /NOPERM|WRONGPASS|NOAUTH/i,
        );
        expect(xreadOut, 'XREAD must return data from input stream').toContain(inputKey);

        // ── PUBLISH to own group messages channel ──────────────────────────
        const publishOut = redisCli(
          `PUBLISH kubeclaw:messages:${GROUP_A} test-payload`,
          creds,
        );
        // PUBLISH returns the number of subscribers (integer ≥ 0) on success.
        expect(publishOut, 'PUBLISH must succeed for own group channel').toMatch(/^\d+$/);
      },
      60_000,
    );

    // ── AC3: Credentials get NOPERM for other job's input or other group's channel ──
    it(
      'AC3: job credentials get NOPERM when accessing another job\'s input or another group\'s channel',
      () => {
        // Ensure both ACLs exist.
        createJobACL(JOB_A, GROUP_A);
        createJobACL(JOB_B, GROUP_B);

        const credsA = getJobCredentials(JOB_A);

        // ── JOB_A creds must NOT read JOB_B's input stream ────────────────
        const inputKeyB = `kubeclaw:input:${JOB_B}`;
        // Ensure job B's input stream exists so the ACL check fires, not a missing-key error.
        redisCli(`XADD ${inputKeyB} '*' type test payload hello`);

        const xreadCrossJob = redisCli(
          `XREAD COUNT 1 STREAMS ${inputKeyB} 0`,
          credsA,
          { allowFail: true },
        );
        expect(
          xreadCrossJob,
          "job A creds must get NOPERM when reading job B's input stream",
        ).toMatch(/NOPERM/i);

        // ── JOB_A creds must NOT publish to JOB_B's group channel ─────────
        const publishCrossGroup = redisCli(
          `PUBLISH kubeclaw:messages:${GROUP_B} cross-group`,
          credsA,
          { allowFail: true },
        );
        expect(
          publishCrossGroup,
          "job A creds must get NOPERM when publishing to job B's group channel",
        ).toMatch(/NOPERM/i);
      },
      60_000,
    );

    // ── AC4: After revokeJobACL, entry is gone and creds are rejected ────────
    it(
      'AC4: revokeJobACL removes ACL entry from Redis; revoked creds get WRONGPASS or NOAUTH',
      () => {
        // Ensure job A's ACL exists and capture creds before revocation.
        createJobACL(JOB_A, GROUP_A);
        const creds = getJobCredentials(JOB_A);

        // Verify the user exists before revocation.
        const aclListBefore = redisCli('ACL LIST');
        expect(
          aclListBefore,
          'ACL LIST must contain the entry before revocation',
        ).toContain(`sidecar-${JOB_A}`);

        // Revoke.
        revokeJobACL(JOB_A);

        // ACL LIST must no longer contain the entry.
        const aclListAfter = redisCli('ACL LIST');
        expect(
          aclListAfter,
          'ACL LIST must NOT contain the entry after revocation',
        ).not.toContain(`sidecar-${JOB_A}`);

        // Revoked creds must be rejected — try PING with the old password.
        const pingOut = redisCli('PING', creds, { allowFail: true });
        expect(
          pingOut,
          'Revoked creds must get WRONGPASS or NOAUTH',
        ).toMatch(/WRONGPASS|NOAUTH/i);
      },
      60_000,
    );

    // ── AC5: SQLite job_acls records status='active' then 'revoked' ─────────
    it(
      'AC5: SQLite job_acls table records status=active after create and status=revoked after revoke',
      () => {
        const jobId = 'e2e-acl-sqlite-verify';

        // Create ACL — should insert a row with status='active'.
        createJobACL(jobId, GROUP_A);

        const statusAfterCreate = sqliteQuery(
          `SELECT status FROM job_acls WHERE job_id='${jobId}';`,
        );
        expect(
          statusAfterCreate,
          'job_acls row must have status=active after createJobACL',
        ).toBe('active');

        // Revoke — should update to status='revoked'.
        revokeJobACL(jobId);

        const statusAfterRevoke = sqliteQuery(
          `SELECT status FROM job_acls WHERE job_id='${jobId}';`,
        );
        expect(
          statusAfterRevoke,
          'job_acls row must have status=revoked after revokeJobACL',
        ).toBe('revoked');

        // Cleanup.
        redisCli(`ACL DELUSER sidecar-${jobId}`, undefined, { allowFail: true });
      },
      60_000,
    );
  },
);
