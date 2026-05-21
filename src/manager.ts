import type { Env, HostConfig } from './config';
import { getEncKey } from './crypto';
import * as tg from './telegram';
import { TelegramError } from './telegram';
import {
  getStored,
  putStored,
  createTenant,
  deleteStored,
  deleteTenant,
  listStored,
  listStoredByOwner,
  findStoredByUsername,
  decryptToken,
  type StoredEntry,
} from './tenant';
import type { TgMessage, DisplayMode } from './types';
import { logError, logEvent } from './security';
import type { KvStore } from './storage';
import { type Locale, localeFromMessage, T } from './i18n';

interface UserState {
  step: 'idle' | 'awaiting_token';
}

const USER_STATE_TTL = 3600;
const REPLY_MAX_LEN = 3500;

async function getState(kv: KvStore, uid: string): Promise<UserState> {
  const s = await kv.get<UserState>(`manager:user-state-${uid}`, { type: 'json' });
  return s ?? { step: 'idle' };
}

async function setState(kv: KvStore, uid: string, state: UserState): Promise<void> {
  await kv.put(`manager:user-state-${uid}`, JSON.stringify(state), {
    expirationTtl: USER_STATE_TTL,
  });
}

export async function handleManagerMessage(
  env: Env,
  host: HostConfig,
  baseUrl: string,
  message: TgMessage,
): Promise<void> {
  if (message.chat.type !== 'private') return;

  const senderId = String(message.chat.id);
  const text = (message.text ?? '').trim();
  const isHost = senderId === host.hostUid;
  const locale = localeFromMessage(message);

  const state = await getState(env.nfd, senderId);

  // Awaiting-token state: intercept escape commands first, otherwise treat the input as the token.
  if (state.step === 'awaiting_token') {
    if (text === '/cancel') {
      await setState(env.nfd, senderId, { step: 'idle' });
      await reply(host, senderId, T.manager.onboardingCancelled[locale]());
      return;
    }
    if (text === '/help') {
      await reply(host, senderId, T.manager.helpText[locale](isHost));
      return;
    }
    await handleTokenInput(env, host, baseUrl, senderId, text, locale);
    return;
  }

  if (text === '/start') {
    await reply(host, senderId, T.manager.welcome[locale]());
    return;
  }
  if (text === '/help') {
    await reply(host, senderId, T.manager.helpText[locale](isHost));
    return;
  }
  if (text === '/whoami') {
    await reply(host, senderId, T.manager.whoami[locale](senderId));
    return;
  }
  if (text === '/cancel') {
    await setState(env.nfd, senderId, { step: 'idle' });
    await reply(host, senderId, T.manager.stateReset[locale]());
    return;
  }
  if (text === '/setup') {
    await setState(env.nfd, senderId, { step: 'awaiting_token' });
    await reply(host, senderId, T.manager.setupPrompt[locale]());
    return;
  }
  if (text === '/list') {
    await handleList(env, host, senderId, locale);
    return;
  }

  // [\s\S] (not .) so args spanning newlines (e.g. multi-line /start_message) still match.
  const m = text.match(/^\/(\w+)(?:\s+([\s\S]+))?$/);
  if (!m) {
    await reply(host, senderId, T.manager.unknownNoName[locale]());
    return;
  }
  const cmd = m[1];
  const args = (m[2] ?? '').trim();

  switch (cmd) {
    case 'info':
      await handleInfo(env, host, senderId, args, isHost, locale);
      return;
    case 'displaymode':
      await handleDisplaymode(env, host, senderId, args, isHost, locale);
      return;
    case 'admins':
      await handleAdmins(env, host, senderId, args, isHost, locale);
      return;
    case 'start_message':
      await handleStartMessage(env, host, senderId, args, isHost, locale);
      return;
    case 'pause':
      await handlePauseResume(env, host, baseUrl, senderId, args, true, isHost, locale);
      return;
    case 'resume':
      await handlePauseResume(env, host, baseUrl, senderId, args, false, isHost, locale);
      return;
    case 'delete':
      await handleDelete(env, host, senderId, args, isHost, locale);
      return;
    case 'host_list':
      if (!isHost) {
        await reply(host, senderId, T.manager.hostOnly[locale]());
        return;
      }
      await handleHostList(env, host, senderId, locale);
      return;
    case 'host_disable':
      if (!isHost) {
        await reply(host, senderId, T.manager.hostOnly[locale]());
        return;
      }
      await handleHostDisable(env, host, senderId, args, locale);
      return;
    case 'host_purge':
      if (!isHost) {
        await reply(host, senderId, T.manager.hostOnly[locale]());
        return;
      }
      await handleHostPurge(env, host, senderId, args, locale);
      return;
    default:
      await reply(host, senderId, T.manager.unknownCmd[locale](cmd));
  }
}

