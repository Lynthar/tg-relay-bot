import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  HOST_UID,
  MANAGER_BOT_ID,
  buildUpdate,
  flush,
  managerWebhookSecret,
  postWebhook,
  provisionLegacyTenant,
  provisionTenant,
  tgMock,
} from '../helpers';
import { getStored } from '../../src/tenant';
import { ScopedKV } from '../../src/storage';

beforeAll(() => tgMock.install());
beforeEach(() => tgMock.reset());
afterAll(() => tgMock.uninstall());

async function sendManagerCmd(
  senderChatId: number,
  text: string,
  languageCode?: string,
): Promise<Response> {
  const secret = await managerWebhookSecret();
  return postWebhook(
    MANAGER_BOT_ID,
    secret,
    buildUpdate({ chatId: senderChatId, text, languageCode }),
  );
}

function lastReplyText(): string {
  const calls = tgMock.getCallsByMethod('sendMessage');
  return calls.length > 0 ? String(calls[calls.length - 1].body?.text ?? '') : '';
}

describe('/admins', () => {
  it('list shows current admins with owner tag', async () => {
    const t = await provisionTenant({ botId: '400001', ownerUid: '400001' });
    await sendManagerCmd(400001, `/admins ${t.cfg.botUsername} list`);
    await flush();
    expect(lastReplyText()).toMatch(/400001 \(owner\)/);
  });

  it('add appends uid to adminUids', async () => {
    const t = await provisionTenant({ botId: '400002', ownerUid: '400002' });
    await sendManagerCmd(400002, `/admins ${t.cfg.botUsername} add 555111`);
    await flush();
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.adminUids).toContain('555111');
    expect(lastReplyText()).toMatch(/已添加管理员 555111/);
    // Default mock lets the reachability probe succeed → no Start warning.
    expect(lastReplyText()).not.toMatch(/点 Start/);
  });

  it('add is idempotent — second add reports already-admin and no duplicate', async () => {
    const t = await provisionTenant({ botId: '400003', ownerUid: '400003' });
    await sendManagerCmd(400003, `/admins ${t.cfg.botUsername} add 555222`);
    await flush();
    tgMock.reset();
    await sendManagerCmd(400003, `/admins ${t.cfg.botUsername} add 555222`);
    await flush();
    expect(lastReplyText()).toMatch(/已经是/);
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.adminUids.filter((u) => u === '555222').length).toBe(1);
  });

  it('remove deletes uid', async () => {
    const t = await provisionTenant({ botId: '400004', ownerUid: '400004' });
    await sendManagerCmd(400004, `/admins ${t.cfg.botUsername} add 555333`);
    await flush();
    tgMock.reset();
    await sendManagerCmd(400004, `/admins ${t.cfg.botUsername} remove 555333`);
    await flush();
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.adminUids).not.toContain('555333');
    expect(lastReplyText()).toMatch(/已移除管理员 555333/);
  });

  it('cannot remove owner', async () => {
    const t = await provisionTenant({ botId: '400005', ownerUid: '400005' });
    await sendManagerCmd(400005, `/admins ${t.cfg.botUsername} remove 400005`);
    await flush();
    expect(lastReplyText()).toMatch(/不能移除 owner/);
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.adminUids).toContain('400005');
  });

  it('rejects non-numeric uid', async () => {
    const t = await provisionTenant({ botId: '400006', ownerUid: '400006' });
    await sendManagerCmd(400006, `/admins ${t.cfg.botUsername} add notanumber`);
    await flush();
    expect(lastReplyText()).toMatch(/纯数字/);
  });

  it("non-owner cannot manage another owner's bot", async () => {
    const t = await provisionTenant({ botId: '400007', ownerUid: '400007' });
    await sendManagerCmd(123456, `/admins ${t.cfg.botUsername} add 555444`);
    await flush();
    expect(lastReplyText()).toMatch(/未找到/);
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.adminUids).not.toContain('555444');
  });
});

