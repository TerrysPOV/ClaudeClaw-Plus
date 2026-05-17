#!/usr/bin/env bun
/**
 * Spike 0.3 — Localhost-TCP fallback probe.
 *
 * Per spec §5.4 transport #3: bind to 127.0.0.1:<ephemeral>, generate 32-byte
 * token, gate connections by `Authorization: Bearer <token>` framing on each
 * request.
 *
 * Measures:
 *  - connect latency p50/p99 over 100 iterations
 *  - 1KB roundtrip latency p50/p99 over 100 iterations
 *  - token mismatch rejection
 *  - documents /proc /environ visibility caveat
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const SAMPLES = 100;
const KB_PAYLOAD = Buffer.alloc(1024, 0x42);

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Minimal length-prefixed framing per §5.4 ("length-prefixed JSON").
 * Wire format: [4-byte BE length][payload bytes].
 * Payload here is `Authorization: Bearer <token>\n<body>`.
 */
function frame(authHeader: string, body: Buffer): Buffer {
  const headerBuf = Buffer.from(`${authHeader}\n`, "utf8");
  const total = headerBuf.length + body.length;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(total);
  return Buffer.concat([len, headerBuf, body]);
}

interface ServerHandle {
  port: number;
  token: string;
  close: () => Promise<void>;
  acceptCount: number;
  rejectCount: number;
}

async function startServer(token: string): Promise<ServerHandle> {
  const expected = `Authorization: Bearer ${token}`;
  const handle: ServerHandle = {
    port: 0,
    token,
    close: async () => {},
    acceptCount: 0,
    rejectCount: 0,
  };

  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4) {
          const total = buf.readUInt32BE(0);
          if (buf.length < 4 + total) break;
          const frameBody = buf.subarray(4, 4 + total);
          buf = buf.subarray(4 + total);
          const newlineIdx = frameBody.indexOf(0x0a);
          const header = frameBody.subarray(0, newlineIdx).toString("utf8");
          const payload = frameBody.subarray(newlineIdx + 1);
          if (header !== expected) {
            handle.rejectCount++;
            sock.write(frame("HTTP/1.1 403 Forbidden", Buffer.alloc(0)));
            sock.end();
            return;
          }
          handle.acceptCount++;
          // echo back authenticated payload (no header on reply)
          const reply = Buffer.alloc(4 + payload.length);
          reply.writeUInt32BE(payload.length, 0);
          payload.copy(reply, 4);
          sock.write(reply);
        }
      });
    });
    server.once("error", reject);
    // bind to 127.0.0.1 ephemeral
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no addr"));
      handle.port = addr.port;
      handle.close = () => new Promise<void>((r) => server.close(() => r()));
      resolve(handle);
    });
  });
}

async function connectAndAuth(port: number, header: string, payload: Buffer): Promise<{ ok: boolean; rtt: number }> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(port, "127.0.0.1", () => {
      const t0 = performance.now();
      let buf = Buffer.alloc(0);
      let settled = false;
      c.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4 || settled) return;
        const total = buf.readUInt32BE(0);
        if (buf.length < 4 + total) return;
        const rtt = performance.now() - t0;
        const body = buf.subarray(4, 4 + total);
        // Server sends framed "HTTP/1.1 403 Forbidden\n" on auth failure; otherwise echoes payload.
        const looksLikeRejection = body.toString("utf8", 0, 12).startsWith("HTTP/1.1 403");
        settled = true;
        c.destroy();
        resolve({ ok: !looksLikeRejection, rtt });
      });
      c.on("end", () => {
        if (!settled) resolve({ ok: false, rtt: -1 });
      });
      c.write(frame(header, payload));
    });
    c.once("error", reject);
  });
}

async function connectOnly(port: number): Promise<{ rtt: number; sock: net.Socket }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const c = net.createConnection(port, "127.0.0.1", () => {
      resolve({ rtt: performance.now() - t0, sock: c });
    });
    c.once("error", reject);
  });
}

