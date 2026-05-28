/**
 * Unit tests for set-reminder LocalTool.
 * Stubs scheduleTaskDirect via vi.mock so no Redis is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- hoisted mock state ----
const mockScheduleTaskDirect = vi.hoisted(() => vi.fn());

vi.mock('../direct-llm-runner.js', async (importOriginal) => {
  // We only need the scheduleTaskDirect export; pull everything else through.
  const original = await importOriginal<typeof import('../direct-llm-runner.js')>();
  return { ...original, scheduleTaskDirect: mockScheduleTaskDirect };
});

import { makeSetReminderTool } from './set-reminder.js';
import type { ContainerInput } from '../types.js';

const fakeInput: ContainerInput = {
  prompt: 'user message',
  groupFolder: 'test-group',
  chatJid: 'user@test',
  isMain: false,
  assistantName: 'Bot',
};

describe('set_reminder tool', () => {
  beforeEach(() => {
    mockScheduleTaskDirect.mockReset();
    mockScheduleTaskDirect.mockResolvedValue('Scheduled task "task-123".');
  });

  it('has the correct tool name and required parameters', () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    expect(tool.def.function.name).toBe('set_reminder');
    const params = tool.def.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.required).toContain('reminder_text');
    expect(params.required).toContain('when_iso');
  });

  it('returns an error and does NOT call scheduleTaskDirect when when_iso is not a valid date', async () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    const result = await tool.handler(
      { reminder_text: 'take vitamins', when_iso: 'in 3 days' },
      fakeInput,
    );
    expect(result).toMatch(/invalid.*datetime/i);
    expect(mockScheduleTaskDirect).not.toHaveBeenCalled();
  });

  it('returns an error for an empty when_iso string', async () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    const result = await tool.handler(
      { reminder_text: 'call dentist', when_iso: '' },
      fakeInput,
    );
    expect(result).toMatch(/invalid.*datetime/i);
    expect(mockScheduleTaskDirect).not.toHaveBeenCalled();
  });

  it('calls scheduleTaskDirect with a verbatim-delivery prompt for a valid ISO datetime', async () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    const isoTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await tool.handler(
      { reminder_text: 'take vitamins', when_iso: isoTime },
      fakeInput,
    );
    expect(mockScheduleTaskDirect).toHaveBeenCalledOnce();
    const [groupFolder, chatJid, isMain, args] =
      mockScheduleTaskDirect.mock.calls[0];
    expect(groupFolder).toBe('test-group');
    expect(chatJid).toBe('user@test');
    expect(isMain).toBe(false);
    expect((args as Record<string, unknown>).prompt).toMatch(
      /deliver this reminder message to the user verbatim.*take vitamins/i,
    );
    expect((args as Record<string, unknown>).schedule_type).toBe('once');
    expect((args as Record<string, unknown>).schedule_value).toBe(isoTime);
  });

  it('returns a confirmation that includes a human-readable time', async () => {
    const tool = makeSetReminderTool(mockScheduleTaskDirect);
    const isoTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await tool.handler(
      { reminder_text: 'take vitamins', when_iso: isoTime },
      fakeInput,
    );
    // Confirmation should include the reminder_text and a recognisable date string
    expect(result).toMatch(/take vitamins/);
    // toLocaleString() contains digits — check for a year like 202x or 203x
    expect(result).toMatch(/20[23]\d/);
  });
});
