// Runs the whole game off the main thread: the wasm core, the WebGL2 renderer (on an OffscreenCanvas)
// and the lazy data files. Keeping them together means a frame (up to ~11 MB of vertices) never has to
// cross a thread boundary, and the core's blocking file reads may use synchronous HTTP Range requests.
//
// main -> worker
//   {type:'start', canvas, canvasWidth, canvasHeight, manifestUrl, dataBase, width, height, quality, memoryBudget}
//   {type:'input', keys:Uint32Array(8), padConnected, padButtons, thumbLX, thumbLY, thumbRX, thumbRY,
//                  leftTrigger, rightTrigger, gear}      (latest state; sent on change)
//   {type:'resize', width, height, canvasWidth, canvasHeight}   core render size / canvas backing store, in pixels
//   {type:'audio-port', port}   PCM goes straight to the AudioWorklet over this port
//   {type:'focus', focused}   {type:'save'}   {type:'listSaves'}   {type:'accessLog'}   {type:'stop'}
//   {type:'blocked', blocked}   controls ignored by the core while a page overlay (the versus lobby) is up
//   online play (the connection itself lives on the main thread, see mp-link.js):
//   {type:'mp-open', role:'host'|'guest', name, buildId}   {type:'mp-link', state, detail}   {type:'mp-data', data}
//   {type:'mp-do', action, value}   {type:'mp-pointer', u, v, click}   {type:'mp-close'}
// worker -> main
//   {type:'phase', text, progress?}  {type:'ready'}  {type:'stats', ...}  {type:'error', message}
//   {type:'accessLog', paths}
//   {type:'mp-send', data, reliable}   {type:'mp-view', view}   {type:'mp-ended', reason}

import IdasCore from './idas_core.js';
import { Core, newInput, PAD } from './abi.js';
import { MpCore } from './mp-core.js';
import { MpSession } from './mp-session.js';
import { RecordStore } from './mp-records.js';
import { Renderer } from './renderer.js';
import { RangeFiles } from './rangefs.js';

const ASSET_ROOT = '/idas';
const SAVE_ROOT = '/saves';

let core = null, renderer = null, files = null, mod = null, offscreen = null, audioPort = null;
let running = false, loopHandle = 0;
const input = newInput();
let resizeRequest = null;
// A press shorter than one step (slow device, quick tap) must still be seen once: presses are latched
// until the next step consumes them.
const latchKeys = new Uint32Array(8);
let latchPad = 0;

const post = (message, transfer) => self.postMessage(message, transfer);
const schedule = (fn) => (self.requestAnimationFrame ? self.requestAnimationFrame(fn) : setTimeout(() => fn(performance.now()), 1000 / 60));

async function start(msg) {
  try {
    post({ type: 'phase', text: 'Loading game data index…' });
    const manifest = await (await fetch(msg.manifestUrl)).json();
    if (manifest.version !== 1) throw new Error('unsupported manifest version ' + manifest.version);

    // Download the known start-up set first: parallel whole-file requests (compressible, HTTP-cached).
    // Anything not listed still works, one blocking range request at a time.
    const prefetchSets = manifest.prefetch ?? {};
    post({ type: 'phase', text: 'Starting engine…' });
    mod = await IdasCore({
      print: (t) => console.log('[core]', t),
      printErr: (t) => console.warn('[core]', t),
    });
    const FS = mod.FS;

    // Game data: lazily fetched, read-only.
    files = new RangeFiles(FS, { base: msg.dataBase, budget: msg.memoryBudget ?? 384 * 1024 * 1024 });
    files.mount(ASSET_ROOT, manifest.files);

    // Saves and settings persist in IndexedDB.
    if (prefetchSets.boot?.length) {
      const total = prefetchSets.boot.reduce((n, p) => n + (manifest.files[p] ?? 0), 0);
      await files.prefetch(prefetchSets.boot, {
        onProgress: (done) => post({ type: 'phase', text: `Downloading game data… ${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`, progress: done / total }),
      });
    }
    FS.mkdirTree(SAVE_ROOT);
    FS.mount(FS.filesystems.IDBFS, {}, SAVE_ROOT);
    await new Promise((resolve, reject) => FS.syncfs(true, (e) => (e ? reject(e) : resolve())));

    offscreen = msg.canvas;
    offscreen.width = msg.canvasWidth; offscreen.height = msg.canvasHeight;
    renderer = new Renderer(offscreen, { preserveDrawingBuffer: !!msg.preserveDrawingBuffer, maxAnisotropy: msg.quality?.anisotropy ?? 4 });
    core = new Core(mod);
    post({ type: 'phase', text: 'Loading the game…' });
    core.initialize(ASSET_ROOT, SAVE_ROOT, msg.width, msg.height);
    renderSize = [msg.width, msg.height];
    core.enableAudio();
    running = true;
    post({ type: 'ready' });
    // While the title and attract screens run, fetch what the menus and the first race will read.
    if (prefetchSets.menus?.length) files.prefetch(prefetchSets.menus, { concurrency: 3 }).catch((e) => console.warn('background prefetch failed', e));
    lastStep = performance.now();
    loopHandle = schedule(frame);
  } catch (e) {
    post({ type: 'error', message: String(e && e.stack || e) });
  }
}

