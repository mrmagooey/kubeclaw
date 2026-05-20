import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  KUBECLAW_CHANNEL,
  KUBECLAW_MODE,
  STORE_DIR,
} from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  LLMProvider,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  JobACL,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Optional metrics callback set by the orchestrator at startup.
 * Avoids importing prom-client into db.ts; the orchestrator passes a closure.
 * Signature: (operation: string, durationMs: number) => void
 */
let _onDbQuery: ((operation: string, durationMs: number) => void) | null = null;

/** Called once from src/index.ts after orchMetrics is initialised. */
export function setDbQueryCallback(
  cb: (operation: string, durationMs: number) => void,
): void {
  _onDbQuery = cb;
}

/** @internal - time a synchronous db operation and report via the callback. */
function timedDbOp<T>(operation: string, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    _onDbQuery?.(operation, Date.now() - start);
  }
}

/** @internal Test/integration use only — do not import from feature modules. Use the curated CRUD functions in this file or in src/capabilities/db.ts. */
export let db: SqlJsDatabase;
let dbPath: string;

function createSchema(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    )
  `);
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)`,
  );

  database.run(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    )
  `);
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run)`,
  );
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status)`,
  );

  database.run(`
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    )
  `);
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at)`,
  );

  database.run(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS job_acls (
      job_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT DEFAULT 'active'
    )
  `);
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_job_acls_group ON job_acls(group_folder)`,
  );
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_job_acls_expires ON job_acls(expires_at, status)`,
  );

  // Legacy mcp_servers table is dropped in the unified-capabilities migration.
  database.run(`DROP TABLE IF EXISTS mcp_servers`);

  database.run(`
    CREATE TABLE IF NOT EXISTS capabilities (
      name        TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      spec        TEXT NOT NULL,
      lifecycle   TEXT NOT NULL DEFAULT 'pending',
      last_probe_at TEXT,
      last_error  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_capabilities_kind ON capabilities(kind)`,
  );

  database.run(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id        TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      role      TEXT NOT NULL,
      content   TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_conversation_history_group
    ON conversation_history(group_folder, created_at)
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS specialist_overrides (
      name        TEXT PRIMARY KEY,
      spec_json   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS specialist_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder    TEXT NOT NULL,
      specialist_name TEXT NOT NULL,
      used_at         INTEGER NOT NULL,
      duration_ms     INTEGER,
      status          TEXT CHECK(status IN ('success','error'))
    )
  `);

  // Additive migration — safe to run repeatedly:
  try {
    database.run(
      `ALTER TABLE conversation_history ADD COLUMN session_key TEXT`,
    );
  } catch {
    /* column already exists */
  }
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_conv_session_key ON conversation_history (session_key, created_at)`,
  );

  database.run(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      loaded_at INTEGER NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_skill_usage_group_skill
    ON skill_usage(group_folder, skill_name)
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_skill_usage_loaded_at
    ON skill_usage(loaded_at)
  `);

  // FTS4 full-text index over conversation_history.content
  // sql.js WASM includes FTS4 but not FTS5 — do not change to fts5.
  // notindexed= keeps the stored columns out of the token index so only
  // the content column is tokenised.
  database.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_history_fts
    USING fts4(
      id          TEXT,
      group_folder TEXT,
      role        TEXT,
      content     TEXT,
      created_at  TEXT,
      notindexed=id,
      notindexed=group_folder,
      notindexed=role,
      notindexed=created_at
    )
  `);

  // AFTER INSERT: mirror the new row into FTS.
  database.run(`
    CREATE TRIGGER IF NOT EXISTS conv_fts_ai
    AFTER INSERT ON conversation_history
    BEGIN
      INSERT INTO conversation_history_fts(id, group_folder, role, content, created_at)
      VALUES (new.id, new.group_folder, new.role, new.content, new.created_at);
    END
  `);

  // AFTER DELETE: remove the FTS row by id.
  database.run(`
    CREATE TRIGGER IF NOT EXISTS conv_fts_ad
    AFTER DELETE ON conversation_history
    BEGIN
      DELETE FROM conversation_history_fts WHERE id = old.id;
    END
  `);

  // AFTER UPDATE OF content: replace the FTS row so the index stays current.
  database.run(`
    CREATE TRIGGER IF NOT EXISTS conv_fts_au
    AFTER UPDATE OF content ON conversation_history
    BEGIN
      DELETE FROM conversation_history_fts WHERE id = old.id;
      INSERT INTO conversation_history_fts(id, group_folder, role, content, created_at)
      VALUES (new.id, new.group_folder, new.role, new.content, new.created_at);
    END
  `);

  try {
    database.run(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.run(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.run(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.run(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.run(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
  } catch {
    /* columns already exist */
  }

  try {
    database.run(`ALTER TABLE registered_groups ADD COLUMN llm_provider TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.run(
      `ALTER TABLE conversation_history ADD COLUMN session_key TEXT`,
    );
  } catch {
    /* column already exists */
  }

  database.run(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      session_key TEXT,
      parent_summary_id TEXT,
      message_start_id TEXT,
      message_end_id TEXT,
      summary_text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      model_used TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE INDEX IF NOT EXISTS idx_conversation_summaries_group
    ON conversation_summaries(group_folder, created_at)
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS per_group_capability_instances (
      group_folder      TEXT NOT NULL,
      capability_name   TEXT NOT NULL,
      group_hash        TEXT NOT NULL,
      deployment_name   TEXT NOT NULL,
      service_name      TEXT NOT NULL,
      current_replicas  INTEGER NOT NULL DEFAULT 0,
      last_used_at      INTEGER,
      created_at        INTEGER NOT NULL,
      PRIMARY KEY (group_folder, capability_name)
    )
  `);
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_per_group_cap_hash ON per_group_capability_instances(group_hash)`,
  );

  database.run(`
    CREATE TABLE IF NOT EXISTS capability_tool_schemas (
      capability_name TEXT NOT NULL,
      image           TEXT NOT NULL,
      schemas_json    TEXT NOT NULL,
      scraped_at      INTEGER NOT NULL,
      PRIMARY KEY (capability_name, image)
    )
  `);

  // Tool job tracking table — used by orphan reconciliation on orchestrator restart.
  // Each row represents a K8s tool job that was spawned.
  // status: 'active' | 'completed' | 'interrupted' | 'timeout'
  // The chat_jid is stored so we can route the interruption notice back to the
  // correct channel SSE stream via the Redis pub/sub channel for the group.
  // message_id: the user-facing message ID from the POST /message response (Story 25).
  // specialist_name: display name of the specialist that was invoked (Story 50).
  database.run(`
    CREATE TABLE IF NOT EXISTS tool_jobs (
      job_id          TEXT PRIMARY KEY,
      group_folder    TEXT NOT NULL,
      chat_jid        TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL,
      resolved_at     TEXT,
      message_id      TEXT,
      specialist_name TEXT NOT NULL DEFAULT ''
    )
  `);
  // Additive migration: add message_id to existing databases.
  try {
    database.run(`ALTER TABLE tool_jobs ADD COLUMN message_id TEXT`);
  } catch {
    /* column already exists */
  }
  // Additive migration: add specialist_name to existing databases (Story 50).
  try {
    database.run(
      `ALTER TABLE tool_jobs ADD COLUMN specialist_name TEXT NOT NULL DEFAULT ''`,
    );
  } catch {
    /* column already exists */
  }
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_tool_jobs_status ON tool_jobs(status)`,
  );
  database.run(
    `CREATE INDEX IF NOT EXISTS idx_tool_jobs_group ON tool_jobs(group_folder)`,
  );
}

/**
 * One-shot migration: adds the `session_key` column to `conversation_history`
 * (if it doesn't exist) and backfills NULL values to match `group_folder`.
 * Safe to call multiple times — idempotent.
 */
export function runSessionKeyBackfill(): void {
  // The column is added via ALTER TABLE inside createSchema(), but on databases
  // that existed before the column was introduced the values will be NULL.
  // Backfill: set session_key = group_folder wherever it is still NULL.
  db.run(
    `UPDATE conversation_history SET session_key = group_folder WHERE session_key IS NULL`,
  );
}

/** @internal Test/integration use only. */
export function saveDatabase(): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

/**
 * One-shot backfill: copies existing conversation_history rows into the FTS
 * index. Safe to call multiple times — if the FTS table already has rows it
 * returns immediately. Uses a single bulk INSERT...SELECT; sql.js executes
 * synchronously so per-chunk OFFSET paging would only add overhead.
 */
export function backfillFts(): void {
  // Guard: skip if FTS already has content (covers re-runs on restart).
  const ftsCount = db.exec(`SELECT COUNT(*) FROM conversation_history_fts`);
  if (Number(ftsCount[0].values[0][0]) > 0) return;

  // Guard: skip if source table is empty (nothing to backfill).
  const srcCount = db.exec(`SELECT COUNT(*) FROM conversation_history`);
  if (Number(srcCount[0].values[0][0]) === 0) return;

  db.run(
    `INSERT OR IGNORE INTO conversation_history_fts (id, group_folder, role, content, created_at)
     SELECT id, group_folder, role, content, created_at FROM conversation_history`,
  );

  saveDatabase();
}

export async function initDatabase(): Promise<void> {
  const dbFile =
    KUBECLAW_MODE === 'channel' && KUBECLAW_CHANNEL
      ? `messages-${KUBECLAW_CHANNEL}.db`
      : 'messages.db';
  dbPath = path.join(STORE_DIR, dbFile);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const wasmPath = path.join(
    __dirname,
    '..',
    'node_modules',
    'sql.js',
    'dist',
    'sql-wasm.wasm',
  );
  const SQL = await initSqlJs({
    locateFile: () => wasmPath,
  });

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  createSchema(db);
  runSessionKeyBackfill();
  backfillFts();
  saveDatabase();
  migrateJsonState();
}

let SQL: initSqlJs.SqlJsStatic | null = null;

async function getSqlJs(): Promise<initSqlJs.SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

export async function _initTestDatabase(): Promise<void> {
  dbPath = '/tmp/kubeclaw-test.db';
  const SQL = await getSqlJs();
  db = new SQL.Database();
  createSchema(db);
}

/**
 * Test-only: clears every user table so each test starts clean.
 * @internal
 */
export function __resetDbForTest(): void {
  const tables = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
  );
  if (tables.length === 0) return;
  for (const row of tables[0].values) {
    const name = row[0] as string;
    db.run(`DELETE FROM ${name}`);
  }
  saveDatabase();
}

function backfillBotMessages(): void {
  const result = db.exec(
    `SELECT COUNT(*) as count FROM messages WHERE content LIKE '${ASSISTANT_NAME}:%' AND is_bot_message = 0`,
  );
  if (
    result.length > 0 &&
    result[0].values.length > 0 &&
    Number(result[0].values[0][0]) > 0
  ) {
    db.run(
      `UPDATE messages SET is_bot_message = 1 WHERE content LIKE '${ASSISTANT_NAME}:%'`,
    );
    saveDatabase();
  }
}

function backfillMainGroups(): void {
  const result = db.exec(
    `SELECT COUNT(*) as count FROM registered_groups WHERE folder = 'main' AND is_main IS NULL`,
  );
  if (
    result.length > 0 &&
    result[0].values.length > 0 &&
    Number(result[0].values[0][0]) > 0
  ) {
    db.run(`UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`);
    saveDatabase();
  }
}

function backfillChatChannels(): void {
  const result = db.exec(
    `SELECT COUNT(*) as count FROM chats WHERE channel IS NULL`,
  );
  if (
    result.length > 0 &&
    result[0].values.length > 0 &&
    Number(result[0].values[0][0]) > 0
  ) {
    db.run(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    db.run(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    db.run(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    db.run(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
    saveDatabase();
  }
}

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    db.run(
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         name = excluded.name,
         last_message_time = MAX(last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, channel),
         is_group = COALESCE(excluded.is_group, is_group)`,
      [chatJid, name, timestamp, ch, group],
    );
  } else {
    db.run(
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET
         last_message_time = MAX(last_message_time, excluded.last_message_time),
         channel = COALESCE(excluded.channel, channel),
         is_group = COALESCE(excluded.is_group, is_group)`,
      [chatJid, chatJid, timestamp, ch, group],
    );
  }
  saveDatabase();
}

export function updateChatName(chatJid: string, name: string): void {
  db.run(
    `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
    [chatJid, name, new Date().toISOString()],
  );
  saveDatabase();
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export function getAllChats(): ChatInfo[] {
  const result = db.exec(`
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `);
  if (result.length === 0) return [];

  return result[0].values.map((row: unknown[]) => ({
    jid: row[0] as string,
    name: row[1] as string,
    last_message_time: row[2] as string,
    channel: row[3] as string,
    is_group: row[4] as number,
  }));
}

export function getLastGroupSync(): string | null {
  const result = db.exec(
    `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0] as string;
}

export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
    [now],
  );
  saveDatabase();
}

export function storeMessage(msg: NewMessage): void {
  timedDbOp('storeMessage', () => {
    db.run(
      `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.id,
        msg.chat_jid,
        msg.sender,
        msg.sender_name,
        msg.content,
        msg.timestamp,
        msg.is_from_me ? 1 : 0,
        msg.is_bot_message ? 1 : 0,
      ],
    );
    saveDatabase();
  });
}

