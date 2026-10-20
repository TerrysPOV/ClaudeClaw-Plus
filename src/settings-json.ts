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
