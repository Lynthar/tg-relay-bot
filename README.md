# Relay Bot

**中文** | [English](README.en.md)

一个跑在 Cloudflare Worker 上的 Telegram **双向消息中继 bot 平台**。一份部署可以同时托管你自己 + 朋友们的多个 bot；朋友通过 Telegram 自助 onboard，全程不需要碰 Cloudflare 或代码。

> Fork 自 [LloydAsp/nfd](https://github.com/LloydAsp/nfd)，重写为多租户架构，强化隐私与安全模型。

---

## 它是什么

一句话：让任何人能给你的 bot 发消息找到你，但 **对方不知道你是谁，也找不到你的真实账号**。

详细：

- 别人给你的 bot 发消息 → 你（运营者）在自己的 Telegram 里收到
- 你直接 reply 那条消息 → 对方收到你的回复，发信人显示为 bot
- 对方完全感知不到你这个真实账号

**多租户**意味着：你（部署方）一次部署，可以同时为自己和你信任的朋友托管多个独立的 bot，每个 bot 数据完全隔离。

## 核心特性

- **轻量** — 单 Cloudflare Worker + 单 KV namespace，零运行时外部依赖
- **多租户** — 一次部署托管所有 bot；朋友在 Telegram 内自助 onboard（需 host 先 `/invite` 邀请）
- **静态加密** — 所有 tenant 的 bot token、webhook secret、hashSecret 在 KV 中一律 AES-GCM 加密存储
- **访客匿名化** — 访客 chatId 在 KV 中以 HMAC-SHA256 哈希形式存储；dump KV 也无法还原"是谁联系过谁"
- **安全收紧** — 每个 webhook 请求强制校验每租户随机的 secret_token（constant-time 比较）、`update_id` 去重、限速、admin 命令必须 reply 转发消息
- **零成本** — Cloudflare 免费档对个人/小团队完全够用

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
| **Host** | 部署本仓库的人 | Cloudflare 账号 + Node.js + 仓库代码 |
| **Friend** | 想拥有自己 bot 的人，由 host 邀请 | 仅需 Telegram |
| **Guest** | 给某个 bot 发消息的任何人 | 仅需 Telegram |

## 架构概览

```
                       ┌──────────────────────────────────┐
                       │  Cloudflare Worker（一份代码）    │
 Friend ──manager bot─→│   /wh/{managerBotId}              │── KV (manager:user-state-*)
                       │     ↓ /setup 多轮对话             │
 Guest ──tenant bot──→ │   /wh/{tenantBotId}               │── KV (tenant:{botId}:*)
                       │     ↓ relay 转发                  │      msg-map / block / rate / dedup
 Friend ←──────────── │     ↓ forwardMessage              │
                       └──────────────────────────────────┘
```

- **管家 bot**（host 一次性建好）：朋友通过它 onboard 与管理自己的 bot
- **Tenant bot**（朋友各自的）：实际承担"双向消息中继"工作
- 二者共用同一个 Worker，URL 路径区分

---

---

## 快速开始

**如果你是 friend**（host 已经把管家 bot 的用户名给你了）：找那个管家 bot 发 `/whoami` 把 UID 报给 host，等他 `/invite` 你；然后去 [@BotFather](https://t.me/BotFather) 建一个自己的 bot，回来发 `/setup` 粘 token 即可。全程不碰 Cloudflare。

**如果你是 host**：

```bash
git clone <this repo> && cd tg-relay-bot && npm install
npx wrangler login
npx wrangler kv namespace create nfd      # 把返回的 id 填进 wrangler.toml
npx wrangler secret put ENV_MANAGER_BOT_TOKEN
npx wrangler secret put ENV_HOST_UID
npx wrangler secret put ENV_MASTER_ENC_KEY   # openssl rand -base64 32
npx wrangler secret put ENV_ADMIN_SECRET     # openssl rand -hex 32
npx wrangler deploy
curl 'https://<你的 worker>.workers.dev/admin/registerWebhook?s=<ENV_ADMIN_SECRET>'
```

⚠️ `wrangler.toml` 里现有的 KV id 是上一任 host 的，**必须换成自己的**。`ENV_MASTER_ENC_KEY` 一旦丢失或更换，所有租户 token 不可恢复——生成后另做一份离线备份。

逐步说明、故障排查表、secret 轮换策略见[使用与部署指南](docs/user-guide.md#host-视角怎么部署)。

## 文档

**[使用与部署指南](docs/user-guide.md)** 是完整参考：

| 章节 | 讲什么 |
|---|---|
| [Friend 视角](docs/user-guide.md#friend-视角怎么使用) | 接入、日常收发、屏蔽、管理自己的 bot |
| [Host 视角](docs/user-guide.md#host-视角怎么部署) | 部署七步、故障排查、secret 含义与轮换 |
| [命令清单](docs/user-guide.md#管家-bot-命令清单) · [Tenant 行为](docs/user-guide.md#tenant-bot-行为) · [显示模式](docs/user-guide.md#显示模式) | 全部命令与三种转发样式 |
| [运维](docs/user-guide.md#运维) | 看日志、查 KV、强制清租户、升级、卸载、重建 |
| [隐私与安全模型](docs/user-guide.md#隐私与安全模型) | 能做到什么、**做不到什么**、信任模型 |
| [数据保留](docs/user-guide.md#数据保留) · [常见问题](docs/user-guide.md#常见问题) · [开发](docs/user-guide.md#开发) | KV 各键的 TTL、FAQ、本地开发与测试 |

English readers: [Usage and Deployment Guide](docs/user-guide.en.md).

---

## 致谢

- [LloydAsp/nfd](https://github.com/LloydAsp/nfd) — 单租户单文件版本，本仓库的起点
- Cloudflare Workers + KV — 让一个轻量 bot 平台可以零运维上线

## License

继承自上游，详见 [LICENSE](LICENSE)。
