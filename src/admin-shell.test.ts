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
  mockRegisterSpecialist,
  mockEditSpecialist,
  mockRemoveSpecialist,
  mockListSpecialistOverrides,
  mockReadNamespacedConfigMap,
  mockReplaceNamespacedConfigMap,
  mockCreateNamespacedConfigMap,
  mockRegisterTool,
  mockEditTool,
  mockRemoveTool,
  mockListToolOverrides,
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
  mockRegisterSpecialist: vi.fn().mockReturnValue({ ok: true }),
  mockEditSpecialist: vi.fn().mockReturnValue({ ok: true }),
  mockRemoveSpecialist: vi.fn().mockReturnValue({ ok: true }),
  mockListSpecialistOverrides: vi.fn().mockReturnValue([]),
  mockRegisterTool: vi.fn().mockReturnValue({ ok: true }),
  mockEditTool: vi.fn().mockReturnValue({ ok: true }),
  mockRemoveTool: vi.fn().mockReturnValue({ ok: true }),
  mockListToolOverrides: vi.fn().mockReturnValue([]),
  mockReadNamespacedConfigMap: vi
    .fn()
    .mockResolvedValue({ metadata: { resourceVersion: '1' } }),
  mockReplaceNamespacedConfigMap: vi.fn().mockResolvedValue(undefined),
  mockCreateNamespacedConfigMap: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./db.js', () => ({
  // `db` is the exported SqlJsDatabase instance; admin-shell.ts checks `db.db`
  // to decide whether to call initDatabase(). We export a truthy object so the
  // guard is satisfied and initDatabase() is never called in tests.
  db: {},
  initDatabase: vi.fn().mockResolvedValue(undefined),
  getAllRegisteredGroups: mockGetAllRegisteredGroups,
  setRegisteredGroup: mockSetRegisteredGroup,
  deleteRegisteredGroup: mockDeleteRegisteredGroup,
  getRegisteredGroup: mockGetRegisteredGroup,
  getAllScheduledTasks: mockGetAllScheduledTasks,
  getAllSessions: mockGetAllSessions,
  clearConversationHistory: mockClearConversationHistory,
  // Story 180
  pruneOldBootstrapHistory: vi.fn().mockReturnValue(0),
  recordBootstrapTerminal: vi.fn(),
  getRecentBootstrapHistory: vi.fn().mockReturnValue([]),
}));

vi.mock('./skills/orchestrator/specialist-registry.js', () => ({
  registerSpecialist: mockRegisterSpecialist,
  editSpecialist: mockEditSpecialist,
  removeSpecialist: mockRemoveSpecialist,
  listSpecialistOverrides: mockListSpecialistOverrides,
}));

vi.mock('./skills/orchestrator/tool-registry.js', () => ({
  registerTool: mockRegisterTool,
  editTool: mockEditTool,
  removeTool: mockRemoveTool,
  listToolOverrides: mockListToolOverrides,
}));

vi.mock('./tools/reconciler.js', () => ({
  ToolReconciler: class {
    apply() {
      return Promise.resolve();
    }
  },
  loadBaselineFromDisk: vi.fn().mockReturnValue([]),
}));

vi.mock('./skills/orchestrator/channel-manifest-registry.js', () => ({
  registerChannelManifest: vi.fn().mockReturnValue({
    ok: true,
    manifest_hash: 'abc',
    source: 'admin-registered',
  }),
  listChannelManifestOverrides: vi.fn().mockReturnValue([]),
}));

vi.mock('./channel-manifests/reconciler.js', () => ({
  ChannelManifestReconciler: class {
    apply() {
      return Promise.resolve();
    }
  },
  loadBaselineFromDisk: vi.fn().mockReturnValue([]),
  mergeManifests: vi.fn().mockReturnValue([]),
}));

vi.mock('./per-group-capabilities/k8s-client.js', () => ({
  RealPerGroupK8sClient: class {
    constructor(_kc?: unknown) {}
  },
}));

vi.mock('./per-group-capabilities/credentials.js', () => ({
  setGroupCredential: vi.fn().mockResolvedValue(undefined),
  unsetGroupCredential: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./per-group-capabilities/index.js', () => ({
  onGroupRemoved: vi.fn().mockResolvedValue(undefined),
}));

const MockCoreV1Api = class {};
const MockAppsV1Api = class {};
const MockBatchV1Api = class {};
const MockNetworkingV1Api = class {};

