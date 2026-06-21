/**
 * Minikube-live regression test for the channel-install unification work:
 *
 *   1. The DECLARATIVE Helm install path (`channels.<n>.enabled`) must stage the
 *      runtime adapter via the `stage-runtime` init container so the channel pod
 *      actually works (regression for the channel-pods.yaml fix — a broken
 *      staging would CrashLoop the pod / 404 the factory).
 *   2. `remove_channel` must delete EVERY resource the channel owns — Deployment,
 *      both Services, NetworkPolicy, Ingress, Secret, and all PVCs — by name
 *      (regression for the channel-remove.ts rewrite — wrong names orphan
 *      resources).
 *
 * Runs against the live minikube release stood up by minikube-live-setup.ts
 * (namespace kubeclaw-live). Uses a dedicated instance name (`decl`) so it does
 * not collide with the bootstrapped channels the setup installs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';

const NAMESPACE = 'kubeclaw-live';
const RELEASE = 'kubeclaw-live';
const VALUES = './helm/kubeclaw/values-minikube.yaml';
const INSTANCE = 'decl';
const BASE = `kubeclaw-channel-${INSTANCE}`;
const TYPE = 'http';
const USERS = 'alice:livepass';
const LOCAL_PORT = 19087;

// Every resource the declarative install creates (httpPort + ingress + netpol).
const RESOURCES: Array<[kind: string, name: string]> = [
  ['deployment', BASE],
  ['service', BASE],
  ['service', `${BASE}-metrics`],
  ['networkpolicy', `${BASE}-ingress`],
  ['ingress', BASE],
  ['secret', BASE],
  ['pvc', `${BASE}-groups`],
  ['pvc', `${BASE}-store`],
  ['pvc', `${BASE}-sessions`],
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function kc(args: string[], opts: { timeout?: number } = {}) {
  const r = spawnSync('kubectl', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30_000,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Call executeTool inside the orchestrator pod (no LLM needed). */
