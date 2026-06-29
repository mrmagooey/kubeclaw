import { describe, it, expect, vi } from 'vitest';
import { capRows, isAuthorized, buildToolHandlers, buildRoleBootstrapSql, SAFE_IDENTIFIER_RE } from './server.js';
import type { QueryPool } from './server.js';

describe('capRows', () => {
  it('truncates to the max and flags truncation', () => {
    expect(capRows([1, 2, 3], 2)).toEqual({ rows: [1, 2], truncated: true });
    expect(capRows([1], 2)).toEqual({ rows: [1], truncated: false });
    expect(capRows([1, 2], 2)).toEqual({ rows: [1, 2], truncated: false });
  });

  it('returns all rows when max is not a positive finite number', () => {
    const rows = [1, 2, 3];
    // max <= 0
    expect(capRows(rows, 0)).toEqual({ rows, truncated: false });
    expect(capRows(rows, -1)).toEqual({ rows, truncated: false });
    // NaN
    expect(capRows(rows, NaN)).toEqual({ rows, truncated: false });
    // Infinity
    expect(capRows(rows, Infinity)).toEqual({ rows, truncated: false });
    expect(capRows(rows, -Infinity)).toEqual({ rows, truncated: false });
  });
});

describe('isAuthorized', () => {
  it('accepts the exact bearer token, rejects otherwise', () => {
    expect(isAuthorized('Bearer abc', 'abc')).toBe(true);
    expect(isAuthorized('Bearer abc', 'xyz')).toBe(false);
    expect(isAuthorized(undefined, 'abc')).toBe(false);
    expect(isAuthorized('abc', 'abc')).toBe(false);
  });
});

// ─── buildToolHandlers pool-routing tests ─────────────────────────────────────

/**
 * Creates a fake QueryPool that records every SQL string passed to .query()
 * and returns an empty row set.
 */
function makeFakePool(): QueryPool & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push(sql);
      return { rows: [] };
    },
  };
}

describe('buildToolHandlers', () => {
  const defaultOpts = {
    maxRows: 1000,
    statementTimeoutMs: 5000,
  };

  it('routes "query" to the ro pool', async () => {
    const roPool = makeFakePool();
    const rwPool = makeFakePool();
    const handle = buildToolHandlers({ roPool, rwPool, ...defaultOpts });

    await handle({ name: 'query', arguments: { sql: 'SELECT 1' } });

    // ro pool should have been called (setup + user sql)
    expect(roPool.calls.some((s) => s.includes('SELECT 1'))).toBe(true);
    // rw pool should NOT have been touched
    expect(rwPool.calls).toHaveLength(0);
  });

  it('routes "execute" to the rw pool', async () => {
    const roPool = makeFakePool();
    const rwPool = makeFakePool();
    const handle = buildToolHandlers({ roPool, rwPool, ...defaultOpts });

    await handle({ name: 'execute', arguments: { sql: 'INSERT INTO t VALUES (1)' } });

    // rw pool should have been called
    expect(rwPool.calls.some((s) => s.includes('INSERT INTO t VALUES (1)'))).toBe(true);
    // ro pool should NOT have been touched
    expect(roPool.calls).toHaveLength(0);
  });

  it('applies default_transaction_read_only on the ro pool (defence-in-depth)', async () => {
    const roPool = makeFakePool();
    const rwPool = makeFakePool();
    const handle = buildToolHandlers({ roPool, rwPool, ...defaultOpts });

    await handle({ name: 'query', arguments: { sql: 'SELECT 1' } });

    // The setup query for ro should include default_transaction_read_only
    expect(
      roPool.calls.some((s) => s.includes('default_transaction_read_only')),
    ).toBe(true);
  });

  it('does NOT apply default_transaction_read_only on the rw pool', async () => {
    const roPool = makeFakePool();
    const rwPool = makeFakePool();
    const handle = buildToolHandlers({ roPool, rwPool, ...defaultOpts });

    await handle({ name: 'execute', arguments: { sql: 'INSERT INTO t VALUES (1)' } });

    expect(
      rwPool.calls.some((s) => s.includes('default_transaction_read_only')),
    ).toBe(false);
  });

  it('throws on unknown tool name', async () => {
    const roPool = makeFakePool();
    const rwPool = makeFakePool();
    const handle = buildToolHandlers({ roPool, rwPool, ...defaultOpts });

    await expect(
      handle({ name: 'drop_tables', arguments: { sql: 'DROP TABLE users' } }),
    ).rejects.toThrow('unknown tool: drop_tables');
  });

  it('throws when sql argument is missing', async () => {
    const roPool = makeFakePool();
    const rwPool = makeFakePool();
    const handle = buildToolHandlers({ roPool, rwPool, ...defaultOpts });

    await expect(
      handle({ name: 'query', arguments: {} }),
    ).rejects.toThrow('"sql" argument');
  });

  it('respects maxRows cap in the returned content', async () => {
    const bigRows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const roPool: QueryPool = {
      async query(sql: string) {
        // ignore setup query, return big result on user sql
        if (sql.includes('SELECT')) return { rows: bigRows };
        return { rows: [] };
      },
    };
    const rwPool = makeFakePool();
    const handle = buildToolHandlers({ roPool, rwPool, maxRows: 3, statementTimeoutMs: 5000 });

    const result = await handle({ name: 'query', arguments: { sql: 'SELECT * FROM t' } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.truncated).toBe(true);
  });
});

describe('buildRoleBootstrapSql', () => {
  it('grants SELECT and future-table SELECT to the ro role, no write grants', () => {
    const sql = buildRoleBootstrapSql('kubeclaw_ro');
    expect(sql).toMatch(/GRANT SELECT ON ALL TABLES IN SCHEMA public TO kubeclaw_ro/i);
    expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kubeclaw_ro/i);
    expect(sql).toMatch(/GRANT USAGE ON SCHEMA public TO kubeclaw_ro/i);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|ALL PRIVILEGES/i);
  });
  it('grants CONNECT ON DATABASE kubeclaw to the ro role', () => {
    const sql = buildRoleBootstrapSql('kubeclaw_ro');
    expect(sql).toMatch(/GRANT CONNECT ON DATABASE kubeclaw TO kubeclaw_ro/i);
  });
  it('rejects an unsafe role identifier', () => {
    expect(() => buildRoleBootstrapSql('ro; DROP DATABASE x')).toThrow();
  });
});

describe('SAFE_IDENTIFIER_RE (PG_RO_USER guard)', () => {
  it('accepts valid lowercase identifiers', () => {
    expect(SAFE_IDENTIFIER_RE.test('kubeclaw_ro')).toBe(true);
    expect(SAFE_IDENTIFIER_RE.test('ro')).toBe(true);
    expect(SAFE_IDENTIFIER_RE.test('_ro_user_2')).toBe(true);
  });
  it('rejects identifiers with unsafe characters (SQL injection vectors)', () => {
    // semicolons, quotes, hyphens, spaces, uppercase — all rejected
    expect(SAFE_IDENTIFIER_RE.test('ro; DROP DATABASE x')).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test('"admin"')).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test('ro-user')).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test('ro user')).toBe(false);
    expect(SAFE_IDENTIFIER_RE.test('Kubeclaw_RO')).toBe(false);
  });
  it('rejects identifiers that start with a digit', () => {
    expect(SAFE_IDENTIFIER_RE.test('1ro')).toBe(false);
  });
});
