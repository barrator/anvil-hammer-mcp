/**
 * The authorization page (passphrase and consent) and its error page. Plain
 * HTML, no script. Every value is escaped; the style block is allowed by its
 * hash in the Content-Security-Policy.
 */
import { createHash } from "node:crypto";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#1d1d1b;line-height:1.45}
main{max-width:30rem;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:10px;padding:20px}
h1{font-size:1.25rem;margin:0 0 12px}
.host{font-size:1.15rem;font-weight:700;word-break:break-all}
.warn{background:#fff4d6;border:1px solid #e0b84c;border-radius:6px;padding:10px;margin:12px 0}
.err{background:#fde8e8;border:1px solid #d66;border-radius:6px;padding:10px;margin:12px 0}
.small{font-size:.85rem;color:#555;word-break:break-all}
label{display:block;margin:16px 0 6px;font-weight:600}
input[type=password]{width:100%;box-sizing:border-box;font-size:1.1rem;padding:10px;border:1px solid #999;border-radius:6px}
.row{display:flex;gap:10px;margin-top:16px}
button{flex:1;font-size:1.05rem;padding:12px;border-radius:6px;border:1px solid #333;background:#1d1d1b;color:#fff}
button.secondary{background:#fff;color:#1d1d1b}
`;

const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** CSP for our pages. form-action must also allow the redirect target (browsers check redirects after a POST). */
export function pageCsp(redirectOrigin?: string): string {
  const formAction = ["'self'", ...(redirectOrigin ? [redirectOrigin] : [])].join(" ");
  return [
    "default-src 'none'",
    `style-src 'sha256-${STYLE_HASH}'`,
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}

export interface ConsentView {
  requestId: string;
  clientName: string;
  /** "cimd": identity proven by the https URL of its document; "preregistered": listed by the owner. */
  source: "cimd" | "preregistered";
  clientId: string;
  redirectHost: string;
  loopback: boolean;
  error?: string;
}

export function consentPage(v: ConsentView): string {
  const identity =
    v.source === "cimd"
      ? `Identity published at <span class="small">${escapeHtml(v.clientId)}</span>`
      : `Client pre-registered on this server (<span class="small">${escapeHtml(v.clientId)}</span>)`;
  const loopback = v.loopback
    ? `<div class="warn"><strong>Local application.</strong> The authorization goes to a program on the
computer that started this sign-in (${escapeHtml(v.redirectHost)}). Any program on that computer can claim
this address: approve only if you started this connection yourself, from this device.</div>`
    : "";
  const error = v.error ? `<div class="err" role="alert">${escapeHtml(v.error)}</div>` : "";
  return layout(
    "Authorize access",
    `<h1>Authorize access to your World Anvil worlds</h1>
<p><strong>${escapeHtml(v.clientName)}</strong> asks to use this anvil-hammer-mcp server.</p>
<p class="small">${identity}</p>
<p>After you approve, your browser goes to:</p>
<p class="host">${escapeHtml(v.redirectHost)}</p>
${loopback}${error}
<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(v.requestId)}">
<label for="passphrase">Passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus required>
<div class="row">
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny" class="secondary" formnovalidate>Deny</button>
</div>
</form>`,
  );
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`);
}
