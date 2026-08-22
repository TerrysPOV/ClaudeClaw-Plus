/**
 * Tests for skills-tuner DiscordAdapter.
 *
 * Run with: bun test src/__tests__/skills-tuner/discord-adapter.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { DiscordAdapter, type DiscordAdapterConfig } from "../../skills-tuner/adapters/discord";
import type { Proposal } from "../../skills-tuner/core/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 42,
    cluster_id: "cluster-1",
    subject: "skills",
    kind: "create",
    target_path: "/home/user/.claude/skills/foo.md",
    alternatives: [
      { id: "a", label: "Tight option", diff_or_content: "x", tradeoff: "fast but terse" },
      { id: "b", label: "Verbose option", diff_or_content: "y", tradeoff: "longer but clearer" },
    ],
    pattern_signature: "sig-1",
    created_at: new Date("2026-05-17T00:00:00Z"),
    signature: "test-signature",
    ...overrides,
  } as Proposal;
}

function makeConfig(overrides: Partial<DiscordAdapterConfig> = {}): DiscordAdapterConfig {
  return {
    botToken: "test-token",
    channelId: "1234567890",
    baseUrl: "https://discord.test",
    allowedUserIds: ["user-alice", "user-bob"],
    ...overrides,
  };
}

// fetch mock — captures calls and returns canned responses
type CapturedCall = { url: string; init?: RequestInit };
let capturedCalls: CapturedCall[];
let nextResponse: { ok: boolean; status: number; body: string };
const origFetch = globalThis.fetch;

beforeEach(() => {
  capturedCalls = [];
  nextResponse = { ok: true, status: 200, body: '{"id":"msg-1"}' };
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    capturedCalls.push({ url: url.toString(), init });
    return new Response(nextResponse.body, { status: nextResponse.status });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

// ─── Constructor ─────────────────────────────────────────────────────────────

describe("DiscordAdapter constructor", () => {
  it("rejects empty allowedUserIds", () => {
    expect(() => new DiscordAdapter(makeConfig({ allowedUserIds: [] }))).toThrow(
      /at least one allowedUserId/,
    );
  });

  it("rejects missing botToken", () => {
    expect(() => new DiscordAdapter(makeConfig({ botToken: "" }))).toThrow(/requires botToken/);
  });

  it("rejects missing channelId", () => {
    expect(() => new DiscordAdapter(makeConfig({ channelId: "" }))).toThrow(/requires channelId/);
  });

  it("accepts valid config", () => {
    expect(() => new DiscordAdapter(makeConfig())).not.toThrow();
  });
});

// ─── renderProposal ──────────────────────────────────────────────────────────

describe("DiscordAdapter.renderProposal", () => {
  it("posts to /channels/{channelId}/messages with Bot auth header", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    await adapter.renderProposal(makeProposal());
    expect(capturedCalls).toHaveLength(1);
    const call = capturedCalls[0]!;
    expect(call.url).toBe("https://discord.test/channels/1234567890/messages");
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bot test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("never embeds botToken in the URL", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    await adapter.renderProposal(makeProposal());
    expect(capturedCalls[0]!.url).not.toContain("test-token");
  });

  it("builds an Apply button per alternative + Refuse/Edit row", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    await adapter.renderProposal(makeProposal());
    const body = JSON.parse(capturedCalls[0]!.init?.body as string);
    expect(body.components).toHaveLength(2);
    const applyRow = body.components[0];
    expect(applyRow.type).toBe(1); // action row
    expect(applyRow.components).toHaveLength(2); // 2 alternatives
    expect(applyRow.components[0].custom_id).toBe("apply:42:a");
    expect(applyRow.components[1].custom_id).toBe("apply:42:b");
    const decisionRow = body.components[1];
    expect(decisionRow.components.map((b: { custom_id: string }) => b.custom_id)).toEqual([
      "refuse:42",
      "edit:42",
    ]);
  });

  it("truncates button labels exceeding Discord's 80-char limit", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    const longLabel = "x".repeat(200);
    await adapter.renderProposal(
      makeProposal({
        alternatives: [{ id: "a", label: longLabel, diff_or_content: "", tradeoff: "" }],
      }),
    );
    const body = JSON.parse(capturedCalls[0]!.init?.body as string);
    const label: string = body.components[0].components[0].label;
    expect(label.length).toBeLessThanOrEqual(80);
  });

  it("throws with the HTTP status when Discord rejects the request", async () => {
    nextResponse = { ok: false, status: 401, body: "Unauthorized" };
    const adapter = new DiscordAdapter(makeConfig());
    await expect(adapter.renderProposal(makeProposal())).rejects.toThrow(
      /Discord createMessage failed: 401/,
    );
  });

  it("does not leak the botToken in error messages", async () => {
    nextResponse = { ok: false, status: 500, body: "some error" };
    const adapter = new DiscordAdapter(makeConfig({ botToken: "secret-token-do-not-leak" }));
    let err: Error | null = null;
    try {
      await adapter.renderProposal(makeProposal());
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("secret-token-do-not-leak");
  });
});

// ─── handleCallback ──────────────────────────────────────────────────────────

describe("DiscordAdapter.handleCallback", () => {
  it("rejects users not in allowedUserIds", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    await expect(adapter.handleCallback("apply:1:a", "user-eve")).rejects.toThrow(
      /not in allowedUserIds/,
    );
  });

  it("accepts users in allowedUserIds and fires callback", async () => {
    const seen: { proposalId: number; alternativeId?: string; action: string }[] = [];
    const adapter = new DiscordAdapter(
      makeConfig({
        callbackHandler: async (p) => {
          seen.push(p);
        },
      }),
    );
    await adapter.handleCallback("apply:42:a", "user-alice");
    expect(seen).toEqual([{ proposalId: 42, alternativeId: "a", action: "apply" }]);
  });

  it("rejects malformed custom_id", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    await expect(adapter.handleCallback("malformed", "user-alice")).rejects.toThrow(
      /Discord callback malformed/,
    );
  });

  it("rejects unknown action verb", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    await expect(adapter.handleCallback("destroy:1", "user-alice")).rejects.toThrow(
      /unknown action/,
    );
  });

  it("rejects non-numeric proposalId", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    await expect(adapter.handleCallback("apply:abc:x", "user-alice")).rejects.toThrow(
      /invalid proposalId/,
    );
  });

  it("rejects proposalId < 1", async () => {
    const adapter = new DiscordAdapter(makeConfig());
    await expect(adapter.handleCallback("apply:0:x", "user-alice")).rejects.toThrow(
      /invalid proposalId/,
    );
  });

  it("calls verifyProposalFn before firing callback when provided", async () => {
    let verified: number | null = null;
    let callbackFired = false;
    const adapter = new DiscordAdapter(
      makeConfig({
        verifyProposalFn: async (id) => {
          verified = id;
          return true;
        },
        callbackHandler: async () => {
          callbackFired = true;
        },
      }),
    );
    await adapter.handleCallback("apply:42:a", "user-alice");
    expect(verified).toBe(42);
    expect(callbackFired).toBe(true);
  });

  it("blocks the callback when verifyProposalFn returns false", async () => {
    let callbackFired = false;
    const adapter = new DiscordAdapter(
      makeConfig({
        verifyProposalFn: async () => false,
        callbackHandler: async () => {
          callbackFired = true;
        },
      }),
    );
    await expect(adapter.handleCallback("apply:42:a", "user-alice")).rejects.toThrow(
      /verifyProposalFn rejected/,
    );
    expect(callbackFired).toBe(false);
  });

  it("parses refuse without alternativeId", async () => {
    const seen: { proposalId: number; alternativeId?: string; action: string }[] = [];
    const adapter = new DiscordAdapter(
      makeConfig({
        callbackHandler: async (p) => {
          seen.push(p);
        },
      }),
    );
    await adapter.handleCallback("refuse:42", "user-alice");
    expect(seen[0]).toEqual({ proposalId: 42, alternativeId: undefined, action: "refuse" });
  });
});

// ─── formatProposalText ──────────────────────────────────────────────────────

describe("DiscordAdapter.formatProposalText", () => {
  it("includes proposal id, subject/kind, target path, alternatives", () => {
    const adapter = new DiscordAdapter(makeConfig());
    const txt = adapter.formatProposalText(makeProposal());
    expect(txt).toContain("Proposal #42");
    expect(txt).toContain("skills/create");
    expect(txt).toContain("/home/user/.claude/skills/foo.md");
    expect(txt).toContain("Tight option");
    expect(txt).toContain("Verbose option");
  });

  it("substitutes 'no tradeoff' when tradeoff is empty", () => {
    const adapter = new DiscordAdapter(makeConfig());
    const txt = adapter.formatProposalText(
      makeProposal({
        alternatives: [{ id: "a", label: "Plain", diff_or_content: "", tradeoff: "" }],
      }),
    );
    expect(txt).toContain("no tradeoff");
  });
});
