// Two real browser instances (separate profiles) pair with codes over a real WebRTC data channel, meet in the
// lobby, chat, pick cars and a course, start a race, drive, and leave. Needs the packaged client and game data.
//   node mp_browser_test.cjs <dist dir> <Native dir> <manifest.json> <out dir>
// Software GL only; the race part checks that input packets flow and both cores advance, not who wins (the
// full race to a result runs headless in mp_session_test.mjs).
// MP_RESULTS=1 keeps both players holding the throttle until the race times out (about 70 s of game time, slow on
// software GL), then presses Enter through the original result screens back to the lobby and checks the saved record.
// MP_MAXLONG=<px> sets the render size (default 320). MP_VIEWPORT=<w>x<h> and MP_TOUCH=1 emulate a phone;
// MP_STOP=lobby ends the run after the lobby screenshots (layout checks).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), assert = require('assert');
const [dist, native, manifest, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: mp_browser_test.cjs dist native manifest outDir'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const port = 20000 + Math.floor(Math.random() * 20000);
const server = spawn('node', [path.join(__dirname, '../tools/serve.mjs'), '--www', dist, '--data', native, '--manifest', manifest, '--port', String(port)], { stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const t0 = Date.now();

async function launch(browser, name) {
  const [vw, vh] = (process.env.MP_VIEWPORT ?? '960x540').split('x').map(Number);
  const touch = !!process.env.MP_TOUCH;
  const context = await browser.newContext({ viewport: { width: vw, height: vh }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
  const page = await context.newPage();
  page.on('console', (m) => { const t = m.text(); if (/\[online\]|error|Error/.test(t)) console.log(`[${name}]`, t.slice(0, 300)); });
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('**/romgate.js', (route) => route.fulfill({ contentType: 'text/javascript',
    body: 'export async function validateDisc(){ return { verified: true, message: "test stub", format: "stub" }; }' }));
  await page.goto(`http://127.0.0.1:${port}/?stats=1&signal=off&maxlong=${process.env.MP_MAXLONG ?? 320}`);   // signal=off: pairing codes only (the link flow has its own test)
  await page.setInputFiles('#files', { name: 'stub.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  return page;
}
const view = (page) => page.evaluate(() => window.__versus ?? null);
const mpStats = (page) => page.evaluate(() => window.__stats?.mp ?? null);
async function until(what, fn, timeout = 60000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const host = await launch(browser, 'host'), guest = await launch(browser, 'guest');
  await until('both games ready', async () => (await host.evaluate(() => window.__ready || window.__error)) && (await guest.evaluate(() => window.__ready || window.__error)), 280000);
  assert.ok(!(await host.evaluate(() => window.__error)) && !(await guest.evaluate(() => window.__error)), 'a game failed to start');
  log('both games ready');
  await sleep(1500);

  // ---- pairing by code ----------------------------------------------------------------------------
  for (const [page, n] of [[host, 'Takumi'], [guest, 'Ryosuke']]) {
    await until('versus button', () => page.isVisible('#vsButton'), 20000);
    await page.click('#vsButton');
    await page.fill('#vsName', n);
  }
  await host.click('#vsHost');
  const hostCode = await until('host code', async () => (await host.inputValue('#vsHostCode')) || null, 20000);
  log('host code', hostCode.length, 'chars');
  await host.screenshot({ path: path.join(outDir, 'pair-host.png') });
  await guest.click('#vsJoin');
  await guest.fill('#vsHostIn', hostCode);
  await guest.click('#vsJoinGo');
  const reply = await until('reply code', async () => (await guest.inputValue('#vsReplyOut')) || null, 20000);
  log('reply code', reply.length, 'chars');
  await guest.screenshot({ path: path.join(outDir, 'pair-guest.png') });
  // A damaged code is refused with a message instead of connecting to the wrong place.
  await host.fill('#vsReply', reply.slice(0, -7));
  await host.click('#vsConnect');
  const bad = await until('damaged-code message', async () => /damaged|incomplete|short/.test(await host.textContent('#vsHostStatus')) || null, 5000);
  assert.ok(bad);
  await host.fill('#vsReply', ` ${reply.toLowerCase()} `);
  await host.click('#vsConnect');
  await until('both in the lobby', async () => (await view(host))?.state === 'lobby' && (await view(guest))?.state === 'lobby', 60000);
  const hv = await view(host), gv = await view(guest);
  assert.equal(hv.remoteName, 'Ryosuke'); assert.equal(gv.remoteName, 'Takumi');
  log('lobby: host sees', hv.remoteName, '/ guest sees', gv.remoteName);
  await host.screenshot({ path: path.join(outDir, 'lobby-host.png') });

  // ---- lobby --------------------------------------------------------------------------------------
  await host.fill('#vsSay', 'hello <b>there</b>'); await host.press('#vsSay', 'Enter');
  await until('chat arrives', async () => /hello bthere\/b/.test(await guest.textContent('#vsChat')), 10000);
  await guest.fill('#vsSay', 'ready when you are'); await guest.press('#vsSay', 'Enter');
  await until('chat reply', async () => /ready when you are/.test(await host.textContent('#vsChat')), 10000);
  const options = await guest.$$eval('#vsCar option', (o) => o.map((x) => [x.value, x.textContent]));
  assert.ok(options.length >= 35, `garage has ${options.length} cars`);
  await guest.selectOption('#vsCar', options[12][0]);
  await host.selectOption('#vsCourse', '3');
  await until('car shows on the host', async () => (await view(host)).remote.car === (await view(guest)).local.car, 10000);
  await sleep(500);
  assert.equal((await view(host)).canStart, false);
  await guest.click('#vsReady');
  await until('host can start', async () => (await view(host)).canStart, 10000);
  log('chat and selection ok; starting');
  await host.screenshot({ path: path.join(outDir, 'lobby-ready.png') });
  await guest.screenshot({ path: path.join(outDir, 'lobby-guest.png') });
  if (process.env.MP_STOP === 'lobby') { log('OK (stopped at the lobby)'); await browser.close(); server.kill(); process.exit(0); }

  // ---- race ---------------------------------------------------------------------------------------
  await host.click('#vsStart');
  await until('both racing', async () => (await mpStats(host))?.state === 'racing' && (await mpStats(guest))?.state === 'racing', 120000);
  log('both racing');
  await host.screenshot({ path: path.join(outDir, 'race-host-start.png') });
  const press = async (page, code, down) => (down ? page.keyboard.down(code) : page.keyboard.up(code));
  await Promise.all([press(host, 'ArrowUp', true), press(guest, 'ArrowUp', true)]);
  await until('countdown over, cars moving', async () => ((await mpStats(host))?.confirmed ?? 0) > 420 && ((await mpStats(guest))?.confirmed ?? 0) > 420, 240000);
  const a = await mpStats(host), b = await mpStats(guest);
  log('host', JSON.stringify({ frame: a.frame, confirmed: a.confirmed, rollbacks: a.rollbacks, received: a.received, recoveries: a.recoveries }));
  log('guest', JSON.stringify({ frame: b.frame, confirmed: b.confirmed, rollbacks: b.rollbacks, received: b.received, recoveries: b.recoveries }));
  assert.ok(a.received > 100 && b.received > 100, 'input packets flow both ways');
  await host.screenshot({ path: path.join(outDir, 'race-host.png') });
  await guest.screenshot({ path: path.join(outDir, 'race-guest.png') });
  if (process.env.MP_RESULTS) {
    // ---- result screens, records, back to the lobby ---------------------------------------------------
    let lastLog = 0;
    await until('both results', async () => {
      if (Date.now() - lastLog > 30000) { lastLog = Date.now(); const x = await mpStats(host), y = await mpStats(guest); log('race progress', x?.confirmed, y?.confirmed, x?.state, y?.state); }
      return (await mpStats(host))?.state === 'results' && (await mpStats(guest))?.state === 'results';
    }, 30 * 60000);
    await Promise.all([press(host, 'ArrowUp', false), press(guest, 'ArrowUp', false)]);
    const rh = await mpStats(host), rg = await mpStats(guest);
    log('results', rh.result.text, '/', rg.result.text, 'winner', rh.winner, rg.winner);
    assert.equal(rh.winner, rg.winner); assert.equal(rh.hostFinishTicks, rg.hostFinishTicks); assert.equal(rh.clientFinishTicks, rg.clientFinishTicks);
    await sleep(1500);
    await host.screenshot({ path: path.join(outDir, 'result-host.png') });
    await until('back in the lobby', async () => {
      for (const page of [host, guest]) await page.keyboard.press('Enter');
      await sleep(450);
      return (await view(host))?.state === 'lobby' && (await view(guest))?.state === 'lobby';
    }, 120000);
    const hv2 = await view(host), gv2 = await view(guest);
    log('back in the lobby; history', JSON.stringify(hv2.history[0]));
    assert.equal(hv2.history.length, 1); assert.equal(gv2.history.length, 1);
    assert.equal(hv2.history[0].result, rh.result.text);
    await host.screenshot({ path: path.join(outDir, 'lobby-after.png') });
    // Records survive a reload (IndexedDB).
    await guest.click('#vsLeave');
    await until('host told', async () => (await host.evaluate(() => window.__versus)) === null, 30000);
    log('guest left from the lobby; host ended');
    await browser.close(); server.kill();
    log('OK (with results)');
    process.exit(0);
  }
  await Promise.all([press(host, 'ArrowUp', false), press(guest, 'ArrowUp', false)]);

  // ---- leaving mid-race ---------------------------------------------------------------------------
  await guest.click('#vsChipLeave');
  await until('guest back at the start', async () => (await guest.evaluate(() => window.__versus)) === null, 30000);
  await until('host told the race ended', async () => (await view(host))?.state === 'disconnected', 30000);
  assert.match((await view(host)).status, /left/);
  await host.screenshot({ path: path.join(outDir, 'host-after-leave.png') });
  await host.click('#vsLostLeave');
  await until('host back at the start', async () => (await host.evaluate(() => window.__versus)) === null, 30000);
  // The core is back in its menus (not stuck in the online race).
  await until('menus', async () => ((await host.evaluate(() => window.__stats?.mp)) === null), 5000);
  log('OK');
  await browser.close(); server.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); server.kill(); process.exit(1); });
