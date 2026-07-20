#!/usr/bin/env bun
/**
 * Typecheck ratchet (#327 / #324).
 *
 * The repo cannot pass `tsc --noEmit` cleanly — there is a backlog of type
 * errors predating any typecheck step. Waiting for zero before wiring CI means
 * the class stays unguarded indefinitely, which is how `dedupeKey is not
 * defined` (#329) survived 3.5 months and #330's object-into-a-string
 * parameter went unnoticed since April. Both were statically detectable.
 *
 * So this is a RATCHET, not a pass/fail gate: CI fails if the error count
 * moves AT ALL relative to the recorded baseline — up, because that is a new
 * error; down, because a stale baseline is silent slack that lets errors creep
 * back in later under a green build.
 *
 *   bun run typecheck            # compare against .tsc-baseline.json
 *   bun run typecheck --update   # re-record the baseline after a real change
 *
 * ## Fail closed, always
 *
 * Every ambiguous state is a FAILURE, not a pass. A ratchet that silently
 * disables itself is worse than none, because it reads as protection:
 *
 *   - tsc crashes, or fails without emitting file-prefixed diagnostics
 *     (e.g. `error TS18003: No inputs were found in config file`) -> fail.
 *     Counting only stdout text would report 0 errors and "improvement".
 *   - `.tsc-baseline.json` missing, empty, malformed, or containing merge
 *     conflict markers -> fail. That file is a single small JSON blob, i.e.
 *     exactly the shape that conflicts on parallel cleanup PRs, and a botched
 *     resolution must not turn the gate off.
 *   - `--update` that would RAISE the total -> refused unless
 *     `--allow-increase` is passed explicitly, so nobody buries new errors by
 *     reflexively running the command a failure message suggested.
 *
 * ## Per-file baseline
 *
 * The baseline records per-file counts, not just a total. A bare total makes
 * the failure output useless: printing the first N errors in tsc's path-sorted
 * order shows the same alphabetically-first backlog entries every time, never
 * the new ones. With per-file counts the script can name exactly which files
 * regressed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BASELINE_FILE = join(REPO_ROOT, ".tsc-baseline.json");

/** A diagnostic line: `path/to/file.ts(12,34): error TS1234: ...` */
const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+/;
/** A config-level diagnostic with no file prefix: `error TS18003: ...` */
const CONFIG_ERROR = /^error TS\d+/;

interface Baseline {
  total: number;
  files: Record<string, number>;
}

function die(msg: string): never {
  console.error(`\ntypecheck ratchet FAILED: ${msg}`);
  process.exit(1);
}

function runTsc(): { perFile: Record<string, number>; total: number } {
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(["bunx", "tsc", "--noEmit"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    die(`could not run tsc: ${err instanceof Error ? err.message : String(err)}`);
  }

  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  const lines = output.split("\n");

  // A config-level error means tsc never typechecked anything. Counting its
  // (zero) file diagnostics would look like a clean repo.
  const configError = lines.find((l) => CONFIG_ERROR.test(l));
  if (configError)
    die(`tsc reported a configuration error, so nothing was checked:\n  ${configError}`);

  const perFile: Record<string, number> = {};
  for (const line of lines) {
    const m = DIAGNOSTIC.exec(line);
    if (!m?.[1]) continue;
    // Only count code this repo controls. Dependency `.d.ts` files (notably
    // `bun-types`) emit their own errors, and those move whenever anything is
    // installed — pinning `typescript` alone shifted them by 5 — which would
    // make the ratchet fail on dependency churn rather than on a change the
    // author made.
    if (m[1].includes("node_modules/")) continue;
    perFile[m[1]] = (perFile[m[1]] ?? 0) + 1;
  }
  const total = Object.values(perFile).reduce((a, b) => a + b, 0);

  // tsc exits 0 with no diagnostics, 1 or 2 when diagnostics exist. Any
  // nonzero exit with zero parsed diagnostics means it failed for a reason we
  // did not parse — treat as broken, never as "clean".
  if (proc.exitCode !== 0 && total === 0) {
    die(
      `tsc exited ${proc.exitCode} but produced no parseable diagnostics — it likely crashed.\n` +
        output
          .split("\n")
          .slice(0, 15)
          .map((l) => `  ${l}`)
          .join("\n"),
    );
  }

  return { perFile, total };
}

function readBaseline(): Baseline {
  if (!existsSync(BASELINE_FILE)) {
    die(`${BASELINE_FILE} is missing. Recreate it with: bun run typecheck --update`);
  }
  const raw = readFileSync(BASELINE_FILE, "utf8");
  if (raw.includes("<<<<<<<") || raw.includes(">>>>>>>")) {
    die(`${BASELINE_FILE} contains unresolved merge conflict markers.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die(`${BASELINE_FILE} is not valid JSON.`);
  }
  const b = parsed as Partial<Baseline>;
  if (typeof b?.total !== "number" || typeof b?.files !== "object" || b.files === null) {
    die(
      `${BASELINE_FILE} is malformed — expected { total: number, files: Record<string, number> }.`,
    );
  }
  return b as Baseline;
}

const args = new Set(process.argv.slice(2));
const { perFile, total } = runTsc();

if (args.has("--update")) {
  const allowIncrease = args.has("--allow-increase");
  if (existsSync(BASELINE_FILE)) {
    const prev = readBaseline();
    if (total > prev.total && !allowIncrease) {
      die(
        `refusing to RAISE the baseline (${prev.total} -> ${total}).\n` +
          "  This would bury new type errors under a green build.\n" +
          "  Fix them, or pass --allow-increase if the increase is genuinely intended.",
      );
    }
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ total, files: perFile }, null, 2)}\n`);
  console.log(`baseline recorded: ${total} error(s) across ${Object.keys(perFile).length} file(s)`);
  process.exit(0);
}

const baseline = readBaseline();
console.log(`typecheck: ${total} error(s), baseline ${baseline.total}`);

if (total === baseline.total) process.exit(0);

// Name the files that actually moved, in either direction.
const names = new Set([...Object.keys(perFile), ...Object.keys(baseline.files)]);
const moved = [...names]
  .map((f) => ({ file: f, now: perFile[f] ?? 0, was: baseline.files[f] ?? 0 }))
  .filter((r) => r.now !== r.was)
  .sort((a, b) => b.now - b.was - (a.now - a.was));

if (total > baseline.total) {
  console.error(`\ntypecheck ratchet FAILED: ${total} errors, baseline ${baseline.total}.`);
  console.error("New type errors were introduced. Files that grew:\n");
  for (const r of moved.filter((x) => x.now > x.was)) {
    console.error(`  +${r.now - r.was}  ${r.file}  (${r.was} -> ${r.now})`);
  }
  console.error("\nFix them. Do NOT re-baseline to make this pass.");
  process.exit(1);
}

console.error(`\ntypecheck ratchet FAILED: ${total} errors, baseline ${baseline.total}.`);
console.error("The count DROPPED — good, but the baseline must be lowered in the same change,");
console.error("otherwise it leaves slack that lets errors creep back under a green build.\n");
for (const r of moved.filter((x) => x.now < x.was)) {
  console.error(`  -${r.was - r.now}  ${r.file}  (${r.was} -> ${r.now})`);
}
console.error("\nRun: bun run typecheck --update");
process.exit(1);