export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.run(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message ? 1 : 0,
    ],
  );
  saveDatabase();
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const stmt = db.prepare(sql);
  stmt.bind([lastTimestamp, ...jids, `${botPrefix}:%`, limit]);

  const messages: NewMessage[] = [];
  let newTimestamp = lastTimestamp;

  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as NewMessage;
    messages.push(row);
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }
  stmt.free();

  return { messages, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  return timedDbOp('getMessagesSince', () => {
    const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

    const stmt = db.prepare(sql);
    stmt.bind([chatJid, sinceTimestamp, `${botPrefix}:%`, limit]);

    const messages: NewMessage[] = [];
    while (stmt.step()) {
      messages.push(stmt.getAsObject() as unknown as NewMessage);
    }
    stmt.free();

    return messages;
  });
}

/**
 * Return outbound (bot/assistant) messages for a chat JID since the given
 * ISO timestamp, ordered chronologically, capped at `limit` rows.
 *
 * Used by the HTTP channel to replay missed SSE events on reconnect
 * (Last-Event-ID catch-up, Story 20).
 */
export function getOutboundMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  limit: number = 200,
): Pick<NewMessage, 'id' | 'content' | 'timestamp'>[] {
  return timedDbOp('getOutboundMessagesSince', () => {
    const sql = `
      SELECT * FROM (
        SELECT id, content, timestamp
        FROM messages
        WHERE chat_jid = ? AND timestamp > ?
          AND is_bot_message = 1
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?
      ) ORDER BY timestamp
    `;
    const stmt = db.prepare(sql);
    stmt.bind([chatJid, sinceTimestamp, limit]);
    const rows: Pick<NewMessage, 'id' | 'content' | 'timestamp'>[] = [];
    while (stmt.step()) {
      rows.push(
        stmt.getAsObject() as unknown as Pick<
          NewMessage,
          'id' | 'content' | 'timestamp'
        >,
      );
    }
    stmt.free();
    return rows;
  });
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.run(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.group_folder,
      task.chat_jid,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.context_mode || 'isolated',
      task.next_run,
      task.status,
      task.created_at,
    ],
  );
  saveDatabase();
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const stmt = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?');
  stmt.bind([id]);

  if (stmt.step()) {
    const result = stmt.getAsObject() as unknown as ScheduledTask;
    stmt.free();
    return result;
  }
  stmt.free();
  return undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  const stmt = db.prepare(
    'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
  );
  stmt.bind([groupFolder]);

  const tasks: ScheduledTask[] = [];
  while (stmt.step()) {
    tasks.push(stmt.getAsObject() as unknown as ScheduledTask);
  }
  stmt.free();
  return tasks;
}

