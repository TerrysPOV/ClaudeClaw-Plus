/**
 * Real Discord REST API implementation for the Bus runtime.
 *
 * Implements `DiscordRestApiLike` so it can drop into `DiscordAdapter` in
 * place of the test `FakeDiscordRestApi`. Mirrors the subset of HTTP
 * calls in `src/commands/discord.ts` the Bus adapter actually uses:
 *   - POST `/channels/{id}/messages` (auto-chunked at 2000 chars)
 *   - POST `/interactions/{id}/{token}/callback` (CHANNEL_MESSAGE_WITH_SOURCE)
 *
 * Sprint 4 will replace this with a shared `src/discord/api.ts` used by
 * both runtimes — see TODO at the bottom of `src/adapters/discord/index.ts`.
 */
import type { DiscordRestApiLike } from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_MAX_MESSAGE_LEN = 2000;

/** #323: deny ALL mention parsing on outbound (model-generated) content — a
 *  single source every content-bearing send references, so the guarantee is
 *  greppable/one-place-to-change instead of a literal copy-pasted per site. */
const DENY_ALL_MENTIONS = { parse: [] as string[] } as const;

export interface DiscordRestApiOptions {
  token: string;
  logger?: Pick<Console, "warn" | "info" | "error">;
  /** Test seam for `fetch`. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

export class DiscordRestApi implements DiscordRestApiLike {
  private readonly token: string;
  private readonly logger: Pick<Console, "warn" | "info" | "error">;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DiscordRestApiOptions) {
    if (!opts.token) throw new Error("DiscordRestApi: `token` is required");
    this.token = opts.token;
    this.logger = opts.logger ?? console;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendMessage(channelId: string, text: string, components?: unknown[]): Promise<void> {
    const chunks = chunkContent(text);
    if (chunks.length === 0) return;
    for (let i = 0; i < chunks.length; i++) {
      // #323: deny all mention parsing — outbound text is model-generated,
      // never operator-authored, so an @everyone/@here/role ping must not fire.
      const body: Record<string, unknown> = {
        content: chunks[i],
        allowed_mentions: DENY_ALL_MENTIONS,
      };
      if (components && i === chunks.length - 1) body.components = components;
      await this.call("POST", `/channels/${channelId}/messages`, body);
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    // Returns 204; we just need the side effect (~10s typing indicator).
    // Errors propagate via this.call so the adapter can log them.
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async respondToInteraction(
    interactionId: string,
    interactionToken: string,
    body: { content: string; flags?: number },
  ): Promise<void> {
    // Interaction callbacks are NOT bot-token authenticated — they use the
    // ephemeral interaction token in the URL.
    const res = await this.fetchImpl(
      `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: 4, data: { ...body, allowed_mentions: DENY_ALL_MENTIONS } }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Discord interaction callback failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
  }

  private async call(
    method: string,
    endpoint: string,
    body?: unknown,
    attempt = 0,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${DISCORD_API}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      if (attempt >= 3) {
        throw new Error(`Discord rate limit exceeded after 3 retries on ${method} ${endpoint}`);
      }
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const retryMs =
        typeof data.retry_after === "number" && Number.isFinite(data.retry_after)
          ? Math.ceil(data.retry_after * 1000)
          : 5_000;
      this.logger.warn(
        `[discord-rest] 429 on ${method} ${endpoint}; retrying in ${retryMs}ms (attempt ${attempt + 1}/3)`,
      );
      await sleep(retryMs);
      return this.call(method, endpoint, body, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Discord API ${method} ${endpoint}: ${res.status} ${res.statusText} ${text}`);
    }
    if (res.status === 204) return undefined;
    return res.json();
  }
}

function chunkContent(text: string): string[] {
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let i = 0; i < normalized.length; i += DISCORD_MAX_MESSAGE_LEN) {
    chunks.push(normalized.slice(i, i + DISCORD_MAX_MESSAGE_LEN));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDiscordRestApi(opts: DiscordRestApiOptions): DiscordRestApi {
  return new DiscordRestApi(opts);
}
