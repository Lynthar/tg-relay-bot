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

  const state = await getState(env.nfd, senderId);

  // Awaiting-token state: intercept escape commands first, otherwise treat the input as the token.
  if (state.step === 'awaiting_token') {
    if (text === '/cancel') {
      await setState(env.nfd, senderId, { step: 'idle' });
      await reply(host, senderId, '已取消接入流程。');
      return;
    }
    if (text === '/help') {
      await reply(host, senderId, helpText(isHost));
      return;
    }
    await handleTokenInput(env, host, baseUrl, senderId, text);
    return;
  }

  if (text === '/start') {
    await reply(host, senderId, '欢迎使用 Relay-Bot 管家。\n/setup 接入新 bot；/help 查看完整命令清单。');
    return;
  }
  if (text === '/help') {
    await reply(host, senderId, helpText(isHost));
    return;
  }
  if (text === '/whoami') {
    await reply(host, senderId, `Your chat id: ${senderId}`);
    return;
  }
  if (text === '/cancel') {
    await setState(env.nfd, senderId, { step: 'idle' });
    await reply(host, senderId, '已重置会话状态。');
    return;
  }
  if (text === '/setup') {
    await setState(env.nfd, senderId, { step: 'awaiting_token' });
    await reply(
      host,
      senderId,
      '请粘贴你从 BotFather 拿到的 bot token（形如 12345:ABC...）。\n/cancel 中止。',
    );
    return;
  }
  if (text === '/list') {
    await handleList(env, host, senderId);
    return;
  }

  // [\s\S] (not .) so args spanning newlines (e.g. multi-line /start_message) still match.
  const m = text.match(/^\/(\w+)(?:\s+([\s\S]+))?$/);
  if (!m) {
    await reply(host, senderId, '未知命令。/help 查看可用命令。');
    return;
  }
  const cmd = m[1];
  const args = (m[2] ?? '').trim();

  switch (cmd) {
    case 'info':
      await handleInfo(env, host, senderId, args, isHost);
      return;
    case 'displaymode':
      await handleDisplaymode(env, host, senderId, args, isHost);
      return;
    case 'admins':
      await handleAdmins(env, host, senderId, args, isHost);
      return;
    case 'start_message':
      await handleStartMessage(env, host, senderId, args, isHost);
      return;
    case 'pause':
      await handlePauseResume(env, host, baseUrl, senderId, args, true, isHost);
      return;
    case 'resume':
      await handlePauseResume(env, host, baseUrl, senderId, args, false, isHost);
      return;
    case 'delete':
      await handleDelete(env, host, senderId, args, isHost);
      return;
    case 'host_list':
      if (!isHost) {
        await reply(host, senderId, '仅 host 可用。');
        return;
      }
      await handleHostList(env, host, senderId);
      return;
    case 'host_disable':
      if (!isHost) {
        await reply(host, senderId, '仅 host 可用。');
        return;
      }
      await handleHostDisable(env, host, senderId, args);
      return;
    case 'host_purge':
      if (!isHost) {
        await reply(host, senderId, '仅 host 可用。');
        return;
      }
      await handleHostPurge(env, host, senderId, args);
      return;
    default:
      await reply(host, senderId, `未知命令 /${cmd}。/help 查看可用命令。`);
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

function helpText(isHost: boolean): string {
  const base = [
    '管家 bot 命令：',
    '',
    '/setup - 接入一个新 bot（粘贴 BotFather 给的 token）',
    '/list - 看你拥有的所有 bot',
    '/info <bot_username> - 看某个 bot 的详细信息',
    '/displaymode <bot_username> <native|tag|hex> - 切换显示模式',
    '/admins <bot_username> [add|remove <uid> | list] - 管理管理员',
    '/start_message <bot_username> <文案> - 自定义 /start 文案（支持多行）',
    '/pause <bot_username> - 暂停（注销 webhook）',
    '/resume <bot_username> - 恢复（重新注册 webhook）',
    '/delete <bot_username> - 删除 bot（再加 --yes 真正执行）',
    '/whoami - 显示你的 Telegram UID',
    '/cancel - 重置当前会话状态',
  ];
  if (isHost) {
    base.push(
      '',
      'Host 命令：',
      '/host_list - 列出所有租户',
      '/host_disable <bot_username> - 强制暂停任意 tenant',
      '/host_purge <bot_username> --yes - 强制删除任意 tenant',
    );
  }
  return base.join('\n');
}

async function handleTokenInput(
  env: Env,
  host: HostConfig,
  baseUrl: string,
  senderId: string,
  token: string,
): Promise<void> {
  const m = token.match(/^(\d+):[A-Za-z0-9_-]+$/);
  if (!m) {
    await reply(host, senderId, '看起来不是有效的 token。请重新粘贴，或 /cancel 中止。');
    return;
  }
  const botId = m[1];

  // Refuse to onboard the manager bot's own token —— would otherwise hijack the platform.
  if (botId === host.managerBotId) {
    await setState(env.nfd, senderId, { step: 'idle' });
    await reply(
      host,
      senderId,
      '不能用管家 bot 自己的 token 来 onboard。请改用其他 BotFather 创建的 bot 的 token。',
    );
    return;
  }

  const encKey = await getEncKey(host.masterEncKey);

  const existing = await getStored(env.nfd, botId);
  if (existing) {
    await setState(env.nfd, senderId, { step: 'idle' });
    await reply(
      host,
      senderId,
      `这个 bot (@${existing.botUsername}) 已被 onboard，所有者 ${existing.ownerUid}。如要重置，所有者须先 /delete ${existing.botUsername} --yes`,
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
      'Telegram API 验证失败：' +
        (e instanceof TelegramError ? e.detail : 'unknown') +
        '\n请确认 token 正确，或 /setup 重试。',
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
      'setWebhook 失败：' +
        (e instanceof TelegramError ? e.detail : 'unknown') +
        '\n租户记录已回滚。请检查网络后 /setup 重试。',
    );
    return;
  }

  await setState(env.nfd, senderId, { step: 'idle' });
  logEvent(host.debug, 'tenant_created', { botId, owner: senderId });

  await reply(
    host,
    senderId,
    [
      `✅ @${me.username} 已上线！`,
      '',
      '默认配置：',
      `· 管理员：${senderId}（即你）`,
      '· 显示模式：native（Telegram 原生 forward UI）',
      '· 限速：60s 内每访客 5 条',
      '',
      '常用命令（带上 bot 用户名）：',
      `/info ${me.username}`,
      `/displaymode ${me.username} tag`,
      `/pause ${me.username}`,
      '',
      '⚠️ 你刚才发的 token 还在我们的对话里。建议长按那条消息选 "Delete for me and bot" 把它从两端清除。',
    ].join('\n'),
  );
}

async function handleList(env: Env, host: HostConfig, senderId: string): Promise<void> {
  const owned = await listStoredByOwner(env.nfd, senderId);
  if (owned.length === 0) {
    await reply(host, senderId, '你还没有 onboard 任何 bot。/setup 开始。');
    return;
  }
  const lines = owned.map(
    ({ cfg }) =>
      `@${cfg.botUsername} - ${cfg.paused ? 'paused' : 'active'} - ${cfg.displayMode}`,
  );
  await replyChunked(host, senderId, '你拥有的 bot：', lines);
}

async function resolveStored(
  env: Env,
  arg: string,
  ownerUid: string,
  isHost: boolean,
): Promise<StoredEntry | string> {
  const username = arg.trim().split(/\s+/)[0];
  if (!username) return '请提供 bot 用户名，例如 /info your_bot 或 /info @your_bot';
  const entry = await findStoredByUsername(
    env.nfd,
    username,
    isHost ? undefined : ownerUid,
  );
  if (!entry) return `未找到 ${username}（注意是否你拥有的 bot）。`;
  return entry;
}

async function handleInfo(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
): Promise<void> {
  const r = await resolveStored(env, args, senderId, isHost);
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
): Promise<void> {
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    await reply(host, senderId, '用法：/displaymode <bot_username> <native|tag|hex>');
    return;
  }
  const [username, modeRaw] = parts;
  const mode = modeRaw.toLowerCase();
  if (mode !== 'native' && mode !== 'tag' && mode !== 'hex') {
    await reply(host, senderId, '模式必须是 native / tag / hex 之一。');
    return;
  }
  const r = await resolveStored(env, username, senderId, isHost);
  if (typeof r === 'string') return reply(host, senderId, r);
  r.cfg.displayMode = mode as DisplayMode;
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(host, senderId, `@${r.cfg.botUsername} 的显示模式已设为 ${mode}。`);
}

