import { readFile, writeFile } from "fs/promises";

/**
 * The `statusLine` entry the daemon adds to the project's `.claude/settings.json`
 * on start and removes on stop.
 *
 * That file belongs to the operator (permissions, hooks, env…), so both directions
 * follow two rules:
 *  - a file that exists but does not parse as a JSON object is never written: it is
 *    left byte-identical and the step is skipped with one log line, instead of being
 *    replaced by `{ statusLine }` and losing everything else in it;
 *  - the file is only written when the entry actually has to change, so a restart
 *    with the entry already in place leaves the file (content and mtime) untouched.
 */
export const STATUSLINE_SETTING = {
  type: "command",
  command: "node .claude/statusline.cjs",
} as const;

export type StatuslineSettingResult = "written" | "unchanged" | "skipped-invalid";

type ReadResult =
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; settings: Record<string, unknown> };

async function readSettings(path: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", reason: (err as Error)?.message ?? String(err) };
  }
  // A leading BOM (some editors add one) is not an error; an empty file holds nothing to lose.
  raw = raw.replace(/^\uFEFF/, "");
  if (raw.trim() === "") return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "invalid", reason: (err as Error)?.message ?? String(err) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "top-level value is not a JSON object" };
  }
  return { kind: "ok", settings: parsed as Record<string, unknown> };
}

function serialize(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2) + "\n";
}

function logSkip(path: string, action: string, reason: string): void {
  console.warn(
    `[statusline] ${path} could not be read as JSON (${reason}); left untouched, ${action} skipped`,
  );
}

/** Add the daemon's `statusLine` entry, creating the file if it does not exist. */
export async function ensureStatuslineSetting(path: string): Promise<StatuslineSettingResult> {
  const current = await readSettings(path);
  if (current.kind === "invalid") {
    logSkip(path, "statusline setup", current.reason);
    return "skipped-invalid";
  }
  const settings = current.kind === "ok" ? current.settings : {};
  if (current.kind === "ok" && Bun.deepEquals(settings.statusLine, STATUSLINE_SETTING)) {
    return "unchanged";
  }
  settings.statusLine = { ...STATUSLINE_SETTING };
  await writeFile(path, serialize(settings));
  return "written";
}

/** Remove the `statusLine` entry. A missing file, or one without the entry, is not written. */
export async function removeStatuslineSetting(path: string): Promise<StatuslineSettingResult> {
  const current = await readSettings(path);
  if (current.kind === "missing") return "unchanged";
  if (current.kind === "invalid") {
    logSkip(path, "statusline teardown", current.reason);
    return "skipped-invalid";
  }
  if (!Object.hasOwn(current.settings, "statusLine")) return "unchanged";
  delete current.settings.statusLine;
  await writeFile(path, serialize(current.settings));
  return "written";
}
