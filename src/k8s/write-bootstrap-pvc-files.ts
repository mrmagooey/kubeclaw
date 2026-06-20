import { Readable, Writable } from 'node:stream';
import type { CoreV1Api, Exec, V1Status } from '@kubernetes/client-node';

/**
 * Push channel source files onto a bootstrap pod's /runtime PVC via the
 * Kubernetes Exec API (stdin → `cat > /runtime/<path>`). The deterministic
 * counterpart of read-bootstrap-pvc-files.ts: the orchestrator owns the bytes,
 * so no hash/TOCTOU is needed on this path.
 */
export interface ChannelSourceFile {
  /** Path relative to /runtime, e.g. "channel-entry.js" or "lib/util.js". */
  path: string;
  content: string;
}

export interface WriteBootstrapPvcFilesDeps {
  coreApi: Pick<CoreV1Api, 'listNamespacedPod'>;
  exec: Pick<Exec, 'exec'>;
  namespace: string;
}

// The bootstrap Job's main container mounts /runtime read-write. The inspector
// sidecar mounts it read-only and MUST NOT be targeted for writes.
const BOOTSTRAP_CONTAINER = 'bootstrap';
const RUNTIME_DIR = '/runtime';
const SAFE_REL_PATH = /^(?!.*(^|\/)\.\.(\/|$))[-._a-zA-Z0-9]+(\/[-._a-zA-Z0-9]+)*$/;

export function assertSafeRelPath(p: string): void {
  if (p.startsWith('/') || !SAFE_REL_PATH.test(p)) {
    throw new Error(`Unsafe channel source path: ${JSON.stringify(p)}`);
  }
}

export async function writeBootstrapPvcFiles(
  deps: WriteBootstrapPvcFilesDeps,
  instanceName: string,
  files: ChannelSourceFile[],
): Promise<void> {
  const podList = await deps.coreApi.listNamespacedPod({
    namespace: deps.namespace,
    labelSelector: `kubeclaw-channel=${instanceName},kubeclaw.io/role=bootstrap`,
    fieldSelector: 'status.phase=Running',
  });
  const podName = podList.items[0]?.metadata?.name;
  if (!podName) {
    throw new Error(`No running bootstrap pod found for instance ${instanceName}`);
  }

  for (const file of files) {
    assertSafeRelPath(file.path);
    await execWrite(deps, podName, file);
  }
}

function execWrite(
  deps: WriteBootstrapPvcFilesDeps,
  podName: string,
  file: ChannelSourceFile,
): Promise<void> {
  const full = `${RUNTIME_DIR}/${file.path}`;
  // mkdir -p the parent, then write stdin to the file. `full` is validated to a
  // safe charset above, so it is shell-safe to interpolate.
  const command = ['sh', '-c', `mkdir -p "$(dirname '${full}')" && cat > '${full}'`];

  return new Promise<void>((resolve, reject) => {
    let stderr = '';
    let status: V1Status | undefined;
    const outStream = new Writable({ write(_c, _e, cb) { cb(); } });
    const errStream = new Writable({ write(c, _e, cb) { stderr += c.toString(); cb(); } });
    const inStream = Readable.from([file.content]);

    deps.exec
      .exec(
        deps.namespace,
        podName,
        BOOTSTRAP_CONTAINER,
        command,
        outStream,
        errStream,
        inStream,
        false,
        (s) => { status = s; },
      )
      .then((ws) => {
        ws.on('close', () => {
          if (status?.status === 'Failure') {
            reject(new Error(`exec write ${full} in ${podName} failed: ${status.message ?? stderr.trim() ?? 'unknown'}`));
          } else {
            resolve();
          }
        });
        ws.on('error', reject);
      })
      .catch(reject);
  });
}
