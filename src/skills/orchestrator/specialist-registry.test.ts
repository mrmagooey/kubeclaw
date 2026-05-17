import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSpecialist,
  editSpecialist,
  removeSpecialist,
  listSpecialistOverrides,
} from './specialist-registry.js';
import { _initTestDatabase, __resetDbForTest } from '../../db.js';

describe('specialist-registry', () => {
  beforeEach(async () => {
    await _initTestDatabase();
    __resetDbForTest();
  });

  it('register inserts a valid override', () => {
    const r = registerSpecialist({ name: 'A', prompt: 'p' });
    expect(r.ok).toBe(true);
    expect(listSpecialistOverrides()).toHaveLength(1);
  });

  it('register rejects invalid name', () => {
    const r = registerSpecialist({ name: '1bad', prompt: 'p' });
    expect(r.ok).toBe(false);
  });

  it('register fails on duplicate name', () => {
    registerSpecialist({ name: 'A', prompt: 'p' });
    const r = registerSpecialist({ name: 'A', prompt: 'q' });
    expect(r.ok).toBe(false);
  });

  it('edit updates fields, fails if name missing', () => {
    registerSpecialist({ name: 'A', prompt: 'p' });
    const ok = editSpecialist({ name: 'A', patch: { prompt: 'new' } });
    expect(ok.ok).toBe(true);
    const missing = editSpecialist({ name: 'Z', patch: { prompt: 'x' } });
    expect(missing.ok).toBe(false);
    expect(listSpecialistOverrides()[0].prompt).toBe('new');
  });

  it('remove deletes the row', () => {
    registerSpecialist({ name: 'A', prompt: 'p' });
    removeSpecialist({ name: 'A' });
    expect(listSpecialistOverrides()).toHaveLength(0);
  });

  it('remove returns ok:false if specialist not found', () => {
    const r = removeSpecialist({ name: 'NonExistent' });
    expect(r.ok).toBe(false);
  });

  it('listSpecialistOverrides returns all specialists ordered by name', () => {
    registerSpecialist({ name: 'B', prompt: 'b' });
    registerSpecialist({ name: 'A', prompt: 'a' });
    const list = listSpecialistOverrides();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('A');
    expect(list[1].name).toBe('B');
  });

  it('edit validates the merged result', () => {
    registerSpecialist({ name: 'A', prompt: 'p' });
    // Patching with invalid prompt should fail validation
    const r = editSpecialist({ name: 'A', patch: { prompt: '' } });
    expect(r.ok).toBe(false);
  });

  it('register preserves all optional fields', () => {
    const spec = {
      name: 'Research',
      prompt: 'do research',
      triggers: ['Researcher'],
      llmProvider: 'claude',
      memory: { isolated: true },
      claudemd: 'extra context',
      tools: ['mcp:fetch'],
    };
    registerSpecialist(spec);
    const list = listSpecialistOverrides();
    expect(list[0]).toMatchObject(spec);
  });
});
