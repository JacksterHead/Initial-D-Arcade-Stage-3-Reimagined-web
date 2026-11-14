// The one-link flow in two real browser instances against a local ntfy-compatible relay (Web/tools/signal-relay.mjs):
// the host gets a link, the guest opens it, and both reach the lobby without anybody copying a reply code.
//   node mp_link_browser_test.cjs <dist dir> <Native dir> <manifest.json> <out dir>
// Covers: a guest opening the link in a fresh tab; a guest pasting it into a tab that is already up (hashchange);
// a cancelled invitation; an unknown link; a second guest arriving after the seat is taken (relay stream only,
// the third player is simulated with a raw POST); the relay going away (clear message, pairing codes still work);
// and ?signal=off. It cannot test the public ntfy.sh (not reachable from the sandbox): that service only has to behave
// like the relay's documented subset (POST body, SSE stream with since=all, CORS).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), assert = require('assert');
const [dist, native, manifest, outDir] = process.argv.slice(2);
if (!outDir) { console.error('usage: mp_link_browser_test.cjs dist native manifest outDir'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const port = 20000 + Math.floor(Math.random() * 20000), relayPort = port + 1;
const server = spawn('node', [path.join(__dirname, '../tools/serve.mjs'), '--www', dist, '--data', native, '--manifest', manifest, '--port', String(port)], { stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const RELAY = `http://127.0.0.1:${relayPort}`;
const EXTRA = `stats=1&maxlong=${process.env.MP_MAXLONG ?? 256}`;

async function open(browser, name, url) {
  const [vw, vh] = (process.env.MP_VIEWPORT ?? '960x540').split('x').map(Number);
  const touch = !!process.env.MP_TOUCH;                         // MP_VIEWPORT=844x390 MP_TOUCH=1 emulates a phone in landscape
  const context = await browser.newContext({ viewport: { width: vw, height: vh }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
  const page = await context.newPage();
  page.on('console', (m) => { const t = m.text(); if (/\[online\]|rror/.test(t)) console.log(`[${name}]`, t.slice(0, 300)); });
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('**/romgate.js', (route) => route.fulfill({ contentType: 'text/javascript',
    body: 'export async function validateDisc(){ return { verified: true, message: "test stub", format: "stub" }; }' }));
  await page.goto(url);
  await page.setInputFiles('#files', { name: 'stub.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
  return page;
}
const ready = (page) => page.evaluate(() => window.__ready || window.__error);
const view = (page) => page.evaluate(() => window.__versus ?? null);
async function until(what, fn, timeout = 60000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
const text = (page, sel) => page.textContent(sel).then((t) => t ?? '');
/** Panel open on its start screen, whatever it showed before. */
async function home(page) {
  if (!(await page.isVisible('#versus'))) await page.click('#vsButton');
  for (let i = 0; i < 3 && !(await page.isVisible('#vsHost')); ++i) {
    if (await page.isVisible('#vsEndedOk')) await page.click('#vsEndedOk');
    else if (await page.isVisible('#vsHostCancel')) await page.click('#vsHostCancel');
    else if (await page.isVisible('#vsJoinCancel')) await page.click('#vsJoinCancel');
    await sleep(150);
  }
  await until('start screen', () => page.isVisible('#vsHost'), 5000);
}
async function joinScreen(page) { await home(page); await page.click('#vsJoin'); await until('join screen', () => page.isVisible('#vsJoinGo'), 5000); }
async function hostLink(page, name) {
  await home(page);
  await page.fill('#vsName', name);
  await page.click('#vsHost');
  const link = await until('invitation link', async () => (await page.inputValue('#vsInvite')) || null, 20000);
  assert.match(link, /#join=[0-9a-z]{26}$/, 'link shape');
  assert.ok(link.includes(`signal=${encodeURIComponent(RELAY)}`) || link.includes(`signal=${RELAY}`), `the link keeps the mailbox: ${link}`);
  assert.ok(!(await page.inputValue('#vsReply')), 'no reply code is needed');
  return link;
}
const joinStatus = (page) => text(page, '#vsJoinStatus');

(async () => {
  const relayModule = await import(path.join(__dirname, '../tools/signal-relay.mjs'));
  const relay = relayModule.createRelay();
  await new Promise((r) => relay.server.listen(relayPort, '127.0.0.1', r));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const base = `http://127.0.0.1:${port}/`;
  const host = await open(browser, 'host', `${base}?${EXTRA}&signal=${encodeURIComponent(RELAY)}`);
  await until('host game ready', () => ready(host), 280000);
  assert.ok(!(await host.evaluate(() => window.__error)), 'host game failed to start');
  log('host ready');
  await sleep(1000);

  // ---- 1. a guest opens the link in a fresh tab ---------------------------------------------------------
  const link1 = await hostLink(host, 'Takumi');
  log('link', link1.replace(/join=.*/, 'join=…'));
  await host.screenshot({ path: path.join(outDir, 'link-host.png') });
  const u = new URL(link1);
  for (const [k, v] of new URLSearchParams(EXTRA)) u.searchParams.set(k, v);
  let guest = await open(browser, 'guest', u.href);
  await until('guest game ready', () => ready(guest), 280000);
  assert.ok(!(await guest.evaluate(() => window.__error)), 'guest game failed to start');
  // The invitation opens the join screen by itself, with the link filled in and the address bar cleaned up.
  await until('join screen', () => guest.isVisible('#vsJoinGo'), 20000);
  assert.match(await guest.inputValue('#vsHostIn'), /#join=[0-9a-z]{26}$/);
  assert.ok(!/join=/.test(await guest.evaluate(() => location.href)), 'the address bar no longer carries the invitation');
  await guest.screenshot({ path: path.join(outDir, 'link-guest-invited.png') });
  await guest.fill('#vsJoinName', 'Ryosuke');
  await guest.click('#vsJoinGo');
  await until('both in the lobby', async () => (await view(host))?.state === 'lobby' && (await view(guest))?.state === 'lobby', 60000);
  assert.equal((await view(host)).remoteName, 'Ryosuke'); assert.equal((await view(guest)).remoteName, 'Takumi');
  assert.ok(!(await host.inputValue('#vsReply')), 'the host never had to paste a reply');
  log('1. fresh tab: lobby reached from one link');
  await host.fill('#vsSay', 'hi from the link'); await host.press('#vsSay', 'Enter');
  await until('chat over the link-made connection', async () => /hi from the link/.test(await text(guest, '#vsChat')), 10000);
  await guest.screenshot({ path: path.join(outDir, 'link-lobby-guest.png') });
  // The mailbox holds only pairing messages.
  const topics = [...relay.topics.entries()];
  assert.equal(topics.length, 1);
  const kinds = topics[0][1].messages.map((m) => JSON.parse(m.message).k);
  assert.deepEqual(kinds, ['offer', 'answer', 'taken'], `mailbox saw ${kinds}`);
  await guest.click('#vsLeave');
  await until('session over on both', async () => !(await view(host)) && !(await view(guest)), 30000);

  // ---- 2. a guest pastes the link into a tab that is already up ------------------------------------------
  const link2 = await hostLink(host, 'Takumi');
  assert.notEqual(link1, link2, 'a new invitation each time');
  await home(guest);
  await guest.evaluate((h) => { location.hash = h; }, new URL(link2).hash);
  await until('join screen from hashchange', async () => guest.isVisible('#vsJoinGo'), 5000);
  await guest.click('#vsJoinGo');
  await until('lobby again', async () => (await view(host))?.state === 'lobby' && (await view(guest))?.state === 'lobby', 60000);
  log('2. open tab: lobby reached through the hash');
  await guest.click('#vsLeave');
  await until('session over again', async () => !(await view(host)) && !(await view(guest)), 30000);

  // ---- 3. a cancelled invitation and an unknown one -------------------------------------------------------
  const link3 = await hostLink(host, 'Takumi');
  await host.click('#vsHostCancel');
  await sleep(1200);                                            // the worker's echo of the cancel must not replace the start screen
  assert.ok(await host.isVisible('#vsHost'), 'after Cancel the host is back at the start screen');
  await until('cancel reaches the mailbox', async () => [...relay.topics.values()].some((t) => t.messages.some((m) => /"bye"/.test(m.message))), 5000);
  await joinScreen(guest);
  await guest.fill('#vsHostIn', link3);
  await guest.click('#vsJoinGo');
  await until('cancelled message', async () => /cancelled/.test(await joinStatus(guest)), 15000);
  log('3a. cancelled invitation:', (await joinStatus(guest)).trim());
  const bogus = link3.replace(/join=.{26}/, 'join=' + 'a'.repeat(26));
  await guest.fill('#vsHostIn', bogus);
  await guest.click('#vsJoinGo');
  await until('missing message', async () => /No invitation found/.test(await joinStatus(guest)), 40000)
    .catch(async (e) => { console.log('status was:', JSON.stringify(await joinStatus(guest)), 'streams', relay.stats.streams); throw e; });
  log('3b. unknown link:', (await joinStatus(guest)).trim());
  assert.ok(!(await guest.isDisabled('#vsJoinGo')), 'the guest can try again');

  // ---- 4. the seat is already taken ------------------------------------------------------------------------
  const link4 = await hostLink(host, 'Takumi');
  const room4 = /join=([0-9a-z]{26})/.exec(link4)[1];
  await until('offer posted', async () => relay.topics.get(`idas3-${room4}`)?.messages.some((m) => /"offer"/.test(m.message)), 5000);
  await fetch(`${RELAY}/idas3-${room4}`, { method: 'POST', body: JSON.stringify({ k: 'taken', tag: 'SOMEONEELSE' }) });
  await joinScreen(guest);
  await guest.fill('#vsHostIn', link4);
  await guest.click('#vsJoinGo');
  await until('full message', async () => /already joined/.test(await joinStatus(guest)), 15000);
  log('4. taken seat:', (await joinStatus(guest)).trim());
  await host.click('#vsHostCancel');

  // ---- 5. the mailbox is gone: say so, and the pairing codes still work ----------------------------------------
  relay.close();
  await sleep(300);
  await home(host);
  await host.click('#vsHost');
  await until('host fallback message', async () => /could not be reached/.test(await text(host, '#vsHostStatus')), 20000);
  assert.ok(await host.$eval('#vsManualHost', (d) => d.open), 'the manual codes are opened for the host');
  assert.equal(await host.inputValue('#vsInvite'), '');
  const code = await until('host code', async () => (await host.inputValue('#vsHostCode')) || null, 10000);
  await host.screenshot({ path: path.join(outDir, 'link-fallback-host.png') });
  await joinScreen(guest);
  await guest.fill('#vsHostIn', link4);
  await guest.click('#vsJoinGo');
  await until('guest unreachable message', async () => /could not be reached/.test(await joinStatus(guest)), 20000);
  log('5a. relay down:', (await joinStatus(guest)).trim());
  await guest.fill('#vsHostIn', code);
  await guest.click('#vsJoinGo');
  const reply = await until('reply code', async () => (await guest.inputValue('#vsReplyOut')) || null, 20000);
  await host.fill('#vsReply', reply);
  await host.click('#vsConnect');
  await until('lobby through codes', async () => (await view(host))?.state === 'lobby' && (await view(guest))?.state === 'lobby', 60000);
  log('5b. codes still pair after the relay went away');
  await guest.click('#vsLeave');
  await until('session over once more', async () => !(await view(host)) && !(await view(guest)), 30000);

  // ---- 6. ?signal=off ----------------------------------------------------------------------------------------
  const off = await open(browser, 'off', `${base}?${EXTRA}&signal=off`);
  await until('off page ready', () => ready(off), 280000);
  await home(off);
  await off.click('#vsHost');
  await until('links off message', async () => /switched off/.test(await text(off, '#vsHostStatus')), 10000);
  assert.equal(await off.inputValue('#vsInvite'), '');
  assert.ok(await until('code', async () => (await off.inputValue('#vsHostCode')) || null, 10000));
  log('6. ?signal=off: codes only');

  log('OK');
  await browser.close(); server.kill();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); server.kill(); process.exit(1); });