vi.mock('@kubernetes/client-node', () => {
  const mockCoreV1 = {
    readNamespacedSecret: mockReadNamespacedSecret,
    createNamespacedSecret: mockCreateNamespacedSecret,
    patchNamespacedSecret: mockPatchNamespacedSecret,
    readNamespacedPersistentVolumeClaim:
      mockReadNamespacedPersistentVolumeClaim,
    createNamespacedPersistentVolumeClaim:
      mockCreateNamespacedPersistentVolumeClaim,
    readNamespacedConfigMap: mockReadNamespacedConfigMap,
    replaceNamespacedConfigMap: mockReplaceNamespacedConfigMap,
    createNamespacedConfigMap: mockCreateNamespacedConfigMap,
  };
  const mockAppsV1 = {
    readNamespacedDeployment: mockReadNamespacedDeployment,
    listNamespacedDeployment: mockListNamespacedDeployment,
    patchNamespacedDeployment: mockPatchNamespacedDeployment,
    createNamespacedDeployment: mockCreateNamespacedDeployment,
    replaceNamespacedDeployment: mockReplaceNamespacedDeployment,
  };
  const mockBatchV1 = {};
  const mockNetV1 = {};
  class MockKubeConfig {
    loadFromCluster() {}
    loadFromDefault() {}
    makeApiClient(ApiClass: unknown) {
      if (ApiClass === MockCoreV1Api) return mockCoreV1;
      if (ApiClass === MockBatchV1Api) return mockBatchV1;
      if (ApiClass === MockNetworkingV1Api) return mockNetV1;
      return mockAppsV1;
    }
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: MockCoreV1Api,
    AppsV1Api: MockAppsV1Api,
    BatchV1Api: MockBatchV1Api,
    NetworkingV1Api: MockNetworkingV1Api,
  };
});

