// JS side of the core's online-race C ABI (Native/src/unity_bridge.h, "Idas3Multiplayer*"). Works with any
// instantiated core module (the browser worker or a Node test), so two cores can race each other in a test.
//
// A race is "input authority" version 2: both players run the whole two-car simulation and exchange only
// their controls (Idas3MultiplayerAuthorityPacket / Receive). The core rolls back and replays when a late
// packet differs from its prediction, so the transport may drop and reorder packets.
//
// Struct layouts are wasm32 = LP64 for these structs because none of them holds a pointer (checked against the
// static_asserts in Native/src/native_multiplayer.h).

export const WORDS = 307;                 // a car profile is 307 u32 words (original battle profile)
export const MAX_AUTHORITY_PACKET = 1064;
export const MIN_AUTHORITY_PACKET = 40;
export const WINNER = { UNDECIDED: -3, BOTH_TIME_UP: -1, HOST: 0, GUEST: 1, DRAW: 2 };
export const CAR_COUNT = 35;

// The words of a car profile that a peer may send and that the other core accepts (byte offsets / 4, see
// Idas3OnlineCar in Assets/Scripts/Multiplayer and Idas3MultiplayerStartSaved): car, physics profile,
// driver name glyphs, paint, parts and appearance flags. Tuning, balances and progress never leave a device.
export const APPEARANCE_WORDS = [4, 6, 11, 12, 13, 14, 15, 16, 19, 38, 39, 40, 41];

export const carOf = (words) => words[4];
export const isAutomatic = (words) => words[17] === 0;

/** The part of a profile that is sent to the other player. */
export function appearanceOf(words) {
  return APPEARANCE_WORDS.map((i) => words[i] >>> 0);
}

/**
 * Rebuilds a 307-word profile from what a peer sent, applying the same bounds the desktop game checks
 * (Idas3OnlineCar.Read). Throws on anything out of range; the core validates again in StartSaved.
 */
export function remoteWordsFrom(appearance, expectedCar) {
  if (!Array.isArray(appearance) || appearance.length !== APPEARANCE_WORDS.length) throw new Error('invalid car description');
  const words = new Uint32Array(WORDS);
  APPEARANCE_WORDS.forEach((index, i) => {
    const v = appearance[i];
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error('invalid car description');
    words[index] = v;
  });
  if (!Number.isInteger(expectedCar) || expectedCar < 0 || expectedCar >= CAR_COUNT || words[4] !== expectedCar) throw new Error('invalid car selection');
  if (words[19] > 5 || words[16] >= 93) throw new Error('invalid car paint');
  for (let i = 11; i <= 15; ++i) if (words[i] > 220) throw new Error('invalid driver name glyph');
  for (let offset = 156; offset < 164; ++offset) if (((words[offset >> 2] >>> ((offset & 3) * 8)) & 255) > 6) throw new Error('invalid body part');
  if (words[6] > 31 || (words[41] & 255) >= 76) throw new Error('invalid physics profile');
  if (((words[41] >>> 8) & 255) > 3 || ((words[41] >>> 16) & 255) > 3) throw new Error('invalid appearance flags');
  return words;
}

export class MpCore {
  /** @param mod instantiated core module   @param core the Core wrapper from abi.js (for error text) */
  constructor(mod, core) {
    this.mod = mod;
    this.core = core;
    this.cfg = mod._malloc(40);
    this.localWords = mod._malloc(WORDS * 4);
    this.remoteWords = mod._malloc(WORDS * 4);
    this.packetBuf = mod._malloc(MAX_AUTHORITY_PACKET + 64);
    this.statusBuf = mod._malloc(96);
    this.snapBuf = mod._malloc(128);
    this.recBuf = mod._malloc(16 * 3 + 16);
    this.textBuf = mod._malloc(256);
  }

