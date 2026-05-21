import * as tg from './telegram';
import { TelegramError } from './telegram';
import { getMsgMap, type ScopedKV } from './storage';
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
  await handleAdminReply(cfg, skv, debug, message, locale);
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
  const entry = await getMsgMap(skv, reply.message_id);

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