vi.mock('./runtime/llm-client.js', () => ({
  createLLMClient: vi.fn(() => ({})),
  DEFAULT_DIRECT_MODEL: 'gpt-4o',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('./k8s/ipc-redis.js', () => ({
  currentStepByJob: new Map(),
  pendingBootstrapQuestionByJob: new Map(),
  startBootstrapTaskWatcher: vi.fn(),
  registerBootstrapDeps: vi.fn(),
}));

vi.mock('./k8s/bootstrap-runner.js', () => ({
  bootstrapChannelFromSkill: vi
    .fn()
    .mockResolvedValue({ bootstrapJobId: 'test-job-id' }),
  waitForBootstrapJobCompletion: vi.fn().mockResolvedValue(undefined),
  bootstrapStatus: vi.fn().mockResolvedValue({ active: [], recent: [] }),
  registerBootstrapMeta: vi.fn(),
  deregisterBootstrapMeta: vi.fn(),
  getBootstrapMeta: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./k8s/job-runner.js', () => ({
  jobRunner: { waitForJobCompletion: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('./k8s/redis-client.js', () => ({
  getRedisClient: vi.fn(() => ({
    publish: vi.fn().mockResolvedValue(1),
  })),
}));

// ── Import after mocks ─────────────────────────────────────────────────────

const { executeTool, TOOLS, activeBootstraps, buildPendingBootstrapNote, broadcastBootstrapSse } =
  await import('./admin-shell.js');
const { getRedisClient } = await import('./k8s/redis-client.js');
const { pendingBootstrapQuestionByJob } = await import('./k8s/ipc-redis.js');
const { bootstrapChannelFromSkill: mockBootstrapChannelFromSkill, waitForBootstrapJobCompletion: mockWaitForBootstrapJobCompletion } =
  await import('./k8s/bootstrap-runner.js');

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
      'remove_channel',
      // Story 178: channel manifest IPC tools
      'list_channel_manifests',
      'register_channel_manifest',
      // Story 179: bootstrap skill IPC tools
      'list_bootstrap_skills',
      'register_bootstrap_skill',
      'remove_bootstrap_skill',
      'bootstrap_channel_from_skill',
      // Story 181: upgrade channel
      'upgrade_channel',
      // Story 180: bootstrap status tools
      'report_step',
      'reply_to_bootstrap',
      'bootstrap_status',
      // Story 184: bootstrap audit log
      'bootstrap_audit_log',
      'get_orchestrator_status',
      'restart_orchestrator',
      'install_capability',
      'remove_capability',
      'list_capabilities',
      'get_capability_logs',
      'register_specialist',
      'edit_specialist',
      'remove_specialist',
      'list_specialists',
      'register_tool',
      'edit_tool',
      'remove_tool',
      'list_tools',
      'set_group_credential',
      'unset_group_credential',
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
      expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
        'tg:99999',
        expect.objectContaining({
          name: 'New Group',
          folder: 'new-group',
          trigger: '@Bot',
        }),
      );
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
      mockGetAllScheduledTasks.mockReturnValue([
        {
          id: 'task-abc',
          group_folder: 'my-group',
          status: 'active',
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          next_run: '2026-04-01T09:00:00.000Z',
          last_run: null,
        },
      ]);
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
      const result = await executeTool('clear_conversation', {
        folder: 'test-group',
      });
      expect(result).toContain(
        'Cleared conversation history for group folder: test-group',
      );
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
          {
            metadata: { name: 'kubeclaw-channel-http' },
            spec: { replicas: 1 },
            status: { readyReplicas: 1 },
          },
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
      const props = setupTool!.function.parameters?.properties as Record<
        string,
        unknown
      >;
      expect(props.instanceName).toBeDefined();
    });

    it('uses instanceName for resource naming when provided', async () => {
      // Mock K8s APIs for the full setup flow
      mockReadNamespacedSecret.mockRejectedValue(new Error('not found'));
      mockCreateNamespacedSecret.mockResolvedValue({});
      mockReadNamespacedPersistentVolumeClaim.mockRejectedValue(
        new Error('not found'),
      );
      mockCreateNamespacedPersistentVolumeClaim.mockResolvedValue({});
      mockReadNamespacedDeployment
        .mockResolvedValueOnce({
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: 'orchestrator',
                    image: 'kubeclaw-orchestrator:latest',
                  },
                ],
              },
            },
          },
        }) // orchestrator lookup
        .mockRejectedValueOnce(new Error('not found')); // channel deployment doesn't exist
      mockCreateNamespacedDeployment.mockResolvedValue({});

      const result = await executeTool('setup_channel', {
        type: 'http',
        instanceName: 'http-staging',
        httpUsers: 'alice:pass',
      });

      // Verify secret uses instanceName
      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'kubeclaw-http-staging-secrets',
            }),
          }),
        }),
      );

      // Verify PVCs use instanceName
      expect(mockCreateNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'kubeclaw-channel-http-staging-groups',
            }),
          }),
        }),
      );

      // Verify deployment uses instanceName
      expect(mockCreateNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'kubeclaw-channel-http-staging',
            }),
          }),
        }),
      );

      // Verify deployment env vars have both KUBECLAW_CHANNEL and KUBECLAW_CHANNEL_TYPE
      const deployCall = mockCreateNamespacedDeployment.mock.calls[0][0];
      const envVars = deployCall.body.spec.template.spec.containers[0].env;
      const channelEnv = envVars.find(
        (e: { name: string }) => e.name === 'KUBECLAW_CHANNEL',
      );
      const typeEnv = envVars.find(
        (e: { name: string }) => e.name === 'KUBECLAW_CHANNEL_TYPE',
      );
      expect(channelEnv.value).toBe('http-staging');
      expect(typeEnv.value).toBe('http');
    });

    it('defaults instanceName to type when not provided', async () => {
      mockReadNamespacedSecret.mockRejectedValue(new Error('not found'));
      mockCreateNamespacedSecret.mockResolvedValue({});
      mockReadNamespacedPersistentVolumeClaim.mockRejectedValue(
        new Error('not found'),
      );
      mockCreateNamespacedPersistentVolumeClaim.mockResolvedValue({});
      mockReadNamespacedDeployment
        .mockResolvedValueOnce({
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name: 'orchestrator',
                    image: 'kubeclaw-orchestrator:latest',
                  },
                ],
              },
            },
          },
        })
        .mockRejectedValueOnce(new Error('not found'));
      mockCreateNamespacedDeployment.mockResolvedValue({});

      await executeTool('setup_channel', {
        type: 'http',
        httpUsers: 'bob:pass',
      });

      // Without instanceName, should use type as the name
      expect(mockCreateNamespacedSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'kubeclaw-http-secrets',
            }),
          }),
        }),
      );
      expect(mockCreateNamespacedDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'kubeclaw-channel-http',
            }),
          }),
        }),
      );
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
        'test:prog': {
          name: 'Progressive',
          folder: 'progressive',
          trigger: '@P',
        },
      });
      const populated = await executeTool('list_groups', {});
      expect(populated).toContain('test:prog');
      expect(populated).toContain('Progressive');
    });
  });

  // ── register_specialist ───────────────────────────────────────────────

  describe('register_specialist', () => {
    it('calls registerSpecialist and returns confirmation', async () => {
      mockRegisterSpecialist.mockReturnValue({ ok: true });
      const result = await executeTool('register_specialist', {
        name: 'Research',
        prompt: 'You are a research specialist.',
        triggers: ['Researcher', 'Analysis'],
        llmProvider: 'claude',
      });
      expect(mockRegisterSpecialist).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Research',
          prompt: 'You are a research specialist.',
          triggers: ['Researcher', 'Analysis'],
          llmProvider: 'claude',
        }),
        expect.any(Function),
      );
      expect(result).toContain('Research');
      expect(result).toContain('Changes are live');
    });

    it('returns error when registerSpecialist fails validation', async () => {
      mockRegisterSpecialist.mockReturnValue({
        ok: false,
        error: 'specialist already registered: Research',
      });
      const result = await executeTool('register_specialist', {
        name: 'Research',
        prompt: 'duplicate',
      });
      expect(result).toContain('Error');
      expect(result).toContain('already registered');
    });

    it('tool definition includes triggers and llmProvider parameters', () => {
      const tool = TOOLS.find((t) => t.function.name === 'register_specialist');
      expect(tool).toBeDefined();
      const props = tool!.function.parameters?.properties as Record<
        string,
        unknown
      >;
      expect(props.name).toBeDefined();
      expect(props.prompt).toBeDefined();
      expect(props.triggers).toBeDefined();
      expect(props.llmProvider).toBeDefined();
      expect(props.memory).toBeDefined();
      expect(props.tools).toBeDefined();
    });
  });

  // ── edit_specialist ───────────────────────────────────────────────────

  describe('edit_specialist', () => {
    it('calls editSpecialist with name and patch fields', async () => {
      mockEditSpecialist.mockReturnValue({ ok: true });
      const result = await executeTool('edit_specialist', {
        name: 'Research',
        prompt: 'Updated prompt.',
      });
      expect(mockEditSpecialist).toHaveBeenCalledWith(
        {
          name: 'Research',
          patch: expect.objectContaining({ prompt: 'Updated prompt.' }),
        },
        expect.any(Function),
      );
      expect(result).toContain('Research');
      expect(result).toContain('Changes are live');
    });

    it('returns error when specialist does not exist', async () => {
      mockEditSpecialist.mockReturnValue({
        ok: false,
        error: 'no override registered: Ghost',
      });
      const result = await executeTool('edit_specialist', {
        name: 'Ghost',
        prompt: 'new',
      });
      expect(result).toContain('Error');
      expect(result).toContain('no override registered');
    });

    it('returns error when name is missing', async () => {
      const result = await executeTool('edit_specialist', {});
      expect(result).toContain('Error');
      expect(mockEditSpecialist).not.toHaveBeenCalled();
    });
  });

  // ── remove_specialist ─────────────────────────────────────────────────

  describe('remove_specialist', () => {
    it('calls removeSpecialist and returns confirmation', async () => {
      mockRemoveSpecialist.mockReturnValue({ ok: true });
      const result = await executeTool('remove_specialist', {
        name: 'Research',
      });
      expect(mockRemoveSpecialist).toHaveBeenCalledWith(
        { name: 'Research' },
        expect.any(Function),
      );
      expect(result).toContain('Research');
      expect(result).toContain('Changes are live');
    });

    it('returns error when specialist does not exist', async () => {
      mockRemoveSpecialist.mockReturnValue({
        ok: false,
        error: 'no such override: Ghost',
      });
      const result = await executeTool('remove_specialist', { name: 'Ghost' });
      expect(result).toContain('Error');
      expect(result).toContain('no such override');
    });

    it('returns error when name is missing', async () => {
      const result = await executeTool('remove_specialist', {});
      expect(result).toContain('Error');
      expect(mockRemoveSpecialist).not.toHaveBeenCalled();
    });
  });

  // ── list_specialists ──────────────────────────────────────────────────

  describe('list_specialists', () => {
    it('returns empty message when no overrides registered', async () => {
      mockListSpecialistOverrides.mockReturnValue([]);
      const result = await executeTool('list_specialists', {});
      expect(result).toContain('No specialist overrides');
    });

    it('returns formatted list when overrides present', async () => {
      mockListSpecialistOverrides.mockReturnValue([
        {
          name: 'Research',
          prompt: 'You are a research specialist.',
          triggers: ['Researcher', 'Analysis'],
          llmProvider: 'claude',
        },
        {
          name: 'Helper',
          prompt: 'Answer questions quickly.',
          memory: { isolated: true },
        },
      ]);
      const result = await executeTool('list_specialists', {});
      expect(result).toContain('Name: Research');
      expect(result).toContain('Triggers: Researcher, Analysis');
      expect(result).toContain('Provider: claude');
      expect(result).toContain('Name: Helper');
      expect(result).toContain('Memory:');
    });
  });

  // ── register_specialist with reconciler (Task 2) ──────────────────────────

  describe('register_specialist with reconciler', () => {
    it('passes reconcile fn to registerSpecialist', async () => {
      mockRegisterSpecialist.mockReturnValue({ ok: true });
      await executeTool('register_specialist', {
        name: 'Wired',
        prompt: 'test prompt',
      });
      // registerSpecialist must be called with a second argument (the reconcile fn)
      expect(mockRegisterSpecialist).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Wired' }),
        expect.any(Function),
      );
    });
  });

  // ── register_specialist reconcile wiring (Task 3) ─────────────────────────

  describe('register_specialist reconcile wiring', () => {
    it('calls replaceNamespacedConfigMap after successful register', async () => {
      mockRegisterSpecialist.mockReturnValue({ ok: true });
      mockReadNamespacedConfigMap.mockResolvedValue({
        metadata: { resourceVersion: '42' },
      });
      mockReplaceNamespacedConfigMap.mockResolvedValue(undefined);
      await executeTool('register_specialist', {
        name: 'Wired',
        prompt: 'prompt text',
      });
      expect(mockRegisterSpecialist).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Wired' }),
        expect.any(Function),
      );
      // Invoke the reconcile fn that was passed to registerSpecialist.
      const reconcileFn = mockRegisterSpecialist.mock
        .calls[0][1] as () => Promise<void>;
      await reconcileFn();
      expect(mockReadNamespacedConfigMap).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'kubeclaw-specialists' }),
      );
      expect(mockReplaceNamespacedConfigMap).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'kubeclaw-specialists' }),
      );
    });

    it('returns live-catalog success string', async () => {
      mockRegisterSpecialist.mockReturnValue({ ok: true });
      const result = await executeTool('register_specialist', {
        name: 'Wired',
        prompt: 'prompt text',
      });
      expect(result).toContain('Changes are live');
      expect(result).not.toContain('next orchestrator restart');
    });

    it('404 from readNamespacedConfigMap falls back to createNamespacedConfigMap', async () => {
      mockRegisterSpecialist.mockReturnValue({ ok: true });
      const notFound = Object.assign(new Error('not found'), {
        response: { statusCode: 404 },
      });
      mockReadNamespacedConfigMap.mockRejectedValue(notFound);
      mockCreateNamespacedConfigMap.mockResolvedValue(undefined);
      await executeTool('register_specialist', {
        name: 'New',
        prompt: 'p',
      });
      const reconcileFn = mockRegisterSpecialist.mock
        .calls[0][1] as () => Promise<void>;
      await reconcileFn();
      expect(mockCreateNamespacedConfigMap).toHaveBeenCalled();
    });

    it('non-404 configMapApply error is swallowed (non-fatal)', async () => {
      // specialist-registry.ts:31-34 already .catch()es the reconcile fn —
      // a k8s error must not surface as an executeTool rejection.
      mockRegisterSpecialist.mockReturnValue({ ok: true });
      mockReadNamespacedConfigMap.mockRejectedValue(
        Object.assign(new Error('k8s 500'), { response: { statusCode: 500 } }),
      );
      const result = await executeTool('register_specialist', {
        name: 'Fail',
        prompt: 'p',
      });
      expect(result).toContain('Changes are live');
    });
  });

  describe('edit_specialist reconcile wiring', () => {
    it('passes reconcile fn to editSpecialist', async () => {
      mockEditSpecialist.mockReturnValue({ ok: true });
      await executeTool('edit_specialist', { name: 'R', prompt: 'new' });
      expect(mockEditSpecialist).toHaveBeenCalledWith(
        { name: 'R', patch: expect.objectContaining({ prompt: 'new' }) },
        expect.any(Function),
      );
    });

    it('returns live-catalog success string', async () => {
      mockEditSpecialist.mockReturnValue({ ok: true });
      const result = await executeTool('edit_specialist', {
        name: 'R',
        prompt: 'new',
      });
      expect(result).toContain('Changes are live');
      expect(result).not.toContain('next orchestrator restart');
    });
  });

  describe('remove_specialist reconcile wiring', () => {
    it('passes reconcile fn to removeSpecialist', async () => {
      mockRemoveSpecialist.mockReturnValue({ ok: true });
      await executeTool('remove_specialist', { name: 'R' });
      expect(mockRemoveSpecialist).toHaveBeenCalledWith(
        { name: 'R' },
        expect.any(Function),
      );
    });

    it('returns live-catalog success string', async () => {
      mockRemoveSpecialist.mockReturnValue({ ok: true });
      const result = await executeTool('remove_specialist', { name: 'R' });
      expect(result).toContain('Changes are live');
      expect(result).not.toContain('next orchestrator restart');
    });
  });

  // ── register_tool ─────────────────────────────────────────────────────────

  describe('register_tool', () => {
    it('calls registerTool and returns confirmation', async () => {
      mockRegisterTool.mockReturnValue({ ok: true });
      const result = await executeTool('register_tool', {
        name: 'weather',
        description: 'Get weather data',
        parameters: { type: 'object', properties: {} },
        image: 'ghcr.io/example/weather:1',
        pattern: 'http',
      });
      expect(mockRegisterTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'weather',
          image: 'ghcr.io/example/weather:1',
          pattern: 'http',
        }),
        expect.any(Function),
      );
      expect(result).toContain('weather');
      expect(result).toContain('Changes are live');
    });

    it('returns error when registerTool fails validation', async () => {
      mockRegisterTool.mockReturnValue({
        ok: false,
        error: 'tool already registered: weather',
      });
      const result = await executeTool('register_tool', {
        name: 'weather',
        description: 'dup',
        parameters: {},
        image: 'img:1',
        pattern: 'http',
      });
      expect(result).toContain('Error');
      expect(result).toContain('already registered');
    });

    it('tool definition has required fields', () => {
      const tool = TOOLS.find((t) => t.function.name === 'register_tool');
      expect(tool).toBeDefined();
      expect(tool!.function.parameters?.required).toEqual(
        expect.arrayContaining([
          'name',
          'description',
          'parameters',
          'image',
          'pattern',
        ]),
      );
    });

    it('passes optional fields through to registerTool', async () => {
      mockRegisterTool.mockReturnValue({ ok: true });
      await executeTool('register_tool', {
        name: 'weather',
        description: 'Get weather data',
        parameters: { type: 'object', properties: {} },
        image: 'ghcr.io/example/weather:1',
        pattern: 'http',
        port: 9000,
        channels: ['telegram'],
        healthPath: '/healthz',
        pullPolicy: 'Always',
      });
      expect(mockRegisterTool).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 9000,
          channels: ['telegram'],
          healthPath: '/healthz',
          pullPolicy: 'Always',
        }),
        expect.any(Function),
      );
    });

    it('passes requestMapping through to registerTool', async () => {
      const mapping = {
        method: 'GET',
        path: '/weather/{city}',
        responsePath: 'temp',
      };
      mockRegisterTool.mockReturnValue({ ok: true });
      await executeTool('register_tool', {
        name: 'weather',
        description: 'Weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
        image: 'ghcr.io/example/weather:1',
        pattern: 'http',
        requestMapping: mapping,
      });
      expect(mockRegisterTool).toHaveBeenCalledWith(
        expect.objectContaining({ requestMapping: mapping }),
        expect.any(Function),
      );
    });
  });

  // ── edit_tool ──────────────────────────────────────────────────────────────

  describe('edit_tool', () => {
    it('calls editTool with name and patch', async () => {
      mockEditTool.mockReturnValue({ ok: true });
      const result = await executeTool('edit_tool', {
        name: 'weather',
        image: 'ghcr.io/example/weather:2',
      });
      expect(mockEditTool).toHaveBeenCalledWith(
        {
          name: 'weather',
          patch: expect.objectContaining({
            image: 'ghcr.io/example/weather:2',
          }),
        },
        expect.any(Function),
      );
      expect(result).toContain('weather');
      expect(result).toContain('Changes are live');
    });

    it('returns error when tool does not exist', async () => {
      mockEditTool.mockReturnValue({
        ok: false,
        error: 'no override registered: weather',
      });
      const result = await executeTool('edit_tool', {
        name: 'weather',
        image: 'new:1',
      });
      expect(result).toContain('Error');
      expect(result).toContain('no override registered');
    });

    it('returns error when name is missing', async () => {
      const result = await executeTool('edit_tool', {});
      expect(result).toContain('Error');
      expect(mockEditTool).not.toHaveBeenCalled();
    });

    it('patch does not contain name', async () => {
      mockEditTool.mockReturnValue({ ok: true });
      await executeTool('edit_tool', {
        name: 'weather',
        image: 'ghcr.io/example/weather:3',
      });
      const call = mockEditTool.mock.calls[0][0];
      expect(call.patch).toHaveProperty('image', 'ghcr.io/example/weather:3');
      expect(call.patch).not.toHaveProperty('name');
    });
  });

  // ── remove_tool ────────────────────────────────────────────────────────────

  describe('remove_tool', () => {
    it('calls removeTool and returns confirmation', async () => {
      mockRemoveTool.mockReturnValue({ ok: true });
      const result = await executeTool('remove_tool', { name: 'weather' });
      expect(mockRemoveTool).toHaveBeenCalledWith(
        { name: 'weather' },
        expect.any(Function),
      );
      expect(result).toContain('weather');
      expect(result).toContain('Changes are live');
    });

    it('returns error when tool does not exist', async () => {
      mockRemoveTool.mockReturnValue({
        ok: false,
        error: 'no such override: weather',
      });
      const result = await executeTool('remove_tool', { name: 'weather' });
      expect(result).toContain('Error');
      expect(result).toContain('no such override');
    });

    it('returns error when name is missing', async () => {
      const result = await executeTool('remove_tool', {});
      expect(result).toContain('Error');
      expect(mockRemoveTool).not.toHaveBeenCalled();
    });
  });

  // ── list_tools ─────────────────────────────────────────────────────────────

  describe('list_tools', () => {
    it('returns empty message when no overrides', async () => {
      mockListToolOverrides.mockReturnValue([]);
      const result = await executeTool('list_tools', {});
      expect(result).toContain('No tool overrides registered');
    });

    it('returns formatted list when overrides present', async () => {
      mockListToolOverrides.mockReturnValue([
        {
          name: 'weather',
          description: 'Get weather data',
          parameters: {},
          image: 'ghcr.io/example/weather:1',
          pattern: 'http',
          channels: ['telegram'],
        },
      ]);
      const result = await executeTool('list_tools', {});
      expect(result).toContain('Name: weather');
      expect(result).toContain('ghcr.io/example/weather:1');
      expect(result).toContain('telegram');
    });

    it('shows "all" for a tool with no channels field', async () => {
      mockListToolOverrides.mockReturnValue([
        {
          name: 'calc',
          description: 'Calculator',
          parameters: {},
          image: 'ghcr.io/example/calc:1',
          pattern: 'http',
        },
      ]);
      const result = await executeTool('list_tools', {});
      expect(result).toContain('Name: calc');
      expect(result).toContain('all');
    });
  });

  // ── upgrade_channel tool (Story 181) ─────────────────────────────────────────
  describe('upgrade_channel', () => {
    it('returns error if instance_name is missing', async () => {
      const result = await executeTool('upgrade_channel', {
        target_manifest_hash: 'abc123',
      });
      expect(result).toMatch(
        /instance_name.*required|required.*instance_name/i,
      );
    });

    it('returns error if target_manifest_hash is missing', async () => {
      const result = await executeTool('upgrade_channel', {
        instance_name: 'my-telegram',
      });
      expect(result).toMatch(
        /target_manifest_hash.*required|required.*target_manifest_hash/i,
      );
    });

    it('returns error for invalid instance_name (uppercase)', async () => {
      const result = await executeTool('upgrade_channel', {
        instance_name: 'My-Telegram',
        target_manifest_hash: 'abc123',
      });
      expect(result).toMatch(/lowercase|alphanumeric/i);
    });
  });

  describe('reply_to_bootstrap', () => {
    let publishSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      activeBootstraps.clear();
      (pendingBootstrapQuestionByJob as Map<string, unknown>).clear();
      publishSpy = vi.fn().mockResolvedValue(1);
      (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue({
        publish: publishSpy,
      });
    });

    it('publishes the reply to the bootstrap-admin channel for an active bootstrap', async () => {
      activeBootstraps.set('my-echo', 'job-uuid-123');
      const result = await executeTool('reply_to_bootstrap', {
        instance_name: 'my-echo',
        message: 'Use port 8080.',
      });
      expect(publishSpy).toHaveBeenCalledWith(
        'kubeclaw:bootstrap-admin:job-uuid-123',
        JSON.stringify({ text: 'Use port 8080.' }),
      );
      expect(result).toMatch(/forwarded.*my-echo/i);
    });

    it('clears the pending question after forwarding the reply', async () => {
      activeBootstraps.set('my-echo', 'job-uuid-123');
      pendingBootstrapQuestionByJob.set('job-uuid-123', {
        text: 'Which port?',
        ts: '2026-01-01T00:00:00.000Z',
      });
      await executeTool('reply_to_bootstrap', {
        instance_name: 'my-echo',
        message: 'Use port 8080.',
      });
      expect(pendingBootstrapQuestionByJob.has('job-uuid-123')).toBe(false);
    });

    it('resolves the upgrade-keyed bootstrap when no plain instance entry exists', async () => {
      activeBootstraps.set('my-echo:upgrade', 'job-upgrade-456');
      const result = await executeTool('reply_to_bootstrap', {
        instance_name: 'my-echo',
        message: 'token-xyz',
      });
      expect(publishSpy).toHaveBeenCalledWith(
        'kubeclaw:bootstrap-admin:job-upgrade-456',
        JSON.stringify({ text: 'token-xyz' }),
      );
      expect(result).toMatch(/forwarded/i);
    });

    it('returns an error when no active bootstrap matches the instance', async () => {
      const result = await executeTool('reply_to_bootstrap', {
        instance_name: 'unknown',
        message: 'hello',
      });
      expect(publishSpy).not.toHaveBeenCalled();
      expect(result).toMatch(/no active bootstrap/i);
    });

    it('returns an error when instance_name or message is missing', async () => {
      const r1 = await executeTool('reply_to_bootstrap', {
        message: 'hi',
      });
      const r2 = await executeTool('reply_to_bootstrap', {
        instance_name: 'my-echo',
      });
      expect(r1).toMatch(/required/i);
      expect(r2).toMatch(/required/i);
    });
  });
});

