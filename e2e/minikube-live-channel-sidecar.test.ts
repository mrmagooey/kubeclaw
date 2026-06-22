/**
 * Minikube-live regression test: sidecar-bearing channel install + remove.
 *
 * This validates the sidecar RENDERING + LIFECYCLE with a stand-in image; it is
 * NOT a live Signal round-trip (real Signal needs an account + device linking,
 * untestable in CI).
 *
 * Uses an `http`-type channel (instance name `sidecartest`) with a lightweight
 * non-root stand-in sidecar (`nginxinc/nginx-unprivileged:stable-alpine`, uid
 * 101) in place of the real signal-cli image. The rendered sidecar
 * securityContext sets `runAsNonRoot: true`, which would cause a root-based
 * image (plain nginx) to fail the kubelet admission check — the unprivileged
 * variant is required to prove the pod can actually reach Ready.
 *
 * ACs:
 *  AC1 [render+ready]:  the channel pod reaches readyReplicas=1, has 2
 *                       containers (channel + http-backend), and the
 *                       kubeclaw-channel-sidecartest-auxsession PVC is Bound.
 *  AC2 [remove]:        runAdminTool('remove_channel', {instanceName:'sidecartest'})
 *                       reports success and names the auxsession PVC.
 *  AC3 [no orphans]:    every resource — deployment, services, networkpolicies,
 *                       secret, all PVCs incl. auxsession — is gone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const NAMESPACE = 'kubeclaw-live';
const RELEASE = 'kubeclaw-live';
const VALUES = './helm/kubeclaw/values-minikube.yaml';
const INSTANCE = 'sidecartest';
const BASE = `kubeclaw-channel-${INSTANCE}`;
const TYPE = 'http';
const USERS = 'alice:sidecarpass';

// Every resource the install creates for this sidecar-bearing instance.
// The http-backend sidecar egress netpol is named `<base>-sidecar-egress`.
const RESOURCES: Array<[kind: string, name: string]> = [
  ['deployment', BASE],
  ['service', BASE],
  ['service', `${BASE}-metrics`],
  ['networkpolicy', `${BASE}-ingress`],
  ['secret', BASE],
  ['pvc', `${BASE}-groups`],
  ['pvc', `${BASE}-store`],
  ['pvc', `${BASE}-sessions`],
  ['pvc', `${BASE}-auxsession`],
];

// The sidecar-egress netpol is only rendered when egressPorts is set; track it
// separately so AC3 can verify it too, but don't expect it in the remove output
// (remove_channel targets it by the naming convention — it will be in
// alreadyAbsent or deleted depending on whether the netpol was ever created).
const SIDECAR_EGRESS_NETPOL = `${BASE}-sidecar-egress`;

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
  spawnSync('kubectl', ['get', 'ns', NAMESPACE], { stdio: 'pipe' }).status === 0;

beforeAll(() => {
  if (!clusterReachable) return;

  // Pre-clean any leftovers from a previous run.
  for (const [kind, name] of RESOURCES) {
    kc(['delete', kind, name, '-n', NAMESPACE, '--ignore-not-found', '--wait=false']);
  }
  kc([
    'delete',
    'networkpolicy',
    SIDECAR_EGRESS_NETPOL,
    '-n',
    NAMESPACE,
    '--ignore-not-found',
    '--wait=false',
  ]);

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

  // Render the sidecar-bearing declarative channel and apply it. The sidecar
  // fields override the http manifest's (normally empty) sidecar stanza via
  // --set. This exercises channel-pods.yaml (2-container deployment + auxsession
  // volume) and storage.yaml (auxsession PVC).
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
      `channels.${INSTANCE}.envVars[0].name=HTTP_CHANNEL_USERS`,
      '--set',
      `channels.${INSTANCE}.envVars[0].key=users`,
      // Sidecar: lightweight non-root stand-in (uid 101, serves / on :8080).
      // runAsNonRoot: true in the rendered securityContext makes the unprivileged
      // variant mandatory — plain nginx (root) would be rejected by the kubelet.
      '--set',
      `bootstrap.channelManifests.http.sidecar.image=nginxinc/nginx-unprivileged:stable-alpine`,
      '--set',
      `bootstrap.channelManifests.http.sidecar.port=8080`,
      '--set',
      `bootstrap.channelManifests.http.sidecar.sessionMountPath=/tmp/session`,
      '--set',
      `bootstrap.channelManifests.http.sidecar.sessionStorageGi=1`,
      '--set',
      `bootstrap.channelManifests.http.sidecar.healthPath=/`,
      '--set',
      `bootstrap.channelManifests.http.sidecar.egressPorts={443}`,
      '--set',
      `bootstrap.channelManifests.http.sidecar.apiUrlEnv=TEST_BACKEND_URL`,
      '--show-only',
      'templates/storage.yaml',
      '--show-only',
      'templates/channel-pods.yaml',
      '--show-only',
      'templates/networkpolicies.yaml',
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
  // Best-effort cleanup (AC2/AC3 should have done it; this catches a failed run).
  for (const [kind, name] of RESOURCES) {
    kc(['delete', kind, name, '-n', NAMESPACE, '--ignore-not-found', '--wait=false']);
  }
  kc([
    'delete',
    'networkpolicy',
    SIDECAR_EGRESS_NETPOL,
    '-n',
    NAMESPACE,
    '--ignore-not-found',
    '--wait=false',
  ]);
});

describe.skipIf(!clusterReachable)(
  'minikube-live: sidecar-bearing channel install + remove_channel regression',
  () => {
    it(
      'AC1 [render+ready]: channel pod has 2 containers and auxsession PVC is Bound',
      async () => {
        // Wait for the deployment to reach readyReplicas=1. Both containers must
        // be ready: the stage-runtime init container must have staged the adapter,
        // and the nginx-unprivileged sidecar must have passed its readiness probe
        // (GET / on :8080 → 200).
        const ready = await (async () => {
          const deadline = Date.now() + 300_000; // 5 min — image pull may be slow
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
            await sleep(5000);
          }
          return false;
        })();

        if (!ready) {
          // Dump diagnostics to surface staging / sidecar failures.
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
            `[AC1 not Ready] pod=${pod}\n` +
              '[stage-runtime logs]\n' +
              kc(['logs', `pod/${pod}`, '-c', 'stage-runtime', '-n', NAMESPACE]).stdout +
              '\n[channel logs]\n' +
              kc(['logs', `pod/${pod}`, '-c', 'channel', '-n', NAMESPACE, '--tail=40'])
                .stdout +
              '\n[http-backend (sidecar) logs]\n' +
              kc([
                'logs',
                `pod/${pod}`,
                '-c',
                'http-backend',
                '-n',
                NAMESPACE,
                '--tail=40',
              ]).stdout,
          );
        }
        expect(ready, `${BASE} did not reach readyReplicas=1`).toBe(true);

        // Verify the deployment spec has exactly 2 containers: `channel` and
        // `http-backend` (the sidecar container name is `<type>-backend`).
        const containerNames = kc([
          'get',
          'deployment',
          BASE,
          '-n',
          NAMESPACE,
          '-o',
          "jsonpath={.spec.template.spec.containers[*].name}",
        ]).stdout.trim();
        expect(containerNames, 'expected container named "channel"').toContain('channel');
        expect(containerNames, 'expected container named "http-backend"').toContain(
          'http-backend',
        );

        // Verify the auxsession PVC exists and is Bound.
        const auxPvcName = `${BASE}-auxsession`;
        const pvcPhase = kc([
          'get',
          'pvc',
          auxPvcName,
          '-n',
          NAMESPACE,
          '-o',
          'jsonpath={.status.phase}',
        ]).stdout.trim();
        expect(
          pvcPhase,
          `${auxPvcName} PVC not found or not Bound (got: "${pvcPhase}")`,
        ).toBe('Bound');
      },
      360_000,
    );

    it(
      'AC2 [remove_channel]: reports success and names the auxsession PVC',
      () => {
        const result = runAdminTool(
          'remove_channel',
          { instanceName: INSTANCE },
          { timeout: 90_000 },
        );
        expect(
          result.ok,
          `remove_channel failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        ).toBe(true);
        const out = result.stdout;
        expect(out).toContain('Deleted:');
        // The auxsession PVC must appear in the removal summary.
        expect(out, 'expected auxsession PVC name in remove output').toContain(
          `${BASE}-auxsession`,
        );
        // Every other tracked resource must appear too.
        for (const [, name] of RESOURCES.filter(([, n]) => !n.includes('auxsession'))) {
          expect(out, `expected ${name} in remove output`).toContain(name);
        }
      },
      120_000,
    );

    it(
      'AC3 [no orphans]: every resource — including auxsession PVC and sidecar-egress netpol — is gone',
      async () => {
        const allResources: Array<[string, string]> = [
          ...RESOURCES,
          ['networkpolicy', SIDECAR_EGRESS_NETPOL],
        ];
        const deadline = Date.now() + 90_000;
        let leftover: string[] = [];
        while (Date.now() < deadline) {
          leftover = allResources
            .filter(([kind, name]) => {
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
            })
            .map(([kind, name]) => `${kind}/${name}`);
          if (leftover.length === 0) break;
          await sleep(3000);
        }
        expect(
          leftover,
          `orphaned resources after remove_channel: ${leftover.join(', ')}`,
        ).toEqual([]);
      },
      100_000,
    );
  },
);
