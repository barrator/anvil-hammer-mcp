/**
 * Technical log (hosted mode): JSON Lines, one file per UTC day in the logs
 * volume. Tool calls record identifiers and outcome only (tool, world, element
 * ID, duration, result); authentication events record the client address.
 * Never content, never a key: every line also goes through the redactor.
 * Files older than the retention period (180 days by default) are deleted.
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../redact.js";
import type { ToolCallRecord } from "../tools/context.js";

export const DEFAULT_LOG_RETENTION_DAYS = 180;
const FILE = /^technical-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type AuthLogEntry = {
  kind: string;
  ip?: string;
  client?: string;
  reason?: string;
  status?: number;
  grant?: string;
  families?: number;
};

export type LogEntry =
  | ({ event: "tool" } & ToolCallRecord)
  | ({ event: "auth" } & AuthLogEntry)
  | { event: "server"; kind: string; detail?: string };

export class TechLog {
  private warned = false;

  constructor(
    private readonly dir: string,
    private readonly retentionDays: number,
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  write(entry: LogEntry): void {
    const ts = this.now().toISOString();
    const line = this.redactor.redact(JSON.stringify({ ts, ...entry }));
    try {
      appendFileSync(join(this.dir, `technical-${ts.slice(0, 10)}.jsonl`), `${line}\n`, {
        mode: 0o600,
      });
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.error(
          `[anvil-hammer-mcp] Cannot write the technical log in ${this.dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Delete day files older than the retention period (by the date in the name). */
  prune(): number {
    const cutoff = this.now().getTime() - this.retentionDays * 86_400_000;
    let removed = 0;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const m = FILE.exec(name);
      if (!m) continue;
      // A day file is kept until its whole day is older than the cutoff.
      const end = Date.parse(`${m[1]}T00:00:00Z`) + 86_400_000;
      if (end <= cutoff) {
        try {
          unlinkSync(join(this.dir, name));
          removed++;
        } catch {
          // Leave it for the next pass.
        }
      }
    }
    return removed;
  }
}
