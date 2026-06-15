import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  allowedTools?: string[];
}

export interface ServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ServerStatus = "starting" | "up" | "crashed" | "restarting" | "failed" | "stopped";

const BACKOFF_MS = [1_000, 5_000, 30_000, 60_000];
const CRASH_WINDOW_MS = 5 * 60 * 1_000;
const MAX_CRASHES_IN_WINDOW = 5;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class McpServerProcess {
  readonly name: string;
  private config: McpServerConfig;

  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  status: ServerStatus = "starting";
  tools: ServerTool[] = [];
  startedAt: Date | null = null;
  lastInvocationAt: Date | null = null;

  private crashTimestamps: number[] = [];
  private crashCount = 0;
  private restartHook?: (name: string, reason: string) => void;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires after the server has been stably "up" for CRASH_WINDOW_MS, resetting
   *  the crash counters so the restart backoff reflects the CURRENT crash burst
   *  rather than the process lifetime. Cancelled by the next crash, so a tight
   *  crash-loop never resets and its backoff still escalates. */
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  // Generation counter: stale onclose/onerror handlers from old transports are discarded
  private generation = 0;
  /**
   * Defense-in-depth allowlist used by `call()` to gate tool dispatch
   * (#72 item 3). The multiplexer layer already enforces this against
   * the per-server `allowedTools` config, but `proc.call(...)` is
   * exported and could be reached by future in-process callers that
   * skip the multiplexer-level gate. The proxy must be hermetic without
   * trusting upstream behaviour OR upstream callers.
   *
   * Populated at the end of `start()` from `this.tools` (which itself
   * is already filtered against `config.allowedTools`). When
   * `config.allowedTools` is undefined the set contains every tool the
   * upstream advertised — `call()` still rejects bare typos and unknown
   * names but doesn't restrict beyond what the operator allowed at
   * startup.
   */
  private _allowedToolNames = new Set<string>();

  constructor(
    name: string,
    config: McpServerConfig,
    opts?: {
      onCrash?: (name: string, reason: string) => void;
    },
  ) {
    this.name = name;
    this.config = config;
    this.restartHook = opts?.onCrash;
  }

  async start(): Promise<void> {
    this.status = "starting";
    const gen = ++this.generation;
    const logDir = join(homedir(), ".cache", "claudeclaw", "mcp-proxy");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `${this.name}.log`);

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: this.config.env,
      stderr: "pipe",
    });

    // Pipe stderr to log file — transport.stderr is available immediately when stderr:"pipe"
    const stderrStream = this.transport.stderr;
    if (stderrStream) {
      const logStream = createWriteStream(logPath, { flags: "a" });
      logStream.on("error", (err) =>
        console.error(`[mcp-proxy] log write error for ${this.name}:`, err.message),
      );
      stderrStream.pipe(logStream);
    }

    this.client = new Client(
      { name: `mcp-proxy/${this.name}`, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    // Capture gen in closure so stale handlers from a previous transport are silently discarded.
    // Also gate with a per-generation `crashHandled` flag: when a transport fails, both
    // `onerror` and `onclose` fire for the same generation. Without this flag both
    // would call _handleCrash, scheduling two restart timers and double-spawning.
    let crashHandled = false;
    this.transport.onclose = () => {
      if (this.generation !== gen || crashHandled) return;
      crashHandled = true;
      this._handleCrash("transport closed");
    };
    this.transport.onerror = (err) => {
      if (this.generation !== gen || crashHandled) return;
      crashHandled = true;
      this._handleCrash(`transport error: ${err.message}`);
    };

    // Cleanup guarantee: if connect/listTools throws, kill the spawned subprocess
    // before propagating. Prevents zombie MCP servers across daemon restarts when
    // upstream servers are flaky at startup.
    let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
    try {
      await this.client.connect(this.transport);
      ({ tools } = await this.client.listTools());
    } catch (err) {
      this.status = "failed";
      try {
        await this.client?.close();
      } catch {}
      try {
        await this.transport?.close();
      } catch {}
      this.client = null;
      this.transport = null;
      throw err;
    }
    const allowed = this.config.allowedTools;
    this.tools = tools
      .filter((t) => !allowed || allowed.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      }));
    // #72 item 3: rebuild the per-call allowlist from the just-filtered
    // tools. Restart paths re-enter `start()` so the set always reflects
    // the upstream's CURRENT tool list intersected with the operator's
    // configured allowlist.
    this._allowedToolNames = new Set(this.tools.map((t) => t.name));

    this.status = "up";
    this.startedAt = new Date();
    // Arm the stability reset: if the server stays up for a full crash window,
    // clear the crash counters so a later isolated crash gets a SHORT backoff
    // again instead of being pinned at max by the lifetime crash count. A crash
    // before then cancels this (see _handleCrash), keeping backoff escalating
    // through a genuine crash-loop.
    if (this.stabilityTimer !== null) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      this.crashCount = 0;
      this.crashTimestamps = [];
    }, CRASH_WINDOW_MS);
    (this.stabilityTimer as { unref?: () => void }).unref?.();
  }

  async call(tool: string, args: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.client || this.status !== "up") {
      throw new Error(`Server ${this.name} is not ready (status: ${this.status})`);
    }
    // #72 item 3: defense-in-depth allowlist check. The multiplexer
    // layer already gates against `config.allowedTools` before reaching
    // here, but the proxy must be hermetic without trusting upstream
    // callers. Reject before invocation so a future caller bypassing
    // the multiplexer gate can't reach a disallowed tool — and the
    // upstream child never sees the request.
    if (!this._allowedToolNames.has(tool)) {
      throw new Error(
        `Tool '${tool}' is not in allowedTools for server '${this.name}' ` +
          `(allowlist size=${this._allowedToolNames.size})`,
      );
    }
    this.lastInvocationAt = new Date();

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timer = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Tool call ${tool} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    const call = this.client.callTool({
      name: tool,
      arguments: args as Record<string, unknown>,
    });

    let result: Awaited<typeof call>;
    try {
      result = await Promise.race([call, timer]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
    const content = (result as { content?: Array<{ text?: string }> }).content?.[0];
    const text = content?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stabilityTimer !== null) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    this.status = "stopped";
    try {
      await this.client?.close();
    } catch {}
    try {
      await this.transport?.close();
    } catch {}
    this.client = null;
    this.transport = null;
  }

  private _handleCrash(reason: string): void {
    if (this.stopping || this.status === "failed" || this.status === "stopped") return;
    // A crash cancels the pending stability reset, so crashCount keeps climbing
    // (and backoff keeps escalating) through a genuine crash-loop.
    if (this.stabilityTimer !== null) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    this.status = "crashed";
    this.crashCount++;
    const now = Date.now();
    this.crashTimestamps = [...this.crashTimestamps, now].filter((t) => now - t < CRASH_WINDOW_MS);

    if (this.crashTimestamps.length >= MAX_CRASHES_IN_WINDOW) {
      this.status = "failed";
    }

    // Fire hook AFTER status is finalized so callers see "failed" vs "crashed" correctly
    this.restartHook?.(this.name, reason);

    if (this.status === "failed") {
      return;
    }

    const backoff = BACKOFF_MS[Math.min(this.crashCount - 1, BACKOFF_MS.length - 1)] ?? 60_000;
    this.status = "restarting";
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._doRestart();
    }, backoff);
  }

  private async _doRestart(): Promise<void> {
    if (this.stopping) return; // stop() may have been called while restart timer was queued
    try {
      const oldClient = this.client;
      const oldTransport = this.transport;
      this.client = null;
      this.transport = null;
      await this.start();
      // Close old transport after new generation is live — stale handlers are discarded by gen guard
      try {
        await oldClient?.close();
      } catch {}
      try {
        await oldTransport?.close();
      } catch {}
    } catch (err) {
      this._handleCrash(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
