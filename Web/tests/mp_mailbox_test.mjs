// The one-link mailbox: rooms, links, and the host/guest hand-over through a local ntfy-compatible relay.
import assert from 'node:assert/strict';
import { createRelay } from '../tools/signal-relay.mjs';
import { Mailbox, hostInvite, guestJoin, newRoom, validRoom, inviteUrl, roomFrom, DEFAULT_SIGNAL, tagOf } from '../www/mp-mailbox.js';

const relay = createRelay();
await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${relay.server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(15); } };
const record = () => { const log = []; return { log, cb: (s, d) => log.push(s + (d ? `:${d}` : '')) }; };

// ---- rooms and links ------------------------------------------------------------------------------
const rooms = new Set(Array.from({ length: 500 }, () => newRoom()));
assert.equal(rooms.size, 500, 'rooms are unique');
for (const r of rooms) assert.ok(validRoom(r), r);
const room = [...rooms][0];
const link = inviteUrl('https://user.github.io/repo/play/?data=x&scale=2#old', room, DEFAULT_SIGNAL);
assert.equal(link, `https://user.github.io/repo/play/#join=${room}`);
assert.equal(inviteUrl('http://localhost:8080/', room, 'https://relay.example').split('#')[0], 'http://localhost:8080/?signal=https%3A%2F%2Frelay.example');
assert.equal(roomFrom(link), room);
assert.equal(roomFrom(`please join: ${link} thanks`), room);
assert.equal(roomFrom(`#join=${room.toUpperCase()}`), room);
assert.equal(roomFrom('#join=short'), null); assert.equal(roomFrom('nothing'), null);
assert.throws(() => new Mailbox({ base: 'http://example.com', room }), /https/);
assert.throws(() => new Mailbox({ base, room: 'bad' }), /room/);

// ---- relay behaviour (what ntfy.sh also does) ------------------------------------------------------
{
  const mb = new Mailbox({ base, room: newRoom() });
  await mb.post({ k: 'x' });
  const big = await fetch(mb.url, { method: 'POST', body: 'a'.repeat(5000) });
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${base}/bad%20topic`, { method: 'POST', body: 'x' })).status, 404);
  const pre = await fetch(mb.url, { method: 'OPTIONS' });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const got = []; mb.subscribe((m) => got.push(m)); await until('history replay', () => got.length === 1); mb.close();
}

// ---- a normal hand-over ---------------------------------------------------------------------------
{
  const mb = () => new Mailbox({ base, room });
  const h = record(), g = record();
  let received = null;
  const host = hostInvite({ mailbox: mb(), offerCode: 'OFFER-CODE-1', onStatus: h.cb, onAnswer: async (code) => { received = code; } });
  await until('host waiting', () => h.log.includes('waiting'));
  const guest = guestJoin({ mailbox: mb(), settleMs: 60, onStatus: g.cb, onOffer: async (offer) => { assert.equal(offer, 'OFFER-CODE-1'); return 'ANSWER-A-1234567890'; } });
  await until('host got the reply', () => received === 'ANSWER-A-1234567890');
  await until('host answered', () => h.log.includes('answered'));
  assert.deepEqual(g.log.slice(0, 3), ['looking', 'joining', 'replied:ANSWER-A-1234567890']);
  // A second guest opening the same link now finds the room taken.
  const g2 = record();
  guestJoin({ mailbox: mb(), settleMs: 60, onStatus: g2.cb, onOffer: async () => { throw new Error('must not join'); } });
  await until('second guest told full', () => g2.log.includes('full'));
  // The first guest is not misled by the "taken" that names it.
  await sleep(150); assert.ok(!g.log.includes('full'), g.log.join());
  host.done(); guest.stop();
}

// ---- a guest that opens the link first still joins once the host posts ------------------------------
{
  const r2 = newRoom(), mb = () => new Mailbox({ base, room: r2 });
  const g = record(); let joined = false;
  guestJoin({ mailbox: mb(), settleMs: 60, missingMs: 4000, onStatus: g.cb, onOffer: async () => { joined = true; return 'ANSWER-B-1234567890'; } });
  await sleep(200); assert.ok(!joined);
  const h = record(); let ans = null;
  hostInvite({ mailbox: mb(), offerCode: 'OFFER-CODE-2', onStatus: h.cb, onAnswer: async (c) => { ans = c; } });
  await until('late host joined', () => ans === 'ANSWER-B-1234567890');
}

// ---- cancelled and missing invitations ----------------------------------------------------------------
{
  const r3 = newRoom(), mb = () => new Mailbox({ base, room: r3 });
  const h = record();
  const host = hostInvite({ mailbox: mb(), offerCode: 'OFFER-CODE-3', onStatus: h.cb, onAnswer: async () => {} });
  await until('posted', () => h.log.includes('waiting'));
  host.cancel();
  await sleep(100);
  const g = record();
  guestJoin({ mailbox: mb(), settleMs: 60, onStatus: g.cb, onOffer: async () => { throw new Error('must not join'); } });
  await until('guest told the invitation ended', () => g.log.includes('ended'));
  const gm = record();
  guestJoin({ mailbox: new Mailbox({ base, room: newRoom() }), settleMs: 60, missingMs: 400, onStatus: gm.cb, onOffer: async () => 'x' });
  await until('missing room', () => gm.log.includes('missing'));
}

// ---- a damaged reply does not block a good one -----------------------------------------------------------
{
  const r4 = newRoom(), mb = () => new Mailbox({ base, room: r4 });
  const h = record(); const seen = [];
  hostInvite({ mailbox: mb(), offerCode: 'OFFER-CODE-4', onStatus: h.cb, onAnswer: async (c) => { seen.push(c); if (c === 'BAD') throw new Error('damaged'); } });
  await until('posted', () => h.log.includes('waiting'));
  await mb().post({ k: 'answer', v: 1, code: 'BAD' });
  await until('bad answer reported', () => h.log.some((s) => s.startsWith('bad-answer')));
  await mb().post({ k: 'answer', v: 1, code: 'GOOD-ONE-1234567890' });
  await until('good answer accepted', () => h.log.includes('answered'));
  assert.deepEqual(seen, ['BAD', 'GOOD-ONE-1234567890']);
}

// ---- the service is not reachable ------------------------------------------------------------------------
{
  const dead = new Mailbox({ base: 'http://127.0.0.1:9', room: newRoom() });
  const h = record();
  const host = hostInvite({ mailbox: dead, offerCode: 'x', unreachableMs: 200, onStatus: h.cb, onAnswer: async () => {} });
  await until('unreachable reported', () => h.log.some((s) => s.startsWith('unreachable')), 3000);
  host.done();
  const g = record();
  const guest = guestJoin({ mailbox: new Mailbox({ base: 'http://127.0.0.1:9', room: newRoom() }), unreachableMs: 200, onStatus: g.cb, onOffer: async () => 'x' });
  await until('guest unreachable', () => g.log.includes('unreachable'), 3000);
  guest.stop();
}

// ---- rate limit ---------------------------------------------------------------------------------------------
{
  const mb = new Mailbox({ base, room: newRoom() });
  let limited = 0;
  for (let i = 0; i < 80; ++i) { const r = await fetch(mb.url, { method: 'POST', body: 'x' }); if (r.status === 429) ++limited; }
  assert.ok(limited > 0, 'the relay limits one address');
}
assert.equal(tagOf('ab-cd 12'), 'ABCD12');
console.log(`OK (${relay.stats.posts} posts, ${relay.stats.streams} streams)`);
relay.close();
process.exit(0);
