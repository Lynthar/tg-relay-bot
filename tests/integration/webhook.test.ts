import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  MANAGER_BOT_ID,
  buildUpdate,
  flush,
  getWebhook,
  nid,
  postWebhook,
  provisionTenant,
  tgMock,
} from '../helpers';
import { userKey } from '../../src/security';
import { ScopedKV } from '../../src/storage';

beforeAll(() => tgMock.install());
beforeEach(() => tgMock.reset());
afterAll(() => tgMock.uninstall());

describe('webhook auth (PLAN items 1, 2)', () => {
  it('GET /wh/{botId} returns 404 (item 2)', async () => {
    const res = await getWebhook(MANAGER_BOT_ID);
    expect(res.status).toBe(404);
  });

  it('POST without secret header returns 404 (item 1)', async () => {
    const res = await postWebhook(MANAGER_BOT_ID, null, { update_id: nid() });
    expect(res.status).toBe(404);
  });

  it('POST with wrong secret returns 404 (item 1)', async () => {
    const res = await postWebhook(MANAGER_BOT_ID, 'wrong-secret', { update_id: nid() });
    expect(res.status).toBe(404);
  });

  it('POST to non-existent tenant botId returns 404', async () => {
    const res = await postWebhook('999000', 'any-secret', { update_id: nid() });
    expect(res.status).toBe(404);
  });
});

describe('relay happy-path (sanity)', () => {
  it('guest message → forwardMessage called and msg-map written', async () => {
    const t = await provisionTenant({ botId: '200000', ownerUid: 'owner-200000' });
    const guest = 5550;

    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, text: 'hello' }),
    );
    expect(r.status).toBe(200);
    await flush();

    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    expect((await skv.list('msg-map-')).keys.length).toBe(1);
  });
});

describe('PLAN item 3: rate limit (5/60s, 6th dropped)', () => {
  it('only 5 of 6 messages within the window trigger forwardMessage', async () => {
    const t = await provisionTenant({ botId: '200001', ownerUid: 'owner-200001' });
    const guest = 5551;

    for (let i = 0; i < 6; i++) {
      const r = await postWebhook(
        t.botId,
        t.webhookSecret,
        buildUpdate({ chatId: guest, text: `msg ${i}` }),
      );
      expect(r.status).toBe(200);
      await flush();
    }

    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(5);
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    expect((await skv.list('msg-map-')).keys.length).toBe(5);
  });
});

describe('PLAN item 4: blocked guest is silently dropped', () => {
  it('no TG call, no msg-map, no rate-limit window', async () => {
    const t = await provisionTenant({ botId: '200002', ownerUid: 'owner-200002' });
    const guest = 5552;
    const uk = await userKey(guest, t.cfg.hashSecret);
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    await skv.put(`block-${uk}`, '1');

    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, text: 'should be dropped' }),
    );
    expect(r.status).toBe(200);
    await flush();

    expect(tgMock.getCalls().length).toBe(0);
    expect((await skv.list('msg-map-')).keys.length).toBe(0);
    // rate-limit check runs only AFTER the block check passes; absence proves the block branch fired.
    expect((await skv.list('rate-')).keys.length).toBe(0);
  });
});

describe('admin reply happy-path (sanity)', () => {
  it('admin replies to valid msg-map → copyMessage to original guest', async () => {
    const adminUid = 200004;
    const t = await provisionTenant({ botId: '200004', ownerUid: String(adminUid) });

    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    const guestChat = 9999;
    const guestUk = await userKey(guestChat, t.cfg.hashSecret);
    await skv.put(
      'msg-map-7777',
      JSON.stringify({ chatId: guestChat, userKey: guestUk, createdAt: Date.now() }),
    );

    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({
        chatId: adminUid,
        fromId: adminUid,
        text: 'admin reply text',
        replyToMessageId: 7777,
      }),
    );
    expect(r.status).toBe(200);
    await flush();

    const copyCalls = tgMock.getCallsByMethod('copyMessage');
    expect(copyCalls.length).toBe(1);
    expect(copyCalls[0].body?.chat_id).toBe(guestChat);
  });
});

