#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runAddClient, runCheck, runHashPassphrase, runRevokeAll } from "./cli/admin.js";
import { runEgressCheck } from "./cli/egress.js";
import { runHttp } from "./cli/http.js";
import { ConfigError, loadConfig } from "./config/index.js";
import { SERVER_VERSION } from "./constants.js";
import { Logger, Redactor } from "./redact.js";
import { createServer } from "./server.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

const USAGE = `anvil-hammer-mcp ${SERVER_VERSION}

Usage:
  anvil-hammer-mcp                  MCP server on stdio (local use)
  anvil-hammer-mcp http             hosted server: Streamable HTTP with OAuth
  anvil-hammer-mcp hash-passphrase  print the hash to store in WA_PASSPHRASE_FILE
  anvil-hammer-mcp add-client --name NAME --redirect-uri URI [--redirect-uri URI]
                                    add a pre-registered public OAuth client
  anvil-hammer-mcp revoke-all       revoke every OAuth grant (all clients sign in again)
  anvil-hammer-mcp check            test the World Anvil connection with the configured keys
  anvil-hammer-mcp egress-check     show which hosts this machine or container can reach
`;

async function runStdio(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Config errors never contain key values; still go through a redactor-free path.
    const msg = err instanceof ConfigError ? err.message : "Could not load configuration.";
    console.error(`[anvil-hammer-mcp] Startup refused: ${msg}`);
    process.exit(1);
  }
  const log = new Logger(new Redactor([config.secrets.appKey, config.secrets.authToken]));
  try {
    const server = createServer(config);
    await server.connect(new StdioServerTransport());
    log.error(
      `v${SERVER_VERSION} running on stdio (read-only; ${config.access.size} world(s) in access file).`,
    );
  } catch (err) {
    log.error("Fatal error:", err);
    process.exit(1);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      return runStdio();
    case "http":
      return runHttp();
    case "hash-passphrase":
      return runHashPassphrase();
    case "add-client":
      return runAddClient(rest);
    case "revoke-all":
      return runRevokeAll();
    case "check":
      return runCheck();
    case "egress-check":
      return runEgressCheck();
    case "--version":
      out(SERVER_VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(2);
  }
}

void main(process.argv.slice(2));
