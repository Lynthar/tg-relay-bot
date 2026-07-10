import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  checkRateLimit,
  clearBlocked,
  constantTimeEqual,
  formatError,
  isBlocked,
  isDuplicateUpdate,
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
  it('allows first 5, blocks 6th within window', async () => {
    const skv = freshSkv();
    const uk = 'rl-test';
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(await checkRateLimit(skv, uk, 60, 5));
    }
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('separate userKeys have independent counters', async () => {
    const skv = freshSkv();
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(skv, 'uk-a', 60, 5)).toBe(true);
    }
    expect(await checkRateLimit(skv, 'uk-a', 60, 5)).toBe(false);
    expect(await checkRateLimit(skv, 'uk-b', 60, 5)).toBe(true);
  });
});

describe('blocklist', () => {
  it('set / check / clear round trip', async () => {
    const skv = freshSkv();
    const uk = 'block-test';
    expect(await isBlocked(skv, uk)).toBe(false);
    await setBlocked(skv, uk);
    expect(await isBlocked(skv, uk)).toBe(true);
    await clearBlocked(skv, uk);
    expect(await isBlocked(skv, uk)).toBe(false);
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

describe('isDuplicateUpdate', () => {
  it('first call returns false, second returns true', async () => {
    const skv = freshSkv();
    expect(await isDuplicateUpdate(skv, 100, 60)).toBe(false);
    expect(await isDuplicateUpdate(skv, 100, 60)).toBe(true);
  });

  it('distinct update_ids are independent', async () => {
    const skv = freshSkv();
    expect(await isDuplicateUpdate(skv, 1, 60)).toBe(false);
    expect(await isDuplicateUpdate(skv, 2, 60)).toBe(false);
    expect(await isDuplicateUpdate(skv, 1, 60)).toBe(true);
  });
});