function runAdminTool(
  toolName: string,
  input: Record<string, unknown>,
  opts: { timeout?: number } = {},
) {
  const script = `import('/app/dist/admin-shell.js').then(async m => {
  const result = await m.executeTool(${JSON.stringify(toolName)}, ${JSON.stringify(input)});
  process.stdout.write(result + '\\n');
}).catch(e => { process.stderr.write(String(e) + '\\n'); process.exit(1); });`;
  const r = spawnSync(
    'kubectl',
    [
      '-n',
      NAMESPACE,
      'exec',
      'deployment/kubeclaw-orchestrator',
      '-c',
      'orchestrator',
      '--',
      'node',
      '--input-type=module',
      '-e',
      script,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout ?? 60_000 },
  );
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const clusterReachable =
  spawnSync('kubectl', ['get', 'ns', NAMESPACE], { stdio: 'pipe' }).status ===
  0;

beforeAll(() => {
  if (!clusterReachable) return;
  // Pre-clean any leftovers from a previous run.
  for (const [kind, name] of RESOURCES) {
    kc(['delete', kind, name, '-n', NAMESPACE, '--ignore-not-found', '--wait=false']);
  }

  // The channel reads HTTP_CHANNEL_USERS from this Secret (envVars mapping).
  kc([
    'create',
    'secret',
    'generic',
    BASE,
    '-n',
    NAMESPACE,
    `--from-literal=users=${USERS}`,
  ]);

  // Render the declarative channel (full resource set) and apply it. This
  // exercises the real channel-pods.yaml template, including the stage-runtime
  // init container that delivers /runtime/channel-entry.js.
  const render = spawnSync(
    'helm',
    [
      'template',
      RELEASE,
      './helm/kubeclaw',
      '-f',
      VALUES,
      '--set',
      `namespace=${NAMESPACE}`,
      '--set',
      'networkPolicy.enabled=true',
      '--set',
      `channels.${INSTANCE}.enabled=true`,
      '--set',
      `channels.${INSTANCE}.type=${TYPE}`,
      '--set',
      `channels.${INSTANCE}.httpPort=4080`,
      '--set',
      `channels.${INSTANCE}.ingress.enabled=true`,
      '--set',
      `channels.${INSTANCE}.envVars[0].name=HTTP_CHANNEL_USERS`,
      '--set',
      `channels.${INSTANCE}.envVars[0].key=users`,
      '--show-only',
      'templates/storage.yaml',
      '--show-only',
      'templates/channel-pods.yaml',
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 },
  );
  if (render.status !== 0) {
    throw new Error(`helm template failed:\n${render.stderr}`);
  }
  const apply = spawnSync('kubectl', ['apply', '-f', '-'], {
    input: render.stdout,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60_000,
  });
  if (apply.status !== 0) {
    throw new Error(
      `kubectl apply failed:\nstdout: ${apply.stdout}\nstderr: ${apply.stderr}`,
    );
  }
}, 120_000);

afterAll(() => {
  if (!clusterReachable) return;
  // Best-effort cleanup (the remove test should have done it; this catches a
  // failed run before AC2).
  for (const [kind, name] of RESOURCES) {
    kc(['delete', kind, name, '-n', NAMESPACE, '--ignore-not-found', '--wait=false']);
  }
});

describe.skipIf(!clusterReachable)(
  'minikube-live: declarative channel install + remove_channel regression',
  () => {
    it('AC1 [stage-runtime]: declarative install stages the adapter; the channel pod is Ready and serves', async () => {
      // The stage-runtime init container runs `npm ci` + copies the adapter; if
      // it regressed, the pod never reaches Ready.
      const ready = await (async () => {
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          const r = kc([
            'get',
            'deployment',
            BASE,
            '-n',
            NAMESPACE,
            '-o',
            'jsonpath={.status.readyReplicas}',
          ]);
          if (r.ok && r.stdout.trim() === '1') return true;
          await sleep(3000);
        }
        return false;
      })();
      if (!ready) {
        // Dump diagnostics to make a staging regression obvious.
        const pod = kc([
          'get',
          'pods',
          '-n',
          NAMESPACE,
          '-l',
          `app=${BASE}`,
          '-o',
          'jsonpath={.items[0].metadata.name}',
        ]).stdout.trim();
        console.error(
          '[AC1 not Ready] stage-runtime logs:\n' +
            kc(['logs', `pod/${pod}`, '-c', 'stage-runtime', '-n', NAMESPACE])
              .stdout +
            '\nchannel logs:\n' +
            kc(['logs', `deployment/${BASE}`, '-n', NAMESPACE, '--tail=40'])
              .stdout,
        );
      }
      expect(ready, `${BASE} did not reach readyReplicas=1`).toBe(true);

      // Serve check via port-forward: /healthz (no auth), /version (no auth),
      // and an authed data-facade endpoint (/jobs).
      const pf = spawn(
        'kubectl',
        ['port-forward', '-n', NAMESPACE, `svc/${BASE}`, `${LOCAL_PORT}:80`],
        { stdio: ['ignore', 'ignore', 'pipe'], detached: false },
      );
      try {
        const url = `http://127.0.0.1:${LOCAL_PORT}`;
        const auth =
          'Basic ' + Buffer.from(USERS).toString('base64');
        let healthOk = false;
        for (let i = 0; i < 20; i++) {
          try {
            const res = await fetch(`${url}/healthz`, {
              signal: AbortSignal.timeout(2000),
            });
            if (res.status === 200) {
              healthOk = true;
              break;
            }
          } catch {
            // retry
          }
          await sleep(1500);
        }
        expect(healthOk, '/healthz did not return 200').toBe(true);

        const version = await fetch(`${url}/version`, {
          signal: AbortSignal.timeout(4000),
        });
        expect(version.status).toBe(200);

        // Authed data-facade endpoint — proves the staged adapter + sdk.jobs work.
        const jobs = await fetch(`${url}/jobs`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(4000),
        });
        expect(jobs.status).toBe(200);

        // And that auth is enforced.
        const noAuth = await fetch(`${url}/jobs`, {
          signal: AbortSignal.timeout(4000),
        });
        expect(noAuth.status).toBe(401);
      } finally {
        pf.kill('SIGTERM');
      }
    }, 240_000);

    it('AC2 [remove_channel]: reports every resource deleted', () => {
      const result = runAdminTool(
        'remove_channel',
        { instanceName: INSTANCE },
        { timeout: 60_000 },
      );
      expect(
        result.ok,
        `remove_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(true);
      const out = result.stdout;
      expect(out).toContain('Deleted:');
      // Each resource name must appear in the tool's summary.
      for (const [, name] of RESOURCES) {
        expect(out, `expected ${name} in remove output`).toContain(name);
      }
    }, 90_000);

    it('AC3 [remove_channel]: every resource is fully gone (no orphans)', async () => {
      const deadline = Date.now() + 90_000;
      let leftover: string[] = [];
      while (Date.now() < deadline) {
        leftover = RESOURCES.filter(([kind, name]) => {
          const r = kc([
            'get',
            kind,
            name,
            '-n',
            NAMESPACE,
            '--ignore-not-found',
            '-o',
            'name',
          ]);
          return !(r.ok && r.stdout.trim() === '');
        }).map(([kind, name]) => `${kind}/${name}`);
        if (leftover.length === 0) break;
        await sleep(3000);
      }
      expect(
        leftover,
        `orphaned resources after remove_channel: ${leftover.join(', ')}`,
      ).toEqual([]);
    }, 100_000);
  },
);
