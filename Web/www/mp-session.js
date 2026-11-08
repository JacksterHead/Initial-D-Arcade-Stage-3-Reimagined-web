// Head-to-head session for the browser: handshake, lobby (car, rules, ready), chat, race start, the input
// authority pump, results, battle records and the return to the lobby. It is the web counterpart of
// Assets/Scripts/Multiplayer/Idas3MultiplayerSession.cs with a simpler lobby (the host's course pick stands;
// there is no random draw between two picks) and its own wire format over one WebRTC connection:
//
//   reliable ordered channel  JSON text messages (below) and, for recovery, binary input packets
//   unreliable channel        binary input packets, JSON pings
//
// The session never touches the DOM, the network or the clock directly: the worker (or a test) passes in the
// core wrapper, `send(message, reliable)`, `now()` and a record store, and calls beforeFrame()/afterFrame()
// around every core step. That keeps it testable with two cores in one Node process.
//
// Input authority (the core's "version 2"): each side simulates both cars from the exchanged controls, so a
// result needs no trust in the other side's claims; the host only announces what it computed and the guest
// checks that its own simulation agrees before accepting it.

import { WINNER, appearanceOf, remoteWordsFrom, CAR_COUNT, carOf, isAutomatic, MIN_AUTHORITY_PACKET, MAX_AUTHORITY_PACKET } from './mp-core.js';
import { LobbyChat, MAX_CHARACTERS } from './mp-chat.js';
import { validRecord, freshRecord } from './mp-records.js';

export const PROTOCOL = 1;
export const CAR_NAMES = [
  'AE86 TRUENO', 'AE86 LEVIN', 'AE85 LEVIN', 'SW20 MR2', 'ZZW30 MR-S', 'SXE10 ALTEZZA', 'ST205 CELICA',
  'BNR32 SKYLINE', 'BNR34 SKYLINE', 'S13 SILVIA', 'S14 SILVIA Q\'s', 'S14 SILVIA K\'s', 'S15 SILVIA',
  'RPS13 180SX', 'RPS13 SILEIGHTY', 'EK9 CIVIC', 'EG6 CIVIC', 'DC2 INTEGRA', 'AP1 S2000',
  'CE9A LANCER', 'CN9A LANCER', 'CT9A LANCER', 'FD3S RX-7 Type R', 'FD3S RX-7 Spirit R', 'FC3S RX-7',
  'NA6CE ROADSTER', 'NB8C ROADSTER', 'GC8 IMPREZA', 'GDB IMPREZA', 'GC8 IMPREZA Type R',
  'EA11R CAPPUCCINO', 'ER34 SKYLINE', 'CP9A LANCER V', 'CP9A LANCER VI', 'SE3P RX-8',
];
// The nine stock courses. (The desktop game's imported course packs are not part of the web data.)
export const COURSES = ['Myogi', 'Usui', 'Akagi', 'Akina', 'Happogahara', 'Irohazaka', 'Shomaru', 'Tsuchisaka', 'Akina Snow'];
export const requiresNight = (course) => course === 4 || course === 8;
export const requiresWet = (course) => course === 8;

/** Direction names as the desktop menu shows them (Idas3CourseCatalog.DirectionToken/Label). */
export function directionLabel(course, reverse) {
  let token;
  if (course < 2) token = reverse ? 'cw' : 'ccw';
  else if (course === 4 || course === 6 || course === 7) token = reverse ? 'ib' : 'ob';
  else if (course === 5 && reverse) token = 'rev';
  else token = reverse ? 'uh' : 'dh';
  return { cw: 'CLOCKWISE', ccw: 'COUNTERCLOCKWISE', ob: 'OUTBOUND', ib: 'INBOUND', rev: 'REVERSE', uh: 'UPHILL', dh: 'DOWNHILL' }[token];
}

export function normaliseRules(r) {
  const course = Number.isInteger(r?.course) && r.course >= 0 && r.course < COURSES.length ? r.course : 3;
  return {
    course, reverse: !!r?.reverse,
    wet: requiresWet(course) || !!r?.wet,
    night: requiresNight(course) || !!r?.night,
    boost: r?.boost !== false, collisions: r?.collisions !== false,
  };
}
const sameRules = (a, b) => a.course === b.course && a.reverse === b.reverse && a.wet === b.wet && a.night === b.night && a.boost === b.boost && a.collisions === b.collisions;

