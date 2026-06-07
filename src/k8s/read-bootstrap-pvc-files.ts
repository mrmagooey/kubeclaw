import { Writable } from 'node:stream';
import type { CoreV1Api, Exec, V1Status } from '@kubernetes/client-node';

/**
 * Story 176 TOCTOU defense: the orchestrator independently reads package.json
 * and package-lock.json from a bootstrap pod's runtime PVC (via the inspector
 * sidecar) rather than trusting the values the bootstrap agent reports. This
 * uses the Kubernetes API directly (list pod + exec) instead of shelling out to
 * a `kubectl` binary, which the orchestrator image does not ship.
 */
export interface ReadBootstrapPvcFilesDeps {
  coreApi: Pick<CoreV1Api, 'listNamespacedPod'>;
  exec: Pick<Exec, 'exec'>;
  namespace: string;
}

const INSPECTOR_CONTAINER = 'inspector';
const INSPECT_DIR = '/runtime-inspect';

export async function readBootstrapPvcFiles(
  deps: ReadBootstrapPvcFilesDeps,
  instanceName: string,
): Promise<{ packageJson: string; packageLockJson: string }> {
  const podList = await deps.coreApi.listNamespacedPod({
    namespace: deps.namespace,
    labelSelector: `kubeclaw-channel=${instanceName},kubeclaw.io/role=bootstrap`,
    fieldSelector: 'status.phase=Running',
  });
  const podName = podList.items[0]?.metadata?.name;
  if (!podName) {
    throw new Error(
      `No running bootstrap pod found for instance ${instanceName}`,
    );
  }

  const execCat = (file: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let status: V1Status | undefined;
      const outStream = new Writable({
        write(chunk, _enc, cb) {
          stdout += chunk.toString();
          cb();
        },
      });
      const errStream = new Writable({
        write(chunk, _enc, cb) {
          stderr += chunk.toString();
          cb();
        },
      });
      deps.exec
        .exec(
          deps.namespace,
          podName,
          INSPECTOR_CONTAINER,
          ['cat', `${INSPECT_DIR}/${file}`],
          outStream,
          errStream,
          null,
          false,
          (s) => {
            status = s;
          },
        )
        .then((ws) => {
          // The status message (channel 3) arrives before the socket closes, so
          // by the time 'close' fires `status` reflects the command's outcome.
          ws.on('close', () => {
            if (status?.status === 'Failure') {
              reject(
                new Error(
                  `exec cat ${file} in bootstrap pod ${podName} failed: ${
                    status.message ?? stderr.trim() ?? 'unknown error'
                  }`,
                ),
              );
            } else {
              resolve(stdout);
            }
          });
          ws.on('error', reject);
        })
        .catch(reject);
    });

  const packageJson = await execCat('package.json');
  const packageLockJson = await execCat('package-lock.json');
  return { packageJson, packageLockJson };
}
