/**
 * Tests for MCP Server database operations
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  setMcpServer,
  getMcpServer,
  getAllMcpServers,
  deleteMcpServer,
} from './db.js';
import type { McpServerSpec } from './types.js';

beforeEach(async () => {
  await _initTestDatabase();
});

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
  channels: ['telegram'],
  env: { API_KEY: 'secret' },
  allowedTools: ['list_events'],
  resources: {
    memoryRequest: '256Mi',
    memoryLimit: '512Mi',
  },
};

describe('MCP Server DB operations', () => {
  describe('setMcpServer', () => {
    it('stores a new MCP server spec', () => {
      setMcpServer(weatherSpec);

      const result = getMcpServer('weather');
      expect(result).toBeDefined();
      expect(result!.name).toBe('weather');
      expect(result!.image).toBe('mcp/weather-server:latest');
      expect(result!.port).toBe(3000);
    });

    it('stores complex spec with all fields', () => {
      setMcpServer(calendarSpec);

      const result = getMcpServer('calendar');
      expect(result).toBeDefined();
      expect(result!.channels).toEqual(['telegram']);
      expect(result!.env).toEqual({ API_KEY: 'secret' });
      expect(result!.allowedTools).toEqual(['list_events']);
      expect(result!.resources?.memoryRequest).toBe('256Mi');
    });

    it('updates existing server spec (upsert)', () => {
      setMcpServer(weatherSpec);
      const updatedSpec = { ...weatherSpec, image: 'mcp/weather:v2', port: 4000 };
      setMcpServer(updatedSpec);

      const result = getMcpServer('weather');
      expect(result!.image).toBe('mcp/weather:v2');
      expect(result!.port).toBe(4000);
    });
  });

  describe('getMcpServer', () => {
    it('returns undefined for nonexistent server', () => {
      expect(getMcpServer('nonexistent')).toBeUndefined();
    });

    it('returns undefined for deleted server', () => {
      setMcpServer(weatherSpec);
      deleteMcpServer('weather');
      expect(getMcpServer('weather')).toBeUndefined();
    });
  });

  describe('getAllMcpServers', () => {
    it('returns empty array when no servers', () => {
      expect(getAllMcpServers()).toEqual([]);
    });

    it('returns all active servers', () => {
      setMcpServer(weatherSpec);
      setMcpServer(calendarSpec);

      const servers = getAllMcpServers();
      expect(servers).toHaveLength(2);
      expect(servers.map((s) => s.name)).toContain('weather');
      expect(servers.map((s) => s.name)).toContain('calendar');
    });

    it('excludes deleted servers', () => {
      setMcpServer(weatherSpec);
      setMcpServer(calendarSpec);
      deleteMcpServer('weather');

      const servers = getAllMcpServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('calendar');
    });

    it('returns servers ordered by created_at', () => {
      setMcpServer(weatherSpec);
      setMcpServer(calendarSpec);

      const servers = getAllMcpServers();
      expect(servers[0].name).toBe('weather'); // created first
      expect(servers[1].name).toBe('calendar');
    });
  });

  describe('deleteMcpServer', () => {
    it('deletes an existing server', () => {
      setMcpServer(weatherSpec);
      deleteMcpServer('weather');
      expect(getMcpServer('weather')).toBeUndefined();
    });

    it('does nothing for nonexistent server', () => {
      expect(() => deleteMcpServer('nonexistent')).not.toThrow();
    });

    it('only deletes the specified server', () => {
      setMcpServer(weatherSpec);
      setMcpServer(calendarSpec);
      deleteMcpServer('weather');

      expect(getMcpServer('weather')).toBeUndefined();
      expect(getMcpServer('calendar')).toBeDefined();
    });
  });
});
