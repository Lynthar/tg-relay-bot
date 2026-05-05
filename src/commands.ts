import * as tg from './telegram';
import { TelegramError } from './telegram';
import { getMsgMap, type ScopedKV } from './storage';
import { setBlocked, clearBlocked, isBlocked, logError, logEvent } from './security';
import type { TgMessage } from './types';
import type { TenantCfg } from './tenant';

export async function handleAdminMessage(
  cfg: TenantCfg,
  skv: ScopedKV,
  debug: boolean,
  message: TgMessage,
): Promise<void> {
  const text = message.text ?? '';
  if (text === '/status') {
    await handleStatus(cfg, skv, message);
    return;
  }
  await handleAdminReply(cfg, skv, debug, message);
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
): Promise<void> {
  const reply = message.reply_to_message;
  if (!reply) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: '请先回复一条转发的消息再发送内容；或对转发的消息使用 /block /unblock /checkblock。命令清单见 /help。',
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
        text: '该转发消息已超出有效期或不存在映射，无法执行该操作。',
      });
      return;
    }
    const cmd = cmdMatch[1];
    if (cmd === 'block') {
      await setBlocked(skv, entry.userKey);
      logEvent(debug, 'block_set', { uk: entry.userKey });
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: `已屏蔽 ${entry.userKey}`,
      });
    } else if (cmd === 'unblock') {
      await clearBlocked(skv, entry.userKey);
      logEvent(debug, 'block_clear', { uk: entry.userKey });
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: `已解除屏蔽 ${entry.userKey}`,
      });
    } else {
      const blocked = await isBlocked(skv, entry.userKey);
      await tg.sendMessage(cfg.botToken, {
        chat_id: message.chat.id,
        text: `${entry.userKey} ${blocked ? '已屏蔽' : '未屏蔽'}`,
      });
    }
    return;
  }

  if (!entry) {
    await tg.sendMessage(cfg.botToken, {
      chat_id: message.chat.id,
      text: '该转发消息已超出有效期或不存在映射，无法回复。',
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
        text: `回复发送失败：${e.detail}`,
      });
      return;
    }
    throw e;
  }
}
