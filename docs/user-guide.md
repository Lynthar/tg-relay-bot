# 使用与部署指南

[← 回到 README](../README.md) · [English](user-guide.en.md)

README 只讲这个项目是什么。这份文档是完整参考：怎么用、怎么部署、怎么运维、出了问题怎么查。

## 目录

- [Friend 视角：怎么使用](#friend-视角怎么使用)
- [Host 视角：怎么部署](#host-视角怎么部署)
- [管家 bot 命令清单](#管家-bot-命令清单)
- [Tenant bot 行为](#tenant-bot-行为)
- [显示模式](#显示模式)
- [运维](#运维)
- [隐私与安全模型](#隐私与安全模型)
- [数据保留](#数据保留)
- [常见问题](#常见问题)
- [开发](#开发)

---

## Friend 视角：怎么使用

完全不需要 Cloudflare 或代码。前提：你的 host 已经把管家 bot 的用户名告诉你（如 `@YourHostRelayManagerBot`）。

### 第一次接入

1. 在 Telegram 找 host 给你的管家 bot，发 `/whoami` 拿到你的 UID，把它告诉 host；host 执行 `/invite <你的UID>` 后你才能进行下一步
2. 去 [@BotFather](https://t.me/BotFather) 发 `/newbot`，按指引取一个名字和用户名，复制返回的 token（形如 `12345:ABC...`）
3. 回到管家 bot 发 `/setup`，再粘贴上一步的 token
4. 看到 `✅ @你的bot 已上线` 就完事
5. **重要**：长按你刚才发 token 的消息 → 选 "Delete for me and bot"，把 token 从聊天历史里清掉

每个用户最多可 onboard 3 个 bot（host 自己不限）。

### 日常使用

- 任何人给 `@你的bot` 发消息 → 你 Telegram 里收到一条**原生 forward 消息**（顶部蓝色 "Forwarded from <访客名字>"，可点开访客 profile）
- 你直接 reply 那条消息 → 对方收到（发信人是 bot，看不到你）
- 你回复的内容也以 copyMessage 形式发出，**不会暴露你的真实身份**

### 屏蔽 / 解屏

在你 onboard 出来的那个 bot 自己的私聊里（**不是管家 bot 里**）：

| 操作 | 效果 |
|---|---|
| reply 一条转发消息发任意文字 | 该文字回复给原发送者 |
| reply 一条转发消息发 `/block` | 屏蔽该访客 |
| reply 一条转发消息发 `/unblock` | 解除屏蔽 |
| reply 一条转发消息发 `/checkblock` | 查询是否屏蔽 |
| 发 `/blocklist` | 列出所有被屏蔽访客的 userKey |
| 发 `/unblock <userKey>` | 按 userKey 解除屏蔽（无需 reply） |
| 发 `/status` | 看该 bot 的运行状态（msg-map 数 / 黑名单数等） |

⚠️ `/block` **必须是回复一条转发消息**才生效——禁止裸输入 UID，避免误伤。解除屏蔽有一个例外：被屏蔽的访客不再产生新转发，老转发 30 天后过期，届时用 `/unblock <userKey>`（参数是匿名哈希，见 `/blocklist`），而不是 UID。

### 管理你拥有的 bot

在管家 bot 里：

| 命令 | 说明 |
|---|---|
| `/list` | 看你拥有的所有 bot |
| `/info <bot_username>` | 看某个 bot 的详细信息 |
| `/displaymode <bot_username> <native\|tag\|hex>` | 切换显示模式（[见下](#显示模式)） |
| `/admins <bot_username> [add\|remove <uid> \| list]` | 管理管理员（owner 不能被移除） |
| `/start_message <bot_username> <文案>` | 改 /start 文案（支持多行；最长 1000 字符） |
| `/pause <bot_username>` | 暂停（注销 webhook；暂停期间的访客消息在 Telegram 侧排队，最多保留 24 小时） |
| `/resume <bot_username>` | 恢复（重新注册 webhook；暂停期间排队的消息会被补发） |
| `/delete <bot_username> --yes` | 删除（注销 webhook + 清所有 KV） |

`/delete` 不带 `--yes` 只会提示确认，加上才真删。

---

---

## Host 视角：怎么部署

### 准备

1. **Cloudflare 账号**：[dash.cloudflare.com](https://dash.cloudflare.com) 注册（免费）
2. **Node.js**：[nodejs.org](https://nodejs.org) LTS 版
3. **管家 bot**：去 [@BotFather](https://t.me/BotFather) `/newbot`，建议名字带 `Manager` 后缀以与 tenant bot 区分，保存 token
4. **你自己的 Telegram UID**：找 [@userinfobot](https://t.me/userinfobot) 发任意消息，记下 `Id:` 后面的数字

### 部署步骤

```bash
# 1. 克隆并装依赖
git clone <this repo>
cd tg-relay-bot
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 KV namespace
npx wrangler kv namespace create nfd
# 把返回的 id 填进 wrangler.toml 里的 id = "..."
# ⚠️ 仓库里现有的 id 是上一任 host 的；不替换的话部署会报
#    "KV namespace not found"（若恰好在同一 Cloudflare 账号下则会误绑旧数据）

# 4. 设置 4 个必填 secret
npx wrangler secret put ENV_MANAGER_BOT_TOKEN   # 上面建的管家 bot token
npx wrangler secret put ENV_HOST_UID            # 你的 Telegram UID
npx wrangler secret put ENV_MASTER_ENC_KEY      # openssl rand -base64 32
npx wrangler secret put ENV_ADMIN_SECRET        # openssl rand -hex 32

# （可选）开 debug 日志
npx wrangler secret put ENV_DEBUG               # 输入 1

# 5. 部署
npx wrangler deploy
# 输出形如：https://tg-relay-bot.<你的子域>.workers.dev

# 6. 注册管家 bot 的 webhook
curl 'https://tg-relay-bot.<你的子域>.workers.dev/admin/registerWebhook?s=<ENV_ADMIN_SECRET>'
# 应返回：manager webhook registered at https://.../wh/<管家botId>

# 7. 在 Telegram 找你的管家 bot 发 /start，应收到欢迎语
```

### 部署故障排查

| 症状 | 可能原因 |
|---|---|
| `wrangler deploy` 报 `KV namespace not found` | `wrangler.toml` 的 id 没换或换错 |
| `/admin/registerWebhook` 返回 `Not found` | `ENV_ADMIN_SECRET` 未设、URL 拼错、或 secret 含特殊字符未 URL-encode |
| `/admin/registerWebhook` 返回 502 with `telegram error` | `ENV_MANAGER_BOT_TOKEN` 错或已被 revoke |
| Manager bot 不响应 `/start` | webhook 未注册（重跑步骤 6）；`npx wrangler tail` 看错误 |
| `/setup` 后 `setWebhook 失败` | Worker URL 不是 HTTPS、DNS 还没传播，或网络抖动；通常等 30s 后重试即可 |
| 部署后 Telegram 重发旧消息洗版 | `update_id` dedup 在 5min TTL 内会去重；过 5 分钟自然停 |

### Secret 的含义与轮换策略

| Secret | 作用 | 何时换 |
|---|---|---|
| `ENV_MANAGER_BOT_TOKEN` | 管家 bot 的身份 | 管家 bot 重置时；换后需重跑步骤 6 |
| `ENV_HOST_UID` | 你（host）的 Telegram UID | 你换 Telegram 账号时 |
| `ENV_MASTER_ENC_KEY` | 加密所有 tenant token 的 AES key | **永远不要换**——换了所有 tenant 全部失效 |
| `ENV_ADMIN_SECRET` | 鉴权 `/admin/*` 端点 | 怀疑泄漏时随时可换 |
| `ENV_DEBUG` | 是否开调试日志 | 默认不设 |

> ⚠️ `ENV_MASTER_ENC_KEY` 是整个系统中最敏感的 secret。它丢失或被改 = 所有租户 token 不可恢复 = 全平台需要每个 tenant 重新 `/setup`。建议把生成出来的值额外做一份离线备份。

### 把你自己也当作 friend

部署完后，host 也要走一遍 friend 流程才能拥有第一个对外 bot：

1. 去 BotFather 单独建一个对外的 relay bot（**不是管家 bot**）
2. 在管家 bot 里 `/setup`，粘贴新 bot 的 token（host 无需邀请自己，也不受数量上限约束）
3. 完事

---

---

## 管家 bot 命令清单

朋友与 host 通用：

| 命令 | 说明 |
|---|---|
| `/start` | 欢迎语 |
| `/help` | 命令清单（host 会多看到 host-only 命令） |
| `/whoami` | 显示你的 Telegram UID |
| `/cancel` | 重置当前会话状态（中止 /setup） |
| `/setup` | 多轮对话：粘 token → 自动验证 → 自动注册 webhook（需 host 先 `/invite`；每人上限 3 个 bot） |
| `/list` | 列出你拥有的所有 bot |
| `/info <bot_username>` | 查看某个 bot 的详情 |
| `/displaymode <bot_username> <native\|tag\|hex>` | 切换显示模式 |
| `/admins <bot_username> [add\|remove <uid> \| list]` | 管理管理员列表；不带动作默认 `list`；不能移除 owner；每 bot 最多 10 名管理员 |
| `/start_message <bot_username> <文案>` | 自定义 /start 文案（支持多行，最长 1000 字符） |
| `/pause <bot_username>` | 暂停 bot（暂停期间的访客消息在 Telegram 侧最多排队 24 小时） |
| `/resume <bot_username>` | 恢复 bot（补发暂停期间排队的消息） |
| `/delete <bot_username> [--yes]` | 删除 bot；不带 `--yes` 仅提示，加上才真删 |

仅 host 可用：

| 命令 | 说明 |
|---|---|
| `/host_migrate` | 从旧版本升级后运行一次：加密存量租户的明文 secrets 并刷新 webhook；可重复运行 |
| `/invite <uid>` | 邀请某用户使用 `/setup`（对方可发 `/whoami` 查 UID） |
| `/uninvite <uid>` | 取消邀请（不影响其已 onboard 的 bot，需要时用 `/host_purge`） |
| `/invites` | 查看邀请列表 |
| `/host_list` | 列出**所有**租户（含其他朋友的） |
| `/host_disable <bot_username>` | 强制暂停任意 tenant（不需要是 owner） |
| `/host_purge <bot_username> --yes` | 强制删除任意 tenant；不带 `--yes` 仅提示 |

---

---

## Tenant bot 行为

每个 onboard 出来的 bot 自己的私聊里支持以下命令。

所有人可用：

| 命令 | 说明 |
|---|---|
| `/start` | 显示欢迎语（默认中英双语；owner 可在管家 bot 里用 `/start_message` 自定义） |
| `/help` | 显示用法 |
| `/whoami` | 显示当前发送者的 UID |

仅管理员可用（owner 以及其通过 `/admins` 添加的人）：

| 操作 | 效果 |
|---|---|
| reply 一条转发消息发任意文字 | 该文字回复给原访客 |
| reply 一条转发消息发 `/block` | 拉黑该访客 |
| reply 一条转发消息发 `/unblock` | 解黑 |
| reply 一条转发消息发 `/checkblock` | 查询是否被屏蔽 |
| 发 `/blocklist` | 列出被屏蔽访客的 userKey |
| 发 `/unblock <userKey>` | 按 userKey 解除屏蔽（应对原转发消息已过期的情况） |
| 发 `/status` | 显示运行状态（msg-map / block / rate-limit windows 计数） |

非 admin 用户发 `/block` 等命令 → 命令不生效（被当作普通消息转发给 admin）。管理员发送的以 `/` 开头但不是上述命令的文本（如拼错的 `/blck`）会被拦截并提示，不会发送给访客。

注意：webhook 只订阅新消息（`message`），访客对已发送消息的**编辑不会同步**给管理员。

---

---

## 显示模式

每个 tenant bot 独立配置；默认 `native`。在管家 bot 里 `/displaymode <bot_username> <mode>` 切换。

| 模式 | 转发样式 | 适合 |
|---|---|---|
| `native` | Telegram 原生 forward UI（顶部 "Forwarded from <访客名字>"，可点访客 profile） | 大多数场景；最直观 |
| `tag` | 富 HTML 标签 (`↘ <name> · @handle · id:xxx`，带 tg://user 可点链接) + copyMessage（不显示 forward 元数据） | 想看到访客身份但不愿 bot 显得在"转发" |
| `hex` | 不可读哈希标签 (`↘ a3f9c1b8...`) + copyMessage | 隐私最大化；admin 也只看到匿名哈希 |

---

---

## 运维

### 看实时日志

```bash
npx wrangler tail
```

默认只在错误时输出。设 `ENV_DEBUG=1` 后可见结构化事件流（不含消息内容）。

### 查看 KV 数据

```bash
# 列所有 key（看大致状态）。注意 --remote：Wrangler v4 默认操作本地模拟数据
npx wrangler kv key list --binding=nfd --remote

# 看某个 tenant 的全部 key
npx wrangler kv key list --binding=nfd --prefix="tenant:<botId>:" --remote
```

### 强制清除某个 tenant（绕过管家 bot）

正常请走 `/delete <bot_username> --yes`。如果管家 bot 不可用（需要 `jq`；两条命令都必须带 `--remote`，否则删的是本地模拟数据）：

```bash
for key in $(npx wrangler kv key list --binding=nfd --prefix="tenant:<botId>:" --remote | jq -r '.[].name'); do
  npx wrangler kv key delete --binding=nfd "$key" --remote
done
```

### 升级到新版本

```bash
git pull
npm install
npx wrangler deploy
```

不需要重新注册 webhook、不需要重新 put secret、不会丢 KV 数据。

从引入 `/host_migrate` 之前的旧版本升级上来时，部署后做两件事（都幂等，可重跑）：

1. 重跑一次 `curl 'https://.../admin/registerWebhook?s=<ENV_ADMIN_SECRET>'`——让管家 bot 的 webhook 应用 `allowed_updates`
2. 在管家 bot 里运行 `/host_migrate`——加密存量租户的明文 secrets，并刷新各租户 webhook

### 完全卸载

```bash
# 1. 在 Telegram 找 BotFather 删掉所有 bot（管家 bot + 你建的 tenant bot）
# 2. 删 Worker
npx wrangler delete
# 3. 删 KV namespace
npx wrangler kv namespace delete --binding=nfd
```

### 重建（撤掉重新部署）

= **完全卸载 + 重新走一遍部署**。如果旧 bot 还想继续用，BotFather 那一步只解绑 webhook、不真删 bot：

```bash
# 1a. 给每个想保留的 bot 解绑 webhook（不删 bot）
curl "https://api.telegram.org/bot<旧 bot token>/deleteWebhook"

# 1b. 不想保留的 bot 才去 BotFather → /mybots → Delete Bot

# 2. 删 Worker 与 KV
npx wrangler delete
npx wrangler kv namespace delete --binding=nfd

# 3. 按上面"部署步骤"从头来一遍
```

注意：

1. **新生成的 `ENV_MASTER_ENC_KEY` 不可能跟旧的一样**——所有旧 tenant 的加密 token 失效，每个朋友都要重新 `/setup`
2. 新 KV namespace id 不同——**记得改 `wrangler.toml`**
3. 如果 Worker 名字不变，URL 通常保持原样（同一 subdomain），朋友们对话的管家 bot 不变、无感

只想换某个 secret 不动 Worker / KV：直接 `npx wrangler secret put <NAME>` 覆盖即可。注意 `ENV_MASTER_ENC_KEY` 换了**所有现有 tenant token 不可解**。

只想暂时下线（不删数据）：在管家 bot 里给每个 tenant `/pause` 即可，`/resume` 恢复。注意暂停期间访客发来的消息会在 Telegram 侧排队（最长 24 小时），`/resume` 后会补发给管理员；超过 24 小时的部分由 Telegram 丢弃。

---

---

## 隐私与安全模型

### 我们能做到的

- 访客 chatId 在 KV 中以 HMAC-SHA256 哈希存储（`userKey`），dump KV 看不到 chatId 明文（唯一例外是回复路由用的 msg-map，保留 30 天后自动过期）
- 所有 tenant 的 token、webhook secret、hashSecret 都以 AES-GCM 加密存储于 KV——单独拿到 KV dump（没有 `ENV_MASTER_ENC_KEY`）无法对 userKey 做离线暴力反推（从旧版本升级的部署需先运行一次 `/host_migrate`）
- webhook 鉴权依赖每租户随机的 `secret_token` header（constant-time 比较，防侧信道），而非路径保密——路径中的 botId 本身是公开信息；secret 缺失或错误一律返回统一的 404，无法用于探测某个 bot 是否托管在此
- Telegram 重发的 webhook 自动去重（`update_id`）
- 每访客 60s 内最多 5 条；超出静默丢弃
- 所有 admin 端点强制 `ENV_ADMIN_SECRET`，无效一律 404
- bot 默认忽略群聊与 `message` 之外的所有更新类型
- 管理命令必须 reply 一条转发消息才生效，禁止裸 UID 操作
- onboard 需要 host 显式 `/invite` 邀请，且每人有 bot 数量上限——陌生人即使找到管家 bot 也无法把 bot 挂到你的部署上

### 我们做不到的

| 谁 | 能看到内容 | 为什么 |
|---|---|---|
| Telegram 公司 | ✅ | Telegram **不是** E2E 加密；bot 协议无法用 Secret Chats |
| Cloudflare | ✅ 技术上可见 | Worker 在他们边缘上运行；TLS 在 CF 终止 |
| Host（部署方） | ✅ | `wrangler tail` 看日志；KV 里有所有租户 token；多租户托管的固有代价 |
| 任何拿到某 bot token 的人 | ✅ | token = 全权；切换 webhook 即可截获所有该 bot 的消息 |
| ISP / 中间网络 | ❌ 仅元数据 | TLS 加密 |
| 其它 Telegram 用户 | ❌ | 私聊为 1-to-1 |

### 信任模型

- **Host 与 Friend 之间需要相互信任**——host 持有所有租户 token 的解密能力
- **不要在不可信的 host 上托管你的 bot**
- 你与 Telegram 公司、Cloudflare 公司的信任，是这个架构的前置假设

---

---

## 数据保留

| 数据 | 保留时长 |
|---|---|
| `tenant:{botId}:cfg`（含加密 token 与 secrets） | 直到 `/delete --yes` |
| `tenant:{botId}:msg-map-{adminUid}-{id}` | 30 天后 TTL 过期 |
| `tenant:{botId}:block-{userKey}` | 直到 `/unblock` |
| `tenant:{botId}:rate-{userKey}` | 60 秒后 TTL 过期 |
| `tenant:{botId}:update-{id}` | 5 分钟后 TTL 过期 |
| `tenant:{botId}:mg-*` / `album-*`（相册标签与限速去重标记） | 60 秒后 TTL 过期 |
| `manager:user-state-{uid}` | 1 小时无活动后 TTL 过期 |
| `manager:dedup-update-{id}` | 5 分钟后 TTL 过期 |
| `manager:allow-{uid}`（邀请列表） | 直到 `/uninvite` |

---

---

## 常见问题

**Q: 如果换了 `ENV_MASTER_ENC_KEY` 会怎样？**
全部 tenant 不可恢复——这个 key 用于加密所有 token，换了等于丢失全部 token。**永远不要换**这个 key。真的发生了（key 丢失/误换）的恢复路径：每个租户先 `/delete <bot> --yes`（或 host `/host_purge`）清掉本地数据——即使 token 已解不开，本地清理仍会执行，只是无法替租户注销旧 webhook——然后重新 `/setup`，新的 setWebhook 会直接覆盖旧 webhook。

**Q: 为什么 webhook 路径有时候返回 404？**
可能 3 种：(a) URL 不对；(b) `X-Telegram-Bot-Api-Secret-Token` header 缺失或不对；(c) tenant 已删除。已 `/pause` 的 tenant 不返回 404——它返回 200 并丢弃该条消息（正常情况下 pause 已注销 webhook，Telegram 根本不会再投递）。

**Q: 管家 bot 不响应怎么办？**
检查 `npx wrangler tail` 日志；用 `/admin/registerWebhook?s=...` 重新注册；确认 `ENV_MANAGER_BOT_TOKEN` 正确。

**Q: 朋友的 tenant bot 收不到消息？**
在管家 bot 里 `/info <他的bot>` 看 `status`；如果 paused 就 `/resume`；或让朋友重新 `/setup`。

**Q: 朋友能看到我的 bot 数据吗？**
其他朋友不能——每个 tenant 在 KV 内完全隔离（`tenant:{botId}:` 前缀），普通用户的 `/info /pause` 等命令只作用于自己拥有的 bot。但 **host 是超级管理员**：除 `/host_*` 命令外，host 的普通管理命令也能作用于任意 tenant（毕竟 host 持有 master key 与 Cloudflare 账号，这不是额外的信任让步）。消息内容任何人都看不到——它不持久化保存。

**Q: Cloudflare 免费档够用吗？**
小规模够。Workers 免费 10 万请求/天；KV 免费 **1000 写入/天（全平台共享，00:00 UTC 重置）**。每条送达的访客消息约 3 次 KV 写入（被拉黑/超限/垃圾消息不消耗写入）。注意：**超出免费额度后当日的 KV 写入会直接失败**，表现为消息静默丢失，而不是"略微超支"。10 个朋友 × 每天 50 条 ≈ 1500 写已明显超出——这种量级请开 Workers Paid（$5/月，1M 写/月）。

**Q: 怎么本地开发？**
创建 `.dev.vars`（已 gitignore）镜像 4 个必填 secret，然后 `npx wrangler dev`。

**Q: 为什么访客在 60s 内连发多条只看到前 5 条到达？**
限速保护：每访客每 60s 最多 5 条。超出的会被静默丢弃，访客不会收到任何提示（避免给攻击者反馈）。相册（media group）整组只计 1 条额度，2-10 张的相册会完整送达。

---

---

## 开发

```bash
npm install           # 装依赖
npm run typecheck     # tsc 类型检查
npm test              # 跑测试套件（vitest + @cloudflare/vitest-pool-workers，本地全离线）
npm run test:watch    # 测试 watch 模式
npm run dev           # 本地起 wrangler dev
npm run deploy        # 部署到 Cloudflare
```

测试位于 `tests/unit/`（纯函数）和 `tests/integration/`（webhook、tenant 隔离、manager 命令）。

---
