/**
 * Shared Kubernetes CLI helpers for setup modules.
 */
import { spawnSync } from 'child_process';

/**
 * Run a kubectl command and return stdout, or undefined if it fails.
 * Output is truncated to maxLines to avoid flooding logs.
 */
export function runKubectl(
  args: string[],
  maxLines = 50,
): string | undefined {
  try {
    const result = spawnSync('kubectl', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      return undefined;
    }
    const lines = result.stdout.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + '\n... (truncated)';
    }
    return result.stdout;
  } catch {
    return undefined;
  }
}

/**
 * Truncate text to maxChars to avoid flooding status blocks.
 */
export function truncateText(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... (truncated)';
}

/**
 * Poll for a pod label selector to reach Running phase.
 * Returns true if the condition is met within timeoutMs.
 */
export async function waitForPodRunning(
  namespace: string,
  labelSelector: string,
  timeoutMs = 60_000,
  intervalMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'kubectl',
      [
        'get', 'pods',
        '-n', namespace,
        '-l', labelSelector,
        '-o', 'jsonpath={.items[0].status.phase}',
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (result.status === 0 && result.stdout.trim() === 'Running') {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Wait for a DaemonSet to have all desired pods ready.
 * Returns true if ready within timeoutMs.
 */
export async function waitForDaemonSet(
  namespace: string,
  name: string,
  timeoutMs = 120_000,
  intervalMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'kubectl',
      [
        'get', 'daemonset', name,
        '-n', namespace,
        '-o', 'jsonpath={.status.numberReady}/{.status.desiredNumberScheduled}',
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (result.status === 0) {
      const [ready, desired] = result.stdout.trim().split('/').map(Number);
      if (desired > 0 && ready >= desired) return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
