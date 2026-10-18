import { spawn } from "node:child_process";
import { runOneShot } from "../../oneshot/engine.js";
import { withPrintRuntime } from "../../oneshot/print.js";
import { DEFAULT_LLM_TIMEOUT_MS, type TunerConfig } from "./config.js";

export type Role = "intent_classifier" | "detector" | "proposer" | "proposer_high_stakes" | "judge";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface LLMClient {
  call(role: Role, system: string, messages: Message[], maxTokens?: number): Promise<string>;
  modelFor(role: Role): string;
}

function buildPrompt(system: string, messages: Message[]): string {
  const lines: string[] = ["[system]", system, "[/system]"];
  for (const m of messages) {
    lines.push("[" + m.role + "]", m.content, "[/" + m.role + "]");
  }
  return lines.join("\n");
}

/**
 * One-shot `claude -p` calls carry untrusted text (conversation turns, skill
 * bodies), so they run through `runOneShot` as `untrusted`: no built-in tools,
 * no MCP servers, no settings file (no hooks, no user plugins), no saved session
 * and no slash commands, with the prompt on stdin. The flags live in
 * `oneshot/isolation.ts`. With no configured model, or the env-routed "glm"
 * alias, --model is left out and the CLI's default applies (same rule as the
 * runner's spawn sites).
 */
export class ClaudeCliBackend implements LLMClient {
  private readonly models: TunerConfig["models"];
  private readonly timeoutMs: number;

  constructor(
    config: TunerConfig,
    private readonly spawnFn: typeof spawn = spawn,
  ) {
    this.models = config.models;
    // `llm` can be `{}` when a nested default is not applied, so fall back here too.
    this.timeoutMs = config.llm?.timeout_ms ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  modelFor(role: Role): string {
    const m = this.models;
    return (
      {
        intent_classifier: m.intent_classifier,
        detector: m.detector,
        proposer: m.proposer_default,
        proposer_high_stakes: m.proposer_high_stakes,
        judge: m.judge,
      } as Record<Role, string>
    )[role];
  }

  // The claude CLI has no output-length flag, so maxTokens is accepted for
  // interface compatibility but not forwarded.
  async call(role: Role, system: string, messages: Message[], maxTokens?: number): Promise<string> {
    const prompt = buildPrompt(system, messages);
    let stderr = "";
    const result = await withPrintRuntime(
      {
        spawn: this.spawnFn,
        forcePrint: this.forcePrint,
        onStderr: (excerpt) => {
          stderr = excerpt;
        },
      },
      () =>
        runOneShot({
          route: role === "judge" ? "tuner.judge" : "tuner.propose",
          prompt,
          model: this.modelFor(role),
          isolation: "untrusted",
          timeoutMs: this.timeoutMs,
          maxTokens,
        }),
    );
    if (result.exitCode !== 0)
      throw new Error(`claude CLI exited ${result.exitCode}: ${stderr}`);
    return result.text.trim();
  }

  protected get forcePrint(): boolean {
    return true;
  }
}

/** Uses the configured oneShot route; claude_cli remains a print alias. */
export class OneShotBackend extends ClaudeCliBackend {
  protected override get forcePrint(): boolean {
    return false;
  }
}

export class AnthropicApiBackend implements LLMClient {
  private readonly models: TunerConfig["models"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  private readonly apiKey: string;

  constructor(config: TunerConfig) {
    this.models = config.models;
    const apiKey = config.llm.api_key ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error(
        "anthropic_api backend requires api_key in config or ANTHROPIC_API_KEY env var",
      );
    this.apiKey = apiKey;
  }

  modelFor(role: Role): string {
    const m = this.models;
    return (
      {
        intent_classifier: m.intent_classifier,
        detector: m.detector,
        proposer: m.proposer_default,
        proposer_high_stakes: m.proposer_high_stakes,
        judge: m.judge,
      } as Record<Role, string>
    )[role];
  }

  async call(role: Role, system: string, messages: Message[], maxTokens = 4096): Promise<string> {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 4 });
    }
    const model = this.modelFor(role);
    const response = await this.client.messages.create({
      model,
      system,
      messages: messages.map((m: Message) => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
    });
    const block = response.content[0];
    return block && "text" in block ? block.text : "";
  }
}

export function makeLLMClient(config: TunerConfig): LLMClient {
  if (config.llm.backend === "anthropic_api") return new AnthropicApiBackend(config);
  if (config.llm.backend === "oneshot") return new OneShotBackend(config);
  return new ClaudeCliBackend(config);
}