// ---- online play ------------------------------------------------------------------------------------
let renderSize = [640, 480];
let mpCore = null, mpSession = null, mpStore = null, mpDirty = false, mpViewAt = 0;
const mpPrev = { confirm: false, cancel: false };
const RECORDS_DIR = `${SAVE_ROOT}/web-online`, RECORDS_FILE = `${RECORDS_DIR}/records.json`;
const mpClock = () => performance.now() / 1000;

function mpStorage() {
  const FS = mod.FS;
  FS.mkdirTree(RECORDS_DIR);
  return {
    load() { try { return FS.readFile(RECORDS_FILE, { encoding: 'utf8' }); } catch { return null; } },
    save(text) { FS.writeFile(RECORDS_FILE, text); FS.syncfs(false, () => {}); },
  };
}
function mpOpen(msg) {
  if (!core || !running) { post({ type: 'mp-ended', reason: 'The game is still loading.' }); return; }
  if (mpSession?.alive) { post({ type: 'mp-ended', reason: 'An online session is already open.' }); return; }
  if ((core.status().flags & 3) === 0) { post({ type: 'mp-ended', reason: 'Leave the current race first.' }); return; }
  try {
    mpCore ??= new MpCore(mod, core);
    mpStore ??= new RecordStore(mpStorage());
    mpSession = new MpSession({
      mp: mpCore, role: msg.role, name: msg.name, buildId: msg.buildId, store: mpStore, now: mpClock,
      send: (data, reliable) => (typeof data === 'string' ? post({ type: 'mp-send', data, reliable }) : post({ type: 'mp-send', data, reliable }, [data.buffer])),
      onChange: () => { mpDirty = true; },
    });
    mpDirty = true;
  } catch (e) {
    mpSession = null;
    post({ type: 'mp-ended', reason: `Online play could not start: ${e.message}` });
  }
}
/** Run a session call; a failure ends the online session, never the game. */
function mpGuard(fn) {
  if (!mpSession) return;
  try { fn(mpSession); } catch (e) { console.warn('[online]', e); mpSession?.fail(`Online play stopped: ${e.message}`, { race: true }); }
}
const held = (vk) => ((input.keys[vk >> 5] >>> (vk & 31)) & 1) === 1;
/** Result-screen controls from the current keys/pad: confirm and cancel on press, direction while held. */
function mpResultControls() {
  const pad = input.padButtons;
  const confirm = held(13) || held(32) || (pad & PAD.A) !== 0;
  const cancel = held(27) || held(8) || (pad & PAD.B) !== 0;
  const left = held(37) || held(38) || (pad & (PAD.LEFT | PAD.UP)) !== 0 || input.thumbLX < -16000 || input.thumbLY > 16000;
  const right = held(39) || held(40) || (pad & (PAD.RIGHT | PAD.DOWN)) !== 0 || input.thumbLX > 16000 || input.thumbLY < -16000;
  const out = { confirm: confirm && !mpPrev.confirm, cancel: cancel && !mpPrev.cancel && !confirm, direction: left ? -1 : right ? 1 : 0, blocked: input.controlsBlocked };
  mpPrev.confirm = confirm; mpPrev.cancel = cancel;
  return out;
}
function mpPublish(now) {
  if (!mpSession) return;
  if (mpDirty && now - mpViewAt > 80) {
    mpDirty = false; mpViewAt = now;
    post({ type: 'mp-view', view: mpSession.view() });
  }
  if (!mpSession.alive) {
    const reason = mpSession.status;
    post({ type: 'mp-view', view: mpSession.view() });
    post({ type: 'mp-ended', reason });
    mpSession = null;
  }
}
function mpStats() {
  if (!mpSession) return null;
  const out = { state: mpSession.state, ping: mpSession.ping, race: mpSession.race?.hex ?? null, received: mpSession.received ?? 0, recoveries: mpSession.recoveries };
  if (mpSession.race?.native) { try { Object.assign(out, mpCore.status()); out.hostFinishTicks = String(out.hostFinishTicks); out.clientFinishTicks = String(out.clientFinishTicks); } catch { /* between races */ } }
  if (mpSession.result) out.result = { winner: mpSession.result.winner, text: mpSession.result.text, ticks: mpSession.result.ticks };
  return out;
}

