import type { ScopedKV } from './storage';

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
  await skv.put(k, JSON.stringify(next), windowSec);
  return next.count <= max;
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

export async function isDuplicateUpdate(
  skv: ScopedKV,
  updateId: number,
  ttlSec: number,
): Promise<boolean> {
  const k = `update-${updateId}`;
  const seen = await skv.getString(k);
  if (seen) return true;
  await skv.put(k, '1', ttlSec);
  return false;
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

export function logError(event: string, err: unknown): void {
  const name = err instanceof Error ? err.name : 'Unknown';
  console.error(`error event=${event} name=${name}`);
}
