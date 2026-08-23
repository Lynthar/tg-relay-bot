import { describe, expect, it } from 'vitest';
import {
  ScopedKV,
  type KvStore,
  putMsgMap,
  getMsgMap,
} from '../../src/storage';
import { MemoryKvStore } from '../../src/kv/memory';

describe('KvStore abstraction (no Cloudflare deps)', () => {
  it('MemoryKvStore satisfies the KvStore contract', () => {
    const kv: KvStore = new MemoryKvStore();
    expect(kv).toBeDefined();
  });

  it('ScopedKV.get/put/delete round-trip', async () => {
    const scoped = new ScopedKV(new MemoryKvStore(), 'tenant:42:');
    await scoped.put('foo', 'bar');
    expect(await scoped.getString('foo')).toBe('bar');
    await scoped.delete('foo');
    expect(await scoped.getString('foo')).toBeNull();
  });

  it('ScopedKV prefix isolates two scopes sharing one backend', async () => {
    const kv = new MemoryKvStore();
    const a = new ScopedKV(kv, 'tenant:A:');
    const b = new ScopedKV(kv, 'tenant:B:');
    await a.put('shared', 'A');
    await b.put('shared', 'B');
    expect(await a.getString('shared')).toBe('A');
    expect(await b.getString('shared')).toBe('B');
  });

  it('ScopedKV.list filters by scope', async () => {
    const kv = new MemoryKvStore();
    const a = new ScopedKV(kv, 'tenant:A:');
    const b = new ScopedKV(kv, 'tenant:B:');
    await a.put('k1', '1');
    await a.put('k2', '2');
    await b.put('k1', '3');
    expect((await a.list()).keys.length).toBe(2);
    expect((await b.list()).keys.length).toBe(1);
  });

  it('ScopedKV.list subPrefix narrows within a scope', async () => {
    const s = new ScopedKV(new MemoryKvStore(), 'tenant:A:');
    await s.put('msg-map-1', 'x');
    await s.put('msg-map-2', 'y');
    await s.put('block-1', 'z');
    expect((await s.list('msg-map-')).keys.length).toBe(2);
    expect((await s.list('block-')).keys.length).toBe(1);
  });

  it('ScopedKV.getJson parses stored JSON', async () => {
    const s = new ScopedKV(new MemoryKvStore(), 'p:');
    await s.put('obj', JSON.stringify({ a: 1, b: 'two' }));
    expect(await s.getJson<{ a: number; b: string }>('obj')).toEqual({
      a: 1,
      b: 'two',
    });
  });

  it('expirationTtl removes the value after the TTL elapses', async () => {
    const s = new ScopedKV(new MemoryKvStore(), 'p:');
    await s.put('temp', 'v', 0.1);
    expect(await s.getString('temp')).toBe('v');
    await new Promise((r) => setTimeout(r, 200));
    expect(await s.getString('temp')).toBeNull();
  });

  it('higher-level putMsgMap / getMsgMap work end-to-end', async () => {
    const s = new ScopedKV(new MemoryKvStore(), 'tenant:7:');
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

  describe('MemoryKvStore.list pagination', () => {
    it('returns list_complete:false + cursor when result exceeds listLimit', async () => {
      const kv = new MemoryKvStore({ listLimit: 2 });
      await kv.put('a', '1');
      await kv.put('b', '2');
      await kv.put('c', '3');
      await kv.put('d', '4');
      const page1 = await kv.list({ prefix: '' });
      expect(page1.keys.map((k) => k.name)).toEqual(['a', 'b']);
      expect(page1.list_complete).toBe(false);
      expect(page1.cursor).toBe('b');
      const page2 = await kv.list({ prefix: '', cursor: page1.cursor });
      expect(page2.keys.map((k) => k.name)).toEqual(['c', 'd']);
      expect(page2.list_complete).toBe(true);
      expect(page2.cursor).toBeUndefined();
    });

    it('honors prefix bounds across paged results', async () => {
      const kv = new MemoryKvStore({ listLimit: 2 });
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
  });
});