async function reply(host: HostConfig, chatId: string | number, text: string): Promise<void> {
  try {
    await tg.sendMessage(host.managerBotToken, { chat_id: chatId, text });
  } catch (e) {
    if (e instanceof TelegramError) {
      logError('manager_reply', e);
      return;
    }
    throw e;
  }
}

// Send long content as multiple chunks — Telegram caps a single message at 4096 chars.
async function replyChunked(
  host: HostConfig,
  chatId: string,
  header: string,
  lines: string[],
): Promise<void> {
  let buf = header;
  for (const line of lines) {
    const candidate = buf.length === 0 ? line : `${buf}\n${line}`;
    if (candidate.length > REPLY_MAX_LEN) {
      if (buf.length > 0) await reply(host, chatId, buf);
      buf = line;
    } else {
      buf = candidate;
    }
  }
  if (buf.length > 0) await reply(host, chatId, buf);
}

async function handleTokenInput(
  env: Env,
  host: HostConfig,
  baseUrl: string,
  senderId: string,
  token: string,
  locale: Locale,
): Promise<void> {
  const m = token.match(/^(\d+):[A-Za-z0-9_-]+$/);
  if (!m) {
    await reply(host, senderId, T.manager.tokenInvalid[locale]());
    return;
  }
  const botId = m[1];

  // Refuse to onboard the manager bot's own token —— would otherwise hijack the platform.
  if (botId === host.managerBotId) {
    await setState(env.nfd, senderId, { step: 'idle' });
    await reply(host, senderId, T.manager.cannotOnboardSelf[locale]());
    return;
  }

  const encKey = await getEncKey(host.masterEncKey);

  const existing = await getStored(env.nfd, botId);
  if (existing) {
    await setState(env.nfd, senderId, { step: 'idle' });
    await reply(
      host,
      senderId,
      T.manager.botAlreadyOnboarded[locale](existing.botUsername, existing.ownerUid),
    );
    return;
  }

  let me: tg.TgMe;
  try {
    me = await tg.getMe(token);
  } catch (e) {
    await setState(env.nfd, senderId, { step: 'idle' });
    await reply(
      host,
      senderId,
      T.manager.getMeFailed[locale](e instanceof TelegramError ? e.detail : 'unknown'),
    );
    return;
  }

  const cfg = await createTenant(env.nfd, encKey, {
    token,
    ownerUid: senderId,
    botUsername: me.username,
    botId,
  });

  const target = `${baseUrl}/wh/${botId}`;
  try {
    await tg.setWebhook(token, { url: target, secret_token: cfg.webhookSecret });
  } catch (e) {
    // Roll back the partially-onboarded tenant — orphan record would otherwise occupy the botId slot.
    try {
      await deleteStored(env.nfd, botId);
    } catch {
      // best effort
    }
    await setState(env.nfd, senderId, { step: 'idle' });
    await reply(
      host,
      senderId,
      T.manager.setupWebhookFailed[locale](e instanceof TelegramError ? e.detail : 'unknown'),
    );
    return;
  }

  await setState(env.nfd, senderId, { step: 'idle' });
  logEvent(host.debug, 'tenant_created', { botId, owner: senderId });

  await reply(host, senderId, T.manager.onboardSuccess[locale](me.username, senderId));
}

async function handleList(
  env: Env,
  host: HostConfig,
  senderId: string,
  locale: Locale,
): Promise<void> {
  const owned = await listStoredByOwner(env.nfd, senderId);
  if (owned.length === 0) {
    await reply(host, senderId, T.manager.listEmpty[locale]());
    return;
  }
  const lines = owned.map(
    ({ cfg }) =>
      `@${cfg.botUsername} - ${cfg.paused ? 'paused' : 'active'} - ${cfg.displayMode}`,
  );
  await replyChunked(host, senderId, T.manager.listHeader[locale](), lines);
}

async function resolveStored(
  env: Env,
  arg: string,
  ownerUid: string,
  isHost: boolean,
  locale: Locale,
): Promise<StoredEntry | string> {
  const username = arg.trim().split(/\s+/)[0];
  if (!username) return T.manager.needBotUsername[locale]();
  const entry = await findStoredByUsername(
    env.nfd,
    username,
    isHost ? undefined : ownerUid,
  );
  if (!entry) return T.manager.botNotFound[locale](username);
  return entry;
}

