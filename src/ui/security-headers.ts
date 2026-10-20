/**
 * Response hardening for the dashboard server (`startWebUi`), applied to
 * every response its fetch handler returns — including the 401/403/421
 * rejections that happen before routing, and plugin-gateway and `/mcp/*`
 * responses. The webui bus adapter (`src/adapters/webui/`) runs its own
 * server, serves no HTML, and is not covered here.
 *
 * - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
 *   `Referrer-Policy: no-referrer` and a Permissions-Policy that turns off
 *   camera, microphone and geolocation, everywhere. The dashboard is opened with
 *   the web token in `?token=`; no-referrer keeps it out of any Referer.
 * - `Cache-Control: no-store` on every `/api/*` response, overriding what the
 *   route set (the chat stream said `no-cache`, which still allows storing):
 *   they carry agent state, logs and session content. Elsewhere `no-store`
 *   is the default and a route may opt into caching (the fonts do).
 * - The Content-Security-Policy is per response, built by {@link pageCsp}
 *   with the nonce the HTML shell was rendered with; other responses get a
 *   deny-all policy, which costs nothing for JSON and protects a response
 *   a browser might ever render.
 */

const BASELINE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const DENY_ALL_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** A fresh, unguessable nonce for one rendering of the HTML shell. */
export function newCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

/**
 * Policy for the HTML shell. The page is one inline `<script>` and one
 * inline `<style>`, both rendered with `nonce`; it talks only to its own
 * origin (fetch, SSE) and loads fonts from `/assets/fonts/`. No
 * `'unsafe-inline'`: an injected `<script>`, inline handler or style
 * attribute does not run.
 */
export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "font-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function withSecurityHeaders(pathname: string, res: Response): Response {
  const extra: Record<string, string> = { ...BASELINE_HEADERS };
  if (!res.headers.has("Content-Security-Policy")) {
    extra["Content-Security-Policy"] = DENY_ALL_CSP;
  }
  if (pathname.startsWith("/api/") || !res.headers.has("Cache-Control")) {
    extra["Cache-Control"] = "no-store";
  }
  try {
    for (const [name, value] of Object.entries(extra)) res.headers.set(name, value);
    return res;
  } catch {
    // A Response obtained from fetch() (a proxied plugin response) has
    // immutable headers; rebuild it around the same body.
    const headers = new Headers(res.headers);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
