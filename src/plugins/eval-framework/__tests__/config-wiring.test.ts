/**
 * Regression tests for the settings pipeline (#80 review finding #5):
 * `governance.evalFramework` written by an operator must actually reach the
 * parsed Settings object — previously parseGovernanceConfig only ever read
 * `watchdog`, so eval-framework config was dead-wired end-to-end.
 */

import { describe, it, expect } from "bun:test";
import { parseGovernanceConfig } from "../../../config.js";

describe("governance.evalFramework wiring", () => {
  it("carries evalFramework through when present", () => {
    const parsed = parseGovernanceConfig({
      evalFramework: { enabled: true, evals_root: "/srv/evals", default_max_cost_usd: 5 },
    });
    expect(parsed.evalFramework?.enabled).toBe(true);
    expect(parsed.evalFramework?.evals_root).toBe("/srv/evals");
    expect(parsed.evalFramework?.default_max_cost_usd).toBe(5);
  });

  it("parses evalFramework even when watchdog is absent", () => {
    const parsed = parseGovernanceConfig({ evalFramework: { enabled: true } });
    expect(parsed.evalFramework?.enabled).toBe(true);
    expect(parsed.watchdog).toEqual({});
  });

  it("still parses watchdog alongside evalFramework", () => {
    const parsed = parseGovernanceConfig({
      watchdog: { enabled: true, maxToolCalls: 50 },
      evalFramework: { enabled: false },
    });
    expect(parsed.watchdog.enabled).toBe(true);
    expect(parsed.watchdog.maxToolCalls).toBe(50);
    expect(parsed.evalFramework?.enabled).toBe(false);
  });

  it("omits evalFramework when not configured", () => {
    expect(parseGovernanceConfig({}).evalFramework).toBeUndefined();
    expect(parseGovernanceConfig(undefined).evalFramework).toBeUndefined();
    expect(parseGovernanceConfig({ evalFramework: "bogus" }).evalFramework).toBeUndefined();
  });
});
