/**
 * Removes secret values from any text before it leaves the server
 * (tool results, error messages, logs). CLAUDE.md, principle 3.
 */
export const REDACTED = "[REDACTED]";

export class Redactor {
  private readonly needles: string[];

  constructor(secrets: readonly string[]) {
    const forms = new Set<string>();
    for (const s of secrets) {
      if (s.length < 4) continue; // too short to redact meaningfully; config refuses these anyway
      forms.add(s);
      forms.add(encodeURIComponent(s));
      forms.add(JSON.stringify(s).slice(1, -1)); // JSON-escaped form
    }
    // Longest first so a secret that contains another is fully replaced.
    this.needles = [...forms].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const n of this.needles) out = out.split(n).join(REDACTED);
    return out;
  }

  /** Redact every string inside a JSON-like value. */
  redactValue<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[this.redact(k)] = this.redactValue(v);
      return out as T;
    }
    return value;
  }
}

/** Logger writing to stderr (stdout belongs to the MCP stdio transport), always redacted. */
export class Logger {
  constructor(private readonly redactor: Redactor) {}

  error(message: string, err?: unknown): void {
    const detail = err === undefined ? "" : ` ${err instanceof Error ? err.message : String(err)}`;
    console.error(this.redactor.redact(`[anvil-hammer-mcp] ${message}${detail}`));
  }
}
