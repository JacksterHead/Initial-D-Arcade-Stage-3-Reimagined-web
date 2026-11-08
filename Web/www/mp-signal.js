// Pairing codes: a WebRTC data-channel session description squeezed into one short, typo-resistant text code
// that two players can send each other in any chat app (no signalling server).
//
// A full SDP is 1-3 KB, mostly boilerplate. A data-channel-only session needs just the ICE credentials, the
// DTLS certificate fingerprint (which also authenticates the peer: a man in the middle would have to change
// the code), the DTLS role and the UDP candidate addresses. Those are packed into ~90-130 bytes, protected by
// a CRC-16 against truncated or mistyped pastes, and written in Crockford base32 (no 0/O or 1/I/L confusion,
// case-insensitive) in groups of five.
//
//   [0]      version(4) | answer(1) | setup(2) | reserved
//   [1..32]  SHA-256 DTLS fingerprint
//   [..]     ufrag (len u8 + ASCII), pwd (len u8 + ASCII)
//   [..]     candidate count u8, then per candidate: type(2) | addr(2) | tcp(1) in one byte, address, port u16 BE
//   [last 2] CRC-16/CCITT of everything before

const VERSION = 1;
const SETUP = ['actpass', 'active', 'passive'];
const TYPES = ['host', 'srflx', 'prflx', 'relay'];
const MAX_CANDIDATES = 12;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---- Crockford base32 --------------------------------------------------------------------------
function toBase32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function fromBase32(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('The code contains a character that is not allowed.');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}
const group = (s) => s.match(/.{1,5}/g).join('-');
/** Accepts what a person pastes: any case, spaces, newlines, dashes, I/L read as 1 and O as 0. */
function normalise(text) {
  return String(text).toUpperCase().replace(/[\s\-_.:]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; ++i) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// ---- SDP <-> description ------------------------------------------------------------------------
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
function parseUuid(name) {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i.exec(name);
  if (!m) return null;
  const h = m.slice(1).join('');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(h.substr(i * 2, 2), 16));
}
function uuidOf(bytes) {
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
}
function ipv6Bytes(text) {
  // Full expansion of "::" notation (no embedded IPv4, which candidates do not use).
  const [head, tail = null] = text.split('::');
  const a = head ? head.split(':') : [], b = tail === null ? [] : (tail ? tail.split(':') : []);
  if (tail === null && a.length !== 8) return null;
  const parts = tail === null ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  if (parts.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; ++i) {
    const v = parseInt(parts[i], 16);
    if (!/^[0-9a-f]{1,4}$/i.test(parts[i]) || Number.isNaN(v)) return null;
    out[i * 2] = v >> 8; out[i * 2 + 1] = v & 255;
  }
  return out;
}
const ipv6Text = (bytes) => Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16)).join(':');

