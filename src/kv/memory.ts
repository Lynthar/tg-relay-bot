import type { KvStore, KvListResult } from '../storage';

const DEFAULT_LIST_LIMIT = 1000;

interface Entry {
  value: string;
  expiresAt?: number;
}

export interface MemoryKvOptions {
  listLimit?: number;
}

// Reference KvStore impl with zero external deps. Used by tests and as the canonical
// behaviour spec for other backends. Lazy TTL expiration on read; pagination via
// keyset (cursor = last key of previous page).
export class MemoryKvStore implements KvStore {
  private readonly store = new Map<string, Entry>();
  private readonly listLimit: number;

  constructor(opts: MemoryKvOptions = {}) {
    this.listLimit = opts.listLimit ?? DEFAULT_LIST_LIMIT;
  }

  get(key: string): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
  async get(key: string, options?: { type: 'json' }): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return options?.type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const expiresAt =
      options?.expirationTtl !== undefined
        ? Date.now() + options.expirationTtl * 1000
        : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; cursor?: string }): Promise<KvListResult> {
    const prefix = options?.prefix ?? '';
    const after = options?.cursor;
    const now = Date.now();
    const matched: string[] = [];
    for (const [k, v] of this.store) {
      if (v.expiresAt !== undefined && now >= v.expiresAt) {
        this.store.delete(k);
        continue;
      }
      if (!k.startsWith(prefix)) continue;
      if (after !== undefined && k <= after) continue;
      matched.push(k);
    }
    matched.sort();
    const hasMore = matched.length > this.listLimit;
    const page = hasMore ? matched.slice(0, this.listLimit) : matched;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: !hasMore,
      ...(hasMore ? { cursor: page[page.length - 1] } : {}),
    };
  }

  // Test helper — not part of the KvStore contract.
  clear(): void {
    this.store.clear();
  }
}
