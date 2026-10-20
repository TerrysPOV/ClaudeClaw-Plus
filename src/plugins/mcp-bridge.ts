import { z } from "zod";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { recordToolCall, recordToolCallIntent } from "../observability/tool-call-sink.js";
import type { ToolCallStatus } from "../observability/tool-call.js";
import type { McpBridgeConfig } from "../config.js";

/** Cap on a handler error recorded in the audit log — same bound as the
 *  `mcp.tool_call` chain's error field. */
const MAX_AUDIT_ERROR_LEN = 2_000;

/** `agent_id` of the bridge's `mcp.tool_call` events. The bridge has no PTY
 *  identity (its callers are in-process, the stdio server and the plugin HTTP
 *  gateway); this tells its events apart from the multiplexer's on the chain. */
export const BRIDGE_AGENT_ID = "plugin-bridge";

// ── Types ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PluginTool<T extends z.ZodType = z.ZodType<any, any>> {
  name: string;
  description: string;
  schema: T;
  handler: (args: z.infer<T>) => Promise<unknown> | unknown;
  /** Set when the tool proxies another MCP server's tool (mcp-proxy, the
   *  multiplexer): its `mcp.tool_call` events then name that server and tool,
   *  the keys the multiplexer's own HTTP path records, instead of the wrapper
   *  plugin and the namespaced name. */
  upstream?: { server: string; tool: string };
}

export interface PluginToolContext {
  pluginId: string;
  callerToken?: string;
  signature: string;
  ts: number;
}

export interface RegisteredTool {
  plugin: string;
  tool: PluginTool;
}

export interface ListedTool {
  fqn: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── PluginMcpBridge ───────────────────────────────────────────────────────────

export class PluginMcpBridge {
  private tools = new Map<string, RegisteredTool>();
  private secrets = new Map<string, Buffer>();
  private auditPath: string;
  private toolPolicy: McpBridgeConfig = { plugins: {} };

  constructor(auditPath?: string) {
    // #304: `PLUS_PLUGIN_AUDIT_PATH` overrides the default journal location
    // — an operator who keeps state elsewhere, and the test preload, which
    // points every default bridge of a `bun test` run at a temp file so the
    // suites stop appending to the operator's live journal.
    this.auditPath = auditPath
      ? resolve(auditPath)
      : process.env.PLUS_PLUGIN_AUDIT_PATH
        ? resolve(process.env.PLUS_PLUGIN_AUDIT_PATH)
        : resolve(homedir(), ".config", "plus", "plugin-audit.jsonl");

    // Ensure audit directory exists
    const auditDir = this.auditPath.substring(0, this.auditPath.lastIndexOf("/"));
    mkdirSync(auditDir, { recursive: true });
  }

  // ── Tool registration ──────────────────────────────────────────────────

  // Path-traversal guard: pluginId must be a safe identifier.
  // Allowed: lowercase letters, digits, dashes; must start with a letter; 1-64 chars.
  // Rejects any string containing path separators, dots, or other special chars.
  private _validatePluginId(pluginId: string): void {
    if (typeof pluginId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(pluginId)) {
      throw new Error(
        `invalid pluginId: ${JSON.stringify(pluginId)} (must match /^[a-z][a-z0-9-]{0,63}$/)`,
      );
    }
  }

  registerPluginTool(pluginId: string, tool: PluginTool): void {
    this._validatePluginId(pluginId);
    const fqn = `${pluginId}__${tool.name}`;

    if (this.tools.has(fqn)) {
      throw new Error(`Duplicate tool registration: "${fqn}" is already registered`);
    }

    this.tools.set(fqn, { plugin: pluginId, tool });
    this.audit("register", { fqn, pluginId, toolName: tool.name, description: tool.description });
  }

  unregisterPlugin(pluginId: string): void {
    this._validatePluginId(pluginId);
    for (const [fqn, entry] of this.tools) {
      if (entry.plugin === pluginId) this.tools.delete(fqn);
    }
    this.audit("unregister", { pluginId });
  }

  // ── Secret management ──────────────────────────────────────────────────

  loadOrCreateSecret(pluginId: string): Buffer {
    this._validatePluginId(pluginId);
    const cached = this.secrets.get(pluginId);
    if (cached) return cached;

    const secretDir = resolve(homedir(), ".config", "plus", "plugins", pluginId);
    const secretPath = join(secretDir, ".secret");

    mkdirSync(secretDir, { recursive: true });

    let secret: Buffer;
    if (existsSync(secretPath)) {
      const raw = readFileSync(secretPath);
      // hex-encoded 32 bytes = 64 chars
      secret = Buffer.from(raw.toString().trim(), "hex");
    } else {
      secret = randomBytes(32);
      writeFileSync(secretPath, secret.toString("hex"), { encoding: "utf8" });
      chmodSync(secretPath, 0o600);
    }

    this.secrets.set(pluginId, secret);
    return secret;
  }

