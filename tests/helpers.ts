import { buildApp } from '../src/index';
import { parseHostConfig, type Env } from '../src/config';
import { getEncKey } from '../src/crypto';
import { MemoryKvStore } from '../src/kv/memory';
import { createTenant, putStored, type StoredTenantCfg } from '../src/tenant';
import type { DisplayMode, TgUpdate } from '../src/types';

export const MANAGER_BOT_ID = '111111';
export const MANAGER_TOKEN = '111111:test-manager-token-aaaa';
export const HOST_UID = '999999';
export const ADMIN_SECRET = 'test-admin-secret';
export const PUBLIC_BASE_URL = 'https://test.example.com';

// Module-level Env shared across all tests in a worker. Tests use unique botIds /
// scope prefixes to avoid cross-test interference.
export const env: Env = {
  nfd: new MemoryKvStore(),
  ENV_MANAGER_BOT_TOKEN: MANAGER_TOKEN,
  ENV_HOST_UID: HOST_UID,
  ENV_MASTER_ENC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ENV_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
  ENV_ADMIN_SECRET: ADMIN_SECRET,
};

let cachedManagerSecret: string | null = null;
export async function managerWebhookSecret(): Promise<string> {
  if (cachedManagerSecret) return cachedManagerSecret;
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(MANAGER_TOKEN + ':manager-webhook'),
  );
  cachedManagerSecret = [...new Uint8Array(buf)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return cachedManagerSecret;
}

export interface ProvisionedTenant {
  botId: string;
  token: string;
  webhookSecret: string;
  cfg: StoredTenantCfg;
}

export async function provisionTenant(args: {
  botId: string;
  ownerUid: string;
  botUsername?: string;
  displayMode?: DisplayMode;
}): Promise<ProvisionedTenant> {
  const token = `${args.botId}:test-token-${args.botId}`;
  const encKey = await getEncKey(env.ENV_MASTER_ENC_KEY);
  const cfg = await createTenant(env.nfd, encKey, {
    token,
    ownerUid: args.ownerUid,
    botUsername: args.botUsername ?? `test_bot_${args.botId}`,
    botId: args.botId,
  });
  if (args.displayMode && args.displayMode !== cfg.displayMode) {
    cfg.displayMode = args.displayMode;
    await putStored(env.nfd, args.botId, cfg);
  }
  return { botId: args.botId, token, webhookSecret: cfg.webhookSecret, cfg };
}

let nextId = 1_000_000;
export function nid(): number {
  return nextId++;
}

export interface UpdateBuilder {
  updateId?: number;
  messageId?: number;
  chatId: number;
  fromId?: number;
  text?: string;
  replyToMessageId?: number;
  mediaGroupId?: string;
  languageCode?: string;
}

export function buildUpdate(b: UpdateBuilder): TgUpdate {
  const fromId = b.fromId ?? b.chatId;
  const reply =
    b.replyToMessageId !== undefined
      ? {
          message_id: b.replyToMessageId,
          chat: { id: b.chatId, type: 'private' as const },
        }
      : undefined;
  return {
    update_id: b.updateId ?? nid(),
    message: {
      message_id: b.messageId ?? nid(),
      chat: { id: b.chatId, type: 'private' as const },
      from: {
        id: fromId,
        first_name: 'Test',
        is_bot: false,
        ...(b.languageCode !== undefined ? { language_code: b.languageCode } : {}),
      },
      ...(b.text !== undefined ? { text: b.text } : {}),
      ...(reply ? { reply_to_message: reply } : {}),
      ...(b.mediaGroupId !== undefined ? { media_group_id: b.mediaGroupId } : {}),
    },
  };
}

export function webhookUrl(botId: string): string {
  return `${PUBLIC_BASE_URL}/wh/${botId}`;
}

// Lazy singleton — the Hono app captures env + host at construction; rebuilding
// per test is unnecessary because env is module-shared.
let appPromise: ReturnType<typeof buildAppFromEnv> | null = null;
async function buildAppFromEnv(): Promise<{ fetch: (req: Request) => Promise<Response> }> {
  const host = await parseHostConfig(env);
  const app = buildApp({ env, host });
  return { fetch: (req: Request) => Promise.resolve(app.fetch(req)) };
}
function getApp(): Promise<{ fetch: (req: Request) => Promise<Response> }> {
  if (!appPromise) appPromise = buildAppFromEnv();
  return appPromise;
}

async function callApp(req: Request): Promise<Response> {
  const app = await getApp();
  return app.fetch(req);
}

export async function postWebhook(
  botId: string,
  secret: string | null,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  const req = new Request(webhookUrl(botId), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return callApp(req);
}

export async function getWebhook(botId: string): Promise<Response> {
  return callApp(new Request(webhookUrl(botId), { method: 'GET' }));
}

// Brief sleep so ctx.waitUntil background work has time to settle before assertions.
export function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Telegram API mock ───────────────────────────────────────────────────
// `SELF.fetch` is gone; tests call `worker.fetch` directly. We still need to
// intercept outbound api.telegram.org calls — same trick as before, patch
// `globalThis.fetch`.
export interface TgCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

type TgResponder = (call: TgCall) => Response | Promise<Response>;

class TgMock {
  private originalFetch: typeof fetch | null = null;
  private calls: TgCall[] = [];
  private responder: TgResponder | null = null;

  install(): void {
    if (this.originalFetch) return;
    this.originalFetch = globalThis.fetch;
    const self = this;
    globalThis.fetch = async function patched(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith('https://api.telegram.org')) {
        const bodyStr = typeof init?.body === 'string' ? init.body : null;
        let parsed: Record<string, unknown> | null = null;
        if (bodyStr) {
          try {
            parsed = JSON.parse(bodyStr) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
        }
        const call: TgCall = { url, method: init?.method ?? 'GET', body: parsed };
        self.calls.push(call);
        if (self.responder) return self.responder(call);
        return Response.json({
          ok: true,
          result: { message_id: Math.floor(Math.random() * 1e9) },
        });
      }
      return self.originalFetch!.call(globalThis, input, init);
    };
  }

  reset(): void {
    this.calls = [];
    this.responder = null;
  }

  uninstall(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
    this.calls = [];
    this.responder = null;
  }

  getCalls(): TgCall[] {
    return [...this.calls];
  }

  getCallsByMethod(method: string): TgCall[] {
    return this.calls.filter((c) => c.url.endsWith(`/${method}`));
  }

  setResponder(r: TgResponder | null): void {
    this.responder = r;
  }
}

export const tgMock = new TgMock();