let lastStep = 0, lastSync = 0, lastDriving = null;
const perf = { frames: 0, step: 0, render: 0, windowStart: 0, draws: 0 };

function frame(now) {
  if (!running) return;
  loopHandle = schedule(frame);
  const elapsed = (now - lastStep) / 1000;
  if (elapsed < 1 / 60 - 0.002) return;                 // cap at 60 steps/s on faster displays
  lastStep = now;
  try {
    input.deltaSeconds = Math.min(elapsed, 0.1);       // the core rejects deltas above 0.25 s
    const heldKeys = input.keys.slice(), heldPad = input.padButtons;
    for (let i = 0; i < 8; ++i) input.keys[i] |= latchKeys[i];
    input.padButtons |= latchPad;
    latchKeys.fill(0); latchPad = 0;
    if (resizeRequest) { input.width = resizeRequest.width; input.height = resizeRequest.height; resizeRequest = null; }
    else { input.width = 0; input.height = 0; }
    if (mpSession) {
      mpGuard((m) => { m.beforeFrame(); if (m.state === 'results') m.resultFrame(mpResultControls()); });
    }
    const t0 = performance.now();
    core.step(input);
    input.keys.set(heldKeys); input.padButtons = heldPad;
    if (mpSession) { mpGuard((m) => m.afterFrame()); mpPublish(now); }
    const t1 = performance.now();
    const pcm = core.readAudio();
    if (pcm && audioPort) audioPort.postMessage(pcm, [pcm.buffer]);
    const f = core.frame();
    renderer.render(f, core.ui());
    renderer.present();
    const t2 = performance.now();
    {   // layout hint for the touch controls: driving unless a menu or the pause panel is up
      const flags = core.status().flags, driving = (flags & 3) === 0;
      if (driving !== lastDriving) { lastDriving = driving; post({ type: 'mode', driving, flags }); }
    }
    perf.frames++; perf.step += t1 - t0; perf.render += t2 - t1; perf.draws = renderer.stats.draws; perf.gfx = renderer.stats;
    if (now - perf.windowStart >= 1000) {
      const status = core.status();
      post({
        type: 'stats', fps: perf.frames * 1000 / (now - perf.windowStart), stepMs: perf.step / perf.frames,
        renderMs: perf.render / perf.frames, draws: perf.draws, frameSize: [f.width, f.height],
        gfx: { ...perf.gfx, cachedGeometry: renderer.geometry.size, slabs: renderer.slabs.length },
        status, files: { ...files.stats, cachedMB: files.used / 1048576 }, heapMB: mod.HEAPU8.length / 1048576,
        mp: mpStats(),
      });
      perf.frames = perf.step = perf.render = 0; perf.windowStart = now;
    }
    if (now - lastSync > 10000) { lastSync = now; mod.FS.syncfs(false, () => {}); }
  } catch (e) {
    running = false;
    post({ type: 'error', message: String(e && e.stack || e) });
  }
}

