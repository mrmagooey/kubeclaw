/**
 * Unit tests for getDiagSnapshot (Story 79).
 *
 * Exercises each field in isolation and verifies null fallback when a
 * sub-read throws.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  _initTestDatabase,
  db,
  appendConversationMessage,
  createTask,
  getDiagSnapshot,
} from './db.js';

beforeEach(async () => {
  await _initTestDatabase();
});

describe('getDiagSnapshot', () => {
  it('returns an object with all 7 required keys', async () => {
    const snap = getDiagSnapshot('test-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap).toHaveProperty('conversation_history_rows');
    expect(snap).toHaveProperty('scheduled_tasks_active');
    expect(snap).toHaveProperty('tool_jobs_recent_24h');
    expect(snap).toHaveProperty('attachment_count');
    expect(snap).toHaveProperty('attachment_bytes');
    expect(snap).toHaveProperty('db_size_bytes');
    expect(snap).toHaveProperty('uptime_seconds');
  });

  it('conversation_history_rows counts rows for the given group only', () => {
    appendConversationMessage('my-group', 'user', 'hello');
    appendConversationMessage('my-group', 'assistant', 'hi');
    appendConversationMessage('other-group', 'user', 'unrelated');

    const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap.conversation_history_rows).toBe(2);
  });

  it('conversation_history_rows is 0 when group has no history', () => {
    const snap = getDiagSnapshot('empty-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap.conversation_history_rows).toBe(0);
  });

  it('scheduled_tasks_active counts only active tasks for the given group', () => {
    const now = new Date().toISOString();
    createTask({
      id: 'task-1',
      group_folder: 'my-group',
      chat_jid: 'http:alice',
      prompt: 'do something',
      schedule_type: 'interval',
      schedule_value: '3600',
      context_mode: 'isolated',
      next_run: now,
      status: 'active',
      created_at: now,
    });
    createTask({
      id: 'task-2',
      group_folder: 'my-group',
      chat_jid: 'http:alice',
      prompt: 'done thing',
      schedule_type: 'interval',
      schedule_value: '3600',
      context_mode: 'isolated',
      next_run: null,
      status: 'completed',
      created_at: now,
    });
    createTask({
      id: 'task-3',
      group_folder: 'other-group',
      chat_jid: 'http:bob',
      prompt: 'bob task',
      schedule_type: 'interval',
      schedule_value: '3600',
      context_mode: 'isolated',
      next_run: now,
      status: 'active',
      created_at: now,
    });

    const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap.scheduled_tasks_active).toBe(1);
  });

  it('scheduled_tasks_active is 0 when no active tasks for group', () => {
    const snap = getDiagSnapshot('no-tasks-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap.scheduled_tasks_active).toBe(0);
  });

  it('tool_jobs_recent_24h is null when tool_jobs table does not exist', () => {
    // Drop the table to simulate a missing table, then check that the field is null.
    db.run(`DROP TABLE IF EXISTS tool_jobs`);
    const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap.tool_jobs_recent_24h).toBeNull();
  });

  it('tool_jobs_recent_24h returns count when tool_jobs table exists', () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago

    db.run(`INSERT INTO tool_jobs (job_id, group_folder, chat_jid, status, created_at) VALUES ('j1', 'my-group', 'http:alice', 'active', '${recent}')`);
    db.run(`INSERT INTO tool_jobs (job_id, group_folder, chat_jid, status, created_at) VALUES ('j2', 'my-group', 'http:alice', 'active', '${old}')`);
    db.run(`INSERT INTO tool_jobs (job_id, group_folder, chat_jid, status, created_at) VALUES ('j3', 'other-group', 'http:bob', 'active', '${recent}')`);

    const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap.tool_jobs_recent_24h).toBe(1);
  });

  it('attachment_count and attachment_bytes are 0 when attachments dir is empty', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-diag-test-'));
    try {
      const attachDir = path.join(tmpDir, 'my-group', 'attachments', 'raw');
      fs.mkdirSync(attachDir, { recursive: true });

      const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-store', tmpDir);
      expect(snap.attachment_count).toBe(0);
      expect(snap.attachment_bytes).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('attachment_count and attachment_bytes reflect actual files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-diag-test-'));
    try {
      const attachDir = path.join(tmpDir, 'my-group', 'attachments', 'raw');
      fs.mkdirSync(attachDir, { recursive: true });
      fs.writeFileSync(path.join(attachDir, 'img1.png'), Buffer.alloc(100));
      fs.writeFileSync(path.join(attachDir, 'img2.jpg'), Buffer.alloc(200));

      const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-store', tmpDir);
      expect(snap.attachment_count).toBe(2);
      expect(snap.attachment_bytes).toBe(300);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('attachment_count and attachment_bytes are null when attachments dir does not exist', () => {
    const snap = getDiagSnapshot('no-attach-group', '/tmp/does-not-exist-store', '/tmp/does-not-exist-groups');
    expect(snap.attachment_count).toBeNull();
    expect(snap.attachment_bytes).toBeNull();
  });

  it('db_size_bytes is null when db file does not exist', () => {
    const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap.db_size_bytes).toBeNull();
  });

  it('db_size_bytes returns file size when db file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaw-diag-db-'));
    try {
      const dbFile = path.join(tmpDir, 'messages.db');
      fs.writeFileSync(dbFile, Buffer.alloc(4096));

      const snap = getDiagSnapshot('my-group', tmpDir);
      expect(snap.db_size_bytes).toBe(4096);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uptime_seconds is a non-negative integer', () => {
    const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-kubeclaw-store');
    expect(typeof snap.uptime_seconds).toBe('number');
    expect(snap.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(snap.uptime_seconds)).toBe(true);
  });

  it('null fallback: each field is independent — one failure does not affect others', () => {
    // Force conversation_history_rows to fail by dropping the table
    db.run(`DROP TABLE IF EXISTS conversation_history`);
    db.run(`DROP TABLE IF EXISTS conversation_history_fts`);

    const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-kubeclaw-store');

    // conversation_history_rows should be null (table dropped)
    expect(snap.conversation_history_rows).toBeNull();
    // Other fields should still work
    expect(snap.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof snap.scheduled_tasks_active).toBe('number');
  });

  it('null fallback: scheduled_tasks failure returns null without crashing', () => {
    db.run(`DROP TABLE IF EXISTS scheduled_tasks`);

    const snap = getDiagSnapshot('my-group', '/tmp/nonexistent-kubeclaw-store');
    expect(snap.scheduled_tasks_active).toBeNull();
    // uptime still works
    expect(snap.uptime_seconds).toBeGreaterThanOrEqual(0);
  });
});