describe('/start_message', () => {
  it('updates startMessage', async () => {
    const t = await provisionTenant({ botId: '400010', ownerUid: '400010' });
    await sendManagerCmd(400010, `/start_message ${t.cfg.botUsername} Welcome to my bot!`);
    await flush();
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.startMessage).toBe('Welcome to my bot!');
    expect(lastReplyText()).toMatch(/已更新/);
  });

  it('supports multi-line message body', async () => {
    const t = await provisionTenant({ botId: '400011', ownerUid: '400011' });
    const content = 'Line 1\nLine 2\nLine 3';
    await sendManagerCmd(400011, `/start_message ${t.cfg.botUsername} ${content}`);
    await flush();
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.startMessage).toBe(content);
  });

  it('rejects missing body (usage prompt)', async () => {
    const t = await provisionTenant({ botId: '400012', ownerUid: '400012' });
    await sendManagerCmd(400012, `/start_message ${t.cfg.botUsername}`);
    await flush();
    expect(lastReplyText()).toMatch(/用法/);
  });

  it('rejects oversized body (>1000 chars)', async () => {
    const t = await provisionTenant({ botId: '400013', ownerUid: '400013' });
    const huge = 'a'.repeat(1001);
    await sendManagerCmd(400013, `/start_message ${t.cfg.botUsername} ${huge}`);
    await flush();
    expect(lastReplyText()).toMatch(/过长/);
  });
});

describe('/host_disable and /host_purge', () => {
  it('/host_disable: non-host is refused with no state change', async () => {
    const t = await provisionTenant({ botId: '400020', ownerUid: '400020' });
    await sendManagerCmd(123456, `/host_disable ${t.cfg.botUsername}`);
    await flush();
    expect(lastReplyText()).toMatch(/仅 host/);
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.paused).toBe(false);
  });

  it('/host_disable: host pauses any tenant', async () => {
    const t = await provisionTenant({ botId: '400021', ownerUid: '400021' });
    await sendManagerCmd(Number(HOST_UID), `/host_disable ${t.cfg.botUsername}`);
    await flush();
    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.paused).toBe(true);
    expect(lastReplyText()).toMatch(/已被 host 暂停/);
  });

  it('/host_purge: non-host is refused with no state change', async () => {
    const t = await provisionTenant({ botId: '400022', ownerUid: '400022' });
    await sendManagerCmd(123456, `/host_purge ${t.cfg.botUsername} --yes`);
    await flush();
    expect(lastReplyText()).toMatch(/仅 host/);
    expect(await getStored(env.nfd, t.botId)).not.toBeNull();
  });

  it('/host_purge without --yes returns confirmation prompt and does not delete', async () => {
    const t = await provisionTenant({ botId: '400023', ownerUid: '400023' });
    await sendManagerCmd(Number(HOST_UID), `/host_purge ${t.cfg.botUsername}`);
    await flush();
    expect(lastReplyText()).toMatch(/--yes/);
    expect(await getStored(env.nfd, t.botId)).not.toBeNull();
  });

  it('/host_purge --yes deletes any tenant', async () => {
    const t = await provisionTenant({ botId: '400024', ownerUid: '400024' });
    await sendManagerCmd(Number(HOST_UID), `/host_purge ${t.cfg.botUsername} --yes`);
    await flush();
    expect(await getStored(env.nfd, t.botId)).toBeNull();
    expect(lastReplyText()).toMatch(/已被 host 删除/);
  });
});

