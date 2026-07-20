/**
 * Shared `MuxSettingsView` test fixture (#304).
 *
 * Three copies of this builder previously existed — one under
 * `src/plugins/mcp-multiplexer/__tests__/`, two under `src/__tests__/`.
 *
 * When #68 (`metricsEnabled`, 931b25a) and #69 (`cache`, cde2bd8) made new
 * fields REQUIRED on `MuxSettingsView`, both commits updated the copy sitting
 * next to the code they changed and neither touched the two living under
 * `src/__tests__/`. Nothing ran any of them to catch it: there was no CI test
 * job at all until 7a0db7f, six weeks later, and it has never covered these
 * paths. So the two orphans silently rotted, and every test in them began
 * failing with
 * `TypeError: undefined is not an object (evaluating 'settings.cache.cacheable')`
 * at `src/plugins/mcp-multiplexer/index.ts:296` — 14 failures across two files.
 *
 * This is not the first repair. be4688a ("un-break stale mux helpers", 25 May)
 * fixed the same fields in the same files and is NOT an ancestor of main — it
 * was dropped in an upstream-sync graft. a99c527 patched the same fixture in
 * place before that. Three local repairs, two lost or re-rotted.
 *
 * Hence one builder, used by all three consumers: a future required field
 * breaks every call site at once rather than only the ones nobody looks at.
 *
 * Defaults are chosen for unit-test determinism, not to mirror production:
 * timers off, optional subsystems off, so a test opts in to what it exercises.
 *
 * NOTE the deliberate divergence: `sessionPersistenceEnabled` defaults to
 * `false` here, while production defaults it to `true` (see the field docs on
 * `MuxSettingsView`). A test that needs persistence must therefore ask for it.
 * Every current call site does. The trap to avoid: a NEW test that forgets the
 * flag gets persistence silently off, and a negative assertion ("no files
 * written", "no persistence audits") then passes vacuously rather than failing.
 */

import type { MuxSettingsView } from "../../plugins/mcp-multiplexer/index.js";

/**
 * Build a `settingsView` thunk for `McpMultiplexerPlugin`.
 *
 * @param partial - fields to override; everything else takes the test default.
 */
export function makeMuxSettingsView(partial: Partial<MuxSettingsView> = {}): () => MuxSettingsView {
  const view: MuxSettingsView = {
    webEnabled: true,
    webHost: "127.0.0.1",
    webPort: 4632,
    shared: [],
    stateless: [],
    // Health probe off by default so unit tests don't inherit timer
    // flakiness; the probe is exercised directly via `_sampleHealthForTests`.
    healthProbeIntervalMs: 0,
    // Persistence off by default so a test that doesn't care behaves exactly
    // as it did pre-#71; the persistence suites opt in explicitly.
    sessionPersistenceEnabled: false,
    sessionMaxAgeSeconds: 3600,
    sessionPersistencePath: "",
    // #68 — off by default; opt-in tests set true.
    metricsEnabled: false,
    // #69 — off by default; opt-in tests supply a `cacheable` map.
    cache: {
      enabled: false,
      ttlMs: 5_000,
      maxEntries: 1_000,
      cacheable: {},
      defensiveInvalidation: true,
    },
    ...partial,
  };
  return () => view;
}
