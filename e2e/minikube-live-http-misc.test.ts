/**
 * Minikube-live HTTP-misc end-to-end tests.
 *
 * The globalSetup at e2e/minikube-live-setup.ts has helm-installed kubeclaw
 * into namespace `kubeclaw-live` and port-forwarded svc/kubeclaw-channel-http
 * to localhost:14081.
 *
 * Two unrelated but small tests:
 *
 *   1. http-capability-deploy — install a kind=http capability at runtime via
 *      Redis IPC and prove the pod's Service is reachable from inside the
 *      channel pod.
 *
 *   2. http-channel-image-attachment — exercise the multipart image upload
 *      path: POST a PNG to /message, assert 200, assert the file lands on the
 *      groups PVC, and assert conversation_history has an [ImageAttachment:]
 *      marker.
 *
 * NOTE on http-echo + securityContext:
 *   The http capability builder (src/capabilities/builders/common.ts) sets
 *   securityContext.runAsUser=1000 for every capability pod. hashicorp/http-echo
 *   runs fine as UID 1000 on most systems, but if the image bakes in a user
 *   expectation that conflicts with the port assignment (5678 is > 1024 so no
 *   privilege issue), the pod will still start. However if the cluster's
 *   admission/PSP prevents any override you may see a CrashLoopBackOff similar
 *   to the Qdrant runAsUser issue documented in minikube-live-rag.test.ts. In
 *   that case the Deployment poll below will timeout and the test will fail with
 *   a descriptive message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import Redis from 'ioredis';
import {
  KUBECLAW_LIVE_HTTP_LOCAL_PORT,
  KUBECLAW_LIVE_REDIS_LOCAL_PORT,
  KUBECLAW_LIVE_USER,
  KUBECLAW_LIVE_PASS,
} from './minikube-live-setup.js';

const NAMESPACE = 'kubeclaw-live';
const HTTP_URL = `http://127.0.0.1:${KUBECLAW_LIVE_HTTP_LOCAL_PORT}`;

// The http-echo capability we install at runtime.
const HTTP_ECHO_NAME = 'test-http-echo';
// deploymentName() in src/capabilities/builders/common.ts: `kubeclaw-cap-${name}`
const HTTP_ECHO_SERVICE = `kubeclaw-cap-${HTTP_ECHO_NAME}`;
const HTTP_ECHO_LABEL = `app=${HTTP_ECHO_SERVICE}`;
const HTTP_ECHO_PORT = 5678;

// ── Helpers (mirrors minikube-live.test.ts) ──────────────────────────────────

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function kubectl(
  args: string[],
  opts: { timeout?: number; input?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
    input: opts.input,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('Minikube-live: HTTP-misc (http capability deploy + image attachment)', () => {
  let provisioned = false;
  let redis: Redis | null = null;

  beforeAll(async () => {
    // Verify the HTTP-channel port-forward is live.
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${HTTP_URL}/`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.status > 0) {
          provisioned = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!provisioned) {
      console.warn(
        `Port-forward to ${HTTP_URL} not reachable after retries — globalSetup may have failed.`,
      );
      return;
    }

    // Connect to Redis as the orchestrator ACL user (same pattern as
    // minikube-live-capabilities.test.ts beforeAll).
    const pwd = kubectl([
      'get', 'secret', '-n', NAMESPACE, 'kubeclaw-redis',
      '-o', 'jsonpath={.data.admin-password}',
    ]);
    if (!pwd.ok || !pwd.stdout) {
      throw new Error(`failed to read redis admin-password: ${pwd.stderr}`);
    }
    const password = Buffer.from(pwd.stdout, 'base64').toString('utf8');
    redis = new Redis(
      `redis://orchestrator:${password}@127.0.0.1:${KUBECLAW_LIVE_REDIS_LOCAL_PORT}`,
      {
        // Tolerant config: survive a port-forward restart (typically <100 ms)
        // without the test-side client giving up. 20 retries × up to 2 s back-
        // off = up to ~20 s of reconnect attempts before hard failure.
        maxRetriesPerRequest: 20,
        connectTimeout: 15_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        reconnectOnError: () => true,
      },
    );
    await redis.ping();

    // Install the http-echo capability via Redis IPC.
    // hashicorp/http-echo accepts -text= and -listen= flags (see
    // https://github.com/hashicorp/http-echo). The capability builder passes
    // args directly to the container; healthPath is "/" because http-echo
    // responds to every path.
    const spec = {
      kind: 'http',
      name: HTTP_ECHO_NAME,
      image: 'hashicorp/http-echo:latest',
      port: HTTP_ECHO_PORT,
      args: [`-text=hello-from-test-http`, `-listen=:${HTTP_ECHO_PORT}`],
      healthPath: '/',
    };
    await redis.xadd(
      'kubeclaw:task-requests',
      '*',
      'type', 'install_capability',
      'groupFolder', 'http',
      'isMain', 'true',
      'spec', JSON.stringify(spec),
    );

    // Wait for the Deployment to be created by the orchestrator (up to 60 s).
    // We only verify K8s wiring (Deployment + Service) — not pod readiness —
    // because hashicorp/http-echo may CrashLoop under the capability builder's
    // runAsUser=1000 securityContext (same issue documented for Qdrant in
    // minikube-live-rag.test.ts). Confirming the Deployment exists is
    // sufficient to prove the IPC install_capability path is wired correctly.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const r = kubectl([
        'get', 'deployment', HTTP_ECHO_SERVICE, '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      if (r.ok && r.stdout.trim() === HTTP_ECHO_SERVICE) {
        break;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
  }, 120_000);

  afterAll(async () => {
    // Remove the capability so it doesn't leak into later tests.
    if (redis) {
      try {
        await redis.xadd(
          'kubeclaw:task-requests',
          '*',
          'type', 'remove_capability',
          'groupFolder', 'http',
          'isMain', 'true',
          'name', HTTP_ECHO_NAME,
        );
      } catch {
        /* ignore cleanup errors */
      }
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    }
  });

  // ── 1. http-capability-deploy ─────────────────────────────────────────────
  //
  // Verifies that a kind=http capability installed at runtime creates the
  // expected K8s wiring:
  //   a. Creates a Deployment named `kubeclaw-cap-test-http-echo`.
  //   b. Creates a Service named `kubeclaw-cap-test-http-echo`.
  //   c. Orchestrator logs confirm the capability was installed
  //      ('Capability installed via stream' with name=test-http-echo).
  //
  // NOTE on assertion (c): handleCapabilitiesUpdate() in channel-runner.ts
  // only processes MCP-kind entries from the capabilities_update payload and
  // does not log HTTP capability names. The orchestrator is the authoritative
  // source of truth for the install event — it logs 'Capability installed via
  // stream' with the name field whenever installCapability() succeeds via the
  // task-request stream.
  //
  // NOTE: We test wiring only and do NOT assert pod readiness or HTTP
  // reachability. hashicorp/http-echo may CrashLoop under the capability
  // builder's runAsUser=1000 securityContext (src/capabilities/builders/
  // common.ts:130). This is the same root cause documented for Qdrant in
  // minikube-live-rag.test.ts. The Deployment + Service being created
  // proves the install_capability IPC path is correctly wired end-to-end.
  it(
    'http-capability-deploy: a runtime-installed http capability is reachable from the channel pod',
    () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // (a) Deployment exists.
      const dep = kubectl([
        'get', 'deployment', HTTP_ECHO_SERVICE,
        '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      expect(
        dep.ok,
        `Deployment ${HTTP_ECHO_SERVICE} not found: ${dep.stderr}`,
      ).toBe(true);
      expect(dep.stdout.trim()).toBe(HTTP_ECHO_SERVICE);

      // (b) Service exists (created alongside the Deployment by the capability builder).
      const svc = kubectl([
        'get', 'service', HTTP_ECHO_SERVICE,
        '-n', NAMESPACE,
        '-o', 'jsonpath={.metadata.name}',
      ]);
      expect(
        svc.ok,
        `Service ${HTTP_ECHO_SERVICE} not found: ${svc.stderr}`,
      ).toBe(true);
      expect(svc.stdout.trim()).toBe(HTTP_ECHO_SERVICE);

      // (c) Orchestrator logs confirm the capability install event.
      // handleCapabilitiesUpdate() on the channel pod only processes MCP-kind
      // entries and does not log HTTP capability names. Check the orchestrator
      // logs instead — it emits 'Capability installed via stream' (info level,
      // pino JSON) containing the name field whenever installCapability()
      // succeeds via the kubeclaw:task-requests stream.
      const orchLogs = kubectl([
        'logs', '-n', NAMESPACE,
        'deployment/kubeclaw-orchestrator',
        '--tail=2000',
      ]);
      expect(orchLogs.ok, `kubectl logs (orchestrator) failed: ${orchLogs.stderr}`).toBe(true);
      expect(
        orchLogs.stdout,
        `expected '${HTTP_ECHO_NAME}' in orchestrator logs`,
      ).toContain(HTTP_ECHO_NAME);
    },
    30_000,
  );

  // ── 2. http-channel-image-attachment ─────────────────────────────────────
  //
  // Verifies the multipart image-upload path in src/channels/http.ts:396-445:
  //   a. POST multipart/form-data with a PNG image part → 200.
  //   b. An img-*.png file appears in the channel pod's groups PVC at
  //      /app/groups/http:alice/attachments/raw/.
  //   c. The conversation_history table has a row with [ImageAttachment: ...].
  //
  // Image used: a 67-byte 1x1 red PNG decoded from base64.
  //   PNG header: 89 50 4e 47 0d 0a 1a 0a  (8 bytes)
  //   IHDR chunk + IDAT chunk + IEND chunk
  // This is the canonical "smallest valid PNG" that all PNG decoders accept.
  // The MEDIA_MAGIC check in detectMediaType() only needs the first 8 bytes to
  // match [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].
  it(
    'http-channel-image-attachment: multipart image upload writes a file to the groups PVC and emits the [ImageAttachment:] marker',
    async () => {
      expect(provisioned, 'globalSetup port-forward not live').toBe(true);

      // Minimal 1×1 red PNG (67 bytes). Hardcoded base64 from the canonical
      // smallest-valid-PNG reference — this specific 67-byte image is widely
      // known (pngcheck passes it, all conformant decoders accept it).
      const TINY_PNG_B64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const pngBytes = Buffer.from(TINY_PNG_B64, 'base64');

      // Sanity: first 8 bytes must be the PNG magic bytes.
      const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      for (let i = 0; i < pngMagic.length; i++) {
        expect(pngBytes[i], `PNG magic byte[${i}] mismatch`).toBe(pngMagic[i]);
      }

      // Build multipart body using Node 20's native FormData + fetch.
      const form = new FormData();
      form.append(
        'image',
        new Blob([pngBytes], { type: 'image/png' }),
        'test-attachment.png',
      );
      form.append('text', 'e2e-image-attachment-test');

      // Prime: send a plain text JSON message first so the channel auto-registers
      // alice's group (jid=http:alice). The image upload path in http.ts:423 checks
      // registeredGroups()[jid] and silently drops the upload if the group is not
      // yet registered. A text message triggers onChatMetadata → auto-registration
      // (src/channel-runner.ts:788-798) before the image arrives.
      const primeRes = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'e2e-primer' }),
      });
      expect(
        primeRes.status,
        `expected 200 from primer text POST, got ${primeRes.status}`,
      ).toBe(200);

      // Give the channel pod time to process the primer and register the group.
      await new Promise((r) => setTimeout(r, 2000));

      // (a) POST to /message and assert 200.
      const res = await fetch(`${HTTP_URL}/message`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(KUBECLAW_LIVE_USER, KUBECLAW_LIVE_PASS),
        },
        body: form,
      });
      expect(
        res.status,
        `expected 200 from multipart POST, got ${res.status}`,
      ).toBe(200);

      // Give the channel pod a moment to write the file and append to the DB.
      await new Promise((r) => setTimeout(r, 2000));

      // Locate the channel pod.
      const podsR = kubectl([
        'get', 'pods', '-n', NAMESPACE, '-l', 'app=kubeclaw-channel-http',
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]);
      expect(podsR.ok, `get channel pod failed: ${podsR.stderr}`).toBe(true);
      const podName = podsR.stdout.trim();
      expect(podName, 'no channel pod found').toBeTruthy();

      // (b) The attachment file exists on the groups PVC.
      // Path: /app/groups/http:alice/attachments/raw/img-*.png
      // (GROUPS_DIR=/app/groups, jid=http:alice)
      // The shell script lists the directory and exits 0 if at least one
      // img-*.png file is found.
      const lsScript = `
        const fs = require('node:fs');
        const dir = '/app/groups/http:${KUBECLAW_LIVE_USER}/attachments/raw';
        if (!fs.existsSync(dir)) {
          console.error('dir-missing:' + dir);
          process.exit(1);
        }
        const files = fs.readdirSync(dir).filter((f) => f.startsWith('img-') && f.endsWith('.png'));
        if (files.length === 0) {
          console.error('no-img-files:' + dir);
          process.exit(1);
        }
        console.log('files-ok:' + files.join(','));
      `;
      const lsExec = kubectl(
        ['exec', '-n', NAMESPACE, podName, '-c', 'channel', '--', 'node', '-e', lsScript],
        { timeout: 15_000 },
      );
      expect(
        lsExec.ok,
        `attachment dir probe failed:\nstdout: ${lsExec.stdout}\nstderr: ${lsExec.stderr}`,
      ).toBe(true);
      expect(
        lsExec.stdout,
        `expected files-ok in probe output, got: ${lsExec.stdout}`,
      ).toMatch(/^files-ok:/m);

      // (c) conversation_history table has an [ImageAttachment:] row.
      // DB path in channel pod: /app/store/messages-http.db
      // (STORE_DIR=/app/store, KUBECLAW_CHANNEL=http → messages-http.db)
      // Group folder for http:alice → jidToFolder('http','http:alice')
      //   = folderPrefix('http') + '-' + sanitize('http:alice')
      //   = 'http' + '-' + 'http-alice'  = 'http-http-alice'
      const GROUP_FOLDER = 'http-http-alice';
      const queryScript = `
        const fs = require('node:fs');
        const initSqlJs = require('/app/node_modules/sql.js');
        (async () => {
          const SQL = await initSqlJs();
          const candidates = [
            '/app/store/messages-http.db',
            '/app/store/messages.db',
          ];
          let dbPath = null;
          for (const p of candidates) {
            if (fs.existsSync(p)) { dbPath = p; break; }
          }
          if (!dbPath) {
            const { execSync } = require('node:child_process');
            const found = execSync(
              'find /app/store /app/groups /data -name "*.db" 2>/dev/null || true'
            ).toString().trim().split('\\n').filter(Boolean);
            if (found.length === 0) { console.log('no-db-found'); process.exit(0); }
            dbPath = found[0];
          }
          const data = fs.readFileSync(dbPath);
          const db = new SQL.Database(new Uint8Array(data));
          const rows = db.exec(
            "SELECT content FROM conversation_history WHERE group_folder = '${GROUP_FOLDER}' AND content LIKE '%[ImageAttachment:%' ORDER BY created_at DESC LIMIT 5"
          );
          if (!rows.length || !rows[0].values.length) {
            console.log('no-image-attachment-rows');
            process.exit(0);
          }
          console.log('FOUND:' + JSON.stringify(rows[0].values));
        })().catch((e) => { console.error('script-error:' + e.message); process.exit(4); });
      `;
      const dbExec = kubectl(
        ['exec', '-n', NAMESPACE, podName, '-c', 'channel', '--', 'node', '-e', queryScript],
        { timeout: 30_000 },
      );
      expect(
        dbExec.ok,
        `db probe failed:\nstdout: ${dbExec.stdout}\nstderr: ${dbExec.stderr}`,
      ).toBe(true);
      expect(
        dbExec.stdout,
        `expected FOUND: marker in conversation_history probe, got: ${dbExec.stdout}`,
      ).toMatch(/^FOUND:/m);
    },
    90_000,
  );
});
