import {
  MSG_MAP_TTL_SEC,
  RATE_LIMIT_WINDOW_SEC,
  RATE_LIMIT_MAX,
  MEDIA_GROUP_TAG_TTL_SEC,
  DEDUP_TTL_SEC,
} from './config';
import * as tg from './telegram';
import { TelegramError, parseBotCommand } from './telegram';
import { putMsgMap, type MsgMapEntry, type ScopedKV } from './storage';
import {
  userKey,
  isBlocked,
  checkRateLimit,
  markUpdateSeen,
  tryPut,
  logEvent,
  logError,
} from './security';
import { handleAdminMessage } from './commands';
import type { TgMessage } from './types';
import type { TenantCfg } from './tenant';
import { localeFromMessage, T } from './i18n';

export async function handleMessage(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
  updateId: number,
): Promise<void> {
  if (message.chat.type !== 'private') return;

  const senderId = String(message.chat.id);
  const text = message.text ?? '';
  const isAdmin = cfg.adminUids.has(senderId);
  const locale = localeFromMessage(message);

  const cmd = parseBotCommand(text, cfg.botUsername)?.cmd ?? null;
  if (cmd === 'start') {
    await tg.sendMessage(cfg.botToken, { chat_id: message.chat.id, text: cfg.startMessage });
    return;
  }
  if (cmd === 'help') {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.relay.help[locale](isAdmin),
    });
    return;
  }
  if (cmd === 'whoami') {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.relay.whoami[locale](String(message.chat.id)),
    });
    return;
  }

  // The dedup mark is deferred to just before the first non-idempotent side
  // effect (admin command / relay), so messages dropped below cost no KV writes.
  if (isAdmin) {
    await markUpdateSeen(skv, updateId, DEDUP_TTL_SEC);
    await handleAdminMessage(cfg, skv, debug, message, locale);
    return;
  }

  const uk = await userKey(senderId, cfg.hashSecret);

  if (await isBlocked(skv, uk)) {
    logEvent(debug, 'guest_blocked', { uk });
    return;
  }

  const allowed = await admitGuestMessage(skv, uk, message);
  if (!allowed) {
    logEvent(debug, 'guest_rate_limited', { uk });
    return;
  }

  await markUpdateSeen(skv, updateId, DEDUP_TTL_SEC);
  await relayToAdmins(cfg, skv, debug, message, uk);
}

// Telegram delivers each item of a media group as its own update, so a legal
// 2–10-item album would eat the whole 5/60s budget (and every item would rewrite
// the same rate key within a second — a KV 429). Instead the album's first item
// buys admission for the group: one rate unit covers all items sharing the
// media_group_id, and a rejected album is rejected whole.
async function admitGuestMessage(
  skv: ScopedKV,
  uk: string,
  message: TgMessage,
): Promise<boolean> {
  const albumId = message.media_group_id;
  if (!albumId) return checkRateLimit(skv, uk, RATE_LIMIT_WINDOW_SEC, RATE_LIMIT_MAX);
  const albumKey = `album-${uk}-${albumId}`;
  if (await skv.getString(albumKey)) return true;
  const allowed = await checkRateLimit(skv, uk, RATE_LIMIT_WINDOW_SEC, RATE_LIMIT_MAX);
  if (allowed) {
    // Best-effort (concurrent first items may race): a lost marker only means one
    // extra rate unit for the same album.
    await tryPut(skv, albumKey, '1', MEDIA_GROUP_TAG_TTL_SEC, 'album_put');
  }
  return allowed;
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
        await tryPutMsgMap(skv, adminId, fwd.message_id, entry);
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
          await tryPutMsgMap(skv, adminId, tagMsg.message_id, entry);
        }
        const copied = await tg.copyMessage(cfg.botToken, {
          chat_id: adminId,
          from_chat_id: message.chat.id,
          message_id: message.message_id,
        });
        await tryPutMsgMap(skv, adminId, copied.message_id, entry);
      }
      logEvent(debug, 'forwarded', { uk, admin: adminId });
    } catch (e) {
      if (e instanceof TelegramError) {
        // botId, not adminId: an admin's UID is a chatId, which must never reach an
        // always-on log (privacy invariant). Per-admin detail stays in the debug-gated
        // 'forwarded' event above.
        logError('forward', e, { botId: cfg.botId });
        continue;
      }
      throw e;
    }
  }
}

// Losing a mapping only degrades reply-routing for this one message — the admin
// already received it — so a KV write throttle here must not abort delivery.
async function tryPutMsgMap(
  skv: ScopedKV,
  adminId: string,
  adminMessageId: number,
  entry: MsgMapEntry,
): Promise<void> {
  try {
    await putMsgMap(skv, adminId, adminMessageId, entry, MSG_MAP_TTL_SEC);
  } catch (e) {
    logError('msg_map_put', e);
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
  await tryPut(skv, key, '1', MEDIA_GROUP_TAG_TTL_SEC, 'mg_tag_put');
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
