import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRoutingSubject } from "../../../subjects/model-routing-subject.js";
import type { Patch, Proposal } from "../../../../skills-tuner/core/types.js";

let tmpRoot: string;
let configPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mrconf-"));
  configPath = join(tmpRoot, "agentic.yaml");
  writeFileSync(configPath, "modes: {}\n");
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function foreignProposal(target: string): Proposal {
  return {
    id: 1,
    cluster_id: "c",
    subject: "model_routing",
    kind: "patch",
    target_path: target,
    alternatives: [{ id: "a", label: "l", diff_or_content: "modes: {}\n", tradeoff: "" }],
    pattern_signature: "s",
    created_at: new Date(),
  } as unknown as Proposal;
}

describe("ModelRoutingSubject — apply/revert confinement", () => {
  it("apply refuses a target_path outside the managed modes config", async () => {
    const sub = new ModelRoutingSubject({ modesConfigPath: configPath });
    const foreign = join(tmpRoot, "engine.ts");
    await expect(sub.apply(foreignProposal(foreign), "a")).rejects.toThrow(
      /not the managed modes config/,
    );
  });

  it("revert refuses a foreign target_path", async () => {
    const sub = new ModelRoutingSubject({ modesConfigPath: configPath });
    const inverse: Patch = {
      target_path: join(tmpRoot, "engine.ts"),
      kind: "patch_inverse",
      applied_content: "x",
    };
    await expect(sub.revert(inverse)).rejects.toThrow(/not the managed modes config/);
  });

  it("apply still works for the managed config", async () => {
    const sub = new ModelRoutingSubject({ modesConfigPath: configPath });
    const patch = await sub.apply(foreignProposal(configPath), "a");
    expect(patch.target_path).toBe(configPath);
  });
});
