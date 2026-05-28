/**
 * Tests for src/ui/auth.ts — issue #164 webUI auth hardening (PR A).
 *
 * Run with: bun test src/ui/__tests__/auth.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cwdBackup: string;
let tmp: string;

beforeEach(() => {
  cwdBackup = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ccaw-auth-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwdBackup);
  rmSync(tmp, { recursive: true, force: true });
});

function req(
  headers: Record<string, string> = {},
  url = "http://127.0.0.1:4632/api/state",
): Request {
  return new Request(url, { headers });
}

describe("checkBearer (issue #164 item 4 — byte-safe)", () => {
  it("returns 503 when no token configured", async () => {
    const { checkBearer } = await import("../auth");
    const res = checkBearer(req({ Authorization: "Bearer x" }), undefined);
    expect(res?.status).toBe(503);
  });

  it("accepts a matching Bearer token", async () => {
    const { checkBearer } = await import("../auth");
    const res = checkBearer(req({ Authorization: "Bearer sekret" }), "sekret");
    expect(res).toBeNull();
  });

  it("rejects a wrong token with 401", async () => {
    const { checkBearer } = await import("../auth");
    const res = checkBearer(req({ Authorization: "Bearer nope" }), "sekret");
    expect(res?.status).toBe(401);
  });

  it("rejects a missing header with 401", async () => {
    const { checkBearer } = await import("../auth");
    const res = checkBearer(req({}), "sekret");
    expect(res?.status).toBe(401);
  });

  it("does NOT throw on a non-ASCII provided token of different byte length", async () => {
    const { checkBearer } = await import("../auth");
    // "café" is 4 chars but 5 bytes — the old char-length compare could
    // mismatch buffer lengths and (with raw timingSafeEqual) throw.
    const res = checkBearer(req({ Authorization: "Bearer café" }), "test");
    expect(res?.status).toBe(401);
  });
});

describe("checkToken (issue #164 — byte-safe, header + query)", () => {
  it("accepts the token via Authorization header", async () => {
    const { checkToken } = await import("../auth");
    expect(checkToken(req({ Authorization: "Bearer abc123" }), "abc123")).toBe(true);
  });

  it("accepts the token via ?token= query param", async () => {
    const { checkToken } = await import("../auth");
    expect(checkToken(req({}, "http://127.0.0.1:4632/api/state?token=abc123"), "abc123")).toBe(
      true,
    );
  });

  it("prefers the header over the query param", async () => {
    const { checkToken } = await import("../auth");
    const r = req(
      { Authorization: "Bearer abc123" },
      "http://127.0.0.1:4632/api/state?token=wrong",
    );
    expect(checkToken(r, "abc123")).toBe(true);
  });

  it("returns false when neither is present", async () => {
    const { checkToken } = await import("../auth");
    expect(checkToken(req({}), "abc123")).toBe(false);
  });

  it("does NOT throw on non-ASCII mismatched byte length", async () => {
    const { checkToken } = await import("../auth");
    expect(checkToken(req({ Authorization: "Bearer café" }), "test")).toBe(false);
  });
});

describe("getOrCreateWebToken (issue #164 item 1)", () => {
  it("mints a base64url token, persists it at 0600, and is idempotent", async () => {
    const { getOrCreateWebToken } = await import("../auth");
    const first = await getOrCreateWebToken();
    expect(first.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url ≈ 43 chars
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet, no padding

    const tokenPath = join(tmp, ".claude", "claudeclaw", "web.token");
    expect(existsSync(tokenPath)).toBe(true);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);

    // Second call returns the SAME token (reads the persisted file).
    const second = await getOrCreateWebToken();
    expect(second).toBe(first);
    // File content matches (trimmed).
    expect(readFileSync(tokenPath, "utf-8").trim()).toBe(first);
  });
});
