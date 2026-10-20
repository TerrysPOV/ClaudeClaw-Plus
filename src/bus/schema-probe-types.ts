/**
 * Schema-probe types — extracted so `schema-probe.ts` and
 * `schema-probe-runner.ts` can share them without a circular import.
 */

export interface ProbeRunner {
  /** Write a prompt to the session (followed by Enter). */
  sendPrompt(text: string): Promise<void>;
  /** Send a slash command (no leading slash; runner adds CR). */
  sendSlash(cmd: string): Promise<void>;
  /**
   * Wait until the REPL is up and accepting prompts — boot dialogs answered,
   * idle footer rendered (#441). `false` on timeout or exit during boot.
   * Optional: a runner without a screen (test stubs) is ready immediately.
   */
  waitForReady?(timeoutMs: number): Promise<boolean>;
  /** Wait for process exit (timeout returns `false`). */
  waitForExit(timeoutMs: number): Promise<boolean>;
  /** Last lines of the rendered screen, for failure reasons. Optional. */
  screenTail?(): string;
  /** Hard kill if still alive. */
  kill(): void;
}

export interface ProbeRunnerSpawnArgs {
  cwd: string;
  sessionId: string;
  claudeBin: string;
  /** `SchemaProbeOptions.homeOverride` — the home the child must use so the
   *  predicted JSONL path is where it writes. Unset in production. */
  homeDir?: string;
}

export type ProbeRunnerFactory = (args: ProbeRunnerSpawnArgs) => Promise<ProbeRunner>;
