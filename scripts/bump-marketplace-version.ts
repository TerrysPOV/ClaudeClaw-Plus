import { readFile, writeFile } from "node:fs/promises";

const MARKETPLACE_JSON = ".claude-plugin/marketplace.json";
const VALID_BUMP_TYPES = new Set(["patch", "minor", "major"]);

type BumpType = "patch" | "minor" | "major";

function bumpVersion(version: string, bumpType: BumpType): string {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported marketplace version format: ${version}`);
  }

  const [, major, minor, patch] = match;
  let nextMajor = Number(major);
  let nextMinor = Number(minor);
  let nextPatch = Number(patch);

  switch (bumpType) {
    case "major":
      nextMajor += 1;
      nextMinor = 0;
      nextPatch = 0;
      break;
    case "minor":
      nextMinor += 1;
      nextPatch = 0;
      break;
    case "patch":
      nextPatch += 1;
      break;
  }

  return `${nextMajor}.${nextMinor}.${nextPatch}`;
}

function parseVersion(version: string): [number, number, number] {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported marketplace version format: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isHigher(a: string, b: string): boolean {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

async function main(): Promise<void> {
  const rawBumpType = process.argv[2] ?? "patch";
  if (!VALID_BUMP_TYPES.has(rawBumpType)) {
    throw new Error(`Unsupported bump type: ${rawBumpType}. Use patch, minor, or major.`);
  }

  const bumpType = rawBumpType as BumpType;
  const raw = await readFile(MARKETPLACE_JSON, "utf8");
  const marketplace = JSON.parse(raw) as {
    version?: string;
    plugins?: Array<{ name?: string; version?: string }>;
  };

  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    throw new Error(`${MARKETPLACE_JSON} does not contain any plugins.`);
  }

  const plugin =
    marketplace.plugins.find((entry) => entry.name === "claudeclaw-plus") ?? marketplace.plugins[0];
  if (!plugin || typeof plugin.version !== "string" || plugin.version.trim() === "") {
    throw new Error(`${MARKETPLACE_JSON} is missing a valid plugin version string.`);
  }

  // The top-level `version` is optional; when present it moves with the plugin entry.
  // If the two disagree, bump from the higher so neither goes backwards.
  const hasTopLevel = typeof marketplace.version === "string" && marketplace.version.trim() !== "";
  let baseVersion = plugin.version;
  if (hasTopLevel && plugin.version.trim() !== (marketplace.version as string).trim()) {
    if (isHigher(marketplace.version as string, plugin.version)) {
      baseVersion = marketplace.version as string;
    }
    console.log(
      `${MARKETPLACE_JSON}: top-level version ${marketplace.version} and plugin version ${plugin.version} were out of step; bumping from ${baseVersion.trim()}`,
    );
  }

  const nextVersion = bumpVersion(baseVersion, bumpType);
  plugin.version = nextVersion;
  if (hasTopLevel) marketplace.version = nextVersion;

  await writeFile(MARKETPLACE_JSON, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
  console.log(`${MARKETPLACE_JSON}: ${nextVersion}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
