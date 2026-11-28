/**
 * `egress-check`: run inside the server container to show what it can reach.
 * Expected with the compose gateway: World Anvil and claude.ai (client
 * metadata documents) over HTTPS; nothing else, including a raw IP, plain
 * HTTP, and a TLS connection to the gateway that names another host (SNI).
 * Uses no key and prints only host names and outcomes.
 */
import { connect as tlsConnect } from "node:tls";

const out = (line: string) => process.stdout.write(`${line}\n`);

type Outcome = { reachable: boolean; detail: string };

async function tryHttp(url: string, timeoutMs: number): Promise<Outcome> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return { reachable: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const name = err instanceof Error ? err.name : "error";
    return { reachable: false, detail: cause ?? (name === "TimeoutError" ? "timeout" : name) };
  }
}

function trySni(host: string, servername: string, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername, timeout: timeoutMs });
    const finish = (o: Outcome) => {
      socket.destroy();
      resolve(o);
    };
    socket.once("secureConnect", () => finish({ reachable: true, detail: "TLS handshake done" }));
    socket.once("timeout", () => finish({ reachable: false, detail: "timeout" }));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      finish({ reachable: false, detail: e.code ?? e.message }),
    );
    socket.once("close", () => finish({ reachable: false, detail: "closed" }));
  });
}

interface Probe {
  label: string;
  expect: "reachable" | "blocked";
  run: () => Promise<Outcome>;
}

export async function runEgressCheck(timeoutMs = 8000): Promise<void> {
  const probes: Probe[] = [
    {
      label: "https://www.worldanvil.com/",
      expect: "reachable",
      run: () => tryHttp("https://www.worldanvil.com/", timeoutMs),
    },
    {
      label: "https://claude.ai/",
      expect: "reachable",
      run: () => tryHttp("https://claude.ai/", timeoutMs),
    },
    {
      label: "https://example.com/",
      expect: "blocked",
      run: () => tryHttp("https://example.com/", timeoutMs),
    },
    {
      label: "https://www.google.com/",
      expect: "blocked",
      run: () => tryHttp("https://www.google.com/", timeoutMs),
    },
    {
      label: "https://1.1.1.1/ (raw IP)",
      expect: "blocked",
      run: () => tryHttp("https://1.1.1.1/", timeoutMs),
    },
    {
      label: "http://www.worldanvil.com/ (port 80)",
      expect: "blocked",
      run: () => tryHttp("http://www.worldanvil.com/", timeoutMs),
    },
    {
      label: "TLS to the World Anvil address, SNI example.com",
      expect: "blocked",
      run: () => trySni("www.worldanvil.com", "example.com", timeoutMs),
    },
  ];
  out("Egress check (from this container)");
  let passed = 0;
  for (const p of probes) {
    const o = await p.run();
    const observed = o.reachable ? "reachable" : "blocked";
    const ok = observed === p.expect;
    if (ok) passed++;
    out(
      `  ${ok ? "PASS" : "FAIL"}  ${p.label.padEnd(48)} expected ${p.expect.padEnd(9)} observed ${observed} (${o.detail})`,
    );
  }
  out(`Result: ${passed}/${probes.length} as expected.`);
  if (passed !== probes.length) process.exit(1);
}