describe('buildPendingBootstrapNote', () => {
  beforeEach(() => {
    activeBootstraps.clear();
    (pendingBootstrapQuestionByJob as Map<string, unknown>).clear();
  });

  it('returns null when no bootstrap has a pending question', () => {
    activeBootstraps.set('my-echo', 'job-1');
    expect(buildPendingBootstrapNote()).toBeNull();
  });

  it('lists the pending question with its instance name', () => {
    activeBootstraps.set('my-echo', 'job-1');
    pendingBootstrapQuestionByJob.set('job-1', {
      text: 'Which TCP port should the channel listen on?',
      ts: '2026-01-01T00:00:00.000Z',
    });
    const note = buildPendingBootstrapNote();
    expect(note).toContain('reply_to_bootstrap');
    expect(note).toContain('"my-echo"');
    expect(note).toContain('Which TCP port should the channel listen on?');
  });

  it('strips the :upgrade suffix from upgrade-keyed bootstraps', () => {
    activeBootstraps.set('my-echo:upgrade', 'job-up');
    pendingBootstrapQuestionByJob.set('job-up', {
      text: 'API token?',
      ts: '2026-01-01T00:00:00.000Z',
    });
    const note = buildPendingBootstrapNote();
    expect(note).toContain('"my-echo"');
    expect(note).not.toContain(':upgrade');
  });

  it('omits active bootstraps that have no pending question', () => {
    activeBootstraps.set('waiting', 'job-w');
    activeBootstraps.set('quiet', 'job-q');
    pendingBootstrapQuestionByJob.set('job-w', {
      text: 'Port?',
      ts: '2026-01-01T00:00:00.000Z',
    });
    const note = buildPendingBootstrapNote();
    expect(note).toContain('"waiting"');
    expect(note).not.toContain('"quiet"');
  });
});

