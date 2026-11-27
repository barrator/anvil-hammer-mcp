import { PAGE_SIZE, USER_AGENT, WORLD_ANVIL_BASE_URL } from "../constants.js";
import type { Secrets } from "../config/secrets.js";
import { Redactor } from "../redact.js";

export type Json = Record<string, unknown>;
export type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

export type ApiErrorKind =
  | "not_found" // 404, or an HTML "page not found" response
  | "unauthorized" // 401
  | "forbidden" // 403
  | "rejected" // 400 / 422, or success:false
  | "rate_limited" // 429 after all retries
  | "server" // 5xx
  | "invalid_response" // non-JSON body
  | "network";

/** Error raised by the client. Its message is always redacted. */
export class WorldAnvilApiError extends Error {
  override name = "WorldAnvilApiError";
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  fetch?: typeof fetch;
  /** Minimum delay between two calls. World Anvil documents no limit; ~750 ms is polite. */
  minIntervalMs?: number;
  /** Retries after a 429 before giving up. */
  maxRetries?: number;
  /** First backoff delay; doubles on each retry. */
  backoffBaseMs?: number;
  /** Upper bound for a single backoff delay. */
  backoffMaxMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Extract a short, human-readable reason from a World Anvil error body. */
function errorDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Json;
  const parts: string[] = [];
  if (typeof b.status === "string") parts.push(b.status);
  if (typeof b.error === "string") parts.push(b.error);
  else if (b.error && typeof b.error === "object") {
    const e = b.error as Json;
    if (typeof e.summary === "string") parts.push(e.summary);
    else if (typeof e.message === "string") parts.push(e.message);
  } else if (typeof b.message === "string") parts.push(b.message);
  // traceStack is deliberately dropped: it is long and may echo request data.
  return parts.join(": ").slice(0, 500);
}

const KIND_BY_STATUS: Record<number, ApiErrorKind> = {
  400: "rejected",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  422: "rejected",
  429: "rate_limited",
};

const HINT: Partial<Record<ApiErrorKind, string>> = {
  unauthorized: "World Anvil rejected the credentials.",
  forbidden: "The token does not have access to this element.",
  not_found: "Element or route not found.",
  rate_limited: "World Anvil is rate limiting requests; try again later.",
};

/**
 * The only module that talks to World Anvil. Calls are serialized and spaced,
 * 429 responses are retried with exponential backoff, and every error message
 * is redacted before it is thrown.
 */
export class WorldAnvilClient {
  private readonly fetchImpl: typeof fetch;
  private readonly redactor: Redactor;
  private readonly opts: Required<Omit<ClientOptions, "fetch">>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = -Infinity;

  constructor(
    private readonly secrets: Secrets,
    options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.redactor = new Redactor([secrets.appKey, secrets.authToken]);
    this.opts = {
      minIntervalMs: options.minIntervalMs ?? 750,
      maxRetries: options.maxRetries ?? 4,
      backoffBaseMs: options.backoffBaseMs ?? 1000,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      timeoutMs: options.timeoutMs ?? 30_000,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
    };
  }

  /** Send one request. Requests are queued so they never overlap. */
  request<T = Json>(
    method: Method,
    path: string,
    query: Record<string, string | undefined> = {},
    body?: unknown,
  ): Promise<T> {
    const run = this.queue.then(() => this.send<T>(method, path, query, body));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async waitForSlot(): Promise<void> {
    const wait = this.lastCallAt + this.opts.minIntervalMs - this.opts.now();
    if (wait > 0) await this.opts.sleep(wait);
    this.lastCallAt = this.opts.now();
  }

  private fail(message: string, kind: ApiErrorKind, status: number): never {
    throw new WorldAnvilApiError(this.redactor.redact(message), kind, status);
  }

  private async send<T>(
    method: Method,
    path: string,
    query: Record<string, string | undefined>,
    body: unknown,
  ): Promise<T> {
    const url = new URL(`${WORLD_ANVIL_BASE_URL}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const label = `${method} /${path.replace(/^\/+/, "")}`;

    for (let attempt = 0; ; attempt++) {
      await this.waitForSlot();

      let res: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            "x-application-key": this.secrets.appKey,
            "x-auth-token": this.secrets.authToken,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const reason =
          (err as Error).name === "AbortError" ? "request timed out" : (err as Error).message;
        this.fail(`${label} failed: network error (${reason}).`, "network", 0);
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429 && attempt < this.opts.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Math.min(this.opts.backoffBaseMs * 2 ** attempt, this.opts.backoffMaxMs);
        const delay =
          retryAfter > 0 ? Math.min(retryAfter * 1000, this.opts.backoffMaxMs) : backoff;
        await res.body?.cancel();
        await this.opts.sleep(delay);
        continue;
      }

      const text = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      const looksHtml = contentType.includes("text/html") || /^\s*</.test(text);

      let parsed: unknown;
      let isJson = false;
      if (!looksHtml && text.trim()) {
        try {
          parsed = JSON.parse(text);
          isJson = true;
        } catch {
          isJson = false;
        }
      }

      if (!res.ok) {
        const kind: ApiErrorKind =
          KIND_BY_STATUS[res.status] ?? (res.status >= 500 ? "server" : "rejected");
        // HTML error pages (e.g. unknown routes) are summarized, never dumped.
        const detail = isJson ? errorDetail(parsed) : looksHtml ? "HTML error page" : "";
        const hint = HINT[kind] ? ` ${HINT[kind]}` : "";
        this.fail(
          `${label} failed with HTTP ${res.status}${detail ? ` (${detail})` : ""}.${hint}`,
          kind,
          res.status,
        );
      }

      if (looksHtml) {
        // World Anvil serves an HTML page for unknown routes, sometimes with HTTP 200.
        this.fail(
          `${label} returned an HTML page instead of JSON (unknown route?).`,
          "not_found",
          res.status,
        );
      }
      if (!text.trim()) return {} as T;
      if (!isJson)
        this.fail(`${label} returned a response that is not JSON.`, "invalid_response", res.status);

      if (parsed && typeof parsed === "object" && (parsed as Json).success === false) {
        const detail = errorDetail(parsed);
        const kind: ApiErrorKind = /not.?found/i.test(detail) ? "not_found" : "rejected";
        this.fail(
          `${label} was refused by World Anvil${detail ? ` (${detail})` : ""}.`,
          kind,
          res.status,
        );
      }
      return parsed as T;
    }
  }

  /** One page of a list endpoint. Values are strings, as the API expects. */
  async listPage(
    path: string,
    parentId: string | undefined,
    offset: number,
    extra: Json = {},
  ): Promise<Json[]> {
    const res = await this.request<Json>(
      "POST",
      path,
      { id: parentId },
      { ...extra, limit: String(PAGE_SIZE), offset: String(offset) },
    );
    const entities = res.entities;
    if (entities === undefined) return [];
    if (!Array.isArray(entities)) {
      this.fail(`POST /${path} returned an unexpected list shape.`, "invalid_response", 200);
    }
    return entities as Json[];
  }

  /** Walk every page of a list endpoint. */
  async listAll(
    path: string,
    parentId: string | undefined,
    extra: Json = {},
    maxPages = 200,
  ): Promise<{ items: Json[]; complete: boolean }> {
    const items: Json[] = [];
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.listPage(path, parentId, page * PAGE_SIZE, extra);
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return { items, complete: true };
    }
    return { items, complete: false };
  }
}
