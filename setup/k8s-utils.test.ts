import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSpawnSync = vi.fn();
vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }));

function spawnResult(stdout: string, status = 0) {
  return { status, stdout, stderr: '', error: undefined };
}

describe('waitForDeployment', () => {
  let waitForDeployment: typeof import('./k8s-utils.js').waitForDeployment;

  beforeEach(async () => {
    mockSpawnSync.mockReset();
    const mod = await import('./k8s-utils.js');
    waitForDeployment = mod.waitForDeployment;
  });

  it('returns true immediately when readyReplicas matches replicas', async () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult('1/1'));
    const ok = await waitForDeployment('cert-manager', 'cert-manager-webhook', 5_000, 10);
    expect(ok).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('polls until readiness reached, then returns true', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('0/1'))
      .mockReturnValueOnce(spawnResult('0/1'))
      .mockReturnValueOnce(spawnResult('1/1'));
    const ok = await waitForDeployment('ns', 'dep', 5_000, 10);
    expect(ok).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
  });

  it('returns false when timeout elapses without readiness', async () => {
    mockSpawnSync.mockReturnValue(spawnResult('0/1'));
    const ok = await waitForDeployment('ns', 'dep', 80, 10);
    expect(ok).toBe(false);
  });

  it('treats kubectl non-zero exit as "not ready yet" and retries', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))
      .mockReturnValueOnce(spawnResult('1/1'));
    const ok = await waitForDeployment('ns', 'dep', 5_000, 10);
    expect(ok).toBe(true);
  });

  it('treats replicas=0 as not-ready (deployment scaled to zero shouldn\'t count as ready)', async () => {
    mockSpawnSync.mockReturnValue(spawnResult('0/0'));
    const ok = await waitForDeployment('ns', 'dep', 80, 10);
    expect(ok).toBe(false);
  });
});
