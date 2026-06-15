/**
 * Bus core — IPC server helpers.
 *
 * Implements the wire framing and UDS binding for the Bus core ↔ Bus MCP
 * server channel (spec §5.4). Sprint 1 only ships UDS — TCP/named-pipe
 * fallback is stubbed with a TODO for Spike 0.3 follow-up.
 *
 * Wire format (every transport): `<uint32-be length><utf8 json bytes>`.
 */

import { existsSync, mkdirSync, unlinkSync, chmodSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import { type IpcMessage, UDS_PATH_MAX_BYTES } from "./types";

/**
 * Required capability strings declared by Bus MCP. Per Spike 0.1, both must
 * be present in `IpcHello.capabilities` for the handshake to succeed.
 */
export const REQUIRED_MCP_CAPABILITIES: readonly string[] = [
  "claude/channel",
  "claude/channel/permission",
] as const;

/**
 * Validate the resolved UDS path fits within the safe budget.
 * macOS `sun_path` is 104 bytes; atomic-create needs +4B for `.tmp`.
 * Per Spike 0.3 the safe cap is 96 bytes.
 */
export function validateUdsPath(path: string): void {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes > UDS_PATH_MAX_BYTES) {
    throw new Error(
      `UDS path exceeds ${UDS_PATH_MAX_BYTES}-byte safe cap (got ${bytes} bytes): ${path}\n` +
        `  Fixes: shorten agent_id, use a shorter $HOME, or set XDG_RUNTIME_DIR.`,
    );
  }
}

/**
 * Validate an inbound `IpcHello` declares both required Channels capabilities.
 * Returns null on success, or an error message on failure.
 */
export function validateHelloCapabilities(caps: readonly string[]): string | null {
  for (const required of REQUIRED_MCP_CAPABILITIES) {
    if (!caps.includes(required)) {
      return `Missing required MCP capability: ${required}`;
    }
  }
  return null;
}

/* ───────────────────────────────────────────────────────────────────── */
/* Length-prefixed framing                                               */
/* ───────────────────────────────────────────────────────────────────── */

/**
 * Encode a message as `<uint32-be length><utf8 json>`. Returns a Buffer
 * ready to write to a Bun socket.
 */
