/**
 * Static assets the dashboard loads from the daemon itself rather than from
 * a CDN: the three web fonts. A fixed map, not a directory listing — a path
 * that is not a key here is a 404, so nothing else under `page/fonts/` (the
 * licence files included) is reachable over HTTP.
 */
const FONT_FILES = new Set([
  "fraunces-latin.woff2",
  "space-grotesk-latin.woff2",
  "jetbrains-mono-latin.woff2",
]);

export const FONT_ROUTE_PREFIX = "/assets/fonts/";

const fontCache = new Map<string, ArrayBuffer>();

async function readFont(name: string): Promise<ArrayBuffer> {
  const cached = fontCache.get(name);
  if (cached) return cached;
  const bytes = await Bun.file(new URL(`./page/fonts/${name}`, import.meta.url)).arrayBuffer();
  fontCache.set(name, bytes);
  return bytes;
}

/** Response for a `/assets/fonts/…` path, or null when it is not one of ours. */
export async function serveFont(pathname: string): Promise<Response | null> {
  const name = pathname.slice(FONT_ROUTE_PREFIX.length);
  if (!FONT_FILES.has(name)) return null;
  return new Response(await readFont(name), {
    headers: {
      "Content-Type": "font/woff2",
      // The files change only with a release; a day keeps a reload cheap
      // without pinning a stale font across an upgrade for long.
      "Cache-Control": "public, max-age=86400",
    },
  });
}
