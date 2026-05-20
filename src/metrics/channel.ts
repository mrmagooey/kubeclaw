import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export interface ChannelMetrics {
  recordMessage(labels: { channelKind: string; group: string }): void;
  recordLlmCall(labels: {
    provider: string;
    model: string;
    success: boolean;
    durationMs: number;
  }): void;
  recordTokens(labels: {
    provider: string;
    model: string;
    direction: 'input' | 'output';
    count: number;
  }): void;
  recordToolCall(labels: { tool: string; status: 'success' | 'failure' }): void;
  recordSkillLoad(labels: { group: string }): void;
  setConversationHistorySize(labels: { group: string }, size: number): void;
}

export function createChannelMetrics(registry: Registry): ChannelMetrics {
  const messagesReceived = new Counter({
    name: 'kubeclaw_channel_messages_received_total',
    help: 'Total inbound messages processed by this channel pod',
    labelNames: ['channel_kind', 'group'] as const,
    registers: [registry],
  });

  const llmCallDuration = new Histogram({
    name: 'kubeclaw_channel_llm_call_duration_seconds',
    help: 'LLM call round-trip latency including streaming',
    labelNames: ['provider', 'model', 'success'] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
    registers: [registry],
  });

  const tokensTotal = new Counter({
    name: 'kubeclaw_channel_tokens_total',
    help: 'Total tokens exchanged with the LLM provider',
    labelNames: ['provider', 'model', 'direction'] as const,
    registers: [registry],
  });

  const toolCallsTotal = new Counter({
    name: 'kubeclaw_channel_tool_calls_total',
    help: 'Total tool invocations by the channel LLM during conversations',
    labelNames: ['tool', 'status'] as const,
    registers: [registry],
  });

  const skillLoadsTotal = new Counter({
    name: 'kubeclaw_channel_skill_loads_total',
    help: 'Total skill injections into the system prompt',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  const conversationHistorySize = new Gauge({
    name: 'kubeclaw_channel_conversation_history_size',
    help: 'Number of messages in the in-memory conversation history per group',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  return {
    recordMessage({ channelKind, group }) {
      messagesReceived.inc({ channel_kind: channelKind, group });
    },
    recordLlmCall({ provider, model, success, durationMs }) {
      llmCallDuration.observe(
        { provider, model, success: String(success) },
        durationMs / 1000,
      );
    },
    recordTokens({ provider, model, direction, count }) {
      tokensTotal.inc({ provider, model, direction }, count);
    },
    recordToolCall({ tool, status }) {
      toolCallsTotal.inc({ tool, status });
    },
    recordSkillLoad({ group }) {
      skillLoadsTotal.inc({ group });
    },
    setConversationHistorySize({ group }, size) {
      conversationHistorySize.set({ group }, size);
    },
  };
}
