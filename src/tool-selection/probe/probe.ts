import type { ToolSpec } from '../../tools/types.js';
import { buildSmokeInput } from './smoke-input.js';

export interface ProbeJobRunner {
  runProbeToolJob(args: {
    toolSpec: ToolSpec;
    input: Record<string, string>;
    timeoutMs: number;
  }): Promise<{ ok: boolean; output?: string; egressViolation?: boolean; error?: string }>;
}

export interface ProbeResult {
  verified: boolean;
  reason: string;
}

const PROBE_TIMEOUT_MS = 60_000;

export async function probeTool(spec: ToolSpec, runner: ProbeJobRunner): Promise<ProbeResult> {
  // Probe a credential-FREE copy of the spec: never inject secrets during a smoke test.
  const probeSpec: ToolSpec = { ...spec, credentials: undefined };
  const input = buildSmokeInput(spec.parameters as Record<string, unknown>);
  const res = await runner.runProbeToolJob({ toolSpec: probeSpec, input, timeoutMs: PROBE_TIMEOUT_MS });

  if (res.egressViolation) return { verified: false, reason: 'probe attempted off-allowlist egress' };
  if (!res.ok) return { verified: false, reason: `probe failed: ${res.error ?? 'unknown error'}` };
  if (!res.output || res.output.trim().length === 0) return { verified: false, reason: 'probe returned empty output' };
  return { verified: true, reason: 'probe produced a well-formed result' };
}
