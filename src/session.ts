/**
 * Per-MCP-session state. In HTTP mode several clients share one process, so
 * nothing here is global: each session id gets its own state.
 */

export interface SeenUpdate {
  /** updateDate exactly as World Anvil returned it, serialized for comparison. */
  updateDate: string;
  readAt: number;
}

export class SessionState {
  /** `${type}:${id}` → last updateDate seen by this session (used by stage B). */
  readonly updateDates = new Map<string, SeenUpdate>();
  /** `${type}:${id}` → world id it belongs to. */
  readonly worlds = new Map<string, string>();

  rememberUpdateDate(type: string, id: string, updateDate: unknown, now = Date.now()): void {
    if (updateDate === undefined || updateDate === null || updateDate === "") return;
    this.updateDates.set(`${type}:${id}`, { updateDate: JSON.stringify(updateDate), readAt: now });
  }

  lastUpdateDate(type: string, id: string): SeenUpdate | undefined {
    return this.updateDates.get(`${type}:${id}`);
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