  #ok(value, what) {
    if (value !== 1) throw new Error(`${what}: ${this.core?.error?.() || 'failed'}`);
  }
  #dv() { return new DataView(this.mod.HEAPU8.buffer); }
  #put(ptr, words) {
    const heap = new Uint32Array(this.mod.HEAPU8.buffer, ptr, WORDS);
    heap.set(words);
  }

  /**
   * Saved-car query. selection 5+car is the stock car `car` (always available); 0..4 is a save slot's
   * car, 40+slot*35+car a car driven in that slot. Returns {saved, words:Uint32Array(307)} or null.
   */
  readCar(selection) {
    const found = this.mod._Idas3MultiplayerReadCar(selection, this.localWords, WORDS);
    if (found < 0) throw new Error(`Idas3MultiplayerReadCar: ${this.core?.error?.() || 'failed'}`);
    if (found === 0) return null;
    const words = new Uint32Array(this.mod.HEAPU8.buffer, this.localWords, WORDS).slice();
    return { saved: found === 1, words, car: carOf(words), automatic: isAutomatic(words) };
  }

  /** Selection id of the car the menus currently have chosen (5+car for a stock car, a save slot otherwise), -1 if none. */
  currentCar() { return this.mod._Idas3MultiplayerCurrentCar(); }

  /**
   * Loads the race and holds all simulation until setGo(1). `local` is exactly what readCar(selection)
   * returned; `remote` only contributes appearance and physics-profile words (the core ignores the rest).
   */
  start(cfg, selection, localWords, remoteWords) {
    const dv = this.#dv();
    const p = this.cfg;
    const fields = [40, 2, cfg.course, cfg.reverse ? 1 : 0, cfg.wet ? 1 : 0, cfg.night ? 1 : 0, cfg.localCar, cfg.remoteCar,
      cfg.localSlot, cfg.automatic ? 1 : 0];
    fields.forEach((v, i) => dv.setUint32(p + i * 4, v >>> 0, true));
    this.#put(this.localWords, localWords);
    this.#put(this.remoteWords, remoteWords);
    this.#ok(this.mod._Idas3MultiplayerStartSaved(p, selection, this.localWords, this.remoteWords, WORDS), 'StartSaved');
  }
  /** Race identity is shared by both players (the host chooses it); BigInt. */
  enableAuthority(race, remoteAutomatic, boost, collisions) {
    this.#ok(this.mod._Idas3MultiplayerEnableAuthorityRules(BigInt(race), remoteAutomatic ? 1 : 0, boost ? 1 : 0, collisions ? 1 : 0), 'EnableAuthorityRules');
  }
  setNames(local, opponent) {
    const m = this.mod;
    const a = this.#cstring(local), b = this.#cstring(opponent);
    const ok = m._Idas3SceneSetPreRaceNames(a, b);
    m._free(a); m._free(b);
    this.#ok(ok, 'SetPreRaceNames');
  }
  #cstring(text) {
    const m = this.mod, n = m.lengthBytesUTF8(text) + 1, p = m._malloc(n);
    m.stringToUTF8(text, p, n);
    return p;
  }
  setBattleRecords(local, remote) {
    const dv = this.#dv(), p = this.recBuf;
    [local, remote].forEach((r, i) => {
      dv.setUint32(p + i * 16, r.battles >>> 0, true); dv.setUint32(p + i * 16 + 4, r.wins >>> 0, true);
      dv.setUint32(p + i * 16 + 8, r.level >>> 0, true); dv.setUint32(p + i * 16 + 12, r.streak >>> 0, true);
    });
    this.#ok(this.mod._Idas3MultiplayerSetBattleRecords(p, p + 16), 'SetBattleRecords');
  }
  /** Release the showcase / VS sequence; the countdown and the race follow. */
  setGo(released = 1) { this.#ok(this.mod._Idas3MultiplayerSetGo(released), 'SetGo'); }

  // ---- input authority -----------------------------------------------------------------------
  /** The packet to send for the newest simulated frame (own controls plus the verified history). */
  packet() {
    const n = this.mod._Idas3MultiplayerAuthorityPacket(this.packetBuf, MAX_AUTHORITY_PACKET);
    if (n < MIN_AUTHORITY_PACKET || n > MAX_AUTHORITY_PACKET) throw new Error(`AuthorityPacket: ${this.core?.error?.() || 'bad size ' + n}`);
    return new Uint8Array(this.mod.HEAPU8.buffer, this.packetBuf, n).slice();
  }
  /** Feed the peer's packet. Throws on a malformed or foreign one (the session then ends the race). */
  receive(bytes) {
    if (bytes.length < MIN_AUTHORITY_PACKET || bytes.length > MAX_AUTHORITY_PACKET) throw new Error('authority packet length');
    this.mod.HEAPU8.set(bytes, this.packetBuf);
    this.#ok(this.mod._Idas3MultiplayerAuthorityReceive(this.packetBuf, bytes.length), 'AuthorityReceive');
  }
  setRemoteHeadlights(sequence, enabled) {
    this.#ok(this.mod._Idas3MultiplayerSetRemoteHeadlights(BigInt(sequence), enabled ? 1 : 0), 'SetRemoteHeadlights');
  }
  /** Idas3AuthorityStatus. winner: -3 undecided, -1 both time up, 0 host, 1 guest, 2 draw. */
  status() {
    const dv = this.#dv(), p = this.statusBuf;
    dv.setUint32(p, 96, true); dv.setUint32(p + 4, 1, true);
    this.#ok(this.mod._Idas3MultiplayerAuthorityStatus(p), 'AuthorityStatus');
    const d = this.#dv();
    return {
      frame: Number(d.getBigUint64(p + 8, true)), confirmed: Number(d.getBigUint64(p + 16, true)),
      verified: Number(d.getBigUint64(p + 24, true)), contactFrames: Number(d.getBigUint64(p + 32, true)),
      rollbacks: Number(d.getBigUint64(p + 40, true)), replayedFrames: Number(d.getBigUint64(p + 48, true)),
      maxDepth: d.getUint32(p + 56, true), stalled: d.getUint32(p + 60, true),
      maxCorrection: d.getFloat32(p + 64, true), maxReplayMs: d.getFloat32(p + 68, true),
      winner: d.getInt32(p + 72, true),
      hostFinishTicks: d.getBigUint64(p + 80, true), clientFinishTicks: d.getBigUint64(p + 88, true),
    };
  }
  /** Own car's state; only what the session needs (headlamps are replicated by the session, not the core). */
  localSnapshot() {
    const dv = this.#dv(), p = this.snapBuf;
    dv.setUint32(p, 128, true); dv.setUint32(p + 4, 1, true);
    this.#ok(this.mod._Idas3MultiplayerGetLocalSnapshot(p), 'GetLocalSnapshot');
    const d = this.#dv();
    return { sequence: d.getBigUint64(p + 8, true), raceTicks: d.getBigUint64(p + 16, true), flags: d.getUint32(p + 24, true), car: d.getUint32(p + 28, true) };
  }

  // ---- result --------------------------------------------------------------------------------
  /** Commit the settled result (tuning reward for the car, original result menus). Repeating it is a no-op. */
  setResult(winner) { this.#ok(this.mod._Idas3MultiplayerSetResult(winner), 'SetResult'); return this.mod._Idas3MultiplayerPointsEarned(); }
  /** Battle points + level shown on the original result screen. */
  resultRecord(points, level) { this.#ok(this.mod._Idas3MultiplayerResultRecord(points, level), 'ResultRecord'); }
  /** field 0 current page (0..2), 2 decision (0 none, 1 return to lobby, 2 leave); <0 when no result screen. */
  resultScreen(field = 0) { return this.mod._Idas3MultiplayerResultScreen(field); }
  /** flags: 1 blocked, 2 peer left, 4 peer ready, 8 record save failed. */
  resultInput(confirm, cancel, direction, flags = 0) {
    this.#ok(this.mod._Idas3MultiplayerResultInput(confirm ? 1 : 0, cancel ? 1 : 0, direction | 0, flags >>> 0), 'ResultInput');
  }
  /** Pointer hit in the 640x480 source space: -1 none, 0 the "go again" button, 1 the other one. */
  resultHit(x, y) { return this.mod._Idas3MultiplayerResultHit(x, y); }
  /** The original progression arithmetic: {record, experience} after a win/loss against `opponent`. */
  nextRecord(before, won, opponent, experience) {
    const dv = this.#dv(), p = this.recBuf;
    const put = (at, r) => { dv.setUint32(p + at, r.battles >>> 0, true); dv.setUint32(p + at + 4, r.wins >>> 0, true); dv.setUint32(p + at + 8, r.level >>> 0, true); dv.setUint32(p + at + 12, r.streak >>> 0, true); };
    put(0, before); put(16, opponent);
    const out = p + 32, exp = p + 48;
    this.#ok(this.mod._Idas3MultiplayerNextBattleRecord(p, won ? 1 : 0, p + 16, experience >>> 0, out, exp), 'NextBattleRecord');
    const d = this.#dv();
    return {
      record: { battles: d.getUint32(out, true), wins: d.getUint32(out + 4, true), level: d.getUint32(out + 8, true), streak: d.getUint32(out + 12, true) },
      experience: d.getUint32(exp, true),
    };
  }

  // ---- ending --------------------------------------------------------------------------------
  /** Neutral terminal finish (the peer vanished): keeps the race owner until leave(). */
  disconnect() { this.mod._Idas3MultiplayerDisconnect(); }
  /** Give the core back to the normal menus. */
  leave() { return this.mod._Idas3MultiplayerLeave(); }
}
