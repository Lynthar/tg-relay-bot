import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  MANAGER_BOT_ID,
  buildUpdate,
  flush,
  getWebhook,
  nid,
  postWebhook,
  provisionLegacyTenant,
  provisionTenant,
  tgMock,
} from '../helpers';
import { userKey } from '../../src/security';
import { ScopedKV } from '../../src/storage';
import { getStored, putStored } from '../../src/tenant';
import { decrypt, getEncKey } from '../../src/crypto';

beforeAll(() => tgMock.install());
beforeEach(() => tgMock.reset());
afterAll(() => tgMock.uninstall());

describe('webhook auth', () => {
  it('GET /wh/{botId} returns 404', async () => {
    const res = await getWebhook(MANAGER_BOT_ID);
    expect(res.status).toBe(404);
  });

  it('POST without secret header returns 404', async () => {
    const res = await postWebhook(MANAGER_BOT_ID, null, { update_id: nid() });
    expect(res.status).toBe(404);
  });

  it('POST with wrong secret returns 404', async () => {
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

describe('rate limit (5/60s, 6th dropped)', () => {
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

describe('blocked guest is silently dropped', () => {
  it('no TG call, no msg-map, no rate-limit window', async () => {
    const t = await provisionTenant({ botId: '200002', ownerUid: 'owner-200002' });
    const guest = 5552;
    const uk = await userKey(guest, t.hashSecret);
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
    const guestUk = await userKey(guestChat, t.hashSecret);
    await skv.put(
      `msg-map-${adminUid}-7777`,
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

describe('missing msg-map → "不存在映射" notice', () => {
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

describe('tenant secrets at rest', () => {
  it('newly created tenants store secrets only encrypted', async () => {
    const t = await provisionTenant({ botId: '530001', ownerUid: 'owner-530001' });
    const stored = await getStored(env.nfd, t.botId);
    expect(stored?.webhookSecret).toBeUndefined();
    expect(stored?.hashSecret).toBeUndefined();
    const encKey = await getEncKey(env.ENV_MASTER_ENC_KEY);
    expect(await decrypt(stored!.webhookSecretEnc!, encKey)).toBe(t.webhookSecret);
    expect(await decrypt(stored!.hashSecretEnc!, encKey)).toBe(t.hashSecret);
  });

  it('legacy plaintext tenants still authenticate and relay', async () => {
    const t = await provisionLegacyTenant({ botId: '530002', ownerUid: 'owner-530002' });
    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 63333, text: 'hello legacy' }),
    );
    expect(r.status).toBe(200);
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
  });
});

describe('command parsing: deep-link payloads and @botname suffixes', () => {
  it('/start with a deep-link payload shows the welcome message, not a relay', async () => {
    const t = await provisionTenant({ botId: '520001', ownerUid: 'owner-520001' });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 61111, text: '/start ref123' }),
    );
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(0);
    const sends = tgMock.getCallsByMethod('sendMessage');
    expect(sends.length).toBe(1);
    expect(String(sends[0].body?.text)).toBe(t.cfg.startMessage);
  });

  it("/start@own_bot is handled as /start", async () => {
    const t = await provisionTenant({ botId: '520002', ownerUid: 'owner-520002' });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 61112, text: `/start@${t.cfg.botUsername}` }),
    );
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(0);
    expect(String(tgMock.getCallsByMethod('sendMessage')[0]?.body?.text)).toBe(
      t.cfg.startMessage,
    );
  });

  it('/start@another_bot is relayed as ordinary text', async () => {
    const t = await provisionTenant({ botId: '520003', ownerUid: 'owner-520003' });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 61113, text: '/start@some_other_bot' }),
    );
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
    expect(tgMock.getCallsByMethod('sendMessage').length).toBe(0);
  });

  it('/help@own_bot with trailing words shows help', async () => {
    const t = await provisionTenant({ botId: '520004', ownerUid: 'owner-520004' });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 61114, text: `/help@${t.cfg.botUsername} please` }),
    );
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(0);
    expect(String(tgMock.getCallsByMethod('sendMessage')[0]?.body?.text)).toMatch(/可用命令/);
  });

  it('a longer command word ("/starting soon") is not mistaken for /start', async () => {
    const t = await provisionTenant({ botId: '520005', ownerUid: 'owner-520005' });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 61115, text: '/starting soon' }),
    );
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
    expect(tgMock.getCallsByMethod('sendMessage').length).toBe(0);
  });
});

