#!/usr/bin/env bun
/**
 * Spike 0.5 — Lifecycle marker discovery in claude's JSONL transcript.
 *
 * Sprint 0 of the Bus migration. v2 spec §5.2 assumed `session.init`,
 * `session.end`, `session.compact` markers in the JSONL. Nibbler couldn't
 * find them on 2.1.126. This probe re-tests on 2.1.143.
 *
 * Strategy (simplified after first attempt)
 * -----------------------------------------
 * For each command we spawn a fresh `claude` via bun-pty (Spike 0.4 proved
 * plain stdin doesn't work for slash relay). We wait for TUI paint, then
 * immediately send the slash command, wait a few seconds, then SIGTERM.
 *
 * We do NOT seed a real first turn — slash commands sent during model
 * inference get queued behind the model reply and don't fire deterministic-
 * ally. The empty-history path is enough to observe whether and how the
 * lifecycle command is recorded.
 *
 * Output:
 *   docs/spikes/fixtures/lifecycle/<command>/
 *     before.jsonl    transcript captured just before slash is typed
 *     after.jsonl     transcript captured a few seconds after slash
 *     banner.tail     PTY stdout tail (shows any human-visible signal)
 *
 * Note on cwd encoding: macOS resolves /tmp → /private/tmp via fs.realpath,
 * so claude's project-dir encoder uses the realpath. We mirror that.
 */

import { spawn as ptySpawn, type IPty } from "bun-pty";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SETTLE_BANNER_MS = 7000;
const SETTLE_AFTER_SLASH_MS = 6000;
const SETTLE_COMPACT_EXTRA_MS = 10000; // /compact may trigger a summarisation turn

interface JsonlStat {
  bytes: number;
  lines: number;
  mtime: number;
  types: Record<string, number>;
}

