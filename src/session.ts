/**
 * Per-MCP-session state. In HTTP mode several clients share one process, so
 * nothing here is global: each session id gets its own state.
 */

/**
 * Normalize an updateDate for comparison. World Anvil returns an object
 * {date, timezone_type, timezone}; callers may pass the date string alone.
 */
export function normalizeUpdateDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && typeof (value as { date?: unknown }).date === "string") {
    return (value as { date: string }).date.trim();
  }
  return JSON.stringify(value);
}

export interface SeenUpdate {
  /** Normalized updateDate (see normalizeUpdateDate). */
  updateDate: string;
  readAt: number;
}

export class SessionState {
  /** `${type}:${id}` → last updateDate seen by this session. */
  readonly updateDates = new Map<string, SeenUpdate>();
  /**
   * `${type}:${id}` → content last seen, for elements that come back without
   * an updateDate (conflict detection then compares content instead).
   */
  readonly contents = new Map<string, Record<string, unknown>>();
  /** `${type}:${id}` → world id it belongs to. */
  readonly worlds = new Map<string, string>();

  rememberUpdateDate(type: string, id: string, updateDate: unknown, now = Date.now()): void {
    const normalized = normalizeUpdateDate(updateDate);
    if (normalized === undefined) return;
    this.updateDates.set(`${type}:${id}`, { updateDate: normalized, readAt: now });
  }

  /** Remember what a read returned: its updateDate, or its content when it has none. */
  rememberRead(type: string, id: string, element: Record<string, unknown>, now = Date.now()): void {
    const key = `${type}:${id}`;
    if (normalizeUpdateDate(element.updateDate) !== undefined) {
      this.rememberUpdateDate(type, id, element.updateDate, now);
      this.contents.delete(key);
    } else {
      this.updateDates.delete(key);
      this.contents.set(key, element);
    }
  }

  lastUpdateDate(type: string, id: string): SeenUpdate | undefined {
    return this.updateDates.get(`${type}:${id}`);
  }

  lastContent(type: string, id: string): Record<string, unknown> | undefined {
    return this.contents.get(`${type}:${id}`);
  }

  /** Forget an element (after it was deleted). */
  forget(type: string, id: string): void {
    this.updateDates.delete(`${type}:${id}`);
    this.contents.delete(`${type}:${id}`);
    this.worlds.delete(`${type}:${id}`);
  }
}

/** stdio has a single session and no session id. */
export const DEFAULT_SESSION = "default";

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  get(sessionId: string | undefined): SessionState {
    const key = sessionId ?? DEFAULT_SESSION;
    let s = this.sessions.get(key);
    if (!s) {
      s = new SessionState();
      this.sessions.set(key, s);
    }
    return s;
  }

  /** Drop a session's state when it closes (HTTP mode). */
  end(sessionId: string | undefined): void {
    this.sessions.delete(sessionId ?? DEFAULT_SESSION);
  }

  get count(): number {
    return this.sessions.size;
  }
}
