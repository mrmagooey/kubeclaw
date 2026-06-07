import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { V1Status } from '@kubernetes/client-node';
import { readBootstrapPvcFiles } from './read-bootstrap-pvc-files.js';

const NS = 'kubeclaw';
const INSTANCE = 'e2e-http-echo';

function podList(names: string[]) {
  return { items: names.map((name) => ({ metadata: { name } })) };
}

/**
 * Build a fake Exec whose `exec` writes canned stdout for each file, reports a
 * status via the callback, then emits 'close' on the returned websocket — the
 * same ordering the real client-node Exec uses (status before close).
 */
function fakeExec(
  files: Record<string, { stdout?: string; stderr?: string; status?: V1Status }>,
) {
  const calls: Array<{ container: string; command: string[] }> = [];
  const exec = vi.fn(
    async (
      _ns: string,
      _pod: string,
      container: string,
      command: string | string[],
      stdout: Writable | null,
      stderr: Writable | null,
      _stdin: unknown,
      _tty: boolean,
      statusCallback?: (s: V1Status) => void,
    ) => {
      const cmd = Array.isArray(command) ? command : [command];
      calls.push({ container, command: cmd });
      const file = cmd[cmd.length - 1].split('/').pop()!;
      const spec = files[file] ?? { stdout: '' };
      const ws = new EventEmitter();
      // Emulate async streaming then status then close. Use a macrotask so the
      // 'close' event fires after the caller's .then() attaches its listener,
      // matching the real websocket (which closes on a later tick).
      setTimeout(() => {
        if (spec.stdout && stdout) stdout.write(spec.stdout);
        if (spec.stderr && stderr) stderr.write(spec.stderr);
        if (statusCallback)
          statusCallback(spec.status ?? ({ status: 'Success' } as V1Status));
        ws.emit('close');
      }, 0);
      return ws as unknown as never;
    },
  );
  return { exec, calls };
}

describe('readBootstrapPvcFiles', () => {
  it('reads package.json and package-lock.json from the inspector sidecar', async () => {
    const coreApi = { listNamespacedPod: vi.fn().mockResolvedValue(podList(['bootstrap-pod-1'])) };
    const { exec, calls } = fakeExec({
      'package.json': { stdout: '{"name":"runtime"}' },
      'package-lock.json': { stdout: '{"lockfileVersion":3}' },
    });

    const result = await readBootstrapPvcFiles(
      { coreApi: coreApi as never, exec: { exec } as never, namespace: NS },
      INSTANCE,
    );

    expect(result.packageJson).toBe('{"name":"runtime"}');
    expect(result.packageLockJson).toBe('{"lockfileVersion":3}');

    // Pod lookup used the bootstrap label + Running field selector.
    expect(coreApi.listNamespacedPod).toHaveBeenCalledWith({
      namespace: NS,
      labelSelector: `kubeclaw-channel=${INSTANCE},kubeclaw.io/role=bootstrap`,
      fieldSelector: 'status.phase=Running',
    });
    // Both files were cat'd from the inspector container under /runtime-inspect.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      container: 'inspector',
      command: ['cat', '/runtime-inspect/package.json'],
    });
    expect(calls[1]).toEqual({
      container: 'inspector',
      command: ['cat', '/runtime-inspect/package-lock.json'],
    });
  });

  it('throws when no running bootstrap pod exists', async () => {
    const coreApi = { listNamespacedPod: vi.fn().mockResolvedValue(podList([])) };
    const { exec } = fakeExec({});
    await expect(
      readBootstrapPvcFiles(
        { coreApi: coreApi as never, exec: { exec } as never, namespace: NS },
        INSTANCE,
      ),
    ).rejects.toThrow(/No running bootstrap pod/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects when the exec reports a Failure status', async () => {
    const coreApi = { listNamespacedPod: vi.fn().mockResolvedValue(podList(['bootstrap-pod-1'])) };
    const { exec } = fakeExec({
      'package.json': {
        stderr: 'cat: /runtime-inspect/package.json: No such file or directory',
        status: { status: 'Failure', message: 'command terminated with non-zero exit code' } as V1Status,
      },
    });
    await expect(
      readBootstrapPvcFiles(
        { coreApi: coreApi as never, exec: { exec } as never, namespace: NS },
        INSTANCE,
      ),
    ).rejects.toThrow(/exec cat package.json .* failed/);
  });
});