interface CommandResult {
  command: "/compact" | "/clear" | "/quit";
  jsonlPath: string | null;
  before: JsonlStat;
  after: JsonlStat;
  newTypes: string[];
  commandEnvelopes: string[];
  localCommandStderr: string[];
  localCommandStdout: string[];
  bannerSnippet: string;
  exitCode: number | null;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function findJsonl(projectDir: string): string | null {
  if (!existsSync(projectDir)) return null;
  const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return null;
  return files
    .map((f) => ({ p: join(projectDir, f), m: statSync(join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0].p;
}

function summariseJsonl(path: string | null): JsonlStat {
  if (!path || !existsSync(path)) return { bytes: 0, lines: 0, mtime: 0, types: {} };
  const text = readFileSync(path, "utf8");
  const st = statSync(path);
  const lines = text.split("\n").filter((l) => l.length > 0);
  const types: Record<string, number> = {};
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const base = String(obj.type ?? "<no-type>");
      const key = obj.subtype ? `${base}:${obj.subtype}` : base;
      types[key] = (types[key] ?? 0) + 1;
    } catch {
      types["<unparseable>"] = (types["<unparseable>"] ?? 0) + 1;
    }
  }
  return { bytes: st.size, lines: lines.length, mtime: st.mtimeMs, types };
}

function extractEnvelopes(path: string | null): {
  commandNames: string[];
  stderr: string[];
  stdout: string[];
} {
  if (!path || !existsSync(path)) return { commandNames: [], stderr: [], stdout: [] };
  const text = readFileSync(path, "utf8");
  const commandNames: string[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  for (const line of text.split("\n").filter((l) => l.length > 0)) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = typeof obj?.message?.content === "string" ? obj.message.content : typeof obj?.content === "string" ? obj.content : "";
    if (obj.type === "user" && content.includes("<command-name>")) {
      const m = content.match(/<command-name>([^<]+)<\/command-name>/);
      if (m) commandNames.push(m[1]);
    }
    if (obj.type === "system" && obj.subtype === "local_command") {
      const errMatch = content.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
      if (errMatch) stderr.push(errMatch[1].trim());
      const outMatch = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (outMatch) stdout.push(outMatch[1].trim());
    }
    if (obj.type === "user" && content.includes("<local-command-stdout>")) {
      const m = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (m) stdout.push(m[1].trim());
    }
  }
  return { commandNames, stderr, stdout };
}

async function runOne(command: "/compact" | "/clear" | "/quit"): Promise<CommandResult> {
  const rawWork = await mkdtemp(join(tmpdir(), `spike-0.5-${command.slice(1)}-`));
  // Resolve symlinks (macOS: /tmp → /private/tmp) so we look at the same
  // path claude uses for its project-dir key.
  const work = await realpath(rawWork);
  await writeFile(join(work, "README.md"), `# spike 0.5 ${command}\n`);

  const projectDir = join(homedir(), ".claude", "projects", encodeCwd(work));
  console.log(`\n══ ${command} ══════════════════════════════════════`);
  console.log(`workdir:    ${work}`);
  console.log(`projectDir: ${projectDir}`);

  const pty: IPty = ptySpawn("claude", [], {
    cwd: work,
    cols: 120,
    rows: 30,
    env: { ...process.env, CI: "1" } as Record<string, string>,
  });

  let buf = "";
  let exitCode: number | null = null;
  pty.onData((d: string) => {
    buf += d;
  });
  pty.onExit((info: { exitCode: number }) => {
    exitCode = info.exitCode;
  });

  await Bun.sleep(SETTLE_BANNER_MS);

  // BEFORE snapshot: whatever claude has written so far for this fresh session.
  const fixDir = join(import.meta.dir, "..", "fixtures", "lifecycle", command.slice(1));
  let jsonlPath = findJsonl(projectDir);
  if (jsonlPath) {
    copyFileSync(jsonlPath, join(fixDir, "before.jsonl"));
  } else {
    await writeFile(join(fixDir, "before.jsonl"), "");
  }
  const before = summariseJsonl(jsonlPath);
  console.log(`  before: ${before.bytes}B / ${before.lines}L / types=${Object.keys(before.types).join(",")}`);

  // Type the slash command. PTY uses CR.
  pty.write(`${command}\r`);
  const waitMs = command === "/compact" ? SETTLE_AFTER_SLASH_MS + SETTLE_COMPACT_EXTRA_MS : SETTLE_AFTER_SLASH_MS;
  await Bun.sleep(waitMs);

  // AFTER snapshot. /clear may rotate to a new JSONL — re-resolve.
  jsonlPath = findJsonl(projectDir);
  if (jsonlPath) {
    copyFileSync(jsonlPath, join(fixDir, "after.jsonl"));
  }
  const after = summariseJsonl(jsonlPath);
  console.log(`  after:  ${after.bytes}B / ${after.lines}L / types=${Object.keys(after.types).join(",")}`);

  const newTypes = Object.keys(after.types).filter((t) => !(t in before.types));
  console.log(`  newTypes: ${newTypes.join(",") || "(none)"}`);

  const env = extractEnvelopes(jsonlPath);
  console.log(`  command envelopes: ${env.commandNames.join(",") || "(none)"}`);
  if (env.stderr.length) console.log(`  local-command-stderr: ${JSON.stringify(env.stderr)}`);
  if (env.stdout.length) console.log(`  local-command-stdout: ${JSON.stringify(env.stdout)}`);

  // For /quit we expect claude to exit on its own. For /compact and /clear
  // we still need to clean up — type /exit.
  if (exitCode === null && command !== "/quit") {
    pty.write("/exit\r");
    await Bun.sleep(2500);
  }
  if (exitCode === null) {
    pty.kill("SIGTERM");
    await Bun.sleep(500);
    if (exitCode === null) pty.kill("SIGKILL");
  }
  await Bun.sleep(500);

  // Final snapshot AFTER the post-cleanup /exit so we can also see the
  // session-end envelope. Useful for /compact and /clear cases.
  const finalPath = findJsonl(projectDir);
  if (finalPath) {
    copyFileSync(finalPath, join(fixDir, "after-with-exit.jsonl"));
  }

  const banner = buf.slice(-3000);
  await writeFile(join(fixDir, "banner.tail"), banner);

  await rm(rawWork, { recursive: true, force: true }).catch(() => {});

  return {
    command,
    jsonlPath: jsonlPath ?? null,
    before,
    after,
    newTypes,
    commandEnvelopes: env.commandNames,
    localCommandStderr: env.stderr,
    localCommandStdout: env.stdout,
    bannerSnippet: banner.slice(-500),
    exitCode,
  };
}

async function main(): Promise<void> {
  const results: CommandResult[] = [];
  for (const cmd of ["/compact", "/clear", "/quit"] as const) {
    try {
      results.push(await runOne(cmd));
    } catch (err) {
      console.error(`  !! failed: ${err}`);
    }
  }

  console.log(`\n══ SUMMARY ════════════════════════════════════════════`);
  for (const r of results) {
    console.log(`${r.command}: bytes ${r.before.bytes} → ${r.after.bytes} | lines ${r.before.lines} → ${r.after.lines} | exit=${r.exitCode}`);
    console.log(`  envelopes: ${r.commandEnvelopes.join(",") || "(none)"}`);
    console.log(`  stderr:    ${JSON.stringify(r.localCommandStderr)}`);
    console.log(`  stdout:    ${JSON.stringify(r.localCommandStdout)}`);
    console.log(`  newTypes:  ${r.newTypes.join(",") || "(none)"}`);
  }
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