async function handlePauseResume(
  env: Env,
  host: HostConfig,
  baseUrl: string,
  senderId: string,
  args: string,
  pause: boolean,
  isHost: boolean,
): Promise<void> {
  const r = await resolveStored(env, args, senderId, isHost);
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
    await reply(host, senderId, `@${r.cfg.botUsername} 已暂停（webhook 已注销）。`);
    return;
  }

  const target = `${baseUrl}/wh/${r.botId}`;
  try {
    await tg.setWebhook(token, { url: target, secret_token: r.cfg.webhookSecret });
  } catch (e) {
    await reply(
      host,
      senderId,
      'setWebhook 失败：' + (e instanceof TelegramError ? e.detail : 'unknown'),
    );
    return;
  }
  r.cfg.paused = false;
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(host, senderId, `@${r.cfg.botUsername} 已恢复（webhook 已重注册）。`);
}

async function handleDelete(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
): Promise<void> {
  const parts = args.split(/\s+/);
  const username = parts[0];
  const yes = parts.includes('--yes');
  if (!username) {
    await reply(host, senderId, '用法：/delete <bot_username> --yes');
    return;
  }
  const r = await resolveStored(env, username, senderId, isHost);
  if (typeof r === 'string') return reply(host, senderId, r);

  if (!yes) {
    await reply(
      host,
      senderId,
      `确认删除 @${r.cfg.botUsername} 吗？将注销 webhook 并清除全部相关 KV 数据，不可撤销。\n如确认：/delete ${r.cfg.botUsername} --yes`,
    );
    return;
  }
  const encKey = await getEncKey(host.masterEncKey);
  const purged = await deleteTenant(env.nfd, r.botId, encKey);
  await reply(host, senderId, `@${r.cfg.botUsername} 已删除（清除了 ${purged} 个 KV 键）。`);
  logEvent(host.debug, 'tenant_deleted', { botId: r.botId, owner: senderId });
}

