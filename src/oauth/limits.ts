/**
 * In-memory counters for the authorization page. Single process, single user:
 * nothing here needs to survive a restart.
 */

interface Window {
  max: number;
  windowMs: number;
}

/** Sliding-window counter of events per key. */
class EventWindow {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly w: Window,
    private readonly now: () => number,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.w.windowMs;
    const kept = (this.events.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.events.set(key, kept);
    else this.events.delete(key);
    return kept;
  }

  full(key: string): boolean {
    return this.recent(key).length >= this.w.max;
  }

  /** Seconds until the oldest counted event leaves the window. */
  retryAfter(key: string): number {
    const oldest = this.recent(key)[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + this.w.windowMs - this.now()) / 1000));
  }

  add(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.events.set(key, list);
    // Bound memory: forget the oldest keys if an attacker rotates addresses.
    if (this.events.size > 10_000) {
      const first = this.events.keys().next().value;
      if (first !== undefined) this.events.delete(first);
    }
  }

  clear(key: string): void {
    this.events.delete(key);
  }
}

const GLOBAL = "*";

export interface AttemptLimits {
  perIp: Window;
  global: Window;
}

export const DEFAULT_ATTEMPT_LIMITS: AttemptLimits = {
  perIp: { max: 5, windowMs: 15 * 60_000 },
  global: { max: 20, windowMs: 60 * 60_000 },
};

/**
 * Failed passphrase attempts: 5 per address per 15 minutes and 20 in total per
 * hour. The global limit also holds when an attacker changes addresses; it can
 * delay the owner's next sign-in, but tokens already issued keep working.
 */
export class AttemptLimiter {
  private readonly perIp: EventWindow;
  private readonly global: EventWindow;

  constructor(limits: AttemptLimits = DEFAULT_ATTEMPT_LIMITS, now: () => number = Date.now) {
    this.perIp = new EventWindow(limits.perIp, now);
    this.global = new EventWindow(limits.global, now);
  }

  /** Seconds to wait before another attempt is allowed, or 0. */
  blockedFor(ip: string): number {
    const waits = [
      this.perIp.full(ip) ? this.perIp.retryAfter(ip) : 0,
      this.global.full(GLOBAL) ? this.global.retryAfter(GLOBAL) : 0,
    ];
    return Math.max(...waits);
  }

  fail(ip: string): void {
    this.perIp.add(ip);
    this.global.add(GLOBAL);
  }

  succeed(ip: string): void {
    this.perIp.clear(ip);
  }
}

/** Plain request rate limit per key (e.g. authorization requests per address). */
export class RateLimiter {
  private readonly w: EventWindow;

  constructor(limit: Window, now: () => number = Date.now) {
    this.w = new EventWindow(limit, now);
  }

  /** Count one request; false when the key is over its limit. */
  take(key: string): boolean {
    if (this.w.full(key)) return false;
    this.w.add(key);
    return true;
  }
}
