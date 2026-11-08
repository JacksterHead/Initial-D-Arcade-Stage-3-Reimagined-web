// Battle records kept on this device, per car, like Assets/Scripts/Multiplayer/Idas3MultiplayerRecords.cs.
// The progression arithmetic (levels, streaks, experience) is the core's own (MpCore.nextRecord); this class
// only stores it, makes a result idempotent per race, and keeps a short history of recent matches.
//
// `storage` is {load(): string|null, save(text)}; the worker backs it with a file in the IndexedDB-synced save
// folder and tests use memory.

const VERSION = 1;
const MAX_RECEIPTS = 32;
const MAX_HISTORY = 50;

export const freshRecord = () => ({ battles: 0, wins: 0, level: 1, streak: 0 });

export function validRecord(r) {
  return !!r && ['battles', 'wins', 'level', 'streak'].every((k) => Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= 0xffffff)
    && r.level >= 1 && r.level <= 99 && r.wins <= r.battles;
}

export class RecordStore {
  constructor(storage) {
    this.storage = storage;
    this.state = { version: VERSION, cars: {}, history: [] };
    try {
      const text = storage.load();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed && parsed.version === VERSION && typeof parsed.cars === 'object' && Array.isArray(parsed.history)) this.state = parsed;
      }
    } catch { /* unreadable: start fresh; the next save replaces it */ }
  }
  #entry(car) {
    const e = this.state.cars[car];
    if (e && validRecord(e.record) && Number.isInteger(e.experience) && e.experience >= 0 && e.experience <= 99 && Array.isArray(e.receipts)) return e;
    return { record: freshRecord(), experience: 0, receipts: [] };
  }
  read(car) { return { ...this.#entry(car).record }; }
  experience(car) { return this.#entry(car).experience; }
  /** Points the original result screen shows: levels gained * 100 + experience gained. */
  static levelPoints(record, experience) { return (record.level - 1) * 100 + experience; }
  readLevelPoints(car) { const e = this.#entry(car); return RecordStore.levelPoints(e.record, e.experience); }

  /**
   * Applies a won/lost result once per race id. `advance(before, won, opponent, experience)` is the core's
   * evaluator. Returns {record, battlePoints, repeated}.
   */
  commit(car, raceId, won, opponent, advance) {
    const entry = this.#entry(car);
    const id = String(raceId);
    const seen = entry.receipts.find((r) => r.raceId === id);
    if (seen) {
      if (seen.won !== won) throw new Error('Conflicting result for a recorded race.');
      return { record: { ...entry.record }, battlePoints: seen.battlePoints ?? 0, repeated: true };
    }
    if (!validRecord(opponent)) throw new Error('Invalid opponent record.');
    const beforePoints = RecordStore.levelPoints(entry.record, entry.experience);
    const next = advance({ ...entry.record }, won, { ...opponent }, entry.experience);
    if (!validRecord(next.record) || !(next.experience >= 0 && next.experience <= 99)) throw new Error('Invalid record from the core.');
    const battlePoints = RecordStore.levelPoints(next.record, next.experience) - beforePoints;
    const receipts = [...entry.receipts, { raceId: id, won, battlePoints }].slice(-MAX_RECEIPTS);
    this.state.cars[car] = { record: next.record, experience: next.experience, receipts };
    this.#persist();
    return { record: { ...next.record }, battlePoints, repeated: false };
  }

  /** One line per finished race, newest last. `entry` is plain data (names, courses, result text). */
  addHistory(entry) {
    this.state.history = [...this.state.history, entry].slice(-MAX_HISTORY);
    this.#persist();
  }
  history() { return this.state.history.map((h) => ({ ...h })); }
  /** Every car with a recorded battle, most raced first. */
  summary() {
    const cars = Object.keys(this.state.cars).map(Number).filter(Number.isInteger).map((car) => ({ car, record: this.read(car) }))
      .filter((c) => c.record.battles > 0).sort((a, b) => b.record.battles - a.record.battles);
    return { cars, history: this.history() };
  }

  #persist() {
    try { this.storage.save(JSON.stringify(this.state)); } catch (e) { this.lastError = e; }
  }
}