// ── broadcastBootstrapSse ────────────────────────────────────────────────────

describe('broadcastBootstrapSse', () => {
  it('writes a correctly-formatted SSE data line to each live client', () => {
    const writes: string[] = [];
    const liveClient = {
      res: { writableEnded: false, write: (data: string) => { writes.push(data); } },
    };
    const writes2: string[] = [];
    const liveClient2 = {
      res: { writableEnded: false, write: (data: string) => { writes2.push(data); } },
    };

    broadcastBootstrapSse([liveClient, liveClient2], 'bootstrap', 'Job timed out');

    // Both clients should receive exactly one write call.
    expect(writes).toHaveLength(1);
    expect(writes2).toHaveLength(1);

    // The SSE line must end with \n\n and each data: line must be a valid JSON object.
    const line = writes[0];
    expect(line.endsWith('\n\n')).toBe(true);
    // Strip trailing \n\n and split by \n to get individual data: lines.
    const dataLines = line.slice(0, -2).split('\n');
    expect(dataLines.length).toBeGreaterThanOrEqual(1);
    for (const dl of dataLines) {
      expect(dl.startsWith('data: ')).toBe(true);
    }
    // Re-assemble the JSON body (handle multi-line payloads).
    const jsonStr = dataLines.map((dl) => dl.slice('data: '.length)).join('\n');
    const parsed = JSON.parse(jsonStr) as { type: string; text: string };
    expect(parsed.type).toBe('bootstrap');
    expect(parsed.text).toBe('Job timed out');
  });

  it('skips clients whose response is already ended (writableEnded=true) and removes them from the array', () => {
    const writes: string[] = [];
    const deadClient = {
      res: { writableEnded: true, write: (data: string) => { writes.push(data); } },
    };
    const liveWrites: string[] = [];
    const liveClient = {
      res: { writableEnded: false, write: (data: string) => { liveWrites.push(data); } },
    };

    const clients = [deadClient, liveClient];
    broadcastBootstrapSse(clients, 'bootstrap', 'step done');

    expect(writes).toHaveLength(0); // dead client — skipped, not written to
    expect(liveWrites).toHaveLength(1); // live client — written
    // Dead client must be pruned from the array in place.
    expect(clients).toHaveLength(1);
    expect(clients[0]).toBe(liveClient);
  });

  it('removes clients whose write() throws from the array', () => {
    const throwingClient = {
      res: {
        writableEnded: false,
        write: (_data: string) => { throw new Error('EPIPE'); },
      },
    };
    const liveWrites: string[] = [];
    const liveClient = {
      res: { writableEnded: false, write: (data: string) => { liveWrites.push(data); } },
    };

    const clients = [throwingClient, liveClient];
    broadcastBootstrapSse(clients, 'bootstrap', 'step done');

    // Throwing client must be pruned; live client still receives the event.
    expect(clients).toHaveLength(1);
    expect(clients[0]).toBe(liveClient);
    expect(liveWrites).toHaveLength(1);
  });
});

