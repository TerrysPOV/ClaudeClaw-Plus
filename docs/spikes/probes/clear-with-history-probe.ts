#!/usr/bin/env bun
/**
 * Spike 0.5 supplemental — does `/clear` rotate to a fresh JSONL, or wipe
 * the existing one in place, or do something else?
 *
 * Drive a real first turn before /clear so the JSONL has assistant content
 * to lose. Then send /clear, then /exit. Snapshot the project dir at each
 * step and count files + bytes.
 */

import { spawn as ptySpawn } from "bun-pty";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function snapshotDir(dir: string, label: string) {
  if (!existsSync(dir)) {
    console.log(`  [${label}] (project dir does not exist)`);
    return [];
  }
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = join(dir, f);
      const st = statSync(p);
      return { name: f, bytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);
  console.log(`  [${label}] ${entries.length} jsonl file(s):`);
  for (const e of entries) console.log(`    ${e.name}  ${e.bytes}B`);
  return entries;
}

async function main() {
  const rawWork = await mkdtemp(join(tmpdir(), "spike-0.5-clear-hist-"));
  const work = await realpath(rawWork);
  await writeFile(join(work, "README.md"), "# spike clear-hist\n");
  const projectDir = join(homedir(), ".claude", "projects", encodeCwd(work));
  console.log(`workdir:    ${work}`);
  console.log(`projectDir: ${projectDir}`);

  const pty = ptySpawn("claude", [], { cwd: work, cols: 120, rows: 30, env: { ...process.env, CI: "1" } as Record<string, string> });
  let buf = "";
  let exitCode: number | null = null;
  pty.onData((d: string) => {
    buf += d;
  });
  pty.onExit((info: { exitCode: number }) => {
    exitCode = info.exitCode;
  });

  await Bun.sleep(7000);
  snapshotDir(projectDir, "after banner");

  // Seed a quick exchange.
  pty.write("say only the word OK\r");
  await Bun.sleep(25000);
  const afterTurn = snapshotDir(projectDir, "after first turn");

  // Copy the JSONL we expect to be cleared.
  if (afterTurn[0]) {
    copyFileSync(join(projectDir, afterTurn[0].name), join(import.meta.dir, "..", "fixtures", "lifecycle", "clear", "pre-clear-with-history.jsonl"));
  }

  // /clear
  pty.write("/clear\r");
  await Bun.sleep(6000);
  const afterClear = snapshotDir(projectDir, "after /clear");

  // /exit
  pty.write("/exit\r");
  await Bun.sleep(4000);
  const afterExit = snapshotDir(projectDir, "after /exit");

  for (const e of afterExit) {
    const src = join(projectDir, e.name);
    const dst = join(import.meta.dir, "..", "fixtures", "lifecycle", "clear", `post-${e.name}`);
    copyFileSync(src, dst);
  }
  await writeFile(join(import.meta.dir, "..", "fixtures", "lifecycle", "clear", "banner-with-history.tail"), buf.slice(-4000));

  if (exitCode === null) {
    pty.kill("SIGTERM");
    await Bun.sleep(500);
    if (exitCode === null) pty.kill("SIGKILL");
  }

  console.log(`\nSummary:`);
  console.log(`  files after turn:  ${afterTurn.length}`);
  console.log(`  files after clear: ${afterClear.length}`);
  console.log(`  files after exit:  ${afterExit.length}`);
  if (afterTurn[0] && afterClear[0]) {
    const same = afterTurn[0].name === afterClear[0].name;
    console.log(`  filename stable across /clear? ${same}`);
    if (same) {
      console.log(`  bytes before: ${afterTurn[0].bytes}  after: ${afterClear[0].bytes}  Δ=${afterClear[0].bytes - afterTurn[0].bytes}`);
    } else {
      console.log(`  ROTATED: pre=${afterTurn[0].name} (${afterTurn[0].bytes}B)  post=${afterClear[0].name} (${afterClear[0].bytes}B)`);
    }
  }

  await rm(rawWork, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
