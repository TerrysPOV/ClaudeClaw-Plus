import { expect, it } from "bun:test";

/** #570: a process that never ran the startup version probe must keep untrusted routes on print. */
it("pty isolation is OFF in a fresh process that never probed (fail closed)", () => {
  const probe = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { engines } from "./src/oneshot/registry.js"; import { resolveOneShotEngine } from "./src/oneshot/config.js";
       console.log(JSON.stringify({ iso: engines.get("pty").caps.isolation,
         route: resolveOneShotEngine({ engines: {}, routes: {} }, "discord.classifier", true) }));`,
    ],
    { cwd: process.cwd() },
  );
  expect(probe.exitCode).toBe(0);
  expect(JSON.parse(probe.stdout.toString().trim())).toEqual({ iso: false, route: "print" });
});

/**
 * #570 r11 (B): settings load runs BEFORE the startup probe, so it cannot depend on the
 * capability the probe sets. A fresh process has not probed, so isolation is off here.
 */
it("explicit pty untrusted routes load in a fresh process whose gate has not run", () => {
  // Went red (with three in-process twins in engine.test.ts) when the load-time isolation check came back.
  const probe = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { engines } from "./src/oneshot/registry.js"; import { parseOneShotSettings } from "./src/oneshot/config.js";
       const out = { iso: engines.get("pty").caps.isolation, loaded: [] };
       for (const raw of [{ default: "pty" }, { routes: { "discord.classifier": "pty" } }, { routes: { "tuner.*": "pty" } }]) {
         try { parseOneShotSettings(raw); out.loaded.push(true); } catch (e) { out.loaded.push(String(e.message)); }
       }
       console.log(JSON.stringify(out));`,
    ],
    { cwd: process.cwd() },
  );
  expect(probe.exitCode).toBe(0);
  expect(JSON.parse(probe.stdout.toString().trim())).toEqual({
    iso: false,
    loaded: [true, true, true],
  });
});

it("the call, not the load, refuses an untrusted pty route while isolation is off", () => {
  // Went red when the error text lost the version.
  const probe = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { validateRouteEngine } from "./src/oneshot/config.js";
       try { validateRouteEngine("pty", "discord.classifier", true, false); console.log("accepted"); }
       catch (e) { console.log(e.message); }`,
    ],
    { cwd: process.cwd() },
  );
  expect(probe.exitCode).toBe(0);
  const message = probe.stdout.toString().trim();
  expect(message).toContain("does not advertise isolation");
  // Names the real cause, not a spike status.
  expect(message).toContain("2.1.304");
  expect(message.includes("spike")).toBe(false);
});

it("start.ts hands the gate the probed version, after the probe", async () => {
  // Went red when start.ts passed null instead of the probed version.
  const start = await Bun.file(`${process.cwd()}/src/commands/start.ts`).text();
  const probe = start.indexOf("await probeClaudeCliVersion()");
  const gate = start.indexOf("applyPtyIsolationVersionGate(cliProbe.version)");
  expect(probe).toBeGreaterThan(0);
  expect(gate).toBeGreaterThan(probe);
});
