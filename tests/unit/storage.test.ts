import { describe, expect, it } from 'vitest';
import { freshScope } from '../helpers';
import { getLegacyMsgMap, getMsgMap, putMsgMap } from '../../src/storage';

describe('ScopedKV', () => {
  it('listScoped returns names relative to the scope prefix', async () => {
    const k = freshScope();
    await k.put('block-aaa', '1');
    await k.put('block-bbb', '1');
    await k.put('rate-ccc', '1');
    const res = await k.listScoped('block-');
    expect(res.names.sort()).toEqual(['block-aaa', 'block-bbb']);
    expect(res.complete).toBe(true);
  });
});

describe('msg-map CRUD', () => {
  it('same message_id under different admins does not collide', async () => {
    const k = freshScope();
    await putMsgMap(k, '111', 500, { chatId: 1, createdAt: 1 }, 3600);
    await putMsgMap(k, '222', 500, { chatId: 2, createdAt: 2 }, 3600);
    expect((await getMsgMap(k, '111', 500))?.chatId).toBe(1);
    expect((await getMsgMap(k, '222', 500))?.chatId).toBe(2);
  });

  it('getLegacyMsgMap reads the pre-admin-dimension key format', async () => {
    const k = freshScope();
    await k.put('msg-map-42', JSON.stringify({ chatId: 9, userKey: 'uk', createdAt: 3 }));
    expect((await getLegacyMsgMap(k, 42))?.chatId).toBe(9);
    expect(await getMsgMap(k, '111', 42)).toBeNull();
  });
});
