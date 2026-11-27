import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Json, WorldAnvilApiError, type WorldAnvilClient } from "../api/client.js";
import type { AccessPolicy } from "../config/access.js";
import { compactElement, missingFields, pickFields } from "../output/compact.js";
import { fitElement, fitList } from "../output/truncate.js";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "../output/untrusted.js";
import type { Redactor } from "../redact.js";
import type { WorldResolver } from "../resolver.js";
import type { SessionState, SessionStore } from "../session.js";

export interface ToolContext {
  client: WorldAnvilClient;
  access: AccessPolicy;
  resolver: WorldResolver;
  sessions: SessionStore;
  redactor: Redactor;
  maxResponseChars: number;
}

/** A refusal or user-facing failure. Its message is shown as is (after redaction). */
export class ToolError extends Error {
  override name = "ToolError";
}

/** Same wording for "does not exist" and "blocked world", so blocked worlds never leak. */
export function notFound(type: string, id: string): ToolError {
  return new ToolError(`Not found: ${type} "${id}" does not exist or is not accessible.`);
}

/** Server message line, visibly distinct from world content. */
export const serverLine = (text: string) => `[anvil-hammer-mcp] ${text}`;

export function textResult(ctx: ToolContext, text: string): CallToolResult {
  return { content: [{ type: "text", text: ctx.redactor.redact(text) }] };
}

export function errorResult(ctx: ToolContext, err: unknown): CallToolResult {
  let message: string;
  if (err instanceof ToolError || err instanceof WorldAnvilApiError) message = err.message;
  else message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return {
    isError: true,
    content: [{ type: "text", text: ctx.redactor.redact(serverLine(message)) }],
  };
}

/** Wrap a handler: errors become tool errors, never protocol errors. */
export function handler<A>(
  ctx: ToolContext,
  fn: (args: A, state: SessionState) => Promise<CallToolResult>,
) {
  return async (args: A, extra: { sessionId?: string }): Promise<CallToolResult> => {
    try {
      return await fn(args, ctx.sessions.get(extra.sessionId));
    } catch (err) {
      return errorResult(ctx, err);
    }
  };
}

/** Render one element: compact, pick fields, fit, wrap as untrusted. */
export function renderElement(
  ctx: ToolContext,
  header: string,
  source: string,
  element: Json,
  fields?: string[],
): CallToolResult {
  const picked = pickFields(compactElement(element), fields);
  const fit = fitElement(picked, ctx.maxResponseChars);
  const lines = [serverLine(`${header} ${UNTRUSTED_NOTICE}`)];
  lines.push(wrapUntrusted(source, JSON.stringify(fit.value, null, 2)));
  const missing = missingFields(compactElement(element), fields);
  if (missing.length) {
    lines.push(serverLine(`Requested fields absent or empty: ${missing.join(", ")}.`));
  }
  if (fit.truncated) {
    const parts = [`Response truncated to about ${ctx.maxResponseChars} characters.`];
    if (fit.cut.length) parts.push(`Text cut in: ${fit.cut.join(", ")}.`);
    if (fit.omitted.length) parts.push(`Fields omitted: ${fit.omitted.join(", ")}.`);
    parts.push(
      'Call again with "fields" listing only the fields you need (for example ["content"]) to see them in full.',
    );
    lines.push(serverLine(parts.join(" ")));
  }
  return textResult(ctx, lines.join("\n"));
}

/** Render a list: compact each item, pick fields, page by size, wrap as untrusted. */
export function renderList(
  ctx: ToolContext,
  header: string,
  source: string,
  all: Json[],
  opts: { offset: number; fields?: string[]; complete: boolean },
): CallToolResult {
  const prepared = all.map((e) => pickFields(compactElement(e), opts.fields));
  const fit = fitList(prepared, opts.offset, ctx.maxResponseChars);
  const items = fit.items.map((item) => {
    const f = fitElement(item, ctx.maxResponseChars);
    return f.value;
  });
  const shownTo = opts.offset + items.length;
  const lines = [
    serverLine(
      `${header} ${all.length} item(s) in total; showing ${items.length ? `${opts.offset + 1}-${shownTo}` : "none"}. ${UNTRUSTED_NOTICE}`,
    ),
    wrapUntrusted(source, JSON.stringify(items, null, 2)),
  ];
  if (fit.truncated) {
    lines.push(
      serverLine(
        `Response truncated to about ${ctx.maxResponseChars} characters. Call again with offset=${fit.nextOffset} for the next items.`,
      ),
    );
  }
  if (!opts.complete) {
    lines.push(
      serverLine(
        "World Anvil returned more pages than the server reads at once; the list is incomplete.",
      ),
    );
  }
  return textResult(ctx, lines.join("\n"));
}
