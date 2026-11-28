/**
 * Live-test report. It holds only structure: field names, counts, booleans
 * and HTTP facts. Never titles, content, IDs or names (the repository is public
 * and the report is meant to be pasted into a pull request).
 */
import { writeFileSync } from "node:fs";
import { RESPONSE_FLAGS } from "../src/output/compact.js";
import { REGISTRY } from "../src/registry/index.js";

export interface TypeObservation {
  listed: number;
  listFields: string[];
  sampled: number;
  /** field → JSON kinds seen with a non-empty value (stage E). */
  kinds?: Record<string, string[]>;
  /** verb → "ok" or the error kind (stage E). */
  routes?: Record<string, string>;
  /** BBCode-assumed fields: how many values held BBCode-like tags, and how many did not. */
  bbcode?: Record<string, { withTags: number; plain: number }>;
  /** granularity → observation */
  granularities: Record<
    string,
    { fields: string[]; withWorldField: number; withParentLink: Record<string, number>; of: number }
  >;
  templateTypes?: Record<string, number>;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export class LiveReport {
  readonly checks: Check[] = [];
  readonly types: Record<string, TypeObservation> = {};
  readonly quirks: Record<string, unknown> = {};

  /** IDs (test world, created elements) to mask in details, on top of any UUID. */
  private readonly hidden = new Set<string>();

  hide(...ids: string[]): void {
    for (const id of ids) if (id) this.hidden.add(id);
  }

  /** Details may quote server messages: never let an ID or a UUID through. */
  private sanitize(text: string): string {
    let out = text.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<id>",
    );
    for (const id of this.hidden) out = out.split(id).join("<id>");
    return out.replace(/\s+/g, " ").slice(0, 300);
  }

  check(name: string, ok: boolean, detail?: string): void {
    this.checks.push({ name, ok, ...(detail ? { detail: this.sanitize(detail) } : {}) });
  }

  get failed(): Check[] {
    return this.checks.filter((c) => !c.ok);
  }

  /** Make the run fail when any check failed, including checks made in afterAll. */
  assertAllPassed(): void {
    const failed = this.failed;
    if (failed.length) {
      throw new Error(
        `${failed.length} live check(s) failed: ${failed.map((c) => c.name).join("; ")}`,
      );
    }
  }

  type(name: string): TypeObservation {
    this.types[name] ??= { listed: 0, listFields: [], sampled: 0, granularities: {} };
    return this.types[name];
  }

  /** Registry fields seen in real responses → candidates to mark verified. */
  registryComparison() {
    const out: Record<
      string,
      { observed: string[]; notObserved: string[]; notInRegistry: string[] }
    > = {};
    for (const [name, obs] of Object.entries(this.types)) {
      const def = REGISTRY[name];
      if (!def) continue;
      const seen = new Set(
        [...obs.listFields, ...Object.values(obs.granularities).flatMap((g) => g.fields)].filter(
          (f) => !RESPONSE_FLAGS.has(f),
        ),
      );
      const known = Object.keys(def.fields);
      out[name] = {
        observed: known.filter((f) => seen.has(f)).sort(),
        notObserved: known.filter((f) => !seen.has(f)).sort(),
        notInRegistry: [...seen].filter((f) => !known.includes(f)).sort(),
      };
    }
    return out;
  }

  /**
   * What observed.ts may take from this run (stage E): registry fields seen,
   * the single JSON kind seen for each (when one), and the verbs that worked.
   */
  promotion() {
    const out: Record<
      string,
      { fields: string[]; kinds: Record<string, string>; verbs: string[] }
    > = {};
    for (const [name, cmp] of Object.entries(this.registryComparison())) {
      const obs = this.types[name]!;
      const kinds: Record<string, string> = {};
      for (const f of cmp.observed) {
        const k = (obs.kinds?.[f] ?? []).filter((x) => x !== "null");
        if (k.length === 1) kinds[f] = k[0]!;
      }
      const verbs = Object.entries(obs.routes ?? {})
        .filter(([, v]) => v === "ok")
        .map(([k]) => k)
        .sort();
      out[name] = { fields: cmp.observed, kinds, verbs };
    }
    return out;
  }

  toJSON() {
    return {
      generatedAt: new Date().toISOString(),
      checks: this.checks,
      quirks: this.quirks,
      types: this.types,
      registry: this.registryComparison(),
      promotion: this.promotion(),
    };
  }

  write(file: string): void {
    writeFileSync(file, JSON.stringify(this.toJSON(), null, 2) + "\n");
  }

  summary(): string {
    const lines = ["Live read run — structure only, no real data", ""];
    for (const c of this.checks)
      lines.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    lines.push("");
    for (const [name, obs] of Object.entries(this.types)) {
      const g = Object.entries(obs.granularities)
        .map(
          ([k, v]) =>
            `g${k}: world ${v.withWorldField}/${v.of}${Object.entries(v.withParentLink)
              .map(([f, n]) => `, ${f} ${n}/${v.of}`)
              .join("")}`,
        )
        .join("; ");
      lines.push(`${name}: listed ${obs.listed}, sampled ${obs.sampled}. ${g}`);
    }
    lines.push("", "Quirks:", JSON.stringify(this.quirks, null, 2));
    return lines.join("\n");
  }
}
