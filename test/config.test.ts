import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAccessPolicy, parseAccessConfig, topLevelKeys } from "../src/config/access.js";
import { ConfigError, loadConfig } from "../src/config/index.js";
import { loadSecrets } from "../src/config/secrets.js";

const dir = mkdtempSync(join(tmpdir(), "ahm-config-"));
const file = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

describe("secrets", () => {
  it("reads both keys from files and trims the trailing newline", () => {
    const s = loadSecrets({
      WA_APP_KEY_FILE: file("app", "fake-app-key-1234\n"),
      WA_AUTH_TOKEN_FILE: file("tok", "fake-token-5678\n"),
    });
    expect(s).toEqual({ appKey: "fake-app-key-1234", authToken: "fake-token-5678" });
  });

  it("accepts plain environment variables as a fallback", () => {
    const s = loadSecrets({ WA_APP_KEY: "fake-app-key-1234", WA_AUTH_TOKEN: "fake-token-5678" });
    expect(s.appKey).toBe("fake-app-key-1234");
  });

  it("prefers the file over the plain variable", () => {
    const s = loadSecrets({
      WA_APP_KEY_FILE: file("app2", "from-file-key-0000"),
      WA_APP_KEY: "from-env-key-0000",
      WA_AUTH_TOKEN: "fake-token-5678",
    });
    expect(s.appKey).toBe("from-file-key-0000");
  });

  it.each([
    [{ WA_AUTH_TOKEN: "fake-token-5678" }, /WA_APP_KEY_FILE/],
    [{ WA_APP_KEY: "fake-app-key-1234" }, /WA_AUTH_TOKEN_FILE/],
    [{}, /WA_APP_KEY_FILE/],
  ])("refuses to start when a key is missing (%o)", (env, msg) => {
    expect(() => loadSecrets(env)).toThrow(msg);
  });

  it("refuses an unreadable or empty key file without echoing content", () => {
    expect(() =>
      loadSecrets({ WA_APP_KEY_FILE: join(dir, "nope"), WA_AUTH_TOKEN: "fake-token-5678" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadSecrets({ WA_APP_KEY_FILE: file("empty", "  \n"), WA_AUTH_TOKEN: "fake-token-5678" }),
    ).toThrow(/empty/);
  });
});

describe("access file", () => {
  it("parses valid levels and defaults unlisted worlds to read_only", () => {
    const p = parseAccessConfig(
      '{"w-a": "full_edit", "w-b": "blocked", "w-c": "edit_only", "w-d": "read_only"}',
    );
    expect(p.levelFor("w-a")).toBe("full_edit");
    expect(p.levelFor("w-b")).toBe("blocked");
    expect(p.canRead("w-b")).toBe(false);
    expect(p.levelFor("w-unlisted")).toBe("read_only");
  });

  it("rejects duplicate world IDs that JSON.parse would silently merge", () => {
    expect(() => parseAccessConfig('{"w-a": "read_only", "w-a": "full_edit"}')).toThrow(
      /more than once/,
    );
  });

  it("detects keys only at the top level", () => {
    expect(topLevelKeys('{"a": {"x": 1, "x": 2}, "b": ["c", "d"], "e\\"q": 1}')).toEqual([
      "a",
      "b",
      'e"q',
    ]);
  });

  it.each([
    ['{"w-a": "admin"}', /unknown level/],
    ['{"w-a": 3}', /unknown level/],
    ["[]", /JSON object/],
    ["not json", /not valid JSON/],
    ['{"": "read_only"}', /empty world ID/],
  ])("rejects %s", (text, msg) => {
    expect(() => parseAccessConfig(text)).toThrow(msg);
  });

  it("prevents startup when the configured path does not exist", () => {
    expect(() => loadAccessPolicy(join(dir, "missing.json"))).toThrow(/missing file/);
  });

  it("treats an unset path as all read_only", () => {
    expect(loadAccessPolicy(undefined).levelFor("anything")).toBe("read_only");
  });

  it("loadConfig wires everything and validates WA_MAX_RESPONSE_CHARS", () => {
    const env = {
      WA_APP_KEY: "fake-app-key-1234",
      WA_AUTH_TOKEN: "fake-token-5678",
      WA_ACCESS_FILE: file("access.json", '{"w-x": "blocked"}'),
    };
    const c = loadConfig(env);
    expect(c.access.levelFor("w-x")).toBe("blocked");
    expect(c.maxResponseChars).toBe(25_000);
    expect(() => loadConfig({ ...env, WA_MAX_RESPONSE_CHARS: "12" })).toThrow(/at least 1000/);
  });
});
