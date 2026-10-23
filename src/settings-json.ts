/**
 * Read settings.json for a rewrite without losing integers past 2^53.
 *
 * The dashboard save handlers and the tuner's model switch parse the whole file, patch one section and write it all
 * back. A plain `JSON.parse` rounds a bare integer such as a Discord snowflake
 * (`123456789012345678901` → `123456789012345680000`), and the loader then
 * reads the rounded text as an exact id (#496). Here every integer literal
 * that does not survive the parse is kept as `JSON.rawJSON(<source>)`, which
 * `JSON.stringify` writes back verbatim. Every other value parses as before.
 */

import { chmod, rename, rm, stat, writeFile } from "node:fs/promises";

type RawJsonFn = (text: string) => unknown;

const INTEGER_LITERAL = /^-?\d+$/;

export function parseSettingsForRewrite(text: string): Record<string, unknown> {
  const rawJSON = (JSON as unknown as { rawJSON?: RawJsonFn }).rawJSON;
  return JSON.parse(
    text,
    function keepLargeIntegers(
      _key: string,
      value: unknown,
      context?: { source?: string },
    ): unknown {
      if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
      const source = context?.source;
      if (typeof source !== "string" || !INTEGER_LITERAL.test(source)) return value;
      if (typeof rawJSON !== "function") {
        throw new Error(
          "settings.json holds an integer past 2^53 that this runtime cannot write back exactly; write it as a quoted string",
        );
      }
      return rawJSON(source);
    },
  ) as Record<string, unknown>;
}

/**
 * Write settings.json whole or not at all: a temp file next to it, then a
 * rename over it, so a crash or a full disk never leaves half a file for the
 * loader. The temp file takes the old file's mode (it may hold tokens).
 */
export async function writeSettingsAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    const mode = await stat(path).then(
      (s) => s.mode & 0o777,
      () => 0o600,
    );
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
