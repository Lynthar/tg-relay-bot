import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryKvStore } from '../../src/kv/memory';
import { SqliteKvStore } from '../../src/kv/sqlite';
import {
  MIN_EXPIRATION_TTL_SEC,
  ScopedKV,
  getMsgMap,
  putMsgMap,
  type KvStore,
} from '../../src/storage';

// One table, both local backends: src/kv/memory.ts calls itself the canonical behaviour
// spec for the others, and this is what holds them to it. Anything specific to one backend
// (SQLite's cleanup() and close()) stays in kv-sqlite.test.ts.
type MakeKv = (opts?: { listLimit?: number }) => KvStore;

const openStores: SqliteKvStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (openStores.length > 0) openStores.pop()?.close();
});

const backends: [string, MakeKv][] = [
  ['memory', (opts = {}) => new MemoryKvStore(opts)],
  [
    'sqlite',
    (opts = {}) => {
      // Each store gets its own private in-memory database; `:memory:` is per-connection,
      // so two stores cannot see each other's writes.
      const s = new SqliteKvStore(':memory:', { cleanupIntervalMs: 0, ...opts });
      openStores.push(s);
      return s;
    },
  ],
];

// Advances the mocked clock past a TTL written with the minimum legal value.
function elapsePastMinTtl(): void {
  vi.setSystemTime(Date.now() + (MIN_EXPIRATION_TTL_SEC + 1) * 1000);
}

