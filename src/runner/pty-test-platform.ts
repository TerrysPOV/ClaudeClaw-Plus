/** Test seam: run `fn` as if `process.platform` were `platform`, then put the real one back. */
export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (real) Object.defineProperty(process, "platform", real);
  }
}

/** As `withPlatform`, for a body that awaits (the platform stays overridden until it settles). */
export async function withPlatformAsync<T>(
  platform: NodeJS.Platform,
  fn: () => Promise<T>,
): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    if (real) Object.defineProperty(process, "platform", real);
  }
}
