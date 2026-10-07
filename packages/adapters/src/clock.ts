/** Time is injected everywhere (docs/12 section 4, docs/17 section 4). */
export interface Clock {
  /** Current instant as an ISO timestamp (UTC). */
  now(): string;
  /** Milliseconds since the epoch, for timeouts and backoff. */
  nowMs(): number;
  /** Today's business date (UTC) as YYYY-MM-DD. */
  today(): string;
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
  nowMs(): number {
    return Date.now();
  }
  today(): string {
    return this.now().slice(0, 10);
  }
}

/** A clock tests can set and advance. */
export class FixedClock implements Clock {
  private ms: number;
  constructor(iso: string) {
    this.ms = Date.parse(iso);
    if (Number.isNaN(this.ms)) throw new Error(`invalid timestamp ${iso}`);
  }
  now(): string {
    return new Date(this.ms).toISOString();
  }
  nowMs(): number {
    return this.ms;
  }
  today(): string {
    return this.now().slice(0, 10);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}
