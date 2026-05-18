import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { ScopedKV, getMsgMap, putMsgMap } from '../../src/storage';

const fresh = (): ScopedKV => new ScopedKV(env.nfd, `test:st:${crypto.randomUUID()}:`);

describe('ScopedKV', () => {
  it('isolates two scopes for the same logical key', async () => {
    const a = fresh();
    const b = fresh();
    await a.put('shared', 'A');
    await b.put('shared', 'B');
    expect(await a.getString('shared')).toBe('A');
    expect(await b.getString('shared')).toBe('B');
  });

  it('list returns only keys in own scope', async () => {
    const a = fresh();
    const b = fresh();
    await a.put('k1', '1');
    await a.put('k2', '2');
    await b.put('k1', '3');
    expect((await a.list()).keys.length).toBe(2);
    expect((await b.list()).keys.length).toBe(1);
  });

  it('list with subPrefix filters', async () => {
    const k = fresh();
    await k.put('foo-1', '1');
    await k.put('foo-2', '2');
    await k.put('bar-1', '3');
    expect((await k.list('foo-')).keys.length).toBe(2);
    expect((await k.list('bar-')).keys.length).toBe(1);
  });

  it('getJson parses stored JSON', async () => {
    const k = fresh();
    await k.put('j', JSON.stringify({ a: 1, b: 'two' }));
    expect(await k.getJson<{ a: number; b: string }>('j')).toEqual({ a: 1, b: 'two' });
  });

  it('delete removes a key', async () => {
    const k = fresh();
    await k.put('x', '1');
    expect(await k.getString('x')).toBe('1');
    await k.delete('x');
    expect(await k.getString('x')).toBeNull();
  });
});

describe('msg-map CRUD', () => {
  it('put / get round trip', async () => {
    const k = fresh();
    await putMsgMap(k, 42, { chatId: 100, userKey: 'abc', createdAt: 12345 }, 3600);
    expect(await getMsgMap(k, 42)).toEqual({ chatId: 100, userKey: 'abc', createdAt: 12345 });
  });

  it('missing message returns null', async () => {
    const k = fresh();
    expect(await getMsgMap(k, 999)).toBeNull();
  });
});
