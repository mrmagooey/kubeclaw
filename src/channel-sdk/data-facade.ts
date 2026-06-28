/**
 * data-facade.ts — typed facade that maps the Channel SDK's grouped surface
 * (history / tasks / jobs / audit / diag / skills / config) to the real
 * host singletons (db functions, skill-store, config constants).
 *
 * Adapters call sdk.history.getPage(...) etc.; they never import from db.ts.
 */
import {
  // history
  getConversationHistoryPage,
  getAllConversationHistory,
  getMessageById,
  searchConversations,
  getOutboundMessagesSince,
  appendConversationMessage,
  updateConversationMessage,
  deleteMessageById,
  deleteConversationHistoryBefore,
  clearConversationHistory,
  storeMessageDirect,
  getDiagSnapshot,
  // tasks
  createTask,
  getTasksForGroup,
  getTaskById,
  deleteTaskForGroup,
  pauseTask,
  resumeTask,
  getTaskRunLogs,
  // jobs
  getActiveToolJobs,
  getRecentToolJobsForGroup,
  getToolJobByIdForGroup,
  insertToolJobForDebug,
  // audit
  writeAuditEntry,
  getAuditEntries,
  // types (re-exported via index.ts)
  type ConversationHistoryPageRow,
  type ConversationHistoryRow,
  type ConversationExportRow,
  type SearchResult,
  type SearchConversationsArgs,
  type DiagSnapshot,
  type AuditEntry,
  type TaskRunLogRow,
  type ToolJobRecord,
  db,
} from '../db.js';
import {
  listAcceptedSkills,
  listCandidates,
  listArchived,
  acceptCandidate,
  rejectCandidate,
  type Candidate,
} from '../runtime/skill-store.js';
import type { SkillFile } from '../runtime/skill-format.js';
import type { NewMessage, ScheduledTask } from '../types.js';
import {
  TIMEZONE,
  RATE_LIMIT_WINDOW_MS,
  STORE_DIR,
  TOOL_JOBS_RETENTION_DAYS,
  DEBUG_ENDPOINTS_ENABLED,
  GROUPS_DIR,
} from '../config.js';
import { DEFAULT_DIRECT_MODEL } from '../runtime/llm-client.js';

// Re-export row types so adapters can import them from the SDK module.
export type {
  ConversationHistoryPageRow,
  ConversationHistoryRow,
  ConversationExportRow,
  SearchResult,
  SearchConversationsArgs,
  DiagSnapshot,
  AuditEntry,
  TaskRunLogRow,
  ToolJobRecord,
  Candidate,
  SkillFile,
  NewMessage,
  ScheduledTask,
};

export interface DataFacadeConfig {
  timezone: string;
  rateLimitWindowMs: number;
  storeDir: string;
  toolJobsRetentionDays: number;
  defaultModel: string;
  debugEndpointsEnabled: boolean;
}

export interface DataFacadeHistory {
  getPage(
    groupFolder: string,
    opts?: { limit?: number; before?: string },
  ): ConversationHistoryPageRow[];
  getAll(groupFolder: string, username: string): ConversationExportRow[];
  getById(id: string, groupFolder: string): ConversationHistoryRow | null;
  search(args: SearchConversationsArgs): SearchResult[];
  getOutboundSince(
    chatJid: string,
    sinceTimestamp: string,
    limit?: number,
  ): Pick<NewMessage, 'id' | 'content' | 'timestamp'>[];
  append(
    groupFolder: string,
    role: 'user' | 'assistant',
    content: string,
  ): void;
  update(id: string, content: string, groupFolder: string): boolean;
  deleteById(id: string, groupFolder: string): boolean;
  deleteBefore(groupFolder: string, before: Date): number;
  clear(groupFolder: string): void;
  storeOutbound(msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
  }): void;
  groupFolderForMessage(id: string): string | null;
}

