/**
 * MCP sessions over Streamable HTTP. Each session has its own transport and
 * MCP server; all share one tool context. A session is bound to the grant
 * (token family) that opened it: another token cannot take it over. Idle
 * sessions close after an hour; the number of sessions is capped.
 */
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServerForContext } from "../server.js";
import type { WriteContext } from "../write/service.js";

interface Entry {
  transport: StreamableHTTPServerTransport;
  family: string;
  lastSeen: number;
}

export interface SessionOptions {
  idleMs?: number;
  max?: number;
  now?: () => number;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function familyOf(auth: AuthInfo | undefined): string {
  const f = (auth?.extra as { family?: unknown } | undefined)?.family;
  return typeof f === "string" ? f : "";
}

export class McpSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;
  private readonly idleMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(
    private readonly ctx: WriteContext,
    o: SessionOptions = {},
  ) {
    this.idleMs = o.idleMs ?? 60 * 60_000;
    this.max = o.max ?? 20;
    this.now = o.now ?? Date.now;
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  get count(): number {
    return this.entries.size;
  }

  /** Close sessions idle for too long. */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const e of [...this.entries.values()]) if (e.lastSeen < cutoff) void e.transport.close();
  }

  private evictOldest(): void {
    let oldest: Entry | undefined;
    for (const e of this.entries.values()) if (!oldest || e.lastSeen < oldest.lastSeen) oldest = e;
    if (oldest) void oldest.transport.close();
  }

  async handle(req: Request & { auth?: AuthInfo }, res: Response): Promise<void> {
    const family = familyOf(req.auth);
    const header = req.headers["mcp-session-id"];
    const sessionId = typeof header === "string" ? header : undefined;

    if (sessionId) {
      const e = this.entries.get(sessionId);
      // A session of another grant answers like a missing one.
      if (!e || e.family !== family) return rpcError(res, 404, -32001, "Session not found.");
      e.lastSeen = this.now();
      await e.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(req.body))
      return rpcError(res, 400, -32000, "Bad request: no valid session. Send initialize first.");

    if (this.entries.size >= this.max) this.evictOldest();
    const server = createServerForContext(this.ctx);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.entries.set(id, { transport, family, lastSeen: this.now() });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        this.entries.delete(id);
        this.ctx.sessions.end(id);
      }
      // The MCP server's own close handling (wrapped by connect) runs after this.
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    await Promise.allSettled([...this.entries.values()].map((e) => e.transport.close()));
    this.entries.clear();
  }
}
