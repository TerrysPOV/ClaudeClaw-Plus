<<<<<<< HEAD
import { readFile, writeFile, chmod, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import { dirname, join } from "path";

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
 * enforce with. Enforced on every `/api/*` route by `server.ts`; the
 * dashboard reads it from `?token=` on first load.
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
 * (the query-param path is how the dashboard bootstraps on first load
 * before it strips the token from the URL).
 */
export function checkToken(req: Request, expected: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const provided = m?.[1] ?? new URL(req.url).searchParams.get("token") ?? "";
  if (!provided) return false;
  return safeEqual(provided, expected);
}

function safeEqual(provided: string, expected: string): boolean {
=======
import { readFile, writeFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import { join } from "path";

const TOKEN_FILE = join(process.cwd(), ".claude", "claudeclaw", "web.token");

export async function getOrCreateWebToken(): Promise<string> {
  if (existsSync(TOKEN_FILE)) {
    return (await readFile(TOKEN_FILE, "utf-8")).trim();
  }
  const token = randomBytes(32).toString("base64url");
  await writeFile(TOKEN_FILE, token + "\n", { mode: 0o600 });
  await chmod(TOKEN_FILE, 0o600); // belt-and-suspenders for systems where mode arg is ignored
  return token;
}

export function checkToken(req: Request, expected: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const provided =
    m?.[1] ??
    new URL(req.url).searchParams.get("token") ??
    "";
  if (!provided) return false;
  // Compare byte lengths (not JS character lengths) so non-ASCII input never causes timingSafeEqual to throw.
>>>>>>> upstream/master
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