describe.each(backends)('KvStore contract (%s)', (_name, makeKv) => {
  it('put / get round-trips a string value', async () => {
    const kv = makeKv();
    await kv.put('foo', 'bar');
    expect(await kv.get('foo')).toBe('bar');
  });

  it('get returns null for a missing key', async () => {
    expect(await makeKv().get('missing')).toBeNull();
  });

  it('get with type=json parses the stored value', async () => {
    const kv = makeKv();
    await kv.put('obj', JSON.stringify({ a: 1, b: 'two' }));
    expect(await kv.get<{ a: number; b: string }>('obj', { type: 'json' })).toEqual({
      a: 1,
      b: 'two',
    });
  });

  it('put overwrites an existing value', async () => {
    const kv = makeKv();
    await kv.put('k', 'v1');
    await kv.put('k', 'v2');
    expect(await kv.get('k')).toBe('v2');
  });

  it('delete removes the key, and deleting a missing key is a no-op', async () => {
    const kv = makeKv();
    await kv.put('k', 'v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
    await expect(kv.delete('never-existed')).resolves.toBeUndefined();
  });

  it('list returns prefix-filtered keys in alphabetical order', async () => {
    const kv = makeKv();
    await kv.put('p:c', '1');
    await kv.put('p:a', '2');
    await kv.put('p:b', '3');
    await kv.put('other:x', '4');
    const r = await kv.list({ prefix: 'p:' });
    expect(r.keys.map((k) => k.name)).toEqual(['p:a', 'p:b', 'p:c']);
    expect(r.list_complete).toBe(true);
  });

  it('list with an empty prefix returns every live key', async () => {
    const kv = makeKv();
    await kv.put('a', '1');
    await kv.put('b', '2');
    expect((await kv.list({ prefix: '' })).keys.length).toBe(2);
  });

  it('a prefix scan does not bleed into the neighbouring prefix', async () => {
    // ':' (0x3A) is followed by ';' (0x3B) in ASCII — neither 'tenant;a' nor 'tenants:a'
    // may surface under the prefix 'tenant:'.
    const kv = makeKv();
    await kv.put('tenant:a', '1');
    await kv.put('tenant:b', '2');
    await kv.put('tenant;a', '3');
    await kv.put('tenants:a', '4');
    const r = await kv.list({ prefix: 'tenant:' });
    expect(r.keys.map((k) => k.name)).toEqual(['tenant:a', 'tenant:b']);
  });

  it('list paginates at listLimit and resumes from the cursor', async () => {
    const kv = makeKv({ listLimit: 2 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) await kv.put(k, '1');
    const page1 = await kv.list({ prefix: '' });
    expect(page1.keys.map((k) => k.name)).toEqual(['a', 'b']);
    expect(page1.list_complete).toBe(false);
    expect(page1.cursor).toBe('b');
    const page2 = await kv.list({ prefix: '', cursor: page1.cursor });
    expect(page2.keys.map((k) => k.name)).toEqual(['c', 'd']);
    expect(page2.list_complete).toBe(false);
    expect(page2.cursor).toBe('d');
    const page3 = await kv.list({ prefix: '', cursor: page2.cursor });
    expect(page3.keys.map((k) => k.name)).toEqual(['e']);
    expect(page3.list_complete).toBe(true);
    expect(page3.cursor).toBeUndefined();
  });

  it('pagination honours the prefix bound across pages', async () => {
    const kv = makeKv({ listLimit: 2 });
    await kv.put('other:1', 'x');
    await kv.put('p:a', '1');
    await kv.put('p:b', '2');
    await kv.put('p:c', '3');
    await kv.put('z:later', 'y');
    const page1 = await kv.list({ prefix: 'p:' });
    expect(page1.keys.map((k) => k.name)).toEqual(['p:a', 'p:b']);
    expect(page1.list_complete).toBe(false);
    const page2 = await kv.list({ prefix: 'p:', cursor: page1.cursor });
    expect(page2.keys.map((k) => k.name)).toEqual(['p:c']);
    expect(page2.list_complete).toBe(true);
  });

  it('rejects an expirationTtl below the Cloudflare KV floor', async () => {
    const kv = makeKv();
    await expect(kv.put('k', 'v', { expirationTtl: 30 })).rejects.toThrow(RangeError);
    expect(await kv.get('k')).toBeNull();
  });

  it('expirationTtl removes the value once it elapses', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const kv = makeKv();
    await kv.put('temp', 'v', { expirationTtl: MIN_EXPIRATION_TTL_SEC });
    expect(await kv.get('temp')).toBe('v');
    elapsePastMinTtl();
    expect(await kv.get('temp')).toBeNull();
  });

  it('list omits expired keys', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const kv = makeKv();
    await kv.put('p:a', '1', { expirationTtl: MIN_EXPIRATION_TTL_SEC });
    await kv.put('p:b', '2');
    elapsePastMinTtl();
    const r = await kv.list({ prefix: 'p:' });
    expect(r.keys.map((k) => k.name)).toEqual(['p:b']);
  });

  it('ScopedKV round-trips get / put / delete under its prefix', async () => {
    const s = new ScopedKV(makeKv(), 'tenant:42:');
    await s.put('foo', 'bar');
    expect(await s.getString('foo')).toBe('bar');
    await s.delete('foo');
    expect(await s.getString('foo')).toBeNull();
  });

  it('ScopedKV.getJson parses a stored JSON value', async () => {
    const s = new ScopedKV(makeKv(), 'p:');
    await s.put('obj', JSON.stringify({ a: 1, b: 'two' }));
    expect(await s.getJson<{ a: number; b: string }>('obj')).toEqual({ a: 1, b: 'two' });
  });

  it('two ScopedKV scopes sharing one backend stay isolated', async () => {
    const kv = makeKv();
    const a = new ScopedKV(kv, 'tenant:A:');
    const b = new ScopedKV(kv, 'tenant:B:');
    await a.put('shared', 'A');
    await b.put('shared', 'B');
    expect(await a.getString('shared')).toBe('A');
    expect(await b.getString('shared')).toBe('B');
  });

  it('ScopedKV.list filters by scope and narrows by subPrefix', async () => {
    const kv = makeKv();
    const a = new ScopedKV(kv, 'tenant:A:');
    const b = new ScopedKV(kv, 'tenant:B:');
    await a.put('msg-map-1', 'x');
    await a.put('msg-map-2', 'y');
    await a.put('block-1', 'z');
    await b.put('msg-map-1', 'other');
    expect((await a.list()).keys.length).toBe(3);
    expect((await b.list()).keys.length).toBe(1);
    expect((await a.list('msg-map-')).keys.length).toBe(2);
    expect((await a.list('block-')).keys.length).toBe(1);
  });

  it('msg-map round-trips through ScopedKV', async () => {
    const s = new ScopedKV(makeKv(), 'tenant:7:');
    await putMsgMap(s, '42', 9999, { chatId: 100, userKey: 'uk-test', createdAt: 1234 }, 60);
    expect(await getMsgMap(s, '42', 9999)).toEqual({
      chatId: 100,
      userKey: 'uk-test',
      createdAt: 1234,
    });
  });
});