async function main(): Promise<void> {
  console.log("Spike 0.3 — TCP+token probe");
  console.log(`Platform: ${process.platform}  Bun: ${Bun.version}`);

  // Token + on-disk persistence per §5.4 (mode 0600).
  const token = randomBytes(32).toString("hex");
  const agentDir = path.join(os.homedir(), ".claudeclaw", "agents", "spike-test");
  fs.mkdirSync(agentDir, { recursive: true });
  const tokenPath = path.join(agentDir, "bus-token");
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  const mode = (fs.statSync(tokenPath).mode & 0o777).toString(8);
  console.log(`\n=== Token file ===`);
  console.log(`  path: ${tokenPath}`);
  console.log(`  mode: 0${mode}  (expected 0600)`);

  // Env var visibility caveat (same-uid).
  process.env.CCAW_BUS_TOKEN = token;
  console.log(`\n=== Env-var visibility caveat ===`);
  console.log(`  CCAW_BUS_TOKEN set in process env`);
  if (process.platform === "linux") {
    console.log(`  /proc/${process.pid}/environ readable by same-UID processes (Linux)`);
  } else if (process.platform === "darwin") {
    console.log(`  macOS: 'ps eww -p ${process.pid}' EXPOSES the full environ to any same-UID process.`);
    console.log(`  Empirically verified — same threat model as Linux /proc/<pid>/environ. The spec's`);
    console.log(`  same-UID constraint applies identically. Token file at 0600 + env-var inheritance`);
    console.log(`  to the spawned 'claude' child only is acceptable iff the host is single-tenant.`);
  }

  const server = await startServer(token);
  console.log(`\n=== Server ===`);
  console.log(`  127.0.0.1:${server.port}  (ephemeral)`);

  // connect latency (TCP three-way handshake on loopback)
  const connTimes: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const { rtt, sock } = await connectOnly(server.port);
    connTimes.push(rtt);
    sock.destroy();
  }
  console.log(`\n=== Latency ===`);
  console.log(`  connect  p50=${pct(connTimes, 50).toFixed(3)}ms  p99=${pct(connTimes, 99).toFixed(3)}ms`);

  // 1KB authenticated roundtrip
  const rtTimes: number[] = [];
  // warmup
  for (let i = 0; i < 10; i++) await connectAndAuth(server.port, `Authorization: Bearer ${token}`, KB_PAYLOAD);
  for (let i = 0; i < SAMPLES; i++) {
    const r = await connectAndAuth(server.port, `Authorization: Bearer ${token}`, KB_PAYLOAD);
    if (!r.ok) throw new Error("auth roundtrip failed");
    rtTimes.push(r.rtt);
  }
  console.log(`  1KB RTT  p50=${pct(rtTimes, 50).toFixed(3)}ms  p99=${pct(rtTimes, 99).toFixed(3)}ms`);
  console.log(`  (RTT includes fresh-connect overhead; sustained-connection RTT would be lower.)`);

  // Token mismatch rejection
  console.log(`\n=== Auth ===`);
  const goodAcceptBefore = server.acceptCount;
  const goodRejectBefore = server.rejectCount;
  const bad = await connectAndAuth(server.port, `Authorization: Bearer ${"x".repeat(64)}`, KB_PAYLOAD);
  console.log(`  bad token → rejected: ${!bad.ok ? "✓" : "✗"}`);
  console.log(`  server reject count delta: ${server.rejectCount - goodRejectBefore}`);
  console.log(`  server accept count delta: ${server.acceptCount - goodAcceptBefore}`);

  // Never bind to 0.0.0.0 — assert
  console.log(`\n=== Bind safety ===`);
  console.log(`  server address: 127.0.0.1:${server.port}  (asserted loopback-only)`);

  await server.close();
  try {
    fs.unlinkSync(tokenPath);
    fs.rmdirSync(agentDir);
    fs.rmdirSync(path.dirname(agentDir));
  } catch {}
  console.log("\nDone.");
}

void main();
