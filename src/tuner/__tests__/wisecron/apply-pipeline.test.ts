/**
 * ApplyPipeline apply-ordering safety (fix #1): validation must run BEFORE the
 * change is git-committed and recorded. On a validation failure the on-disk
 * write must be rolled back to the pre-apply snapshot and leave NO git commit
 * and NO rollback_history revision behind. The happy path must be unchanged
 * (commit made + revision recorded).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyPipeline } from "../../wisecron/apply-pipeline.js";
import { WisecronStateDB } from "../../wisecron/state-db.js";
import { Registry } from "../../../skills-tuner/core/registry.js";
import { TunableSubject } from "../../../skills-tuner/core/interfaces.js";
import type { RiskTier } from "../../../skills-tuner/core/interfaces.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../../skills-tuner/core/types.js";

class FileSubject extends TunableSubject {
  readonly name = "file_subject";
  readonly risk_tier: RiskTier = "medium";
  valid = true;

  async collectObservations(_since: Date): Promise<Observation[]> {
    return [];
  }
  async detectProblems(_o: Observation[]): Promise<Cluster[]> {
    return [];
  }
  async proposeChange(_c: Cluster): Promise<UnsignedProposal> {
    throw new Error("unused");
  }
  async apply(proposal: Proposal, altId: string): Promise<Patch> {
    const alt = proposal.alternatives.find((a) => a.id === altId);
    if (!alt) throw new Error(`alt ${altId} not found`);
    writeFileSync(proposal.target_path, alt.diff_or_content, "utf8");
    return {
      target_path: proposal.target_path,
      kind: "patch",
      applied_content: alt.diff_or_content,
    };
  }
  async validate(_p: Patch): Promise<ValidationResult> {
    return this.valid ? { valid: true } : { valid: false, reason: "duplicate keyword 'x'" };
  }
  async revert(inverse: Patch): Promise<void> {
    writeFileSync(inverse.target_path, inverse.applied_content, "utf8");
  }
}

let tmpDir: string;
let db: WisecronStateDB;
let registry: Registry;
let subject: FileSubject;
let configPath: string;
let pipeline: ApplyPipeline;

function git(...args: string[]) {
  return spawnSync("git", ["-C", tmpDir, ...args], { encoding: "utf8" });
}
function commitCount(): number {
  const r = git("rev-list", "--count", "HEAD");
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

function proposal(content: string): Proposal {
  return {
    id: 101,
    cluster_id: "c",
    subject: "file_subject",
    kind: "patch",
    target_path: configPath,
    pattern_signature: "sig",
    created_at: new Date(),
    signature: "s",
    alternatives: [{ id: "a", label: "", tradeoff: "", diff_or_content: content }],
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "apply-pipe-"));
  db = new WisecronStateDB(join(tmpDir, "wisecron.db"));
  registry = new Registry();
  subject = new FileSubject();
  registry.registerSubject(subject);
  configPath = join(tmpDir, "agentic.yaml");
  writeFileSync(configPath, "modes:\n  a:\n    keywords: [good]\n");
  // Real git repo so we can assert whether a [tuner] commit was made.
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  pipeline = new ApplyPipeline(registry, db, { verify: () => true });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ApplyPipeline — validate before commit/record (fix #1)", () => {
  it("validation failure restores the config AND leaves no commit / no revision", async () => {
    const original = readFileSync(configPath, "utf8");
    const before = commitCount();
    subject.valid = false;

    await expect(
      pipeline.apply(
        proposal("modes:\n  a:\n    keywords: [x]\n  b:\n    keywords: [x]\n"),
        "a",
        "cli",
      ),
    ).rejects.toThrow(/failed validation/);

    // On-disk config rolled back to the pre-apply snapshot.
    expect(readFileSync(configPath, "utf8")).toBe(original);
    // No git commit was made (validation gated it).
    expect(commitCount()).toBe(before);
    // No rollback_history revision recorded.
    expect(db.getActiveRevisionByProposal("101")).toBeNull();
    expect(db.listRevisionsBySubject("file_subject")).toHaveLength(0);
  });

  it("happy path unchanged: valid apply commits + records a revision", async () => {
    const before = commitCount();
    subject.valid = true;

    const outcome = await pipeline.apply(
      proposal("modes:\n  a:\n    keywords: [renamed]\n"),
      "a",
      "cli",
    );

    expect(readFileSync(configPath, "utf8")).toContain("renamed");
    expect(commitCount()).toBe(before + 1);
    expect(git("log", "-1", "--pretty=%s").stdout).toContain("[tuner]");
    expect(outcome.revision.id).toBeGreaterThan(0);
    expect(db.getActiveRevisionByProposal("101")).not.toBeNull();
  });
});
