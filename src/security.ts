import type { ScopedKV } from './storage';
import { TelegramError } from './telegram';

const enc = new TextEncoder();

const hmacKeyCache = new Map<string, CryptoKey>();
async function getHmacKey(secret: string): Promise<CryptoKey> {
  const cached = hmacKeyCache.get(secret);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  hmacKeyCache.set(secret, key);
  return key;
}

export async function userKey(chatId: number | string, hashSecret: string): Promise<string> {
  const key = await getHmacKey(hashSecret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(chatId)));
  return [...new Uint8Array(sig)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

interface RateLimitState {
  start: number;
  count: number;
}

// Relay-hot-path put: a KV write throttle (KV allows only 1 write/sec to the same
// key and throws 429 beyond that) or an exhausted daily write quota must degrade
// the bookkeeping this key carries — never abort processing the guest's message.
// Config and blocklist writes stay fail-loud; do not route them through here.
export async function tryPut(
  skv: ScopedKV,
  key: string,
  value: string,
  ttlSec: number,
  event: string,
): Promise<void> {
  try {
    await skv.put(key, value, ttlSec);
  } catch (e) {
    logError(event, e);
  }
}

export async function checkRateLimit(
  skv: ScopedKV,
  uk: string,
  windowSec: number,
  max: number,
): Promise<boolean> {
  const k = `rate-${uk}`;
  const now = Date.now();
  const cur = await skv.getJson<RateLimitState>(k);
  const fresh = !cur || now - cur.start > windowSec * 1000;
  const next: RateLimitState = fresh
    ? { start: now, count: 1 }
    : { start: cur.start, count: cur.count + 1 };
  if (next.count > max) return false;
  // Persisted only for admitted messages: once over the limit the stored count no
  // longer changes the decision (it stays above max until the window lapses), and
  // skipping the write keeps a flood from hammering this key — rejections cost
  // zero KV writes.
  await tryPut(skv, k, JSON.stringify(next), windowSec, 'rate_put');
  return true;
}

export async function isBlocked(skv: ScopedKV, uk: string): Promise<boolean> {
  return (await skv.getString(`block-${uk}`)) === '1';
}

export async function setBlocked(skv: ScopedKV, uk: string): Promise<void> {
  await skv.put(`block-${uk}`, '1');
}

export async function clearBlocked(skv: ScopedKV, uk: string): Promise<void> {
  await skv.delete(`block-${uk}`);
}

// Webhook dedup is split into check and mark so the mark (a KV write) can be
// deferred until the update is known to cause a non-idempotent side effect.
// Dropped messages (blocked / rate-limited / uninvited spam) are processed
// idempotently, so leaving them unmarked is harmless — and it means junk traffic
// consumes zero writes of the platform-wide daily KV quota.
export async function seenUpdate(skv: ScopedKV, updateId: number): Promise<boolean> {
  return (await skv.getString(`update-${updateId}`)) !== null;
}

export async function markUpdateSeen(
  skv: ScopedKV,
  updateId: number,
  ttlSec: number,
): Promise<void> {
  // Fail-open: losing the mark risks (rare) double-processing of a Telegram
  // re-delivery; failing loud would drop the message outright.
  await tryPut(skv, `update-${updateId}`, '1', ttlSec, 'dedup_put');
}

export function logEvent(
  debug: boolean,
  event: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  if (!debug) return;
  const parts = [`event=${event}`, ...Object.entries(fields).map(([k, v]) => `${k}=${v}`)];
  console.log(parts.join(' '));
}

// Long digit runs are masked so an error message can never leak a chatId/UID into
// logs (e.g. V8's JSON SyntaxError quotes a fragment of the offending source).
function sanitizeForLog(s: string): string {
  return s.replace(/\d{5,}/g, '<id>').replace(/\s+/g, ' ').slice(0, 200);
}

export function formatError(
  event: string,
  err: unknown,
  fields: Record<string, string | number> = {},
): string {
  const parts = [
    `error event=${event}`,
    ...Object.entries(fields).map(([k, v]) => `${k}=${v}`),
  ];
  if (err instanceof TelegramError) {
    parts.push('name=TelegramError', `method=${err.method}`, `detail=${sanitizeForLog(err.detail)}`);
  } else if (err instanceof Error) {
    parts.push(`name=${err.name}`, `msg=${sanitizeForLog(err.message)}`);
  } else {
    parts.push('name=Unknown');
  }
  return parts.join(' ');
}

export function logError(
  event: string,
  err: unknown,
  fields: Record<string, string | number> = {},
): void {
  console.error(formatError(event, err, fields));
}
