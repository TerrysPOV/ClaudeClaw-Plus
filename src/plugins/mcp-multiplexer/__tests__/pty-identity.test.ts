import { describe, it, expect, beforeEach } from "bun:test";
import {
  issueIdentity,
  getIdentity,
  revokeIdentity,
  verifyBearer,
  _listIssuedPtyIds,
  _resetIdentityStore,
  AUTH_HEADER,
  PTY_ID_HEADER,
  PTY_TS_HEADER,
  PTY_SECRET_BYTES,
} from "../pty-identity.js";

describe("pty-identity", () => {
  beforeEach(() => {
    _resetIdentityStore();
  });

  // ── Issuance ─────────────────────────────────────────────────────────

  it("issueIdentity returns a fresh identity with all required headers", () => {
    const id = issueIdentity("suzy");
    expect(id.ptyId).toBe("suzy");
    expect(typeof id.issuedAt).toBe("number");
    expect(id.issuedAt).toBeGreaterThan(0);
    expect(id.headers[AUTH_HEADER]).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(id.headers[PTY_ID_HEADER]).toBe("suzy");
    expect(id.headers[PTY_TS_HEADER]).toBe(String(id.issuedAt));
  });

  it("issueIdentity hex length matches PTY_SECRET_BYTES", () => {
    const id = issueIdentity("test");
    const hex = id.headers[AUTH_HEADER].slice("Bearer ".length);
    expect(hex.length).toBe(PTY_SECRET_BYTES * 2);
  });

  it("issueIdentity produces a distinct secret on each call", () => {
    const a = issueIdentity("a");
    const b = issueIdentity("b");
    expect(a.headers[AUTH_HEADER]).not.toBe(b.headers[AUTH_HEADER]);
  });

  it("issueIdentity for the same ptyId replaces the previous identity", () => {
    const a = issueIdentity("same");
    const b = issueIdentity("same");
    expect(a.headers[AUTH_HEADER]).not.toBe(b.headers[AUTH_HEADER]);
    expect(_listIssuedPtyIds()).toEqual(["same"]);
    // old bearer no longer verifies against new identity
    expect(verifyBearer("same", a.headers[AUTH_HEADER])).toBe(false);
    expect(verifyBearer("same", b.headers[AUTH_HEADER])).toBe(true);
  });

  it("rejects invalid ptyIds at issue time", () => {
    expect(() => issueIdentity("")).toThrow();
    expect(() => issueIdentity("with/slash")).toThrow();
    expect(() => issueIdentity("../etc/passwd")).toThrow();
    expect(() => issueIdentity("has space")).toThrow();
    expect(() => issueIdentity("a".repeat(200))).toThrow();
  });

  it("accepts canonical sessionKey shapes (named, adhoc, global)", () => {
    expect(() => issueIdentity("suzy")).not.toThrow();
    expect(() => issueIdentity("peggy")).not.toThrow();
    expect(() => issueIdentity("global")).not.toThrow();
    expect(() => issueIdentity("thread-abc-123")).not.toThrow();
    expect(() => issueIdentity("UUID:f47ac10b-58cc-4372-a567-0e02b2c3d479")).not.toThrow();
  });

  // ── Verification ─────────────────────────────────────────────────────

  it("verifyBearer accepts the issued bearer header verbatim", () => {
    const id = issueIdentity("suzy");
    expect(verifyBearer("suzy", id.headers[AUTH_HEADER])).toBe(true);
  });

  it("verifyBearer is case-insensitive on the 'Bearer' scheme prefix", () => {
    const id = issueIdentity("suzy");
    const hex = id.headers[AUTH_HEADER].slice("Bearer ".length);
    expect(verifyBearer("suzy", `bearer ${hex}`)).toBe(true);
    expect(verifyBearer("suzy", `BEARER ${hex}`)).toBe(true);
  });

  it("verifyBearer rejects an unknown ptyId", () => {
    const id = issueIdentity("suzy");
    expect(verifyBearer("reg", id.headers[AUTH_HEADER])).toBe(false);
  });

  it("verifyBearer rejects a tampered secret", () => {
    const id = issueIdentity("suzy");
    const hex = id.headers[AUTH_HEADER].slice("Bearer ".length);
    // Deterministic flip: if the first nibble is "0", flip to "1";
    // otherwise flip to "0". Previously `"0" + hex.slice(1)` collided
    // 1-in-16 runs when the bearer happened to start with "0".
    const flippedFirst = hex[0] === "0" ? "1" : "0";
    const flipped = flippedFirst + hex.slice(1);
    expect(verifyBearer("suzy", `Bearer ${flipped}`)).toBe(false);
  });

  it("verifyBearer rejects missing/empty/null bearer values", () => {
    issueIdentity("suzy");
    expect(verifyBearer("suzy", null)).toBe(false);
    expect(verifyBearer("suzy", undefined)).toBe(false);
    expect(verifyBearer("suzy", "")).toBe(false);
    expect(verifyBearer("suzy", "Bearer ")).toBe(false);
    expect(verifyBearer("suzy", "Bearer not-hex")).toBe(false);
  });

  it("verifyBearer rejects malformed bearer headers", () => {
    issueIdentity("suzy");
    expect(verifyBearer("suzy", "Basic abc")).toBe(false);
    expect(verifyBearer("suzy", "abc")).toBe(false);
    expect(verifyBearer("suzy", "Bearer abc")).toBe(false); // wrong length
  });

  it("verifyBearer rejects bearer of wrong byte length", () => {
    issueIdentity("suzy");
    expect(verifyBearer("suzy", "Bearer " + "ab".repeat(16))).toBe(false); // 16 bytes
    expect(verifyBearer("suzy", "Bearer " + "ab".repeat(64))).toBe(false); // 64 bytes
  });

  // ── Revocation ───────────────────────────────────────────────────────

  it("revokeIdentity drops the secret and returns true", () => {
    const id = issueIdentity("suzy");
    expect(revokeIdentity("suzy")).toBe(true);
    expect(verifyBearer("suzy", id.headers[AUTH_HEADER])).toBe(false);
    expect(getIdentity("suzy")).toBeUndefined();
  });

  it("revokeIdentity is idempotent", () => {
    issueIdentity("suzy");
    expect(revokeIdentity("suzy")).toBe(true);
    expect(revokeIdentity("suzy")).toBe(false);
    expect(revokeIdentity("never-existed")).toBe(false);
  });

  it("revoking one identity does not affect siblings", () => {
    const a = issueIdentity("a");
    const b = issueIdentity("b");
    expect(revokeIdentity("a")).toBe(true);
    expect(verifyBearer("a", a.headers[AUTH_HEADER])).toBe(false);
    expect(verifyBearer("b", b.headers[AUTH_HEADER])).toBe(true);
  });

  it("_listIssuedPtyIds reflects current store contents", () => {
    expect(_listIssuedPtyIds()).toEqual([]);
    issueIdentity("a");
    issueIdentity("b");
    expect(_listIssuedPtyIds().sort()).toEqual(["a", "b"]);
    revokeIdentity("a");
    expect(_listIssuedPtyIds()).toEqual(["b"]);
  });

  // ── getIdentity ──────────────────────────────────────────────────────

  it("getIdentity returns the public identity for issued ptyIds", () => {
    const issued = issueIdentity("suzy");
    const fetched = getIdentity("suzy");
    expect(fetched).toBeDefined();
    expect(fetched!.headers[AUTH_HEADER]).toBe(issued.headers[AUTH_HEADER]);
    expect(fetched!.ptyId).toBe("suzy");
  });

  it("getIdentity returns undefined for unknown ptyIds", () => {
    expect(getIdentity("nope")).toBeUndefined();
  });
});
