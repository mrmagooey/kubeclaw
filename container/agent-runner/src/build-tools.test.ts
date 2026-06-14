import { describe, it, expect } from 'vitest';
import { buildToolDefinitions } from './index.js';
import type { CatalogTool } from './tool-catalog.js';

const catalog: CatalogTool[] = [
  {
    name: 'bash',
    description: 'run',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  },
  {
    name: 'web_search',
    description: 'search',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
];

function build(opts: { isSuperuser?: boolean; isMain?: boolean } = {}) {
  return buildToolDefinitions({
    isSuperuser: opts.isSuperuser ?? false,
    isMain: opts.isMain ?? false,
    redis: {} as any,
    agentJobId: 'job-1',
    groupFolder: 'g1',
    chatJid: 'c1',
    channel: '',
    catalogTools: catalog,
    spawnedTools: new Set<string>(),
  });
}

describe('buildToolDefinitions', () => {
  it('exposes catalog tools by name', () => {
    const names = build().map((t) => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('web_search');
  });
  it('no longer exposes the old hardcoded routed tools', () => {
    const names = build().map((t) => t.name);
    for (const gone of [
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'web_fetch',
      'agent_browser',
    ]) {
      expect(names).not.toContain(gone);
    }
  });
  it('keeps the IPC tools', () => {
    const names = build().map((t) => t.name);
    for (const kept of [
      'send_message',
      'schedule_task',
      'list_tasks',
      'pause_task',
      'resume_task',
      'cancel_task',
      'update_task',
    ]) {
      expect(names).toContain(kept);
    }
  });
  it('adds main-only and superuser tools when flagged', () => {
    const mainNames = build({ isMain: true }).map((t) => t.name);
    expect(mainNames).toContain('register_group');
    expect(mainNames).toContain('deploy_channel');
    const suNames = build({ isSuperuser: true }).map((t) => t.name);
    expect(suNames).toContain('local_bash');
  });
  it('catalog tool parameters pass through as JSON Schema', () => {
    const bash = build().find((t) => t.name === 'bash')!;
    expect(bash.parameters).toMatchObject({ type: 'object' });
  });
});
