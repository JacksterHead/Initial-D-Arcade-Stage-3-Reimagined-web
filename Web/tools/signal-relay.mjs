// A tiny mailbox server for the one-link pairing flow. It implements the small part of the ntfy.sh API the
// client uses, so the client can talk either to ntfy.sh or to this:
//
//   POST|PUT /<topic>              body = text (<= 4096 bytes)  ->  200 {"id","time","event":"message","topic","message"}
//   GET      /<topic>/sse[?since=all]    Server-Sent Events: `event: open`, then cached messages, then live ones
//   OPTIONS  *                     CORS preflight
//
// It only passes along the two short pairing codes (offer and reply). Game traffic never goes through it.
// In-memory, no accounts, per-address rate limit, messages expire after 12 h like ntfy's cache. Serve it over
// HTTPS (a reverse proxy or a tunnel) when the game page is served over HTTPS.
//
//   node Web/tools/signal-relay.mjs [--port 8787] [--host 127.0.0.1]
//   # then open the game with ?signal=https://your.relay.example   (or set "signal" in config.json)
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
const MAX_BODY = 4096, MAX_PER_TOPIC = 60, MAX_TOPICS = 5000, TTL_MS = 12 * 3600 * 1000;
const BURST = 60, REPLENISH_MS = 5000;               // like ntfy.sh's anonymous request limits

export function createRelay({ now = () => Date.now() } = {}) {
  const topics = new Map();                                  // name -> {messages: [], subscribers: Set<res>}
  const buckets = new Map();                                 // address -> {tokens, at}
  const stats = { posts: 0, streams: 0, limited: 0 };

  const take = (address) => {
    const t = now();
    const b = buckets.get(address) ?? { tokens: BURST, at: t };
    b.tokens = Math.min(BURST, b.tokens + (t - b.at) / REPLENISH_MS); b.at = t;
    buckets.set(address, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const topicOf = (name, create) => {
    let t = topics.get(name);
    if (!t && create) {
      if (topics.size >= MAX_TOPICS) for (const [k, v] of topics) if (!v.subscribers.size) { topics.delete(k); break; }
      t = { messages: [], subscribers: new Set() };
      topics.set(name, t);
    }
    return t;
  };
  const prune = (t) => { const limit = now() - TTL_MS; t.messages = t.messages.filter((m) => m.at > limit).slice(-MAX_PER_TOPIC); };
  const event = (res, name, data) => res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  const plain = (m) => ({ id: m.id, time: m.time, event: 'message', topic: m.topic, message: m.message });

  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400' };
    const end = (status, body = '', type = 'text/plain') => { res.writeHead(status, { ...cors, 'Content-Type': type }); res.end(body); };
    if (req.method === 'OPTIONS') return end(204);
    const url = new URL(req.url, 'http://relay');
    const parts = url.pathname.split('/').filter(Boolean);
    const name = parts[0];
    if (!name || !TOPIC.test(name) || parts.length > 2) return end(404, 'not found');
    if (!take(req.socket.remoteAddress ?? '?')) { ++stats.limited; return end(429, 'rate limited'); }

    if ((req.method === 'POST' || req.method === 'PUT') && parts.length === 1) {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY + 1) chunks.push(c); });
      req.on('end', () => {
        if (size > MAX_BODY) return end(413, 'message too large');
        const t = topicOf(name, true);
        prune(t);
        const m = { id: crypto.randomBytes(6).toString('base64url'), time: Math.floor(now() / 1000), at: now(), topic: name, message: Buffer.concat(chunks).toString('utf8') };
        t.messages.push(m);
        ++stats.posts;
        for (const s of t.subscribers) event(s, null, plain(m));
        end(200, JSON.stringify(plain(m)), 'application/json');
      });
      return undefined;
    }
    if (req.method === 'GET' && parts[1] === 'sse') {
      const t = topicOf(name, true);
      ++stats.streams;
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      event(res, 'open', { id: crypto.randomBytes(6).toString('base64url'), time: Math.floor(now() / 1000), event: 'open', topic: name });
      if (url.searchParams.get('since') === 'all') { prune(t); for (const m of t.messages) event(res, null, plain(m)); }
      t.subscribers.add(res);
      const keepalive = setInterval(() => event(res, 'keepalive', { id: crypto.randomBytes(6).toString('base64url'), time: Math.floor(now() / 1000), event: 'keepalive', topic: name }), 30000);
      req.on('close', () => { clearInterval(keepalive); t.subscribers.delete(res); });
      return undefined;
    }
    return end(405, 'method not allowed');
  });
  return { server, stats, topics, close: () => { for (const t of topics.values()) for (const s of t.subscribers) s.end(); server.close(); server.closeAllConnections?.(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
  const relay = createRelay();
  relay.server.listen(Number(args.port ?? 8787), args.host ?? '127.0.0.1', () => {
    const a = relay.server.address();
    console.log(`signal relay listening on http://${a.address}:${a.port}`);
  });
}
