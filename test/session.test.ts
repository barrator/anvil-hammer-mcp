import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../src/server.js";
import { SessionStore } from "../src/session.js";
import { registerReadTools } from "../src/tools/read.js";
import { createFakeWorldAnvil } from "./helpers/fake-wa.js";
import { connect, testConfig } from "./helpers/setup.js";

type Handler = (args: unknown, extra: { sessionId?: string }) => Promise<unknown>;

function captureTools(sessions: SessionStore) {
  const fake = createFakeWorldAnvil();
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, cb: Handler) => {
      handlers[name] = cb;
    },
  } as unknown as McpServer;
  registerReadTools(
    server,
    createToolContext(testConfig(), {
      clientOptions: { fetch: fake.fetch, minIntervalMs: 0 },
      sessions,
    }),
  );
  return handlers;
}

describe("updateDate memory", () => {
  it("remembers updateDate on read", async () => {
    const { call, sessions } = await connect();
    await call("wa_get", { type: "article", id: "article-open-0005" });
    expect(
      sessions.get(undefined).lastUpdateDate("article", "article-open-0005")?.updateDate,
    ).toContain("2026-02-01");
  });

  it("is kept per MCP session, not globally", async () => {
    const sessions = new SessionStore();
    const tools = captureTools(sessions);
    await tools.wa_get!({ type: "article", id: "article-open-0005" }, { sessionId: "session-a" });
    expect(sessions.get("session-a").lastUpdateDate("article", "article-open-0005")).toBeDefined();
    expect(
      sessions.get("session-b").lastUpdateDate("article", "article-open-0005"),
    ).toBeUndefined();
    sessions.end("session-a");
    expect(
      sessions.get("session-a").lastUpdateDate("article", "article-open-0005"),
    ).toBeUndefined();
  });

  it("list reads remember updateDate too", async () => {
    const { call, sessions } = await connect();
    await call("wa_list", { type: "timeline", parent_id: "world-open-0001" });
    expect(sessions.get(undefined).lastUpdateDate("timeline", "timeline-open-0001")).toBeDefined();
  });
});
