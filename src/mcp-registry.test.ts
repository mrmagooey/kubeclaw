/**
 * Tests for MCP Server Registry — deploy/remove/list/notify lifecycle
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mock state ----

const mockApplyYaml = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeleteDeployment = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockDeleteService = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockPublish = vi.hoisted(() => vi.fn().mockResolvedValue(1));
const mockSetMcpServer = vi.hoisted(() => vi.fn());
const mockGetAllMcpServers = vi.hoisted(() => vi.fn().mockReturnValue([]));
const mockDeleteMcpServerDb = vi.hoisted(() => vi.fn());

vi.mock('./k8s/job-runner.js', () => ({
  jobRunner: {
    applyYamlToK8s: mockApplyYaml,
    deleteDeployment: mockDeleteDeployment,
    deleteService: mockDeleteService,
  },
}));

vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    publish: mockPublish,
  })),
  getControlChannel: vi.fn((name: string) => `kubeclaw:control:${name}`),
}));

vi.mock('./db.js', () => ({
  setMcpServer: mockSetMcpServer,
  getAllMcpServers: mockGetAllMcpServers,
  deleteMcpServer: mockDeleteMcpServerDb,
}));

vi.mock('./config.js', () => ({
  KUBECLAW_NAMESPACE: 'kubeclaw',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---- Import after mocks ----

import {
  deployMcpServer,
  removeMcpServer,
  listMcpServers,
  getServersForChannel,
  notifyAllChannels,
  syncFromValues,
} from './mcp-registry.js';
import type { McpServerSpec } from './types.js';

// ---- Tests ----

describe('MCP Registry', () => {
  const weatherSpec: McpServerSpec = {
    name: 'weather',
    image: 'mcp/weather-server:latest',
    port: 3000,
    path: '/mcp',
  };

  const calendarSpec: McpServerSpec = {
    name: 'calendar',
    image: 'mcp/calendar:v1',
    port: 8080,
    path: '/api/mcp',
    channels: ['telegram', 'http'],
    env: { API_KEY: 'test-key' },
    resources: {
      memoryRequest: '256Mi',
      memoryLimit: '512Mi',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllMcpServers.mockReturnValue([]);
  });

  describe('deployMcpServer', () => {
    it('generates Deployment + Service YAML and applies to K8s', async () => {
      await deployMcpServer(weatherSpec);

      expect(mockApplyYaml).toHaveBeenCalledOnce();
      const yaml = mockApplyYaml.mock.calls[0][0] as string;

      // Verify Deployment
      expect(yaml).toContain('kind: Deployment');
      expect(yaml).toContain('name: kubeclaw-mcp-weather');
      expect(yaml).toContain('namespace: kubeclaw');
      expect(yaml).toContain('image: mcp/weather-server:latest');
      expect(yaml).toContain('containerPort: 3000');
      expect(yaml).toContain('app: kubeclaw-mcp-weather');
      expect(yaml).toContain('kubeclaw-component: mcp-server');

      // Verify Service
      expect(yaml).toContain('kind: Service');
      expect(yaml).toContain('type: ClusterIP');
      expect(yaml).toContain('port: 3000');

      // Verify security context
      expect(yaml).toContain('runAsUser: 1000');
      expect(yaml).toContain('runAsNonRoot: true');
      expect(yaml).toContain('allowPrivilegeEscalation: false');
      expect(yaml).toContain('automountServiceAccountToken: false');
    });

    it('saves spec to database', async () => {
      await deployMcpServer(weatherSpec);
      expect(mockSetMcpServer).toHaveBeenCalledWith(weatherSpec);
    });

    it('notifies channel pods after deployment', async () => {
      mockGetAllMcpServers.mockReturnValue([weatherSpec]);
      await deployMcpServer(weatherSpec);
      // Should publish to common channels since weatherSpec has no channel restriction
      expect(mockPublish).toHaveBeenCalled();
    });

    it('includes environment variables in YAML when specified', async () => {
      await deployMcpServer(calendarSpec);

      const yaml = mockApplyYaml.mock.calls[0][0] as string;
      expect(yaml).toContain('name: API_KEY');
      expect(yaml).toContain('"test-key"');
    });

    it('uses custom port and resources', async () => {
      await deployMcpServer(calendarSpec);

      const yaml = mockApplyYaml.mock.calls[0][0] as string;
      expect(yaml).toContain('containerPort: 8080');
      expect(yaml).toContain('memory: 256Mi'); // request
      expect(yaml).toContain('memory: 512Mi'); // limit
    });

    it('uses default port and resources when not specified', async () => {
      const minimalSpec: McpServerSpec = {
        name: 'minimal',
        image: 'minimal:latest',
      };
      await deployMcpServer(minimalSpec);

      const yaml = mockApplyYaml.mock.calls[0][0] as string;
      expect(yaml).toContain('containerPort: 3000'); // default port
      expect(yaml).toContain('memory: 128Mi'); // default request
    });
  });

  describe('removeMcpServer', () => {
    it('deletes Deployment and Service from K8s', async () => {
      await removeMcpServer('weather');

      expect(mockDeleteDeployment).toHaveBeenCalledWith(
        'kubeclaw-mcp-weather',
        'kubeclaw',
      );
      expect(mockDeleteService).toHaveBeenCalledWith(
        'kubeclaw-mcp-weather',
        'kubeclaw',
      );
    });

    it('deletes spec from database', async () => {
      await removeMcpServer('weather');
      expect(mockDeleteMcpServerDb).toHaveBeenCalledWith('weather');
    });

    it('notifies channel pods after removal', async () => {
      // With remaining servers, notify happens
      mockGetAllMcpServers.mockReturnValue([calendarSpec]);
      await removeMcpServer('weather');
      expect(mockPublish).toHaveBeenCalled();
    });

    it('skips notification when no servers remain', async () => {
      mockGetAllMcpServers.mockReturnValue([]);
      await removeMcpServer('weather');
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('handles K8s deletion errors gracefully', async () => {
      mockDeleteDeployment.mockRejectedValueOnce(new Error('Not found'));

      await expect(removeMcpServer('weather')).resolves.toBeUndefined();
      // Should still delete from DB
      expect(mockDeleteMcpServerDb).toHaveBeenCalledWith('weather');
    });
  });

  describe('listMcpServers', () => {
    it('returns all servers from database', () => {
      mockGetAllMcpServers.mockReturnValue([weatherSpec, calendarSpec]);

      const servers = listMcpServers();
      expect(servers).toHaveLength(2);
      expect(servers[0].name).toBe('weather');
      expect(servers[1].name).toBe('calendar');
    });

    it('returns empty array when no servers', () => {
      mockGetAllMcpServers.mockReturnValue([]);
      expect(listMcpServers()).toEqual([]);
    });
  });

  describe('getServersForChannel', () => {
    it('returns all servers with no channel restriction', () => {
      mockGetAllMcpServers.mockReturnValue([weatherSpec]); // no channels field

      const servers = getServersForChannel('telegram');
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('weather');
      expect(servers[0].url).toBe('http://kubeclaw-mcp-weather:3000/mcp');
    });

    it('filters servers by channel restriction', () => {
      mockGetAllMcpServers.mockReturnValue([weatherSpec, calendarSpec]);

      // Calendar has channels: ['telegram', 'http']
      const telegramServers = getServersForChannel('telegram');
      expect(telegramServers).toHaveLength(2); // both (weather unrestricted, calendar includes telegram)

      const discordServers = getServersForChannel('discord');
      expect(discordServers).toHaveLength(1); // only weather (unrestricted)
      expect(discordServers[0].name).toBe('weather');
    });

    it('builds correct URL from spec', () => {
      mockGetAllMcpServers.mockReturnValue([calendarSpec]);

      const servers = getServersForChannel('telegram');
      expect(servers[0].url).toBe('http://kubeclaw-mcp-calendar:8080/api/mcp');
    });

    it('uses default port and path for URL', () => {
      const minimalSpec: McpServerSpec = {
        name: 'minimal',
        image: 'img:latest',
      };
      mockGetAllMcpServers.mockReturnValue([minimalSpec]);

      const servers = getServersForChannel('any');
      expect(servers[0].url).toBe('http://kubeclaw-mcp-minimal:3000/mcp');
    });

    it('passes through allowedTools', () => {
      const specWithTools: McpServerSpec = {
        name: 'filtered',
        image: 'img:latest',
        allowedTools: ['tool_a', 'tool_b*'],
      };
      mockGetAllMcpServers.mockReturnValue([specWithTools]);

      const servers = getServersForChannel('any');
      expect(servers[0].allowedTools).toEqual(['tool_a', 'tool_b*']);
    });
  });

  describe('notifyAllChannels', () => {
    it('publishes mcp_update to all relevant channels', async () => {
      mockGetAllMcpServers.mockReturnValue([weatherSpec]); // no channel restriction

      await notifyAllChannels();

      // Should publish to common channels (http, telegram, discord, etc.)
      expect(mockPublish).toHaveBeenCalled();
      const calls = mockPublish.mock.calls;

      // Verify the message format
      const msg = JSON.parse(calls[0][1]);
      expect(msg.command).toBe('mcp_update');
      const servers = JSON.parse(msg.servers);
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('weather');
    });

    it('only notifies channels that have access', async () => {
      const restrictedSpec: McpServerSpec = {
        name: 'restricted',
        image: 'img:latest',
        channels: ['telegram'],
      };
      mockGetAllMcpServers.mockReturnValue([restrictedSpec]);

      await notifyAllChannels();

      // Should only publish to telegram control channel
      const channels = mockPublish.mock.calls.map((c) => c[0]);
      expect(channels).toContain('kubeclaw:control:telegram');
      expect(channels).not.toContain('kubeclaw:control:discord');
    });

    it('does nothing when no servers are configured', async () => {
      mockGetAllMcpServers.mockReturnValue([]);
      await notifyAllChannels();
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('syncFromValues', () => {
    it('deploys servers not already in DB', async () => {
      mockGetAllMcpServers.mockReturnValue([]); // DB is empty

      await syncFromValues([weatherSpec]);

      // Should deploy the new server
      expect(mockApplyYaml).toHaveBeenCalledOnce();
      expect(mockSetMcpServer).toHaveBeenCalledWith(weatherSpec);
    });

    it('updates existing servers in DB without redeploying', async () => {
      mockGetAllMcpServers.mockReturnValue([weatherSpec]); // already in DB

      const updatedSpec = { ...weatherSpec, image: 'mcp/weather:v2' };
      await syncFromValues([updatedSpec]);

      // Should NOT deploy (already exists), but should update DB
      expect(mockApplyYaml).not.toHaveBeenCalled();
      expect(mockSetMcpServer).toHaveBeenCalledWith(updatedSpec);
    });

    it('handles empty specs list', async () => {
      await syncFromValues([]);
      expect(mockApplyYaml).not.toHaveBeenCalled();
      expect(mockSetMcpServer).not.toHaveBeenCalled();
    });
  });
});