describe('/blocklist and /unblock <userKey> (no-reply block management)', () => {
  const UK_A = 'a'.repeat(32);
  const UK_B = 'b'.repeat(32);

  it('/blocklist lists blocked userKeys', async () => {
    const adminUid = 510001;
    const t = await provisionTenant({ botId: '510000', ownerUid: String(adminUid) });
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    await skv.put(`block-${UK_A}`, '1');
    await skv.put(`block-${UK_B}`, '1');

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminUid, fromId: adminUid, text: '/blocklist' }),
    );
    await flush();

    const sends = tgMock.getCallsByMethod('sendMessage');
    expect(sends.length).toBe(1);
    const text = String(sends[0].body?.text);
    expect(text).toContain(UK_A);
    expect(text).toContain(UK_B);
  });

  it('/blocklist with no blocked guests reports empty', async () => {
    const adminUid = 510011;
    const t = await provisionTenant({ botId: '510010', ownerUid: String(adminUid) });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminUid, fromId: adminUid, text: '/blocklist' }),
    );
    await flush();
    expect(String(tgMock.getCallsByMethod('sendMessage')[0]?.body?.text)).toMatch(/没有被屏蔽/);
  });

  it('/unblock <userKey> clears the block and confirms', async () => {
    const adminUid = 510021;
    const t = await provisionTenant({ botId: '510020', ownerUid: String(adminUid) });
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    await skv.put(`block-${UK_A}`, '1');

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminUid, fromId: adminUid, text: `/unblock ${UK_A}` }),
    );
    await flush();

    expect(await skv.getString(`block-${UK_A}`)).toBeNull();
    expect(String(tgMock.getCallsByMethod('sendMessage')[0]?.body?.text)).toMatch(/已解除屏蔽/);
  });

  it('/unblock <userKey> for a non-blocked key reports not blocked', async () => {
    const adminUid = 510031;
    const t = await provisionTenant({ botId: '510030', ownerUid: String(adminUid) });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminUid, fromId: adminUid, text: `/unblock ${UK_B}` }),
    );
    await flush();
    expect(String(tgMock.getCallsByMethod('sendMessage')[0]?.body?.text)).toMatch(/未被屏蔽/);
  });

  it('/unblock with a malformed argument shows usage', async () => {
    const adminUid = 510041;
    const t = await provisionTenant({ botId: '510040', ownerUid: String(adminUid) });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminUid, fromId: adminUid, text: '/unblock not-a-key' }),
    );
    await flush();
    expect(String(tgMock.getCallsByMethod('sendMessage')[0]?.body?.text)).toMatch(/用法/);
  });

  it('replying to a forward with "/unblock <userKey>" acts as a command, not a guest reply', async () => {
    const adminUid = 510051;
    const t = await provisionTenant({ botId: '510050', ownerUid: String(adminUid) });
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    await skv.put(`block-${UK_A}`, '1');
    await skv.put(
      `msg-map-${adminUid}-6001`,
      JSON.stringify({ chatId: 59999, userKey: UK_A, createdAt: Date.now() }),
    );

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({
        chatId: adminUid,
        fromId: adminUid,
        text: `/unblock ${UK_A}`,
        replyToMessageId: 6001,
      }),
    );
    await flush();

    expect(tgMock.getCallsByMethod('copyMessage').length).toBe(0);
    expect(await skv.getString(`block-${UK_A}`)).toBeNull();
  });

  it('guest /blocklist is relayed as ordinary text, not executed', async () => {
    const t = await provisionTenant({ botId: '510060', ownerUid: '510061' });
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 58888, text: '/blocklist' }),
    );
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
    expect(tgMock.getCallsByMethod('sendMessage').length).toBe(0);
  });
});

