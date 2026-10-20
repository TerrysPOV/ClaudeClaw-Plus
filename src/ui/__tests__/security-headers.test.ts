/**
 * Response hardening on the dashboard server: a Content-Security-Policy on
 * the HTML shell (inline script and style allowed by a per-response nonce
 * only), anti-framing, nosniff and no-referrer on every response, no-store
 * on every /api/* response, and fonts served from the daemon instead of a
 * third-party CDN.
 *
 * Boots a real startWebUi server on an ephemeral port.
 *
 * Run with: bun test src/ui/__tests__/security-headers.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { withSecurityHeaders } from "../security-headers";
import { startWebUi } from "../server";
import type { WebServerHandle, WebSnapshot } from "../types";

const TOKEN = "test-web-token-headers-abcdefghijkl";

function snapshot(): WebSnapshot {
  return {
    pid: 1234,
    startedAt: Date.now(),
    heartbeatNextAt: 0,
    settings: {
      apiToken: undefined,
      heartbeat: { enabled: false, interval: 30, prompt: "" },
      security: {},
      telegram: { token: "", allowedUserIds: [] },
      discord: { token: "", allowedUserIds: [] },
      web: { enabled: true, host: "127.0.0.1", port: 0 },
    } as unknown as WebSnapshot["settings"],
    jobs: [],
  };
}

let handle: WebServerHandle;
let base: string;

beforeAll(() => {
  handle = startWebUi({ host: "127.0.0.1", port: 0, token: TOKEN, getSnapshot: snapshot });
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(() => {
  handle.stop();
});

function get(path: string, authed = false): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: authed ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
}

function directives(csp: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values.join(" "));
  }
  return out;
}

function expectBaseline(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
}

function expectDenyAllCsp(res: Response): void {
  const d = directives(res.headers.get("content-security-policy") ?? "");
  expect(d.get("default-src")).toBe("'none'");
  expect(d.get("frame-ancestors")).toBe("'none'");
}

describe("dashboard HTML shell", () => {
  it("carries a CSP whose nonce matches the inline script and style, and nothing else", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expectBaseline(res);
    const csp = res.headers.get("content-security-policy") ?? "";
    const d = directives(csp);
    expect(d.get("default-src")).toBe("'none'");
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("base-uri")).toBe("'none'");
    expect(d.get("connect-src")).toBe("'self'");
    expect(d.get("font-src")).toBe("'self'");
    expect(d.get("img-src")).toBe("'self'");
    expect(d.get("form-action")).toBe("'self'");
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(d.get("script-src") ?? "")?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(d.get("style-src")).toContain(`'nonce-${nonce}'`);

    const html = await res.text();
    // Every inline <script>/<style> carries the nonce, so the policy lets
    // the dashboard run; nothing else can.
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    const styles = html.match(/<style\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    expect(styles.length).toBeGreaterThan(0);
    for (const tag of [...scripts, ...styles]) expect(tag).toContain(`nonce="${nonce}"`);
    // An inline handler or style attribute would be blocked by this policy.
    expect(html).not.toMatch(/\son[a-z]+=["']/);
    expect(html).not.toMatch(/\sstyle=["']/);
    // A <style>-attribute in markup the script builds would be blocked too.
    expect(html).not.toMatch(/style='/);
  });

  it("is revalidated, not stored, so back/forward cache still works", async () => {
    for (const path of ["/", "/index.html"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("content-security-policy") ?? "").toContain("'nonce-");
    }
  });

  it("mints a fresh nonce for every response", async () => {
    const a = (await get("/")).headers.get("content-security-policy");
    const b = (await get("/")).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });

  it("loads no third-party resource", async () => {
    const html = await (await get("/")).text();
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
    // Tags that fetch on load; an <a href> to the project page does not.
    expect(html).not.toMatch(/<(?:link|script|img|iframe|source)\b[^>]*(?:src|href)=["']?https?:/);
  });
});

describe("bundled fonts", () => {
  it("serves each @font-face url as woff2, pre-auth and cacheable", async () => {
    const html = await (await get("/")).text();
    const urls = [...html.matchAll(/url\((\/assets\/fonts\/[a-z0-9-]+\.woff2)\)/g)].map(
      (m) => m[1],
    );
    expect(urls.length).toBe(3);
    for (const url of urls) {
      const res = await get(url as string);
      expect(res.status).toBe(200);
      expectBaseline(res);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.headers.get("cache-control") ?? "").toContain("max-age=");
      const body = new Uint8Array(await res.arrayBuffer());
      // WOFF2 signature "wOF2".
      expect(String.fromCharCode(...body.slice(0, 4))).toBe("wOF2");
    }
  });

  it("serves nothing else under /assets/fonts/", async () => {
    for (const path of [
      "/assets/fonts/",
      "/assets/fonts/nope.woff2",
      "/assets/fonts/..%2F..%2Fserver.ts",
      "/assets/fonts/OFL-fraunces.txt",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(404);
    }
  });
});

describe("/api/* responses", () => {
  it("are never stored, authed or not", async () => {
    for (const [path, authed, status] of [
      ["/api/state", true, 200],
      ["/api/settings", true, 200],
      ["/api/state", false, 401],
      ["/api/health", false, 200],
    ] as const) {
      const res = await get(path, authed);
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expectBaseline(res);
      expectDenyAllCsp(res);
    }
  });

  it("override a route's own caching on /api/* (the chat stream sends no-cache)", () => {
    const res = withSecurityHeaders(
      "/api/chat",
      new Response("data: x\n\n", { headers: { "Cache-Control": "no-cache" } }),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("cover plugin-gateway responses", async () => {
    // Answered by the plugin gateway itself (it runs before the auth gate).
    const res = await get("/api/plugin/no-such-plugin/health");
    expect(res.status).toBe(404);
    expectBaseline(res);
    expectDenyAllCsp(res);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keep the baseline headers on rejections that happen before routing", async () => {
    const res = await fetch(`${base}/api/state`, { headers: { Host: "evil.example" } });
    expect(res.status).toBe(421);
    expectBaseline(res);
  });

  it("keep the headers when a route throws, without Bun's error page", async () => {
    const failing = startWebUi({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      getSnapshot: () => {
        throw new Error("snapshot-failure-marker");
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await fetch(`http://127.0.0.1:${failing.port}/api/state`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(500);
      expectBaseline(res);
      expectDenyAllCsp(res);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("Internal Server Error");
    } finally {
      console.error = originalError;
      failing.stop();
    }
  });
});
