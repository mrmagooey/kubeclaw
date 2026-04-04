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
  McpServerSpec,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: SqlJsDatabase;
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

  database.run(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      name TEXT PRIMARY KEY,
      spec TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    )
  `);

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
}

function saveDatabase(): void {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
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
 * Return the most recent conversation messages for a group.
 * Older context is available via RAG retrieval when configured.
 *
 * @param limit  Max messages to return (default: 20). Set to 0 for unlimited.
 *               Configurable via MAX_CONVERSATION_HISTORY env var.
 */
export function getConversationHistory(
  groupFolder: string,
  limit?: number,
): { role: 'user' | 'assistant'; content: string }[] {
  const maxMessages =
    limit ?? (parseInt(process.env.MAX_CONVERSATION_HISTORY || '20', 10) || 0);
  const query =
    maxMessages > 0
      ? 'SELECT role, content FROM conversation_history WHERE group_folder = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT role, content FROM conversation_history WHERE group_folder = ? ORDER BY created_at ASC';
  const params = maxMessages > 0 ? [groupFolder, maxMessages] : [groupFolder];
  const result = db.exec(query, params);
  if (result.length === 0) return [];
  const rows = result[0].values.map((row: unknown[]) => ({
    role: row[0] as 'user' | 'assistant',
    content: row[1] as string,
  }));
  // DESC query returns newest-first; reverse to chronological order
  if (maxMessages > 0) rows.reverse();
  return rows;
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
    'INSERT INTO conversation_history (id, group_folder, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, groupFolder, role, content, new Date().toISOString()],
  );
  saveDatabase();
}

export function clearConversationHistory(groupFolder: string): void {
  db.run('DELETE FROM conversation_history WHERE group_folder = ?', [
    groupFolder,
  ]);
  saveDatabase();
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

// --- MCP Server Functions ---

export function setMcpServer(spec: McpServerSpec): void {
  db.run(
    `INSERT OR REPLACE INTO mcp_servers (name, spec, status, created_at)
     VALUES (?, ?, 'active', COALESCE((SELECT created_at FROM mcp_servers WHERE name = ?), ?))`,
    [spec.name, JSON.stringify(spec), spec.name, new Date().toISOString()],
  );
  saveDatabase();
}

export function getMcpServer(name: string): McpServerSpec | undefined {
  const stmt = db.prepare(
    `SELECT spec FROM mcp_servers WHERE name = ? AND status = 'active'`,
  );
  stmt.bind([name]);

  if (stmt.step()) {
    const row = stmt.getAsObject() as { spec: string };
    stmt.free();
    return JSON.parse(row.spec) as McpServerSpec;
  }
  stmt.free();
  return undefined;
}

export function getAllMcpServers(): McpServerSpec[] {
  const result = db.exec(
    `SELECT spec FROM mcp_servers WHERE status = 'active' ORDER BY created_at`,
  );
  if (result.length === 0) return [];
  return result[0].values.map(
    (row: unknown[]) => JSON.parse(row[0] as string) as McpServerSpec,
  );
}

export function deleteMcpServer(name: string): void {
  db.run(`DELETE FROM mcp_servers WHERE name = ?`, [name]);
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
