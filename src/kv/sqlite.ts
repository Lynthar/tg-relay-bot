import Database from 'better-sqlite3';
import type { KvStore, KvListResult } from '../storage';

const DEFAULT_LIST_LIMIT = 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Any byte sequence in our keys is plain ASCII / UTF-8 of ASCII-derived strings,
// so appending U+FFFF (UTF-8: EF BF BF) yields a value strictly greater than any
// real key sharing the prefix — usable as an exclusive upper bound for range scans.
const HIGH_TERMINATOR = '￿';

export interface SqliteKvOptions {
  listLimit?: number;
  // 0 disables the background cleanup timer (e.g. for tests).
  cleanupIntervalMs?: number;
}

interface KvRow {
  value: string;
  expires_at: number | null;
}

interface KeyRow {
  key: string;
}

export class SqliteKvStore implements KvStore {
  private readonly db: Database.Database;
  private readonly listLimit: number;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly stmt: {
    get: Database.Statement;
    put: Database.Statement;
    delete: Database.Statement;
    listInitial: Database.Statement;
    listAfter: Database.Statement;
    cleanup: Database.Statement;
  };

  constructor(path: string, opts: SqliteKvOptions = {}) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_kv_expires_at
        ON kv(expires_at) WHERE expires_at IS NOT NULL;
    `);

    this.listLimit = opts.listLimit ?? DEFAULT_LIST_LIMIT;

    this.stmt = {
      get: this.db.prepare('SELECT value, expires_at FROM kv WHERE key = ?'),
      put: this.db.prepare(
        'INSERT INTO kv(key, value, expires_at) VALUES(?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      ),
      delete: this.db.prepare('DELETE FROM kv WHERE key = ?'),
      // Inclusive on the lower bound — used for the first page of a prefix scan.
      listInitial: this.db.prepare(
        'SELECT key FROM kv WHERE key >= ? AND key < ? ' +
          'AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?',
      ),
      // Exclusive on the lower bound — used to continue after a cursor.
      listAfter: this.db.prepare(
        'SELECT key FROM kv WHERE key > ? AND key < ? ' +
          'AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?',
      ),
      cleanup: this.db.prepare(
        'DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?',
      ),
    };

    const interval = opts.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    if (interval > 0) {
      this.cleanupTimer = setInterval(() => {
        try {
          this.cleanup();
        } catch {
          // Never crash the timer — next tick will retry.
        }
      }, interval);
      this.cleanupTimer.unref();
    }
  }

  get(key: string): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
  async get(key: string, options?: { type: 'json' }): Promise<unknown> {
    const row = this.stmt.get.get(key) as KvRow | undefined;
    if (!row) return null;
    if (row.expires_at !== null && Date.now() >= row.expires_at) {
      this.stmt.delete.run(key);
      return null;
    }
    return options?.type === 'json' ? JSON.parse(row.value) : row.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const expiresAt =
      options?.expirationTtl !== undefined
        ? Date.now() + options.expirationTtl * 1000
        : null;
    this.stmt.put.run(key, value, expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.stmt.delete.run(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<KvListResult> {
    const prefix = options?.prefix ?? '';
    const upper = prefix + HIGH_TERMINATOR;
    const now = Date.now();
    const limit = this.listLimit + 1;
    const rows = (
      options?.cursor !== undefined
        ? this.stmt.listAfter.all(options.cursor, upper, now, limit)
        : this.stmt.listInitial.all(prefix, upper, now, limit)
    ) as KeyRow[];
    const hasMore = rows.length > this.listLimit;
    const page = hasMore ? rows.slice(0, this.listLimit) : rows;
    return {
      keys: page.map((r) => ({ name: r.key })),
      list_complete: !hasMore,
      ...(hasMore ? { cursor: page[page.length - 1].key } : {}),
    };
  }

  cleanup(): number {
    return this.stmt.cleanup.run(Date.now()).changes;
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.db.close();
  }
}
