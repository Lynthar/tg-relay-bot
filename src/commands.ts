import * as tg from './telegram';
import { TelegramError, parseBotCommand } from './telegram';
import { BLOCK_MAX_DURATION_DAYS, BLOCK_REASON_MAX_CHARS, RECALL_TTL_SEC } from './config';
import {
  deleteRecall,
  getMsgMap,
  getLegacyMsgMap,
  getRecall,
  putRecall,
  type ScopedKV,
} from './storage';
import {
  type BlockEntry,
  setBlocked,
  clearBlocked,
  getBlock,
  isBlocked,
  logError,
  logEvent,
  operatorKey,
} from './security';
import type { TgMessage } from './types';
import type { TenantCfg } from './tenant';
import { type ExposureKind, type Locale, T, blockDetail } from './i18n';

type ReplyAction =
  | { cmd: 'block'; entry: BlockEntry }
  | { cmd: 'unblock' | 'checkblock' | 'recall' };

export async function handleAdminMessage(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
  locale: Locale,
): Promise<void> {
  const text = message.text ?? '';
  const parsed = parseBotCommand(text, cfg.botUsername);
  if (parsed?.cmd === 'status') {
    await handleStatus(cfg, skv, message);
    return;
  }
  if (parsed?.cmd === 'blocklist') {
    await handleBlocklist(cfg, skv, message, locale);
    return;
  }
  // Intercepted before the reply path on purpose: replying to a forward with
  // "/unblock <key>" must act as a command, not get copied to the guest.
  if (parsed?.cmd === 'unblock' && parsed.args) {
    await handleUnblockByKey(cfg, skv, debug, message, parsed.args.split(/\s+/)[0], locale);
    return;
  }
  let action: ReplyAction | null;
  if (parsed?.cmd === 'block') {
    const entry = parseBlockArgs(parsed.args);
    if (!entry) {
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: T.commands.blockUsage[locale](),
      });
      return;
    }
    action = { cmd: 'block', entry };
  } else {
    action = asReplyAction(parsed);
  }
  // Anything else that still looks like a command — a typo ("/bloc"), stray
  // arguments ("/checkblock him"), a foreign @suffix — is refused instead of being
  // copied to the guest, which would leak the admin's moderation intent.
  if (!action && text.startsWith('/')) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.commandNotRelayed[locale](),
    });
    return;
  }
  await handleAdminReply(cfg, skv, debug, message, locale, action);
}

function asReplyAction(parsed: { cmd: string; args: string } | null): ReplyAction | null {
  if (!parsed || parsed.args) return null;
  const { cmd } = parsed;
  return cmd === 'unblock' || cmd === 'checkblock' || cmd === 'recall' ? { cmd } : null;
}

const DURATION_RE = /^(\d+)([mhdw])$/i;
const DURATION_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

// "/block [<n>m|h|d|w] [reason]". A first word that starts with a digit must be a duration:
// a mistyped one ("7 days", "7x") is refused rather than becoming a permanent block whose
// reason is the typo. Returns null when the arguments are unusable.
function parseBlockArgs(args: string): BlockEntry | null {
  const entry: BlockEntry = {};
  let reason = args;
  const first = args.split(/\s/, 1)[0];
  if (/^\d/.test(first)) {
    const m = first.match(DURATION_RE);
    if (!m) return null;
    const ms = Number(m[1]) * DURATION_MS[m[2].toLowerCase()];
    if (ms === 0 || ms > BLOCK_MAX_DURATION_DAYS * DURATION_MS.d) return null;
    entry.until = Date.now() + ms;
    reason = args.slice(first.length).trim();
  }
  if (reason.length > BLOCK_REASON_MAX_CHARS) return null;
  if (reason) entry.reason = reason;
  return entry;
}

// Content an admin might send that identifies them to the guest. Delivered anyway (the
// admin decides), but they get a notice and a /recall handle.
function exposureKind(m: TgMessage): ExposureKind | null {
  if (m.contact) return 'contact';
  if (m.location || m.venue) return 'location';
  if (m.document || m.audio) return 'file';
  return null;
}

const USER_KEY_RE = /^[0-9a-f]{32}$/;