  // ── HMAC signing ──────────────────────────────────────────────────────

  signCall(pluginId: string, body: unknown, ts: number): string {
    const secret = this.loadOrCreateSecret(pluginId);
    const canonical = JSON.stringify({ body, ts });
    return createHmac("sha256", secret).update(canonical).digest("hex");
  }

  verifyCall(pluginId: string, body: unknown, ts: number, signature: string): boolean {
    const expected = this.signCall(pluginId, body, ts);
    try {
      const expectedBuf = Buffer.from(expected, "hex");
      const signatureBuf = Buffer.from(signature, "hex");
      if (expectedBuf.length !== signatureBuf.length) return false;
      return timingSafeEqual(expectedBuf, signatureBuf);
    } catch {
      return false;
    }
  }

  // ── Tool policy (#230) ────────────────────────────────────────────────

  /** Replace the per-plugin policy (`settings.mcp.bridge`). Called at daemon
   *  start and on every settings hot-reload; absent → no restriction. */
  setToolPolicy(policy: McpBridgeConfig | undefined): void {
    const next = policy ?? { plugins: {} };
    const wasDefaultDeny = this.toolPolicy.defaultDeny === true;
    const isDefaultDeny = next.defaultDeny === true;
    this.toolPolicy = next;
    // The posture switch is the one an auditor looks for: say it when it flips.
    if (wasDefaultDeny !== isDefaultDeny) {
      const entries = Object.keys(next.plugins).length;
      this.audit("policy_default_deny", { enabled: isDefaultDeny, entries });
      console.log(
        `[mcp] bridge deny-by-default ${isDefaultDeny ? `ON (${entries} entries)` : "OFF"}`,
      );
    }
  }

  /** Why the policy refuses this tool, or null when it is callable. The
   *  entry under the plugin id and, for a proxied tool, the one under the
   *  upstream server are both consulted; either can refuse. Under
   *  `defaultDeny`, a tool with no entry under either key is refused. */
  private policyDenial(pluginId: string, tool: PluginTool): string | null {
    const keys: Array<[string, string]> = [[pluginId, tool.name]];
    if (tool.upstream) keys.push([tool.upstream.server, tool.upstream.tool]);
    const { plugins } = this.toolPolicy;
    let listed = false;
    for (const [key, name] of keys) {
      if (!Object.prototype.hasOwnProperty.call(plugins, key)) continue;
      listed = true;
      const entry = plugins[key];
      if (entry.enabled === false) return "plugin_disabled";
      if (entry.deniedTools?.includes(name)) return "tool_denied";
      if (entry.allowedTools && !entry.allowedTools.includes(name)) return "not_in_allowed_set";
    }
    // `defaultDeny`: no entry under any of its keys → not callable.
    if (!listed && this.toolPolicy.defaultDeny === true) return "default_deny";
    return null;
  }

  // ── Tool invocation ───────────────────────────────────────────────────

  async invokeTool(fqn: string, args: unknown): Promise<unknown> {
    // One `mcp.tool_call` per call, whatever the outcome, timed from here —
    // the same chain the multiplexer writes (#230/#232). `recordToolCall` only
    // buffers in memory: never awaited, never throws. Args are never recorded.
    const ts = new Date().toISOString();
    const t0 = performance.now();
    // Not registered → not a plugin: the fqn is caller-supplied, so it is kept
    // as the tool name (the sink bounds it), never as a subject.
    let subject = "unknown";
    let toolName = typeof fqn === "string" ? fqn : "<non-string>";
    let status: ToolCallStatus = "error";
    // Recorded instead of the thrown message on the paths where that message
    // is caller-shaped (the fqn, or a validation message quoting arg values).
    let reason: string | undefined = "unknown_tool";
    let error: string | undefined;

    try {
      const registered = this.tools.get(fqn);
      if (!registered) {
        throw new Error(`Unknown tool: "${fqn}"`);
      }

      const { plugin: pluginId, tool } = registered;
      subject = tool.upstream?.server ?? pluginId;
      toolName = tool.upstream?.tool ?? tool.name;

      const denial = this.policyDenial(pluginId, tool);
      if (denial) {
        reason = denial;
        this.audit("policy_denied", {
          fqn,
          pluginId,
          toolName: tool.name,
          ...(tool.upstream ? { upstream: tool.upstream } : {}),
          reason: denial,
        });
        throw new Error(`Tool "${fqn}" is refused by settings.mcp.bridge (${denial})`);
      }

      // Validate args via Zod schema. Set before the parse: a refine or
      // transform that throws its own error is recorded under it too, since
      // that message can quote the args as well.
      reason = "invalid_args";
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        const err = new Error(`Invalid args for "${fqn}": ${parsed.error.message}`);
        this.audit("error", { fqn, pluginId, error: parsed.error.message, phase: "validation" });
        throw err;
      }
      reason = undefined;

      // Sign the call
      const signedAt = Date.now();
      const signature = this.signCall(pluginId, parsed.data, signedAt);

      // `settings.mcp.audit: "enforce"`: the intent is appended synchronously
      // before the handler runs and a failed append refuses the call — no
      // log, no action. A no-op under best-effort.
      try {
        recordToolCallIntent({ ts, plugin: subject, tool: toolName, agent_id: BRIDGE_AGENT_ID });
      } catch (err) {
        reason = "audit_unavailable";
        const message = err instanceof Error ? err.message : String(err);
        this.audit("audit_enforced_reject", {
          fqn,
          pluginId,
          error: message.slice(0, MAX_AUDIT_ERROR_LEN),
        });
        throw new Error(
          `Tool "${fqn}" refused: the audit log is unavailable and settings.mcp.audit is "enforce"`,
        );
      }

      try {
        const result = await tool.handler(parsed.data);
        this.audit("invoke", { fqn, pluginId, ts: signedAt, signature, success: true });
        status = "ok";
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The message can carry a tool's own error text, of any size (an MCP
        // child's `isError` result is thrown with it). The caller gets it whole;
        // the audit line keeps a bounded copy.
        const error =
          message.length > MAX_AUDIT_ERROR_LEN
            ? `${message.slice(0, MAX_AUDIT_ERROR_LEN)}…[truncated ${message.length - MAX_AUDIT_ERROR_LEN} chars]`
            : message;
        this.audit("error", { fqn, pluginId, ts: signedAt, signature, error, phase: "handler" });
        throw err;
      }
    } catch (err) {
      error = reason ?? (err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      recordToolCall({
        ts,
        plugin: subject,
        tool: toolName,
        agent_id: BRIDGE_AGENT_ID,
        status,
        duration_ms: performance.now() - t0,
        ...(status === "error" ? { error: error ?? "unknown" } : {}),
      });
    }
  }

