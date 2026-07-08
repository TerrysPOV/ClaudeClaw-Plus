/**
 * OpenAI-compatible provider calls over plain `fetch` — no `openai` SDK
 * dependency (mirrors llm-router's openrouter.ts convention: injectable
 * fetch, explicit base URLs, throw on non-2xx).
 *
 * Anthropic calls keep using @anthropic-ai/sdk (already a repo dependency);
 * everything else (openai/groq/deepseek) speaks the /chat/completions and
 * /embeddings wire formats directly.
 */

export const OPENAI_COMPAT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com",
};

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiCompatChatOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
}

export interface OpenAiCompatChatResult {
  text: string;
  prompt_tokens: number;
  completion_tokens: number;
}

export async function openAiCompatChat(
  opts: OpenAiCompatChatOpts,
): Promise<OpenAiCompatChatResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: opts.messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`provider HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    prompt_tokens: json.usage?.prompt_tokens ?? 0,
    completion_tokens: json.usage?.completion_tokens ?? 0,
  };
}

export interface OpenAiEmbeddingsOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  input: string[];
  fetchImpl?: typeof fetch;
}

export interface OpenAiEmbeddingsResult {
  embeddings: number[][];
  total_tokens: number;
}

export async function openAiEmbeddings(
  opts: OpenAiEmbeddingsOpts,
): Promise<OpenAiEmbeddingsResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${opts.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ model: opts.model, input: opts.input }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { total_tokens?: number };
  };
  return {
    embeddings: (json.data ?? []).map((d) => d.embedding ?? []),
    total_tokens: json.usage?.total_tokens ?? 0,
  };
}