export function getAllTasks(): ScheduledTask[] {
  const result = db.exec(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
  );
  if (result.length === 0) return [];

  return result[0].values.map((row: unknown[]) => {
    const cols = result[0].columns;
    const obj: Record<string, unknown> = {};
    cols.forEach((col: string, i: number) => (obj[col] = row[i]));
    return obj as unknown as ScheduledTask;
  });
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'last_result'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.last_result !== undefined) {
    fields.push('last_result = ?');
    values.push(updates.last_result);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.run(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
    values as unknown as initSqlJs.BindParams,
  );
  saveDatabase();
}

export function deleteTask(id: string): void {
  db.run('DELETE FROM task_run_logs WHERE task_id = ?', [id]);
  db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id]);
  saveDatabase();
}

/**
 * Delete a scheduled task only if it belongs to the specified group.
 * Returns true if a row was deleted, false if the task was not found
 * or belongs to a different group (cross-group deletion is prevented).
 */
export function deleteTaskForGroup(id: string, groupFolder: string): boolean {
  // Check ownership before deleting run logs (avoids orphan cleanup for
  // tasks that exist but belong to another group).
  const stmt = db.prepare(
    'SELECT id FROM scheduled_tasks WHERE id = ? AND group_folder = ?',
  );
  stmt.bind([id, groupFolder]);
  const exists = stmt.step();
  stmt.free();

  if (!exists) return false;

  db.run('DELETE FROM task_run_logs WHERE task_id = ?', [id]);
  db.run(
    'DELETE FROM scheduled_tasks WHERE id = ? AND group_folder = ?',
    [id, groupFolder],
  );
  saveDatabase();
  return true;
}

