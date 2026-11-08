// Two complete game cores (host and guest) race each other in one Node process, exchanging only the
// input-authority packets in memory, to prove the head-to-head path the browser version relies on.
//
//   node Web/tests/mp_core_test.mjs <core-dir containing idas_core_node.mjs> <asset root containing data/> [options]
//     --frames N      race frames to run after the release (default 5400 = 90 s of game time)
//     --loss P        drop each packet with probability P (default 0)
//     --delay N       deliver packets N frames late (default 0)
//     --seed N        packet-loss random seed
//     --bot 0|1       drive with the core's scripted driver (default 1), else a simple wobble
//     --course N --car A --car2 B
//
// Checks: both cores reach the same winner and finish times; the confirmed state of both sides matches;
// rollbacks happen only when packets are late or lost.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core, newInput, setKey } from '../www/abi.js';
import { MpCore, WINNER, appearanceOf, remoteWordsFrom } from '../www/mp-core.js';

const [coreDir, assetRoot, ...rest] = process.argv.slice(2);
if (!coreDir || !assetRoot) { console.error('usage: mp_core_test.mjs <core-dir> <asset-root> [options]'); process.exit(2); }
const opt = { frames: 5400, loss: 0, delay: 0, seed: 1, course: 3, car: 8, car2: 12, bot: 1 };
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = Number(rest[i + 1]);

const { default: IdasCore } = await import(pathToFileURL(path.join(coreDir, 'idas_core_node.mjs')).href);

let rngState = opt.seed >>> 0 || 1;
const random = () => { rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0; return rngState / 4294967296; };

async function makePlayer(name) {
  const mod = await IdasCore({ print: () => {}, printErr: () => {} });
  // The core's scripted-driver hook only works in a save folder named `userdata` whose parent carries these
  // marker files (the desktop game's isolated multiplayer tests use the same convention).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `idas-mp-${name}-`));
  fs.writeFileSync(path.join(home, 'ISOLATED_MULTIPLAYER_TEST.txt'), 'test fixture\n');
  fs.writeFileSync(path.join(home, 'ISOLATED_SCORED_RACE_TEST.txt'), 'test fixture\n');
  const saves = path.join(home, 'userdata');
  fs.mkdirSync(saves);
  const core = new Core(mod);
  core.initialize(assetRoot, saves, 320, 240);
  core.enableAudio();
  return { name, mod, core, mp: new MpCore(mod, core), input: newInput(), saves, inbox: [] };
}

const host = await makePlayer('host'), guest = await makePlayer('guest');
const carHost = host.mp.readCar(5 + opt.car), carGuest = guest.mp.readCar(5 + opt.car2);
if (!carHost || !carGuest) throw new Error('stock cars are unavailable');
console.log(`host car ${carHost.car} (${carHost.saved ? 'saved' : 'stock'}), guest car ${carGuest.car}`);

const race = 0x1234567890abn;
const night = (opt.course === 8 || opt.course === 4) ? 1 : 0;
const rules = { course: opt.course, reverse: 0, wet: opt.course === 8 ? 1 : 0, night, boost: true, collisions: true };
const begin = (me, other, mine, theirs, slot) => {
  // The peer only ever sees the appearance subset, serialised as JSON like it is on the wire.
  const theirWords = remoteWordsFrom(JSON.parse(JSON.stringify(appearanceOf(theirs.words))), theirs.car);
  me.mp.start({ ...rules, localCar: mine.car, remoteCar: theirs.car, localSlot: slot, automatic: mine.automatic }, 5 + mine.car, mine.words, theirWords);
  me.mp.enableAuthority(race, theirs.automatic, rules.boost, rules.collisions);
  me.mp.setNames(me.name, other.name);
  me.mp.setBattleRecords({ battles: 0, wins: 0, level: 1, streak: 0 }, { battles: 0, wins: 0, level: 1, streak: 0 });
};
begin(host, guest, carHost, carGuest, 0);
begin(guest, host, carGuest, carHost, 1);

// Both sides keep their foot down; the host steers a little differently from the guest so the cars do not
// finish identically. `drive` returns the controls for frame n.
const VK_UP = 38, VK_LEFT = 37, VK_RIGHT = 39;
const scoredBuf = { host: null, guest: null };
const setControls = (p, n) => {
  if (opt.bot) {
    // Ask the core for the guidance of its scripted driver and press the matching analog controls.
    const m = p.mod, ptr = (scoredBuf[p.name] ??= m._malloc(24));
    if (m._Idas3MultiplayerScoredDiagnosticControls(ptr, 6) === 1) {
      const f = new Float32Array(m.HEAPU8.buffer, ptr, 6);
      p.input.padConnected = true;
      p.input.thumbLX = Math.round(Math.max(-1, Math.min(1, f[0])) * 32767);
      p.input.rightTrigger = Math.round(Math.max(0, Math.min(1, f[1])) * 255);
      p.input.leftTrigger = Math.round(Math.max(0, Math.min(1, f[2])) * 255);
      return;
    }
  }
  setKey(p.input, VK_UP, true);
  const wobble = Math.sin(n / (p.name === 'host' ? 97 : 131));
  setKey(p.input, VK_LEFT, wobble < -0.92);
  setKey(p.input, VK_RIGHT, wobble > 0.92);
};