describe('multi-admin msg-map routing (regression: message_id is only per-chat unique)', () => {
  it('same message_id in two admin chats routes each reply to the correct guest', async () => {
    const adminA = 500001;
    const adminB = 500002;
    const guestX = 51111;
    const guestY = 52222;
    const t = await provisionTenant({ botId: '500000', ownerUid: String(adminA) });
    t.cfg.adminUids = [String(adminA), String(adminB)];
    await putStored(env.nfd, t.botId, t.cfg);

    // Telegram assigns message_ids per chat; simulate both admins' counters passing 500:
    //   guest X → A: 500   guest X → B: 600   guest Y → A: 501   guest Y → B: 500
    const forwardIds = [500, 600, 501, 500];
    let fwdCall = 0;
    tgMock.setResponder((call) => {
      if (call.url.endsWith('/forwardMessage')) {
        return Response.json({ ok: true, result: { message_id: forwardIds[fwdCall++] } });
      }
      return Response.json({ ok: true, result: { message_id: 900000 + fwdCall } });
    });

    await postWebhook(t.botId, t.webhookSecret, buildUpdate({ chatId: guestX, text: 'from X' }));
    await flush();
    await postWebhook(t.botId, t.webhookSecret, buildUpdate({ chatId: guestY, text: 'from Y' }));
    await flush();
    expect(fwdCall).toBe(4);

    // Each admin replies to message 500 *in their own chat*: A's is guest X, B's is guest Y.
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminA, fromId: adminA, text: 'to X', replyToMessageId: 500 }),
    );
    await flush();
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminB, fromId: adminB, text: 'to Y', replyToMessageId: 500 }),
    );
    await flush();

    const copies = tgMock.getCallsByMethod('copyMessage');
    expect(copies.length).toBe(2);
    expect(copies[0].body?.chat_id).toBe(guestX);
    expect(copies[1].body?.chat_id).toBe(guestY);
  });

  it('single-admin tenant: legacy pre-admin-dimension entry still resolves', async () => {
    const adminUid = 500011;
    const t = await provisionTenant({ botId: '500010', ownerUid: String(adminUid) });
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    const guestChat = 53333;
    await skv.put(
      'msg-map-8888',
      JSON.stringify({ chatId: guestChat, userKey: 'uk-legacy', createdAt: Date.now() }),
    );

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminUid, fromId: adminUid, text: 'reply', replyToMessageId: 8888 }),
    );
    await flush();

    const copies = tgMock.getCallsByMethod('copyMessage');
    expect(copies.length).toBe(1);
    expect(copies[0].body?.chat_id).toBe(guestChat);
  });

  it('multi-admin tenant: ambiguous legacy entry is ignored → no-mapping notice', async () => {
    const adminA = 500021;
    const t = await provisionTenant({ botId: '500020', ownerUid: String(adminA) });
    t.cfg.adminUids = [String(adminA), '500022'];
    await putStored(env.nfd, t.botId, t.cfg);
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    await skv.put(
      'msg-map-9999',
      JSON.stringify({ chatId: 54444, userKey: 'uk-legacy', createdAt: Date.now() }),
    );

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: adminA, fromId: adminA, text: 'reply', replyToMessageId: 9999 }),
    );
    await flush();

    expect(tgMock.getCallsByMethod('copyMessage').length).toBe(0);
    const sends = tgMock.getCallsByMethod('sendMessage');
    expect(sends.length).toBe(1);
    expect(String(sends[0].body?.text)).toMatch(/不存在映射/);
  });
});

describe('non-admin /block is treated as ordinary text', () => {
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
    const uk = await userKey(nonAdmin, t.hashSecret);
    expect(await skv.getString(`block-${uk}`)).toBeNull();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
  });
});
