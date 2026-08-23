import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildUpdate, env, flush, postWebhook, provisionTenant, tgMock } from '../helpers';
import { userKey } from '../../src/security';
import { ScopedKV, getMsgMap, putMsgMap } from '../../src/storage';
import { deleteTenant, getStored, putStored } from '../../src/tenant';
import { getEncKey } from '../../src/crypto';

beforeAll(() => tgMock.install());
beforeEach(() => tgMock.reset());
afterAll(() => tgMock.uninstall());

describe('tenant isolation', () => {
  it('same chatId hashes to different userKey across tenants (per-tenant hashSecret)', async () => {
    const a = await provisionTenant({ botId: '300001', ownerUid: '300001' });
    const b = await provisionTenant({ botId: '300002', ownerUid: '300002' });
    expect(a.hashSecret).not.toBe(b.hashSecret);
    const guest = 12345;
    expect(await userKey(guest, a.hashSecret)).not.toBe(await userKey(guest, b.hashSecret));
  });

  it('blocking a guest in tenant A does not block them in tenant B', async () => {
    const a = await provisionTenant({ botId: '300003', ownerUid: '300003' });
    const b = await provisionTenant({ botId: '300004', ownerUid: '300004' });
    const guest = 5555;

    const ukA = await userKey(guest, a.hashSecret);
    const skvA = new ScopedKV(env.nfd, `tenant:${a.botId}:`);
    await skvA.put(`block-${ukA}`, '1');

    const r = await postWebhook(
      b.botId,
      b.webhookSecret,
      buildUpdate({ chatId: guest, text: 'hi' }),
    );
    expect(r.status).toBe(200);
    await flush();

    const skvB = new ScopedKV(env.nfd, `tenant:${b.botId}:`);
    expect((await skvB.list('msg-map-')).keys.length).toBe(1);
    expect(await skvA.getString(`block-${ukA}`)).toBe('1');
  });

  it('msg-map written under tenant A is invisible to tenant B (ScopedKV prefix)', async () => {
    const a = await provisionTenant({ botId: '300005', ownerUid: '300005' });
    const b = await provisionTenant({ botId: '300006', ownerUid: '300006' });
    const skvA = new ScopedKV(env.nfd, `tenant:${a.botId}:`);
    const skvB = new ScopedKV(env.nfd, `tenant:${b.botId}:`);

    await putMsgMap(skvA, '900', 4242, { chatId: 999, userKey: 'uk-a', createdAt: Date.now() }, 60);

    expect(await getMsgMap(skvA, '900', 4242)).not.toBeNull();
    expect(await getMsgMap(skvB, '900', 4242)).toBeNull();
  });

  it('deleting tenant A purges only A and leaves tenant B intact', async () => {
    const a = await provisionTenant({ botId: '300007', ownerUid: '300007' });
    const b = await provisionTenant({ botId: '300008', ownerUid: '300008' });
    const skvA = new ScopedKV(env.nfd, `tenant:${a.botId}:`);
    const skvB = new ScopedKV(env.nfd, `tenant:${b.botId}:`);
    await skvA.put('test-key', 'A');
    await skvB.put('test-key', 'B');

    const encKey = await getEncKey(env.ENV_MASTER_ENC_KEY);
    await deleteTenant(env.nfd, a.botId, encKey);

    expect(await skvA.getString('test-key')).toBeNull();
    expect(await env.nfd.get(`tenant:${a.botId}:cfg`)).toBeNull();
    expect(await skvB.getString('test-key')).toBe('B');
    expect(await env.nfd.get(`tenant:${b.botId}:cfg`)).not.toBeNull();
  });

  it('deleteTenant purges local data even when the token cannot be decrypted', async () => {
    const a = await provisionTenant({ botId: '300009', ownerUid: '300009' });
    const stored = await getStored(env.nfd, a.botId);
    // Valid base64, undecryptable content — what a record looks like after the
    // master key was changed.
    stored!.tokenEnc = 'A'.repeat(64);
    await putStored(env.nfd, a.botId, stored!);
    const skv = new ScopedKV(env.nfd, `tenant:${a.botId}:`);
    await skv.put('msg-map-1-1', '{}');

    const encKey = await getEncKey(env.ENV_MASTER_ENC_KEY);
    const purged = await deleteTenant(env.nfd, a.botId, encKey);

    expect(purged).toBeGreaterThanOrEqual(2);
    expect(await env.nfd.get(`tenant:${a.botId}:cfg`)).toBeNull();
    // deleteWebhook was skipped (token undecryptable), never attempted with garbage.
    expect(tgMock.getCallsByMethod('deleteWebhook').length).toBe(0);
  });
});
