import { afterEach, describe, expect, it } from 'vitest';
import { SqliteKvStore } from '../../src/kv/sqlite';
import { ScopedKV, putMsgMap, getMsgMap } from '../../src/storage';

const stores: SqliteKvStore[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

function fresh(opts: { listLimit?: number } = {}): SqliteKvStore {
  // Each store gets its own private in-memory database; `:memory:` is
  // per-connection, so they cannot see each other's writes.
  const s = new SqliteKvStore(':memory:', { cleanupIntervalMs: 0, ...opts });
  stores.push(s);
  return s;
}

describe('SqliteKvStore CRUD', () => {
  it('put / get round-trips string values', async () => {
    const kv = fresh();
    await kv.put('foo', 'bar');
    expect(await kv.get('foo')).toBe('bar');
  });

  it('get returns null for missing key', async () => {
    const kv = fresh();
    expect(await kv.get('missing')).toBeNull();
  });

  it('get with type=json parses stored JSON', async () => {
    const kv = fresh();
    await kv.put('obj', JSON.stringify({ a: 1, b: 'two' }));
    expect(await kv.get<{ a: number; b: string }>('obj', { type: 'json' })).toEqual({
      a: 1,
      b: 'two',
    });
  });

  it('put overwrites existing value', async () => {
    const kv = fresh();
    await kv.put('k', 'v1');
    await kv.put('k', 'v2');
    expect(await kv.get('k')).toBe('v2');
  });

  it('delete removes key; subsequent get returns null', async () => {
    const kv = fresh();
    await kv.put('k', 'v');
    await kv.delete('k');
    expect(await kv.get('k')).toBeNull();
  });

  it('delete of non-existent key is a no-op', async () => {
    const kv = fresh();
    await expect(kv.delete('never-existed')).resolves.toBeUndefined();
  });
});

describe('SqliteKvStore TTL (lazy expiration)', () => {
  it('expirationTtl removes the value after the TTL elapses', async () => {
    const kv = fresh();
    await kv.put('temp', 'v', { expirationTtl: 0.1 });
    expect(await kv.get('temp')).toBe('v');
    await new Promise((r) => setTimeout(r, 150));
    expect(await kv.get('temp')).toBeNull();
  });

  it('list filters out expired keys', async () => {
    const kv = fresh();
    await kv.put('p:a', '1', { expirationTtl: 0.1 });
    await kv.put('p:b', '2');
    await new Promise((r) => setTimeout(r, 150));
    const r = await kv.list({ prefix: 'p:' });
    expect(r.keys.map((k) => k.name)).toEqual(['p:b']);
  });

  it('cleanup() purges all expired rows and returns the count', async () => {
    const kv = fresh();
    await kv.put('x1', 'v', { expirationTtl: 0.05 });
    await kv.put('x2', 'v', { expirationTtl: 0.05 });
    await kv.put('keep', 'v');
    await new Promise((r) => setTimeout(r, 100));
    expect(kv.cleanup()).toBe(2);
    expect(await kv.get('keep')).toBe('v');
  });
});

describe('SqliteKvStore list semantics', () => {
  it('returns keys in alphabetical order, prefix-filtered', async () => {
    const kv = fresh();
    await kv.put('p:c', '1');
    await kv.put('p:a', '2');
    await kv.put('p:b', '3');
    await kv.put('other:x', '4');
    const r = await kv.list({ prefix: 'p:' });
    expect(r.keys.map((k) => k.name)).toEqual(['p:a', 'p:b', 'p:c']);
    expect(r.list_complete).toBe(true);
  });

  it('paginates when result exceeds listLimit, exposes cursor', async () => {
    const kv = fresh({ listLimit: 2 });
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
  });

  it('upper bound: prefix scan does not bleed into the next prefix', async () => {
    const kv = fresh();
    // ':' (0x3A) is followed by ';' (0x3B) in ASCII — verify the upper-terminator
    // computation doesn't include keys that start with 'tenant;' or 'tenants:'.
    await kv.put('tenant:a', '1');
    await kv.put('tenant:b', '2');
    await kv.put('tenant;a', '3');
    await kv.put('tenants:a', '4');
    const r = await kv.list({ prefix: 'tenant:' });
    expect(r.keys.map((k) => k.name)).toEqual(['tenant:a', 'tenant:b']);
  });

  it('empty prefix returns all live keys', async () => {
    const kv = fresh();
    await kv.put('a', '1');
    await kv.put('b', '2');
    const r = await kv.list({ prefix: '' });
    expect(r.keys.length).toBe(2);
  });
});

describe('SqliteKvStore integrates with ScopedKV', () => {
  it('msg-map round-trip through ScopedKV', async () => {
    const skv = new ScopedKV(fresh(), 'tenant:7:');
    await putMsgMap(
      skv,
      '42',
      9999,
      { chatId: 100, userKey: 'uk-test', createdAt: 1234 },
      60,
    );
    expect(await getMsgMap(skv, '42', 9999)).toEqual({
      chatId: 100,
      userKey: 'uk-test',
      createdAt: 1234,
    });
  });

  it('two scopes sharing a backend are isolated', async () => {
    const kv = fresh();
    const a = new ScopedKV(kv, 'tenant:A:');
    const b = new ScopedKV(kv, 'tenant:B:');
    await a.put('shared', 'A');
    await b.put('shared', 'B');
    expect(await a.getString('shared')).toBe('A');
    expect(await b.getString('shared')).toBe('B');
  });
});

describe('SqliteKvStore lifecycle', () => {
  it('close() prevents further use', async () => {
    const kv = new SqliteKvStore(':memory:', { cleanupIntervalMs: 0 });
    await kv.put('k', 'v');
    kv.close();
    await expect(kv.get('k')).rejects.toBeDefined();
  });
});
