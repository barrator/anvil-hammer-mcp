/**
 * Small administration commands: hash-passphrase, add-client, revoke-all, check.
 * They print no secret: the hash goes to stdout, prompts to stderr.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorldAnvilApiError, WorldAnvilClient } from "../api/client.js";
import { ConfigError, loadConfig } from "../config/index.js";
import { resolveOauthDir } from "../http/config.js";
import { newClientId, parseClientsFile, type PreregisteredClient } from "../oauth/clients.js";
import { writeRevokeMarker } from "../oauth/grants.js";
import { hashPassphrase } from "../oauth/passphrase.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

type Env = Record<string, string | undefined>;

function fail(message: string): never {
  console.error(`[anvil-hammer-mcp] ${message}`);
  process.exit(1);
}

/** Read a line from a terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(buf);
        }
        if (ch === "\u0003" || ch === "\u0004") {
          done();
          return reject(new Error("Cancelled."));
        }
        if (ch === "\u007f" || ch === "\b") buf = [...buf].slice(0, -1).join("");
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

/** `hash-passphrase`: prompt (terminal) or read stdin (pipe); print the hash for WA_PASSPHRASE_FILE. */
export async function runHashPassphrase(): Promise<void> {
  let passphrase: string;
  try {
    if (process.stdin.isTTY) {
      passphrase = await promptHidden("Passphrase: ");
      const again = await promptHidden("Same passphrase again: ");
      if (again !== passphrase) fail("The two passphrases differ. Nothing was written.");
    } else {
      passphrase = await readStdin();
    }
    process.stdout.write(`${await hashPassphrase(passphrase)}\n`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function parseFlags(args: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("--")) fail(`Unexpected argument: ${a}`);
    const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    const value = inline ?? args[++i];
    if (value === undefined) fail(`--${name} needs a value.`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return flags;
}

/** `add-client --name NAME --redirect-uri URI [--redirect-uri URI]`: add a pre-registered public client. */
export function runAddClient(args: string[], env: Env = process.env): void {
  const flags = parseFlags(args);
  for (const k of flags.keys())
    if (k !== "name" && k !== "redirect-uri") fail(`Unknown option --${k}.`);
  const name = flags.get("name")?.[0];
  const uris = flags.get("redirect-uri") ?? [];
  if (!name || uris.length === 0)
    fail("Usage: add-client --name NAME --redirect-uri URI [--redirect-uri URI ...]");
  const dir = resolveOauthDir(env);
  const file = join(dir, "clients.json");
  let existing: PreregisteredClient[] = [];
  try {
    existing = parseClientsFile(readFileSync(file, "utf8"), file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if (err instanceof ConfigError) fail(err.message);
      fail(`Cannot read ${file}.`);
    }
  }
  const client: PreregisteredClient = {
    client_id: newClientId(),
    client_name: name,
    redirect_uris: uris,
  };
  const all = [...existing, client];
  const text = JSON.stringify({ clients: all }, null, 2) + "\n";
  try {
    parseClientsFile(text, file);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  out(`Client added. client_id: ${client.client_id}`);
  out("It is a public client (no secret): give the client_id to the application.");
}

/** `revoke-all`: revoke every grant; a running server applies it at once. */
export function runRevokeAll(env: Env = process.env): void {
  writeRevokeMarker(resolveOauthDir(env));
  out("All grants are revoked. Every client must sign in again with the passphrase.");
}

/** `check`: call World Anvil once with the configured keys; print ok or the error kind. */
export async function runCheck(env: Env = process.env): Promise<void> {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    fail(err instanceof ConfigError ? err.message : "Could not load configuration.");
  }
  const client = new WorldAnvilClient(config.secrets);
  const started = performance.now();
  try {
    await client.request("GET", "identity");
    out(`World Anvil: ok (${Math.round(performance.now() - started)} ms)`);
  } catch (err) {
    const kind = err instanceof WorldAnvilApiError ? err.kind : "unexpected";
    out(`World Anvil: error (${kind}, ${Math.round(performance.now() - started)} ms)`);
    process.exit(1);
  }
}
