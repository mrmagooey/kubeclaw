import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist mocks ────────────────────────────────────────────────────────────

const {
  mockGetAllRegisteredGroups,
  mockSetRegisteredGroup,
  mockDeleteRegisteredGroup,
  mockGetRegisteredGroup,
  mockGetAllScheduledTasks,
  mockGetAllSessions,
  mockClearConversationHistory,
  mockReadNamespacedDeployment,
  mockListNamespacedDeployment,
  mockPatchNamespacedDeployment,
  mockReadNamespacedSecret,
  mockCreateNamespacedSecret,
  mockPatchNamespacedSecret,
  mockReadNamespacedPersistentVolumeClaim,
  mockCreateNamespacedPersistentVolumeClaim,
  mockCreateNamespacedDeployment,
  mockReplaceNamespacedDeployment,
} = vi.hoisted(() => ({
  mockGetAllRegisteredGroups: vi.fn().mockReturnValue({}),
  mockSetRegisteredGroup: vi.fn(),
  mockDeleteRegisteredGroup: vi.fn(),
  mockGetRegisteredGroup: vi.fn().mockReturnValue(undefined),
  mockGetAllScheduledTasks: vi.fn().mockReturnValue([]),
  mockGetAllSessions: vi.fn().mockReturnValue({}),
  mockClearConversationHistory: vi.fn(),
  mockReadNamespacedDeployment: vi.fn(),
  mockListNamespacedDeployment: vi.fn(),
  mockPatchNamespacedDeployment: vi.fn(),
  mockReadNamespacedSecret: vi.fn(),
  mockCreateNamespacedSecret: vi.fn(),
  mockPatchNamespacedSecret: vi.fn(),
  mockReadNamespacedPersistentVolumeClaim: vi.fn(),
  mockCreateNamespacedPersistentVolumeClaim: vi.fn(),
  mockCreateNamespacedDeployment: vi.fn(),
  mockReplaceNamespacedDeployment: vi.fn(),
}));

vi.mock('./db.js', () => ({
  initDatabase: vi.fn().mockResolvedValue(undefined),
  getAllRegisteredGroups: mockGetAllRegisteredGroups,
  setRegisteredGroup: mockSetRegisteredGroup,
  deleteRegisteredGroup: mockDeleteRegisteredGroup,
  getRegisteredGroup: mockGetRegisteredGroup,
  getAllScheduledTasks: mockGetAllScheduledTasks,
  getAllSessions: mockGetAllSessions,
  clearConversationHistory: mockClearConversationHistory,
}));

const MockCoreV1Api = class {};
const MockAppsV1Api = class {};

vi.mock('@kubernetes/client-node', () => {
  const mockCoreV1 = {
    readNamespacedSecret: mockReadNamespacedSecret,
    createNamespacedSecret: mockCreateNamespacedSecret,
    patchNamespacedSecret: mockPatchNamespacedSecret,
    readNamespacedPersistentVolumeClaim: mockReadNamespacedPersistentVolumeClaim,
    createNamespacedPersistentVolumeClaim: mockCreateNamespacedPersistentVolumeClaim,
  };
  const mockAppsV1 = {
    readNamespacedDeployment: mockReadNamespacedDeployment,
    listNamespacedDeployment: mockListNamespacedDeployment,
    patchNamespacedDeployment: mockPatchNamespacedDeployment,
    createNamespacedDeployment: mockCreateNamespacedDeployment,
    replaceNamespacedDeployment: mockReplaceNamespacedDeployment,
  };
  let callCount = 0;
  class MockKubeConfig {
    loadFromCluster() {}
    makeApiClient() { return ++callCount === 1 ? mockCoreV1 : mockAppsV1; }
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: MockCoreV1Api,
    AppsV1Api: MockAppsV1Api,
  };
});

