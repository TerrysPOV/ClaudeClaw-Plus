/**
 * Type shim for openai SDK — dynamically imported at runtime.
 * Install `openai` package to use OpenAI/Groq/DeepSeek providers.
 */
declare module "openai" {
  interface ChatCompletion {
    choices: Array<{ message: { content: string | null } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }
  interface EmbeddingResponse {
    data: Array<{ embedding: number[] }>;
    usage?: { total_tokens: number };
  }
  class OpenAI {
    constructor(opts: { apiKey: string; baseURL?: string });
    chat: {
      completions: {
        create(params: { model: string; max_tokens: number; messages: Array<{ role: string; content: string }> }): Promise<ChatCompletion>;
      };
    };
    embeddings: {
      create(params: { model: string; input: string[] }): Promise<EmbeddingResponse>;
    };
  }
  export default OpenAI;
}
