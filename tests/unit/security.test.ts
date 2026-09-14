import { describe, expect, it, vi } from 'vitest';
import { env } from '../helpers';
import {
  checkRateLimit,
  clearBlocked,
  constantTimeEqual,
  formatError,
  getBlock,
  isBlocked,
  markUpdateSeen,
  seenUpdate,
  setBlocked,
  userKey,
} from '../../src/security';
import { ScopedKV } from '../../src/storage';
import { TelegramError } from '../../src/telegram';

function freshSkv(): ScopedKV {
  return new ScopedKV(env.nfd, `test:sec:${crypto.randomUUID()}:`);
}

describe('userKey', () => {
  it('is deterministic for the same chatId + secret', async () => {
    const a = await userKey(12345, 'secret-a');
    const b = await userKey(12345, 'secret-a');
    expect(a).toBe(b);
  });

  it('differs across hashSecrets (cross-tenant isolation)', async () => {
    const a = await userKey(12345, 'secret-a');
    const b = await userKey(12345, 'secret-b');
    expect(a).not.toBe(b);
  });

  it('differs across chatIds', async () => {
    const a = await userKey(12345, 'secret');
    const b = await userKey(12346, 'secret');
    expect(a).not.toBe(b);
  });

  it('produces 32 hex chars (16 bytes truncated HMAC)', async () => {
    expect(await userKey(1, 's')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('constantTimeEqual', () => {
  it('is true for identical strings', () => {
    expect(constantTimeEqual('hello', 'hello')).toBe(true);
  });

  it('is false for different lengths', () => {
    expect(constantTimeEqual('hello', 'hell')).toBe(false);
  });

  it('is false for same-length differing strings', () => {
    expect(constantTimeEqual('hello', 'world')).toBe(false);
  });
});

describe('checkRateLimit', () => {
  it('admits the first 5; the 6th is the one rejection that carries a notice, later ones do not', async () => {
    const skv = freshSkv();
    const uk = 'rl-test';
    const results: string[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(await checkRateLimit(skv, uk, 60, 5));
    }
    expect(results).toEqual([
      'admitted',
      'admitted',
      'admitted',
      'admitted',
      'admitted',
      'limited_first',
      'limited',
      'limited',
    ]);
  });

  it('separate userKeys have independent counters', async () => {
    const skv = freshSkv();
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(skv, 'uk-a', 60, 5)).toBe('admitted');
    }
    expect(await checkRateLimit(skv, 'uk-a', 60, 5)).toBe('limited_first');
    expect(await checkRateLimit(skv, 'uk-b', 60, 5)).toBe('admitted');
  });

  it('only the first rejection is persisted (count = max + 1); the flood after it writes nothing', async () => {
    const skv = freshSkv();
    const put = vi.spyOn(env.nfd, 'put');
    try {
      for (let i = 0; i < 8; i++) await checkRateLimit(skv, 'uk-c', 60, 5);
      expect(put).toHaveBeenCalledTimes(6);
    } finally {
      put.mockRestore();
    }
    const state = await skv.getJson<{ count: number }>('rate-uk-c');
    expect(state?.count).toBe(6);
  });

  it('a fresh window admits again and carries its own single notice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const skv = freshSkv();
      for (let i = 0; i < 7; i++) await checkRateLimit(skv, 'uk-d', 60, 5);
      vi.setSystemTime(Date.now() + 61_000);
      expect(await checkRateLimit(skv, 'uk-d', 60, 5)).toBe('admitted');
      for (let i = 0; i < 4; i++) await checkRateLimit(skv, 'uk-d', 60, 5);
      expect(await checkRateLimit(skv, 'uk-d', 60, 5)).toBe('limited_first');
      expect(await checkRateLimit(skv, 'uk-d', 60, 5)).toBe('limited');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('blocklist', () => {
  it('set / check / clear round trip', async () => {
    const skv = freshSkv();
    const uk = 'block-test';
    expect(await isBlocked(skv, uk)).toBe(false);
    await setBlocked(skv, uk);
    expect(await isBlocked(skv, uk)).toBe(true);
    expect(await getBlock(skv, uk)).toEqual({});
    await clearBlocked(skv, uk);
    expect(await isBlocked(skv, uk)).toBe(false);
  });

  it('a value written by the old code ("1") reads as a permanent block with no detail', async () => {
    const skv = freshSkv();
    await skv.put('block-legacy', '1');
    expect(await getBlock(skv, 'legacy')).toEqual({});
    expect(await isBlocked(skv, 'legacy')).toBe(true);
  });

  it('a timed block keeps its detail and lifts itself once `until` passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const skv = freshSkv();
      const until = Date.now() + 5 * 60_000;
      await setBlocked(skv, 'timed', { reason: 'spam', until });
      expect(await getBlock(skv, 'timed')).toEqual({ reason: 'spam', until });
      vi.setSystemTime(until - 1000);
      expect(await isBlocked(skv, 'timed')).toBe(true);
      vi.setSystemTime(until);
      expect(await isBlocked(skv, 'timed')).toBe(false);
      // The key carried a matching TTL, so the store reaped it on its own.
      expect(await skv.getString('block-timed')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an expired `until` wins even while the store still serves the value', async () => {
    const skv = freshSkv();
    await skv.put('block-stale', JSON.stringify({ until: Date.now() - 1 }));
    expect(await getBlock(skv, 'stale')).toBeNull();
    expect(await isBlocked(skv, 'stale')).toBe(false);
  });
});

describe('formatError', () => {
  it('TelegramError includes method and detail', () => {
    const e = new TelegramError('forwardMessage', 'Forbidden: bot was blocked by the user');
    expect(formatError('forward', e)).toBe(
      'error event=forward name=TelegramError method=forwardMessage detail=Forbidden: bot was blocked by the user',
    );
  });

  it('extra fields are emitted before error details', () => {
    const e = new TelegramError('sendMessage', 'network');
    expect(formatError('forward', e, { admin: '42' })).toContain('admin=42 name=TelegramError');
  });

  it('masks digit runs of 5+ so chatIds/UIDs cannot leak', () => {
    const e = new Error('Unexpected token in {"chatId":1234567890,...');
    const out = formatError('tenant_update', e);
    expect(out).not.toContain('1234567890');
    expect(out).toContain('<id>');
  });

  it('keeps short numbers and truncates very long messages', () => {
    const e = new Error(`retry after 30 ${'x'.repeat(500)}`);
    const out = formatError('t', e);
    expect(out).toContain('retry after 30');
    expect(out.length).toBeLessThan(300);
  });

  it('non-Error values fall back to name=Unknown', () => {
    expect(formatError('t', 'boom')).toBe('error event=t name=Unknown');
  });
});

describe('update dedup (seenUpdate / markUpdateSeen)', () => {
  it('unseen until marked, seen afterwards', async () => {
    const skv = freshSkv();
    expect(await seenUpdate(skv, 100)).toBe(false);
    await markUpdateSeen(skv, 100, 60);
    expect(await seenUpdate(skv, 100)).toBe(true);
  });

  it('distinct update_ids are independent', async () => {
    const skv = freshSkv();
    await markUpdateSeen(skv, 1, 60);
    expect(await seenUpdate(skv, 1)).toBe(true);
    expect(await seenUpdate(skv, 2)).toBe(false);
  });
});
