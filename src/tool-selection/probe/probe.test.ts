import { probeTool, type ProbeJobRunner } from './probe.js';
import type { ToolSpec } from '../../tools/types.js';

const spec: ToolSpec = {
  name: 'extract_metadata',
  description: 'd',
  parameters: {
    type: 'object',
    properties: { filename: { type: 'string' } },
    required: ['filename'],
  },
  image: 'r@sha256:abc',
  pattern: 'file',
  mount: 'scratch',
  allowedEgress: [],
};

describe('probeTool', () => {
  it('verifies a tool whose probe returns a well-formed result', async () => {
    const runner: ProbeJobRunner = {
      runProbeToolJob: async () => ({
        ok: true,
        output: 'ExifTool Version Number: 12.0',
      }),
    };
    const r = await probeTool(spec, runner);
    expect(r.verified).toBe(true);
  });

  it('fails a tool whose probe attempts off-allowlist egress', async () => {
    const runner: ProbeJobRunner = {
      runProbeToolJob: async () => ({ ok: false, egressViolation: true }),
    };
    const r = await probeTool(spec, runner);
    expect(r.verified).toBe(false);
    expect(r.reason).toContain('egress');
  });

  it('fails a tool whose probe errors or returns nothing', async () => {
    const runner: ProbeJobRunner = {
      runProbeToolJob: async () => ({ ok: false, error: 'crash' }),
    };
    expect((await probeTool(spec, runner)).verified).toBe(false);
  });

  it('fails a tool whose probe returns empty output', async () => {
    const runner: ProbeJobRunner = {
      runProbeToolJob: async () => ({ ok: true, output: '' }),
    };
    const r = await probeTool(spec, runner);
    expect(r.verified).toBe(false);
    expect(r.reason).toContain('empty');
  });
});
