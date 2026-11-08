// Two complete games, two sessions, one in-memory link: the whole online flow without a browser.
//   handshake -> lobby (car, rules, ready, chat) -> race -> result -> records -> back to the lobby -> second race -> leave
//
//   node Web/tests/mp_session_test.mjs <core-dir> <asset-root> [--delay 0.05] [--loss 0.1] [--seed N] [--second 1]
//   --second 1 adds a second race that times out, where the guest declines to continue and the host is told.
import assert from 'node:assert/strict';
import { loadModuleFactory, makeCore, driveWithBot, releaseControls, makeLink } from './mp_helpers.mjs';
import { MpSession } from '../www/mp-session.js';
import { RecordStore } from '../www/mp-records.js';

const [coreDir, assetRoot, ...rest] = process.argv.slice(2);
if (!coreDir || !assetRoot) { console.error('usage: mp_session_test.mjs <core-dir> <asset-root> [options]'); process.exit(2); }
const opt = { delay: 0.04, loss: 0.1, seed: 5, second: 0 };
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = Number(rest[i + 1]);

const IdasCore = await loadModuleFactory(coreDir);
const host = await makeCore(IdasCore, assetRoot, 'host'), guest = await makeCore(IdasCore, assetRoot, 'guest');

let frame = 0;
const clock = () => frame / 60;
const link = makeLink(clock, { delay: opt.delay, loss: opt.loss, seed: opt.seed });
const memoryStore = () => { let text = null; return new RecordStore({ load: () => text, save: (t) => { text = t; } }); };
const stores = { host: memoryStore(), guest: memoryStore() };
const make = (p, role, end, name) => new MpSession({ mp: p.mp, role, name, send: (m, r) => end.send(m, r), now: clock, store: stores[p.name], buildId: 'test-build', random: Math.random });
host.session = make(host, 'host', link.a, 'Takumi');
guest.session = make(guest, 'guest', link.b, 'Ryosuke');
host.end = link.a; guest.end = link.b;
const players = [host, guest];

const log = (...a) => console.log(`[${(frame / 60).toFixed(1).padStart(7)}s]`, ...a);
let stage = 'connect', stageAt = 0, raceNumber = 0, resultTick = 0;
const events = [];
function frameStep() {
  for (const p of players) {
    p.end.pump(p.session);
    p.session.beforeFrame();
    if (p.session.state === 'racing' || p.session.state === 'loading' || p.session.state === 'countdown') {
      if (raceNumber === 1) { if (!driveWithBot(p)) releaseControls(p); }
      else { releaseControls(p); p.input.keys[38 >> 5] |= 1 << (38 & 31); }      // held Up arrow: throttle only, the race times out
    } else releaseControls(p);
    p.core.step(p.input);
    p.core.readAudio();
    p.core.frame(); p.core.ui();
    p.session.afterFrame();
  }
  ++frame;
}
const both = (state) => host.session.state === state && guest.session.state === state;