describe('PLAN item 5: missing msg-map → "不存在映射" notice', () => {
  it('admin reply triggers sendMessage explaining the lookup failed', async () => {
    const adminUid = 200005;
    const t = await provisionTenant({ botId: '200005', ownerUid: String(adminUid) });

    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({
        chatId: adminUid,
        fromId: adminUid,
        text: 'reply to a long-gone msg',
        replyToMessageId: 999999,
      }),
    );
    expect(r.status).toBe(200);
    await flush();

    const sendCalls = tgMock.getCallsByMethod('sendMessage');
    expect(sendCalls.length).toBe(1);
    expect(String(sendCalls[0].body?.text)).toMatch(/不存在映射/);
  });

  it('English locale: same case emits "no mapping" notice', async () => {
    const adminUid = 200006;
    const t = await provisionTenant({ botId: '200006', ownerUid: String(adminUid) });

    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({
        chatId: adminUid,
        fromId: adminUid,
        text: 'reply to a long-gone msg',
        replyToMessageId: 999998,
        languageCode: 'en',
      }),
    );
    expect(r.status).toBe(200);
    await flush();

    const sendCalls = tgMock.getCallsByMethod('sendMessage');
    expect(sendCalls.length).toBe(1);
    expect(String(sendCalls[0].body?.text)).toMatch(/no mapping/);
  });
});

describe('media-group tag dedup (tag/hex modes)', () => {
  it('tag mode: first item of an album emits a tag, second item skips it', async () => {
    const t = await provisionTenant({
      botId: '200010',
      ownerUid: 'owner-200010',
      displayMode: 'tag',
    });
    const guest = 5560;
    const album = 'mg-abc-1';

    // Two messages with the same media_group_id arrive as separate updates.
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, mediaGroupId: album }),
    );
    await flush();
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, mediaGroupId: album }),
    );
    await flush();

    // One tag (sendMessage) for the leader, two copyMessage for both items.
    expect(tgMock.getCallsByMethod('sendMessage').length).toBe(1);
    expect(tgMock.getCallsByMethod('copyMessage').length).toBe(2);
  });

  it('tag mode: a different album emits its own tag', async () => {
    const t = await provisionTenant({
      botId: '200011',
      ownerUid: 'owner-200011',
      displayMode: 'tag',
    });
    const guest = 5561;

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, mediaGroupId: 'mg-A' }),
    );
    await flush();
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, mediaGroupId: 'mg-B' }),
    );
    await flush();

    expect(tgMock.getCallsByMethod('sendMessage').length).toBe(2);
    expect(tgMock.getCallsByMethod('copyMessage').length).toBe(2);
  });

  it('hex mode: same dedup behavior as tag mode', async () => {
    const t = await provisionTenant({
      botId: '200012',
      ownerUid: 'owner-200012',
      displayMode: 'hex',
    });
    const guest = 5562;
    const album = 'mg-hex-1';

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, mediaGroupId: album }),
    );
    await flush();
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, mediaGroupId: album }),
    );
    await flush();

    expect(tgMock.getCallsByMethod('sendMessage').length).toBe(1);
    expect(tgMock.getCallsByMethod('copyMessage').length).toBe(2);
  });

  it('native mode: media_group_id has no effect (always forwardMessage)', async () => {
    const t = await provisionTenant({
      botId: '200013',
      ownerUid: 'owner-200013',
      displayMode: 'native',
    });
    const guest = 5563;
    const album = 'mg-native-1';

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, mediaGroupId: album }),
    );
    await flush();
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: guest, mediaGroupId: album }),
    );
    await flush();

    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(2);
    expect(tgMock.getCallsByMethod('sendMessage').length).toBe(0);
  });
});

describe('PLAN item 6: non-admin /block is treated as ordinary text', () => {
  it('no block-* key is written; the message is relayed as text', async () => {
    const t = await provisionTenant({ botId: '200006', ownerUid: '700001' });
    const nonAdmin = 5556;

    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: nonAdmin, text: '/block' }),
    );
    expect(r.status).toBe(200);
    await flush();

    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    const uk = await userKey(nonAdmin, t.cfg.hashSecret);
    expect(await skv.getString(`block-${uk}`)).toBeNull();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
  });
});
