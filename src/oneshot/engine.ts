export interface OneShotRequest {
  route: string;
  prompt: string;
  system?: string;
  model?: string;
  isolation: "untrusted" | "trusted-session";
  resumeSessionId?: string;
  allowedTools?: string[];
  maxTokens?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OneShotResult {
  text: string;
  engine: string;
  model: string;
  exitCode: number;
  sessionId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface OneShotEngine {
  id: string;
  caps: { resume: boolean; tools: boolean; isolation: boolean };
  run(req: OneShotRequest): Promise<OneShotResult>;
}

export async function runOneShot(_req: OneShotRequest): Promise<OneShotResult> {
  throw new Error("not implemented");
}
