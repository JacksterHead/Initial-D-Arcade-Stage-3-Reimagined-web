// The browser connection between two players: one RTCPeerConnection with two data channels, set up by
// exchanging a short pairing code each way (mp-signal.js). Runs on the main thread (workers have no
// RTCPeerConnection); the game worker receives the traffic by postMessage.
//
//   ctl  ordered, reliable      lobby messages, chat, results and the recovery copies of input packets
//   inp  unordered, no retries  the per-frame input packets (a late one is worthless; the core rolls back)
//
// There is no relay server: the connection is direct (UDP, using public STUN servers only to learn each
// side's public address). Most home networks work. Strict corporate firewalls and some mobile carriers block
// peer-to-peer traffic, and then the pairing ends in "could not connect" - that is a limit of the design.

import { describe, encodeCode, decodeCode, toSdp } from './mp-signal.js';

export const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const GATHER_TIMEOUT_MS = 4000;
const DISCONNECT_GRACE_MS = 8000;
const MAX_BUFFERED = 128 * 1024;

export class MpLink {
  /**
   * @param {object} o
   * @param {(state: string, detail?: string) => void} o.onState  new | gathering | code | connecting | open | failed | closed
   * @param {(data: string|ArrayBuffer) => void} o.onMessage
   * @param {RTCIceServer[]} [o.iceServers]
   */
  constructor({ onState, onMessage, iceServers = ICE_SERVERS }) {
    this.onState = onState; this.onMessage = onMessage; this.iceServers = iceServers;
    this.pc = null; this.ctl = null; this.inp = null; this.state = 'new'; this.role = null;
    this.graceTimer = 0;
  }
  #set(state, detail) {
    if (this.state === 'closed' || (this.state === 'failed' && state !== 'closed')) return;
    this.state = state;
    this.onState(state, detail);
  }
  #peer() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      clearTimeout(this.graceTimer);
      if (s === 'failed') this.#set('failed', 'Could not connect. The two networks may block direct connections (this game uses no relay server).');
      else if (s === 'disconnected') this.graceTimer = setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') this.#set('failed', 'The connection to the other driver was lost.'); }, DISCONNECT_GRACE_MS);
      else if (s === 'closed' && this.state === 'open') this.#set('failed', 'The connection to the other driver was closed.');
      else if (s === 'connecting' && this.state === 'code') this.#set('connecting');
    };
    this.pc = pc;
    return pc;
  }
  #wire(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (e) => this.onMessage(e.data);
    channel.onclose = () => { if (this.state === 'open') this.#set('failed', 'The connection to the other driver was closed.'); };
    channel.onopen = () => this.#opened();
    if (channel.label === 'ctl') this.ctl = channel; else if (channel.label === 'inp') this.inp = channel;
    if (channel.readyState === 'open') this.#opened();
  }
  #opened() {
    if (this.state !== 'open' && this.ctl?.readyState === 'open' && this.inp?.readyState === 'open') this.#set('open');
  }
  static #gathered(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      const done = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  /** Host, step 1: returns the code to send to the guest. */
  async host() {
    this.role = 'host';
    this.#set('gathering');
    const pc = this.#peer();
    this.#wire(pc.createDataChannel('ctl', { ordered: true }));
    this.#wire(pc.createDataChannel('inp', { ordered: false, maxRetransmits: 0 }));
    await pc.setLocalDescription(await pc.createOffer());
    await MpLink.#gathered(pc);
    const code = encodeCode(describe(pc.localDescription.sdp, false));
    this.#set('code');
    return code;
  }
  /** Host, step 2: the guest's reply code. */
  async accept(reply) {
    if (this.role !== 'host' || !this.pc) throw new Error('Not waiting for a reply code.');
    const d = decodeCode(reply);
    if (!d.answer) throw new Error('That is the host code. Paste the reply code your friend sent back.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: toSdp(d) });
    this.#set('connecting');
  }
  /** Guest: the host's code in, the reply code out. */
  async join(hostCode) {
    this.role = 'guest';
    const d = decodeCode(hostCode);
    if (d.answer) throw new Error('That is a reply code. Paste the code the host created.');
    this.#set('gathering');
    const pc = this.#peer();
    pc.ondatachannel = (e) => this.#wire(e.channel);
    await pc.setRemoteDescription({ type: 'offer', sdp: toSdp(d) });
    await pc.setLocalDescription(await pc.createAnswer());
    await MpLink.#gathered(pc);
    const code = encodeCode(describe(pc.localDescription.sdp, true));
    this.#set('code');
    return code;
  }

  /** Text or bytes; unreliable messages that would only queue up behind a slow link are dropped. */
  send(data, reliable) {
    const channel = reliable ? this.ctl : this.inp;
    if (!channel || channel.readyState !== 'open') return false;
    if (!reliable && channel.bufferedAmount > MAX_BUFFERED) return false;
    try { channel.send(data); return true; } catch { return false; }
  }
  close() {
    clearTimeout(this.graceTimer);
    const pc = this.pc;
    this.pc = null;
    const was = this.state;
    this.state = 'closed';
    try { this.ctl?.close(); this.inp?.close(); pc?.close(); } catch { /* already gone */ }
    if (was !== 'closed') this.onState('closed');
  }
}