// Escape hatch for guests whose forwarded messages have expired: a blocked guest produces no new
// msg-map entries, so reply-based /unblock stops working after MSG_MAP_TTL. The argument is the
// anonymous userKey, never a raw UID — a UID here would put chatId into logs and command history.
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
  // Read each value for its expiry and reason; a block that lapsed since the listing drops out.
  const lines = (
    await Promise.all(
      uks.map(async (uk) => {
        const entry = await getBlock(skv, uk);
        return entry && `· ${uk}${blockDetail(entry, locale)}`;
      }),
    )
  ).filter((line): line is string => line !== null);
  if (lines.length === 0) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.blocklistEmpty[locale](),
    });
    return;
  }
  let buf = T.commands.blocklistHeader[locale](lines.length, complete);
  for (const line of lines) {
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
  const adminKey = await operatorKey(adminChatId, cfg.hashSecret);
  const entry = await getMsgMap(skv, adminKey, replyMessageId);
  if (entry) return entry;
  // Entries written before admin ids were hashed in keys still carry the raw UID; they age
  // out with MSG_MAP_TTL_SEC after the upgrade, then this lookup can go.
  const rawKeyed = await getMsgMap(skv, adminChatId, replyMessageId);
  if (rawKeyed || cfg.adminUids.size !== 1) return rawKeyed;
  return getLegacyMsgMap(skv, replyMessageId);
}

async function handleAdminReply(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
  locale: Locale,
  action: ReplyAction | null,
): Promise<void> {
  const reply = message.reply_to_message;
  if (!reply) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.needReply[locale](),
    });
    return;
  }

  if (action?.cmd === 'recall') {
    await handleRecall(cfg, skv, message, reply.message_id, locale);
    return;
  }

  const entry = await lookupEntry(cfg, skv, String(message.chat.id), reply.message_id);

  if (action) {
    if (!entry) {
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: T.commands.noMappingForCommand[locale](),
      });
      return;
    }
    // Blocklist access is fail-loud, but the admin only ever sees the reply: a storage
    // failure must reach them as "did not take effect", not as silence.
    let text: string;
    try {
      if (action.cmd === 'block') {
        await setBlocked(skv, entry.userKey, action.entry);
        logEvent(debug, 'block_set', { uk: entry.userKey });
        text = T.commands.blocked[locale](entry.userKey, action.entry);
      } else if (action.cmd === 'unblock') {
        await clearBlocked(skv, entry.userKey);
        logEvent(debug, 'block_clear', { uk: entry.userKey });
        text = T.commands.unblocked[locale](entry.userKey);
      } else {
        text = T.commands.checkBlock[locale](entry.userKey, await getBlock(skv, entry.userKey));
      }
    } catch (e) {
      logError(`admin_${action.cmd}`, e);
      text = T.commands.blockOpFailed[locale]();
    }
    await tg.sendMessage(cfg.botToken, { chat_id: message.chat.id, text });
    return;
  }

  if (!entry) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: T.commands.noMappingForReply[locale](),
    });
    return;
  }

  let copied: { message_id: number };
  try {
    copied = await tg.copyMessage(cfg.botToken, {
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

  const kind = exposureKind(message);
  if (!kind) return;
  const notice = await tg.sendMessage(cfg.botToken, {
    chat_id: message.chat.id,
    text: T.commands.exposureNotice[locale](kind),
    reply_parameters: { message_id: message.message_id },
  });
  // Bookkeeping, fail-open like msg-map: if this write is lost, /recall reports "nothing".
  try {
    await putRecall(
      skv,
      await operatorKey(message.chat.id, cfg.hashSecret),
      notice.message_id,
      { chatId: entry.chatId, messageId: copied.message_id },
      RECALL_TTL_SEC,
    );
  } catch (e) {
    logError('recall_put', e);
  }
}

async function handleRecall(
  cfg: TenantCfg,
  skv: ScopedKV,
  message: TgMessage,
  noticeMessageId: number,
  locale: Locale,
): Promise<void> {
  const adminKey = await operatorKey(message.chat.id, cfg.hashSecret);
  const target = await getRecall(skv, adminKey, noticeMessageId);
  let text: string;
  if (!target) {
    text = T.commands.recallNothing[locale]();
  } else {
    try {
      await tg.deleteMessage(cfg.botToken, {
        chat_id: target.chatId,
        message_id: target.messageId,
      });
      await deleteRecall(skv, adminKey, noticeMessageId);
      text = T.commands.recalled[locale]();
    } catch (e) {
      if (!(e instanceof TelegramError)) throw e;
      logError('admin_recall', e);
      text = T.commands.recallFailed[locale](e.detail);
    }
  }
  await tg.sendMessage(cfg.botToken, { chat_id: message.chat.id, text });
}
