import type { TgMessage, TgUser } from './types';

export type Locale = 'zh' | 'en';

export function pickLocale(code?: string): Locale {
  if (!code) return 'zh';
  return code.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function localeFromUser(u?: TgUser): Locale {
  return pickLocale(u?.language_code);
}

export function localeFromMessage(m: TgMessage): Locale {
  return pickLocale(m.from?.language_code);
}

type Bilingual<A extends readonly unknown[]> = Record<Locale, (...args: A) => string>;

function bil<A extends readonly unknown[]>(
  zh: (...args: A) => string,
  en: (...args: A) => string,
): Bilingual<A> {
  return { zh, en };
}

export const T = {
  manager: {
    welcome: bil(
      () => '欢迎使用 Relay-Bot 管家。\n/setup 接入新 bot；/help 查看完整命令清单。',
      () =>
        'Welcome to Relay-Bot Manager.\n/setup to onboard a new bot; /help for the full command list.',
    ),
    onboardingCancelled: bil(
      () => '已取消接入流程。',
      () => 'Onboarding cancelled.',
    ),
    whoami: bil(
      (id: string) => `Your chat id: ${id}`,
      (id: string) => `Your chat id: ${id}`,
    ),
    stateReset: bil(
      () => '已重置会话状态。',
      () => 'Session state reset.',
    ),
    setupPrompt: bil(
      () => '请粘贴你从 BotFather 拿到的 bot token（形如 12345:ABC...）。\n/cancel 中止。',
      () =>
        'Paste the bot token you got from BotFather (looks like 12345:ABC...).\n/cancel to abort.',
    ),
    setupNotInvited: bil(
      () =>
        '/setup 需要 host 邀请后才能使用。\n发送 /whoami 获取你的 UID，把它告诉 host，请对方执行 /invite 后再试。',
      () =>
        '/setup requires an invitation from the host.\nSend /whoami to get your UID, share it with the host, and try again after they run /invite.',
    ),
    tenantLimitReached: bil(
      (max: number) =>
        `你最多可以 onboard ${max} 个 bot，已达上限。如需更多，请先 /delete 一个或联系 host。`,
      (max: number) =>
        `You can onboard at most ${max} bots and you've reached the limit. /delete one first, or contact the host.`,
    ),
    inviteUsage: bil(
      () => '用法：/invite <uid>（对方可发 /whoami 查看自己的 UID）',
      () => 'Usage: /invite <uid> (they can send /whoami to find their UID)',
    ),
    uninviteUsage: bil(
      () => '用法：/uninvite <uid>',
      () => 'Usage: /uninvite <uid>',
    ),
    invited: bil(
      (uid: string) => `已邀请 ${uid}，对方现在可以使用 /setup。`,
      (uid: string) => `Invited ${uid}. They can now use /setup.`,
    ),
    alreadyInvited: bil(
      (uid: string) => `${uid} 已在邀请列表中。`,
      (uid: string) => `${uid} is already on the invite list.`,
    ),
    uninvited: bil(
      (uid: string) =>
        `已取消 ${uid} 的邀请（其已 onboard 的 bot 不受影响，需要的话用 /host_purge 处理）。`,
      (uid: string) =>
        `Uninvited ${uid} (their existing bots are unaffected; use /host_purge if needed).`,
    ),
    notInInviteList: bil(
      (uid: string) => `${uid} 不在邀请列表中。`,
      (uid: string) => `${uid} is not on the invite list.`,
    ),
    invitesEmpty: bil(
      () => '邀请列表为空。/invite <uid> 添加。',
      () => 'Invite list is empty. /invite <uid> to add.',
    ),
    invitesHeader: bil(
      (count: number) => `已邀请的用户 (${count})：`,
      (count: number) => `Invited users (${count}):`,
    ),
    unknownNoName: bil(
      () => '未知命令。/help 查看可用命令。',
      () => 'Unknown command. /help to see available commands.',
    ),
    hostOnly: bil(
      () => '仅 host 可用。',
      () => 'Host-only command.',
    ),
    unknownCmd: bil(
      (cmd: string) => `未知命令 /${cmd}。/help 查看可用命令。`,
      (cmd: string) => `Unknown command /${cmd}. /help to see available commands.`,
    ),
    helpText: bil(
      (isHost: boolean) => {
        const lines = [
          '管家 bot 命令：',
          '',
          '/setup - 接入一个新 bot（粘贴 BotFather 给的 token；需 host 邀请）',
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
          lines.push(
            '',
            'Host 命令：',
            '/invite <uid> - 邀请用户使用 /setup',
            '/uninvite <uid> - 取消邀请',
            '/invites - 查看邀请列表',
            '/host_list - 列出所有租户',
            '/host_disable <bot_username> - 强制暂停任意 tenant',
            '/host_purge <bot_username> --yes - 强制删除任意 tenant',
            '/host_migrate - 迁移旧租户（加密 secrets + 刷新 webhook），可重复运行',
          );
        }
        return lines.join('\n');
      },
      (isHost: boolean) => {
        const lines = [
          'Manager bot commands:',
          '',
          '/setup - onboard a new bot (paste the BotFather token; requires a host invite)',
          '/list - list all bots you own',
          '/info <bot_username> - details of a specific bot',
          '/displaymode <bot_username> <native|tag|hex> - switch display mode',
          '/admins <bot_username> [add|remove <uid> | list] - manage admins',
          '/start_message <bot_username> <text> - customize the /start message (multi-line supported)',
          '/pause <bot_username> - pause (unregister webhook)',
          '/resume <bot_username> - resume (re-register webhook)',
          '/delete <bot_username> - delete a bot (add --yes to actually execute)',
          '/whoami - show your Telegram UID',
          '/cancel - reset the current session state',
        ];
        if (isHost) {
          lines.push(
            '',
            'Host commands:',
            '/invite <uid> - allow a user to /setup',
            '/uninvite <uid> - revoke an invite',
            '/invites - list invited users',
            '/host_list - list all tenants',
            '/host_disable <bot_username> - force-pause any tenant',
            '/host_purge <bot_username> --yes - force-delete any tenant',
            '/host_migrate - upgrade legacy tenants (encrypt secrets + refresh webhooks), idempotent',
          );
        }
        return lines.join('\n');
      },
    ),
    tokenInvalid: bil(
      () => '看起来不是有效的 token。请重新粘贴，或 /cancel 中止。',
      () => "That doesn't look like a valid token. Paste again, or /cancel to abort.",
    ),
    cannotOnboardSelf: bil(
      () => '不能用管家 bot 自己的 token 来 onboard。请改用其他 BotFather 创建的 bot 的 token。',
      () =>
        "You can't onboard the manager bot's own token. Use a different bot's token from BotFather.",
    ),
    botAlreadyOnboarded: bil(
      (username: string, ownerUid: string) =>
        `这个 bot (@${username}) 已被 onboard，所有者 ${ownerUid}。如要重置，所有者须先 /delete ${username} --yes`,
      (username: string, ownerUid: string) =>
        `This bot (@${username}) is already onboarded, owned by ${ownerUid}. To reset, the owner must first /delete ${username} --yes`,
    ),
    getMeFailed: bil(
      (detail: string) =>
        'Telegram API 验证失败：' + detail + '\n请确认 token 正确，或 /setup 重试。',
      (detail: string) =>
        'Telegram API validation failed: ' + detail + '\nCheck the token, or /setup again.',
    ),
    setupWebhookFailed: bil(
      (detail: string) =>
        'setWebhook 失败：' + detail + '\n租户记录已回滚。请检查网络后 /setup 重试。',
      (detail: string) =>
        'setWebhook failed: ' +
        detail +
        '\nTenant record rolled back. Check the network and /setup again.',
    ),
    onboardSuccess: bil(
      (username: string, senderId: string, reachable: boolean) =>
        [
          `✅ @${username} 已上线！`,
          '',
          reachable
            ? `✅ 已通过 @${username} 给你发了一条确认消息——访客来信都会出现在那个对话里。`
            : `⚠️ 重要：@${username} 目前无法给你发消息。请打开 @${username} 点 Start（或解除对它的屏蔽），否则你将收不到任何访客消息！`,
          '',
          '默认配置：',
          `· 管理员：${senderId}（即你）`,
          '· 显示模式：native（Telegram 原生 forward UI）',
          '· 限速：60s 内每访客 5 条',
          '',
          '常用命令（带上 bot 用户名）：',
          `/info ${username}`,
          `/displaymode ${username} tag`,
          `/pause ${username}`,
          '',
          '⚠️ 你刚才发的 token 还在我们的对话里。建议长按那条消息选 "Delete for me and bot" 把它从两端清除。',
        ].join('\n'),
      (username: string, senderId: string, reachable: boolean) =>
        [
          `✅ @${username} is now online!`,
          '',
          reachable
            ? `✅ A confirmation message was sent to you via @${username} — guest messages will appear in that chat.`
            : `⚠️ Important: @${username} cannot message you yet. Open @${username} and press Start (or unblock it), or you will receive no guest messages!`,
          '',
          'Defaults:',
          `· Admin: ${senderId} (you)`,
          "· Display mode: native (Telegram's native forward UI)",
          '· Rate limit: 5 messages per guest per 60s',
          '',
          'Common commands (include the bot username):',
          `/info ${username}`,
          `/displaymode ${username} tag`,
          `/pause ${username}`,
          '',
          '⚠️ The token you just sent is still in this chat. Long-press that message and choose "Delete for me and bot" to remove it from both sides.',
        ].join('\n'),
    ),
    tenantProbeOwner: bil(
      () => '✅ 接入完成。访客给这个 bot 发的消息都会转发到这里，直接 reply 即可回复。',
      () =>
        '✅ Onboarding complete. Guest messages to this bot will be forwarded here; just reply to answer.',
    ),
    tenantProbeAdmin: bil(
      (username: string) => `你已被添加为 @${username} 的管理员，访客消息将转发到这里。`,
      (username: string) =>
        `You have been added as an admin of @${username}; guest messages will be forwarded here.`,
    ),
    listEmpty: bil(
      () => '你还没有 onboard 任何 bot。/setup 开始。',
      () => "You haven't onboarded any bot yet. /setup to begin.",
    ),
    listHeader: bil(
      () => '你拥有的 bot：',
      () => 'Bots you own:',
    ),
    needBotUsername: bil(
      () => '请提供 bot 用户名，例如 /info your_bot 或 /info @your_bot',
      () => 'Please provide a bot username, e.g. /info your_bot or /info @your_bot',
    ),
    botNotFound: bil(
      (username: string) => `未找到 ${username}（注意是否你拥有的 bot）。`,
      (username: string) => `${username} not found (check whether you own this bot).`,
    ),
    displaymodeUsage: bil(
      () => '用法：/displaymode <bot_username> <native|tag|hex>',
      () => 'Usage: /displaymode <bot_username> <native|tag|hex>',
    ),
    displaymodeInvalid: bil(
      () => '模式必须是 native / tag / hex 之一。',
      () => 'Mode must be one of: native / tag / hex.',
    ),
    displaymodeSet: bil(
      (username: string, mode: string) => `@${username} 的显示模式已设为 ${mode}。`,
      (username: string, mode: string) => `@${username} display mode set to ${mode}.`,
    ),
    paused: bil(
      (username: string) => `@${username} 已暂停（webhook 已注销）。`,
      (username: string) => `@${username} paused (webhook unregistered).`,
    ),
    webhookFailed: bil(
      (detail: string) => 'setWebhook 失败：' + detail,
      (detail: string) => 'setWebhook failed: ' + detail,
    ),
    resumed: bil(
      (username: string) => `@${username} 已恢复（webhook 已重注册）。`,
      (username: string) => `@${username} resumed (webhook re-registered).`,
    ),
    deleteUsage: bil(
      () => '用法：/delete <bot_username> --yes',
      () => 'Usage: /delete <bot_username> --yes',
    ),
    deleteConfirm: bil(
      (username: string) =>
        `确认删除 @${username} 吗？将注销 webhook 并清除全部相关 KV 数据，不可撤销。\n如确认：/delete ${username} --yes`,
      (username: string) =>
        `Confirm deletion of @${username}? Will unregister the webhook and purge all related KV data; irreversible.\nTo confirm: /delete ${username} --yes`,
    ),
    deleted: bil(
      (username: string, purged: number) => `@${username} 已删除（清除了 ${purged} 个 KV 键）。`,
      (username: string, purged: number) => `@${username} deleted (purged ${purged} KV keys).`,
    ),
    hostListEmpty: bil(
      () => '当前无 tenant。',
      () => 'No tenants currently.',
    ),
    hostListHeader: bil(
      (count: number) => `所有 tenant (${count})：`,
      (count: number) => `All tenants (${count}):`,
    ),
    adminsUsage: bil(
      () => '用法：/admins <bot_username> [add|remove <uid> | list]',
      () => 'Usage: /admins <bot_username> [add|remove <uid> | list]',
    ),
    adminsListHeader: bil(
      (username: string) => `@${username} admins:`,
      (username: string) => `@${username} admins:`,
    ),
    adminsActionInvalid: bil(
      () => '动作必须是 add / remove / list 之一。',
      () => 'Action must be one of: add / remove / list.',
    ),
    adminsUsageWithAction: bil(
      (action: string) => `用法：/admins <bot_username> ${action} <uid>`,
      (action: string) => `Usage: /admins <bot_username> ${action} <uid>`,
    ),
    uidMustBeNumeric: bil(
      () => 'UID 必须是纯数字（Telegram 用户 ID）。',
      () => 'UID must be numeric (a Telegram user ID).',
    ),
    adminAlready: bil(
      (uid: string, username: string) => `${uid} 已经是 @${username} 的管理员。`,
      (uid: string, username: string) => `${uid} is already an admin of @${username}.`,
    ),
    adminAdded: bil(
      (uid: string, count: number, username: string, reachable: boolean) =>
        `已添加管理员 ${uid}。当前 ${count} 人。` +
        (reachable
          ? ''
          : `\n⚠️ 对方还未与 @${username} 对话过——需要先打开该 bot 点 Start 才能收到转发。`),
      (uid: string, count: number, username: string, reachable: boolean) =>
        `Added admin ${uid}. ${count} total now.` +
        (reachable
          ? ''
          : `\n⚠️ They haven't talked to @${username} yet — they must open it and press Start to receive forwards.`),
    ),
    cannotRemoveOwner: bil(
      () => '不能移除 owner。如需转移所有权请 /delete 后由新 owner 重新 onboard。',
      () =>
        'Cannot remove the owner. To transfer ownership, /delete the bot and have the new owner re-onboard.',
    ),
    adminNotInList: bil(
      (uid: string, username: string) => `${uid} 不在 @${username} 的管理员列表中。`,
      (uid: string, username: string) => `${uid} is not in @${username}'s admin list.`,
    ),
    adminRemoved: bil(
      (uid: string, count: number) => `已移除管理员 ${uid}。当前 ${count} 人。`,
      (uid: string, count: number) => `Removed admin ${uid}. ${count} total now.`,
    ),
    startMessageUsage: bil(
      (max: number) => `用法：/start_message <bot_username> <文案>\n（支持多行，最长 ${max} 字符）`,
      (max: number) =>
        `Usage: /start_message <bot_username> <text>\n(multi-line supported, up to ${max} characters)`,
    ),
    startMessageEmpty: bil(
      () => '文案不能为空。',
      () => 'Message text cannot be empty.',
    ),
    startMessageTooLong: bil(
      (len: number, max: number) => `文案过长（${len} > 上限 ${max} 字符）。`,
      (len: number, max: number) => `Message too long (${len} > limit ${max} characters).`,
    ),
    startMessageUpdated: bil(
      (username: string, len: number) => `@${username} 的 /start 文案已更新（${len} 字符）。`,
      (username: string, len: number) => `@${username} /start message updated (${len} characters).`,
    ),
    hostDisabled: bil(
      (username: string, ownerUid: string) => `@${username} 已被 host 暂停（owner ${ownerUid}）。`,
      (username: string, ownerUid: string) => `@${username} disabled by host (owner ${ownerUid}).`,
    ),
    hostPurgeUsage: bil(
      () => '用法：/host_purge <bot_username> --yes',
      () => 'Usage: /host_purge <bot_username> --yes',
    ),
    hostPurgeConfirm: bil(
      (username: string, ownerUid: string) =>
        `确认强制删除 @${username}（owner ${ownerUid}）？将注销 webhook 并清除全部数据，不可撤销。\n如确认：/host_purge ${username} --yes`,
      (username: string, ownerUid: string) =>
        `Confirm force-delete @${username} (owner ${ownerUid})? Will unregister the webhook and purge all data; irreversible.\nTo confirm: /host_purge ${username} --yes`,
    ),
    hostMigrated: bil(
      (total: number, migrated: number, webhooks: number, failures: number) =>
        `共 ${total} 个租户：${migrated} 个完成 secrets 加密迁移，${webhooks} 个 webhook 已刷新（allowed_updates 生效）${failures > 0 ? `，${failures} 个刷新失败（token 可能已失效，/host_list 检查）` : ''}。此命令可重复运行。`,
      (total: number, migrated: number, webhooks: number, failures: number) =>
        `${total} tenants: ${migrated} had secrets encrypted, ${webhooks} webhooks refreshed (allowed_updates applied)${failures > 0 ? `, ${failures} refresh failures (token may be revoked, check /host_list)` : ''}. Safe to run again.`,
    ),
    hostPurged: bil(
      (username: string, purged: number, ownerUid: string) =>
        `@${username} 已被 host 删除（清除 ${purged} 个 KV 键，原 owner ${ownerUid}）。`,
      (username: string, purged: number, ownerUid: string) =>
        `@${username} purged by host (purged ${purged} KV keys, prior owner ${ownerUid}).`,
    ),
  },
  relay: {
    whoami: bil(
      (id: string) => `Your chat id: ${id}`,
      (id: string) => `Your chat id: ${id}`,
    ),
    help: bil(
      (isAdmin: boolean) => {
        if (isAdmin) {
          return [
            '管理员命令：',
            '/start /help /whoami - 通用',
            '/status - 查看 bot 运行状态',
            '/blocklist - 查看被屏蔽的访客',
            '/unblock <userKey> - 按 userKey 解除屏蔽（无需 reply）',
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
      },
      (isAdmin: boolean) => {
        if (isAdmin) {
          return [
            'Admin commands:',
            '/start /help /whoami - common',
            '/status - bot runtime status',
            '/blocklist - list blocked guests',
            '/unblock <userKey> - unblock by userKey (no reply needed)',
            '',
            'Reply to a forwarded message:',
            '  any content → reply to the original sender',
            '  /block /unblock /checkblock → block management',
          ].join('\n');
        }
        return [
          'Available commands:',
          '/start - greeting',
          '/help - show this help',
          '/whoami - show your Telegram UID',
          '',
          'Send any message to contact the bot operator.',
        ].join('\n');
      },
    ),
  },
  commands: {
    needReply: bil(
      () =>
        '请先回复一条转发的消息再发送内容；或对转发的消息使用 /block /unblock /checkblock。/blocklist 查看屏蔽列表；/unblock <userKey> 可免 reply 解除屏蔽。命令清单见 /help。',
      () =>
        'Reply to a forwarded message first, or use /block /unblock /checkblock on a forwarded one. /blocklist shows blocked guests; /unblock <userKey> works without a reply. See /help for the command list.',
    ),
    blocklistEmpty: bil(
      () => '当前没有被屏蔽的访客。',
      () => 'No blocked guests.',
    ),
    blocklistHeader: bil(
      (count: number, complete: boolean) =>
        `已屏蔽 ${count}${complete ? '' : '+'} 个访客（/unblock <userKey> 解除）：`,
      (count: number, complete: boolean) =>
        `Blocked guests: ${count}${complete ? '' : '+'} (/unblock <userKey> to lift):`,
    ),
    unblockUsage: bil(
      () =>
        '用法：/unblock <userKey>（32 位十六进制，可从 /blocklist 或屏蔽确认消息复制）；也可以对一条转发消息 reply /unblock。',
      () =>
        'Usage: /unblock <userKey> (32 hex chars, copy it from /blocklist or the block confirmation); or reply /unblock to a forwarded message.',
    ),
    notBlocked: bil(
      (uk: string) => `${uk} 未被屏蔽。`,
      (uk: string) => `${uk} is not blocked.`,
    ),
    noMappingForCommand: bil(
      () => '该转发消息已超出有效期或不存在映射，无法执行该操作。',
      () =>
        'This forwarded message has expired or has no mapping; cannot execute that command.',
    ),
    blocked: bil(
      (uk: string) => `已屏蔽 ${uk}`,
      (uk: string) => `Blocked ${uk}`,
    ),
    unblocked: bil(
      (uk: string) => `已解除屏蔽 ${uk}`,
      (uk: string) => `Unblocked ${uk}`,
    ),
    checkBlock: bil(
      (uk: string, blocked: boolean) => `${uk} ${blocked ? '已屏蔽' : '未屏蔽'}`,
      (uk: string, blocked: boolean) => `${uk} ${blocked ? 'blocked' : 'not blocked'}`,
    ),
    noMappingForReply: bil(
      () => '该转发消息已超出有效期或不存在映射，无法回复。',
      () => 'This forwarded message has expired or has no mapping; cannot reply.',
    ),
    replyFailed: bil(
      (detail: string) => `回复发送失败：${detail}`,
      (detail: string) => `Reply send failed: ${detail}`,
    ),
  },
};
