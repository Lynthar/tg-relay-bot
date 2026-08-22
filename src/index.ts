import {
  parseHostConfig,
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
          allowed_updates: ALLOWED_UPDATES,
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
  let tenant: TenantCfg | null;
  try {
    tenant = await getTenant(env.nfd, botId, encKey);
  } catch (e) {
    // Undecryptable cfg (wrong master key / corrupt record): fail loud with a
    // structured log line; the 5xx keeps Telegram retrying, so updates start
    // flowing again once the key is restored.
    logError('tenant_load', e, { botId });
    return new Response('error', { status: 500 });
  }
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