describe('invite gating: /invite /uninvite /invites + gated /setup', () => {
  it('non-host /setup without invite is refused', async () => {
    await sendManagerCmd(620000, '/setup');
    await flush();
    expect(lastReplyText()).toMatch(/需要 host 邀请/);
  });

  it('non-host /setup refusal is localized (en)', async () => {
    await sendManagerCmd(620001, '/setup', 'en');
    await flush();
    expect(lastReplyText()).toMatch(/requires an invitation/);
  });

  it('host /setup needs no invite', async () => {
    await sendManagerCmd(Number(HOST_UID), '/setup');
    await flush();
    expect(lastReplyText()).toMatch(/请粘贴/);
    await sendManagerCmd(Number(HOST_UID), '/cancel');
    await flush();
  });

  it('non-host cannot /invite', async () => {
    await sendManagerCmd(620002, '/invite 620003');
    await flush();
    expect(lastReplyText()).toMatch(/仅 host/);
    expect(await env.nfd.get('manager:allow-620003')).toBeNull();
  });

  it('host /invite rejects non-numeric uid', async () => {
    await sendManagerCmd(Number(HOST_UID), '/invite notanumber');
    await flush();
    expect(lastReplyText()).toMatch(/纯数字/);
  });

  it('host /invite writes the allow key and /invites lists it', async () => {
    await sendManagerCmd(Number(HOST_UID), '/invite 620010');
    await flush();
    expect(await env.nfd.get('manager:allow-620010')).toBe('1');
    tgMock.reset();
    await sendManagerCmd(Number(HOST_UID), '/invites');
    await flush();
    expect(lastReplyText()).toMatch(/620010/);
  });

  it('invited user completes the full /setup onboarding flow', async () => {
    const friend = 620100;
    tgMock.setResponder((call) => {
      if (call.url.endsWith('/getMe')) {
        return Response.json({
          ok: true,
          result: { id: 620101, is_bot: true, first_name: 'T', username: 'invited_test_bot' },
        });
      }
      if (call.url.endsWith('/setWebhook')) {
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    });

    await sendManagerCmd(Number(HOST_UID), `/invite ${friend}`);
    await flush();
    await sendManagerCmd(friend, '/setup');
    await flush();
    expect(lastReplyText()).toMatch(/请粘贴/);
    await sendManagerCmd(friend, '620101:TESTtoken_abc');
    await flush();

    expect(lastReplyText()).toMatch(/已上线/);
    const stored = await getStored(env.nfd, '620101');
    expect(stored?.ownerUid).toBe(String(friend));
    expect(stored?.botUsername).toBe('invited_test_bot');
    const hooks = tgMock.getCallsByMethod('setWebhook');
    expect(hooks.length).toBe(1);
    expect(hooks[0].body?.allowed_updates).toEqual(['message']);

    // Reachability probe went out via the TENANT bot's token and succeeded → no warning.
    const probes = tgMock
      .getCallsByMethod('sendMessage')
      .filter((c) => c.url.includes('620101:TESTtoken_abc'));
    expect(probes.length).toBe(1);
    expect(lastReplyText()).toMatch(/确认消息/);
    expect(lastReplyText()).not.toMatch(/点 Start/);
  });

  it('onboarding warns when the owner has never started the tenant bot', async () => {
    const friend = 620400;
    tgMock.setResponder((call) => {
      if (call.url.endsWith('/getMe')) {
        return Response.json({
          ok: true,
          result: { id: 620401, is_bot: true, first_name: 'T', username: 'unreachable_bot' },
        });
      }
      if (call.url.endsWith('/setWebhook')) {
        return Response.json({ ok: true, result: true });
      }
      if (call.url.includes('620401:') && call.url.endsWith('/sendMessage')) {
        return Response.json({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot can't initiate conversation with a user",
        });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    });

    await sendManagerCmd(Number(HOST_UID), `/invite ${friend}`);
    await flush();
    await sendManagerCmd(friend, '/setup');
    await flush();
    await sendManagerCmd(friend, '620401:TESTtoken_xyz');
    await flush();

    // Tenant is created regardless — the probe only affects the guidance text.
    expect(await getStored(env.nfd, '620401')).not.toBeNull();
    expect(lastReplyText()).toMatch(/已上线/);
    expect(lastReplyText()).toMatch(/点 Start/);
  });

  it('/admins add warns when the new admin has never started the tenant bot', async () => {
    const owner = 620500;
    const t = await provisionTenant({ botId: '620500', ownerUid: String(owner) });
    tgMock.setResponder((call) => {
      if (call.url.includes(`${t.token}`) && call.url.endsWith('/sendMessage')) {
        return Response.json({
          ok: false,
          error_code: 403,
          description: "Forbidden: bot can't initiate conversation with a user",
        });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    });

    await sendManagerCmd(owner, `/admins ${t.cfg.botUsername} add 555999`);
    await flush();

    const updated = await getStored(env.nfd, t.botId);
    expect(updated?.adminUids).toContain('555999');
    expect(lastReplyText()).toMatch(/已添加管理员 555999/);
    expect(lastReplyText()).toMatch(/点 Start/);
  });

  it('uninvite between /setup and token paste blocks onboarding', async () => {
    const friend = 620200;
    await sendManagerCmd(Number(HOST_UID), `/invite ${friend}`);
    await flush();
    await sendManagerCmd(friend, '/setup');
    await flush();
    await sendManagerCmd(Number(HOST_UID), `/uninvite ${friend}`);
    await flush();
    expect(await env.nfd.get(`manager:allow-${friend}`)).toBeNull();

    await sendManagerCmd(friend, '620201:TESTtoken_abc');
    await flush();
    expect(lastReplyText()).toMatch(/需要 host 邀请/);
    expect(await getStored(env.nfd, '620201')).toBeNull();
  });

  it('per-uid tenant limit blocks a fourth bot', async () => {
    const friend = 620300;
    await provisionTenant({ botId: '620310', ownerUid: String(friend) });
    await provisionTenant({ botId: '620311', ownerUid: String(friend) });
    await provisionTenant({ botId: '620312', ownerUid: String(friend) });
    await sendManagerCmd(Number(HOST_UID), `/invite ${friend}`);
    await flush();
    await sendManagerCmd(friend, '/setup');
    await flush();
    await sendManagerCmd(friend, '620301:TESTtoken_abc');
    await flush();

    expect(lastReplyText()).toMatch(/上限/);
    expect(await getStored(env.nfd, '620301')).toBeNull();
  });

  it('/uninvite of a uid not on the list reports it', async () => {
    await sendManagerCmd(Number(HOST_UID), '/uninvite 620999');
    await flush();
    expect(lastReplyText()).toMatch(/不在邀请列表/);
  });
});

describe('/list, /info, /displaymode', () => {
  it('/list shows owned bots with status and mode', async () => {
    const t = await provisionTenant({ botId: '630001', ownerUid: '630001' });
    await sendManagerCmd(630001, '/list');
    await flush();
    expect(lastReplyText()).toContain(`@${t.cfg.botUsername}`);
    expect(lastReplyText()).toMatch(/active/);
  });

  it('/list with no bots prompts /setup', async () => {
    await sendManagerCmd(630002, '/list');
    await flush();
    expect(lastReplyText()).toMatch(/还没有 onboard/);
  });

  it('/info shows details to the owner', async () => {
    const t = await provisionTenant({ botId: '630003', ownerUid: '630003' });
    await sendManagerCmd(630003, `/info ${t.cfg.botUsername}`);
    await flush();
    expect(lastReplyText()).toContain(`bot_id: ${t.botId}`);
    expect(lastReplyText()).toMatch(/status: active/);
  });

  it("host /info can inspect another owner's bot", async () => {
    const t = await provisionTenant({ botId: '630004', ownerUid: '630004' });
    await sendManagerCmd(Number(HOST_UID), `/info ${t.cfg.botUsername}`);
    await flush();
    expect(lastReplyText()).toContain('owner: 630004');
  });

  it('/displaymode switches the mode and persists', async () => {
    const t = await provisionTenant({ botId: '630005', ownerUid: '630005' });
    await sendManagerCmd(630005, `/displaymode ${t.cfg.botUsername} hex`);
    await flush();
    expect((await getStored(env.nfd, t.botId))?.displayMode).toBe('hex');
    expect(lastReplyText()).toMatch(/hex/);
  });

  it('/displaymode rejects an unknown mode', async () => {
    const t = await provisionTenant({ botId: '630006', ownerUid: '630006' });
    await sendManagerCmd(630006, `/displaymode ${t.cfg.botUsername} rainbow`);
    await flush();
    expect(lastReplyText()).toMatch(/native \/ tag \/ hex/);
    expect((await getStored(env.nfd, t.botId))?.displayMode).toBe('native');
  });
});

describe('/pause /resume /delete', () => {
  it('/pause unregisters the webhook, marks paused, and stops relaying', async () => {
    const t = await provisionTenant({ botId: '630010', ownerUid: '630010' });
    await sendManagerCmd(630010, `/pause ${t.cfg.botUsername}`);
    await flush();
    expect((await getStored(env.nfd, t.botId))?.paused).toBe(true);
    expect(
      tgMock.getCallsByMethod('deleteWebhook').filter((c) => c.url.includes(t.token)).length,
    ).toBe(1);

    tgMock.reset();
    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 64444, text: 'while paused' }),
    );
    expect(r.status).toBe(200);
    await flush();
    expect(tgMock.getCalls().length).toBe(0);
  });

  it('/resume re-registers the webhook with the same secret and relaying works again', async () => {
    const t = await provisionTenant({ botId: '630011', ownerUid: '630011' });
    await sendManagerCmd(630011, `/pause ${t.cfg.botUsername}`);
    await flush();
    tgMock.reset();
    await sendManagerCmd(630011, `/resume ${t.cfg.botUsername}`);
    await flush();
    expect((await getStored(env.nfd, t.botId))?.paused).toBe(false);
    const hooks = tgMock
      .getCallsByMethod('setWebhook')
      .filter((c) => c.url.includes(t.token));
    expect(hooks.length).toBe(1);
    // Round-trips through webhookSecretEnc decryption.
    expect(hooks[0].body?.secret_token).toBe(t.webhookSecret);
    expect(hooks[0].body?.allowed_updates).toEqual(['message']);

    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 64445, text: 'after resume' }),
    );
    expect(r.status).toBe(200);
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
  });

  it('/resume failure keeps the tenant paused', async () => {
    const t = await provisionTenant({ botId: '630012', ownerUid: '630012' });
    await sendManagerCmd(630012, `/pause ${t.cfg.botUsername}`);
    await flush();
    tgMock.setResponder((call) => {
      if (call.url.endsWith('/setWebhook')) {
        return Response.json({
          ok: false,
          error_code: 400,
          description: 'Bad Request: bad webhook',
        });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    await sendManagerCmd(630012, `/resume ${t.cfg.botUsername}`);
    await flush();
    expect((await getStored(env.nfd, t.botId))?.paused).toBe(true);
    expect(lastReplyText()).toMatch(/setWebhook 失败/);
  });

  it('/delete without --yes only confirms', async () => {
    const t = await provisionTenant({ botId: '630013', ownerUid: '630013' });
    await sendManagerCmd(630013, `/delete ${t.cfg.botUsername}`);
    await flush();
    expect(await getStored(env.nfd, t.botId)).not.toBeNull();
    expect(lastReplyText()).toMatch(/--yes/);
  });

  it('/delete --yes unregisters the webhook and purges all tenant keys', async () => {
    const t = await provisionTenant({ botId: '630014', ownerUid: '630014' });
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    await skv.put('block-deadbeef', '1');
    await sendManagerCmd(630014, `/delete ${t.cfg.botUsername} --yes`);
    await flush();
    expect(await getStored(env.nfd, t.botId)).toBeNull();
    expect(await skv.getString('block-deadbeef')).toBeNull();
    expect(
      tgMock.getCallsByMethod('deleteWebhook').filter((c) => c.url.includes(t.token)).length,
    ).toBe(1);
    expect(lastReplyText()).toMatch(/已删除/);
  });
});

describe('/host_migrate', () => {
  it('non-host is refused', async () => {
    await sendManagerCmd(123456, '/host_migrate');
    await flush();
    expect(lastReplyText()).toMatch(/仅 host/);
  });

  it('encrypts legacy secrets, refreshes the webhook, and relay keeps working', async () => {
    const t = await provisionLegacyTenant({ botId: '620600', ownerUid: '620600' });
    await sendManagerCmd(Number(HOST_UID), '/host_migrate');
    await flush();

    const stored = await getStored(env.nfd, t.botId);
    expect(stored?.hashSecret).toBeUndefined();
    expect(stored?.webhookSecret).toBeUndefined();
    expect(stored?.hashSecretEnc).toBeDefined();
    expect(stored?.webhookSecretEnc).toBeDefined();

    const hooks = tgMock
      .getCallsByMethod('setWebhook')
      .filter((c) => c.url.includes(t.token));
    expect(hooks.length).toBe(1);
    expect(hooks[0].body?.secret_token).toBe(t.webhookSecret);
    expect(hooks[0].body?.allowed_updates).toEqual(['message']);
    expect(lastReplyText()).toMatch(/完成 secrets 加密迁移/);

    // The same webhook secret still authenticates after migration.
    tgMock.reset();
    const r = await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: 63334, text: 'post-migrate' }),
    );
    expect(r.status).toBe(200);
    await flush();
    expect(tgMock.getCallsByMethod('forwardMessage').length).toBe(1);
  });

  it('is idempotent — a second run migrates nothing', async () => {
    await provisionLegacyTenant({ botId: '620601', ownerUid: '620601' });
    await sendManagerCmd(Number(HOST_UID), '/host_migrate');
    await flush();
    tgMock.reset();
    await sendManagerCmd(Number(HOST_UID), '/host_migrate');
    await flush();
    const m = lastReplyText().match(/：(\d+) 个完成 secrets 加密迁移/);
    expect(m?.[1]).toBe('0');
  });
});