export function getAllScheduledTasks(): ScheduledTask[] {
  const result = db.exec(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: unknown[]) => {
    const cols = result[0].columns;
    const obj: Record<string, unknown> = {};
    cols.forEach((col: string, i: number) => (obj[col] = row[i]));
    return obj as unknown as ScheduledTask;
  });
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `);
  stmt.bind([now]);

  const tasks: ScheduledTask[] = [];
  while (stmt.step()) {
    tasks.push(stmt.getAsObject() as unknown as ScheduledTask);
  }
  stmt.free();
  return tasks;
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.run(
    `UPDATE scheduled_tasks
     SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
     WHERE id = ?`,
    [nextRun, now, lastResult, nextRun, id],
  );
  saveDatabase();
}

export function logTaskRun(log: TaskRunLog): void {
  db.run(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    ],
  );
  saveDatabase();
}

export function getRouterState(key: string): string | undefined {
  const stmt = db.prepare('SELECT value FROM router_state WHERE key = ?');
  stmt.bind([key]);

  if (stmt.step()) {
    const result = stmt.getAsObject() as { value: string };
    stmt.free();
    return result.value;
  }
  stmt.free();
  return undefined;
}

export function setRouterState(key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)', [
    key,
    value,
  ]);
  saveDatabase();
}

export function getSession(groupFolder: string): string | undefined {
  const stmt = db.prepare(
    'SELECT session_id FROM sessions WHERE group_folder = ?',
  );
  stmt.bind([groupFolder]);

  if (stmt.step()) {
    const result = stmt.getAsObject() as { session_id: string };
    stmt.free();
    return result.session_id;
  }
  stmt.free();
  return undefined;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.run(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
    [groupFolder, sessionId],
  );
  saveDatabase();
}

export function getAllSessions(): Record<string, string> {
  const result = db.exec('SELECT group_folder, session_id FROM sessions');
  if (result.length === 0) return {};

  const sessions: Record<string, string> = {};
  result[0].values.forEach((row: unknown[]) => {
    sessions[row[0] as string] = row[1] as string;
  });
  return sessions;
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const stmt = db.prepare('SELECT * FROM registered_groups WHERE jid = ?');
  stmt.bind([jid]);

  if (!stmt.step()) {
    stmt.free();
    return undefined;
  }

  const row = stmt.getAsObject() as {
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    llm_provider: string | null;
  };
  stmt.free();

  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    llmProvider: (row.llm_provider as LLMProvider) || undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.run(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, llm_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jid,
      group.name,
      group.folder,
      group.trigger,
      group.added_at,
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
      group.isMain ? 1 : 0,
      group.llmProvider || null,
    ],
  );
  saveDatabase();
}

export function updateGroupProvider(
  jid: string,
  provider: string | null | undefined,
): boolean {
  const validProviders = ['claude', 'openrouter'];
  const validatedProvider =
    provider && validProviders.includes(provider) ? provider : null;

  const before = getRegisteredGroup(jid);
  db.run('UPDATE registered_groups SET llm_provider = ? WHERE jid = ?', [
    validatedProvider,
    jid,
  ]);
  const after = getRegisteredGroup(jid);

  saveDatabase();
  return before !== after;
}

export function clearInvalidProviders(): number {
  const validProviders = ['claude', 'openrouter'];
  const before = db.exec(
    'SELECT COUNT(*) FROM registered_groups WHERE llm_provider IS NOT NULL AND llm_provider NOT IN (' +
      validProviders.map(() => '?').join(',') +
      ')',
  );
  const beforeCount =
    before.length > 0 ? (before[0].values[0][0] as number) : 0;

  if (beforeCount === 0) return 0;

  db.run(
    `UPDATE registered_groups 
     SET llm_provider = NULL 
     WHERE llm_provider IS NOT NULL 
     AND llm_provider NOT IN (${validProviders.map(() => '?').join(',')})`,
    validProviders,
  );

  saveDatabase();
  return beforeCount;
}

export function deleteRegisteredGroup(jid: string): void {
  // Clean up scheduled tasks for this group before removing the registration
  const group = getRegisteredGroup(jid);
  if (group) {
    db.run(
      'DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)',
      [group.folder],
    );
    db.run('DELETE FROM scheduled_tasks WHERE group_folder = ?', [
      group.folder,
    ]);
  }
  db.run('DELETE FROM registered_groups WHERE jid = ?', [jid]);
  saveDatabase();
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const result = db.exec('SELECT * FROM registered_groups');
  if (result.length === 0) return {};

  const groups: Record<string, RegisteredGroup> = {};
  const cols = result[0].columns;

  result[0].values.forEach((row: unknown[]) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((col: string, i: number) => (obj[col] = row[i]));

    const r = obj as {
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      added_at: string;
      container_config: string | null;
      requires_trigger: number | null;
      is_main: number | null;
      llm_provider: string | null;
    };

    if (!isValidGroupFolder(r.folder)) {
      logger.warn(
        { jid: r.jid, folder: r.folder },
        'Skipping registered group with invalid folder',
      );
      return;
    }
    groups[r.jid] = {
      name: r.name,
      folder: r.folder,
      trigger: r.trigger_pattern,
      added_at: r.added_at,
      containerConfig: r.container_config
        ? JSON.parse(r.container_config)
        : undefined,
      requiresTrigger:
        r.requires_trigger === null ? undefined : r.requires_trigger === 1,
      isMain: r.is_main === 1 ? true : undefined,
      llmProvider: (r.llm_provider as LLMProvider) || undefined,
    };
  });

  return groups;
}

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Conversation History Functions ---

/**
 * Return the most recent conversation messages for a group or session.
 *
 * Accepts either:
 *  - `getConversationHistory(groupFolder, limit?)` — legacy positional form; queries by group_folder
 *  - `getConversationHistory({ sessionKey, limit? })` — new object form; queries by session_key
 *
 * @param limitOrArgs  Either a numeric limit or an object `{ sessionKey, limit? }`
 */
export function getConversationHistory(
  groupFolderOrArgs: string | { sessionKey: string; limit?: number },
  limit?: number,
): { id: string; role: 'user' | 'assistant'; content: string }[] {
  return timedDbOp('getConversationHistory', () => {
    let column: string;
    let key: string;
    let maxMessages: number;

    if (typeof groupFolderOrArgs === 'string') {
      column = 'group_folder';
      key = groupFolderOrArgs;
      maxMessages =
        limit ??
        (parseInt(process.env.MAX_CONVERSATION_HISTORY || '20', 10) || 0);
    } else {
      column = 'session_key';
      key = groupFolderOrArgs.sessionKey;
      maxMessages =
        groupFolderOrArgs.limit ??
        (parseInt(process.env.MAX_CONVERSATION_HISTORY || '20', 10) || 0);
    }

    const query =
      maxMessages > 0
        ? `SELECT id, role, content FROM conversation_history WHERE ${column} = ? ORDER BY created_at DESC LIMIT ?`
        : `SELECT id, role, content FROM conversation_history WHERE ${column} = ? ORDER BY created_at ASC`;
    const params = maxMessages > 0 ? [key, maxMessages] : [key];
    const result = db.exec(query, params);
    if (result.length === 0) return [];
    const rows = result[0].values.map((row: unknown[]) => ({
      id: row[0] as string,
      role: row[1] as 'user' | 'assistant',
      content: row[2] as string,
    }));
    // DESC query returns newest-first; reverse to chronological order
    if (maxMessages > 0) rows.reverse();
    return rows;
  });
}

export interface AppendConversationArgs {
  groupFolder: string;
  sessionKey: string;
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Append a conversation message with explicit session scoping.
 * Prefer this over appendConversationMessage for new call sites that
 * distinguish session_key from group_folder (e.g. isolated specialists).
 */
export function recordSpecialistUsage(args: {
  groupFolder: string;
  specialistName: string;
  durationMs: number;
  status: 'success' | 'error';
}): void {
  db.run(
    `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
    [
      args.groupFolder,
      args.specialistName,
      Date.now(),
      args.durationMs,
      args.status,
    ],
  );
  saveDatabase();
}

