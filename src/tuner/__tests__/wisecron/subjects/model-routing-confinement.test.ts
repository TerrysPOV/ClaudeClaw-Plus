import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
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

  it("apply refuses a managed path that is a SYMLINK (no write-through into engine code)", async () => {
    // A symlink at the managed path pointing at engine code: resolve() would
    // treat it as the managed config, but writeFileSync follows the link.
    const engineFile = join(tmpRoot, "engine.ts");
    writeFileSync(engineFile, "ENGINE CODE — do not touch\n");
    const linkPath = join(tmpRoot, "agentic-link.yaml");
    symlinkSync(engineFile, linkPath);

    const sub = new ModelRoutingSubject({ modesConfigPath: linkPath });
    await expect(sub.apply(foreignProposal(linkPath), "a")).rejects.toThrow(/symlink/);
    // Engine code untouched — the write never went through the link.
    expect(readFileSync(engineFile, "utf8")).toBe("ENGINE CODE — do not touch\n");
  });

  it("revert refuses a symlinked managed target too", async () => {
    const engineFile = join(tmpRoot, "engine2.ts");
    writeFileSync(engineFile, "ENGINE\n");
    const linkPath = join(tmpRoot, "agentic-link2.yaml");
    symlinkSync(engineFile, linkPath);
    const sub = new ModelRoutingSubject({ modesConfigPath: linkPath });
    await expect(
      sub.revert({ target_path: linkPath, kind: "patch_inverse", applied_content: "x" }),
    ).rejects.toThrow(/symlink/);
    expect(readFileSync(engineFile, "utf8")).toBe("ENGINE\n");
  });

  it("double-apply preserves the ORIGINAL .bak (crash-then-reapply safety)", async () => {
    const original = "modes:\n  o:\n    keywords: [orig]\n";
    writeFileSync(configPath, original);
    const sub = new ModelRoutingSubject({ modesConfigPath: configPath });
    const applied1 = "modes:\n  o:\n    keywords: [applied1]\n";
    const proposal = {
      ...foreignProposal(configPath),
      alternatives: [{ id: "a", label: "l", diff_or_content: applied1, tradeoff: "" }],
    } as Proposal;

    await sub.apply(proposal, "a");
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(original);

    // Simulate the operator re-applying after a crash before the status flip:
    // the target already holds applied content. The .bak must STILL be the
    // pristine original, not overwritten with applied content.
    await sub.apply(proposal, "a");
    expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(original);
  });
});
