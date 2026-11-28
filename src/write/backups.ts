/**
 * Local backups: a full copy of an element saved before any modification or
 * deletion (CLAUDE.md, principle 4). One JSON file per backup:
 *   <dir>/<worldId>/<type>/<elementId>/<timestamp>-<reason>.json
 * Files are written atomically with owner-only permissions.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Json } from "../api/client.js";

export type BackupReason = "update" | "delete" | "restore";

export interface BackupMeta {
  type: string;
  id: string;
  worldId: string;
  reason: BackupReason;
  granularity: string;
  takenAt: string;
}

export interface Backup extends BackupMeta {
  /** File name, used as the backup's id in wa_restore. */
  backupId: string;
  /** The raw World Anvil response, uncompacted. */
  element: Json;
}

export class BackupError extends Error {
  override name = "BackupError";
}

/** Path segments come from World Anvil IDs; refuse anything that could escape the folder. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
const BACKUP_FILE = /^\d{8}T\d{9}Z-[a-z0-9]{6}-(update|delete|restore)\.json$/;

function segment(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value))
    throw new BackupError(`Unsafe ${what} for a backup path: ${JSON.stringify(value)}`);
  return value;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** File names start with the UTC time the backup was taken: YYYYMMDDTHHMMSSmmmZ. */
export function takenAtFromFile(name: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(name);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

export class BackupStore {
  constructor(
    private readonly dir: string,
    private readonly retentionDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private elementDir(worldId: string, type: string, id: string): string {
    return join(
      this.dir,
      segment(worldId, "world id"),
      segment(type, "type"),
      segment(id, "element id"),
    );
  }

  private ensureDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  /** Save a backup. Throws BackupError on any failure: callers must then refuse the write. */
  save(meta: Omit<BackupMeta, "takenAt">, element: Json): Backup {
    const takenAt = this.now();
    const stamp = takenAt
      .toISOString()
      .replace(/[-:.]/g, "")
      .replace(/(\d{8}T\d{6})(\d{3})Z/, "$1$2Z");
    const backupId = `${stamp}-${randomBytes(3).toString("hex")}-${meta.reason}.json`;
    const full: Backup = { ...meta, takenAt: takenAt.toISOString(), backupId, element };
    try {
      this.ensureDir(this.dir);
      const dir = this.elementDir(meta.worldId, meta.type, meta.id);
      this.ensureDir(dir);
      const file = join(dir, backupId);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
    } catch (err) {
      if (err instanceof BackupError) throw err;
      throw new BackupError(`Could not save the backup: ${(err as Error).message}`);
    }
    this.cleanup();
    return full;
  }

  /** Backups of one element, newest first (looked up across worlds). */
  list(type: string, id: string): Backup[] {
    segment(type, "type");
    segment(id, "element id");
    if (!existsSync(this.dir)) return [];
    const out: Backup[] = [];
    for (const world of readdirSync(this.dir)) {
      const dir = join(this.dir, world, type, id);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!BACKUP_FILE.test(f)) continue;
        try {
          out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Backup);
        } catch {
          // A corrupt file is skipped, not fatal.
        }
      }
    }
    return out.sort((a, b) => b.backupId.localeCompare(a.backupId));
  }

  get(type: string, id: string, backupId: string): Backup | undefined {
    if (!BACKUP_FILE.test(backupId))
      throw new BackupError(`Not a backup id: ${JSON.stringify(backupId)}`);
    return this.list(type, id).find((b) => b.backupId === backupId);
  }

  /** Delete backups older than the retention period. Never throws. */
  cleanup(): number {
    const cutoff = this.now().getTime() - this.retentionDays * DAY_MS;
    let removed = 0;
    const walk = (path: string, depth: number) => {
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(path, e);
        if (depth < 3) {
          walk(p, depth + 1);
          continue;
        }
        if (!BACKUP_FILE.test(e)) continue;
        const taken = takenAtFromFile(e);
        if (taken !== undefined && taken < cutoff) {
          try {
            rmSync(p);
            removed++;
          } catch {
            // ignore
          }
        }
      }
    };
    walk(this.dir, 0);
    return removed;
  }
}