export function appendConversationHistory(args: AppendConversationArgs): void {
  const id =
    args.groupFolder +
    '-' +
    Date.now() +
    '-' +
    Math.random().toString(36).slice(2, 8);
  db.run(
    'INSERT INTO conversation_history (id, group_folder, session_key, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      id,
      args.groupFolder,
      args.sessionKey,
      args.role,
      args.content,
      new Date().toISOString(),
    ],
  );
  saveDatabase();
}

export function appendConversationMessage(
  groupFolder: string,
  role: 'user' | 'assistant',
  content: string,
): void {
  const id =
    groupFolder +
    '-' +
    Date.now() +
    '-' +
    Math.random().toString(36).slice(2, 8);
  db.run(
    'INSERT INTO conversation_history (id, group_folder, session_key, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, groupFolder, groupFolder, role, content, new Date().toISOString()],
  );
  saveDatabase();
}

/**
 * Deletes ALL conversation_history rows for a group, including rows written
 * by isolated specialists (where session_key differs from group_folder).
 * Group-level wipe; session-key scoping does not protect specialist rows.
 */
/**
 * Delete conversation_history rows by their IDs, atomically.
 * Returns the number of rows deleted.
 */
export function deleteMessagesByIds(ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  db.run('BEGIN');
  try {
    db.run(
      `DELETE FROM conversation_history WHERE id IN (${placeholders})`,
      ids,
    );
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
  saveDatabase();
  // sql.js doesn't expose affected row count directly; return ids.length as best estimate
  return ids.length;
}

export function clearConversationHistory(groupFolder: string): void {
  db.run('BEGIN');
  try {
    db.run('DELETE FROM conversation_history WHERE group_folder = ?', [
      groupFolder,
    ]);
    db.run('DELETE FROM conversation_summaries WHERE group_folder = ?', [
      groupFolder,
    ]);
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
  saveDatabase();
}

// --- Conversation Summary Functions ---

export interface SummaryRecord {
  id: string;
  groupFolder: string;
  sessionKey: string;
  parentSummaryId: string | null;
  messageStartId: string;
  messageEndId: string;
  summaryText: string;
  modelUsed: string;
  tokenCount: number;
  createdAt: string;
}

export interface InsertSummaryArgs {
  groupFolder: string;
  sessionKey: string;
  parentSummaryId: string | null;
  messageStartId: string;
  messageEndId: string;
  summaryText: string;
  modelUsed: string;
  tokenCount: number;
}

export function insertSummary(args: InsertSummaryArgs): string {
  const id =
    args.groupFolder +
    '-summary-' +
    Date.now() +
    '-' +
    Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO conversation_summaries
      (id, group_folder, session_key, parent_summary_id,
       message_start_id, message_end_id, summary_text,
       model_used, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      args.groupFolder,
      args.sessionKey,
      args.parentSummaryId ?? null,
      args.messageStartId,
      args.messageEndId,
      args.summaryText,
      args.modelUsed,
      args.tokenCount,
      now,
    ],
  );
  saveDatabase();
  return id;
}

export function getLatestSummary(groupFolder: string): SummaryRecord | null {
  const result = db.exec(
    `SELECT id, group_folder, session_key, parent_summary_id,
            message_start_id, message_end_id, summary_text,
            model_used, token_count, created_at
     FROM conversation_summaries
     WHERE group_folder = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [groupFolder],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  const [id, gf, sk, parentId, startId, endId, text, model, tokens, createdAt] =
    result[0].values[0] as [
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
      string,
      number,
      string,
    ];
  return {
    id,
    groupFolder: gf,
    sessionKey: sk,
    parentSummaryId: parentId,
    messageStartId: startId,
    messageEndId: endId,
    summaryText: text,
    modelUsed: model,
    tokenCount: tokens,
    createdAt,
  };
}

export function getSummaryById(id: string): SummaryRecord | null {
  const result = db.exec(
    `SELECT id, group_folder, session_key, parent_summary_id,
            message_start_id, message_end_id, summary_text,
            model_used, token_count, created_at
     FROM conversation_summaries
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  const [
    rid,
    gf,
    sk,
    parentId,
    startId,
    endId,
    text,
    model,
    tokens,
    createdAt,
  ] = result[0].values[0] as [
    string,
    string,
    string,
    string | null,
    string,
    string,
    string,
    string,
    number,
    string,
  ];
  return {
    id: rid,
    groupFolder: gf,
    sessionKey: sk,
    parentSummaryId: parentId,
    messageStartId: startId,
    messageEndId: endId,
    summaryText: text,
    modelUsed: model,
    tokenCount: tokens,
    createdAt,
  };
}

export function deleteSummariesForGroup(groupFolder: string): void {
  db.run('DELETE FROM conversation_summaries WHERE group_folder = ?', [
    groupFolder,
  ]);
  saveDatabase();
}

export interface SearchResult {
  id: string;
  groupFolder: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  snippet: string;
}

export interface SearchConversationsArgs {
  groupFolder: string;
  query: string;
  limit?: number;
  before?: string; // ISO date prefix, e.g. '2026-04' or '2026-04-15'
  after?: string; // ISO date prefix
}

/**
 * Full-text search over conversation_history for a single group.
 * Uses the FTS4 virtual table created in createSchema().
 * Results are ordered by recency descending. Limit defaults to 10.
 */
export function searchConversations(
  args: SearchConversationsArgs,
): SearchResult[] {
  const { groupFolder, query, limit = 10, before, after } = args;

  // Build the date filter fragment for the JOIN side.
  const whereClauses: string[] = [
    'f.group_folder = ?',
    'f.conversation_history_fts MATCH ?',
  ];
  const params: (string | number)[] = [groupFolder, query];

  if (after) {
    whereClauses.push('h.created_at >= ?');
    params.push(after);
  }
  if (before) {
    whereClauses.push('h.created_at <= ?');
    params.push(before);
  }

  const where = whereClauses.join(' AND ');

  // snippet(table, startMatch, endMatch, ellipsis, columnIndex, numTokens)
  // columnIndex 3 = content column (0-indexed: id, group_folder, role, content, created_at)
  const sql = `
    SELECT
      f.id,
      f.group_folder,
      h.role,
      h.content,
      h.created_at,
      snippet(conversation_history_fts, '[', ']', '...', 3, 20) AS snippet
    FROM conversation_history_fts f
    JOIN conversation_history h ON h.id = f.id
    WHERE ${where}
    ORDER BY h.created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const result = db.exec(sql, params);
  if (result.length === 0) return [];

  return result[0].values.map((row: unknown[]) => ({
    id: row[0] as string,
    groupFolder: row[1] as string,
    role: row[2] as 'user' | 'assistant',
    content: row[3] as string,
    createdAt: row[4] as string,
    snippet: row[5] as string,
  }));
}

// --- Job ACL Functions ---

export function storeJobACL(acl: JobACL): void {
  db.run(
    `INSERT OR REPLACE INTO job_acls (job_id, group_folder, username, password, created_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      acl.jobId,
      acl.groupFolder,
      acl.username,
      acl.password,
      acl.createdAt,
      acl.expiresAt,
      acl.status,
    ],
  );
  saveDatabase();
}

export function getJobACL(jobId: string): JobACL | undefined {
  const stmt = db.prepare('SELECT * FROM job_acls WHERE job_id = ?');
  stmt.bind([jobId]);

  if (stmt.step()) {
    const row = stmt.getAsObject() as {
      job_id: string;
      group_folder: string;
      username: string;
      password: string;
      created_at: string;
      expires_at: string;
      status: string;
    };
    stmt.free();
    return {
      jobId: row.job_id,
      groupFolder: row.group_folder,
      username: row.username,
      password: row.password,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status as 'active' | 'revoked',
    };
  }
  stmt.free();
  return undefined;
}

export function getJobACLByGroup(groupFolder: string): JobACL | undefined {
  const stmt = db.prepare(
    'SELECT * FROM job_acls WHERE group_folder = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
  );
  stmt.bind([groupFolder, 'active']);

  if (stmt.step()) {
    const row = stmt.getAsObject() as {
      job_id: string;
      group_folder: string;
      username: string;
      password: string;
      created_at: string;
      expires_at: string;
      status: string;
    };
    stmt.free();
    return {
      jobId: row.job_id,
      groupFolder: row.group_folder,
      username: row.username,
      password: row.password,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status as 'active' | 'revoked',
    };
  }
  stmt.free();
  return undefined;
}

export function revokeJobACL(jobId: string): void {
  db.run(`UPDATE job_acls SET status = 'revoked' WHERE job_id = ?`, [jobId]);
  saveDatabase();
}

export function cleanupExpiredACLs(): string[] {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `SELECT job_id FROM job_acls WHERE status = 'active' AND expires_at < ?`,
  );
  stmt.bind([now]);

  const revokedJobIds: string[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as { job_id: string };
    revokedJobIds.push(row.job_id);
  }
  stmt.free();

  if (revokedJobIds.length > 0) {
    const placeholders = revokedJobIds.map(() => '?').join(',');
    db.run(
      `UPDATE job_acls SET status = 'revoked' WHERE job_id IN (${placeholders})`,
      revokedJobIds,
    );
    saveDatabase();
  }

  return revokedJobIds;
}