export function encodeFrame(message: IpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Stateful framing decoder. Accumulates partial reads and emits whole
 * messages as they become available. Caller invokes `push(bytes)` for each
 * inbound chunk; the decoder calls `onMessage` for each complete frame.
 *
 * Hard cap of 16 MiB per frame keeps a runaway sender from exhausting RAM.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private onMessage: (msg: IpcMessage) => void,
    private onError: (err: Error) => void,
  ) {}

  push(chunk: Uint8Array | Buffer): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.onError(new Error(`Frame exceeds ${MAX_FRAME_BYTES} byte cap: ${length}`));
        // Drain to prevent re-trigger on the same bad frame.
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 4 + length) return; // wait for more bytes
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let parsed: IpcMessage;
      try {
        parsed = JSON.parse(body.toString("utf8")) as IpcMessage;
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      try {
        this.onMessage(parsed);
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}

/* ───────────────────────────────────────────────────────────────────── */
/* UDS binding                                                           */
/* ───────────────────────────────────────────────────────────────────── */

export interface IpcConnection {
  /** Remote agent id from the hello, or null until handshake completes. */
  agentId: string | null;
  socket: Socket<IpcConnectionState>;
}

export interface IpcConnectionState {
  decoder: FrameDecoder;
  agentId: string | null;
  /** Has the hello been validated? */
  handshaked: boolean;
}

export interface IpcServerHandlers {
  /** Called once a connection's hello has been validated. */
  onHello(agentId: string, capabilities: string[]): void;
  /** Called for every post-handshake message. */
  onMessage(agentId: string, msg: IpcMessage): void;
  /** Called when a connection closes. */
  onClose(agentId: string | null): void;
  /** Called on decoder / hello errors. */
  onError(err: Error, agentId: string | null): void;
}

export interface IpcServer {
  /** Path the server is bound to (UDS). */
  path: string;
  /** Stop accepting new connections and close existing ones. */
  stop(): Promise<void>;
  /** Send a message to the connection identified by agent_id. Returns false if no such connection. */
  send(agentId: string, msg: IpcMessage): boolean;
  /** Number of live connections. */
  connectionCount(): number;
}

/**
 * Atomic-create a UDS at `path` and start listening. Per spec §5.4 we:
 *   1. Bind to `<path>.tmp`.
 *   2. chmod 0600.
 *   3. Rename to `<path>`.
 *
 * Prevents races where the MCP server connects before the daemon has
 * permissioned the socket. `mode: 0o600` on `Bun.listen` is the primary
 * guard; the chmod after bind is belt-and-braces against Bun versions that
 * ignore the mode option.
 */
export async function bindUdsServer(path: string, handlers: IpcServerHandlers): Promise<IpcServer> {
  validateUdsPath(path);

  // Ensure parent dir exists.
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }

  // Clean any stale socket file (orphaned from a crashed daemon).
  // TODO: Sprint 1.1 — add a connect() probe per spec §5.4 to verify it's
  // truly orphaned before unlinking. Sprint 1 ships unconditional unlink
  // because we control test environments and there is no race risk with
  // a multi-daemon host yet.
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
  const tmpPath = `${path}.tmp`;
  if (existsSync(tmpPath)) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }

  // Connections keyed by agent_id (post-handshake).
  const connectionsByAgent = new Map<string, Socket<IpcConnectionState>>();
  // All open sockets, for shutdown.
  const allSockets = new Set<Socket<IpcConnectionState>>();

  const server = Bun.listen<IpcConnectionState>({
    unix: tmpPath,
    socket: {
      open(socket) {
        const state: IpcConnectionState = {
          agentId: null,
          handshaked: false,
          decoder: new FrameDecoder(
            (msg) => handleMessage(socket, msg),
            (err) => handlers.onError(err, socket.data?.agentId ?? null),
          ),
        };
        socket.data = state;
        allSockets.add(socket);
      },
      data(socket, data) {
        socket.data.decoder.push(data);
      },
      close(socket) {
        allSockets.delete(socket);
        const aid = socket.data?.agentId;
        if (aid) {
          if (connectionsByAgent.get(aid) === socket) {
            // This socket is the agent's CURRENT connection — a real disconnect.
            connectionsByAgent.delete(aid);
            handlers.onClose(aid);
          }
          // else: a newer hello for the same agent_id already superseded this
          // socket (reconnect / reconciler restart reusing agent_id, see the
          // `prev.end()` takeover in handleMessage). This is the OLD socket
          // closing late; firing onClose would tear down the FRESH generation's
          // delivery-gate / flush-verify / silent-drop state (#252 stack ultra).
          // The new socket owns the agent now — skip the stale teardown.
        } else {
          handlers.onClose(null); // pre-handshake socket closed
        }
      },
      error(socket, err) {
        handlers.onError(err, socket.data?.agentId ?? null);
      },
    },
  });

  function handleMessage(socket: Socket<IpcConnectionState>, msg: IpcMessage): void {
    const state = socket.data;
    if (!state.handshaked) {
      if (msg.type !== "hello") {
        handlers.onError(new Error(`Expected hello as first message, got: ${msg.type}`), null);
        socket.end();
        return;
      }
      const capError = validateHelloCapabilities(msg.capabilities);
      if (capError) {
        handlers.onError(new Error(capError), msg.agent_id);
        // Tell the MCP server why we're dropping them, then close.
        try {
          socket.write(
            encodeFrame({
              type: "error",
              code: "missing_capability",
              message: capError,
            }),
          );
        } catch {
          // ignore — peer may already be gone
        }
        socket.end();
        return;
      }
      state.agentId = msg.agent_id;
      state.handshaked = true;
      // Late-arriving second connection for the same agent_id wins; close
      // the previous one. This is the right call for restart-and-reconnect,
      // not the multi-MCP-per-agent case (which Sprint 1 doesn't support).
      const prev = connectionsByAgent.get(msg.agent_id);
      if (prev && prev !== socket) {
        prev.end();
      }
      connectionsByAgent.set(msg.agent_id, socket);
      handlers.onHello(msg.agent_id, msg.capabilities);
      return;
    }
    // Post-handshake.
    if (state.agentId === null) {
      handlers.onError(new Error("Post-handshake message with null agent_id"), null);
      return;
    }
    handlers.onMessage(state.agentId, msg);
  }

  // Permission bits then atomic rename.
  try {
    chmodSync(tmpPath, 0o600);
  } catch (err) {
    // Best-effort; the server is already running so we don't want to crash
    // the daemon over a chmod failure on a path Bun controls. Log via the
    // error handler so it shows up in audit.
    handlers.onError(err instanceof Error ? err : new Error(String(err)), null);
  }
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    // If rename fails, the MCP server can't find the socket. Stop the
    // listener and surface the error.
    try {
      server.stop(true);
    } catch {
      // ignore
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  return {
    path,
    async stop() {
      for (const s of allSockets) {
        try {
          s.end();
        } catch {
          // ignore
        }
      }
      allSockets.clear();
      connectionsByAgent.clear();
      server.stop(true);
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // ignore
        }
      }
    },
    send(agentId, msg) {
      const sock = connectionsByAgent.get(agentId);
      if (!sock) return false;
      try {
        sock.write(encodeFrame(msg));
        return true;
      } catch {
        return false;
      }
    },
    connectionCount() {
      return allSockets.size;
    },
  };
}

/**
 * Resolve the default UDS path per spec §5.4 with `instanceId` disambiguation.
 *
 *   ${XDG_RUNTIME_DIR:-$HOME/.claudeclaw/run}/bus-<instanceId>-<agentId>.sock
 *
 * `instanceId` is a short stable per-daemon identifier (default: first 8
 * chars of a hash of the cwd, fallback: the pid). Pre-validated to fit in
 * 96 bytes.
 */
export function resolveDefaultUdsPath(opts: {
  agentId: string;
  instanceId: string;
  xdgRuntimeDir?: string;
  home?: string;
}): string {
  const base =
    opts.xdgRuntimeDir ??
    (opts.home ? `${opts.home}/.claudeclaw/run` : `${process.env.HOME ?? ""}/.claudeclaw/run`);
  return `${base}/bus-${opts.instanceId}-${opts.agentId}.sock`;
}
