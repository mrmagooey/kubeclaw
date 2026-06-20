/**
 * Channel SDK — the curated, stable surface the single generic image exposes to
 * runtime-delivered channel adapters. The host (channel-runner) injects an
 * instance of ChannelSdk into an adapter's default-exported register(sdk)
 * function; the adapter calls sdk.registerChannel(...) exactly as a compiled-in
 * channel does. Adapters depend ONLY on this surface from the image; everything
 * else is their own npm dependency.
 */
import { registerChannel } from '../channels/registry.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import {
  buildDataFacade,
  type DataFacadeConfig,
  type DataFacadeHistory,
  type DataFacadeTasks,
  type DataFacadeJobs,
  type DataFacadeAudit,
  type DataFacadeSkills,
  type DiagSnapshot,
  // row types re-exported for adapters
  type ConversationHistoryPageRow,
  type ConversationHistoryRow,
  type ConversationExportRow,
  type SearchResult,
  type SearchConversationsArgs,
  type AuditEntry,
  type TaskRunLogRow,
  type ToolJobRecord,
  type Candidate,
  type SkillFile,
  type NewMessage,
  type ScheduledTask,
} from './data-facade.js';

export interface ChannelSdk {
  registerChannel: typeof registerChannel;
  logger: typeof logger;
  readEnvFile: typeof readEnvFile;
  assistantName: string;
  groupsDir: string;
  // data facade
  config: DataFacadeConfig;
  history: DataFacadeHistory;
  tasks: DataFacadeTasks;
  jobs: DataFacadeJobs;
  audit: DataFacadeAudit;
  diag(groupFolder: string): DiagSnapshot;
  skills: DataFacadeSkills;
}

/** Signature an adapter module must default-export. */
export type RuntimeAdapterRegister = (sdk: ChannelSdk) => void;

export type {
  DataFacadeConfig,
  DataFacadeHistory,
  DataFacadeTasks,
  DataFacadeJobs,
  DataFacadeAudit,
  DataFacadeSkills,
  DiagSnapshot,
  ConversationHistoryPageRow,
  ConversationHistoryRow,
  ConversationExportRow,
  SearchResult,
  SearchConversationsArgs,
  AuditEntry,
  TaskRunLogRow,
  ToolJobRecord,
  Candidate,
  SkillFile,
  NewMessage,
  ScheduledTask,
};

export function buildChannelSdk(): ChannelSdk {
  return {
    registerChannel,
    logger,
    readEnvFile,
    assistantName: ASSISTANT_NAME,
    groupsDir: GROUPS_DIR,
    ...buildDataFacade(),
  };
}