// --- Conversation History Pagination ---

export interface ConversationHistoryPageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

/**
 * Return a page of conversation history rows for a group, ordered oldest-first.
 *
 * @param groupFolder  The group folder (matches the `group_folder` column).
 * @param opts.limit   Maximum rows to return (default 20, cap 100).
 * @param opts.before  If given, return only rows with `created_at` strictly
 *                     older than the row whose `id = before`. Enables cursor
 *                     pagination: pass the `id` of the oldest row in the
 *                     previous page to fetch the next page backwards in time.
 */
export function getConversationHistoryPage(
  groupFolder: string,
  opts: { limit?: number; before?: string } = {},
): ConversationHistoryPageRow[] {
  return timedDbOp('getConversationHistoryPage', () => {
    const rawLimit = opts.limit ?? 20;
    const limit = Math.min(Math.max(1, rawLimit), 100);

    if (opts.before) {
      // Look up the created_at of the cursor row.
      const cursorResult = db.exec(
        `SELECT created_at FROM conversation_history WHERE id = ? AND group_folder = ?`,
        [opts.before, groupFolder],
      );
      if (cursorResult.length === 0 || cursorResult[0].values.length === 0) {
        // Unknown cursor ID → return empty page rather than crash.
        return [];
      }
      const cursorCreatedAt = cursorResult[0].values[0][0] as string;

      const result = db.exec(
        `SELECT id, role, content, created_at
         FROM conversation_history
         WHERE group_folder = ? AND (
           created_at < ? OR (created_at = ? AND id < ?)
         )
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [groupFolder, cursorCreatedAt, cursorCreatedAt, opts.before, limit],
      );
      if (result.length === 0) return [];
      const rows = result[0].values.map((row: unknown[]) => ({
        id: row[0] as string,
        role: row[1] as 'user' | 'assistant',
        content: row[2] as string,
        created_at: row[3] as string,
      }));
      // Return in chronological order (oldest first).
      rows.reverse();
      return rows;
    }

    // No cursor: return `limit` most-recent rows in chronological order.
    const result = db.exec(
      `SELECT id, role, content, created_at
       FROM conversation_history
       WHERE group_folder = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [groupFolder, limit],
    );
    if (result.length === 0) return [];
    const rows = result[0].values.map((row: unknown[]) => ({
      id: row[0] as string,
      role: row[1] as 'user' | 'assistant',
      content: row[2] as string,
      created_at: row[3] as string,
    }));
    rows.reverse();
    return rows;
  });
}

// --- Conversation Export (Story 52) ---

export interface ConversationExportRow {
  role: 'user' | 'assistant';
  content: string;
  /** ISO-8601 timestamp (maps from created_at column) */
  timestamp: string;
  /** Derived from role: username for user rows, 'assistant' for assistant rows */
  sender: string;
}

/**
 * Return ALL conversation_history rows for a group, oldest-first.
 * Intended for export. NOTE: sql.js materializes the whole result set in
 * memory before returning — the HTTP layer streams to the client per-row
 * via `res.write`, but the DB read itself is still buffered. For very large
 * histories on small pods this could OOM; a future story can add a true
 * cursor-based reader if that becomes a real workload.
 *
 * The `sender` field is derived from the role and the provided `username`.
 */
export function getAllConversationHistory(
  groupFolder: string,
  username: string,
): ConversationExportRow[] {
  return timedDbOp('getAllConversationHistory', () => {
    const result = db.exec(
      `SELECT role, content, created_at
       FROM conversation_history
       WHERE group_folder = ?
       ORDER BY created_at ASC, id ASC`,
      [groupFolder],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: unknown[]) => ({
      role: row[0] as 'user' | 'assistant',
      content: row[1] as string,
      timestamp: row[2] as string,
      sender: (row[0] as string) === 'user' ? username : 'assistant',
    }));
  });
}

