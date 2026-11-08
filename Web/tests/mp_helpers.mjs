// Shared by the Node multiplayer tests: loads game cores, drives them with the core's scripted driver and
// connects two sessions through an in-memory link with latency, loss and reordering-free delivery.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core, newInput, setKey } from '../www/abi.js';
import { MpCore } from '../www/mp-core.js';

export async function loadModuleFactory(coreDir) {
  return (await import(pathToFileURL(path.join(coreDir, 'idas_core_node.mjs')).href)).default;
}

/** A game core with its own memory, save folder (named `userdata` with the marker files the scripted driver needs). */
export async function makeCore(IdasCore, assetRoot, name, { width = 320, height = 240 } = {}) {
  const mod = await IdasCore({ print: () => {}, printErr: () => {} });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `idas-mp-${name}-`));
  fs.writeFileSync(path.join(home, 'ISOLATED_MULTIPLAYER_TEST.txt'), 'test fixture\n');
  fs.writeFileSync(path.join(home, 'ISOLATED_SCORED_RACE_TEST.txt'), 'test fixture\n');
  const saves = path.join(home, 'userdata');
  fs.mkdirSync(saves);
  const core = new Core(mod);
  core.initialize(assetRoot, saves, width, height);
  core.enableAudio();
  return { name, mod, core, mp: new MpCore(mod, core), input: newInput(), saves, scored: mod._malloc(24) };
}

/** Press the controls the core's scripted driver asks for (only while a race is live). */
export function driveWithBot(p) {
  const m = p.mod;
  if (m._Idas3MultiplayerScoredDiagnosticControls(p.scored, 6) !== 1) return false;
  const f = new Float32Array(m.HEAPU8.buffer, p.scored, 6);
  p.input.padConnected = true;
  p.input.thumbLX = Math.round(Math.max(-1, Math.min(1, f[0])) * 32767);
  p.input.rightTrigger = Math.round(Math.max(0, Math.min(1, f[1])) * 255);
  p.input.leftTrigger = Math.round(Math.max(0, Math.min(1, f[2])) * 255);
  return true;
}
export function releaseControls(p) {
  p.input.padConnected = false; p.input.thumbLX = 0; p.input.rightTrigger = 0; p.input.leftTrigger = 0;
  p.input.keys.fill(0);
}

/** Two-way in-memory link. `clock()` is shared virtual time in seconds; delay is in seconds. */
export function makeLink(clock, { delay = 0, loss = 0, seed = 1 } = {}) {
  let rng = seed >>> 0 || 1;
  const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; };
  const queues = { a: [], b: [] };           // messages waiting for a / for b
  const stats = { sent: 0, dropped: 0, delivered: 0, reliable: 0, bytes: 0 };
  const end = (me, other) => ({
    send(message, reliable) {
      ++stats.sent; if (reliable) ++stats.reliable;
      stats.bytes += typeof message === 'string' ? message.length : message.length;
      if (!reliable && random() < loss) { ++stats.dropped; return; }
      // Reliable messages keep their order; copy binary data like a real channel does.
      const data = typeof message === 'string' ? message : message.slice().buffer;
      const owned = typeof message === 'string' ? message : data;
      queues[other].push({ at: clock() + delay, data: owned });
    },
    pump(session) {
      const q = queues[me];
      while (q.length && q[0].at <= clock()) { const m = q.shift(); ++stats.delivered; session.receive(m.data); }
    },
  });
  return { a: end('a', 'b'), b: end('b', 'a'), stats };
}