/** [{path, size}] of every file under dir (diagnostics, and a future 'manage saves' screen). */
function listTree(dir) {
  const FS = mod.FS, out = [];
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const path = `${dir}/${name}`, st = FS.stat(path);
    if (FS.isDir(st.mode)) out.push(...listTree(path)); else out.push({ path, size: st.size });
  }
  return out;
}

self.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'start': start(msg); break;
    case 'input':
      for (let i = 0; i < 8; ++i) latchKeys[i] |= msg.keys[i] & ~input.keys[i];     // newly pressed since last message
      latchPad |= msg.padButtons & ~input.padButtons;
      input.keys.set(msg.keys);
      input.padConnected = msg.padConnected; input.padButtons = msg.padButtons;
      input.thumbLX = msg.thumbLX; input.thumbLY = msg.thumbLY; input.thumbRX = msg.thumbRX; input.thumbRY = msg.thumbRY;
      input.leftTrigger = msg.leftTrigger; input.rightTrigger = msg.rightTrigger; input.gear = msg.gear ?? 0;
      break;
    case 'resize':
      resizeRequest = { width: msg.width, height: msg.height };
      renderSize = [msg.width, msg.height];
      if (offscreen) { offscreen.width = msg.canvasWidth; offscreen.height = msg.canvasHeight; }
      break;
    case 'audio-port': audioPort = msg.port; break;
    case 'focus': input.focused = !!msg.focused; break;
    case 'blocked': input.controlsBlocked = !!msg.blocked; break;
    case 'mp-open': mpOpen(msg); break;
    case 'mp-link':
      if (mpSession) mpGuard((m) => { if (msg.state === 'open') m.linkOpened(); else if (msg.state === 'failed' || msg.state === 'closed') m.linkClosed(msg.detail || undefined); });
      mpDirty = true;
      break;
    case 'mp-data': mpGuard((m) => m.receive(msg.data)); break;
    case 'mp-do':
      mpGuard((m) => {
        switch (msg.action) {
          case 'selectCar': m.selectCar(msg.value); break;
          case 'automatic': m.setAutomatic(!!msg.value); break;
          case 'rules': m.setRules(msg.value); break;
          case 'ready': m.setReady(!!msg.value); break;
          case 'start': m.start(); break;
          case 'say': m.say(String(msg.value ?? '')); break;
          case 'return': m.requestReturn(); break;
          case 'leave': m.leave(); break;
        }
      });
      mpDirty = true;
      break;
    case 'mp-pointer':
      mpGuard((m) => {
        // The canvas shows the render target letterboxed; the result art lives in a centred 640x480 square scaled to fit.
        const [w, h] = renderSize;
        const fit = Math.min(w / 640, h / 480);
        m.pointer((msg.u * w - (w - 640 * fit) / 2) / fit, (msg.v * h - (h - 480 * fit) / 2) / fit, !!msg.click);
      });
      break;
    case 'mp-records':
      try { mpStore ??= new RecordStore(mpStorage()); post({ type: 'mp-records', ...mpStore.summary() }); } catch (e) { console.warn('[online] records', e); }
      break;
    case 'mp-close': mpGuard((m) => m.leave()); mpPublish(performance.now()); break;
    case 'save': mod?.FS.syncfs(false, () => {}); break;
    case 'listSaves': post({ type: 'saves', files: mod ? listTree(SAVE_ROOT) : [] }); break;
    case 'accessLog': post({ type: 'accessLog', paths: files ? files.accessLog.slice() : [] }); break;
    case 'stop': running = false; core?.shutdown(); mod?.FS.syncfs(false, () => {}); break;
  }
};
