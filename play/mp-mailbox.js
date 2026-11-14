// The "one link" part of pairing. Two browsers cannot find each other without some shared mailbox, so the host
// leaves its pairing code (the offer) there under a secret random room name, and the guest, who opens the link
// that contains that room name, leaves the reply code (the answer). Only these two short codes pass through the
// mailbox. The game itself is a direct browser-to-browser connection afterwards.
//
// The mailbox is any server that speaks the small subset of the ntfy API used here (https://docs.ntfy.sh):
//   POST <base>/<topic>                     body = text      publish
//   GET  <base>/<topic>/sse?since=all       Server-Sent Events: cached messages first, then live ones
// By default that is the public https://ntfy.sh; Web/tools/signal-relay.mjs is a self-hostable replacement.
// A room name is 128 random bits, so nobody who has not seen the link can guess where to look.
//
// Messages (JSON in the body): {k:'offer',v:1,code}  {k:'answer',v:1,code}  {k:'taken',tag}  {k:'bye'}
// A room is used once: the first reply wins ("taken"), later guests are told the room is full.

export const DEFAULT_SIGNAL = 'https://ntfy.sh';
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ROOM_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
export const SETTLE_MS = 700;                 // quiet time that tells the guest the replayed history is complete
const RECONNECT_MS = 1500;
export const INVITE_LIFETIME_MS = 15 * 60 * 1000;

export const validRoom = (s) => typeof s === 'string' && ROOM_RE.test(s);
export const topicOf = (room) => `idas3-${room}`;
/** 26 characters = 130 bits of the browser's CSPRNG. */
export function newRoom(cryptoImpl = globalThis.crypto) {
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(17));
  let out = '';
  for (let i = 0; i < 26; ++i) {
    const bit = i * 5, byte = bit >> 3, shift = bit & 7;
    const v = ((bytes[byte] << 8) | bytes[byte + 1]) >> (11 - shift);
    out += ALPHABET[v & 31];
  }
  return out;
}
/** `https://host/play/#join=<room>`; keeps a custom ?signal= so the guest uses the same mailbox. */
export function inviteUrl(pageUrl, room, signal) {
  const u = new URL(pageUrl);
  u.hash = ''; u.search = '';
  if (signal && signal !== DEFAULT_SIGNAL) u.searchParams.set('signal', signal);
  u.hash = `join=${room}`;
  return u.href;
}
/** The room in a link or in `#join=...`; null when there is none. Accepts a pasted full link. */
export function roomFrom(text) {
  const m = /join=([0-9a-hjkmnp-tv-z]{26})(?![0-9a-z])/i.exec(String(text ?? ''));
  return m && validRoom(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}
export const tagOf = (code) => String(code).replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 16);
export function normaliseBase(text) {
  const u = new URL(String(text));
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The signalling address must use https.');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export class Mailbox {
  /** @param {{base: string, room: string, fetchImpl?: typeof fetch}} o */
  constructor({ base, room, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    if (!validRoom(room)) throw new Error('Invalid room.');
    this.base = normaliseBase(base); this.room = room; this.fetch = fetchImpl;
    this.url = `${this.base}/${topicOf(room)}`;
    this.closed = false; this.abort = null; this.seen = new Set();
  }
  async post(message) {
    const r = await this.fetch(this.url, { method: 'POST', body: JSON.stringify(message), cache: 'no-store' });
    if (!r.ok) throw new Error(`The matchmaking service answered ${r.status}.`);
  }
  /** Best effort while the page is going away. */
  beacon(message) {
    try { return navigator.sendBeacon(this.url, JSON.stringify(message)); } catch { return false; }
  }
  /**
   * Streams every message of the room (history first). `onMessage(obj)` gets parsed protocol objects;
   * `onStatus('open'|'retry')` reports the stream. Reconnects until close(); duplicates are dropped.
   */
  subscribe(onMessage, onStatus = () => {}) {
    const run = async () => {
      while (!this.closed) {
        this.abort = new AbortController();
        try {
          const r = await this.fetch(`${this.url}/sse?since=all`, { headers: { Accept: 'text/event-stream' }, signal: this.abort.signal, cache: 'no-store' });
          if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
          onStatus('open');
          const reader = r.body.getReader(), decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
            let at;
            while ((at = buffer.indexOf('\n\n')) >= 0) { this.#dispatch(buffer.slice(0, at), onMessage); buffer = buffer.slice(at + 2); }
          }
        } catch { /* fall through to retry */ }
        if (this.closed) return;
        onStatus('retry');
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
      }
    };
    run();
  }
  #dispatch(block, onMessage) {
    let name = 'message', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trimStart();
    }
    if (name !== 'message' || !data) return;                       // open / keepalive
    let env;
    try { env = JSON.parse(data); } catch { return; }
    if (env?.event !== 'message' || typeof env.message !== 'string' || (env.id && this.seen.has(env.id))) return;
    if (env.id) { this.seen.add(env.id); if (this.seen.size > 500) this.seen.clear(); }
    let msg;
    try { msg = JSON.parse(env.message); } catch { return; }
    if (msg && typeof msg === 'object' && typeof msg.k === 'string') onMessage(msg);
  }
  close() { this.closed = true; try { this.abort?.abort(); } catch { /* ignore */ } }
}

