import * as tg from './telegram';
import { TelegramError } from './telegram';
import { getMsgMap, getLegacyMsgMap, type ScopedKV } from './storage';
import { setBlocked, clearBlocked, isBlocked, logError, logEvent } from './security';
import type { TgMessage } from './types';
import type { TenantCfg } from './tenant';
import { type Locale, T } from './i18n';

export async function handleAdminMessage(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
  locale: Locale,
): Promise<void> {
  const text = message.text ?? '';
  if (text === '/status') {
    await handleStatus(cfg, skv, message);
    return;
  }
  if (text === '/blocklist') {
    await handleBlocklist(cfg, skv, message, locale);
    return;
  }
  // Intercepted before the reply path on purpose: replying to a forward with
  // "/unblock <key>" must act as a command, not get copied to the guest.
  const unblockArg = text.match(/^\/unblock\s+(\S+)$/);
  if (unblockArg) {
    await handleUnblockByKey(cfg, skv, debug, message, unblockArg[1], locale);
    return;
  }
  await handleAdminReply(cfg, skv, debug, message, locale);
}

const USER_KEY_RE = /^[0-9a-f]{32}$/;

// Escape hatch for guests whose forwarded messages have expired: a blocked guest
// produces no new msg-map entries, so reply-based /unblock stops working after
// MSG_MAP_TTL. The argument is the anonymous userKey (shown by /blocklist and in
// the /block confirmation), never a raw UID.
async function handleUnblockByKey(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
  arg: string,
  locale: Locale,
): Promise<void> {
  const uk = arg.toLowerCase();
  if (!USER_KEY_RE.test(uk)) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.unblockUsage[locale](),
    });
    return;
  }
  if (!(await isBlocked(skv, uk))) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.notBlocked[locale](uk),
    });
    return;
  }
  await clearBlocked(skv, uk);
  logEvent(debug, 'block_clear', { uk });
  await tg.sendMessage(cfg.botToken, {
    chat_id: message.chat.id,
    text: T.commands.unblocked[locale](uk),
  });
}

const BLOCKLIST_CHUNK_MAX = 3500;

async function handleBlocklist(
  cfg: TenantCfg,
  skv: ScopedKV,
  message: TgMessage,
  locale: Locale,
): Promise<void> {
  const { names, complete } = await skv.listScoped('block-');
  const uks = names.map((n) => n.slice('block-'.length));
  if (uks.length === 0) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.blocklistEmpty[locale](),
    });
    return;
  }
  let buf = T.commands.blocklistHeader[locale](uks.length, complete);
  for (const uk of uks) {
    const line = `· ${uk}`;
    const candidate = `${buf}\n${line}`;
    if (candidate.length > BLOCKLIST_CHUNK_MAX) {
      await tg.sendMessage(cfg.botToken, { chat_id: message.chat.id, text: buf });
      buf = line;
    } else {
      buf = candidate;
    }
  }
  await tg.sendMessage(cfg.botToken, { chat_id: message.chat.id, text: buf });
}

async function handleStatus(cfg: TenantCfg, skv: ScopedKV, message: TgMessage): Promise<void> {
  const [maps, blocks, rates] = await Promise.all([
    skv.list('msg-map-'),
    skv.list('block-'),
    skv.list('rate-'),
  ]);
  const text = [
    `bot: @${cfg.botUsername}`,
    `display_mode: ${cfg.displayMode}`,
    `admins: ${cfg.adminUids.size}`,
    `msg-map: ${maps.keys.length}${maps.list_complete ? '' : '+'}`,
    `blocked: ${blocks.keys.length}${blocks.list_complete ? '' : '+'}`,
    `rate-limit windows: ${rates.keys.length}${rates.list_complete ? '' : '+'}`,
  ].join('\n');
  await tg.sendMessage(cfg.botToken, { chat_id: message.chat.id, text });
}

// Legacy fallback: entries written before msg-map keys gained the admin dimension are only
// unambiguous when the tenant has a single admin (one chat cannot collide with itself).
// For multi-admin tenants a legacy hit may belong to another admin's chat — treat as missing.
async function lookupEntry(
  cfg: TenantCfg,
  skv: ScopedKV,
  adminChatId: string,
  replyMessageId: number,
) {
  const entry = await getMsgMap(skv, adminChatId, replyMessageId);
  if (entry || cfg.adminUids.size !== 1) return entry;
  return getLegacyMsgMap(skv, replyMessageId);
}

async function handleAdminReply(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
  locale: Locale,
): Promise<void> {
  const reply = message.reply_to_message;
  if (!reply) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.needReply[locale](),
    });
    return;
  }

  const text = message.text ?? '';
  const cmdMatch = text.match(/^\/(block|unblock|checkblock)$/);
  const entry = await lookupEntry(cfg, skv, String(message.chat.id), reply.message_id);

  if (cmdMatch) {
    if (!entry) {
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: T.commands.noMappingForCommand[locale](),
      });
      return;
    }
    const cmd = cmdMatch[1];
    if (cmd === 'block') {
      await setBlocked(skv, entry.userKey);
      logEvent(debug, 'block_set', { uk: entry.userKey });
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: T.commands.blocked[locale](entry.userKey),
      });
    } else if (cmd === 'unblock') {
      await clearBlocked(skv, entry.userKey);
      logEvent(debug, 'block_clear', { uk: entry.userKey });
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: T.commands.unblocked[locale](entry.userKey),
      });
    } else {
      const blocked = await isBlocked(skv, entry.userKey);
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: T.commands.checkBlock[locale](entry.userKey, blocked),
      });
    }
    return;
  }

  if (!entry) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.noMappingForReply[locale](),
    });
    return;
  }

  try {
    await tg.copyMessage(cfg.botToken, {
      chat_id: entry.chatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
    });
  } catch (e) {
    if (e instanceof TelegramError) {
      logError('admin_reply_copy', e);
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: T.commands.replyFailed[locale](e.detail),
      });
      return;
    }
    throw e;
  }
}
