import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSafeGitUrl,
  isSafeNpmSpec,
  defaultAuditReader,
} from "../../../subjects/mcp-plugin-subject.js";

// The first line of defense before the registry gate — worth its own suite.
describe("isSafeGitUrl", () => {
  it("accepts a plain https git url", () => {
    expect(isSafeGitUrl("https://github.com/qdrant/mcp-server-qdrant")).toBe(true);
  });

  it("rejects non-https schemes (file/ssh/scp-style/http)", () => {
    for (const bad of [
      "file:///etc/passwd",
      "ssh://git@github.com/owner/repo",
      "git@github.com:owner/repo.git", // scp-style, not a valid https URL
      "http://github.com/o/r",
      "",
      "not a url",
    ]) {
      expect(isSafeGitUrl(bad)).toBe(false);
    }
  });

  it("rejects SSRF-ish hosts (loopback, private ranges, cloud metadata, IPv6)", () => {
    for (const bad of [
      "https://localhost/o/r",
      "https://127.0.0.1/o/r",
      "https://10.0.0.5/o/r",
      "https://192.168.1.1/o/r",
      "https://172.16.0.1/o/r",
      "https://169.254.169.254/latest/meta-data", // cloud metadata endpoint
      "https://[::1]/o/r",
    ]) {
      expect(isSafeGitUrl(bad)).toBe(false);
    }
  });
});

describe("isSafeNpmSpec", () => {
  it("accepts a plain name / scoped name / name@version", () => {
    expect(isSafeNpmSpec("mcp-server-qdrant")).toBe(true);
    expect(isSafeNpmSpec("mcp-server-qdrant@1.2.3")).toBe(true);
    expect(isSafeNpmSpec("@scope/pkg@1.0.0")).toBe(true);
  });

  it("rejects leading-flag, path, url and shell-metachar specs", () => {
    for (const bad of [
      "--registry=http://evil", // flag injection (leading '-')
      "../../etc/passwd", // path traversal (leading '.')
      ".hidden",
      "http://evil/pkg.tgz", // url scheme
      "pkg; rm -rf /", // shell metachar in the name part
      "pkg$(whoami)",
      "pkg`id`",
      "pkg && curl evil",
      "",
    ]) {
      expect(isSafeNpmSpec(bad)).toBe(false);
    }
  });
});

describe("defaultAuditReader — timestamp windowing", () => {
  it("skips lines with a missing or unparseable ts so they can't accumulate forever", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-ts-"));
    const p = join(dir, "operations.jsonl");
    const since = new Date("2026-01-01T00:00:00.000Z");
    writeFileSync(
      p,
      `${[
        JSON.stringify({ type: "mcp_tool_call", tool: "a", ts: "2026-06-01T00:00:00.000Z" }), // in window
        JSON.stringify({ type: "mcp_tool_call", tool: "b" }), // NO ts → must be skipped
        JSON.stringify({ type: "mcp_tool_call", tool: "c", ts: "not-a-date" }), // bad ts → skipped
        JSON.stringify({ type: "mcp_tool_call", tool: "d", ts: "2020-01-01T00:00:00.000Z" }), // pre-window
      ].join("\n")}\n`,
    );
    const events = defaultAuditReader(p, since);
    rmSync(dir, { recursive: true, force: true });
    // Only the genuinely in-window record survives.
    expect(events.map((e) => e.tool)).toEqual(["a"]);
  });
});
