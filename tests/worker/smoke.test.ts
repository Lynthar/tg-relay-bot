import { env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getEncKey } from '../../src/crypto';
import { createTenant } from '../../src/tenant';
import { TgMock, buildUpdate, flush, managerWebhookSecret } from '../helpers';

// Worker-entry smoke only: the business suite runs in plain Node (tests/unit,
// tests/integration). These cases prove the workerd wiring — entry memoisation,
// KV binding compatibility, the waitUntil path — against the real runtime.

const tg = new TgMock();

beforeAll(() => tg.install());
beforeEach(() => tg.reset());
afterAll(() => tg.uninstall());

describe('worker entry smoke', () => {
  it('serves /healthz', async () => {
    const res = await SELF.fetch('https://test.example.com/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('hides the webhook surface without a valid secret', async () => {
    const get = await SELF.fetch('https://test.example.com/wh/111111');
    expect(get.status).toBe(404);
    const bad = await SELF.fetch('https://test.example.com/wh/111111', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'wrong',
      },
      body: JSON.stringify(buildUpdate({ chatId: 424242, text: 'hi' })),
    });
    expect(bad.status).toBe(404);
  });

  it('builds the registration target from ENV_PUBLIC_BASE_URL, not the request URL', async () => {
    const res = await SELF.fetch(
      'https://internal-proxy.local/admin/registerWebhook?s=test-admin-secret',
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('https://test.example.com/wh/111111');
    const [call] = tg.getCallsByMethod('setWebhook');
    expect(call?.body?.url).toBe('https://test.example.com/wh/111111');
  });

  it('answers a manager update through the waitUntil path', async () => {
    const res = await SELF.fetch('https://test.example.com/wh/111111', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': await managerWebhookSecret(),
      },
      body: JSON.stringify(buildUpdate({ chatId: 555001, text: '/whoami' })),
    });
    expect(res.status).toBe(200);
    await flush();
    const calls = tg.getCallsByMethod('sendMessage');
    expect(calls.some((c) => String(c.body?.chat_id) === '555001')).toBe(true);
  });

  it('relays a guest message end to end via the KV binding', async () => {
    const encKey = await getEncKey(env.ENV_MASTER_ENC_KEY);
    const botId = '777001';
    const { webhookSecret } = await createTenant(env.nfd, encKey, {
      token: `${botId}:smoke-token`,
      ownerUid: '888001',
      botUsername: 'smoke_bot',
      botId,
    });
    const res = await SELF.fetch(`https://test.example.com/wh/${botId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
      },
      body: JSON.stringify(buildUpdate({ chatId: 999001, text: 'hello' })),
    });
    expect(res.status).toBe(200);
    await flush();
    expect(tg.getCallsByMethod('forwardMessage').length).toBe(1);
  });
});
