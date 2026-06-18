import { describe, it, expect, vi } from 'vitest';
import { parseAllDocuments } from 'yaml';

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

  describe('YAML round-trip', () => {
    function getDeploymentContainer(yamlStr: string) {
      const docs = parseAllDocuments(yamlStr).map((d) => d.toJSON());
      const deployment = docs.find((d) => d?.kind === 'Deployment');
      expect(deployment).toBeDefined();
      return deployment.spec.template.spec.containers[0];
    }

    it('renders YAML that parses cleanly with no null env field', () => {
      const yamlStr = buildMcpYaml(base); // base has no env
      const container = getDeploymentContainer(yamlStr);
      // The env field must be either absent or an array — never null
      expect(container.env === null).toBe(false);
    });

    it('renders env entries as a list of name/value objects when provided', () => {
      const yamlStr = buildMcpYaml({
        ...base,
        env: { LOG_LEVEL: 'debug', FOO: 'bar' },
      });
      const container = getDeploymentContainer(yamlStr);
      expect(container.env).toEqual([
        { name: 'LOG_LEVEL', value: 'debug' },
        { name: 'FOO', value: 'bar' },
      ]);
    });

    it('renders envFrom as a list of secretRef entries when provided', () => {
      const yamlStr = buildMcpYaml({
        ...base,
        envFromSecrets: ['kubeclaw-secrets', 'mcp-extra'],
      });
      const container = getDeploymentContainer(yamlStr);
      expect(container.envFrom).toEqual([
        { secretRef: { name: 'kubeclaw-secrets' } },
        { secretRef: { name: 'mcp-extra' } },
      ]);
    });

    it('renders command and args as JSON arrays', () => {
      const yamlStr = buildMcpYaml({
        ...base,
        command: ['node', '/app/server.js'],
        args: ['--port', '3000'],
      });
      const container = getDeploymentContainer(yamlStr);
      expect(container.command).toEqual(['node', '/app/server.js']);
      expect(container.args).toEqual(['--port', '3000']);
    });
  });

  it('forwards probe, scheduling, and podSecurity to the renderer', () => {
    const yaml = buildMcpYaml({
      kind: 'mcp',
      name: 'm',
      image: 'img',
      port: 3000,
      probe: { type: 'tcp', port: 3000 },
      scheduling: { runtimeClassName: 'nvidia' },
      podSecurity: { fsGroup: 1000 },
    });
    expect(yaml).toContain('tcpSocket:');
    expect(yaml).toContain('runtimeClassName: nvidia');
    expect(yaml).toContain('fsGroup: 1000');
  });
});