async function handleInfo(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
  locale: Locale,
): Promise<void> {
  const r = await resolveStored(env, args, senderId, isHost, locale);
  if (typeof r === 'string') return reply(host, senderId, r);
  const { botId, cfg } = r;
  const created = new Date(cfg.createdAt).toISOString().slice(0, 10);
  await reply(
    host,
    senderId,
    [
      `@${cfg.botUsername}`,
      `bot_id: ${botId}`,
      `owner: ${cfg.ownerUid}`,
      `admins: ${cfg.adminUids.join(', ')}`,
      `display: ${cfg.displayMode}`,
      `status: ${cfg.paused ? 'paused' : 'active'}`,
      `created: ${created}`,
    ].join('\n'),
  );
}

async function handleDisplaymode(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
  locale: Locale,
): Promise<void> {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    await reply(host, senderId, T.manager.displaymodeUsage[locale]());
    return;
  }
  const [username, modeRaw] = parts;
  const mode = modeRaw.toLowerCase();
  if (mode !== 'native' && mode !== 'tag' && mode !== 'hex') {
    await reply(host, senderId, T.manager.displaymodeInvalid[locale]());
    return;
  }
  const r = await resolveStored(env, username, senderId, isHost, locale);
  if (typeof r === 'string') return reply(host, senderId, r);
  r.cfg.displayMode = mode as DisplayMode;
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(host, senderId, T.manager.displaymodeSet[locale](r.cfg.botUsername, mode));
}

async function handlePauseResume(
  env: Env,
  host: HostConfig,
  baseUrl: string,
  senderId: string,
  args: string,
  pause: boolean,
  isHost: boolean,
  locale: Locale,
): Promise<void> {
  const r = await resolveStored(env, args, senderId, isHost, locale);
  if (typeof r === 'string') return reply(host, senderId, r);

  const encKey = await getEncKey(host.masterEncKey);
  const token = await decryptToken(r.cfg, encKey);

  if (pause) {
    try {
      await tg.deleteWebhook(token);
    } catch (e) {
      if (!(e instanceof TelegramError)) throw e;
    }
    r.cfg.paused = true;
    await putStored(env.nfd, r.botId, r.cfg);
    await reply(host, senderId, T.manager.paused[locale](r.cfg.botUsername));
    return;
  }

  const target = `${baseUrl}/wh/${r.botId}`;
  try {
    await tg.setWebhook(token, { url: target, secret_token: r.cfg.webhookSecret });
  } catch (e) {
    await reply(
      host,
      senderId,
      T.manager.webhookFailed[locale](e instanceof TelegramError ? e.detail : 'unknown'),
    );
    return;
  }
  r.cfg.paused = false;
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(host, senderId, T.manager.resumed[locale](r.cfg.botUsername));
}

async function handleDelete(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
  locale: Locale,
): Promise<void> {
  const parts = args.split(/\s+/);
  const username = parts[0];
  const yes = parts.includes('--yes');
  if (!username) {
    await reply(host, senderId, T.manager.deleteUsage[locale]());
    return;
  }
  const r = await resolveStored(env, username, senderId, isHost, locale);
  if (typeof r === 'string') return reply(host, senderId, r);

  if (!yes) {
    await reply(host, senderId, T.manager.deleteConfirm[locale](r.cfg.botUsername));
    return;
  }
  const encKey = await getEncKey(host.masterEncKey);
  const purged = await deleteTenant(env.nfd, r.botId, encKey);
  await reply(host, senderId, T.manager.deleted[locale](r.cfg.botUsername, purged));
  logEvent(host.debug, 'tenant_deleted', { botId: r.botId, owner: senderId });
}

async function handleHostList(
  env: Env,
  host: HostConfig,
  senderId: string,
  locale: Locale,
): Promise<void> {
  const all = await listStored(env.nfd);
  if (all.length === 0) {
    await reply(host, senderId, T.manager.hostListEmpty[locale]());
    return;
  }
  const lines = all.map(
    ({ cfg }) =>
      `@${cfg.botUsername} - owner ${cfg.ownerUid} - ${cfg.paused ? 'paused' : 'active'}`,
  );
  await replyChunked(host, senderId, T.manager.hostListHeader[locale](lines.length), lines);
}

