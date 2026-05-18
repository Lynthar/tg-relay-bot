import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  HOST_UID,
  MANAGER_BOT_ID,
  buildUpdate,
  flush,
  managerWebhookSecret,
  postWebhook,
  provisionTenant,
  tgMock,
} from '../helpers';
import { getStored } from '../../src/tenant';

beforeAll(() => tgMock.install());
beforeEach(() => tgMock.reset());
afterAll(() => tgMock.uninstall());

async function sendManagerCmd(senderChatId: number, text: string): Promise<Response> {
  const secret = await managerWebhookSecret();
  return postWebhook(MANAGER_BOT_ID, secret, buildUpdate({ chatId: senderChatId, text }));
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
