/**
 * Story 74 — /memory REST API End-to-End Tests
 *
 * Tests GET, HEAD, PUT, PATCH /memory on the HTTP channel.
 * Namespace: kubeclaw-e2e-memory-http  Port: 14157
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { HttpChannel, type HttpChannelOpts } from '../src/channels/http.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MEMORY_PORT = 14157;
const TEST_USER = 'memtest';
const TEST_PASS = 'mempass';
const TEST_JID = `http:${TEST_USER}`;
const GROUP_FOLDER = 'http-memtest';

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

const AUTH_HEADER = basicAuth(TEST_USER, TEST_PASS);

describe('HTTP Channel /memory REST API (Story 74)', () => {
  let channel: HttpChannel | null = null;
  let groupsDir: string;

  function createTestOpts(): HttpChannelOpts {
    return {
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({
        [TEST_JID]: {
          name: 'MemTest User',
          folder: GROUP_FOLDER,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        },
      }),
    };
  }

  function createChannel(opts?: HttpChannelOpts): HttpChannel {
    const config = {
      port: MEMORY_PORT,
      users: { [TEST_USER]: TEST_PASS },
    };
    return new HttpChannel(config, opts ?? createTestOpts());
  }

  beforeAll(async () => {
    // Create a temp groups dir that matches the GROUPS_DIR used by the channel
    // The channel uses the GROUPS_DIR from config.ts at module load time.
    // For e2e tests, we rely on the real config.ts GROUPS_DIR but create
    // the group folder under it so the file operations work.
    // Alternatively we use a tmp dir and set GROUPS_DIR env before import —
    // but since GROUPS_DIR is imported at module level in config.ts we instead
    // discover it from the environment.
    const configModule = await import('../src/config.js');
    groupsDir = configModule.GROUPS_DIR;
    const groupDir = path.join(groupsDir, GROUP_FOLDER);
    fs.mkdirSync(groupDir, { recursive: true });
    // Ensure any previous test run's CLAUDE.md is removed
    const memFile = path.join(groupDir, 'CLAUDE.md');
    if (fs.existsSync(memFile)) fs.unlinkSync(memFile);

    channel = createChannel();
    await channel!.connect();
  });

  afterAll(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
    // Clean up the test group dir
    const groupDir = path.join(groupsDir, GROUP_FOLDER);
    if (fs.existsSync(groupDir)) {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Remove CLAUDE.md before each test for a clean slate
    const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');
    if (fs.existsSync(memFile)) fs.unlinkSync(memFile);
  });

  // ── GET /memory ───────────────────────────────────────────────────────────

  describe('GET /memory', () => {
    it('returns 200 with empty content when file does not exist', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string };
      expect(body.content).toBe('');
    });

    it('returns 200 with file contents when CLAUDE.md exists', async () => {
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');
      fs.writeFileSync(memFile, '# My Group Memory\nSome notes here.', 'utf8');

      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string };
      expect(body.content).toBe('# My Group Memory\nSome notes here.');
    });

    it('returns 401 without credentials', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`);
      expect(res.status).toBe(401);
    });

    it('returns JSON content type', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });

  // ── HEAD /memory ──────────────────────────────────────────────────────────

  describe('HEAD /memory', () => {
    it('returns same status and headers as GET but no body', async () => {
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');
      fs.writeFileSync(memFile, '# Test', 'utf8');

      const [getRes, headRes] = await Promise.all([
        fetch(`http://localhost:${MEMORY_PORT}/memory`, {
          headers: { Authorization: AUTH_HEADER },
        }),
        fetch(`http://localhost:${MEMORY_PORT}/memory`, {
          method: 'HEAD',
          headers: { Authorization: AUTH_HEADER },
        }),
      ]);

      expect(headRes.status).toBe(200);
      expect(headRes.status).toBe(getRes.status);
      expect(headRes.headers.get('content-type')).toBe(
        getRes.headers.get('content-type'),
      );
      // HEAD body must be empty
      const headBody = await headRes.text();
      expect(headBody).toBe('');
    });
  });

  // ── PUT /memory ───────────────────────────────────────────────────────────

  describe('PUT /memory', () => {
    it('returns 204 and overwrites file with new content', async () => {
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');
      fs.writeFileSync(memFile, 'Old content', 'utf8');

      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# New Memory\nFresh content.' }),
      });
      expect(res.status).toBe(204);

      const written = fs.readFileSync(memFile, 'utf8');
      expect(written).toBe('# New Memory\nFresh content.');
    });

    it('creates file when it does not exist', async () => {
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');
      expect(fs.existsSync(memFile)).toBe(false);

      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Created from scratch.' }),
      });
      expect(res.status).toBe(204);
      expect(fs.existsSync(memFile)).toBe(true);
      expect(fs.readFileSync(memFile, 'utf8')).toBe('Created from scratch.');
    });

    it('returns 400 for missing content field', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ other: 'field' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for non-string content', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 123 }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 401 without credentials', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'test' }),
      });
      expect(res.status).toBe(401);
    });

    it('PUT is idempotent — second PUT replaces first', async () => {
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');

      await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'First write.' }),
      });
      await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Second write.' }),
      });

      expect(fs.readFileSync(memFile, 'utf8')).toBe('Second write.');
    });
  });

  // ── PATCH /memory ─────────────────────────────────────────────────────────

  describe('PATCH /memory', () => {
    it('returns 204 and appends text with leading newline when file has content', async () => {
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');
      fs.writeFileSync(memFile, 'Line one', 'utf8');

      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PATCH',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ append: 'Line two' }),
      });
      expect(res.status).toBe(204);

      const written = fs.readFileSync(memFile, 'utf8');
      expect(written).toBe('Line one\nLine two');
    });

    it('creates file and writes without leading newline when file does not exist', async () => {
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');
      expect(fs.existsSync(memFile)).toBe(false);

      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PATCH',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ append: 'First entry' }),
      });
      expect(res.status).toBe(204);

      expect(fs.readFileSync(memFile, 'utf8')).toBe('First entry');
    });

    it('multiple PATCHes accumulate correctly', async () => {
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');

      for (const text of ['A', 'B', 'C']) {
        await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
          method: 'PATCH',
          headers: {
            Authorization: AUTH_HEADER,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ append: text }),
        });
      }

      expect(fs.readFileSync(memFile, 'utf8')).toBe('A\nB\nC');
    });

    it('returns 400 for missing append field', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PATCH',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ other: 'field' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 401 without credentials', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ append: 'text' }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ── 405 Method Not Allowed ─────────────────────────────────────────────────

  describe('405 Method Not Allowed', () => {
    it('returns 405 with Allow header for POST /memory', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'POST',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'ignored' }),
      });
      expect(res.status).toBe(405);
      const allow = res.headers.get('Allow') ?? res.headers.get('allow') ?? '';
      expect(allow).toContain('GET');
      expect(allow).toContain('PUT');
      expect(allow).toContain('PATCH');
    });

    it('returns 405 for DELETE /memory (before auth check)', async () => {
      const res = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'DELETE',
        // No auth — 405 must be returned before 401 (no info leak)
      });
      expect(res.status).toBe(405);
    });
  });

  // ── Cross-group isolation ─────────────────────────────────────────────────

  describe('Cross-group isolation', () => {
    it('server uses authenticated user groupFolder, not client-supplied param', async () => {
      // Try to read another group's memory by appending query params or path
      // The server ignores any client-supplied group info
      const memFile = path.join(groupsDir, GROUP_FOLDER, 'CLAUDE.md');
      fs.writeFileSync(memFile, 'Only my data', 'utf8');

      // Attempt to supply a different group via query param (should be ignored)
      const res = await fetch(
        `http://localhost:${MEMORY_PORT}/memory?group=other-group`,
        {
          headers: { Authorization: AUTH_HEADER },
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string };
      // Must return the authenticated user's data, not any other group's
      expect(body.content).toBe('Only my data');
    });
  });

  // ── GET → PUT → GET roundtrip ─────────────────────────────────────────────

  describe('full roundtrip', () => {
    it('GET → PUT → GET returns updated content', async () => {
      // Initial GET — no file
      const get1 = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(get1.status).toBe(200);
      const body1 = await get1.json() as { content: string };
      expect(body1.content).toBe('');

      // PUT new content
      const put = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: '# Updated Memory' }),
      });
      expect(put.status).toBe(204);

      // GET again
      const get2 = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(get2.status).toBe(200);
      const body2 = await get2.json() as { content: string };
      expect(body2.content).toBe('# Updated Memory');
    });

    it('GET → PATCH → GET returns appended content', async () => {
      const put = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PUT',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: 'Base line' }),
      });
      expect(put.status).toBe(204);

      const patch = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        method: 'PATCH',
        headers: {
          Authorization: AUTH_HEADER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ append: 'Appended line' }),
      });
      expect(patch.status).toBe(204);

      const get = await fetch(`http://localhost:${MEMORY_PORT}/memory`, {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(get.status).toBe(200);
      const body = await get.json() as { content: string };
      expect(body.content).toBe('Base line\nAppended line');
    });
  });
});
