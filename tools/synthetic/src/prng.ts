/**
 * Deterministic pseudo-random numbers (mulberry32). Same seed, same output, on every platform.
 * Not for anything security related; this only shapes synthetic data (docs/14 section 1).
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }

  /** Weighted pick: weights need not sum to one. */
  weighted<T>(items: readonly { value: T; weight: number }[]): T {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = this.next() * total;
    for (const i of items) {
      r -= i.weight;
      if (r <= 0) return i.value;
    }
    const last = items[items.length - 1];
    if (last === undefined) throw new Error('weighted pick from an empty list');
    return last.value;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i];
      const b = out[j];
      if (a !== undefined && b !== undefined) {
        out[i] = b;
        out[j] = a;
      }
    }
    return out;
  }

  /** A RFC 4122 version 4 shaped UUID drawn from this generator (deterministic). */
  uuid(): string {
    const bytes: number[] = [];
    for (let i = 0; i < 16; i++) bytes.push(this.int(0, 255));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /** A money amount string with two decimals, roughly log-uniform between min and max. */
  money(min: number, max: number): string {
    const v = Math.exp(Math.log(min) + this.next() * (Math.log(max) - Math.log(min)));
    return (Math.round(v * 100) / 100).toFixed(2);
  }

  /** A decimal in [min, max] with the given number of places, as a string. */
  decimal(min: number, max: number, places: number): string {
    const v = min + this.next() * (max - min);
    return v.toFixed(places);
  }
}
