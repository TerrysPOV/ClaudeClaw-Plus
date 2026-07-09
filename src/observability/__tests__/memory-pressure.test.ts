import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readMemoryPressure } from "../memory-pressure.js";

const TMP = `/tmp/memory-pressure-test-${process.pid}`;
const CG_PATH = "/user.slice/agent.service";

function writeCgroup(files: Record<string, string>) {
  const dir = join(TMP, "cgroup", CG_PATH);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  writeFileSync(join(TMP, "proc-self-cgroup"), `0::${CG_PATH}\n`);
  return {
    cgroupRoot: join(TMP, "cgroup"),
    procSelfCgroup: join(TMP, "proc-self-cgroup"),
  };
}

describe("readMemoryPressure", () => {
  beforeEach(() => rmSync(TMP, { recursive: true, force: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("reports the freeze zone: current above high", () => {
    const deps = writeCgroup({
      "memory.current": "1900000000\n",
      "memory.high": "1610612736\n",
      "memory.max": "2684354560\n",
      "memory.swap.current": "3900000000\n",
      "memory.swap.max": "max\n",
      "memory.events": "low 0\nhigh 42\nmax 0\noom 0\noom_kill 0\n",
    });
    const p = readMemoryPressure(deps);
    expect(p.supported).toBe(true);
    expect(p.overHigh).toBe(true);
    expect(p.currentBytes).toBe(1_900_000_000);
    expect(p.highBytes).toBe(1_610_612_736);
    expect(p.swapCurrentBytes).toBe(3_900_000_000);
    expect(p.swapMaxBytes).toBeNull(); // "max" = unlimited — the trap
    expect(p.highEvents).toBe(42);
  });

  it("healthy: current under high", () => {
    const deps = writeCgroup({
      "memory.current": "400000000\n",
      "memory.high": "1610612736\n",
      "memory.max": "2684354560\n",
      "memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n",
    });
    const p = readMemoryPressure(deps);
    expect(p.supported).toBe(true);
    expect(p.overHigh).toBe(false);
    expect(p.highEvents).toBe(0);
  });

  it("no soft limit (high=max): never overHigh", () => {
    const deps = writeCgroup({
      "memory.current": "9000000000\n",
      "memory.high": "max\n",
      "memory.max": "max\n",
    });
    const p = readMemoryPressure(deps);
    expect(p.supported).toBe(true);
    expect(p.overHigh).toBe(false);
    expect(p.highBytes).toBeNull();
    expect(p.maxBytes).toBeNull();
  });

  it("unsupported when memory.current is unreadable (cgroup v1 / non-Linux)", () => {
    const deps = writeCgroup({}); // path exists but no memory files
    const p = readMemoryPressure(deps);
    expect(p.supported).toBe(false);
    expect(p.overHigh).toBe(false);
  });

  it("unsupported when /proc/self/cgroup is missing or has no v2 line", () => {
    expect(
      readMemoryPressure({
        cgroupRoot: "/nonexistent",
        procSelfCgroup: "/nonexistent/proc-cgroup",
      }).supported,
    ).toBe(false);

    mkdirSync(TMP, { recursive: true });
    const v1Only = join(TMP, "v1-cgroup");
    writeFileSync(v1Only, "12:memory:/user.slice\n1:name=systemd:/user.slice\n");
    expect(readMemoryPressure({ cgroupRoot: TMP, procSelfCgroup: v1Only }).supported).toBe(false);
  });

  it("missing optional files degrade to null, not unsupported", () => {
    const deps = writeCgroup({
      "memory.current": "500\n",
      "memory.high": "1000\n",
    });
    const p = readMemoryPressure(deps);
    expect(p.supported).toBe(true);
    expect(p.maxBytes).toBeNull();
    expect(p.swapCurrentBytes).toBeNull();
    expect(p.highEvents).toBeNull();
  });
});
