import { z } from "zod";

/**
 * JSON-schema judge: passes if actual output is valid JSON matching a zod schema
 * derived from the expected_output object definition.
 *
 * For scaffold purposes, validates that output is parseable JSON and that
 * required keys from expected are present. Full JSON Schema validation can
 * be added via ajv or similar in a follow-up.
 */
export function judgeJsonSchema(
  actual: string,
  expected: string | Record<string, unknown>,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(actual);
  } catch {
    return false;
  }

  if (typeof expected === "string") {
    try {
      expected = JSON.parse(expected) as Record<string, unknown>;
    } catch {
      return parsed != null;
    }
  }

  if (typeof parsed !== "object" || parsed === null) return false;

  // Check that all top-level keys from expected exist in actual
  const actualObj = parsed as Record<string, unknown>;
  for (const key of Object.keys(expected)) {
    if (!(key in actualObj)) return false;
  }

  return true;
}