/**
 * Host side. `offerCode` is the pairing code from MpLink.host(). `onAnswer(code)` receives the first reply
 * (return/throw to say whether it worked). Status: 'posting' | 'waiting' | 'unreachable' | 'answered' | 'expired' | 'failed'.
 */
export function hostInvite({ mailbox, offerCode, onAnswer, onStatus, lifetimeMs = INVITE_LIFETIME_MS, unreachableMs = 8000 }) {
  let accepted = false, stopped = false, opened = false;
  const finish = (status, detail) => { if (!stopped) onStatus(status, detail); };
  const unreachable = setTimeout(() => { if (!opened && !accepted) finish('unreachable'); }, unreachableMs);
  const expiry = setTimeout(() => { if (!accepted) { stop(true); finish('expired'); } }, lifetimeMs);
  const stop = (sayBye) => {
    if (stopped) return;
    clearTimeout(unreachable); clearTimeout(expiry);
    if (sayBye && !accepted) mailbox.post({ k: 'bye' }).catch(() => {});
    stopped = true; mailbox.close();
  };
  finish('posting');
  mailbox.post({ k: 'offer', v: 1, code: offerCode })
    .then(() => { opened = true; finish('waiting'); })
    .catch((e) => { finish('unreachable', e.message); });
  mailbox.subscribe(async (msg) => {
    if (accepted || stopped || msg.k !== 'answer' || msg.v !== 1 || typeof msg.code !== 'string' || msg.code.length > 600) return;
    accepted = true;
    try {
      await onAnswer(msg.code);
      mailbox.post({ k: 'taken', tag: tagOf(msg.code) }).catch(() => {});
      finish('answered');
    } catch (e) {
      accepted = false;                                       // a damaged reply must not block a good one
      finish('bad-answer', e.message);
    }
  }, (s) => { if (s === 'open') opened = true; });
  return { cancel: () => stop(true), done: () => stop(false), beacon: () => { if (!accepted) mailbox.beacon({ k: 'bye' }); } };
}

/**
 * Guest side. Waits for the replayed history to settle, then decides: join (`onOffer(code)` must return the
 * reply code), or report 'ended' (the host cancelled), 'full' (someone else was taken) or 'missing'.
 * Status: 'looking' | 'unreachable' | 'joining' | 'replied' | 'ended' | 'full' | 'missing' | 'failed'.
 */
export function guestJoin({ mailbox, onOffer, onStatus, settleMs = SETTLE_MS, missingMs = 20000, unreachableMs = 8000 }) {
  let offer = null, taken = false, bye = false, joined = false, myTag = null, stopped = false, opened = false;
  let settleTimer = 0;
  const say = (s, d) => { if (!stopped) onStatus(s, d); };
  const stop = () => { stopped = true; clearTimeout(settleTimer); clearTimeout(missing); clearTimeout(unreachable); mailbox.close(); };
  const unreachable = setTimeout(() => { if (!opened) say('unreachable'); }, unreachableMs);
  const missing = setTimeout(() => { if (!joined) { say('missing'); stop(); } }, missingMs);
  const decide = async () => {
    if (joined || stopped) return;
    if (!offer) return;                                        // keep waiting for the host (until `missing`)
    if (bye) { say('ended'); stop(); return; }
    if (taken) { say('full'); stop(); return; }
    joined = true; clearTimeout(missing);
    say('joining');
    try {
      const reply = await onOffer(offer);
      myTag = tagOf(reply);
      await mailbox.post({ k: 'answer', v: 1, code: reply });
      say('replied', reply);
    } catch (e) { say('failed', e.message); stop(); }
  };
  say('looking');
  mailbox.subscribe((msg) => {
    if (stopped) return;
    if (joined) {
      if (msg.k === 'taken' && myTag && msg.tag !== myTag) { say('full'); stop(); }
      else if (msg.k === 'bye') { say('ended'); stop(); }
      return;
    }
    if (msg.k === 'offer' && msg.v === 1 && typeof msg.code === 'string' && msg.code.length <= 600) { offer = msg.code; taken = false; bye = false; }
    else if (msg.k === 'taken') taken = true;
    else if (msg.k === 'bye') bye = true;
    else return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(decide, settleMs);
  }, (s) => { if (s === 'open') opened = true; });
  return { stop };
}
