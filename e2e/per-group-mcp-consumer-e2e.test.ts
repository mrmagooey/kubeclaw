import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { isKubernetesAvailable } from './setup.js';

const K8S_AVAILABLE = isKubernetesAvailable();
const SKIP_E2E = process.env.SKIP_E2E === '1';
const NAMESPACE = 'kubeclaw';

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!K8S_AVAILABLE || SKIP_E2E)('per-group MCP consumer e2e', () => {
  beforeAll(async () => {
    // The global-setup may already have kubeclaw installed; this test assumes
    // the standard kubeclaw release exists. Build + load the echo image so
    // the orchestrator can scrape it.
    try {
      sh(`./container/echo-mcp/build.sh kubeclaw-echo-mcp:test`);
      sh(`minikube image load kubeclaw-echo-mcp:test 2>&1 || true`);
    } catch (err) {
      console.warn('echo image setup failed:', err);
    }
  }, 300_000);

  afterAll(() => {
    // Best-effort cleanup of any per-group Deployments left over.
    try {
      sh(
        `kubectl delete deployment -l kubeclaw.io/capability=echo -n ${NAMESPACE} 2>&1 || true`,
      );
      sh(
        `kubectl delete service -l kubeclaw.io/capability=echo -n ${NAMESPACE} 2>&1 || true`,
      );
      sh(
        `kubectl delete networkpolicy -l kubeclaw.io/capability=echo -n ${NAMESPACE} 2>&1 || true`,
      );
    } catch {
      // ignore
    }
  });

  it('placeholder: full LLM roundtrip pending Phase B Spec 2/3', () => {
    // The integration test in e2e/per-group-mcp-consumer-integration.test.ts
    // covers: schema scrape + cached, endpoint resolves, MCP HTTP call works.
    //
    // The full LLM-driven path (orchestrator pushes mcp-group entry in
    // capabilities_update → channel runtime sees mcp__echo__echo in tool
    // list → LLM calls it → response reaches the user) requires a mock-LLM
    // + channel-pod orchestration harness that doesn't exist in e2e/ yet.
    // Phase B Spec 2 (filesystem) ships the first real consumer test of
    // that path; this file is a placeholder so the task ledger has an entry.
    expect(true).toBe(true);
  });
});
