import { readFile, writeFile, chmod, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import { dirname, join } from "path";
import { json } from "./http";

/**
 * Resolved lazily (not at module load) so it tracks the daemon's actual
 * working directory and so tests can `chdir` into a temp dir.
 */
function tokenFilePath(): string {
  return join(process.cwd(), ".claude", "claudeclaw", "web.token");
}

/**
 * Read the persisted 256-bit web token, or mint + persist one on first
 * start (issue #164, ported from upstream #185). Stored at
 * `.claude/claudeclaw/web.token` mode 0600 so a daemon that the operator
 * never gave an explicit `settings.apiToken` still has a strong token to
 * enforce with. PR A (this change) generates + persists it; enforcement
 * on `/api/*` lands in PR B alongside the dashboard auto-token UX.
 */
export async function getOrCreateWebToken(): Promise<string> {
  const tokenFile = tokenFilePath();
  if (existsSync(tokenFile)) {
    return (await readFile(tokenFile, "utf-8")).trim();
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  // Belt-and-suspenders: some systems ignore the mode arg to writeFile
  // when the file is created, so re-assert 0600 explicitly.
  await chmod(tokenFile, 0o600);
  return token;
}

/**
 * Byte-length-safe constant-time token comparison. Compares `Buffer`
 * byte lengths (not JS string character lengths) so a non-ASCII
 * `provided` value can never make `timingSafeEqual` throw `RangeError`.
 * Accepts the token via `Authorization: Bearer <t>` or `?token=<t>`
 * (the query-param path is what the dashboard auto-token UX in PR B
 * will use on first load).
 */
export function checkToken(req: Request, expected: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const provided = m?.[1] ?? new URL(req.url).searchParams.get("token") ?? "";
  if (!provided) return false;
  return safeEqual(provided, expected);
}

/**
 * Bearer-header auth guard for the legacy `/api/inject` route. Hardened
 * for issue #164 item 4: the previous implementation used a plain `!==`
 * string compare which is neither constant-time nor byte-length safe.
 * Now routes through `safeEqual`.
 */
export function checkBearer(req: Request, token: string | undefined): Response | null {
  if (!token) return json({ ok: false, error: "API token not configured" }, 503);
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  const provided = m?.[1] ?? "";
  if (!provided || !safeEqual(provided, token)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  return null;
}

function safeEqual(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
