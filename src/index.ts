import { parseHostConfig, DEDUP_TTL_SEC, type Env, type HostConfig } from './config';
import { getEncKey } from './crypto';
import { getTenant, type TenantCfg } from './tenant';
import { handleMessage as handleTenantMessage } from './relay';
import { handleManagerMessage } from './manager';
import { setWebhook, deleteWebhook, TelegramError } from './telegram';
import { isDuplicateUpdate, constantTimeEqual, logError } from './security';
import { ScopedKV } from './storage';
import type { TgUpdate } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let host: HostConfig;
    try {
      host = await parseHostConfig(env);
    } catch (e) {
      logError('config', e);
      return notFound();
    }

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.hostname}`;
    const path = url.pathname;

    const whMatch = path.match(/^\/wh\/(\d+)$/);
    if (whMatch) {
      return handleWebhook(request, ctx, env, host, baseUrl, whMatch[1]);
    }

    if (path === '/admin/registerWebhook') {
      return handleAdmin(request, host, async () => {
        const target = `${baseUrl}/wh/${host.managerBotId}`;
        await setWebhook(host.managerBotToken, {
          url: target,
          secret_token: host.managerWebhookSecret,
        });
        return new Response(`manager webhook registered at ${target}`);
      });
    }
    if (path === '/admin/unRegisterWebhook') {
      return handleAdmin(request, host, async () => {
        await deleteWebhook(host.managerBotToken);
        return new Response('manager webhook removed');
      });
    }
    return notFound();
  },
} satisfies ExportedHandler<Env>;

function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

async function handleAdmin(
  request: Request,
  host: HostConfig,
  action: () => Promise<Response>,
): Promise<Response> {
  if (!host.adminSecret) return notFound();
  const provided = new URL(request.url).searchParams.get('s') ?? '';
  if (!constantTimeEqual(provided, host.adminSecret)) return notFound();
  try {
    return await action();
  } catch (e) {
    if (e instanceof TelegramError) {
      logError('admin_action', e);
      return new Response(`telegram error: ${e.detail}`, { status: 502 });
    }
    logError('admin_action', e);
    return new Response('error', { status: 500 });
  }
}

async function handleWebhook(
  request: Request,
  ctx: ExecutionContext,
  env: Env,
  host: HostConfig,
  baseUrl: string,
  botId: string,
): Promise<Response> {
  if (request.method !== 'POST') return notFound();
  const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';

  if (botId === host.managerBotId) {
    if (!constantTimeEqual(headerSecret, host.managerWebhookSecret)) return notFound();
    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return new Response('ok');
    }
    ctx.waitUntil(processManagerUpdate(env, host, baseUrl, update));
    return new Response('ok');
  }

  const encKey = await getEncKey(host.masterEncKey);
  const tenant = await getTenant(env.nfd, botId, encKey);
  if (!tenant) return notFound();
  if (!constantTimeEqual(headerSecret, tenant.webhookSecret)) return notFound();
  if (tenant.paused) return new Response('ok');

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response('ok');
  }
  ctx.waitUntil(processTenantUpdate(env, host, tenant, update));
  return new Response('ok');
}

async function processManagerUpdate(
  env: Env,
  host: HostConfig,
  baseUrl: string,
  update: TgUpdate,
): Promise<void> {
  try {
    if (typeof update.update_id !== 'number') return;
    const skv = new ScopedKV(env.nfd, 'manager:dedup-');
    if (await isDuplicateUpdate(skv, update.update_id, DEDUP_TTL_SEC)) return;
    if (!update.message) return;
    await handleManagerMessage(env, host, baseUrl, update.message);
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
    const skv = new ScopedKV(env.nfd, `tenant:${tenant.botId}:`);
    if (await isDuplicateUpdate(skv, update.update_id, DEDUP_TTL_SEC)) return;
    if (!update.message) return;
    await handleTenantMessage(tenant, skv, host.debug, update.message);
  } catch (e) {
    logError('tenant_update', e);
  }
}