async function handleHostList(env: Env, host: HostConfig, senderId: string): Promise<void> {
  const all = await listStored(env.nfd);
  if (all.length === 0) {
    await reply(host, senderId, '当前无 tenant。');
    return;
  }
  const lines = all.map(
    ({ cfg }) =>
      `@${cfg.botUsername} - owner ${cfg.ownerUid} - ${cfg.paused ? 'paused' : 'active'}`,
  );
  await replyChunked(host, senderId, `所有 tenant (${lines.length})：`, lines);
}

async function handleAdmins(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    await reply(host, senderId, '用法：/admins <bot_username> [add|remove <uid> | list]');
    return;
  }
  const [username, action = 'list', uid] = parts;

  const r = await resolveStored(env, username, senderId, isHost);
  if (typeof r === 'string') {
    await reply(host, senderId, r);
    return;
  }

  if (action === 'list') {
    const lines = r.cfg.adminUids.map(
      (u) => `· ${u}${u === r.cfg.ownerUid ? ' (owner)' : ''}`,
    );
    await reply(host, senderId, [`@${r.cfg.botUsername} admins:`, ...lines].join('\n'));
    return;
  }

  if (action !== 'add' && action !== 'remove') {
    await reply(host, senderId, '动作必须是 add / remove / list 之一。');
    return;
  }

  if (!uid) {
    await reply(host, senderId, `用法：/admins <bot_username> ${action} <uid>`);
    return;
  }

  if (!/^\d+$/.test(uid)) {
    await reply(host, senderId, 'UID 必须是纯数字（Telegram 用户 ID）。');
    return;
  }

  if (action === 'add') {
    if (r.cfg.adminUids.includes(uid)) {
      await reply(host, senderId, `${uid} 已经是 @${r.cfg.botUsername} 的管理员。`);
      return;
    }
    r.cfg.adminUids = [...r.cfg.adminUids, uid];
    await putStored(env.nfd, r.botId, r.cfg);
    await reply(
      host,
      senderId,
      `已添加管理员 ${uid}。当前 ${r.cfg.adminUids.length} 人。`,
    );
    return;
  }

  // action === 'remove'
  if (uid === r.cfg.ownerUid) {
    await reply(
      host,
      senderId,
      '不能移除 owner。如需转移所有权请 /delete 后由新 owner 重新 onboard。',
    );
    return;
  }
  if (!r.cfg.adminUids.includes(uid)) {
    await reply(host, senderId, `${uid} 不在 @${r.cfg.botUsername} 的管理员列表中。`);
    return;
  }
  r.cfg.adminUids = r.cfg.adminUids.filter((u) => u !== uid);
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(
    host,
    senderId,
    `已移除管理员 ${uid}。当前 ${r.cfg.adminUids.length} 人。`,
  );
}

