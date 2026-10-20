/**
 * Test-only seams for `pty-process.ts`. Kept out of `PtyProcessOptions` so nothing a
 * caller can construct (settings, a one-shot request, the supervisor's spawn builder)
 * can reach them. Read when a PTY process is constructed; reset in `afterEach`.
 */
import type { preparePtyPromptForWrite } from "./pty-prompt-sanitizer.js";

let promptPrepare: typeof preparePtyPromptForWrite | undefined;
let fileMentionNeutralizing = true;

/**
 * Replace the sanitize + leading-command guard, to isolate a CLI flag from the input
 * guard. The untrusted `@` replacement still applies on top. `null` restores the default.
 */
export function setPromptPrepareForTests(fn: typeof preparePtyPromptForWrite | null): void {
  promptPrepare = fn ?? undefined;
}

/** Turn the untrusted `@` replacement off (a control-removed twin), or back on. */
export function setUntrustedFileMentionNeutralizingForTests(enabled: boolean): void {
  fileMentionNeutralizing = enabled;
}

export const promptPrepareOverride = (): typeof preparePtyPromptForWrite | undefined =>
  promptPrepare;
export const untrustedFileMentionNeutralizing = (): boolean => fileMentionNeutralizing;
