import { describe, it, expect, vi, beforeEach } from 'vitest';

// Intercept spawnSync (helm + kubectl calls).
const mockSpawnSync = vi.fn();
vi.mock('child_process', () => ({ spawnSync: mockSpawnSync }));

// Silence logger output.
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub waitForDeployment so tests don't sleep.
const mockWaitForDeployment = vi.fn();
vi.mock('./k8s-utils.js', () => ({
  waitForDeployment: mockWaitForDeployment,
}));

function spawnResult(stdout: string = '', status = 0) {
  return { status, stdout, stderr: '', error: undefined };
}

describe('isCertManagerInstalled', () => {
  let isCertManagerInstalled: typeof import('./cert-manager.js').isCertManagerInstalled;

  beforeEach(async () => {
    mockSpawnSync.mockReset();
    const mod = await import('./cert-manager.js');
    isCertManagerInstalled = mod.isCertManagerInstalled;
  });

  it('returns true when helm status succeeds', () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult('STATUS: deployed', 0));
    expect(isCertManagerInstalled()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'helm',
      ['status', 'cert-manager', '--namespace', 'cert-manager'],
      { stdio: 'pipe' },
    );
  });

  it('returns false when helm status fails (no release)', () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult('Error: not found', 1));
    expect(isCertManagerInstalled()).toBe(false);
  });
});

describe('installCertManager', () => {
  let installCertManager: typeof import('./cert-manager.js').installCertManager;

  beforeEach(async () => {
    mockSpawnSync.mockReset();
    mockWaitForDeployment.mockReset();
    const mod = await import('./cert-manager.js');
    installCertManager = mod.installCertManager;
  });

  it('returns "skipped" when opts.skip is true and makes no helm/kubectl calls', async () => {
    const result = await installCertManager({ skip: true });
    expect(result).toBe('skipped');
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockWaitForDeployment).not.toHaveBeenCalled();
  });

  it('returns "present" when cert-manager release already exists', async () => {
    mockSpawnSync.mockReturnValueOnce(spawnResult('STATUS: deployed', 0)); // helm status
    const result = await installCertManager();
    expect(result).toBe('present');
    // Only the status check should have been called.
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockWaitForDeployment).not.toHaveBeenCalled();
  });

  it('installs cert-manager when absent and waits for webhook readiness', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))      // helm status -> not found
      .mockReturnValueOnce(spawnResult('', 0))      // helm repo add
      .mockReturnValueOnce(spawnResult('', 0))      // helm repo update
      .mockReturnValueOnce(spawnResult('', 0));     // helm upgrade --install
    mockWaitForDeployment.mockResolvedValueOnce(true);

    const result = await installCertManager();
    expect(result).toBe('installed');

    // Verify the install command included the pinned version + crds.enabled.
    const installCall = mockSpawnSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === 'upgrade',
    );
    expect(installCall).toBeDefined();
    expect(installCall![1]).toContain('--version');
    const versionIdx = installCall![1].indexOf('--version');
    expect(installCall![1][versionIdx + 1]).toMatch(/^v1\.16\./);
    expect(installCall![1]).toContain('--set');
    expect(installCall![1]).toContain('crds.enabled=true');
    expect(installCall![1]).toContain('--wait');

    expect(mockWaitForDeployment).toHaveBeenCalledWith(
      'cert-manager', 'cert-manager-webhook', 60_000,
    );
  });

  it('throws cert_manager_install_failed when helm install returns non-zero', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))      // helm status
      .mockReturnValueOnce(spawnResult('', 0))      // repo add
      .mockReturnValueOnce(spawnResult('', 0))      // repo update
      .mockReturnValueOnce(spawnResult('', 1));     // helm install fails

    await expect(installCertManager()).rejects.toThrow('cert_manager_install_failed');
    expect(mockWaitForDeployment).not.toHaveBeenCalled();
  });

  it('throws cert_manager_webhook_not_ready when webhook never becomes Ready', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))
      .mockReturnValueOnce(spawnResult('', 0))
      .mockReturnValueOnce(spawnResult('', 0))
      .mockReturnValueOnce(spawnResult('', 0));
    mockWaitForDeployment.mockResolvedValueOnce(false);

    await expect(installCertManager()).rejects.toThrow('cert_manager_webhook_not_ready');
  });

  it('throws cert_manager_repo_add_failed when helm repo add fails', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))   // helm status -> not installed
      .mockReturnValueOnce(spawnResult('', 1));  // helm repo add fails

    await expect(installCertManager()).rejects.toThrow('cert_manager_repo_add_failed');
  });

  it('throws cert_manager_repo_update_failed when repo update fails', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))   // helm status -> not installed
      .mockReturnValueOnce(spawnResult('', 0))   // helm repo add ok
      .mockReturnValueOnce(spawnResult('', 1));  // helm repo update fails

    await expect(installCertManager()).rejects.toThrow('cert_manager_repo_update_failed');
    expect(mockWaitForDeployment).not.toHaveBeenCalled();
  });

  it('passes opts.timeout through to helm upgrade --install', async () => {
    mockSpawnSync
      .mockReturnValueOnce(spawnResult('', 1))   // status
      .mockReturnValueOnce(spawnResult('', 0))   // repo add
      .mockReturnValueOnce(spawnResult('', 0))   // repo update
      .mockReturnValueOnce(spawnResult('', 0));  // install
    mockWaitForDeployment.mockResolvedValueOnce(true);

    await installCertManager({ timeout: '5m' });

    const installCall = mockSpawnSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === 'upgrade',
    );
    const timeoutIdx = installCall![1].indexOf('--timeout');
    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(installCall![1][timeoutIdx + 1]).toBe('5m');
  });
});
