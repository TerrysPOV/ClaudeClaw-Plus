#!/usr/bin/env bun
/**
 * Spike 0.3 — UDS probe.
 *
 * Validates the Bus core ↔ Bus MCP IPC transport choice on macOS/Linux per
 * spec §5.4. Measures:
 *  - sun_path byte budget for realistic agent_id slugs
 *  - connect latency p50/p99 over 100 iterations
 *  - 1KB roundtrip latency p50/p99 over 100 iterations
 *  - atomic-create pattern (<path>.tmp → chmod → rename)
 *  - crash recovery (kill server, cleanup stale socket, restart)
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// ---------- helpers ----------

const SUN_PATH_LIMIT_MACOS = 104; // includes NUL
const SUN_PATH_SAFETY = 100; // spec §5.4: 4-byte margin
const SAMPLES = 100;
const KB_PAYLOAD = Buffer.alloc(1024, 0x41); // 1KB of 'A'

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function instanceIdFromCwd(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8);
}

function resolvedSocketPath(agentId: string, instanceId: string): string {
  const base = process.env.XDG_RUNTIME_DIR ?? path.join(os.homedir(), ".claudeclaw", "run");
  return path.join(base, `bus-${instanceId}-${agentId}.sock`);
}

function pathBudgetCheck(p: string): { bytes: number; ok: boolean; margin: number } {
  const bytes = Buffer.byteLength(p, "utf8");
  return { bytes, ok: bytes <= SUN_PATH_SAFETY, margin: SUN_PATH_LIMIT_MACOS - bytes };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uds-spike-"));
  try {
    return await fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

// ---------- probes ----------

function probePathBudget(): void {
  console.log("\n=== Path budget ===");
  const instanceId = instanceIdFromCwd();
  console.log(`HOME = ${os.homedir()} (${Buffer.byteLength(os.homedir())} bytes)`);
  console.log(`XDG_RUNTIME_DIR = ${process.env.XDG_RUNTIME_DIR ?? "(unset — using $HOME fallback)"}`);
  console.log(`instanceId = ${instanceId}`);

  const agents = [
    "triage-agent",
    "research-agent",
    "my-very-long-customer-named-agent-instance",
    "a".repeat(40),
    "a".repeat(50),
    "a".repeat(60),
  ];
  for (const a of agents) {
    const p = resolvedSocketPath(a, instanceId);
    const { bytes, ok, margin } = pathBudgetCheck(p);
    console.log(`  ${a.padEnd(46)} → ${bytes}B  ${ok ? "OK" : "OVERFLOW"}  margin=${margin}`);
  }
}

async function bindAndServe(sockPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.on("data", (buf) => {
        // echo back
        sock.write(buf);
      });
    });
    server.once("error", reject);
    server.listen(sockPath, () => resolve(server));
  });
}

/** Atomic create per spec §5.4: bind to .tmp → chmod → rename → final path. */
async function atomicBind(sockPath: string): Promise<net.Server> {
  const tmp = `${sockPath}.tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch {}
  const server = await bindAndServe(tmp);
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, sockPath);
  return server;
}

async function connectClient(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath, () => resolve(c));
    c.once("error", reject);
  });
}

/**
 * Roundtrip on a persistent socket. We attach a single data listener that
 * resolves the current pending request, then we keep the listener attached
 * across iterations to avoid listener-leak warnings.
 */
function makeRoundtripper(c: net.Socket): (payload: Buffer) => Promise<number> {
  let received = 0;
  let pending: { expected: number; t0: number; resolve: (n: number) => void } | null = null;
  c.on("data", (buf: Buffer) => {
    received += buf.length;
    if (pending && received >= pending.expected) {
      const rtt = performance.now() - pending.t0;
      const resolver = pending.resolve;
      pending = null;
      received = 0;
      resolver(rtt);
    }
  });
  return (payload: Buffer) =>
    new Promise<number>((resolve) => {
      pending = { expected: payload.length, t0: performance.now(), resolve };
      c.write(payload);
    });
}

async function probeLatency(sockDir: string): Promise<void> {
  console.log("\n=== Latency ===");
  const sockPath = path.join(sockDir, "bus-latency.sock");
  const server = await atomicBind(sockPath);
  console.log(`Bound at ${sockPath} (${Buffer.byteLength(sockPath)}B)`);

  // connect latency
  const connTimes: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const c = await connectClient(sockPath);
    connTimes.push(performance.now() - t0);
    c.destroy();
  }
  console.log(`  connect  p50=${pct(connTimes, 50).toFixed(3)}ms  p99=${pct(connTimes, 99).toFixed(3)}ms`);

  // 1KB roundtrip latency on a persistent connection
  const c = await connectClient(sockPath);
  const rt = makeRoundtripper(c);
  const rtTimes: number[] = [];
  for (let i = 0; i < 10; i++) await rt(KB_PAYLOAD); // warmup
  for (let i = 0; i < SAMPLES; i++) rtTimes.push(await rt(KB_PAYLOAD));
  c.destroy();
  console.log(`  1KB RTT  p50=${pct(rtTimes, 50).toFixed(3)}ms  p99=${pct(rtTimes, 99).toFixed(3)}ms`);

  await new Promise<void>((r) => server.close(() => r()));
  try {
    fs.unlinkSync(sockPath);
  } catch {}
}

async function probeAtomicCreate(sockDir: string): Promise<void> {
  console.log("\n=== Atomic create ===");
  const sockPath = path.join(sockDir, "bus-atomic.sock");
  const server = await atomicBind(sockPath);
  const st = fs.statSync(sockPath);
  const mode = (st.mode & 0o777).toString(8);
  const tmpExists = fs.existsSync(`${sockPath}.tmp`);
  console.log(`  final path exists: ${fs.existsSync(sockPath)}`);
  console.log(`  mode: 0${mode}  (expected 0600)`);
  console.log(`  .tmp leftover: ${tmpExists}  (expected false)`);
  // Quick connect to prove it's a live listener
  const c = await connectClient(sockPath);
  c.destroy();
  console.log(`  client can connect: true`);
  await new Promise<void>((r) => server.close(() => r()));
  fs.unlinkSync(sockPath);
}

/**
 * Bind at the resolved spec path (no temp dir) to confirm the OS actually
 * accepts a path right up against the 100-byte safety budget. Uses the actual
 * $HOME/.claudeclaw/run/ fallback location.
 */
async function probeSpecPathBind(): Promise<void> {
  console.log("\n=== Spec-path bind (real $HOME/.claudeclaw/run/) ===");
  const instanceId = instanceIdFromCwd();
  const runDir = path.join(os.homedir(), ".claudeclaw", "run");
  fs.mkdirSync(runDir, { recursive: true });

  // Test with the longest agent slug that fits inside the 100-byte budget,
  // accounting for the +4 byte `.tmp` overhead from atomic-create.
  const testCases = [
    { agent: "triage-agent", note: "typical short slug" },
    { agent: "my-very-long-customer-named-agent-instance", note: "100B final — atomic-create needs 104B (.tmp)" },
    { agent: "my-very-long-customer-named-agent-insta", note: "96B final — leaves 4B headroom for .tmp" },
  ];

  for (const { agent, note } of testCases) {
    const sockPath = resolvedSocketPath(agent, instanceId);
    const bytes = Buffer.byteLength(sockPath);
    process.stdout.write(`  [${bytes}B] ${note}: `);
    try {
      const server = await atomicBind(sockPath);
      const c = await connectClient(sockPath);
      c.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      fs.unlinkSync(sockPath);
      console.log("bind+connect OK");
    } catch (e) {
      console.log(`FAILED — ${(e as Error).message}`);
    }
  }

  try {
    fs.rmdirSync(runDir);
    fs.rmdirSync(path.dirname(runDir));
  } catch {}
}

async function probeCrashRecovery(sockDir: string): Promise<void> {
  console.log("\n=== Crash recovery ===");
  const sockPath = path.join(sockDir, "bus-crash.sock");
  const server = await atomicBind(sockPath);
  // Simulate crash: close listener WITHOUT unlinking (the SIGKILL scenario).
  await new Promise<void>((r) => server.close(() => r()));
  const stale = fs.existsSync(sockPath);
  console.log(`  stale socket present after crash: ${stale}`);

  // Client tries connect → should fail.
  let connectErr: Error | null = null;
  try {
    const c = await connectClient(sockPath);
    c.destroy();
  } catch (e) {
    connectErr = e as Error;
  }
  console.log(`  client connect to stale socket: ${connectErr ? "rejected ✓" : "succeeded (unexpected)"}`);

  // Daemon-restart cleanup: probe with connect() — fails → unlink → rebind.
  if (fs.existsSync(sockPath)) {
    let listenerAlive = false;
    try {
      const probe = await connectClient(sockPath);
      probe.destroy();
      listenerAlive = true;
    } catch {
      listenerAlive = false;
    }
    if (!listenerAlive) {
      fs.unlinkSync(sockPath);
      console.log(`  stale-socket cleanup: unlinked`);
    } else {
      console.log(`  WARN: live listener detected, would refuse cleanup`);
    }
  }

  // Rebind succeeds.
  const server2 = await atomicBind(sockPath);
  const c = await connectClient(sockPath);
  const rt = makeRoundtripper(c);
  const rttMs = await rt(Buffer.from("ping"));
  console.log(`  rebind + reconnect roundtrip: ${rttMs.toFixed(3)}ms ✓`);
  c.destroy();
  await new Promise<void>((r) => server2.close(() => r()));
  fs.unlinkSync(sockPath);
}

async function main(): Promise<void> {
  console.log("Spike 0.3 — UDS probe");
  console.log(`Platform: ${process.platform}  Bun: ${Bun.version}  Node-compat: ${process.versions.node}`);

  probePathBudget();
  await probeSpecPathBind();
  await withTempDir(async (dir) => {
    await probeLatency(dir);
    await probeAtomicCreate(dir);
    await probeCrashRecovery(dir);
  });

  console.log("\nDone.");
}

void main();
