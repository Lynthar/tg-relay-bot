import { MSG_MAP_TTL_SEC, RATE_LIMIT_WINDOW_SEC, RATE_LIMIT_MAX } from './config';
import * as tg from './telegram';
import { TelegramError } from './telegram';
import { putMsgMap, type MsgMapEntry, type ScopedKV } from './storage';
import { userKey, isBlocked, checkRateLimit, logEvent, logError } from './security';
import { handleAdminMessage } from './commands';
import type { TgMessage } from './types';
import type { TenantCfg } from './tenant';

export async function handleMessage(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
): Promise<void> {
  if (message.chat.type !== 'private') return;

  const senderId = String(message.chat.id);
  const text = message.text ?? '';
  const isAdmin = cfg.adminUids.has(senderId);

  if (text === '/start') {
    await tg.sendMessage(cfg.botToken, { chat_id: message.chat.id, text: cfg.startMessage });
    return;
  }
  if (text === '/help') {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: buildHelpText(isAdmin),
    });
    return;
  }
  if (text === '/whoami') {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: `Your chat id: ${message.chat.id}`,
    });
    return;
  }

  if (isAdmin) {
    await handleAdminMessage(cfg, skv, debug, message);
    return;
  }

  const uk = await userKey(senderId, cfg.hashSecret);

  if (await isBlocked(skv, uk)) {
    logEvent(debug, 'guest_blocked', { uk });
    return;
  }

  const allowed = await checkRateLimit(skv, uk, RATE_LIMIT_WINDOW_SEC, RATE_LIMIT_MAX);
  if (!allowed) {
    logEvent(debug, 'guest_rate_limited', { uk });
    return;
  }

  await relayToAdmins(cfg, skv, debug, message, uk);
}

function buildHelpText(isAdmin: boolean): string {
  if (isAdmin) {
    return [
      '管理员命令：',
      '/start /help /whoami - 通用',
      '/status - 查看 bot 运行状态',
      '',
      '回复一条转发的消息：',
      '  发任意内容 → 回复给原发送者',
      '  发 /block /unblock /checkblock → 屏蔽管理',
    ].join('\n');
  }
  return [
    '可用命令：',
    '/start - 欢迎语',
    '/help - 显示此帮助',
    '/whoami - 显示你的 Telegram UID',
    '',
    '直接发送消息即可联系运营者。',
  ].join('\n');
}

async function relayToAdmins(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
  uk: string,
): Promise<void> {
  const entry: MsgMapEntry = {
    chatId: message.chat.id,
    userKey: uk,
    createdAt: Date.now(),
  };

  for (const adminId of cfg.adminUids) {
    try {
      if (cfg.displayMode === 'native') {
        const fwd = await tg.forwardMessage(cfg.botToken, {
          chat_id: adminId,
          from_chat_id: message.chat.id,
          message_id: message.message_id,
        });
        await putMsgMap(skv, fwd.message_id, entry, MSG_MAP_TTL_SEC);
      } else {
        const useHtml = cfg.displayMode === 'tag';
        const tagText = useHtml ? buildRichTag(message, uk) : buildHexTag(message, uk);
        const tagMsg = await tg.sendMessage(cfg.botToken, {
          chat_id: adminId,
          text: tagText,
          ...(useHtml ? { parse_mode: 'HTML' as const, disable_web_page_preview: true } : {}),
        });
        const copied = await tg.copyMessage(cfg.botToken, {
          chat_id: adminId,
          from_chat_id: message.chat.id,
          message_id: message.message_id,
        });
        await putMsgMap(skv, tagMsg.message_id, entry, MSG_MAP_TTL_SEC);
        await putMsgMap(skv, copied.message_id, entry, MSG_MAP_TTL_SEC);
      }
      logEvent(debug, 'forwarded', { uk, admin: adminId });
    } catch (e) {
      if (e instanceof TelegramError) {
        logError('forward', e);
        continue;
      }
      throw e;
    }
  }
}

function buildHexTag(message: TgMessage, uk: string): string {
  return `↘ ${uk}${message.media_group_id ? ' · album' : ''}`;
}

function buildRichTag(message: TgMessage, uk: string): string {
  const u = message.from;
  const album = message.media_group_id ? ' · album' : '';
  if (!u) return `↘ <code>${uk}</code>${album}`;
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'user';
  const escapedName = htmlEscape(fullName);
  const handle = u.username ? ` · @${htmlEscape(u.username)}` : '';
  return `↘ <a href="tg://user?id=${u.id}">${escapedName}</a>${handle} · id:<code>${u.id}</code>${album}`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