// --- Skill Usage Functions ---

export interface SkillLoadStat {
  skill_name: string;
  load_count: number;
  last_loaded: number;
}

export function recordSkillLoad(
  groupFolder: string,
  skillName: string,
  loadedAt: number = Date.now(),
): void {
  const id = `${groupFolder}-${skillName}-${loadedAt}-${Math.random().toString(36).slice(2, 8)}`;
  db.run(
    'INSERT INTO skill_usage (id, group_folder, skill_name, loaded_at) VALUES (?, ?, ?, ?)',
    [id, groupFolder, skillName, loadedAt],
  );
  saveDatabase();
}

export function getSkillLoadStats(groupFolder: string): SkillLoadStat[] {
  const rows = db.exec(
    `SELECT skill_name, COUNT(*) as load_count, MAX(loaded_at) as last_loaded
     FROM skill_usage WHERE group_folder = ? GROUP BY skill_name
     ORDER BY last_loaded DESC`,
    [groupFolder],
  );
  if (rows.length === 0) return [];
  return rows[0].values.map((r: unknown[]) => ({
    skill_name: r[0] as string,
    load_count: r[1] as number,
    last_loaded: r[2] as number,
  }));
}

export function getSkillsLoadedSince(
  groupFolder: string,
  sinceMs: number,
): string[] {
  const rows = db.exec(
    `SELECT DISTINCT skill_name FROM skill_usage
     WHERE group_folder = ? AND loaded_at >= ?`,
    [groupFolder, sinceMs],
  );
  if (rows.length === 0) return [];
  return rows[0].values.map((r: unknown[]) => r[0] as string);
}

