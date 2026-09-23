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

// HMAC-SHA256 of `value` under `secret`, truncated to 32 hex chars.
export async function keyedHash(value: string, secret: string): Promise<string> {
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return [...new Uint8Array(sig)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function userKey(chatId: number | string, hashSecret: string): Promise<string> {
  return keyedHash(String(chatId), hashSecret);
}

// Storage keys and debug logs carry this instead of an owner/admin UID. It must never equal the
// same person's userKey: a dump could then join an operator key to a guest row holding their UID.
export function operatorKey(uid: number | string, hashSecret: string): Promise<string> {
  return keyedHash(`operator:${uid}`, hashSecret);
}

// The operator key older versions wrote (equal to userKey). Read-only: never write under it.
export function legacyOperatorKey(uid: number | string, hashSecret: string): Promise<string> {
  return userKey(uid, hashSecret);
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

// Relay-hot-path put: a write throttle (KV allows 1 write/sec per key, 429 beyond) or an exhausted
// daily quota must degrade this bookkeeping, never abort the guest's message. Config and blocklist
// writes stay fail-loud — dropped silently, a /block would look applied while it is not.
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

// 'limited_first' is the first rejection of a window — the caller's cue to tell the guest once.
export type RateLimitVerdict = 'admitted' | 'limited' | 'limited_first';

export async function checkRateLimit(
  skv: ScopedKV,
  uk: string,
  windowSec: number,
  max: number,
): Promise<RateLimitVerdict> {
  const k = `rate-${uk}`;
  const now = Date.now();
  const cur = await skv.getJson<RateLimitState>(k);
  const next: RateLimitState =
    cur && now - cur.start <= windowSec * 1000
      ? { start: cur.start, count: cur.count + 1 }
      : { start: now, count: 1 };
  // A stored count of max + 1 records that the window's notice went out. Beyond it nothing is
  // persisted: the decision cannot change until the window lapses, and skipping the write keeps
  // a flood from hammering this key.
  if (next.count > max + 1) return 'limited';
  await tryPut(skv, k, JSON.stringify(next), windowSec, 'rate_put');
  return next.count > max ? 'limited_first' : 'admitted';
}

export interface BlockEntry {
  reason?: string;
  // Epoch ms at which the block lifts; absent means permanent.
  until?: number;
}

// Value the pre-timed-block code wrote: a permanent block with nothing to say about it.
const LEGACY_BLOCK_VALUE = '1';

export async function getBlock(skv: ScopedKV, uk: string): Promise<BlockEntry | null> {
  const raw = await skv.getString(`block-${uk}`);
  if (raw === null) return null;
  const entry: BlockEntry = raw === LEGACY_BLOCK_VALUE ? {} : JSON.parse(raw);
  // The key expires with `until`, but a KV edge cache may serve it for up to a minute longer;
  // the timestamp decides, so an expired block never drops a message.
  if (entry.until !== undefined && entry.until <= Date.now()) return null;
  return entry;
}

export async function isBlocked(skv: ScopedKV, uk: string): Promise<boolean> {
  return (await getBlock(skv, uk)) !== null;
}

/**
 * @param entry.until Must lie at least MIN_EXPIRATION_TTL_SEC (60 s) ahead: it becomes the
 *   key's expirationTtl, and the store rejects a nearer value (RangeError).
 * @throws RangeError when `until` is not in the future — a zero TTL would mean "never expires".
 */
export async function setBlocked(
  skv: ScopedKV,
  uk: string,
  entry: BlockEntry = {},
): Promise<void> {
  let ttlSec: number | undefined;
  if (entry.until !== undefined) {
    ttlSec = Math.ceil((entry.until - Date.now()) / 1000);
    if (ttlSec <= 0) throw new RangeError('block `until` must be in the future');
  }
  await skv.put(`block-${uk}`, JSON.stringify(entry), ttlSec);
}

export async function clearBlocked(skv: ScopedKV, uk: string): Promise<void> {
  await skv.delete(`block-${uk}`);
}

// Dedup is split into check and mark so the mark (a KV write) is deferred until the update is known
// to cause a non-idempotent side effect. Dropped updates (blocked / rate-limited / spam) are handled
// idempotently, so leaving them unmarked is harmless and costs junk traffic zero writes.
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
