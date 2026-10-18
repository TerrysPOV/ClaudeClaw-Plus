/**
 * The Discord thread-intent classifier runs `claude --print` on a message
 * written by a guild member. It used to inherit every built-in tool, every
 * MCP server and the daemon's full env — so a message could ask it to run a
 * shell command or read a file, and its output was parsed for thread names.
 * It now runs with no tools, no MCP, and an allowlisted env.
 */
import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { classifierSpawnEnv } from "../commands/discord";
import { buildPrintArgs } from "../oneshot/print";

// The argv `classifyThreadIntent` executes: runOneShot builds it with
// buildPrintArgs for the discord.classifier route, untrusted, prompt on stdin.
const CLASSIFIER_ARGS = buildPrintArgs({
  route: "discord.classifier",
  prompt: "private message",
  model: "claude-sonnet-4-20250514",
  isolation: "untrusted",
  timeoutMs: 15000,
});

describe("classifyThreadIntent isolation", () => {
  it("disables every built-in tool and every MCP server", () => {
    const i = CLASSIFIER_ARGS.indexOf("--tools");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(CLASSIFIER_ARGS[i + 1]).toBe("");
    expect(CLASSIFIER_ARGS).toContain("--strict-mcp-config");
    expect(CLASSIFIER_ARGS).not.toContain("--mcp-config");
    expect(CLASSIFIER_ARGS).toContain("--print");
  });

  it("keeps the message out of argv (it is delivered on stdin)", () => {
    expect(CLASSIFIER_ARGS).not.toContain("private message");
    expect(CLASSIFIER_ARGS).not.toContain("-p");
  });

  it("loads no settings file (hooks, user plugins) and no skills", () => {
    const i = CLASSIFIER_ARGS.indexOf("--setting-sources");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(CLASSIFIER_ARGS[i + 1]).toBe("");
    expect(CLASSIFIER_ARGS).toContain("--disable-slash-commands");
  });

  it("passes model auth and basics, drops chat tokens and other daemon secrets", () => {
    const env = classifierSpawnEnv({
      PATH: "/usr/bin",
      HOME: "/somewhere/else",
      LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "oat",
      HTTPS_PROXY: "http://proxy:3128",
      DISCORD_TOKEN: "discord-secret",
      TELEGRAM_TOKEN: "telegram-secret",
      GITHUB_TOKEN: "gh-secret",
      SSH_AUTH_SOCK: "/run/agent.sock",
      DATABASE_URL: "postgres://u:p@db/x",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: homedir(),
      LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "oat",
      HTTPS_PROXY: "http://proxy:3128",
    });
  });
});