function script() {
  const h = host.session, g = guest.session;
  switch (stage) {
    case 'connect':
      // The host's channels open first, so its hello reaches the guest before the guest's own link reports open.
      if (frame === 5) h.linkOpened();
      if (frame === 25) g.linkOpened();
      if (both('lobby')) {
        assert.equal(h.remoteName, 'RYOSUKE'.slice(0, 0) + 'Ryosuke'); assert.equal(g.remoteName, 'Takumi');
        log('both in the lobby; garage sizes', h.garage.length, g.garage.length);
        // The guest picks a different car, the host a course; chat both ways.
        const other = g.garage.find((x) => x.car === 12) ?? g.garage[1];
        g.selectCar(other.selection);
        h.setRules({ course: 3, collisions: true, boost: true });
        stage = 'settle'; stageAt = frame;
      }
      break;
    case 'settle':
      if (frame - stageAt === 30) { assert.ok(h.say('hello from the host')); assert.ok(g.say('<b>hi</b> from the guest')); }
      if (frame - stageAt === 60) {
        assert.equal(g.local.car, 12, 'guest car selected');
        assert.equal(h.remote.car, g.local.car, 'host sees the guest car');
        assert.equal(g.remote.car, h.local.car, 'guest sees the host car');
        assert.ok(h.chat.messages.some((m) => !m.local && m.text === 'bhi/b from the guest'), `host chat: ${JSON.stringify(h.chat.messages)}`);
        assert.ok(g.chat.messages.some((m) => !m.local && m.text === 'hello from the host'), 'guest received host chat');
        assert.equal(h.canStart, false, 'host cannot start before the guest is ready');
        g.setReady(true);
        stage = 'ready'; stageAt = frame;
      }
      break;
    case 'ready':
      if (h.canStart) {
        assert.ok(g.localReady);
        // Changing the rules makes the guest ready again; check that, then restore.
        h.setRules({ collisions: false });
        if (frame - stageAt > 600) throw new Error('guest ready did not reach host');
      }
      if (frame - stageAt > 20 && !h.canStart && !g.localReady) {
        log('rule change cleared Ready on both sides');
        h.setRules({ collisions: true });
        stage = 'ready1b'; stageAt = frame;
      }
      break;
    case 'ready1b':
      // Ready only counts against the settings the guest has seen: press it once the new revision arrived.
      if (frame - stageAt === 30) { assert.equal(g.rules.collisions, true); g.setReady(true); stage = 'ready2'; stageAt = frame; }
      break;
    case 'ready2':
      if (h.canStart) { log('host starts the race'); assert.ok(h.start()); stage = 'race'; stageAt = frame; ++raceNumber; }
      else if (frame - stageAt > 600) throw new Error('could not become ready');
      break;
    case 'race':
      if (h.state === 'closed' || g.state === 'closed') throw new Error(`session closed during race: ${h.error} / ${g.error}`);
      if (both('results')) { log('both on the result screen:', h.result.text, '/', g.result.text, JSON.stringify(h.result.ticks)); stage = 'results'; stageAt = frame; resultTick = 0; }
      else if (frame - stageAt > 30000) throw new Error('race did not finish');
      break;
    case 'results': {
      // Press confirm every 25 frames; at the last page choose "continue" (direction -1).
      const tick = frame - stageAt;
      for (const s of [h, g]) {
        const confirm = tick % 25 === 12;
        s.resultFrame({ confirm, direction: s.resultPage === 2 ? -1 : 0 });
      }
      if (both('lobby')) {
        log('both back in the lobby');
        stage = 'checks'; stageAt = frame;
      } else if (tick > 1500) throw new Error(`result screen did not complete: ${h.state}/${g.state} pages ${h.resultPage}/${g.resultPage}`);
      break;
    }
    case 'checks': {
      const hr = stores.host.read(h.local.car), gr = stores.guest.read(g.local.car);
      log('host record', JSON.stringify(hr), 'guest record', JSON.stringify(gr));
      checkFirstRace();
      if (!opt.second) return 'done';
      // Second race: both press ready again (the lobby reset it), the host starts, and this one times out.
      stage = 'again'; stageAt = frame;
      break;
    }
    case 'again':
      if (frame - stageAt === 30) g.setReady(true);
      if (frame - stageAt > 30 && h.canStart) { log('second race starts'); assert.ok(h.start()); ++raceNumber; stage = 'race2'; stageAt = frame; }
      else if (frame - stageAt > 600) throw new Error('could not become ready for the second race');
      break;
    case 'race2':
      if (both('results')) { log('second race over:', h.result.text, '/', g.result.text); assert.equal(h.result.text, 'TIME UP'); stage = 'decline'; stageAt = frame; }
      else if (frame - stageAt > 12000) throw new Error('second race did not time out');
      break;
    case 'decline': {
      // The guest walks the result pages and declines (cancel on the last page); the host is told and then leaves too.
      const tick = frame - stageAt;
      if (g.state === 'results') g.resultFrame({ confirm: g.resultPage < 2 && tick % 25 === 12, cancel: g.resultPage === 2 && tick % 25 === 12, direction: g.resultPage === 2 ? 1 : 0 });
      if (h.state === 'results') h.resultFrame({ confirm: h.resultPage < 2 && tick % 25 === 12, direction: 0 });
      if (g.state === 'closed' && h.peerLeft) {
        log('guest declined; host knows:', h.status);
        assert.equal(h.state, 'results');
        h.resultFrame({ confirm: true, direction: -1 }); h.resultFrame({ confirm: false, direction: -1 });
        stage = 'host-out'; stageAt = frame;
      } else if (tick > 3000) throw new Error(`decline did not complete: ${h.state}/${g.state} page ${h.resultPage}/${g.resultPage}`);
      break;
    }
    case 'host-out': {
      const tick = frame - stageAt;
      if (h.state === 'results') h.resultFrame({ confirm: tick % 25 === 12, direction: -1 });
      if (h.state === 'closed') { log('host closed:', h.status); return 'declined'; }
      if (tick > 1500) throw new Error(`host stayed in ${h.state}`);
      break;
    }
  }
  return null;
}

function checkFirstRace() {
  const h = host.session, g = guest.session;
// Results are identical on both sides and recorded once on each.
assert.equal(h.result.winner, g.result.winner);
assert.equal(h.result.ticks.host, g.result.ticks.host);
const winnerIsHost = h.result.winner === 0;
const hr = stores.host.read(h.local.car), gr = stores.guest.read(g.local.car);
assert.equal(hr.battles, 1); assert.equal(gr.battles, 1);
assert.equal(hr.wins, winnerIsHost ? 1 : 0); assert.equal(gr.wins, winnerIsHost ? 0 : 1);
assert.equal(h.view().history.length, 1); assert.equal(g.view().history.length, 1);
assert.equal(h.view().history[0].result, winnerIsHost ? 'YOU WIN' : 'YOU LOSE');
log(`race 1: winner ${winnerIsHost ? 'host' : 'guest'}, ticks ${JSON.stringify(h.result?.ticks)}; ` +
  `packets sent ${link.stats.sent} (${link.stats.reliable} reliable, ${link.stats.dropped} dropped), recoveries host ${h.recoveries} guest ${g.recoveries}`);

}
const t0 = Date.now();
let done = null;
while (!done) {
  done = script();
  if (!done) frameStep();
  if (frame > 60000) throw new Error('test did not finish');
}
const h = host.session, g = guest.session;

if (done === 'declined') {
  assert.equal(stores.host.history().length, 2); assert.equal(stores.guest.history().length, 2);
  assert.equal(stores.host.history()[1].result, 'TIME UP');
  assert.match(h.status, /left/);
} else {
  // Leave from the lobby: the other side is told and ends.
  g.leave();
  for (let i = 0; i < 30 && h.state !== 'closed'; ++i) frameStep();
  assert.equal(g.state, 'closed'); assert.equal(h.state, 'closed', 'host notices the guest leaving');
  assert.match(h.status, /left/);
}
console.log(`OK (${((Date.now() - t0) / 1000).toFixed(0)} s wall, ${frame} frames)`);
process.exit(0);
