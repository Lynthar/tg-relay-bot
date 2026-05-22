# Relay Bot

**中文** | [English](README.en.md)

一个用 Docker 部署的 Telegram **双向消息中继 bot 平台**。一份部署可以同时托管你自己 + 朋友们的多个 bot；朋友通过 Telegram 自助 onboard，全程不需要碰服务器或代码。

> Fork 自 [LloydAsp/nfd](https://github.com/LloydAsp/nfd)，重写为多租户架构，从 Cloudflare Worker 迁移到 Node.js + SQLite 容器化部署，强化隐私与安全模型。

---

## 目录

- [它是什么](#它是什么)
- [核心特性](#核心特性)
- [适用与不适用场景](#适用与不适用场景)
- [三类角色](#三类角色)
- [架构概览](#架构概览)
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
- [致谢](#致谢)
- [License](#license)

---

## 它是什么

一句话：让任何人能给你的 bot 发消息找到你，但 **对方不知道你是谁，也找不到你的真实账号**。

详细：

- 别人给你的 bot 发消息 → 你（运营者）在自己的 Telegram 里收到
- 你直接 reply 那条消息 → 对方收到你的回复，发信人显示为 bot
- 对方完全感知不到你这个真实账号

**多租户**意味着：你（部署方）一次部署，可以同时为自己和你信任的朋友托管多个独立的 bot，每个 bot 数据完全隔离。

## 核心特性

- **轻量** — 单容器 + 一个 SQLite 文件，零外部服务依赖
- **多租户** — 一次部署托管所有 bot；朋友在 Telegram 内自助 onboard
- **token 加密** — 所有 tenant 的 bot token 以 AES-GCM 加密存储在 SQLite 中
- **访客匿名化** — 访客 chatId 在数据库里以 HMAC-SHA256 哈希形式存储；dump 数据库也无法还原"是谁联系过谁"
- **安全收紧** — webhook 路径不可猜、强制 secret_token 校验、constant-time 比较、`update_id` 去重、限速、admin 命令必须 reply 转发消息
- **资源占用低** — 一台 1 vCPU / 512 MB RAM 的 VPS 跑十几个 tenant bot 完全够用

## 适用与不适用场景

| ✅ 适用 | ❌ 不适用 |
|---|---|
| 公开一个 bot 接受陌生人留言但不暴露自己 ID | 真正的端到端加密通讯（Telegram 本身做不到） |
| 个人客服 / 私聊咨询入口 | 大规模商业客服（用 Crisp / Chatwoot / Intercom） |
| 小团队共享一个对外联系点 | 工单 / 自动分配 / 人工坐席切换 |
| 帮朋友们也托管同样的服务 | 不可信场景下的代托管（host 持有 token 解密能力） |

## 三类角色

| 角色 | 是谁 | 需要什么 |
|---|---|---|
| **Host** | 部署本仓库的人 | 一台带 Docker 的服务器 + 一个公网 HTTPS 域名（反代到容器即可） |
| **Friend** | 想拥有自己 bot 的人，由 host 邀请 | 仅需 Telegram |
| **Guest** | 给某个 bot 发消息的任何人 | 仅需 Telegram |

## 架构概览

```
                   ┌─────────────────┐    ┌──────────────────────────────┐
                   │  反代            │    │  Docker 容器 (Node + Hono)   │
 Friend ──tg ─→ ───┤  TLS 终止        ├─→──┤  /wh/{managerBotId}          │── SQLite (/data/db.sqlite)
                   │  (Caddy/Nginx/   │    │    ↓ /setup 多轮对话         │      manager:* + tenant:{botId}:*
 Guest  ──tg ─→ ───┤   Traefik...)    ├─→──┤  /wh/{tenantBotId}           │
                   │                  │    │    ↓ relay 转发              │
 Friend ←─tg ──── ─┤                  │←─── ─    ↓ forwardMessage         │
                   └─────────────────┘    │  /healthz, /admin/*          │
                                          └──────────────────────────────┘
```

- **管家 bot**（host 一次性建好）：朋友通过它 onboard 与管理自己的 bot
- **Tenant bot**（朋友各自的）：实际承担"双向消息中继"工作
- 二者共用同一个容器进程，URL 路径区分
- **反代必须做 TLS 终止** —— Telegram webhook 强制 HTTPS，但容器自身只监听 HTTP（端口 8080）

---

## Friend 视角：怎么使用

完全不需要碰服务器或代码。前提：你的 host 已经把管家 bot 的用户名告诉你（如 `@YourHostRelayManagerBot`）。

### 第一次接入

1. 去 [@BotFather](https://t.me/BotFather) 发 `/newbot`，按指引取一个名字和用户名，复制返回的 token（形如 `12345:ABC...`）
2. 在 Telegram 找 host 给你的管家 bot
3. 发 `/setup`，再粘贴上一步的 token
4. 看到 `✅ @你的bot 已上线` 就完事
5. **重要**：长按你刚才发 token 的消息 → 选 "Delete for me and bot"，把 token 从聊天历史里清掉

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
| 发 `/status` | 看该 bot 的运行状态（msg-map 数 / 黑名单数等） |

⚠️ `/block` 等**必须是回复一条转发消息**才生效——禁止裸输入 UID，避免误伤。

### 管理你拥有的 bot

在管家 bot 里：

| 命令 | 说明 |
|---|---|
| `/list` | 看你拥有的所有 bot |
| `/info <bot_username>` | 看某个 bot 的详细信息 |
| `/displaymode <bot_username> <native\|tag\|hex>` | 切换显示模式（[见下](#显示模式)） |
| `/admins <bot_username> [add\|remove <uid> \| list]` | 管理管理员（owner 不能被移除） |
| `/start_message <bot_username> <文案>` | 改 /start 文案（支持多行；最长 1000 字符） |
| `/pause <bot_username>` | 暂停（注销 webhook，bot 不再接收消息） |
| `/resume <bot_username>` | 恢复（重新注册 webhook） |
| `/delete <bot_username> --yes` | 删除（注销 webhook + 清所有数据） |

`/delete` 不带 `--yes` 只会提示确认，加上才真删。

---

## Host 视角：怎么部署

### 准备

1. **一台服务器** —— Linux 居多。1 vCPU / 512 MB RAM / 5 GB 磁盘对个人/小团队足够
2. **Docker + Docker Compose** —— 跟 distro 一致的安装方式（[官方文档](https://docs.docker.com/engine/install/)）
3. **一个反代 + HTTPS 域名** —— Telegram webhook 强制 HTTPS，容器自身只听 HTTP。常见组合：Caddy（自动签证书）/ Nginx + certbot / Traefik / Cloudflare Tunnel
4. **管家 bot** —— 去 [@BotFather](https://t.me/BotFather) `/newbot`，建议名字带 `Manager` 后缀以与 tenant bot 区分，保存 token
5. **你自己的 Telegram UID** —— 找 [@userinfobot](https://t.me/userinfobot) 发任意消息，记下 `Id:` 后面的数字

### 部署步骤

```bash
# 1. 克隆
git clone <this repo>
cd tg-relay-bot-docker

# 2. 准备 env 文件
cp .env.example .env
# 编辑 .env，填入：
#   ENV_MANAGER_BOT_TOKEN  — 上面建的管家 bot token
#   ENV_HOST_UID           — 你的 Telegram UID
#   ENV_MASTER_ENC_KEY     — 运行 `openssl rand -base64 32` 一次得到
#   ENV_PUBLIC_BASE_URL    — 反代对外的 HTTPS URL，如 https://relay.example.com（必须 https://，不带尾斜杠）
#   ENV_ADMIN_SECRET       — 运行 `openssl rand -hex 32` 一次得到

# 3. 启动容器（首次构建会拉镜像 + 编译 better-sqlite3，约 1-2 分钟）
docker compose up -d

# 4. 配反代，把 ENV_PUBLIC_BASE_URL 对应的域名 TLS 终止后转发到 127.0.0.1:8080
#    Caddyfile 示例：
#       relay.example.com {
#           reverse_proxy 127.0.0.1:8080
#       }

# 5. 注册管家 bot 的 webhook（容器起来 + 反代就位后）
curl "https://relay.example.com/admin/registerWebhook?s=<ENV_ADMIN_SECRET>"
# 应返回：manager webhook registered at https://relay.example.com/wh/<管家botId>

# 6. 在 Telegram 找你的管家 bot 发 /start，应收到欢迎语
```

### 部署故障排查

| 症状 | 可能原因 |
|---|---|
| 容器启动后立刻退出 + 日志 `fatal: missing env XXX` | `.env` 里某个必填字段没填 |
| 启动报 `fatal: ENV_PUBLIC_BASE_URL must start with https://` | 填了 `http://` 或裸 hostname；必须 `https://` |
| 反代收到 502 / 容器健康检查失败 | 容器还没起完，`docker compose logs bot` 看 `listening on :8080`；或反代回源端口错了 |
| `/admin/registerWebhook` 返回 `Not found` | `ENV_ADMIN_SECRET` 未设、URL 拼错、或 secret 含特殊字符未 URL-encode |
| `/admin/registerWebhook` 返回 502 + `telegram error` | `ENV_MANAGER_BOT_TOKEN` 错或已被 revoke |
| Manager bot 不响应 `/start` | webhook 未注册（重跑步骤 5）；`docker compose logs -f bot` 看错误 |
| `/setup` 后 `setWebhook 失败` | `ENV_PUBLIC_BASE_URL` 对应的 HTTPS 域名 Telegram 访问不到（DNS、证书、防火墙、Cloudflare proxy 等），单独 `curl -I https://relay.example.com/healthz` 自测 |
| 重启后 Telegram 重发旧消息洗版 | `update_id` dedup 在 5min TTL 内会去重；过 5 分钟自然停 |

### Secret 的含义与轮换策略

| 字段 | 作用 | 何时换 |
|---|---|---|
| `ENV_MANAGER_BOT_TOKEN` | 管家 bot 的身份 | 管家 bot 重置时；换后需重跑步骤 5 |
| `ENV_HOST_UID` | 你（host）的 Telegram UID | 你换 Telegram 账号时 |
| `ENV_MASTER_ENC_KEY` | 加密所有 tenant token 的 AES key | **永远不要换**——换了所有 tenant 全部失效 |
| `ENV_PUBLIC_BASE_URL` | 反代对外的 HTTPS URL | 换域名时；换后所有 tenant 要 `/pause` 再 `/resume` 重新注册 webhook |
| `ENV_ADMIN_SECRET` | 鉴权 `/admin/*` 端点 | 怀疑泄漏时随时可换 |
| `ENV_DEBUG` | 是否开调试日志 | 默认不设 |

改完 `.env` 后跑 `docker compose up -d` 重启容器即可生效。

> ⚠️ `ENV_MASTER_ENC_KEY` 是整个系统中最敏感的密钥。它丢失或被改 = 所有租户 token 不可恢复 = 全平台需要每个 tenant 重新 `/setup`。建议把生成出来的值另做一份离线备份；同时定期备份 `./data/db.sqlite`。

### 把你自己也当作 friend

部署完后，host 也要走一遍 friend 流程才能拥有第一个对外 bot：

1. 去 BotFather 单独建一个对外的 relay bot（**不是管家 bot**）
2. 在管家 bot 里 `/setup`，粘贴新 bot 的 token
3. 完事

---

## 管家 bot 命令清单

朋友与 host 通用：

| 命令 | 说明 |
|---|---|
| `/start` | 欢迎语 |
| `/help` | 命令清单（host 会多看到 host-only 命令） |
| `/whoami` | 显示你的 Telegram UID |
| `/cancel` | 重置当前会话状态（中止 /setup） |
| `/setup` | 多轮对话：粘 token → 自动验证 → 自动注册 webhook |
| `/list` | 列出你拥有的所有 bot |
| `/info <bot_username>` | 查看某个 bot 的详情 |
| `/displaymode <bot_username> <native\|tag\|hex>` | 切换显示模式 |
| `/admins <bot_username> [add\|remove <uid> \| list]` | 管理管理员列表；不带动作默认 `list`；不能移除 owner |
| `/start_message <bot_username> <文案>` | 自定义 /start 文案（支持多行，最长 1000 字符） |
| `/pause <bot_username>` | 暂停 bot |
| `/resume <bot_username>` | 恢复 bot |
| `/delete <bot_username> [--yes]` | 删除 bot；不带 `--yes` 仅提示，加上才真删 |

仅 host 可用：

| 命令 | 说明 |
|---|---|
| `/host_list` | 列出**所有**租户（含其他朋友的） |
| `/host_disable <bot_username>` | 强制暂停任意 tenant（不需要是 owner） |
| `/host_purge <bot_username> --yes` | 强制删除任意 tenant；不带 `--yes` 仅提示 |

---

## Tenant bot 行为

每个 onboard 出来的 bot 自己的私聊里支持以下命令。

所有人可用：

| 命令 | 说明 |
|---|---|
| `/start` | 显示欢迎语（默认中英双语；当前不可通过命令自定义） |
| `/help` | 显示用法 |
| `/whoami` | 显示当前发送者的 UID |

仅所有者可用（即 onboard 这个 bot 的 friend）：

| 操作 | 效果 |
|---|---|
| reply 一条转发消息发任意文字 | 该文字回复给原访客 |
| reply 一条转发消息发 `/block` | 拉黑该访客 |
| reply 一条转发消息发 `/unblock` | 解黑 |
| reply 一条转发消息发 `/checkblock` | 查询是否被屏蔽 |
| 发 `/status` | 显示运行状态（msg-map / block / rate-limit windows 计数） |

非 admin 用户发 `/block` 等命令 → 命令不生效（被当作普通消息转发给 admin）。

---

## 显示模式

每个 tenant bot 独立配置；默认 `native`。在管家 bot 里 `/displaymode <bot_username> <mode>` 切换。

| 模式 | 转发样式 | 适合 |
|---|---|---|
| `native` | Telegram 原生 forward UI（顶部 "Forwarded from <访客名字>"，可点访客 profile） | 大多数场景；最直观 |
| `tag` | 富 HTML 标签 (`↘ <name> · @handle · id:xxx`，带 tg://user 可点链接) + copyMessage（不显示 forward 元数据） | 想看到访客身份但不愿 bot 显得在"转发" |
| `hex` | 不可读哈希标签 (`↘ a3f9c1b8...`) + copyMessage | 隐私最大化；admin 也只看到匿名哈希 |

---

## 运维

### 看实时日志

```bash
docker compose logs -f bot
```

默认只在错误时输出。`.env` 里设 `ENV_DEBUG=1` 后可见结构化事件流（不含消息内容）。

### 查看数据库内容

数据库是宿主机 `./data/db.sqlite`，可以直接用 sqlite3 命令查：

```bash
# 列所有 key
sqlite3 ./data/db.sqlite "SELECT key FROM kv ORDER BY key;"

# 某个 tenant 的所有 key
sqlite3 ./data/db.sqlite "SELECT key FROM kv WHERE key LIKE 'tenant:<botId>:%' ORDER BY key;"

# 统计 msg-map / 黑名单条数
sqlite3 ./data/db.sqlite "SELECT substr(key, 1, instr(key, '-')-1) AS kind, COUNT(*) FROM kv GROUP BY kind;"
```

### 强制清除某个 tenant（绕过管家 bot）

正常请走管家 bot 的 `/delete <bot_username> --yes`。如果管家 bot 不可用：

```bash
sqlite3 ./data/db.sqlite "DELETE FROM kv WHERE key LIKE 'tenant:<botId>:%';"
```

记得手动 `curl https://api.telegram.org/bot<token>/deleteWebhook` 解绑 webhook，否则 Telegram 会继续向已删除的 tenant 发更新。

### 备份 / 恢复

整个状态在 `./data/db.sqlite` 一个文件里。停容器或 SQLite 在线 backup 任选：

```bash
# 推荐：在线 backup，不停服务
sqlite3 ./data/db.sqlite ".backup ./data/backup-$(date +%F).sqlite"

# 或停容器后复制（数据量小、最省事）
docker compose down
cp ./data/db.sqlite /path/to/backup/db.sqlite
docker compose up -d
```

恢复就是把备份文件还原回 `./data/db.sqlite`，然后 `docker compose restart bot`。

### 升级到新版本

```bash
git pull
docker compose build --pull
docker compose up -d
```

不需要重新注册 webhook、不需要改 `.env`、不会丢 `./data/db.sqlite`。

### 完全卸载

```bash
# 1. 在 Telegram 找 BotFather 删掉所有 bot（管家 bot + 你建的 tenant bot）
# 2. 停容器并删数据
docker compose down -v
rm -rf ./data
# 3. 删镜像（可选）
docker image rm tg-relay-bot:local
```

### 重建（撤掉重新部署）

= **完全卸载 + 重新走一遍部署**。如果旧 bot 还想继续用，BotFather 那一步只解绑 webhook、不真删 bot：

```bash
# 1a. 给每个想保留的 bot 解绑 webhook（不删 bot）
curl "https://api.telegram.org/bot<旧 bot token>/deleteWebhook"

# 1b. 不想保留的 bot 才去 BotFather → /mybots → Delete Bot

# 2. 停容器 + 删数据
docker compose down -v
rm -rf ./data

# 3. 按上面"部署步骤"从头来一遍
```

注意：**新生成的 `ENV_MASTER_ENC_KEY` 不可能跟旧的一样**——所有旧 tenant 的加密 token 失效，每个朋友都要重新 `/setup`。

只想换某个字段不动数据：编辑 `.env` 后 `docker compose up -d` 重启容器即可。注意 `ENV_MASTER_ENC_KEY` 换了**所有现有 tenant token 不可解**。

只想暂时下线（不删数据）：`docker compose stop bot` 即可，`docker compose start bot` 恢复；或在管家 bot 里给单个 tenant `/pause` / `/resume`。

---

## 隐私与安全模型

### 我们能做到的

- 访客 chatId 以 HMAC-SHA256 哈希存储（`userKey`），dump 数据库看不到 chatId 明文（除短期 msg-map 之外）
- 所有 tenant token 用 AES-GCM 加密存储于 SQLite
- 每个 tenant 的 webhook secret 是独立随机 32 字节，校验用 constant-time 比较防侧信道
- Telegram 重发的 webhook 自动去重（`update_id`）
- 每访客 60s 内最多 5 条；超出静默丢弃
- 所有 admin 端点强制 `ENV_ADMIN_SECRET`，无效一律 404
- bot 默认忽略群聊与 `message` 之外的所有更新类型
- 管理命令必须 reply 一条转发消息才生效，禁止裸 UID 操作

### 我们做不到的

| 谁 | 能看到内容 | 为什么 |
|---|---|---|
| Telegram 公司 | ✅ | Telegram **不是** E2E 加密；bot 协议无法用 Secret Chats |
| Host（部署方） | ✅ | `docker logs` 看日志；`./data/db.sqlite` 含所有租户 token；多租户托管的固有代价 |
| 反代/TLS 终止层 | ✅ 技术上可见 | TLS 在反代处终止后内部明文转发到容器；如果反代是别人的（Cloudflare Tunnel 等），他们也能看到 |
| 任何拿到某 bot token 的人 | ✅ | token = 全权；切换 webhook 即可截获所有该 bot 的消息 |
| 任何拿到 `./data/db.sqlite` + `ENV_MASTER_ENC_KEY` 的人 | ✅ | 两者一起 = 解密所有 tenant token |
| ISP / 中间网络 | ❌ 仅元数据 | TLS 加密 |
| 其它 Telegram 用户 | ❌ | 私聊为 1-to-1 |

### 信任模型

- **Host 与 Friend 之间需要相互信任**——host 持有所有租户 token 的解密能力
- **不要在不可信的 host 上托管你的 bot**
- 你与 Telegram 公司、宿主机所在 IDC、TLS 反代提供方的信任，是这个架构的前置假设
- 服务器被入侵 = 攻击者拿到 `./data/db.sqlite` + 容器里的 `ENV_MASTER_ENC_KEY` = 全部 tenant 沦陷。建议宿主机硬化、限制 SSH、`./data` 目录权限收紧到 owner-only

---

## 数据保留

数据库 `./data/db.sqlite` 的 `kv` 表存储所有状态，每行带一个 `expires_at` 列。读到的时候 lazy 检查并删除过期行；后台 timer 每小时跑一次清理。

| 数据 | 保留时长 |
|---|---|
| `tenant:{botId}:cfg`（含加密 token） | 直到 `/delete --yes` |
| `tenant:{botId}:msg-map-{id}` | 30 天后 TTL 过期 |
| `tenant:{botId}:block-{userKey}` | 直到 `/unblock` |
| `tenant:{botId}:rate-{userKey}` | 60 秒后 TTL 过期 |
| `tenant:{botId}:update-{id}` | 5 分钟后 TTL 过期 |
| `tenant:{botId}:mg-{adminId}-{mgId}` | 60 秒后 TTL 过期 |
| `manager:user-state-{uid}` | 1 小时无活动后 TTL 过期 |
| `manager:dedup-update-{id}` | 5 分钟后 TTL 过期 |

---

## 常见问题

**Q: 如果换了 `ENV_MASTER_ENC_KEY` 会怎样？**
全部 tenant 不可恢复——这个 key 用于加密所有 token，换了等于丢失全部 token。每个租户必须重新 `/setup`。**永远不要换**这个 key。

**Q: 为什么 webhook 路径有时候返回 404？**
可能 4 种：(a) URL 不对；(b) `X-Telegram-Bot-Api-Secret-Token` header 缺失或不对；(c) tenant 已 `/pause`；(d) tenant 已删除。

**Q: 管家 bot 不响应怎么办？**
检查 `docker compose logs -f bot` 日志；用 `/admin/registerWebhook?s=...` 重新注册；确认 `ENV_MANAGER_BOT_TOKEN` 正确、反代 + DNS 正常（`curl https://relay.example.com/healthz` 应该返回 `{"ok":true}`）。

**Q: 朋友的 tenant bot 收不到消息？**
在管家 bot 里 `/info <他的bot>` 看 `status`；如果 paused 就 `/resume`；或让朋友重新 `/setup`。

**Q: 朋友能看到我的 bot 数据吗？**
不能。每个 tenant 在数据库内完全隔离（`tenant:{botId}:` 前缀），且只有 owner 自己能用 `/info /pause` 等命令。Host 能用 `/host_list` 看到所有 tenant **存在**，但消息内容并不持久化保存。

**Q: 一台多大的机器够用？**
1 vCPU / 512 MB RAM / 5 GB 磁盘的小 VPS 跑十几个 tenant bot 完全够。SQLite 单写者足够应付个人/小团队规模；如果你预期同时有几百号活跃 tenant 高并发写，那应该考虑切到 Redis/Postgres，不过那时你也不该用这套架构了。

**Q: 怎么本地开发？**
`cp .env.example .env` 填好；`npm install`；`npm run dev`（tsx watch 模式，文件变了自动重启）。SQLite 数据库默认建在 `./data/db.sqlite`，可以删了重来。要本地接通 Telegram webhook 测试，用 ngrok / cloudflared tunnel 暴露到公网，把 `ENV_PUBLIC_BASE_URL` 改成 tunnel URL。

**Q: 为什么访客在 60s 内连发多条只看到前 5 条到达？**
限速保护：每访客每 60s 最多 5 条。超出的会被静默丢弃，访客不会收到任何提示（避免给攻击者反馈）。

---

## 开发

```bash
npm install           # 装依赖（含 better-sqlite3 原生构建）
npm run typecheck     # tsc 类型检查
npm test              # vitest 测试套件，本地全离线（不需要 Docker）
npm run test:watch    # 测试 watch 模式
npm run dev           # tsx watch src/server.ts，改代码自动重启
npm start             # 一次性跑 src/server.ts（prod 入口）
```

测试位于 `tests/unit/`（KV 实现 / crypto / security / storage）和 `tests/integration/`（webhook 路由、tenant 隔离、manager 命令）。集成测试通过 `app.fetch(new Request(...))` 直接驱动 Hono app，无需起 HTTP server。

容器内部行为同样可以本地复现：

```bash
docker compose build       # 构建镜像（首次约 1-2 分钟）
docker compose up -d       # 启动
docker compose logs -f bot # 跟日志
docker compose down        # 停（不删 data/）
```

---

## 致谢

- [LloydAsp/nfd](https://github.com/LloydAsp/nfd) — 单租户单文件版本，本仓库的起点
- Cloudflare Workers + KV — 上游 / Worker 版本的运行环境，本仓库的起点
- Hono、@hono/node-server、better-sqlite3 —— Node 端的核心运行栈

## License

继承自上游，详见 [LICENSE](LICENSE)。
