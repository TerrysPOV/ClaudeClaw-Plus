import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalProcessSubject } from "../external_process.js";

/**
 * These tests drive the real subprocess path: every fixture is a script on disk
 * spawned by ExternalProcessSubject itself, so the assertions cover what an
 * operator actually sees when an external subject fails.
 */

let dir: string;

/**
 * Write a fixture script whose body runs once stdin is drained (the subject
 * always writes a request), and return a subject wired to it.
 *
 * Fixture bodies set `process.exitCode` rather than calling `process.exit()`:
 * `exit()` tears the process down without waiting for a pending write to the
 * stdout/stderr pipe to flush. Measured truncation thresholds are ~219 KB on
 * bun and ~146 KB on node, so no fixture here is anywhere near losing output
 * today — this removes a size-dependent footgun for whoever writes the first
 * fixture that dumps more, not an active flake.
 *
 * The trade: `exit()` always exits, `exitCode` exits only once nothing holds
 * the event loop. Nothing does today. A fixture that later leaves a timer or
 * handle open will hang instead, and surface as the subject's 15s timeout
 * rather than as "your fixture leaked a handle" — so keep fixture bodies free
 * of live handles.
 */
function subjectRunning(fileName: string, body: string): ExternalProcessSubject {
  const scriptPath = join(dir, fileName);
  writeFileSync(
    scriptPath,
    `const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
${body}
});
`,
  );
  return new ExternalProcessSubject({
    name: "fixture-subject",
    command: [process.execPath, scriptPath],
    allowedRoots: [dir],
    timeoutMs: 15_000,
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "external-process-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ExternalProcessSubject non-zero exit", () => {
  it('surfaces the documented {"error": ...} stdout envelope (regression)', async () => {
    const subject = subjectRunning(
      "stdout-error.js",
      `  process.stdout.write(JSON.stringify({ error: "config file is missing a 'threshold' key" }));
  process.exitCode = 1;`,
    );

    const promise = subject.collectObservations(new Date(0));
    await expect(promise).rejects.toThrow("config file is missing a 'threshold' key");
    await expect(promise).rejects.toThrow("exited 1");
  });

  it("still surfaces stderr when the subject logs there", async () => {
    const subject = subjectRunning(
      "stderr-only.js",
      `  process.stderr.write("Traceback: interpreter blew up");
  process.exitCode = 3;`,
    );

    const promise = subject.collectObservations(new Date(0));
    await expect(promise).rejects.toThrow("stderr: Traceback: interpreter blew up");
    await expect(promise).rejects.toThrow("exited 3");
  });

  it("reports both streams when the subject writes to each", async () => {
    const subject = subjectRunning(
      "both-streams.js",
      `  process.stderr.write("warning: cache unreadable");
  process.stdout.write(JSON.stringify({ error: "scan aborted" }));
  process.exitCode = 1;`,
    );

    let message = "";
    try {
      await subject.collectObservations(new Date(0));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("error: scan aborted");
    expect(message).toContain("stderr: warning: cache unreadable");
  });

  it("falls back to raw stdout when it is not the documented envelope", async () => {
    const subject = subjectRunning(
      "stdout-not-json.js",
      `  process.stdout.write("segfault while loading model");
  process.exitCode = 2;`,
    );

    await expect(subject.collectObservations(new Date(0))).rejects.toThrow(
      "stdout: segfault while loading model",
    );
  });

  it("says so explicitly when both streams are empty", async () => {
    const subject = subjectRunning("silent.js", `  process.exitCode = 9;`);

    let message = "";
    try {
      await subject.collectObservations(new Date(0));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("ExternalProcess fixture-subject exited 9. no output on stdout or stderr");
  });

  it("truncates an oversized stream instead of inlining all of it", async () => {
    const subject = subjectRunning(
      "huge-stderr.js",
      `  process.stderr.write("x".repeat(5000));
  process.exitCode = 1;`,
    );

    let message = "";
    try {
      await subject.collectObservations(new Date(0));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`stderr: ${"x".repeat(500)}`);
    expect(message).not.toContain("x".repeat(501));
  });
});

describe("ExternalProcessSubject zero exit (unchanged)", () => {
  it("returns the result payload on the happy path", async () => {
    const subject = subjectRunning(
      "ok-result.js",
      `  process.stdout.write(JSON.stringify({ result: [] }));
  process.exitCode = 0;`,
    );

    await expect(subject.collectObservations(new Date(0))).resolves.toEqual([]);
  });

  it("still throws the RPC error branch on exit 0 with an error envelope", async () => {
    const subject = subjectRunning(
      "ok-error.js",
      `  process.stdout.write(JSON.stringify({ error: "unknown method: collect_observations" }));
  process.exitCode = 0;`,
    );

    await expect(subject.collectObservations(new Date(0))).rejects.toThrow(
      "method collect_observations error: unknown method: collect_observations",
    );
  });
});

describe("ExternalProcessSubject line-oriented envelope", () => {
  it("finds the envelope when the subject logged before failing", async () => {
    const subject = subjectRunning(
      "logs-then-error.js",
      `  process.stdout.write("loading configuration " + ".".repeat(600) + "\\n");
  process.stdout.write(JSON.stringify({ error: "threshold key missing in config" }) + "\\n");
  process.exitCode = 1;`,
    );

    // The protocol prints one JSON object per line, so the envelope is the last
    // line: parsing the whole buffer would drown it in the preceding log noise.
    await expect(subject.collectObservations(new Date(0))).rejects.toThrow(
      "threshold key missing in config",
    );
  });

  it("keeps a result payload out of the failure message", async () => {
    const subject = subjectRunning(
      "result-then-exit.js",
      `  process.stdout.write(JSON.stringify({ result: ["confidential-record-1", "confidential-record-2"] }));
  process.exitCode = 3;`,
    );

    const promise = subject.collectObservations(new Date(0));
    await expect(promise).rejects.toThrow("stdout: result payload");
    await expect(promise).rejects.not.toThrow("confidential-record-1");
  });

  it("clips on a code-point boundary, never mid-surrogate", async () => {
    const subject = subjectRunning(
      "wide-chars.js",
      `  process.stdout.write(JSON.stringify({ error: "x".repeat(499) + "\\u{1F4A5}" + "boom" }));
  process.exitCode = 1;`,
    );

    const message = await subject.collectObservations(new Date(0)).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(message).toContain("\u{1F4A5}");
    expect(/[\uD800-\uDBFF]$/.test(message)).toBe(false);
  });
});

describe("ExternalProcessSubject timeout", () => {
  it("surfaces what the subject reported before it hung", async () => {
    const scriptPath = join(dir, "reports-then-hangs.js");
    writeFileSync(
      scriptPath,
      `process.stdin.on("data", () => {});
process.stdout.write(JSON.stringify({ error: "database handle stuck" }) + "\\n");
setTimeout(() => {}, 30_000);
`,
    );
    const subject = new ExternalProcessSubject({
      name: "fixture-subject",
      command: [process.execPath, scriptPath],
      allowedRoots: [dir],
      timeoutMs: 1_500,
    });

    const promise = subject.collectObservations(new Date(0));
    await expect(promise).rejects.toThrow("timed out after 1500ms");
    await expect(promise).rejects.toThrow("database handle stuck");
  });
});