async function handleAdmins(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
  locale: Locale,
): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    await reply(host, senderId, T.manager.adminsUsage[locale]());
    return;
  }
  const [username, action = 'list', uid] = parts;

  const r = await resolveStored(env, username, senderId, isHost, locale);
  if (typeof r === 'string') {
    await reply(host, senderId, r);
    return;
  }

  if (action === 'list') {
    const lines = r.cfg.adminUids.map(
      (u) => `· ${u}${u === r.cfg.ownerUid ? ' (owner)' : ''}`,
    );
    await reply(
      host,
      senderId,
      [T.manager.adminsListHeader[locale](r.cfg.botUsername), ...lines].join('\n'),
    );
    return;
  }

  if (action !== 'add' && action !== 'remove') {
    await reply(host, senderId, T.manager.adminsActionInvalid[locale]());
    return;
  }

  if (!uid) {
    await reply(host, senderId, T.manager.adminsUsageWithAction[locale](action));
    return;
  }

  if (!/^\d+$/.test(uid)) {
    await reply(host, senderId, T.manager.uidMustBeNumeric[locale]());
    return;
  }

  if (action === 'add') {
    if (r.cfg.adminUids.includes(uid)) {
      await reply(host, senderId, T.manager.adminAlready[locale](uid, r.cfg.botUsername));
      return;
    }
    r.cfg.adminUids = [...r.cfg.adminUids, uid];
    await putStored(env.nfd, r.botId, r.cfg);
    await reply(host, senderId, T.manager.adminAdded[locale](uid, r.cfg.adminUids.length));
    return;
  }

  // action === 'remove'
  if (uid === r.cfg.ownerUid) {
    await reply(host, senderId, T.manager.cannotRemoveOwner[locale]());
    return;
  }
  if (!r.cfg.adminUids.includes(uid)) {
    await reply(host, senderId, T.manager.adminNotInList[locale](uid, r.cfg.botUsername));
    return;
  }
  r.cfg.adminUids = r.cfg.adminUids.filter((u) => u !== uid);
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(host, senderId, T.manager.adminRemoved[locale](uid, r.cfg.adminUids.length));
}

const START_MESSAGE_MAX = 1000;

async function handleStartMessage(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
  locale: Locale,
): Promise<void> {
  const m = args.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) {
    await reply(host, senderId, T.manager.startMessageUsage[locale](START_MESSAGE_MAX));
    return;
  }
  const [, username, contentRaw] = m;
  const content = contentRaw.trim();
  if (content.length === 0) {
    await reply(host, senderId, T.manager.startMessageEmpty[locale]());
    return;
  }
  if (content.length > START_MESSAGE_MAX) {
    await reply(
      host,
      senderId,
      T.manager.startMessageTooLong[locale](content.length, START_MESSAGE_MAX),
    );
    return;
  }

  const r = await resolveStored(env, username, senderId, isHost, locale);
  if (typeof r === 'string') {
    await reply(host, senderId, r);
    return;
  }

  r.cfg.startMessage = content;
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(
    host,
    senderId,
    T.manager.startMessageUpdated[locale](r.cfg.botUsername, content.length),
  );
}

async function handleHostDisable(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  locale: Locale,
): Promise<void> {
  const r = await resolveStored(env, args, senderId, true, locale);
  if (typeof r === 'string') {
    await reply(host, senderId, r);
    return;
  }

  const encKey = await getEncKey(host.masterEncKey);
  const token = await decryptToken(r.cfg, encKey);
  try {
    await tg.deleteWebhook(token);
  } catch (e) {
    if (!(e instanceof TelegramError)) throw e;
  }
  r.cfg.paused = true;
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(
    host,
    senderId,
    T.manager.hostDisabled[locale](r.cfg.botUsername, r.cfg.ownerUid),
  );
  logEvent(host.debug, 'host_disabled', { botId: r.botId, owner: r.cfg.ownerUid });
}

async function handleHostPurge(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  locale: Locale,
): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  const username = parts[0];
  const yes = parts.includes('--yes');
  if (!username) {
    await reply(host, senderId, T.manager.hostPurgeUsage[locale]());
    return;
  }

  const r = await resolveStored(env, username, senderId, true, locale);
  if (typeof r === 'string') {
    await reply(host, senderId, r);
    return;
  }

  if (!yes) {
    await reply(
      host,
      senderId,
      T.manager.hostPurgeConfirm[locale](r.cfg.botUsername, r.cfg.ownerUid),
    );
    return;
  }

  const encKey = await getEncKey(host.masterEncKey);
  const purged = await deleteTenant(env.nfd, r.botId, encKey);
  await reply(
    host,
    senderId,
    T.manager.hostPurged[locale](r.cfg.botUsername, purged, r.cfg.ownerUid),
  );
  logEvent(host.debug, 'host_purged', { botId: r.botId, owner: r.cfg.ownerUid });
}