  // ── Tool listing ──────────────────────────────────────────────────────

  listTools(): ListedTool[] {
    // A tool the policy refuses is not advertised either.
    return Array.from(this.tools.entries())
      .filter(([, { plugin, tool }]) => this.policyDenial(plugin, tool) === null)
      .map(([fqn, { tool }]) => ({
        fqn,
        description: tool.description,
        inputSchema: this.zodToJson(tool.schema),
      }));
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private zodToJson(schema: z.ZodType): Record<string, unknown> {
    // MVP minimal converter — returns a basic JSON Schema object
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape as Record<string, z.ZodType>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, field] of Object.entries(shape)) {
        properties[key] = this.zodFieldToJson(field as z.ZodType);
        // If not optional, mark as required
        if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault)) {
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    }

    // Fallback for non-object schemas
    return { type: "object", additionalProperties: true };
  }

  private zodFieldToJson(field: z.ZodType): Record<string, unknown> {
    if (field instanceof z.ZodOptional) {
      return this.zodFieldToJson(field.unwrap() as z.ZodType);
    }
    if (field instanceof z.ZodDefault) {
      return this.zodFieldToJson(field._def.innerType as z.ZodType);
    }
    if (field instanceof z.ZodString) return { type: "string" };
    if (field instanceof z.ZodNumber) return { type: "number" };
    if (field instanceof z.ZodBoolean) return { type: "boolean" };
    if (field instanceof z.ZodArray)
      return { type: "array", items: this.zodFieldToJson(field.element as z.ZodType) };
    if (field instanceof z.ZodEnum) return { type: "string", enum: field.options as string[] };
    return { type: "object", additionalProperties: true };
  }

  /**
   * Append an audit event to the JSONL log.
   *
   * **Contract (#72 item 13): this method MUST NOT throw.** Every
   * failure mode — JSON-serialisation of a payload that contains
   * circular refs, FS write errors on a full / read-only disk,
   * permission errors, etc. — is swallowed by the inner try/catch.
   * Callers are explicitly relieved of the burden of wrapping
   * `getMcpBridge().audit(...)` in their own try/catch; doing so is
   * dead code that exists in production paths only because callers
   * were defensive before this contract was nailed down. As of #72
   * item 13 all 20 caller-side wrappers were removed.
   */
  audit(event: string, payload: Record<string, unknown>): void {
    try {
      const entry = JSON.stringify({ event, ts: new Date().toISOString(), ...payload }) + "\n";
      appendFileSync(this.auditPath, entry, { encoding: "utf8" });
    } catch {
      // Audit failures must not break the bridge — see contract above.
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _bridge: PluginMcpBridge | null = null;

export function getMcpBridge(): PluginMcpBridge {
  if (!_bridge) {
    _bridge = new PluginMcpBridge();
  }
  return _bridge;
}

/** Reset singleton — only for testing */
export function _resetMcpBridge(): void {
  _bridge = null;
}

/** Set bridge singleton — only for testing */
export function _setMcpBridge(b: PluginMcpBridge | null): void {
  _bridge = b;
}