// --- Tool Job Tracking Functions ---

export interface ToolJobRecord {
  job_id: string;
  group_folder: string;
  chat_jid: string;
  status: 'active' | 'completed' | 'interrupted' | 'timeout' | 'oomkill';
  created_at: string;
  resolved_at: string | null;
  /** User-facing message ID from the POST /message response (Story 25). May be NULL for rows written before this column was added. */
  message_id: string | null;
  /** Display name of the specialist invoked for this job (Story 50). Empty string for rows written before this column was added. */
  specialist_name: string;
}

/**
 * Record a newly spawned tool job so it can be detected as an orphan if the
 * orchestrator restarts while the job is still running.
 *
 * @param messageId — the user-facing message ID returned by POST /message
 *   (Story 25). Pass undefined/null for callers that do not have this value.
 * @param specialistName — display name of the specialist invoked (Story 50).
 *   Optional; defaults to empty string for backward-compatible callers.
 */
export function recordToolJob(
  jobId: string,
  groupFolder: string,
  chatJid: string,
  messageId?: string | null,
  specialistName?: string,
): void {
  db.run(
    `INSERT OR IGNORE INTO tool_jobs (job_id, group_folder, chat_jid, status, created_at, message_id, specialist_name)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    [
      jobId,
      groupFolder,
      chatJid,
      new Date().toISOString(),
      messageId ?? null,
      specialistName ?? '',
    ],
  );
  saveDatabase();
}

/**
 * Mark a tool job as completed (normal termination — not an orphan).
 * Idempotent: safe to call even if the row is already resolved.
 */
export function resolveToolJob(
  jobId: string,
  status: 'completed' | 'interrupted' | 'timeout' | 'oomkill',
): void {
  db.run(
    `UPDATE tool_jobs SET status = ?, resolved_at = ? WHERE job_id = ? AND status = 'active'`,
    [status, new Date().toISOString(), jobId],
  );
  saveDatabase();
}

/**
 * Return all tool job rows that are still in `active` status.
 * These are candidates for orphan reconciliation on orchestrator startup.
 */
export function getActiveToolJobs(): ToolJobRecord[] {
  const result = db.exec(
    `SELECT job_id, group_folder, chat_jid, status, created_at, resolved_at, message_id, specialist_name
     FROM tool_jobs WHERE status = 'active'`,
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: unknown[]) => ({
    job_id: row[0] as string,
    group_folder: row[1] as string,
    chat_jid: row[2] as string,
    status: row[3] as 'active',
    created_at: row[4] as string,
    resolved_at: row[5] as string | null,
    message_id: row[6] as string | null,
    specialist_name: (row[7] as string | null) ?? '',
  }));
}

/**
 * Return the most recent non-active (completed/interrupted/timeout/oomkill)
 * tool jobs for a specific group, ordered newest first.
 * Used by the /jobs command to show recent history.
 */
export function getRecentToolJobsForGroup(
  groupFolder: string,
  limit: number,
): ToolJobRecord[] {
  const result = db.exec(
    `SELECT job_id, group_folder, chat_jid, status, created_at, resolved_at, message_id, specialist_name
     FROM tool_jobs
     WHERE group_folder = ? AND status NOT IN ('active')
     ORDER BY created_at DESC
     LIMIT ?`,
    [groupFolder, limit],
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: unknown[]) => ({
    job_id: row[0] as string,
    group_folder: row[1] as string,
    chat_jid: row[2] as string,
    status: row[3] as 'completed' | 'interrupted' | 'timeout' | 'oomkill',
    created_at: row[4] as string,
    resolved_at: row[5] as string | null,
    message_id: row[6] as string | null,
    specialist_name: (row[7] as string | null) ?? '',
  }));
}