vi.mock('./runtime/llm-client.js', () => ({
  createLLMClient: vi.fn(() => ({})),
  DEFAULT_DIRECT_MODEL: 'gpt-4o',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ── Import after mocks ─────────────────────────────────────────────────────

const { executeTool, TOOLS } = await import('./admin-shell.js');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('admin-shell TOOLS array', () => {
  it('contains all expected tool names', () => {
    const names = TOOLS.map((t) => t.function.name);
    expect(names).toEqual([
      'list_groups',
      'register_group',
      'deregister_group',
      'list_channels',
      'list_scheduled_tasks',
      'get_sessions',
      'clear_conversation',
      'setup_channel',
      'get_orchestrator_status',
      'restart_orchestrator',
    ]);
  });

  it('all tools have descriptions and valid parameters', () => {
    for (const tool of TOOLS) {
      expect(tool.type).toBe('function');
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeDefined();
    }
  });
});

describe('executeTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error for unknown tool', async () => {
    const result = await executeTool('nonexistent', {});
    expect(result).toBe('Unknown tool: nonexistent');
  });

  // ── list_groups ──────────────────────────────────────────────────────

  describe('list_groups', () => {
    it('returns empty message when no groups', async () => {
      mockGetAllRegisteredGroups.mockReturnValue({});
      const result = await executeTool('list_groups', {});
      expect(result).toBe('No groups registered.');
    });

    it('returns formatted group list when populated', async () => {
      mockGetAllRegisteredGroups.mockReturnValue({
        'tg:12345': {
          name: 'TestGroup',
          folder: 'test-group',
          trigger: '@Andy',
          isMain: true,
          requiresTrigger: false,
          llmProvider: undefined,
          containerConfig: { direct: true },
        },
      });
      const result = await executeTool('list_groups', {});
      expect(result).toContain('JID: tg:12345');
      expect(result).toContain('Name: TestGroup');
      expect(result).toContain('Folder: test-group');
      expect(result).toContain('Trigger: @Andy');
      expect(result).toContain('Main: yes');
      expect(result).toContain('RequiresTrigger: no');
      expect(result).toContain('Direct: yes');
    });
  });

  // ── register_group ───────────────────────────────────────────────────

  describe('register_group', () => {
    it('registers a group and returns confirmation', async () => {
      const result = await executeTool('register_group', {
        jid: 'tg:99999',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Bot',
      });
      expect(result).toContain('Registered group "New Group"');
      expect(result).toContain('tg:99999');
      expect(result).toContain('folder: new-group');
      expect(mockSetRegisteredGroup).toHaveBeenCalledWith('tg:99999', expect.objectContaining({
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Bot',
      }));
    });
  });

  // ── deregister_group ─────────────────────────────────────────────────

  describe('deregister_group', () => {
    it('removes existing group', async () => {
      mockGetRegisteredGroup.mockReturnValue({ name: 'Old Group' });
      const result = await executeTool('deregister_group', { jid: 'tg:11111' });
      expect(result).toContain('Removed group "Old Group"');
      expect(mockDeleteRegisteredGroup).toHaveBeenCalledWith('tg:11111');
    });

    it('returns error for unknown JID', async () => {
      mockGetRegisteredGroup.mockReturnValue(undefined);
      const result = await executeTool('deregister_group', { jid: 'tg:00000' });
      expect(result).toContain('No group found with JID: tg:00000');
    });
  });

  // ── list_channels ────────────────────────────────────────────────────

  describe('list_channels', () => {
    it('lists all 5 channel types with status', async () => {
      const result = await executeTool('list_channels', {});
      expect(result).toContain('telegram:');
      expect(result).toContain('whatsapp:');
      expect(result).toContain('discord:');
      expect(result).toContain('slack:');
      expect(result).toContain('irc:');
    });
  });

  // ── list_scheduled_tasks ─────────────────────────────────────────────

  describe('list_scheduled_tasks', () => {
    it('returns empty message when no tasks', async () => {
      mockGetAllScheduledTasks.mockReturnValue([]);
      const result = await executeTool('list_scheduled_tasks', {});
      expect(result).toBe('No scheduled tasks.');
    });

    it('returns formatted task list when populated', async () => {
      mockGetAllScheduledTasks.mockReturnValue([{
        id: 'task-abc',
        group_folder: 'my-group',
        status: 'active',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        next_run: '2026-04-01T09:00:00.000Z',
        last_run: null,
      }]);
      const result = await executeTool('list_scheduled_tasks', {});
      expect(result).toContain('ID: task-abc');
      expect(result).toContain('Group: my-group');
      expect(result).toContain('Status: active');
      expect(result).toContain('Schedule: cron 0 9 * * *');
    });
  });

  // ── get_sessions ─────────────────────────────────────────────────────

  describe('get_sessions', () => {
    it('returns empty message when no sessions', async () => {
      mockGetAllSessions.mockReturnValue({});
      const result = await executeTool('get_sessions', {});
      expect(result).toBe('No active sessions.');
    });

    it('returns session list when populated', async () => {
      mockGetAllSessions.mockReturnValue({ 'my-group': 'sess-123' });
      const result = await executeTool('get_sessions', {});
      expect(result).toContain('my-group: sess-123');
    });
  });

  // ── clear_conversation ───────────────────────────────────────────────

  describe('clear_conversation', () => {
    it('clears history and returns confirmation', async () => {
      const result = await executeTool('clear_conversation', { folder: 'test-group' });
      expect(result).toContain('Cleared conversation history for group folder: test-group');
      expect(mockClearConversationHistory).toHaveBeenCalledWith('test-group');
    });
  });

  // ── get_orchestrator_status ──────────────────────────────────────────

  describe('get_orchestrator_status', () => {
    it('returns orchestrator and channel pod status', async () => {
      mockReadNamespacedDeployment.mockResolvedValue({
        status: { readyReplicas: 1, replicas: 1 },
      });
      mockListNamespacedDeployment.mockResolvedValue({
        items: [
          { metadata: { name: 'kubeclaw-channel-http' }, spec: { replicas: 1 }, status: { readyReplicas: 1 } },
        ],
      });
      const result = await executeTool('get_orchestrator_status', {});
      expect(result).toContain('Orchestrator: kubeclaw-orchestrator');
      expect(result).toContain('Ready: 1/1');
      expect(result).toContain('http: 1/1 ready');
    });

    it('shows (none) when no channel pods', async () => {
      mockReadNamespacedDeployment.mockResolvedValue({
        status: { readyReplicas: 1, replicas: 1 },
      });
      mockListNamespacedDeployment.mockResolvedValue({ items: [] });
      const result = await executeTool('get_orchestrator_status', {});
      expect(result).toContain('(none)');
    });
  });

  // ── restart_orchestrator ─────────────────────────────────────────────

  describe('restart_orchestrator', () => {
    it('triggers rolling restart and returns confirmation', async () => {
      mockPatchNamespacedDeployment.mockResolvedValue({});
      const result = await executeTool('restart_orchestrator', {});
      expect(result).toContain('Rolling restart triggered');
      expect(mockPatchNamespacedDeployment).toHaveBeenCalled();
    });
  });

  // ── setup_channel ────────────────────────────────────────────────────

  describe('setup_channel', () => {
    it('rejects when no credentials provided', async () => {
      const result = await executeTool('setup_channel', { type: 'telegram' });
      expect(result).toContain('No credentials provided');
    });

    it('tool definition includes instanceName parameter', () => {
      const setupTool = TOOLS.find((t) => t.function.name === 'setup_channel');
      expect(setupTool).toBeDefined();
      const props = setupTool!.function.parameters?.properties as Record<string, unknown>;
      expect(props.instanceName).toBeDefined();
    });

    it('uses instanceName for resource naming when provided', async () => {
      // Mock K8s APIs for the full setup flow
      mockReadNamespacedSecret.mockRejectedValue(new Error('not found'));
      mockCreateNamespacedSecret.mockResolvedValue({});
      mockReadNamespacedPersistentVolumeClaim.mockRejectedValue(new Error('not found'));
      mockCreateNamespacedPersistentVolumeClaim.mockResolvedValue({});
      mockReadNamespacedDeployment
        .mockResolvedValueOnce({ spec: { template: { spec: { containers: [{ name: 'orchestrator', image: 'kubeclaw-orchestrator:latest' }] } } } }) // orchestrator lookup
        .mockRejectedValueOnce(new Error('not found')); // channel deployment doesn't exist
      mockCreateNamespacedDeployment.mockResolvedValue({});

      const result = await executeTool('setup_channel', {
        type: 'http',
        instanceName: 'http-staging',
        httpUsers: 'alice:pass',
      });

      // Verify secret uses instanceName
      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'kubeclaw-http-staging-secrets' }),
        }),
      }));

      // Verify PVCs use instanceName
      expect(mockCreateNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'kubeclaw-channel-http-staging-groups' }),
        }),
      }));

      // Verify deployment uses instanceName
      expect(mockCreateNamespacedDeployment).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'kubeclaw-channel-http-staging' }),
        }),
      }));

      // Verify deployment env vars have both KUBECLAW_CHANNEL and KUBECLAW_CHANNEL_TYPE
      const deployCall = mockCreateNamespacedDeployment.mock.calls[0][0];
      const envVars = deployCall.body.spec.template.spec.containers[0].env;
      const channelEnv = envVars.find((e: { name: string }) => e.name === 'KUBECLAW_CHANNEL');
      const typeEnv = envVars.find((e: { name: string }) => e.name === 'KUBECLAW_CHANNEL_TYPE');
      expect(channelEnv.value).toBe('http-staging');
      expect(typeEnv.value).toBe('http');
    });

    it('defaults instanceName to type when not provided', async () => {
      mockReadNamespacedSecret.mockRejectedValue(new Error('not found'));
      mockCreateNamespacedSecret.mockResolvedValue({});
      mockReadNamespacedPersistentVolumeClaim.mockRejectedValue(new Error('not found'));
      mockCreateNamespacedPersistentVolumeClaim.mockResolvedValue({});
      mockReadNamespacedDeployment
        .mockResolvedValueOnce({ spec: { template: { spec: { containers: [{ name: 'orchestrator', image: 'kubeclaw-orchestrator:latest' }] } } } })
        .mockRejectedValueOnce(new Error('not found'));
      mockCreateNamespacedDeployment.mockResolvedValue({});

      await executeTool('setup_channel', { type: 'http', httpUsers: 'bob:pass' });

      // Without instanceName, should use type as the name
      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'kubeclaw-http-secrets' }),
        }),
      }));
      expect(mockCreateNamespacedDeployment).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'kubeclaw-channel-http' }),
        }),
      }));
    });
  });

  // ── progressive: register then list ──────────────────────────────────

  describe('register then list', () => {
    it('registered group appears in list', async () => {
      // Start empty
      mockGetAllRegisteredGroups.mockReturnValue({});
      const empty = await executeTool('list_groups', {});
      expect(empty).toBe('No groups registered.');

      // Register
      await executeTool('register_group', {
        jid: 'test:prog',
        name: 'Progressive',
        folder: 'progressive',
        trigger: '@P',
      });
      expect(mockSetRegisteredGroup).toHaveBeenCalled();

      // Now populated
      mockGetAllRegisteredGroups.mockReturnValue({
        'test:prog': { name: 'Progressive', folder: 'progressive', trigger: '@P' },
      });
      const populated = await executeTool('list_groups', {});
      expect(populated).toContain('test:prog');
      expect(populated).toContain('Progressive');
    });
  });
});
