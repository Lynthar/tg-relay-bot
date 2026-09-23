import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MANAGER_BOT_ID,
  buildUpdate,
  env,
  flush,
  managerWebhookSecret,
  postWebhook,
  provisionTenant,
  storedOperators,
  tgMock,
  type ProvisionedTenant,
} from '../helpers';
import { getBlock, userKey } from '../../src/security';
import { ScopedKV } from '../../src/storage';

beforeAll(() => tgMock.install());
beforeEach(() => tgMock.reset());
afterAll(() => tgMock.uninstall());

// What someone holding only a storage dump sees: key names and raw values, no secret.
interface Row {
  key: string;
  value: string;
}

async function dumpTenant(botId: string): Promise<Row[]> {
  const prefix = `tenant:${botId}:`;
  const rows: Row[] = [];
  for (const { name } of (await env.nfd.list({ prefix })).keys) {
    const value = await env.nfd.get(name);
    if (value !== null) rows.push({ key: name.slice(prefix.length), value });
  }
  return rows;
}

const hashesIn = (s: string): string[] => s.match(/[0-9a-f]{32}/g) ?? [];

function chatIdIn(value: string): string | null {
  try {
    const v: unknown = JSON.parse(value);
    return v && typeof v === 'object' && 'chatId' in v ? String(v.chatId) : null;
  } catch {
    return null;
  }
}

// Joins a dump observer can make by string equality alone.
function linkage(rows: Row[]) {
  const operatorHashes = new Set(
    rows.flatMap((r) => r.key.match(/^(?:msg-map|mg|recall)-([0-9a-f]{32})-/)?.slice(1) ?? []),
  );
  const guestSide = rows.flatMap((r) => [
    ...(r.key.match(/^(?:block|rate|album)-([0-9a-f]{32})/)?.slice(1) ?? []),
    ...hashesIn(r.value),
  ]);
  const withChatId = rows.filter((r) => chatIdIn(r.value) !== null);
  return {
    operatorHashes,
    guestChatIds: withChatId.map((r) => chatIdIn(r.value)),
    // A guest-derived hash equal to an operator key: this admin has also been a guest.
    sharedHashes: [...new Set(guestSide.filter((h) => operatorHashes.has(h)))],
    // A row holding a UID next to an operator key names who runs the bot.
    recoveredUids: withChatId
      .filter((r) => hashesIn(r.value).some((h) => operatorHashes.has(h)))
      .map((r) => chatIdIn(r.value)),
    // A row holding a UID next to any hash is a join column into every key built from it.
    chatIdRowsWithHash: withChatId.filter((r) => hashesIn(r.value).length > 0).map((r) => r.key),
  };
}

async function guestSays(t: ProvisionedTenant, uid: number): Promise<void> {
  await postWebhook(t.botId, t.webhookSecret, buildUpdate({ chatId: uid, text: 'hi' }));
  await flush();
}

async function ownerRuns(owner: number, text: string): Promise<void> {
  const secret = await managerWebhookSecret();
  await postWebhook(MANAGER_BOT_ID, secret, buildUpdate({ chatId: owner, text }));
  await flush();
}

async function setAdmin(t: ProvisionedTenant, owner: number, uid: number, on: boolean) {
  await ownerRuns(owner, `/admins ${t.cfg.botUsername} ${on ? 'add' : 'remove'} ${uid}`);
  expect((await storedOperators(t.botId))?.adminUids.includes(String(uid))).toBe(on);
}

function expectUnlinkable(link: ReturnType<typeof linkage>): void {
  expect(link.recoveredUids).toEqual([]);
  expect(link.sharedHashes).toEqual([]);
  expect(link.chatIdRowsWithHash).toEqual([]);
}

