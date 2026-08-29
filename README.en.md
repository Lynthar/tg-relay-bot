# tg-relay-bot

[![license](https://img.shields.io/github/license/Lynthar/tg-relay-bot)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Lynthar/tg-relay-bot/ci.yml?branch=main&label=CI)](https://github.com/Lynthar/tg-relay-bot/actions/workflows/ci.yml)

Privacy-first, multi-tenant Telegram message relay bot — one codebase, two deploy targets: Cloudflare Worker or Docker

English | [简体中文](README.md)

A stranger messages your bot; the message lands in your own Telegram. You reply
to that forwarded message and they get an answer — from the bot. Your account
never appears.

```mermaid
sequenceDiagram
    participant V as Visitor
    participant B as Relay bot
    participant O as You
    V->>B: private message
    B->>O: forwarded; the sender shows only as a userKey
    O->>B: reply to the forwarded message
    B->>V: delivered as the bot
```

My biggest change from upstream is that **one deployment hosts many bots**.
Yours, plus your friends', fully isolated from each other. Your friends never
touch the server and never ask you for a key: they message a "manager bot", send
`/setup`, and paste their own token.

## Install

Both deployment targets are fully supported, and CI exercises both. Either way
you first need a **manager bot** from [@BotFather](https://t.me/BotFather) —
separate from any relay bot — and your own Telegram UID.

**Cloudflare Worker** — needs a Cloudflare account and Node 20+:

```bash
git clone https://github.com/Lynthar/tg-relay-bot.git
cd tg-relay-bot
npm install
npx wrangler login
npx wrangler kv namespace create nfd
```

Put the returned id in `wrangler.toml` — **the one committed there belongs to
someone else and must be replaced** — set `ENV_PUBLIC_BASE_URL` under `[vars]`,
then:

```bash
npx wrangler secret put ENV_MANAGER_BOT_TOKEN
npx wrangler secret put ENV_HOST_UID
npx wrangler secret put ENV_MASTER_ENC_KEY
npx wrangler secret put ENV_ADMIN_SECRET
npx wrangler deploy
```

**Docker** — needs a domain you can get an HTTPS certificate for, since Telegram
only sends webhooks over HTTPS:

```bash
git clone https://github.com/Lynthar/tg-relay-bot.git
cd tg-relay-bot
cp .env.example .env
docker compose up -d
```

Terminate TLS in your reverse proxy and forward to `127.0.0.1:8080`. Both
deployment targets then need the webhook registered once:

```bash
curl "https://<your-domain>/admin/registerWebhook?s=<ENV_ADMIN_SECRET>"
```

## Usage

The shortest sequence for a friend: message the manager bot with `/whoami` to get
their UID, send it to you, you run `/invite <uid>`, they create a bot with
BotFather, then `/setup` in the manager bot and paste the token. Up to three
bots per UID, and the webhook registers itself.

In the manager bot, anyone can use `/start`, `/help`, `/whoami`, `/setup`,
`/list` and `/cancel`.

Bot owners manage their own:

```
/info <bot_username>
/displaymode <bot_username> <native|tag|hex>
/admins <bot_username> [add|remove <uid> | list]
/start_message <bot_username> <text>
/pause <bot_username>   /resume <bot_username>
/delete <bot_username> --yes
```

The host also has `/invite`, `/uninvite`, `/invites`, `/host_list`,
`/host_disable`, `/host_purge` and `/host_migrate`.

On a relay bot, `/block`, `/unblock` and `/checkblock` only work as a **reply to
a forwarded message**. Albums, forwards and every media type take the same
path; visitors are rate-limited to 5 messages per 60s by default (an album
counting as one), updates are de-duplicated, and each bot can have up to 10
admins.

## Configuration

On Worker, `wrangler secret put` plus `[vars]` in `wrangler.toml`. On Docker, an
`.env` file. Per-tenant settings don't live here — they're in KV or SQLite.

| Variable | Notes |
|---|---|
| `ENV_MANAGER_BOT_TOKEN` | The manager bot's token — **not** a relay bot's |
| `ENV_HOST_UID` | Your own Telegram UID |
| `ENV_MASTER_ENC_KEY` | base64 32-byte AES key. **Set it once and never change it** — changing it makes every tenant token undecryptable |
| `ENV_PUBLIC_BASE_URL` | Required, must start with `https://`; every webhook URL is built from it |
| `ENV_ADMIN_SECRET` | Guards `/admin/*`; without it those endpoints 404 unconditionally |
| `PORT` / `DATA_DIR` | Node target only, default 8080 and `/data` |

Generate keys with `openssl rand -base64 32` and `openssl rand -hex 32`.

## Security and limits

- **Not end-to-end encrypted** — Telegram can't do that, and neither can this.
  The host can decrypt every tenant's token, so **don't run this somewhere you
  don't trust**.
- **Anonymity protects visitors, not operators.** With `ENV_DEBUG=1`, event logs
  record owner and admin UIDs. Visitors only ever appear as a userKey.
- **`ENV_MASTER_ENC_KEY` is the only root key, and losing it is unrecoverable.**
  Every tenant has to `/setup` again; there's no second line of defence.
- **Data can't be migrated between the two deployment targets.** Switching means
  everyone reconfigures, and blocklists are lost.
- **Private chats only.** Groups, channels, edited messages and callback queries
  are not processed.
- **No command menu and no buttons** — bot usernames, UIDs and 32-character
  userKeys all have to be typed by hand.

On the storage side: a visitor's chat ID is never stored, only a 16-byte
truncated `HMAC-SHA256` under a per-tenant key; tenant bot tokens and webhook
secrets are encrypted at rest with AES-256-GCM; secrets are compared in constant
time. 174 test cases — the main suite on plain Node, plus five smoke tests
against real workerd.

## Differences from upstream

Upstream is [LloydAsp/nfd](https://github.com/LloydAsp/nfd): a single-tenant,
single-file Worker where each bot's configuration lives in environment
variables, so adding a bot means editing Cloudflare config. I rewrote it in
TypeScript as a multi-tenant service — configuration moved into storage,
credentials encrypted at rest, plus invites, rate limiting, de-duplication, a
SQLite backend and Docker deployment. I also dropped upstream's UID fraud list,
which served a community use case and is otherwise a runtime dependency on the
open internet.

## Documentation

- [User guide](docs/user-guide.md) — deployment, day-to-day use, FAQ. Also in
  [English](docs/user-guide.en.md).

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE). Inherited from
upstream [LloydAsp/nfd](https://github.com/LloydAsp/nfd), which is GPL-3.0 as
well.