export interface DataFacadeTasks {
  create(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void;
  getForGroup(groupFolder: string): ScheduledTask[];
  getById(id: string): ScheduledTask | undefined;
  deleteForGroup(id: string, groupFolder: string): boolean;
  pause(id: string, groupFolder: string): boolean;
  resume(id: string, groupFolder: string): boolean;
  getRunLogs(
    taskId: string,
    groupFolder: string,
    limit: number,
  ): TaskRunLogRow[];
}

export interface DataFacadeJobs {
  active(): ToolJobRecord[];
  recentForGroup(groupFolder: string, limit: number): ToolJobRecord[];
  byIdForGroup(jobId: string, groupFolder: string): ToolJobRecord | null;
  insertForDebug(args: {
    jobId: string;
    groupFolder: string;
    chatJid?: string;
    status: string;
    createdAt?: string;
    resolvedAt?: string | null;
  }): void;
}

export interface DataFacadeAudit {
  write(args: {
    groupFolder: string;
    actor: string;
    action: string;
    target?: string;
    detail?: string;
  }): void;
  entries(groupFolder: string, limit?: number): AuditEntry[];
}

export interface DataFacadeSkills {
  listAccepted(group: string): SkillFile[];
  listCandidates(group: string): Candidate[];
  listArchived(group: string): SkillFile[];
  accept(group: string, id: string): void;
  reject(group: string, id: string): void;
}

export interface DataFacade {
  config: DataFacadeConfig;
  history: DataFacadeHistory;
  tasks: DataFacadeTasks;
  jobs: DataFacadeJobs;
  audit: DataFacadeAudit;
  diag(groupFolder: string): DiagSnapshot;
  skills: DataFacadeSkills;
}

export function buildDataFacade(): DataFacade {
  return {
    config: {
      timezone: TIMEZONE,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
      storeDir: STORE_DIR,
      toolJobsRetentionDays: TOOL_JOBS_RETENTION_DAYS,
      defaultModel: DEFAULT_DIRECT_MODEL,
      debugEndpointsEnabled: DEBUG_ENDPOINTS_ENABLED,
    },

    history: {
      getPage: getConversationHistoryPage,
      getAll: getAllConversationHistory,
      getById: getMessageById,
      search: searchConversations,
      getOutboundSince: getOutboundMessagesSince,
      append: appendConversationMessage,
      update: updateConversationMessage,
      deleteById: deleteMessageById,
      deleteBefore: deleteConversationHistoryBefore,
      clear: clearConversationHistory,
      storeOutbound: storeMessageDirect,
      groupFolderForMessage(id: string): string | null {
        const r = db.exec(
          'SELECT group_folder FROM conversation_history WHERE id = ? LIMIT 1',
          [id],
        );
        if (r.length === 0 || r[0].values.length === 0) return null;
        return r[0].values[0][0] as string;
      },
    },

    tasks: {
      create: createTask,
      getForGroup: getTasksForGroup,
      getById: getTaskById,
      deleteForGroup: deleteTaskForGroup,
      pause: pauseTask,
      resume: resumeTask,
      getRunLogs: getTaskRunLogs,
    },

    jobs: {
      active: getActiveToolJobs,
      recentForGroup: getRecentToolJobsForGroup,
      byIdForGroup: getToolJobByIdForGroup,
      insertForDebug: insertToolJobForDebug,
    },

    audit: {
      write: writeAuditEntry,
      entries: getAuditEntries,
    },

    diag(groupFolder: string): DiagSnapshot {
      return getDiagSnapshot(groupFolder, STORE_DIR, GROUPS_DIR);
    },

    skills: {
      listAccepted: (group) => listAcceptedSkills(GROUPS_DIR, group),
      listCandidates: (group) => listCandidates(GROUPS_DIR, group),
      listArchived: (group) => listArchived(GROUPS_DIR, group),
      accept: (group, id) => acceptCandidate(GROUPS_DIR, group, id),
      reject: (group, id) => rejectCandidate(GROUPS_DIR, group, id),
    },
  };
}
