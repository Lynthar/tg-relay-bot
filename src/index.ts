import { Hono } from 'hono';
import type { Context } from 'hono';
import { DEDUP_TTL_SEC, type Env, type HostConfig } from './config';
import { getEncKey } from './crypto';
import { getTenant, type TenantCfg } from './tenant';
import { handleMessage as handleTenantMessage } from './relay';
import { handleManagerMessage } from './manager';
import { setWebhook, deleteWebhook, TelegramError } from './telegram';
import { isDuplicateUpdate, constantTimeEqual, logError } from './security';
import { ScopedKV } from './storage';
import type { TgUpdate } from './types';

export interface AppDeps {
  env: Env;
  host: HostConfig;
}

export function buildApp(deps: AppDeps): Hono {
  const { env, host } = deps;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  // botId path constraint: digits only. Anything else falls through to the 404 handler.
  app.post('/wh/:botId{[0-9]+}', async (c) => handleWebhook(c, env, host));

  app.get('/admin/registerWebhook', async (c) =>
    handleAdmin(c, host, async () => {
      const target = `${host.publicBaseUrl}/wh/${host.managerBotId}`;
      await setWebhook(host.managerBotToken, {
        url: target,
        secret_token: host.managerWebhookSecret,
      });
      return c.text(`manager webhook registered at ${target}`);
    }),
  );

  app.get('/admin/unRegisterWebhook', async (c) =>
    handleAdmin(c, host, async () => {
      await deleteWebhook(host.managerBotToken);
      return c.text('manager webhook removed');
    }),
  );

  app.notFound((c) => c.text('Not found', 404));

  return app;
}

async function handleAdmin(
  c: Context,
  host: HostConfig,
  action: () => Promise<Response>,
): Promise<Response> {
  if (!host.adminSecret) return c.text('Not found', 404);
  const provided = c.req.query('s') ?? '';
  if (!constantTimeEqual(provided, host.adminSecret)) return c.text('Not found', 404);
  try {
    return await action();
  } catch (e) {
    if (e instanceof TelegramError) {
      logError('admin_action', e);
      return c.text(`telegram error: ${e.detail}`, 502);
    }
    logError('admin_action', e);
    return c.text('error', 500);
  }
}

async function handleWebhook(
  c: Context,
  env: Env,
  host: HostConfig,
): Promise<Response> {
  const botId = c.req.param('botId') as string;
  const headerSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';

  if (botId === host.managerBotId) {
    if (!constantTimeEqual(headerSecret, host.managerWebhookSecret)) {
      return c.text('Not found', 404);
    }
    let update: TgUpdate;
    try {
      update = (await c.req.json()) as TgUpdate;
    } catch {
      return c.text('ok');
    }
    void processManagerUpdate(env, host, update).catch((e) =>
      logError('bg_manager', e),
    );
    return c.text('ok');
  }

  const encKey = await getEncKey(host.masterEncKey);
  const tenant = await getTenant(env.nfd, botId, encKey);
  if (!tenant) return c.text('Not found', 404);
  if (!constantTimeEqual(headerSecret, tenant.webhookSecret)) {
    return c.text('Not found', 404);
  }
  if (tenant.paused) return c.text('ok');

  let update: TgUpdate;
  try {
    update = (await c.req.json()) as TgUpdate;
  } catch {
    return c.text('ok');
  }
  void processTenantUpdate(env, host, tenant, update).catch((e) =>
    logError('bg_tenant', e),
  );
  return c.text('ok');
}

async function processManagerUpdate(
  env: Env,
  host: HostConfig,
  update: TgUpdate,
): Promise<void> {
  try {
    if (typeof update.update_id !== 'number') return;
    if (!update.message) return;
    if (update.message.chat.type !== 'private') return;
    const skv = new ScopedKV(env.nfd, 'manager:dedup-');
    if (await isDuplicateUpdate(skv, update.update_id, DEDUP_TTL_SEC)) return;
    await handleManagerMessage(env, host, update.message);
  } catch (e) {
    logError('manager_update', e);
  }
}

async function processTenantUpdate(
  env: Env,
  host: HostConfig,
  tenant: TenantCfg,
  update: TgUpdate,
): Promise<void> {
  try {
    if (typeof update.update_id !== 'number') return;
    if (!update.message) return;
    if (update.message.chat.type !== 'private') return;
    const skv = new ScopedKV(env.nfd, `tenant:${tenant.botId}:`);
    if (await isDuplicateUpdate(skv, update.update_id, DEDUP_TTL_SEC)) return;
    await handleTenantMessage(tenant, skv, host.debug, update.message);
  } catch (e) {
    logError('tenant_update', e);
  }
}
