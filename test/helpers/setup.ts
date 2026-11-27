import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseAccessConfig } from "../../src/config/access.js";
import type { Config } from "../../src/config/index.js";
import { createServer } from "../../src/server.js";
import { SessionStore } from "../../src/session.js";
import {
  FAKE_APP_KEY,
  FAKE_TOKEN,
  createFakeWorldAnvil,
  type FakeOptions,
  seedData,
} from "./fake-wa.js";

export const ACCESS_JSON = JSON.stringify({
  "world-blocked-0002": "blocked",
  "world-edit-0003": "edit_only",
});

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    secrets: { appKey: FAKE_APP_KEY, authToken: FAKE_TOKEN },
    access: parseAccessConfig(ACCESS_JSON),
    maxResponseChars: 25_000,
    ...overrides,
  };
}

export async function connect(
  opts: { config?: Partial<Config>; fake?: FakeOptions; data?: ReturnType<typeof seedData> } = {},
) {
  const fake = createFakeWorldAnvil(opts.data ?? seedData(), opts.fake);
  const sessions = new SessionStore();
  const server = createServer(testConfig(opts.config), {
    clientOptions: { fetch: fake.fetch, minIntervalMs: 0, backoffBaseMs: 1, backoffMaxMs: 5 },
    sessions,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as { type: string; text: string }[];
    return { isError: r.isError === true, text: content.map((c) => c.text).join("\n") };
  };
  return { client, call, fake, sessions };
}

/** Parse the JSON inside the first untrusted block. */
export function untrustedJson(text: string): unknown {
  const m =
    /<untrusted_world_content source="[^"]*">\n([\s\S]*?)\n<\/untrusted_world_content>/.exec(text);
  if (!m) throw new Error(`no untrusted block in:\n${text}`);
  return JSON.parse(m[1] as string);
}
