import { describe, expect, it } from 'vitest';
import {
  ScopedKV,
  type KvStore,
  type KvListResult,
  putMsgMap,
  getMsgMap,
} from '../../src/storage';

// Reference KvStore impl with no Cloudflare/Miniflare deps — proves the abstraction is portable.
// Does not simulate cursor pagination (ignores `cursor`, always returns list_complete: true);
// cursor correctness must be verified against a real backend.
class InMemoryKvStore implements KvStore {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  get(key: string): Promise<string | null>;
  get<T = unknown>(key: string, options: { type: 'json' }): Promise<T | null>;
  async get(key: string, options?: { type: 'json' }): Promise<any> {
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
    const now = Date.now();
    const names: string[] = [];
    for (const [k, v] of this.store) {
      if (v.expiresAt !== undefined && now >= v.expiresAt) {
        this.store.delete(k);
        continue;
      }
      if (k.startsWith(prefix)) names.push(k);
    }
    names.sort();
    return { keys: names.map((name) => ({ name })), list_complete: true };
  }
}

describe('KvStore abstraction (no Cloudflare deps)', () => {
  it('InMemoryKvStore satisfies the KvStore contract', () => {
    const kv: KvStore = new InMemoryKvStore();
    expect(kv).toBeDefined();
  });

  it('ScopedKV.get/put/delete round-trip', async () => {
    const scoped = new ScopedKV(new InMemoryKvStore(), 'tenant:42:');
    await scoped.put('foo', 'bar');
    expect(await scoped.getString('foo')).toBe('bar');
    await scoped.delete('foo');
    expect(await scoped.getString('foo')).toBeNull();
  });

  it('ScopedKV prefix isolates two scopes sharing one backend', async () => {
    const kv = new InMemoryKvStore();
    const a = new ScopedKV(kv, 'tenant:A:');
    const b = new ScopedKV(kv, 'tenant:B:');
    await a.put('shared', 'A');
    await b.put('shared', 'B');
    expect(await a.getString('shared')).toBe('A');
    expect(await b.getString('shared')).toBe('B');
  });

  it('ScopedKV.list filters by scope', async () => {
    const kv = new InMemoryKvStore();
    const a = new ScopedKV(kv, 'tenant:A:');
    const b = new ScopedKV(kv, 'tenant:B:');
    await a.put('k1', '1');
    await a.put('k2', '2');
    await b.put('k1', '3');
    expect((await a.list()).keys.length).toBe(2);
    expect((await b.list()).keys.length).toBe(1);
  });

  it('ScopedKV.list subPrefix narrows within a scope', async () => {
    const s = new ScopedKV(new InMemoryKvStore(), 'tenant:A:');
    await s.put('msg-map-1', 'x');
    await s.put('msg-map-2', 'y');
    await s.put('block-1', 'z');
    expect((await s.list('msg-map-')).keys.length).toBe(2);
    expect((await s.list('block-')).keys.length).toBe(1);
  });

  it('ScopedKV.getJson parses stored JSON', async () => {
    const s = new ScopedKV(new InMemoryKvStore(), 'p:');
    await s.put('obj', JSON.stringify({ a: 1, b: 'two' }));
    expect(await s.getJson<{ a: number; b: string }>('obj')).toEqual({
      a: 1,
      b: 'two',
    });
  });

  it('expirationTtl removes the value after the TTL elapses', async () => {
    const s = new ScopedKV(new InMemoryKvStore(), 'p:');
    await s.put('temp', 'v', 0.1);
    expect(await s.getString('temp')).toBe('v');
    await new Promise((r) => setTimeout(r, 200));
    expect(await s.getString('temp')).toBeNull();
  });

  it('higher-level putMsgMap / getMsgMap work end-to-end', async () => {
    const s = new ScopedKV(new InMemoryKvStore(), 'tenant:7:');
    await putMsgMap(
      s,
      '42',
      9999,
      { chatId: 100, userKey: 'uk-test', createdAt: 1234 },
      60,
    );
    expect(await getMsgMap(s, '42', 9999)).toEqual({
      chatId: 100,
      userKey: 'uk-test',
      createdAt: 1234,
    });
  });
});
