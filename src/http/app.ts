/**
 * The hosted-mode HTTP application: health routes, the authorization server,
 * and the MCP endpoint. Every MCP request needs a valid access token before
 * any tool runs.
 */
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { WorldAnvilApiError } from "../api/client.js";
import type { Config } from "../config/index.js";
import { CimdResolver } from "../oauth/cimd.js";
import { ClientRegistry } from "../oauth/clients.js";
import { type GrantEvent, type GrantLimits, GrantStore } from "../oauth/grants.js";
import type { AttemptLimits } from "../oauth/limits.js";
import { type OAuthUrls, oauthUrls } from "../oauth/metadata.js";
import type { PassphraseHash } from "../oauth/passphrase.js";
import { createOAuthServer } from "../oauth/server.js";
import { join } from "node:path";
import { Redactor } from "../redact.js";
import { type ServerDeps, createToolContext } from "../server.js";
import type { HttpConfig } from "./config.js";
import { McpSessions, type SessionOptions } from "./sessions.js";
import { TechLog } from "./techlog.js";

export interface HttpAppOptions {
  config: Config;
  http: HttpConfig;
  passphrase: PassphraseHash;
  /** World Anvil client options (tests pass a fake fetch). */
  serverDeps?: ServerDeps;
  /** Fetch used for client metadata documents (tests pass a fake). */
  cimdFetch?: typeof fetch;
  now?: () => number;
  grantLimits?: Partial<GrantLimits>;
  attemptLimits?: AttemptLimits;
  failureDelayMs?: number;
  sessions?: SessionOptions;
}

export interface HttpApp {
  app: express.Express;
  urls: OAuthUrls;
  log: TechLog;
  grants: GrantStore;
  sessions: McpSessions;
  close(): Promise<void>;
}

/** Folders the server must be able to write; /healthz checks them. */
export function dataDirs(config: Config, http: HttpConfig): Record<string, string> {
  return {
    backups: config.backupDir,
    oauth: http.oauthDir,
    logs: http.logDir,
    ...(http.indexDir ? { index: http.indexDir } : {}),
  };
}

export function unwritableDirs(dirs: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [name, dir] of Object.entries(dirs)) {
    try {
      if (!statSync(dir).isDirectory()) throw new Error("not a folder");
      accessSync(dir, constants.W_OK | constants.R_OK);
    } catch {
      bad.push(name);
    }
  }
  return bad;
}

/** Create the data folders (0700) if missing. Returns the names that still cannot be written. */
export function prepareDirs(dirs: Record<string, string>): string[] {
  for (const dir of Object.values(dirs)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // Reported below.
    }
  }
  return unwritableDirs(dirs);
}

function grantLog(log: TechLog) {
  return (e: GrantEvent) =>
    log.write({
      event: "auth",
      kind: e.kind,
      ...("clientId" in e ? { client: e.clientId } : {}),
      ...("reason" in e ? { reason: e.reason } : {}),
      ...("families" in e ? { families: e.families } : {}),
    });
}

export function createHttpApp(o: HttpAppOptions): HttpApp {
  const { config, http } = o;
  const urls = oauthUrls(http.publicUrl);
  const redactor = new Redactor([config.secrets.appKey, config.secrets.authToken]);
  const log = new TechLog(http.logDir, http.logRetentionDays, redactor, () =>
    o.now ? new Date(o.now()) : new Date(),
  );

  const ctx = createToolContext(config, o.serverDeps);
  ctx.onToolCall = (r) => log.write({ event: "tool", ...r });
  const sessions = new McpSessions(ctx, o.sessions);

  const grants = new GrantStore(http.oauthDir, {
    now: o.now,
    limits: o.grantLimits,
    onEvent: grantLog(log),
  });
  const cimd = http.cimdHosts.length
    ? new CimdResolver({ hosts: http.cimdHosts, fetch: o.cimdFetch, now: o.now })
    : undefined;
  const clients = new ClientRegistry(join(http.oauthDir, "clients.json"), cimd, (message) =>
    log.write({ event: "server", kind: "clients_file_error", detail: message }),
  );
  const oauth = createOAuthServer({
    urls,
    clients,
    grants,
    passphrase: o.passphrase,
    allowedRedirects: http.redirectUris,
    log: (e) => log.write({ event: "auth", ...e }),
    now: o.now,
    failureDelayMs: o.failureDelayMs,
    attemptLimits: o.attemptLimits,
  });

  const app = express();
  app.disable("x-powered-by");
  // X-Forwarded-For counts only when the connection comes from the gateway.
  // Its value is then the single address the gateway wrote (the gateway itself
  // only trusts the header from the host's loopback port, i.e. the reverse proxy).
  const trusted = new Set(http.trustedProxies);
  app.set(
    "trust proxy",
    (addr: string, i: number) => i === 0 && trusted.has(addr.replace(/^::ffff:/, "")),
  );

  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    next();
  });

  // Health: no World Anvil call, no authentication, no detail beyond folder names.
  const dirs = dataDirs(config, http);
  app.get("/healthz", (_req, res) => {
    const failing = unwritableDirs(dirs);
    res.set("Cache-Control", "no-store");
    if (failing.length) res.status(503).json({ status: "error", failing });
    else res.json({ status: "ok" });
  });

  // Everything else must name this server (DNS rebinding protection).
  app.use(hostHeaderValidation([http.publicHostname]));
  app.use(oauth.router);

  // Authenticated World Anvil connection check: ok or error kind, and duration.
  app.get("/healthz/worldanvil", oauth.requireToken, async (_req, res) => {
    const started = performance.now();
    res.set("Cache-Control", "no-store");
    try {
      await ctx.client.request("GET", "identity");
      res.json({ worldAnvil: "ok", ms: Math.round(performance.now() - started) });
    } catch (err) {
      const kind = err instanceof WorldAnvilApiError ? err.kind : "unexpected";
      res
        .status(502)
        .json({ worldAnvil: "error", kind, ms: Math.round(performance.now() - started) });
    }
  });

  // MCP endpoint. A browser Origin other than ours is refused (MCP transport rule).
  const origin = new URL(urls.issuer).origin;
  app.all(
    "/mcp",
    (req: Request, res: Response, next: NextFunction) => {
      const o = req.headers.origin;
      if (o !== undefined && o !== origin) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Origin not allowed." },
          id: null,
        });
        return;
      }
      next();
    },
    oauth.requireToken,
    express.json({ limit: "4mb" }),
    (req: Request, res: Response) => sessions.handle(req, res),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  // Body parse errors and the like: a short answer, never a stack or a request echo.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : 500;
    if (!res.headersSent)
      res.status(status >= 400 && status < 600 ? status : 500).json({ error: "bad_request" });
  });

  log.prune();
  const pruneTimer = setInterval(() => log.prune(), 24 * 3600_000);
  pruneTimer.unref();

  return {
    app,
    urls,
    log,
    grants,
    sessions,
    async close() {
      clearInterval(pruneTimer);
      await sessions.closeAll();
    },
  };
}
