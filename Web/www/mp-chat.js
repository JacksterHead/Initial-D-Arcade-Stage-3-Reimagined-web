// Lobby chat rules, ported from Assets/Scripts/Multiplayer/Idas3LobbyChat.cs: sanitising, per-direction rate
// limits and a bounded history. Names come from the admitted session, never from a message.

export const MAX_CHARACTERS = 160;
export const MAX_HISTORY = 40;
export const MESSAGE_INTERVAL = 0.75;       // seconds of allowance one message costs
const LOCAL_BURST = 3, REMOTE_BURST = 6;    // receive headroom tolerates batching on the wire

/** Text as it may be shown: no control/format characters (bidi overrides too), no angle brackets, collapsed spaces. */
export function cleanText(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = '', space = false, length = 0;
  for (const ch of text) {                       // iterates code points; lone surrogates arrive as U+FFFD-free halves
    const units = ch.length;
    if (/^\s$/u.test(ch)) { space = length > 0; continue; }
    if (ch === '<' || ch === '>' || /^[\p{Cc}\p{Cf}\p{Cs}\p{Cn}]$/u.test(ch)) continue;
    const needed = (space ? 1 : 0) + units;
    if (length + needed > MAX_CHARACTERS) break;
    if (space) { out += ' '; ++length; space = false; }
    out += ch; length += units;
  }
  return out;
}

export class LobbyChat {
  constructor() { this.clear(); }
  clear() {
    this.messages = [];
    this.localTokens = LOCAL_BURST; this.remoteTokens = REMOTE_BURST;
    this.localAt = 0; this.remoteAt = 0;
    this.localSequence = 0; this.remoteSequence = 0;
  }
  static #take(tokens, last, now, burst) {
    if (!Number.isFinite(now) || now < 0) return null;
    const refilled = Math.min(burst, tokens + Math.max(0, now - last) / MESSAGE_INTERVAL);
    if (refilled < 1) return { tokens: refilled, last: now, ok: false };
    return { tokens: refilled - 1, last: now, ok: true };
  }
  #append(name, text, local) {
    if (this.messages.length === MAX_HISTORY) this.messages.shift();
    this.messages.push({ name, text, local });
  }
  /** Returns the cleaned text to send, or null when empty or sent too quickly. */
  tryLocal(name, text, now) {
    const clean = cleanText(text);
    if (!clean) return null;
    const t = LobbyChat.#take(this.localTokens, this.localAt, now, LOCAL_BURST);
    if (!t) return null;
    this.localTokens = t.tokens; this.localAt = t.last;
    if (!t.ok) return null;
    ++this.localSequence;
    this.#append(name, clean, true);
    return clean;
  }
  /** True when the message was shown. Each sequence number is consumed even when filtered, so replays never show. */
  tryRemote(name, text, sequence, now) {
    if (!Number.isInteger(sequence) || sequence <= 0 || sequence <= this.remoteSequence) return false;
    this.remoteSequence = sequence;
    const clean = cleanText(text);
    if (!clean) return false;
    const t = LobbyChat.#take(this.remoteTokens, this.remoteAt, now, REMOTE_BURST);
    if (!t) return false;
    this.remoteTokens = t.tokens; this.remoteAt = t.last;
    if (!t.ok) return false;
    this.#append(name, clean, false);
    return true;
  }
}
