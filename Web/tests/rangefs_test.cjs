// RangeFiles against a data server on another origin: normal Range support and a host that ignores Range.
//   node rangefs_test.cjs <Native dir> <manifest.json>
// Reads three slices of one large file through the real read path (sync XHR in a module worker) and
// compares them with the file on disk; checks how many requests / bytes that took.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const [native, manifestPath] = process.argv.slice(2);
if (!manifestPath) { console.error('usage: rangefs_test.cjs <Native dir> <manifest.json>'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const [rel, size] = Object.entries(manifest.files).filter(([, s]) => s > 12e6 && s < 60e6).sort((a, b) => b[1] - a[1])[0];
const slices = [[0, 100000], [Math.floor(size / 2) - 5000, 70000], [size - 64000, 64000]];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const disk = fs.readFileSync(path.join(native, rel));
const expected = slices.map(([p, n]) => sha(disk.subarray(p, p + n)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORKER = `
import { RangeFiles } from '/rangefs.js';
const nodes = [];
const FS = { mkdirTree() {}, createFile() { const n = { stream_ops: {} }; nodes.push(n); return n; }, ErrnoError: class extends Error {} };
self.onmessage = async ({ data }) => {
  const files = new RangeFiles(FS, { base: data.base });
  files.mount('/idas', { [data.rel]: data.size });
  const read = (position, length) => {
    const heap = new Int8Array(length);
    const n = nodes[0].stream_ops.read(null, heap, 0, length, position);   // what the core's fread ends up calling
    return crypto.subtle.digest('SHA-256', heap.subarray(0, n)).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''));
  };
  const hashes = [];
  for (const [p, n] of data.slices) hashes.push(await read(p, n));
  postMessage({ hashes, stats: files.stats });
};`;

async function scenario(name, extra) {
  const dataPort = 21000 + Math.floor(Math.random() * 3000), pagePort = dataPort + 3000;
  const dataServer = spawn('node', [path.join(__dirname, '../tools/serve.mjs'), '--www', path.join(__dirname, '..'), '--data', native, '--cors', '1', '--port', String(dataPort), ...extra], { stdio: 'ignore' });
  // The test page comes from a real server (a page fabricated by request interception counts as a public
  // address and Chromium then refuses its requests to loopback).
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'rangefs-test-'));
  fs.copyFileSync(path.join(__dirname, '../www/rangefs.js'), path.join(site, 'rangefs.js'));
  fs.writeFileSync(path.join(site, 'page.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(site, 'worker.js'), WORKER);
  const pageServer = spawn('node', [path.join(__dirname, '../tools/serve.mjs'), '--www', site, '--port', String(pagePort)], { stdio: 'ignore' });
  await sleep(600);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${pagePort}/page.html`);
    page.on('console', (m) => console.log('[page]', m.text().slice(0, 200))); page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    const result = await page.evaluate(([base, rel, size, slices]) => new Promise((resolve, reject) => {
      const w = new Worker('/worker.js', { type: 'module' });
      w.onmessage = (e) => resolve(e.data); w.onerror = (e) => reject(new Error('worker error: ' + e.message));
      setTimeout(() => reject(new Error('worker timed out')), 60000);
      w.postMessage({ base, rel, size, slices });
    }), [`http://127.0.0.1:${dataPort}/game/`, rel, size, slices]);
    const counters = await (await fetch(`http://127.0.0.1:${dataPort}/__stats`)).json();
    const ok = JSON.stringify(result.hashes) === JSON.stringify(expected);
    console.log(`${name}: ${ok ? 'data identical' : 'DATA MISMATCH'}; requests ${result.stats.requests}, preflights ${counters.preflights}, refused ${result.stats.rangeRefused}, rangeIgnored ${result.stats.rangeIgnored}, body ${(counters.bodyBytes / 1048576).toFixed(1)} MiB of ${(size / 1048576).toFixed(1)} MiB file`);
    return { ok, result, counters };
  } finally { await browser.close(); dataServer.kill(); pageServer.kill(); fs.rmSync(site, { recursive: true, force: true }); }
}

(async () => {
  console.log(`file ${rel} (${(size / 1048576).toFixed(1)} MiB)`);
  // A plain `Range: bytes=a-b` header is CORS-safelisted: no preflight is sent, so a host that never answers one still works.
  const good = await scenario('cross-origin host, Range works   ', []);
  const refused = await scenario('host whose Range answers fail CORS', ['--cors-no-range', '1']);
  const ignored = await scenario('host that ignores Range           ', ['--ignore-range', '1']);
  const pass = good.ok && refused.ok && ignored.ok
    && good.result.stats.requests === 3 && good.counters.preflights === 0 && good.result.stats.rangeIgnored === 0 && good.counters.bodyBytes < size / 2
    && refused.result.stats.requests === 1 && refused.result.stats.rangeRefused === 1
    && ignored.result.stats.requests === 1 && ignored.result.stats.rangeIgnored === 1;
  console.log(pass ? 'PASS' : 'FAIL'); process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
