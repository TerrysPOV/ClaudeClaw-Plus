import { engines } from "./registry.js";

/**
 * The claude CLI the interactive isolation rows were measured on (spike doc 0.7). A
 * flag's meaning in the interactive REPL can change between releases, so a build the
 * rows were not run against does not get the untrusted routes by default.
 */
export const MIN_PTY_ISOLATION_CLAUDE_VERSION = "2.1.304";

/** `major.minor.patch` numeric compare; anything unparseable is not at least `min`. */
export function claudeVersionAtLeast(version: string | null | undefined, min: string): boolean {
  const parse = (value: string): number[] | undefined => {
    const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const have = version ? parse(version) : undefined;
  const need = parse(min);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}

/**
 * Advertise PTY isolation only on a claude at or above the measured version. Below it, or
 * when the version could not be read, the untrusted routes resolve to print (an explicit
 * `oneShot.routes` entry naming pty is rejected at the call). One warning, at startup.
 * Returns whether PTY isolation is advertised.
 *
 * Never on win32: the native env isolation (`withProcessEnvPolicy`) throws there, so an operator
 * who turned the runner PTY on would get a classifier that fails on every call (#570 r15, A5).
 */
export function applyPtyIsolationVersionGate(
  version: string | null | undefined,
  warn: (message: string) => void = console.warn,
  platform: string = process.platform,
): boolean {
  const supported = platform !== "win32";
  const ok = supported && claudeVersionAtLeast(version, MIN_PTY_ISOLATION_CLAUDE_VERSION);
  const pty = engines.get("pty");
  if (pty) pty.caps.isolation = ok;
  if (!supported) {
    warn("[oneshot] PTY isolation is not available on win32: untrusted one-shot routes use print");
  } else if (!ok) {
    warn(
      `[oneshot] claude ${version ?? "(version unreadable)"} is below ${MIN_PTY_ISOLATION_CLAUDE_VERSION}, the build the interactive isolation was measured on: untrusted one-shot routes use print`,
    );
  }
  return ok;
}
