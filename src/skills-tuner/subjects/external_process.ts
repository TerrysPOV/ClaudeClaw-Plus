import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { TunableSubject } from "../core/interfaces.js";
import {
  UnsignedProposalSchema,
  ClusterSchema,
  ObservationSchema,
  PatchSchema,
  ValidationResultSchema,
  type Cluster,
  type Observation,
  type Patch,
  type UnsignedProposal,
  type ValidationResult,
} from "../core/types.js";
import type { Proposal } from "../core/types.js";
import type { RiskTier } from "../core/interfaces.js";
import type { DateRange, Metric, TelemetryProvider } from "../core/telemetry.js";

export interface ExternalProcessConfig {
  name: string;
  command: string[];
  allowedRoots?: string[];
  riskTier?: RiskTier;
  autoMergeDefault?: boolean;
  supportsCreation?: boolean;
  orphanMinObservations?: number;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  /**
   * OutcomeLoop fitness metrics this external subject is scored on. Declared
   * STATICALLY in TS config (not via RPC) because `fitnessSignals()` is a sync
   * method while the subprocess protocol is async — a sync RPC would be a
   * footgun. The subprocess only implements the async `measure_fitness` half.
   * Each metric's `source` is normally `"artifact"` (Tier 1b: the subprocess
   * scans its own journal/file, always activatable, no host stream gate).
   */
  fitnessSignals?: Metric[];
}

const RpcResponseSchema = z.union([
  z.object({ result: z.unknown() }).strict(),
  z.object({ error: z.string() }).strict(),
]);

const MAX_STREAM_CHARS = 500;

/**
 * Truncate on a code-point boundary so a clipped message never ends on half of
 * a surrogate pair (which would become U+FFFD once the message is encoded).
 *
 * The scan is bounded: it stops one code point past the cap, so the cost of
 * describing a failure never scales with how much the failing subject dumped.
 * `Array.from(text)` would materialise every code point of a multi-megabyte
 * stream as its own string before throwing all but 500 of them away — turning
 * a misbehaving subject into a memory spike on the error path.
 */
function clip(text: string): string {
  let clipped = "";
  let points = 0;
  for (const point of text) {
    if (points === MAX_STREAM_CHARS) return clipped;
    clipped += point;
    points++;
  }
  return text;
}

/**
 * Decode the RPC envelope a subject wrote to stdout, if there is one.
 *
 * The protocol is line-oriented — the template prints one JSON object per line
 * (see examples/external_subject_python_template.py) — so the envelope is the
 * LAST non-empty line, and anything a subject logged before it is not JSON.
 * Parsing the whole buffer would therefore miss the envelope of any subject
 * that logs before it fails.
 */