// ── bootstrap_channel_from_skill timeout_seconds handling ────────────────────

describe('bootstrap_channel_from_skill timeout_seconds handling', () => {
  beforeEach(() => {
    vi.mocked(mockBootstrapChannelFromSkill).mockResolvedValue({ bootstrapJobId: 'test-job-id' });
    delete process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS;
  });

  it('uses timeout_seconds when provided and passes it to both job creation and orchestrator poll', async () => {
    await executeTool('bootstrap_channel_from_skill', {
      skill_name: 'bootstrap-telegram',
      channel_type: 'telegram',
      instance_name: 'test-timeout-inv',
      timeout_seconds: 25,
    });
    expect(vi.mocked(mockBootstrapChannelFromSkill)).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 25 }),
    );
    expect(vi.mocked(mockWaitForBootstrapJobCompletion)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ bootstrapTimeoutSeconds: 25 }),
    );
  });

  it('falls back to BOOTSTRAP_SKILL_TIMEOUT_SECONDS env when timeout_seconds not provided', async () => {
    process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS = '300';
    await executeTool('bootstrap_channel_from_skill', {
      skill_name: 'bootstrap-telegram',
      channel_type: 'telegram',
      instance_name: 'test-timeout-env',
    });
    expect(vi.mocked(mockBootstrapChannelFromSkill)).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 300 }),
    );
    expect(vi.mocked(mockWaitForBootstrapJobCompletion)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ bootstrapTimeoutSeconds: 300 }),
    );
    delete process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS;
  });

  it('falls back to 900 when neither timeout_seconds nor env is set', async () => {
    await executeTool('bootstrap_channel_from_skill', {
      skill_name: 'bootstrap-telegram',
      channel_type: 'telegram',
      instance_name: 'test-timeout-def',
    });
    expect(vi.mocked(mockBootstrapChannelFromSkill)).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 900 }),
    );
    expect(vi.mocked(mockWaitForBootstrapJobCompletion)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ bootstrapTimeoutSeconds: 900 }),
    );
  });

  it('falls back to env default when timeout_seconds is out of range (too low)', async () => {
    process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS = '120';
    await executeTool('bootstrap_channel_from_skill', {
      skill_name: 'bootstrap-telegram',
      channel_type: 'telegram',
      instance_name: 'test-timeout-low',
      timeout_seconds: 5, // below 10, invalid
    });
    expect(vi.mocked(mockBootstrapChannelFromSkill)).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 120 }),
    );
    delete process.env.BOOTSTRAP_SKILL_TIMEOUT_SECONDS;
  });

  it('falls back to env default when timeout_seconds is out of range (too high)', async () => {
    await executeTool('bootstrap_channel_from_skill', {
      skill_name: 'bootstrap-telegram',
      channel_type: 'telegram',
      instance_name: 'test-timeout-high',
      timeout_seconds: 9999, // above 3600, invalid
    });
    expect(vi.mocked(mockBootstrapChannelFromSkill)).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 900 }),
    );
  });
});