describe('i18n: English locale', () => {
  it('/admins add emits English confirmation when language_code=en', async () => {
    const t = await provisionTenant({ botId: '400100', ownerUid: '400100' });
    await sendManagerCmd(400100, `/admins ${t.cfg.botUsername} add 556001`, 'en');
    await flush();
    expect(lastReplyText()).toMatch(/Added admin 556001/);
  });

  it('/admins remove of owner emits English refusal', async () => {
    const t = await provisionTenant({ botId: '400101', ownerUid: '400101' });
    await sendManagerCmd(400101, `/admins ${t.cfg.botUsername} remove 400101`, 'en');
    await flush();
    expect(lastReplyText()).toMatch(/Cannot remove the owner/);
  });

  it('/admins add with non-numeric uid emits English error', async () => {
    const t = await provisionTenant({ botId: '400102', ownerUid: '400102' });
    await sendManagerCmd(400102, `/admins ${t.cfg.botUsername} add notanumber`, 'en');
    await flush();
    expect(lastReplyText()).toMatch(/UID must be numeric/);
  });

  it("non-owner gets English not-found message", async () => {
    const t = await provisionTenant({ botId: '400103', ownerUid: '400103' });
    await sendManagerCmd(123456, `/admins ${t.cfg.botUsername} add 556002`, 'en');
    await flush();
    expect(lastReplyText()).toMatch(/not found/);
  });

  it('/start_message rejects missing body in English', async () => {
    const t = await provisionTenant({ botId: '400104', ownerUid: '400104' });
    await sendManagerCmd(400104, `/start_message ${t.cfg.botUsername}`, 'en');
    await flush();
    expect(lastReplyText()).toMatch(/Usage: \/start_message/);
  });

  it('/start_message rejects oversized body in English', async () => {
    const t = await provisionTenant({ botId: '400105', ownerUid: '400105' });
    const huge = 'a'.repeat(1001);
    await sendManagerCmd(400105, `/start_message ${t.cfg.botUsername} ${huge}`, 'en');
    await flush();
    expect(lastReplyText()).toMatch(/too long/);
  });

  it('/start_message update confirmation in English', async () => {
    const t = await provisionTenant({ botId: '400106', ownerUid: '400106' });
    await sendManagerCmd(
      400106,
      `/start_message ${t.cfg.botUsername} Welcome to my bot!`,
      'en',
    );
    await flush();
    expect(lastReplyText()).toMatch(/\/start message updated/);
  });

  it('/host_disable refuses non-host in English', async () => {
    const t = await provisionTenant({ botId: '400107', ownerUid: '400107' });
    await sendManagerCmd(123456, `/host_disable ${t.cfg.botUsername}`, 'en');
    await flush();
    expect(lastReplyText()).toMatch(/Host-only command/);
  });

  it('/host_disable host action emits English confirmation', async () => {
    const t = await provisionTenant({ botId: '400108', ownerUid: '400108' });
    await sendManagerCmd(Number(HOST_UID), `/host_disable ${t.cfg.botUsername}`, 'en');
    await flush();
    expect(lastReplyText()).toMatch(/disabled by host/);
  });

  it('/host_purge --yes emits English confirmation', async () => {
    const t = await provisionTenant({ botId: '400109', ownerUid: '400109' });
    await sendManagerCmd(
      Number(HOST_UID),
      `/host_purge ${t.cfg.botUsername} --yes`,
      'en',
    );
    await flush();
    expect(lastReplyText()).toMatch(/purged by host/);
  });

  it('/help shows the English command list', async () => {
    await sendManagerCmd(123456, '/help', 'en');
    await flush();
    expect(lastReplyText()).toMatch(/Manager bot commands:/);
  });

  it('/whoami stays English-style in both locales (parity check)', async () => {
    await sendManagerCmd(123456, '/whoami', 'en');
    await flush();
    expect(lastReplyText()).toMatch(/Your chat id: 123456/);
  });
});
