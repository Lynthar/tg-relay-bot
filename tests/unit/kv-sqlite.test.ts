import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSqliteStores, freshSqlite } from '../helpers';
import { SqliteKvStore } from '../../src/kv/sqlite';
import { MIN_EXPIRATION_TTL_SEC } from '../../src/storage';

// Behaviour shared with the other backend is in kv-contract.test.ts, which runs the same
// table against both. Only what SQLite alone offers belongs here.
afterEach(() => {
  vi.useRealTimers();
  closeSqliteStores();
});

describe('SqliteKvStore specifics', () => {
  it('cleanup() purges every expired row and returns the count', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const kv = freshSqlite();
    await kv.put('x1', 'v', { expirationTtl: MIN_EXPIRATION_TTL_SEC });
    await kv.put('x2', 'v', { expirationTtl: MIN_EXPIRATION_TTL_SEC });
    await kv.put('keep', 'v');
    vi.setSystemTime(Date.now() + (MIN_EXPIRATION_TTL_SEC + 1) * 1000);
    expect(kv.cleanup()).toBe(2);
    expect(await kv.get('keep')).toBe('v');
  });

  it('close() prevents further use', async () => {
    const kv = new SqliteKvStore(':memory:', { cleanupIntervalMs: 0 });
    await kv.put('k', 'v');
    kv.close();
    // better-sqlite3's error for any statement run on a closed connection.
    await expect(kv.get('k')).rejects.toThrow('The database connection is not open');
  });
});
