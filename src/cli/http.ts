/** `anvil-hammer-mcp http`: the hosted server (Streamable HTTP with the built-in authorization server). */
import { createServer as createHttpServer } from "node:http";
import { ConfigError, loadConfig } from "../config/index.js";
import { readSecretFile } from "../config/secrets.js";
import { SERVER_VERSION } from "../constants.js";
import { loadHttpConfig } from "../http/config.js";
import { createHttpApp, dataDirs, prepareDirs } from "../http/app.js";
import { parsePassphraseHash } from "../oauth/passphrase.js";

type Env = Record<string, string | undefined>;

export async function runHttp(env: Env = process.env): Promise<void> {
  let config, http, passphrase;
  try {
    config = loadConfig(env, { filesOnly: true });
    http = loadHttpConfig(env);
    passphrase = parsePassphraseHash(readSecretFile("WA_PASSPHRASE_FILE", http.passphraseFile));
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : "Could not load configuration.";
    console.error(`[anvil-hammer-mcp] Startup refused: ${msg}`);
    process.exit(1);
  }
  const failing = prepareDirs(dataDirs(config, http));
  if (failing.length) {
    console.error(
      `[anvil-hammer-mcp] Startup refused: cannot write to ${failing.join(", ")}. ` +
        "Check that these folders exist and belong to the user the server runs as.",
    );
    process.exit(1);
  }

  const h = createHttpApp({ config, http, passphrase });
  const server = createHttpServer(h.app);
  server.listen(http.port, http.listenHost, () => {
    h.log.write({ event: "server", kind: "started", detail: `v${SERVER_VERSION}` });
    console.error(
      `[anvil-hammer-mcp] v${SERVER_VERSION} listening on ${http.listenHost}:${http.port}; ` +
        `MCP endpoint ${h.urls.mcp}; client metadata hosts: ${http.cimdHosts.join(", ") || "none"}; ` +
        `${config.access.size} world(s) in access file.`,
    );
  });
  const stop = (signal: string) => {
    h.log.write({ event: "server", kind: "stopping", detail: signal });
    void h.close().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