const START_MESSAGE_MAX = 1000;

async function handleStartMessage(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
  isHost: boolean,
): Promise<void> {
  const m = args.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) {
    await reply(
      host,
      senderId,
      `用法：/start_message <bot_username> <文案>\n（支持多行，最长 ${START_MESSAGE_MAX} 字符）`,
    );
    return;
  }
  const [, username, contentRaw] = m;
  const content = contentRaw.trim();
  if (content.length === 0) {
    await reply(host, senderId, '文案不能为空。');
    return;
  }
  if (content.length > START_MESSAGE_MAX) {
    await reply(
      host,
      senderId,
      `文案过长（${content.length} > 上限 ${START_MESSAGE_MAX} 字符）。`,
    );
    return;
  }

  const r = await resolveStored(env, username, senderId, isHost);
  if (typeof r === 'string') {
    await reply(host, senderId, r);
    return;
  }

  r.cfg.startMessage = content;
  await putStored(env.nfd, r.botId, r.cfg);
  await reply(
    host,
    senderId,
    `@${r.cfg.botUsername} 的 /start 文案已更新（${content.length} 字符）。`,
  );
}

async function handleHostDisable(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
): Promise<void> {
  const r = await resolveStored(env, args, senderId, true);
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
    `@${r.cfg.botUsername} 已被 host 暂停（owner ${r.cfg.ownerUid}）。`,
  );
  logEvent(host.debug, 'host_disabled', { botId: r.botId, owner: r.cfg.ownerUid });
}

async function handleHostPurge(
  env: Env,
  host: HostConfig,
  senderId: string,
  args: string,
): Promise<void> {
  const parts = args.split(/\s+/).filter(Boolean);
  const username = parts[0];
  const yes = parts.includes('--yes');
  if (!username) {
    await reply(host, senderId, '用法：/host_purge <bot_username> --yes');
    return;
  }

  const r = await resolveStored(env, username, senderId, true);
  if (typeof r === 'string') {
    await reply(host, senderId, r);
    return;
  }

  if (!yes) {
    await reply(
      host,
      senderId,
      `确认强制删除 @${r.cfg.botUsername}（owner ${r.cfg.ownerUid}）？将注销 webhook 并清除全部数据，不可撤销。\n如确认：/host_purge ${r.cfg.botUsername} --yes`,
    );
    return;
  }

  const encKey = await getEncKey(host.masterEncKey);
  const purged = await deleteTenant(env.nfd, r.botId, encKey);
  await reply(
    host,
    senderId,
    `@${r.cfg.botUsername} 已被 host 删除（清除 ${purged} 个 KV 键，原 owner ${r.cfg.ownerUid}）。`,
  );
  logEvent(host.debug, 'host_purged', { botId: r.botId, owner: r.cfg.ownerUid });
}
