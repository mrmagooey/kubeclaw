// src/k8s/write-bootstrap-pvc-files.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  writeBootstrapPvcFiles,
  assertSafeRelPath,
} from './write-bootstrap-pvc-files.js';
import { Writable } from 'node:stream';

function fakeExec(captures: Array<{ cmd: string[]; stdin: string }>) {
  return {
    exec: vi.fn(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        cmd: string[],
        _stdout: Writable,
        _stderr: Writable,
        stdin: NodeJS.ReadableStream | null,
        _tty: boolean,
        statusCb: (s: { status: string }) => void,
      ) => {
        let stdinData = '';
        if (stdin) {
          for await (const chunk of stdin as AsyncIterable<Buffer | string>) {
            stdinData += chunk.toString();
          }
        }
        captures.push({ cmd, stdin: stdinData });
        statusCb({ status: 'Success' });
        const ws: any = { on: (ev: string, cb: () => void) => { if (ev === 'close') setImmediate(cb); return ws; } };
        return ws;
      },
    ),
  };
}

function fakeCore(podName: string | undefined) {
  return {
    listNamespacedPod: vi.fn(async () => ({
      items: podName ? [{ metadata: { name: podName } }] : [],
    })),
  };
}

describe('assertSafeRelPath', () => {
  it('accepts normal relative paths', () => {
    expect(() => assertSafeRelPath('channel-entry.js')).not.toThrow();
    expect(() => assertSafeRelPath('lib/util.js')).not.toThrow();
  });
  it('rejects traversal and absolute paths', () => {
    expect(() => assertSafeRelPath('../escape.js')).toThrow();
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow();
    expect(() => assertSafeRelPath('a/../../b')).toThrow();
  });
});

describe('writeBootstrapPvcFiles', () => {
  it('streams each file to /runtime via exec stdin', async () => {
    const captures: Array<{ cmd: string[]; stdin: string }> = [];
    const deps = { coreApi: fakeCore('bootstrap-pod-xyz') as any, exec: fakeExec(captures) as any, namespace: 'kubeclaw' };
    await writeBootstrapPvcFiles(deps, 'signal', [
      { path: 'channel-entry.js', content: 'export const x = 1;\n' },
      { path: 'lib/util.js', content: 'export const y = 2;\n' },
    ]);
    expect(captures).toHaveLength(2);
    expect(captures[0].cmd.join(' ')).toContain('/runtime/channel-entry.js');
    expect(captures[0].stdin).toBe('export const x = 1;\n');
    expect(captures[1].cmd.join(' ')).toContain('/runtime/lib/util.js');
    expect(captures[1].stdin).toBe('export const y = 2;\n');
  });

  it('throws when no running bootstrap pod exists', async () => {
    const deps = { coreApi: fakeCore(undefined) as any, exec: fakeExec([]) as any, namespace: 'kubeclaw' };
    await expect(writeBootstrapPvcFiles(deps, 'signal', [])).rejects.toThrow(/No running bootstrap pod/);
  });
});
