import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

let SQL: initSqlJs.SqlJsStatic | null = null;

async function getSqlJs(): Promise<initSqlJs.SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

export interface TestChat {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export interface TestMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

export interface TestScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

export interface TestTaskRunLog {
  id?: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

export interface TestDatabase {
  db: SqlJsDatabase;
  addChat: (
    jid: string,
    name: string,
    channel: string,
    isGroup?: boolean,
  ) => void;
  addMessage: (msg: TestMessage) => void;
  getChats: () => TestChat[];
  getMessages: (chatJid: string) => TestMessage[];
  getAllTasks: () => TestScheduledTask[];
  addTask: (task: TestScheduledTask) => void;
  close: () => void;
}

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
      created_at TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated'
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
}

export async function createTestDb(): Promise<TestDatabase> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  createSchema(db);

  return {
    db,

    addChat(jid: string, name: string, channel: string, isGroup = false): void {
      db.run(
        `INSERT OR REPLACE INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)`,
        [jid, name, new Date().toISOString(), channel, isGroup ? 1 : 0],
      );
    },

    addMessage(msg: TestMessage): void {
      db.run(
        `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          msg.id,
          msg.chat_jid,
          msg.sender,
          msg.sender_name,
          msg.content,
          msg.timestamp,
          msg.is_from_me,
          msg.is_bot_message,
        ],
      );
    },

    getChats(): TestChat[] {
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
    },

    getMessages(chatJid: string): TestMessage[] {
      const stmt = db.prepare(
        `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages
         WHERE chat_jid = ?
         ORDER BY timestamp`,
      );
      stmt.bind([chatJid]);

      const messages: TestMessage[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as TestMessage;
        messages.push(row);
      }
      stmt.free();
      return messages;
    },

    getAllTasks(): TestScheduledTask[] {
      const result = db.exec(
        'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
      );
      if (result.length === 0) return [];

      const cols = result[0].columns;
      return result[0].values.map((row: unknown[]) => {
        const obj: Record<string, unknown> = {};
        cols.forEach((col: string, i: number) => (obj[col] = row[i]));
        return obj as unknown as TestScheduledTask;
      });
    },

    addTask(task: TestScheduledTask): void {
      db.run(
        `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, last_run, last_result, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.group_folder,
          task.chat_jid,
          task.prompt,
          task.schedule_type,
          task.schedule_value,
          task.context_mode,
          task.next_run,
          task.last_run,
          task.last_result,
          task.status,
          task.created_at,
        ],
      );
    },

    close(): void {
      db.close();
    },
  };
}
