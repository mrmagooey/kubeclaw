/**
 * set_reminder — convenience LocalTool that wraps schedule_task for
 * natural-language reminder requests.
 *
 * The LLM must supply an absolute ISO-8601 datetime in `when_iso`.
 * The handler validates it, builds a verbatim-delivery prompt, and
 * forwards to scheduleTaskDirect via the Redis IPC path.
 */
import type OpenAI from 'openai';
import type { ContainerInput } from '../types.js';

/** Minimal signature of scheduleTaskDirect used by this tool. */
export type ScheduleTaskFn = (
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
  args: Record<string, unknown>,
) => Promise<string>;

export interface LocalTool {
  def: OpenAI.ChatCompletionTool;
  handler: (
    args: Record<string, unknown>,
    input: ContainerInput,
  ) => Promise<string>;
}

/**
 * Factory — accepts `scheduleTaskFn` so unit tests can inject a stub
 * without going through the module graph.
 */
export function makeSetReminderTool(
  scheduleTaskFn: ScheduleTaskFn,
): LocalTool {
  return {
    def: {
      type: 'function',
      function: {
        name: 'set_reminder',
        description:
          'Set a one-time reminder for the user. Use this (preferred over schedule_task) whenever ' +
          'the user asks to be reminded about something. `when_iso` MUST be an absolute ISO 8601 ' +
          'datetime string (e.g. "2026-06-01T09:00:00Z"). Resolve any relative expression like ' +
          '"in 3 days" or "tomorrow at 9am" to a concrete datetime before calling this tool.',
        parameters: {
          type: 'object',
          properties: {
            reminder_text: {
              type: 'string',
              description:
                'The reminder message to deliver to the user verbatim when the time arrives.',
            },
            when_iso: {
              type: 'string',
              description:
                'Absolute ISO 8601 datetime for the reminder (e.g. "2026-06-01T09:00:00Z"). ' +
                'Never pass relative phrases like "in 3 days" here.',
            },
          },
          required: ['reminder_text', 'when_iso'],
        },
      },
    },

    async handler(
      args: Record<string, unknown>,
      input: ContainerInput,
    ): Promise<string> {
      const reminderText = String(args.reminder_text ?? '');
      const whenIso = String(args.when_iso ?? '');

      // Validate: must parse to a real Date
      const dt = new Date(whenIso);
      if (!whenIso || isNaN(dt.getTime())) {
        return (
          `Invalid datetime: "${whenIso}". ` +
          'Please provide an absolute ISO 8601 datetime string (e.g. "2026-06-01T09:00:00Z"). ' +
          'Resolve relative expressions like "in 3 days" to a concrete datetime first.'
        );
      }

      const prompt =
        `Deliver this reminder message to the user verbatim: ${reminderText}`;

      const scheduleResult = await scheduleTaskFn(
        input.groupFolder,
        input.chatJid,
        input.isMain,
        {
          prompt,
          schedule_type: 'once',
          schedule_value: whenIso,
        },
      );

      const humanTime = dt.toLocaleString();
      return `Reminder set for ${humanTime}: "${reminderText}". ${scheduleResult}`;
    },
  };
}
