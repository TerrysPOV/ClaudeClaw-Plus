/**
 * SchedulerBackend abstraction — pluggable scheduling layer for the
 * tuner's `cron` / `wisecron` family of subjects.
 *
 * Why this exists: the host OS dictates how recurring jobs are stored and
 * activated. Linux with systemd uses `~/.config/systemd/user/*.{timer,service}`;
 * Linux without systemd, plus macOS/BSD, uses POSIX `crontab -l/-e`;
 * containers and serverless environments have neither and need an in-process
 * fallback. Hardcoding any one of these in the engine excludes the others.
 *
 * Adapters live in `src/skills-tuner/schedulers/*.ts` and self-register via
 * `BackendRegistry`. Subjects (and tools like `wisecron_compose`) receive a
 * `SchedulerBackend` instance from the auto-detection layer and never touch
 * the OS scheduler primitives directly.
 *
 * Scope of v0 (this PR):
 *   - SystemdUserBackend (Linux + systemd-user)
 *   - CrontabPosixBackend (Linux/macOS/BSD + POSIX cron)
 *   - InProcessBackend (any host, no external dependencies)
 *
 * Not in scope (community PRs welcome): LaunchdBackend (macOS native),
 * TaskSchedulerBackend (Windows), KubernetesCronJobBackend, etc.
 */

/**
 * Specification for a job we want to schedule. The backend is responsible for
 * translating `schedule` into whatever the host scheduler accepts; the
 * description is the LLM input that produced this spec and is kept for audit
 * and git-commit messages.
 */
export interface JobSpec {
  /** Stable identifier used by remove() and listing. Lowercase, hyphens, max 63. */
  name: string;
  /** Free-form description that produced `schedule` (kept for traceability). */
  description: string;
  /** Either a 5-field POSIX cron expression or a systemd OnCalendar= clause. */
  schedule: string;
  /** Shell command to execute on each tick. Passed verbatim. */
  command: string;
}

/**
 * Snapshot of a job currently registered with the backend, used by list().
 */
export interface ScheduledJob {
  name: string;
  schedule: string;
  command: string;
  /** Backend-specific status: 'active', 'inactive', 'failed', 'unknown'. */
  status: "active" | "inactive" | "failed" | "unknown";
  /** Path of the underlying artifact (timer/service file, crontab line, etc.), or null if in-process. */
  artifactPath: string | null;
}

/**
 * Per-backend rendering of a JobSpec to the on-disk format. Backends use this
 * internally and may expose it for tests / dry-run UX. Pure function — no I/O.
 */
export interface RenderedArtifacts {
  /** Map of relative-path -> file content. Empty for in-process backends. */
  files: Record<string, string>;
  /** Human-readable summary for logging. */
  summary: string;
}

/**
 * The pluggable scheduler interface. Every adapter implements this exactly.
 */
export interface SchedulerBackend {
  /** Stable identifier for telemetry/logging/UX. */
  readonly name: "systemd-user" | "crontab-posix" | "launchd" | "task-scheduler" | "in-process";

  /**
   * Returns true if this backend is usable on the current host.
   *
   * MUST be non-throwing and complete in <500ms. Used by auto-detection at
   * startup to pick the best available backend. Side effects (mkdir, etc.)
   * are forbidden here — only inspection.
   */
  detect(): Promise<boolean>;

  /**
   * Returns the absolute path of the directory the backend writes its
   * artifacts to (timer files, crontab snapshots, etc.), or null when the
   * backend is purely in-process. Subjects use this as their `git_repo`
   * target so the tuner can version OS-level changes.
   */
  gitRepoPath(): string | null;

  /** Snapshot the currently-registered jobs. */
  list(): Promise<ScheduledJob[]>;

  /**
   * Pure render — produce the artifact(s) without writing them. Used for
   * dry-run, tests, and pre-write validation. MUST be deterministic.
   */
  render(spec: JobSpec): RenderedArtifacts;

  /**
   * Write artifacts to disk and activate. MUST be idempotent on name —
   * a second call with the same name should fail with a clear error
   * (operator must `remove` first), not silently overwrite.
   */
  create(spec: JobSpec): Promise<{ artifactPath: string | null }>;

  /**
   * Deactivate + remove the job. MUST be a no-op (with a warning) if the
   * job is not currently registered.
   */
  remove(name: string): Promise<void>;
}

/**
 * Errors that backends throw should extend this so callers can distinguish
 * "this backend says no, try another" from "this backend says no, the
 * operator must intervene."
 */
export class BackendError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

/** Validate a JobSpec.name against the stable identifier rules. */
const NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
export function validateJobName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new BackendError(
      `invalid job name: ${JSON.stringify(name)} (must match ${NAME_RE.source})`,
      false,
    );
  }
}

/** Reject control characters and absurd lengths in commands. */
export function validateJobCommand(command: string): void {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new BackendError("command is required and must be non-empty", false);
  }
  if (command.length > 2000) {
    throw new BackendError(`command too long: ${command.length} chars (max 2000)`, false);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security guard — rejects NUL/CR/LF in commands to prevent injection.
  if (/[\x00\r\n]/.test(command)) {
    throw new BackendError("command contains forbidden control characters (NUL, CR, or LF)", false);
  }
}
