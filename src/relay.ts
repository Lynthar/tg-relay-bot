import {
  MSG_MAP_TTL_SEC,
  RATE_LIMIT_WINDOW_SEC,
  RATE_LIMIT_MAX,
  MEDIA_GROUP_TAG_TTL_SEC,
} from './config';
import * as tg from './telegram';
import { TelegramError } from './telegram';
import { putMsgMap, type MsgMapEntry, type ScopedKV } from './storage';
import { userKey, isBlocked, checkRateLimit, logEvent, logError } from './security';
import { handleAdminMessage } from './commands';
import type { TgMessage } from './types';
import type { TenantCfg } from './tenant';
import { localeFromMessage, T } from './i18n';

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
  const locale = localeFromMessage(message);

  if (text === '/start') {
    await tg.sendMessage(cfg.botToken, { chat_id: message.chat.id, text: cfg.startMessage });
    return;
  }
  if (text === '/help') {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.relay.help[locale](isAdmin),
    });
    return;
  }
  if (text === '/whoami') {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.relay.whoami[locale](String(message.chat.id)),
    });
    return;
  }

  if (isAdmin) {
    await handleAdminMessage(cfg, skv, debug, message, locale);
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
        const emitTag = message.media_group_id
          ? await shouldEmitTag(skv, adminId, message.media_group_id)
          : true;
        if (emitTag) {
          const tagText = useHtml ? buildRichTag(message, uk) : buildHexTag(message, uk);
          const tagMsg = await tg.sendMessage(cfg.botToken, {
            chat_id: adminId,
            text: tagText,
            ...(useHtml ? { parse_mode: 'HTML' as const, disable_web_page_preview: true } : {}),
          });
          await putMsgMap(skv, tagMsg.message_id, entry, MSG_MAP_TTL_SEC);
        }
        const copied = await tg.copyMessage(cfg.botToken, {
          chat_id: adminId,
          from_chat_id: message.chat.id,
          message_id: message.message_id,
        });
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

// Per-admin dedup of the album-leader tag. Same media_group_id within the TTL emits the tag only
// once per admin; subsequent items still get copyMessage'd. Race-prone (no SETNX), but the worst
// case is "one extra tag or one missing tag" — never a data error.
async function shouldEmitTag(
  skv: ScopedKV,
  adminId: string,
  mediaGroupId: string,
): Promise<boolean> {
  const key = `mg-${adminId}-${mediaGroupId}`;
  if (await skv.getString(key)) return false;
  await skv.put(key, '1', MEDIA_GROUP_TAG_TTL_SEC);
  return true;
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
