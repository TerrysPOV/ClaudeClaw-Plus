/**
 * Exact-set judge: passes if actual output matches one of the expected values exactly.
 */
export function judgeExactSet(actual: string, expected: string | string[]): boolean {
  const candidates = Array.isArray(expected) ? expected : [expected];
  return candidates.some((e) => e.trim() === actual.trim());
}