function stdoutEnvelope(stdout: string): { error: string } | { result: unknown } | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const envelope = RpcResponseSchema.safeParse(JSON.parse(line));
      return envelope.success ? envelope.data : undefined;
    } catch {
      // The last non-empty line is not JSON — treat stdout as raw output.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Describe what a failing subject left behind, preferring its own diagnosis.
 */
function failureDetails(stdout: string, stderr: string): string {
  const details: string[] = [];
  const envelope = stdoutEnvelope(stdout);
  if (envelope && "error" in envelope) {
    details.push(`error: ${clip(envelope.error)}`);
  } else if (envelope) {
    // A result payload on a failure path is not a diagnosis; naming it keeps
    // the subject's data out of the exception message.
    details.push("stdout: result payload");
  } else if (stdout.trim()) {
    details.push(`stdout: ${clip(stdout)}`);
  }
  if (stderr.trim()) {
    details.push(`stderr: ${clip(stderr)}`);
  }
  return details.length > 0 ? details.join(" | ") : "no output on stdout or stderr";
}

export class ExternalProcessSubject extends TunableSubject {
  readonly name: string;
  readonly risk_tier: RiskTier;
  readonly auto_merge_default: boolean;
  readonly supports_creation: boolean;
  readonly orphan_min_observations: number;

  constructor(private opts: ExternalProcessConfig) {
    super();
    this.name = opts.name;
    this.risk_tier = opts.riskTier ?? "high";
    this.auto_merge_default = opts.autoMergeDefault ?? false;
    this.supports_creation = opts.supportsCreation ?? false;
    this.orphan_min_observations = opts.orphanMinObservations ?? 2;
  }

  private async callMethod(method: string, payload: unknown): Promise<unknown> {
    const proc = spawn(this.opts.command[0]!, this.opts.command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
    });

    const requestBody = JSON.stringify({ method, payload, config: this.opts.config ?? {} });
    proc.stdin.write(requestBody);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const exitCode: number = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        // A subject can report its own failure and then hang; surface whatever it
        // wrote so a timeout is not the only thing the operator gets.
        reject(
          new Error(
            `ExternalProcess ${this.name} timed out after ${timeoutMs}ms. ` +
              failureDetails(stdout, stderr),
          ),
        );
      }, timeoutMs);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    if (exitCode !== 0) {
      // The documented stdio protocol (see examples/external_subject_python_template.py)
      // has a failing subject print `{"error": "<message>"}` to STDOUT and then exit
      // non-zero, so the subject's own diagnosis lives on stdout, not stderr. Report
      // both streams — a subject may legitimately log to stderr as well.
      throw new Error(
        `ExternalProcess ${this.name} exited ${exitCode}. ${failureDetails(stdout, stderr)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`ExternalProcess ${this.name} returned invalid JSON: ${clip(stdout)}`);
    }

    const validated = RpcResponseSchema.parse(parsed);
    if ("error" in validated) {
      throw new Error(`ExternalProcess ${this.name} method ${method} error: ${validated.error}`);
    }
    return validated.result;
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const result = await this.callMethod("collect_observations", { since: since.toISOString() });
    return z.array(ObservationSchema).parse(result);
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    const result = await this.callMethod("detect_problems", { observations });
    return z.array(ClusterSchema).parse(result);
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const result = await this.callMethod("propose_change", { cluster });
    return UnsignedProposalSchema.parse(result);
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const result = await this.callMethod("apply", { proposal, alternative_id: alternativeId });
    const patch = PatchSchema.parse(result);

    // Path traversal guard
    const roots = this.opts.allowedRoots;
    if (!roots || roots.length === 0) {
      throw new Error(
        `ExternalProcessSubject '${this.name}' has no allowedRoots configured — external subjects must declare explicit write zones`,
      );
    }
    const target = resolve(patch.target_path.replace(/^~/, homedir()));
    const allowed = roots.map((r) => resolve(r.replace(/^~/, homedir())));
    const safe = allowed.some((root) => target.startsWith(root + sep) || target === root);
    if (!safe) {
      throw new Error(
        `ExternalProcessSubject '${this.name}' refusing to write outside allowedRoots: target=${target}, allowedRoots=[${allowed.join(", ")}]`,
      );
    }

    return patch;
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    const result = await this.callMethod("validate", { patch });
    return ValidationResultSchema.parse(result);
  }

  /**
   * Static fitness declaration (sync, no RPC). Mirrors the config — the host's
   * activation gate intersects these sources against its telemetry
   * capabilities; artifact-source metrics always activate. Returns a copy so a
   * caller can't mutate the config array.
   */
  override fitnessSignals(): Metric[] {
    return this.opts.fitnessSignals ? [...this.opts.fitnessSignals] : [];
  }

  /**
   * Measure declared fitness over `range` by proxying to the subprocess'
   * `measure_fitness` method. The subprocess reads its own artifact (e.g. a
   * per-scan conformity journal) over [start,end] and returns metric→value.
   * `_provider` is unused: artifact metrics are self-contained on the Python
   * side (the subprocess owns the journal), so no host stream is queried here.
   */
  override async measureFitness(
    range: DateRange,
    _provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const result = await this.callMethod("measure_fitness", {
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    });
    return z.record(z.string(), z.number()).parse(result);
  }
}