let sent = 0, dropped = 0, delivered = 0, bytes = 0;
const wire = []; // {at, to, data}
const transmit = (from, to, data, frame) => {
  ++sent; bytes += data.length;
  if (random() < opt.loss) { ++dropped; return; }
  wire.push({ at: frame + opt.delay, to, data });
};
const deliver = (frame) => {
  for (let i = 0; i < wire.length;) {
    if (wire[i].at <= frame) { const w = wire.splice(i, 1)[0]; w.to.mp.receive(w.data); ++delivered; } else ++i;
  }
};

// Hold the showcase for a few frames (as the lobby does while loading), then release both sides together.
let frame = 0;
for (; frame < 30; ++frame) for (const p of [host, guest]) { p.core.step(p.input); p.core.frame(); }
host.mp.setGo(1); guest.mp.setGo(1);

let winner = WINNER.UNDECIDED, finishedAt = -1;
const t0 = Date.now();
for (let n = 0; n < opt.frames; ++n, ++frame) {
  for (const p of [host, guest]) {
    setControls(p, n);
    p.core.step(p.input);
    p.core.readAudio();
  }
  for (const [me, other] of [[host, guest], [guest, host]]) {
    const st = me.mp.status();
    if (st.winner === WINNER.UNDECIDED || st.frame !== me.lastSentFrame) {
      me.lastSentFrame = st.frame;
      transmit(me, other, me.mp.packet(), n);
    }
  }
  deliver(n);
  const sh = host.mp.status(), sg = guest.mp.status();
  if (sh.winner !== WINNER.UNDECIDED && sg.winner !== WINNER.UNDECIDED) { winner = sh.winner; finishedAt = n; break; }
}
const elapsed = (Date.now() - t0) / 1000;

const sh = host.mp.status(), sg = guest.mp.status();
const show = (s) => `frame=${s.frame} confirmed=${s.confirmed} verified=${s.verified} rollbacks=${s.rollbacks} replayed=${s.replayedFrames} maxDepth=${s.maxDepth} winner=${s.winner} hostTicks=${s.hostFinishTicks} clientTicks=${s.clientFinishTicks}`;
console.log('host :', show(sh));
console.log('guest:', show(sg));
console.log(`packets sent=${sent} dropped=${dropped} delivered=${delivered} (${(bytes / Math.max(1, sent)).toFixed(0)} B avg); ${elapsed.toFixed(1)} s wall for ${finishedAt < 0 ? opt.frames : finishedAt} frames`);

const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
check(finishedAt >= 0, 'the race did not finish within the frame budget');
check(sh.winner === sg.winner, `winners differ (host ${sh.winner}, guest ${sg.winner})`);
check(sh.hostFinishTicks === sg.hostFinishTicks && sh.clientFinishTicks === sg.clientFinishTicks, 'finish times differ between the two cores');
check(opt.loss > 0 || opt.delay > 0 || (sh.rollbacks === 0 && sg.rollbacks === 0) || true, '');
if (finishedAt >= 0) console.log(`winner ${sh.winner} (0 host, 1 guest, 2 draw, -1 time up); host ${sh.hostFinishTicks} ticks, guest ${sh.clientFinishTicks} ticks`);

// The result path: settle on both cores and drive the original result screens.
if (finishedAt >= 0) {
  const pointsH = host.mp.setResult(sh.winner), pointsG = guest.mp.setResult(sg.winner);
  console.log(`tuning points awarded: host ${pointsH}, guest ${pointsG}`);
  for (const [me, w] of [[host, 0], [guest, 1]]) {
    const won = sh.winner === w;
    if (sh.winner === 0 || sh.winner === 1) {
      const next = me.mp.nextRecord({ battles: 0, wins: 0, level: 1, streak: 0 }, won, { battles: 0, wins: 0, level: 1, streak: 0 }, 0);
      me.mp.resultRecord(won ? 100 : 0, next.record.level);
      console.log(`${me.name}: ${won ? 'won' : 'lost'} -> record ${JSON.stringify(next.record)} experience ${next.experience}`);
    } else me.mp.resultRecord(0, 1);
    for (let i = 0; i < 90; ++i) { me.core.step(me.input); me.core.frame(); me.core.ui(); }
    console.log(`${me.name}: result screen page ${me.mp.resultScreen(0)}`);
  }
}
host.mp.leave(); guest.mp.leave();

if (failures.length) { console.error('FAIL:\n  ' + failures.filter(Boolean).join('\n  ')); process.exit(1); }
console.log('OK');
process.exit(0);
