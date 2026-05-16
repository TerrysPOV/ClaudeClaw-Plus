/**
 * Regex judge: passes if actual output matches the expected regex pattern.
 */
export function judgeRegex(actual: string, expected: string | string[]): boolean {
  const patterns = Array.isArray(expected) ? expected : [expected];
  return patterns.some((pattern) => {
    const re = new RegExp(pattern, "s");
    return re.test(actual);
  });
}