const HANDSHAKE_TIMEOUT = 35, IDLE_TIMEOUT = 15, LOADING_TIMEOUT = 60, LOAD_WAIT = 65, RETURN_TIMEOUT = 30;
const PING_INTERVAL = 0.35;
const RECOVERY_DELAY = 1, RECOVERY_INTERVAL = 0.5, PROGRESS_TIMEOUT = 15;
const PACKET_INTERVAL = 1 / 30;
const MAGIC = 0x49, TYPE_INPUT = 1, INPUT_HEADER = 19;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const isRaceId = (s) => typeof s === 'string' && /^[0-9a-f]{1,16}$/.test(s) && BigInt('0x' + s) !== 0n;
const sameWords = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cleanName = (s) => String(s ?? '').replace(/[\p{Cc}\p{Cf}<>]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'DRIVER';

export class MpSession {
  /**
   * @param {object} o
   * @param {import('./mp-core.js').MpCore} o.mp           the core's multiplayer wrapper
   * @param {'host'|'guest'} o.role
   * @param {string} o.name                                  shown to the other driver
   * @param {(message: string|Uint8Array, reliable: boolean) => void} o.send   text (JSON) or binary input packets
   * @param {() => number} o.now                             seconds, monotonic
   * @param {import('./mp-records.js').RecordStore} o.store
   * @param {string} o.buildId                               both players must run the same build (the simulation must match exactly)
   * @param {() => void} [o.onChange]
   * @param {() => number} [o.random]                        [0,1), for race ids
   */
  constructor(o) {
    Object.assign(this, { mp: o.mp, send: o.send, clock: o.now, store: o.store, buildId: String(o.buildId), onChange: o.onChange ?? (() => {}) });
    this.random = o.random ?? Math.random;
    this.host = o.role === 'host';
    this.name = cleanName(o.name);
    this.chat = new LobbyChat();
    this.state = 'connecting';              // connecting | lobby | loading | countdown | racing | results | returning | disconnected | closed
    this.status = this.host ? 'Waiting for the other driver to connect.' : 'Connecting to the host.';
    this.error = '';
    this.handshake = false;
    this.remoteName = '';
    this.garage = [];
    this.local = null;                      // {selection, car, saved, automatic, words}
    this.remote = { car: 0, automatic: true, appearance: null, record: freshRecord() };
    this.rules = normaliseRules({ course: 3 });
    this.rev = 0; this.serial = 0; this.ackSerial = 0; this.remoteSerial = 0;
    this.localReady = false; this.guestReady = false;
    this.lobbyRound = '0';
    this.race = null;
    this.result = null;
    this.peerLeft = false; this.localContinue = false; this.remoteContinue = false;
    this.ping = -1; this.bestRtt = Infinity; this.peerOffset = 0; this.pending = new Map();
    this.lastPing = -1; this.lastHeard = this.clock(); this.stateAt = this.clock();
    this.refreshGarage();
  }

  // ---- helpers ---------------------------------------------------------------------------------
  get now() { return this.clock(); }
  get inRace() { return this.state === 'loading' || this.state === 'countdown' || this.state === 'racing' || this.state === 'results' || this.state === 'disconnected'; }
  get alive() { return this.state !== 'closed'; }
  #set(state, status) { this.state = state; this.stateAt = this.now; if (status !== undefined) this.status = status; this.onChange(); }
  #tx(message, reliable = true) { if (this.state !== 'closed') this.send(message instanceof Uint8Array ? message : JSON.stringify(message), reliable); }
  /** A local or protocol failure: tell the other player, then end the session (or end an unfinished race neutrally). */
  fail(reason, { race = false } = {}) {
    if (this.state === 'closed') return;
    this.error = reason;
    if (this.handshake) this.#tx({ t: 'leave' });
    if (this.race?.native && race) { this.#disconnectRace(reason); return; }
    this.#close(reason);
  }
  #close(reason) {
    if (this.race?.native) { try { this.mp.leave(); } catch { /* the core may already be gone */ } this.race.native = false; }
    this.race = null;
    this.#set('closed', reason);
  }
  #disconnectRace(reason) {
    if (this.state === 'disconnected' || this.state === 'closed') return;
    // A finished and settled race stays on its result screen; only the unfinished one ends neutrally.
    if (this.state === 'results') { this.peerLeft = true; this.status = reason; this.onChange(); return; }
    try { this.mp.disconnect(); } catch { /* ignore */ }
    this.#set('disconnected', reason);
  }

  // ---- garage -----------------------------------------------------------------------------------
  /** Every car this device can bring: save-slot cars and the stock cars, like the desktop "garage". */
  refreshGarage() {
    if (this.race?.native) return;
    const read = (selection) => {
      const c = this.mp.readCar(selection);
      return c ? { selection, ...c } : null;
    };
    const garage = [];
    for (let slot = 0; slot < 5; ++slot) {
      const primary = read(slot);
      if (!primary) continue;
      garage.push(primary);
      for (let car = 0; car < CAR_COUNT; ++car) {
        if (car === primary.car) continue;
        const item = read(40 + slot * CAR_COUNT + car);
        if (item) garage.push(item);
      }
    }
    for (let car = 0; car < CAR_COUNT; ++car) {
      const item = read(5 + car);
      if (!item) continue;
      if (!item.saved && garage.some((g) => g.car === item.car)) continue;     // a stock fallback is redundant once a saved build exists
      garage.push(item);
    }
    for (const g of garage) {
      g.slot = g.selection < 5 ? g.selection : g.selection >= 40 ? Math.floor((g.selection - 40) / CAR_COUNT) : -1;
      g.label = `${CAR_NAMES[g.car]}${g.slot >= 0 ? ` / SAVE ${g.slot + 1}` : g.saved ? ' / LEGACY SAVE' : ' / STOCK'}`;
    }
    this.garage = garage;
    const keep = this.local && (garage.find((g) => g.selection === this.local.selection)
      ?? (this.local.slot >= 0 ? garage.find((g) => g.slot === this.local.slot && g.car === this.local.car) : undefined));
    const preferred = keep ?? garage.find((g) => g.selection === this.mp.currentCar())
      ?? garage.find((g) => g.saved) ?? garage[0];
    if (!preferred) throw new Error('No car is available.');
    const automatic = this.local && preferred.car === this.local.car ? this.local.automatic : preferred.automatic;
    this.local = { ...preferred, automatic };
  }
  get localRecord() { return this.store.read(this.local.car); }

  // ---- connection / handshake ---------------------------------------------------------------------
  /** The data channels are open. */
  linkOpened() {
    if (this.state !== 'connecting') return;
    this.stateAt = this.now; this.lastHeard = this.now;
    this.status = 'Connected. Exchanging details.';
    this.#sendHello();
    this.onChange();
  }
  /** Once per connection. The other side may speak first (its channels opened a moment earlier), so this is also the answer to its hello. */
  #sendHello() {
    if (this.helloSent) return;
    this.helloSent = true;
    this.#tx({
      t: 'hello', v: PROTOCOL, build: this.buildId, host: this.host, name: this.name,
      car: this.#carWire(), rec: this.localRecord,
    });
  }
  #carWire() {
    return { sel: this.local.selection, saved: this.local.saved, auto: this.local.automatic, car: this.local.car, w: appearanceOf(this.local.words) };
  }
  #readCarWire(c) {
    if (!c || !Number.isInteger(c.sel) || c.sel < 0 || c.sel >= 215 || !Number.isInteger(c.car) || c.car < 0 || c.car >= CAR_COUNT
      || (c.sel >= 40 && (c.sel - 40) % CAR_COUNT !== c.car) || typeof c.auto !== 'boolean') throw new Error('Invalid car selection.');
    const words = remoteWordsFrom(c.w, c.car);
    return { car: c.car, automatic: c.auto, words };
  }
  /** The connection ended (closed, failed, or the page of the other player went away). */
  linkClosed(reason = 'The connection to the other driver ended.') {
    if (this.state === 'closed') return;
    if (this.race?.native) { this.#disconnectRace(reason); return; }
    this.#close(reason);
  }

  // ---- incoming ---------------------------------------------------------------------------------
  /** One message from the other player: a JSON string, or an ArrayBuffer/Uint8Array input packet. */
  receive(data) {
    if (this.state === 'closed') return;
    try {
      if (typeof data === 'string') {
        if (data.length > 8192) throw new Error('Invalid message size.');
        this.#message(JSON.parse(data));
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        this.#input(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } else throw new Error('Unsupported message.');
    } catch (e) {
      this.fail(`Connection stopped: ${e.message}`, { race: true });
    }
  }
  #require(ok, why) { if (!ok) throw new Error(why); }
  #message(m) {
    this.#require(m && typeof m === 'object' && typeof m.t === 'string', 'Invalid message.');
    this.lastHeard = this.now;
    switch (m.t) {
      case 'hello': return this.#onHello(m);
      case 'ping': this.#require(finite(m.stamp), 'Invalid clock packet.'); return this.#tx({ t: 'pong', stamp: m.stamp, at: this.now }, false);
      case 'pong': return this.#onPong(m);
      case 'leave': return this.#onLeave();
    }
    if (!this.handshake) return;                                      // everything else needs the handshake
    switch (m.t) {
      case 'lobby': return this.#onLobby(m);
      case 'player': return this.#onPlayer(m);
      case 'chat': return this.#onChat(m);
      case 'load': return this.#onLoad(m);
      case 'loaded': return this.#onLoaded(m);
      case 'release': return this.#onRelease(m);
      case 'relack': if (this.race && m.race === this.race.hex) { this.#require(this.host && this.race.native, 'Unexpected start acknowledgement.'); this.race.releaseAck = true; } return;
      case 'results': return this.#onResults(m);
      case 'ret': return this.#onReturnRequest(m);
      case 'retlobby': return this.#onReturnLobby(m);
      case 'retack': return this.#onReturnAck(m);
      default: throw new Error('Unknown message.');
    }
  }
  #onHello(m) {
    this.#require(m.v === PROTOCOL, 'The other player uses a different multiplayer protocol version.');
    this.#require(m.build === this.buildId, 'Both players need the same version of the game (reload the page, or ask the other player to).');
    this.#require(m.host === !this.host, 'Both players chose the same role.');
    if (this.handshake) return;
    this.#sendHello();
    const car = this.#readCarWire(m.car);
    this.#require(validRecord(m.rec), 'Invalid driver record.');
    this.remoteName = cleanName(m.name);
    this.remote = { ...car, record: m.rec };
    this.handshake = true;
    this.#set('lobby', 'Choose your car, then get ready. The host picks the course.');
    if (this.host) this.#sendLobby();
  }
  #onPong(m) {
    this.#require(finite(m.stamp) && finite(m.at), 'Invalid clock reply.');
    if (!this.pending.delete(m.stamp)) return;
    const rtt = this.now - m.stamp;
    if (rtt < 0 || rtt >= 5) return;
    this.ping = Math.round(rtt * 1000);
    if (rtt < this.bestRtt) { this.bestRtt = rtt; this.peerOffset = m.at - (m.stamp + this.now) * 0.5; }
  }
  #onLeave() {
    if (this.state === 'returning' && this.result?.recorded) { this.#close('The other driver left.'); return; }
    if (this.race?.native && this.state === 'results') { this.peerLeft = true; this.status = 'The other driver left.'; this.onChange(); return; }
    if (this.race?.native) { this.#disconnectRace('The other driver left the race.'); return; }
    this.#close('The other driver left the room.');
  }

  // ---- lobby -------------------------------------------------------------------------------------
  #lobbyBody() {
    return { rev: this.rev, ack: this.remoteSerial, rules: this.rules, car: this.#carWire(), rec: this.localRecord, ready: this.guestReady };
  }
  #sendLobby() { this.#tx({ t: 'lobby', ...this.#lobbyBody() }); this.onChange(); }
  #sendPlayer() {
    this.#tx({ t: 'player', rev: this.rev, serial: this.serial, car: this.#carWire(), rec: this.localRecord, ready: this.localReady });
    this.onChange();
  }
  #onLobby(m) {
    this.#require(!this.host, 'Unexpected room configuration.');
    this.#require(Number.isInteger(m.rev) && Number.isInteger(m.ack) && m.ack <= this.serial, 'Invalid lobby update.');
    const rules = normaliseRules(m.rules), car = this.#readCarWire(m.car);
    this.#require(validRecord(m.rec), 'Invalid driver record.');
    if (this.race?.native || this.state === 'returning') { this.#require(m.rev <= this.rev, 'Race settings changed after the selection was locked.'); return; }
    if (m.rev < this.rev) return;
    const changed = m.rev !== this.rev;
    this.rev = m.rev; this.rules = rules; this.remote = { ...car, record: m.rec };
    this.ackSerial = Math.max(this.ackSerial, m.ack);
    if (m.ack === this.serial) {
      this.localReady = !!m.ready; this.guestReady = !!m.ready;
    } else {
      // A queued update must not erase a newer local pick or Ready request: say it again against this revision.
      if (changed) this.localReady = false;
      this.#sendPlayer();
    }
    this.onChange();
  }
  #onPlayer(m) {
    this.#require(this.host, 'Unexpected driver configuration.');
    this.#require(Number.isInteger(m.rev) && Number.isInteger(m.serial) && typeof m.ready === 'boolean', 'Invalid driver update.');
    const car = this.#readCarWire(m.car);
    this.#require(validRecord(m.rec), 'Invalid driver record.');
    if (this.race?.native || this.state === 'returning') { this.#require(m.serial <= this.remoteSerial, 'Driver selection changed after race start.'); return; }
    if (m.serial > this.remoteSerial) {
      this.remoteSerial = m.serial;
      const carChanged = this.remote.car !== car.car || this.remote.automatic !== car.automatic || !sameWords(this.remote.words, car.words);
      this.remote = { ...car, record: m.rec };
      if (carChanged) { this.guestReady = false; ++this.rev; } else this.guestReady = m.ready && m.rev === this.rev;
    }
    this.#sendLobby();
  }
  selectCar(selection) {
    if (this.state !== 'lobby') return;
    const g = this.garage.find((x) => x.selection === selection);
    if (!g || g.selection === this.local.selection) return;
    this.local = { ...g, automatic: g.automatic };
    this.#localChanged();
  }
  setAutomatic(automatic) {
    if (this.state !== 'lobby' || this.local.automatic === !!automatic) return;
    this.local = { ...this.local, automatic: !!automatic };
    this.#localChanged();
  }
  #localChanged() {
    this.localReady = false; this.guestReady = false;
    if (this.host) { ++this.rev; this.#sendLobby(); } else { ++this.serial; this.#sendPlayer(); }
  }
  setRules(rules) {
    if (!this.host || this.state !== 'lobby') return;
    const next = normaliseRules({ ...this.rules, ...rules });
    if (sameRules(next, this.rules)) return;
    this.rules = next; this.guestReady = false; ++this.rev; this.#sendLobby();
  }
  /** Guest: ready / not ready. */
  setReady(ready) {
    if (this.host || this.state !== 'lobby' || !this.handshake || this.localReady === !!ready) return;
    this.localReady = !!ready; ++this.serial; this.#sendPlayer();
  }
  get canStart() { return this.host && this.state === 'lobby' && this.handshake && this.guestReady; }
  say(text) {
    if (this.state !== 'lobby' || !this.handshake) return false;
    const clean = this.chat.tryLocal(this.name, text, this.now);
    if (!clean) return false;
    this.#tx({ t: 'chat', round: this.lobbyRound, seq: this.chat.localSequence, text: clean });
    this.onChange();
    return true;
  }
  #onChat(m) {
    this.#require(typeof m.text === 'string' && m.text.length <= MAX_CHARACTERS * 2 && typeof m.round === 'string', 'Invalid lobby chat message.');
    if (this.state === 'lobby' && m.round === this.lobbyRound && this.chat.tryRemote(this.remoteName, m.text, m.seq, this.now)) this.onChange();
  }

  // ---- race start --------------------------------------------------------------------------------
  /** Host: start the race now (the guest must be ready). */
  start() {
    if (!this.canStart) return false;
    const hex = (BigInt(Math.floor(this.random() * 2 ** 26)) << 26n | BigInt(Math.floor(this.random() * 2 ** 26))) + 1n;
    const id = hex.toString(16);
    try {
      this.#beginRace(id);
    } catch (e) {
      this.fail(`Could not start the race: ${e.message}`, { race: true });
      return false;
    }
    this.#tx({ t: 'load', race: id, rev: this.rev });
    return true;
  }
  #onLoad(m) {
    this.#require(!this.host && this.state === 'lobby' && this.localReady && this.guestReady, 'Unexpected race start.');
    this.#require(isRaceId(m.race), 'Invalid race identity.');
    this.#require(m.rev === this.rev, 'Race settings changed before start.');
    this.#beginRace(m.race);
    this.#tx({ t: 'loaded', race: m.race });
  }
  #beginRace(hex) {
    const fresh = this.mp.readCar(this.local.selection);
    this.#require(fresh && sameWords(fresh.words, this.local.words), 'Your saved car changed; open the lobby again.');
    const r = this.rules;
    this.mp.start({ course: r.course, reverse: r.reverse, wet: r.wet, night: r.night, localCar: this.local.car, remoteCar: this.remote.car,
      localSlot: this.host ? 0 : 1, automatic: this.local.automatic }, this.local.selection, this.local.words, this.remote.words);
    this.race = { hex, id: BigInt('0x' + hex), native: true, loaded: false, remoteLoaded: false, releaseAt: 0, releaseAck: false, released: false,
      packetFrame: -1, packetAt: 0, progressAt: 0, progressConfirmed: -1, progressStarted: false, recovering: false, recoveryAt: 0, recoveryPackets: 0,
      pendingResult: null, rules: { ...r }, names: { local: this.name, remote: this.remoteName }, localCar: this.local.car, remoteCar: this.remote.car,
      remoteRecord: { ...this.remote.record } };
    this.mp.enableAuthority(this.race.id, this.remote.automatic, r.boost, r.collisions);
    this.mp.setNames(this.name, this.remoteName);
    this.mp.setBattleRecords(this.localRecord, this.remote.record);
    this.result = null; this.peerLeft = false; this.localContinue = false; this.remoteContinue = false;
    this.#set('loading', 'Loading both cars, then the showcase and countdown.');
  }
  #onLoaded(m) {
    if (!this.race || m.race !== this.race.hex) return;
    this.#require(this.host && this.race.native && !this.race.released, 'Unexpected loading acknowledgement.');
    this.race.remoteLoaded = true;
  }
  #onRelease(m) {
    if (!this.race || m.race !== this.race.hex) return;
    this.#require(!this.host && this.race.native && !this.race.released && finite(m.at) && this.bestRtt < 2, 'Invalid start synchronisation.');
    const at = m.at - this.peerOffset;
    this.#require(at > this.now - 0.1 && at < this.now + 10, 'The start arrived outside the allowed window. Please try again.');
    this.race.releaseAt = at;
    this.#set('countdown');
    this.#tx({ t: 'relack', race: this.race.hex });
  }

  // ---- per frame -----------------------------------------------------------------------------------
  /** Before the core steps. */
  beforeFrame() {
    if (this.state === 'closed') return;
    const now = this.now;
    if (!this.handshake) {
      if (this.state === 'connecting' && this.stateAt >= 0 && now - this.stateAt > HANDSHAKE_TIMEOUT && this.linkIsOpen) this.fail('The other driver did not complete the connection.');
      return;
    }
    const idle = now - this.lastHeard;
    if (this.state !== 'disconnected' && idle > (this.state === 'loading' ? LOADING_TIMEOUT : IDLE_TIMEOUT)) {
      this.fail('Connection to the other driver timed out.', { race: true }); return;
    }
    if (now - this.lastPing > PING_INTERVAL) {
      this.lastPing = now;
      if (this.pending.size >= 20) this.pending.clear();
      this.pending.set(now, 0);
      this.#tx({ t: 'ping', stamp: now }, false);
    }
    if (this.state === 'returning' && now - this.stateAt > RETURN_TIMEOUT) { this.fail('The other driver did not return to the lobby.'); return; }
    const race = this.race;
    if (race?.native && !race.released && (this.state === 'loading' || this.state === 'countdown')) {
      if (now - this.stateAt > LOAD_WAIT && this.state === 'loading') { this.fail('The second driver did not finish loading the race.', { race: true }); return; }
      if (this.host && race.remoteLoaded && !race.releaseAt && this.bestRtt < 2) {
        race.releaseAt = now + Math.max(1, this.bestRtt * 4);
        this.#set('countdown');
        this.#tx({ t: 'release', race: race.hex, at: race.releaseAt });
      }
      if (race.releaseAt && now >= race.releaseAt) {
        if (this.host && !race.releaseAck) { this.fail('The start acknowledgement was not received. Please reconnect and retry.', { race: true }); return; }
        this.mp.setGo(1);
        race.released = true;
        this.#set('racing', `Race live. Collisions ${race.rules.collisions ? 'on' : 'off'}, boost ${race.rules.boost ? 'on' : 'off'}.`);
      }
    }
  }
  /** The transport reports whether the channels are open (the handshake timeout only counts from then). */
  linkIsOpen = true;

  /** After the core stepped. */
  afterFrame() {
    const race = this.race;
    if (!race?.native || !this.handshake || this.state === 'closed' || this.state === 'disconnected' || this.state === 'returning') return;
    const status = this.mp.status();
    const recover = this.#progress(status);
    if (recover === null) return;
    const now = this.now;
    // After the race is decided the other side may still be missing our last frames: keep sending, but slowly.
    const decided = status.winner !== WINNER.UNDECIDED;
    if (recover || (decided ? now - race.packetAt >= 0.25 : status.frame !== race.packetFrame || now - race.packetAt >= PACKET_INTERVAL)) {
      race.packetFrame = status.frame; race.packetAt = now;
      const packet = this.mp.packet();
      const snap = this.mp.localSnapshot();
      const out = new Uint8Array(INPUT_HEADER + packet.length);
      const dv = new DataView(out.buffer);
      out[0] = MAGIC; out[1] = TYPE_INPUT;
      dv.setBigUint64(2, race.id, true);
      dv.setBigUint64(10, snap.sequence, true);
      out[18] = (snap.flags & 16) ? 1 : 0;
      out.set(packet, INPUT_HEADER);
      this.#tx(out, recover);                       // a recovery repeat goes over the reliable channel
      if (recover) ++race.recoveryPackets;
    }
    if (status.winner === WINNER.UNDECIDED) return;
    if (this.host) {
      if (!race.resultSent) {
        race.resultSent = true;
        this.#tx({ t: 'results', race: race.hex, winner: status.winner, host: String(status.hostFinishTicks), guest: String(status.clientFinishTicks) });
        this.#showResult(status);
      }
    } else if (race.pendingResult) {
      const p = race.pendingResult;
      this.#require(p.winner === status.winner && p.host === String(status.hostFinishTicks) && p.guest === String(status.clientFinishTicks),
        'The host result does not match the confirmed race.');
      race.pendingResult = null;
      this.#showResult(status);
    }
  }
  /** null: stop (failed); true: ask for a reliable resend; false: nothing special. */
  #progress(status) {
    const race = this.race;
    if (!race.released || this.state !== 'racing' || status.winner !== WINNER.UNDECIDED) { race.progressStarted = race.recovering = false; return false; }
    if (!race.progressStarted && status.frame === 0) return false;
    const now = this.now;
    if (!race.progressStarted || status.confirmed !== race.progressConfirmed) {
      if (race.recovering) ++this.recoveries;
      race.progressStarted = true; race.recovering = false; race.progressConfirmed = status.confirmed; race.progressAt = now; race.recoveryAt = now;
      return false;
    }
    if (now - race.progressAt >= PROGRESS_TIMEOUT) {
      this.fail('Race synchronisation stopped responding. No result was recorded. Please reconnect.', { race: true });
      return null;
    }
    if (now - race.progressAt >= RECOVERY_DELAY && now - race.recoveryAt >= RECOVERY_INTERVAL) { race.recovering = true; race.recoveryAt = now; return true; }
    return false;
  }
  recoveries = 0;

  #input(bytes) {
    this.#require(bytes.length >= INPUT_HEADER + MIN_AUTHORITY_PACKET && bytes.length <= INPUT_HEADER + MAX_AUTHORITY_PACKET && bytes[0] === MAGIC && bytes[1] === TYPE_INPUT, 'Invalid input packet.');
    if (!this.handshake) return;
    this.lastHeard = this.now;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = dv.getBigUint64(2, true), seq = dv.getBigUint64(10, true), lamps = bytes[18];
    this.#require(seq > 0n && lamps <= 1, 'Invalid opponent headlight state.');
    const race = this.race;
    if (!race?.native || id !== race.id || this.state === 'returning' || this.state === 'disconnected') return;
    this.mp.receive(bytes.subarray(INPUT_HEADER));
    this.mp.setRemoteHeadlights(seq, lamps === 1);
    this.received = (this.received ?? 0) + 1;
  }

  // ---- results -----------------------------------------------------------------------------------
  #onResults(m) {
    this.#require(!this.host && [-1, 0, 1, 2].includes(m.winner) && typeof m.host === 'string' && typeof m.guest === 'string' && /^\d+$/.test(m.host) && /^\d+$/.test(m.guest), 'Invalid race result.');
    const race = this.race;
    if (!race?.native || m.race !== race.hex) return;
    race.pendingResult = { winner: m.winner, host: m.host, guest: m.guest };
    this.afterFrame();                              // the guest may already have confirmed the same outcome
  }
  #showResult(status) {
    const race = this.race;
    const winner = status.winner, iAmHost = this.host;
    const mine = iAmHost ? 0 : 1;
    const won = winner === mine;
    const tuningPoints = this.mp.setResult(winner);
    let record = this.store.read(race.localCar), battlePoints = 0;
    if (winner === 0 || winner === 1) {
      const out = this.store.commit(race.localCar, race.hex, won, race.remoteRecord, (before, w, opp, exp) => this.mp.nextRecord(before, w, opp, exp));
      record = out.record; battlePoints = out.battlePoints;
    }
    this.mp.resultRecord(battlePoints, record.level);
    const text = winner === -1 ? 'TIME UP' : winner === 2 ? 'DRAW' : won ? 'YOU WIN' : 'YOU LOSE';
    const ticks = { host: Number(status.hostFinishTicks), guest: Number(status.clientFinishTicks) };
    this.result = { winner, text, tuningPoints, battlePoints, record, ticks, recorded: true };
    this.store.addHistory({
      at: Date.now(), race: race.hex, result: text, course: race.rules.course, reverse: race.rules.reverse, car: race.localCar, opponent: race.names.remote,
      opponentCar: race.remoteCar, ticks: iAmHost ? ticks.host : ticks.guest, opponentTicks: iAmHost ? ticks.guest : ticks.host,
    });
    this.#set('results', text);
  }
  /** Called each frame while on the result screen with the player's edge-triggered input. */
  resultFrame({ confirm = false, cancel = false, direction = 0, blocked = false } = {}) {
    if (this.state !== 'results') return;
    if (this.mp.resultScreen(0) < 0) return;
    const flags = (blocked ? 1 : 0) | (this.peerLeft ? 2 : 0) | (this.remoteContinue ? 4 : 0);
    this.mp.resultInput(confirm, cancel, direction, flags);
    const decision = this.mp.resultScreen(2);
    if (decision === 2) this.leave();
    else if (decision === 1 && !this.localContinue) this.requestReturn();
  }
  /** Touch/mouse: a pointer position in the result screen's 640x480 space; returns true when it chose something. */
  resultPointer(x, y, click) {
    if (this.state !== 'results') return false;
    const choice = this.mp.resultHit(x, y);
    if (choice < 0) return false;
    this.mp.resultInput(click && choice === 0, click && choice === 1, choice === 0 ? -1 : 1, (this.peerLeft ? 2 : 0) | (this.remoteContinue ? 4 : 0));
    return true;
  }
  /** A click/tap at a position in the 640x480 result-screen space: advances the pages, then picks a button. */
  pointer(x, y, click) {
    if (this.state !== 'results') return false;
    if (this.mp.resultScreen(0) < 2) { if (click) this.resultFrame({ confirm: true }); return click; }
    return this.resultPointer(x, y, click);
  }
  get resultPage() { return this.state === 'results' ? this.mp.resultScreen(0) : -1; }

  // ---- back to the lobby -----------------------------------------------------------------------
  requestReturn() {
    if (this.state !== 'results' || this.localContinue) return;
    if (this.peerLeft) { this.#close('The other driver left.'); return; }
    this.localContinue = true;
    this.#tx({ t: 'ret', race: this.race.hex });
    if (this.host && this.remoteContinue) this.#beginReturn();
    this.onChange();
  }
  #onReturnRequest(m) {
    const race = this.race;
    if (!race || m.race !== race.hex) return;
    this.#require(race.native, 'The race has not finished.');
    this.remoteContinue = true;
    if (this.host && this.state === 'results' && this.localContinue) this.#beginReturn();
    this.onChange();
  }
  #beginReturn() {
    const race = this.race;
    this.rev += 1;
    this.#set('returning', 'Returning to the lobby.');
    this.#tx({ t: 'retlobby', race: race.hex, rev: this.rev });
  }
  #onReturnLobby(m) {
    const race = this.race;
    this.#require(!this.host, 'Invalid lobby return.');
    if (!race || m.race !== race.hex) return;
    this.#require(this.state === 'results' && this.localContinue && Number.isInteger(m.rev) && m.rev === this.rev + 1, 'Unexpected lobby return commit.');
    this.rev = m.rev;
    this.#toLobby(race.hex);
    this.#tx({ t: 'retack', race: race.hex, rev: this.rev, rec: this.localRecord });
  }
  #onReturnAck(m) {
    const race = this.race;
    this.#require(this.host && validRecord(m.rec), 'Invalid lobby return acknowledgement.');
    if (!race || m.race !== race.hex || this.state !== 'returning' || m.rev !== this.rev) return;
    this.remote = { ...this.remote, record: m.rec };
    this.#toLobby(race.hex);
    this.#sendLobby();
  }
  #toLobby(raceHex) {
    try { this.mp.leave(); } catch { /* ignore */ }
    this.race = null;
    this.lobbyRound = raceHex;
    this.localReady = this.guestReady = false;
    this.localContinue = this.remoteContinue = false;
    this.refreshGarage();
    this.#set('lobby', 'Both drivers are back in the lobby. Get ready for another race.');
  }

  // ---- leaving ------------------------------------------------------------------------------------
  /** Leave the room from anywhere (the other player is told). */
  leave() {
    if (this.state === 'closed') return;
    this.#tx({ t: 'leave' });
    this.#close('You left the room.');
  }

  // ---- what the UI shows -------------------------------------------------------------------------
  view() {
    const race = this.race;
    return {
      role: this.host ? 'host' : 'guest', state: this.state, status: this.status, error: this.error, handshake: this.handshake,
      name: this.name, remoteName: this.remoteName, ping: this.ping,
      garage: this.garage.map((g) => ({ selection: g.selection, label: g.label, car: g.car, saved: g.saved, slot: g.slot, automatic: g.automatic })),
      local: this.local && { selection: this.local.selection, car: this.local.car, carName: CAR_NAMES[this.local.car], automatic: this.local.automatic, label: this.garage.find((g) => g.selection === this.local.selection)?.label ?? CAR_NAMES[this.local.car] },
      remote: this.handshake ? { car: this.remote.car, carName: CAR_NAMES[this.remote.car], automatic: this.remote.automatic, record: this.remote.record } : null,
      rules: this.rules, courses: COURSES, direction: directionLabel(this.rules.course, this.rules.reverse),
      guestReady: this.guestReady, localReady: this.host ? true : this.localReady, canStart: this.canStart,
      canChat: this.state === 'lobby' && this.handshake, chat: this.chat.messages.map((c) => ({ ...c })),
      record: this.local ? this.localRecord : null, history: this.store.history().slice(-10).reverse(),
      race: race && { id: race.hex, released: race.released, course: race.rules.course, opponent: race.names.remote },
      result: this.result, resultPage: this.resultPage, peerLeft: this.peerLeft, localContinue: this.localContinue, remoteContinue: this.remoteContinue,
    };
  }
}