describe('a storage dump cannot tie an operator to a UID', () => {
  it('a guest promoted to admin, then another forward', async () => {
    const [owner, person, guest] = [710011, 710012, 710013];
    const t = await provisionTenant({ botId: '710010', ownerUid: String(owner) });
    await guestSays(t, person);
    await setAdmin(t, owner, person, true);
    await guestSays(t, guest);

    const link = linkage(await dumpTenant(t.botId));
    expect(link.operatorHashes.size).toBe(2);
    expect(link.guestChatIds).toContain(String(person));
    expectUnlinkable(link);
  });

  it('an admin who received forwards, removed, then speaking as a guest', async () => {
    const [owner, person, guest] = [710021, 710022, 710023];
    const t = await provisionTenant({ botId: '710020', ownerUid: String(owner) });
    await setAdmin(t, owner, person, true);
    await guestSays(t, guest);
    await setAdmin(t, owner, person, false);
    await guestSays(t, person);

    const link = linkage(await dumpTenant(t.botId));
    expect(link.operatorHashes.size).toBe(2);
    expect(link.guestChatIds).toContain(String(person));
    expectUnlinkable(link);
  });

  it('an admin with no guest history', async () => {
    const [owner, person, guest] = [710031, 710032, 710033];
    const t = await provisionTenant({ botId: '710030', ownerUid: String(owner) });
    await setAdmin(t, owner, person, true);
    await guestSays(t, guest);

    const link = linkage(await dumpTenant(t.botId));
    expect(link.operatorHashes.size).toBe(2);
    expectUnlinkable(link);
  });

  it('an owner who never spoke as a guest', async () => {
    const [owner, guest] = [710041, 710043];
    const t = await provisionTenant({ botId: '710040', ownerUid: String(owner) });
    await guestSays(t, guest);

    const link = linkage(await dumpTenant(t.botId));
    expect(link.operatorHashes.size).toBe(1);
    expectUnlinkable(link);
  });

  it('a reply-based /block still lands on the guest behind a fresh mapping', async () => {
    const [owner, guest] = [710051, 710053];
    const t = await provisionTenant({ botId: '710050', ownerUid: String(owner) });
    tgMock.setResponder(() => Response.json({ ok: true, result: { message_id: 4444 } }));
    await guestSays(t, guest);

    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: owner, text: '/block spam', replyToMessageId: 4444 }),
    );
    await flush();
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    expect(await getBlock(skv, await userKey(guest, t.hashSecret))).toEqual({ reason: 'spam' });
  });
});

// Older versions keyed operator entries by userKey(uid); they must keep working until they expire.
describe('entries under the pre-split operator key', () => {
  async function seed(botId: string, owner: number) {
    const t = await provisionTenant({ botId, ownerUid: String(owner) });
    const skv = new ScopedKV(env.nfd, `tenant:${t.botId}:`);
    return { t, skv, oldKey: await userKey(owner, t.hashSecret) };
  }

  async function ownerReplies(t: ProvisionedTenant, owner: number, text: string, to: number) {
    await postWebhook(
      t.botId,
      t.webhookSecret,
      buildUpdate({ chatId: owner, text, replyToMessageId: to }),
    );
    await flush();
  }

  it('a forward mapped under it still takes a reply and a reply-based /block', async () => {
    const [owner, guest] = [710061, 710063];
    const { t, skv, oldKey } = await seed('710060', owner);
    const uk = await userKey(guest, t.hashSecret);
    await skv.put(
      `msg-map-${oldKey}-4343`,
      JSON.stringify({ chatId: guest, userKey: uk, createdAt: Date.now() }),
    );

    await ownerReplies(t, owner, 'hello', 4343);
    expect(tgMock.getCallsByMethod('copyMessage')[0]?.body?.chat_id).toBe(guest);

    await ownerReplies(t, owner, '/block', 4343);
    expect(await getBlock(skv, uk)).toEqual({});
  });

  it('a recall pointer under it still recalls, and is dropped', async () => {
    const [owner, guest] = [710071, 710073];
    const { t, skv, oldKey } = await seed('710070', owner);
    await skv.put(`recall-${oldKey}-888`, JSON.stringify({ chatId: guest, messageId: 777 }));

    await ownerReplies(t, owner, '/recall', 888);
    expect(tgMock.getCallsByMethod('deleteMessage')[0]?.body).toEqual({
      chat_id: guest,
      message_id: 777,
    });
    expect(await skv.getString(`recall-${oldKey}-888`)).toBeNull();
  });
});
