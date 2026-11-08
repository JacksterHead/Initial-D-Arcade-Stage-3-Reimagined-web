// Pairing-code encoding: SDP -> code -> SDP round trips, damaged codes are rejected, and the code stays short.
import assert from 'node:assert/strict';
import { describe, encodeCode, decodeCode, toSdp } from '../www/mp-signal.js';

const fp = Array.from({ length: 32 }, (_, i) => ((i * 37 + 11) & 255).toString(16).padStart(2, '0').toUpperCase()).join(':');
const offer = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2113937151 7ad7a9de-3b6c-4a8f-9d2e-1c5a6f0b8e41.local 54321 typ host generation 0 network-cost 999',
  'a=candidate:2 1 udp 1677729535 203.0.113.77 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:3 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0',
  'a=candidate:4 1 udp 2113937151 fe80::1ff:fe23:4567:890a 4444 typ host',
  'a=candidate:5 1 udp 1677729535 2001:db8::1234:5678 40000 typ srflx raddr :: rport 0',
  'a=ice-ufrag:aBcD', 'a=ice-pwd:0123456789abcdefghijklmn', 'a=ice-options:trickle', `a=fingerprint:sha-256 ${fp}`,
  'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144', '',
].join('\r\n');

const d = describe(offer, false);
assert.equal(d.candidates.length, 3, 'tcp and link-local candidates are dropped');
const code = encodeCode(d);
console.log(`code (${code.replace(/-/g, '').length} chars): ${code}`);
assert.ok(code.replace(/-/g, '').length < 220);

const back = decodeCode(code);
assert.equal(back.answer, false); assert.equal(back.setup, 0);
assert.equal(back.ufrag, 'aBcD'); assert.equal(back.pwd, '0123456789abcdefghijklmn');
assert.deepEqual([...back.fingerprint], [...d.fingerprint]);
assert.deepEqual(back.candidates.map((c) => [c.type, c.kind, c.port, [...c.bytes].join(',')]), d.candidates.map((c) => [c.type, c.kind, c.port, [...c.bytes].join(',')]));

// Pasting habits: lower case, spaces, line breaks, trailing text.
assert.equal(decodeCode(code.toLowerCase().replace(/-/g, '  \n')).ufrag, 'aBcD');
// Damage is detected rather than producing a wrong session.
const chars = code.replace(/-/g, '');
const flip = chars.slice(0, 40) + (chars[40] === 'A' ? 'B' : 'A') + chars.slice(41);
assert.throws(() => decodeCode(flip), /damaged|incomplete/);
assert.throws(() => decodeCode(chars.slice(0, chars.length - 6)), /damaged|incomplete|short/);
assert.throws(() => decodeCode('hello world'), /pairing code|allowed|short/);
assert.throws(() => decodeCode(''), /short|pairing/);

// The rebuilt SDP has everything a browser needs.
const sdp = toSdp(back);
for (const need of ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=ice-ufrag:aBcD', `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:0',
  '203.0.113.77 54321 typ srflx', '7ad7a9de-3b6c-4a8f-9d2e-1c5a6f0b8e41.local 54321 typ host', '2001:db8:0:0:0:0:1234:5678 40000 typ srflx', 'a=end-of-candidates']) {
  assert.ok(sdp.includes(need), `rebuilt SDP lacks "${need}"`);
}
// An answer keeps its role bit.
const answer = describe(offer.replace('actpass', 'active'), true);
assert.equal(decodeCode(encodeCode(answer)).answer, true);
assert.equal(decodeCode(encodeCode(answer)).setup, 1);
console.log('OK');
