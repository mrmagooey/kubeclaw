import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  KUBECLAW_NAMESPACE: 'kubeclaw',
}));

import { buildMcpYaml } from './mcp.js';
import type { McpCapabilitySpec } from '../types.js';

const base: McpCapabilitySpec = {
  kind: 'mcp',
  name: 'weather',
  image: 'mcp/weather:1.0',
};

describe('buildMcpYaml', () => {
  it('produces a Deployment + Service in the kubeclaw namespace', () => {
    const yaml = buildMcpYaml(base);
    expect(yaml).toContain('kind: Deployment');
    expect(yaml).toContain('kind: Service');
    expect(yaml).toContain('namespace: kubeclaw');
    expect(yaml).toContain('name: kubeclaw-cap-weather');
  });

  it('uses port 3000 by default', () => {
    expect(buildMcpYaml(base)).toContain('containerPort: 3000');
  });

  it('honors a custom port', () => {
    expect(buildMcpYaml({ ...base, port: 8080 })).toContain(
      'containerPort: 8080',
    );
  });

  it('renders env vars when provided', () => {
    const yaml = buildMcpYaml({ ...base, env: { LOG_LEVEL: 'debug' } });
    expect(yaml).toContain('name: LOG_LEVEL');
    expect(yaml).toContain('value: "debug"');
  });

  it('renders envFrom for each secret', () => {
    const yaml = buildMcpYaml({
      ...base,
      envFromSecrets: ['kubeclaw-secrets', 'mcp-extra'],
    });
    expect(yaml).toMatch(/envFrom:\s+- secretRef:\s+name: kubeclaw-secrets/);
    expect(yaml).toContain('name: mcp-extra');
  });

  it('uses the kubeclaw-cap-<name> deployment naming', () => {
    expect(buildMcpYaml(base)).toContain('name: kubeclaw-cap-weather');
  });
});
