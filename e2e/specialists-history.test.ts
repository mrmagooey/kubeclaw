/**
 * E2E test for /specialists history command.
 *
 * Namespace: kubeclaw-e2e-specialists-history  Port: 14141
 *
 * Uses a real sql.js in-memory database to verify the full data path:
 *   recordSpecialistUsage() → specialist_usage table → getSpecialistUsage()
 *   → formatted reply via formatSpecialistsHistoryForE2e()
 *
 * Acceptance criteria covered:
 *   AC1 — success + error invocations appear newest-first, correct format
 *   AC2 — empty group returns "No specialist history for this group."
 *   AC3 — default limit is 10; older rows not included
 *   AC4 — numeric limit arg; 0 and non-numeric fall back to 10
 *
 * No Kubernetes or mock LLM server required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  _initTestDatabase,
  recordSpecialistUsage,
  getSpecialistUsage,
  db,
  type SpecialistUsageRow,
} from '../src/db.js';

const GROUP = 'kubeclaw-e2e-specialists-history';

beforeAll(async () => {
  await _initTestDatabase();
});

/** Mirror of the formatting logic in channel-runner.ts */
function formatSpecialistsHistoryForE2e(
  rows: SpecialistUsageRow[],
): string {
  if (rows.length === 0) return 'No specialist history for this group.';
  return rows
    .map((r) => {
      const tag = r.status === 'success' ? '[ok]' : '[error]';
      const dur = r.durationMs != null ? `${r.durationMs}ms` : '?ms';
      const d = new Date(r.usedAt);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return `${tag} @${r.specialistName} (${dur}) ${hh}:${mm}Z`;
    })
    .join('\n');
}

const DEFAULT_LIMIT = 10;

function getHistory(
  groupFolder: string,
  rawLimit?: string,
): string {
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = parseInt(rawLimit, 10);
    if (!isNaN(parsed) && parsed > 0) limit = parsed;
  }
  const rows = getSpecialistUsage(groupFolder, limit);
  return formatSpecialistsHistoryForE2e(rows);
}

// ─── AC2: empty group ─────────────────────────────────────────────────────────

describe('/specialists history e2e — AC2: empty group', () => {
  it('returns no-history message when group has no rows', () => {
    expect(getHistory(GROUP)).toBe('No specialist history for this group.');
  });
});

// ─── AC1: success + error invocations ────────────────────────────────────────

describe('/specialists history e2e — AC1: success + error invocations', () => {
  const ECHO_GROUP = `${GROUP}-ac1`;

  beforeAll(() => {
    // Older success row
    db.run(
      `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
      [ECHO_GROUP, 'echo', 1716249400000, 150, 'success'],
    );
    // Newer error row
    db.run(
      `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
      [ECHO_GROUP, 'echo', 1716249600000, 200, 'error'],
    );
  });

  it('lists both invocations newest-first in correct format', () => {
    const reply = getHistory(ECHO_GROUP);
    const lines = reply.split('\n');
    expect(lines).toHaveLength(2);
    // Newest first: error row
    expect(lines[0]).toMatch(/^\[error\] @echo \(\d+ms\) \d{2}:\d{2}Z$/);
    // Older success row
    expect(lines[1]).toMatch(/^\[ok\] @echo \(\d+ms\) \d{2}:\d{2}Z$/);
  });

  it('also works via recordSpecialistUsage write path', () => {
    const REC_GROUP = `${GROUP}-rec`;
    recordSpecialistUsage({
      groupFolder: REC_GROUP,
      specialistName: 'echo',
      durationMs: 42,
      status: 'success',
    });
    recordSpecialistUsage({
      groupFolder: REC_GROUP,
      specialistName: 'echo',
      durationMs: 77,
      status: 'error',
    });
    const reply = getHistory(REC_GROUP);
    expect(reply).toContain('[error]');
    expect(reply).toContain('[ok]');
    expect(reply).toContain('@echo');
  });
});

// ─── AC3: default limit 10 ───────────────────────────────────────────────────

describe('/specialists history e2e — AC3: default limit 10', () => {
  const LIMIT_GROUP = `${GROUP}-ac3`;

  beforeAll(() => {
    for (let i = 1; i <= 15; i++) {
      db.run(
        `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
        [LIMIT_GROUP, `spec${i}`, i * 1000, 10, 'success'],
      );
    }
  });

  it('returns at most 10 rows by default (oldest 5 excluded)', () => {
    const reply = getHistory(LIMIT_GROUP);
    const lines = reply.split('\n').filter(Boolean);
    expect(lines).toHaveLength(10);
    // Newest is spec15
    expect(lines[0]).toContain('@spec15');
    // spec6 through spec15 included; spec1 through spec5 excluded
    // Use exact line matching to avoid @spec1 matching @spec10..@spec15
    const specNames = lines.map((l) => {
      const m = /@(\w+)/.exec(l);
      return m ? m[1] : '';
    });
    expect(specNames).not.toContain('spec5');
    expect(specNames).not.toContain('spec1');
  });
});

// ─── AC4: limit arg ───────────────────────────────────────────────────────────

describe('/specialists history e2e — AC4: limit arg', () => {
  const ARG_GROUP = `${GROUP}-ac4`;

  beforeAll(() => {
    for (let i = 1; i <= 8; i++) {
      db.run(
        `INSERT INTO specialist_usage (group_folder, specialist_name, used_at, duration_ms, status) VALUES (?, ?, ?, ?, ?)`,
        [ARG_GROUP, `s${i}`, i * 1000, 5, 'success'],
      );
    }
  });

  it('/specialists history 5 returns at most 5 rows', () => {
    const reply = getHistory(ARG_GROUP, '5');
    expect(reply.split('\n').filter(Boolean)).toHaveLength(5);
  });

  it('/specialists history 0 falls back to 10 (returns all 8)', () => {
    const reply = getHistory(ARG_GROUP, '0');
    expect(reply.split('\n').filter(Boolean)).toHaveLength(8);
  });

  it('/specialists history abc falls back to 10 (returns all 8)', () => {
    const reply = getHistory(ARG_GROUP, 'abc');
    expect(reply.split('\n').filter(Boolean)).toHaveLength(8);
  });
});