/** Extracts what a data-channel peer needs from a browser's SDP. */
export function describe(sdp, answer) {
  const lines = String(sdp).split(/\r?\n/);
  const attr = (name) => { const l = lines.find((x) => x.startsWith(`a=${name}:`)); return l ? l.slice(name.length + 3).trim() : null; };
  const ufrag = attr('ice-ufrag'), pwd = attr('ice-pwd');
  const fp = attr('fingerprint');
  const setup = attr('setup');
  if (!ufrag || !pwd || !fp || !setup) throw new Error('The session description is incomplete.');
  const [algorithm, value] = fp.split(/\s+/);
  if (algorithm.toLowerCase() !== 'sha-256') throw new Error('Unsupported certificate fingerprint.');
  const fingerprint = Uint8Array.from(value.split(':').map((h) => parseInt(h, 16)));
  if (fingerprint.length !== 32 || fingerprint.some(Number.isNaN)) throw new Error('Invalid certificate fingerprint.');
  if (!SETUP.includes(setup)) throw new Error('Unsupported DTLS role.');
  const candidates = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue;
    const t = line.slice(12).trim().split(/\s+/);
    if (t.length < 8 || t[6] !== 'typ') continue;
    const proto = t[2].toLowerCase();
    if (t[1] !== '1' || (proto !== 'udp' && proto !== 'tcp')) continue;
    const type = TYPES.indexOf(t[7]);
    const port = Number(t[5]);
    if (type < 0 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (proto === 'tcp') continue;                                  // direct UDP only (what STUN can punch)
    const address = t[4];
    let kind, bytes;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) { kind = 0; bytes = Uint8Array.from(address.split('.').map(Number)); if (bytes.some((n) => n > 255)) continue; }
    else if (address.includes(':')) { if (/^fe80:/i.test(address)) continue; kind = 1; bytes = ipv6Bytes(address); if (!bytes) continue; }
    else { kind = 2; bytes = parseUuid(address); if (!bytes) continue; }
    const key = `${kind}/${address}/${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ type, kind, bytes, port });
  }
  // Prefer reachable-from-outside addresses when trimming: server-reflexive first, then host.
  candidates.sort((a, b) => (a.type === 1 ? 0 : a.type) - (b.type === 1 ? 0 : b.type));
  return { answer: !!answer, setup: SETUP.indexOf(setup), fingerprint, ufrag, pwd, candidates: candidates.slice(0, MAX_CANDIDATES) };
}

/** A minimal data-channel-only SDP a browser accepts as the remote description. */
export function toSdp(d) {
  const lines = [
    'v=0', `o=- ${Math.floor(Math.random() * 2 ** 52) + 1000} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${d.ufrag}`, `a=ice-pwd:${d.pwd}`, 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${hex(d.fingerprint)}`, `a=setup:${SETUP[d.setup]}`,
    'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
  ];
  d.candidates.forEach((c, i) => {
    const address = c.kind === 0 ? [...c.bytes].join('.') : c.kind === 1 ? ipv6Text(c.bytes) : uuidOf(c.bytes);
    const typePref = [126, 100, 110, 0][c.type];
    const priority = (typePref * 2 ** 24) + ((65535 - i) * 256) + 255;
    let line = `a=candidate:${i + 1} 1 udp ${priority} ${address} ${c.port} typ ${TYPES[c.type]}`;
    if (c.type !== 0) line += ' raddr 0.0.0.0 rport 0';
    lines.push(line);
  });
  lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}

// ---- code <-> description -----------------------------------------------------------------------
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 127));

export function encodeCode(d) {
  const ufrag = ascii(d.ufrag), pwd = ascii(d.pwd);
  if (ufrag.length > 255 || pwd.length > 255) throw new Error('Session description too large.');
  const parts = [Uint8Array.of((VERSION << 4) | (d.answer ? 8 : 0) | (d.setup << 1)), d.fingerprint,
    Uint8Array.of(ufrag.length), ufrag, Uint8Array.of(pwd.length), pwd, Uint8Array.of(d.candidates.length)];
  for (const c of d.candidates) parts.push(Uint8Array.of((c.type << 4) | (c.kind << 2)), c.bytes, Uint8Array.of(c.port >> 8, c.port & 255));
  const size = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(size + 2);
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.length; }
  const crc = crc16(body.subarray(0, size));
  body[size] = crc >> 8; body[size + 1] = crc & 255;
  return group(toBase32(body));
}

export function decodeCode(text) {
  let body;
  try { body = fromBase32(normalise(text)); } catch (e) { throw new Error('This does not look like a pairing code.'); }
  if (body.length < 40) throw new Error('The code is too short. Copy the whole code.');
  const size = body.length - 2;
  if (crc16(body.subarray(0, size)) !== ((body[size] << 8) | body[size + 1])) throw new Error('The code is damaged or incomplete. Copy it again.');
  let at = 0;
  const take = (n) => { if (at + n > size) throw new Error('The code is damaged.'); const s = body.subarray(at, at + n); at += n; return s; };
  const head = take(1)[0];
  if ((head >> 4) !== VERSION) throw new Error('This code is from a different version of the game.');
  const answer = !!(head & 8), setup = (head >> 1) & 3;
  if (setup > 2) throw new Error('The code is damaged.');
  const fingerprint = take(32).slice();
  const ufrag = String.fromCharCode(...take(take(1)[0])), pwd = String.fromCharCode(...take(take(1)[0]));
  const count = take(1)[0];
  if (count > MAX_CANDIDATES) throw new Error('The code is damaged.');
  const candidates = [];
  for (let i = 0; i < count; ++i) {
    const flags = take(1)[0], type = flags >> 4, kind = (flags >> 2) & 3;
    if (type > 3 || kind > 2) throw new Error('The code is damaged.');
    const bytes = take(kind === 0 ? 4 : 16).slice(), p = take(2);
    candidates.push({ type, kind, bytes, port: (p[0] << 8) | p[1] });
  }
  if (at !== size) throw new Error('The code is damaged.');
  return { answer, setup, fingerprint, ufrag, pwd, candidates };
}
