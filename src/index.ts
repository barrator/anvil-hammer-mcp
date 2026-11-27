#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config/index.js";
import { SERVER_VERSION } from "./constants.js";
import { Logger, Redactor } from "./redact.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
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

void main();
