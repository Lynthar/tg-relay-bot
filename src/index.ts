import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ALLOWED_UPDATES,
  DEDUP_TTL_SEC,
  type Env,
  type HostConfig,
} from './config';
import { getEncKey } from './crypto';
import { getTenant, type TenantCfg } from './tenant';
import { handleMessage as handleTenantMessage } from './relay';
import { handleManagerMessage, isInvited } from './manager';
import { setWebhook, deleteWebhook, TelegramError } from './telegram';
import { seenUpdate, markUpdateSeen, constantTimeEqual, logError } from './security';
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
        allowed_updates: ALLOWED_UPDATES,
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

// Workers kill pending work once the response is sent unless it is registered via
// waitUntil; on Node there is no executionCtx (the getter throws) and the event
// loop keeps the promise alive on its own.
function dispatch(c: Context, work: Promise<void>, event: string): void {
  const bg = work.catch((e) => logError(event, e));
  try {
    c.executionCtx.waitUntil(bg);
  } catch {
    /* Node */
  }
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
    dispatch(c, processManagerUpdate(env, host, update), 'bg_manager');
    return c.text('ok');
  }

  const encKey = await getEncKey(host.masterEncKey);
  let tenant: TenantCfg | null;
  try {
    tenant = await getTenant(env.nfd, botId, encKey);
  } catch (e) {
    // Undecryptable cfg (wrong master key / corrupt record): fail loud with a
    // structured log line; the 5xx keeps Telegram retrying, so updates start
    // flowing again once the key is restored.
    logError('tenant_load', e, { botId });
    return c.text('error', 500);
  }
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
  dispatch(c, processTenantUpdate(env, host, tenant, update), 'bg_tenant');
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
    if (await seenUpdate(skv, update.update_id)) return;
    // Strangers get replies but no dedup mark: their handling is stateless, so a
    // rare duplicate delivery merely repeats a reply — cheaper than letting
    // uninvited spam consume the platform-wide daily KV write quota.
    const senderId = String(update.message.chat.id);
    if (senderId === host.hostUid || (await isInvited(env.nfd, senderId))) {
      await markUpdateSeen(skv, update.update_id, DEDUP_TTL_SEC);
    }
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
    if (await seenUpdate(skv, update.update_id)) return;
    // The matching markUpdateSeen happens inside the relay, after the cheap drop
    // decisions (blocked / rate-limited), so dropped junk costs no KV writes.
    await handleTenantMessage(tenant, skv, host.debug, update.message, update.update_id);
  } catch (e) {
    logError('tenant_update', e, { botId: tenant.botId });
  }
}
