# Relay Bot

**中文** | [English](README.en.md)

一个用 Docker 部署的 Telegram **双向消息中继 bot 平台**。一份部署可以同时托管你自己 + 朋友们的多个 bot；朋友通过 Telegram 自助 onboard，全程不需要碰服务器或代码。

> Fork 自 [LloydAsp/nfd](https://github.com/LloydAsp/nfd)，重写为多租户架构，从 Cloudflare Worker 迁移到 Node.js + SQLite 容器化部署，强化隐私与安全模型。

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

---

## 快速开始

**如果你是 friend**（host 已经把管家 bot 的用户名给你了）：找那个管家 bot 发 `/whoami` 把 UID 报给 host，等他 `/invite` 你；然后去 [@BotFather](https://t.me/BotFather) 建一个自己的 bot，回来发 `/setup` 粘 token 即可。全程不碰服务器。

**如果你是 host**：需要一台能跑 Docker 的机器和一个能签 HTTPS 证书的域名。

```bash
git clone <this repo> && cd tg-relay-bot-docker
cp .env.example .env      # 填 5 个必填项，见下
docker compose up -d      # 首次会编译 better-sqlite3，约 1-2 分钟
# 配反代把域名 TLS 终止后转发到 127.0.0.1:8080
curl "https://relay.example.com/admin/registerWebhook?s=<ENV_ADMIN_SECRET>"
```

`.env` 的五个必填项：`ENV_MANAGER_BOT_TOKEN`（管家 bot token）· `ENV_HOST_UID`（你的 Telegram UID）· `ENV_MASTER_ENC_KEY`（`openssl rand -base64 32`）· `ENV_PUBLIC_BASE_URL`（反代对外的 HTTPS URL，必须 `https://`、不带尾斜杠）· `ENV_ADMIN_SECRET`（`openssl rand -hex 32`）。

⚠️ `ENV_MASTER_ENC_KEY` 一旦丢失或更换，所有租户 token 不可恢复——生成后另做一份离线备份。

逐步说明、Caddy 反代示例、故障排查表、secret 轮换策略见[使用与部署指南](docs/user-guide.md#host-视角怎么部署)。

## 文档

**[使用与部署指南](docs/user-guide.md)** 是完整参考：

| 章节 | 讲什么 |
|---|---|
| [Friend 视角](docs/user-guide.md#friend-视角怎么使用) | 接入、日常收发、屏蔽、管理自己的 bot |
| [Host 视角](docs/user-guide.md#host-视角怎么部署) | 部署六步、反代配置、故障排查、secret 含义与轮换 |
| [命令清单](docs/user-guide.md#管家-bot-命令清单) · [Tenant 行为](docs/user-guide.md#tenant-bot-行为) · [显示模式](docs/user-guide.md#显示模式) | 全部命令与三种转发样式 |
| [运维](docs/user-guide.md#运维) | 看日志、查数据库、强制清租户、备份恢复、升级、卸载、重建 |
| [隐私与安全模型](docs/user-guide.md#隐私与安全模型) | 能做到什么、**做不到什么**、信任模型 |
| [数据保留](docs/user-guide.md#数据保留) · [常见问题](docs/user-guide.md#常见问题) · [开发](docs/user-guide.md#开发) | 各表的保留时长、FAQ、本地开发与测试 |

English readers: [Usage and Deployment Guide](docs/user-guide.en.md)。

---

## 致谢

- [LloydAsp/nfd](https://github.com/LloydAsp/nfd) — 单租户单文件版本，本仓库的起点
- Cloudflare Workers + KV — 上游 / Worker 版本的运行环境，本仓库的起点
- Hono、@hono/node-server、better-sqlite3 —— Node 端的核心运行栈

## License

继承自上游，详见 [LICENSE](LICENSE)。
