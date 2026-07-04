import {
  existsSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { BaseSubject } from "../../skills-tuner/subjects/base.js";
import { sanitizeObservationContent } from "../../skills-tuner/core/security.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../skills-tuner/core/types.js";
import type { RevertibleSubject } from "../wisecron/types.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { ARTIFACT_SOURCE } from "../../skills-tuner/core/telemetry.js";
import { nonzeroRate } from "../../skills-tuner/core/aggregate.js";
import { detectCapabilityGaps, type CapabilityGap } from "../wisecron/capability-gap.js";
import {
  lookupCapability,
  matchRegistryEntry,
  allRegistryEntries,
} from "../wisecron/technique-plugin-registry.js";

const BROKEN_MIN_CALLS = 100;
const BROKEN_SUCCESS_RATE = 0.5;
const DEAD_WINDOW_DAYS = 90;
const TRUST_BLOCKED_THRESHOLD = 0.7;
/** Minimum unmet-intent count before a capability gap is worth a proposal. */
const CAPABILITY_GAP_MIN = 3;

/** Install subprocess wall-clock cap. */
const INSTALL_TIMEOUT_MS = 120_000;
/** Cap captured install output so a chatty installer cannot blow memory. */
const INSTALL_MAX_BUFFER = 8 * 1024 * 1024;
/** The `op` discriminator that marks an alternative as a NEW-plugin install. */
const INSTALL_OP = "install-plugin";

/**
 * A structured, gated plugin-install request. Carried verbatim as the
 * alternative's `diff_or_content` (JSON). The proactive cycle builds it from a
 * technique→plugin registry entry; `apply()` performs the confined install then
 * writes `settingsAfter`. This is the ONLY way an architectural capability
 * enters the system — as an installed plugin, never as engine code.
 */
export interface PluginInstallSpec {
  op: typeof INSTALL_OP;
  /** mcpServers key + managed install-dir name. */
  pluginId: string;
  manager: "npm" | "git";
  /** npm package spec or https git clone URL. */
  source: string;
  /** The MCP server entry to register under settings.mcpServers[pluginId]. */
  server: { command: string; args: string[] };
}

/** One row of the managed install manifest (what the tuner installed). */
interface ManifestEntry {
  pluginId: string;
  installDir: string;
  manager: "npm" | "git";
  source: string;
  installedAt: string;
}

/** Injectable installer (real = spawnSync). Returns ok + captured output. */
export type PluginInstaller = (spec: {
  manager: "npm" | "git";
  source: string;
  destDir: string;
}) => { ok: boolean; output: string };

interface ToolStats {
  server: string;
  tool: string;
  calls: number;
  successes: number;
  blocked: number;
  lastCallAt: Date | null;
  trustScore: number;
}

/**
 * McpPluginSubject — wisecron-managed MCP plugin allowedTools tuner (MEDIUM).
 */
export interface McpPluginSubjectConfig {
  llm?: LLMClient;
  /** Operations audit log. Default: ~/.claudeclaw/journal/operations.jsonl. */
  auditLog?: string;
  /** Optional MCP settings path (target_path for proposals). */
  settingsPath?: string;
  /** Injected event reader for tests. */
  auditReader?: (path: string, since: Date) => Array<Record<string, unknown>>;
  /** Confined dir where the tuner installs plugins. Default: ~/.config/tuner/plugins. */
  managedPluginsDir?: string;
  /** Injected installer for tests (default = real spawnSync git/npm). */
  installer?: PluginInstaller;
  /** Session-transcript dirs mined for capability gaps. Default: ~/.claude/projects. */
  transcriptDirs?: string[];
  /** Min unmet-intent count before a capability gap becomes an observation. */
  capabilityGapMin?: number;
  /** Operator approved-list path for capability offers. Default registry path. */
  registryPath?: string;
  /** Injected capability-gap detector for tests. */
  gapDetector?: (opts: { transcriptDirs?: string[]; since?: Date }) => CapabilityGap[];
}

export class McpPluginSubject extends BaseSubject implements RevertibleSubject {
  readonly name = "mcp_plugin";
  readonly risk_tier = "medium" as const;
  readonly auto_merge_default = false;
  // Supports creating a NEW capability — but ONLY as a confined plugin install,
  // never as engine code (the hard boundary).
  readonly supports_creation = true;

  private readonly llm?: LLMClient;
  private readonly auditLog: string;
  private readonly settingsPath: string;
  private readonly auditReader: (path: string, since: Date) => Array<Record<string, unknown>>;
  private readonly managedPluginsDir: string;
  private readonly manifestPath: string;
  private readonly installer: PluginInstaller;
  private readonly transcriptDirs?: string[];
  private readonly capabilityGapMin: number;
  private readonly registryPath?: string;
  private readonly gapDetector: (opts: {
    transcriptDirs?: string[];
    since?: Date;
    providedCapabilities?: string[];
  }) => CapabilityGap[];

  constructor(opts: McpPluginSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.transcriptDirs = opts.transcriptDirs;
    this.capabilityGapMin = opts.capabilityGapMin ?? CAPABILITY_GAP_MIN;
    this.registryPath = opts.registryPath;
    this.gapDetector = opts.gapDetector ?? detectCapabilityGaps;
    this.auditLog = expandHome(
      opts.auditLog ?? join(homedir(), ".claudeclaw", "journal", "operations.jsonl"),
    );
    this.settingsPath = expandHome(
      opts.settingsPath ?? join(homedir(), ".claude", "settings.json"),
    );
    this.auditReader = opts.auditReader ?? defaultAuditReader;
    this.managedPluginsDir = expandHome(
      opts.managedPluginsDir ?? join(homedir(), ".config", "tuner", "plugins"),
    );
    this.manifestPath = join(this.managedPluginsDir, "installed.json");
    this.installer = opts.installer ?? defaultInstaller;
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const events = this.auditReader(this.auditLog, since);
    // NOTE: do NOT early-return on empty events — a capability GAP is precisely
    // the absence of a tool, so it must be detected even with no MCP activity.

    const stats = new Map<string, ToolStats>();
    for (const ev of events) {
      if (ev.type !== "mcp_tool_call") continue;
      const server = String(ev.server ?? "unknown");
      const tool = String(ev.tool ?? "unknown");
      const key = `${server}::${tool}`;
      let s = stats.get(key);
      if (!s) {
        s = {
          server,
          tool,
          calls: 0,
          successes: 0,
          blocked: 0,
          lastCallAt: null,
          trustScore: Number(ev.trust_score ?? 0),
        };
        stats.set(key, s);
      }
      s.calls += 1;
      if (ev.success === true || ev.ok === true) s.successes += 1;
      if (ev.blocked === true) s.blocked += 1;
      const ts = ev.ts;
      const tsDate = typeof ts === "string" || typeof ts === "number" ? new Date(ts) : null;
      if (tsDate && (!s.lastCallAt || tsDate > s.lastCallAt)) s.lastCallAt = tsDate;
      if (typeof ev.trust_score === "number") s.trustScore = ev.trust_score as number;
    }

    const now = new Date();
    const observations: Observation[] = [];
    for (const s of stats.values()) {
      const successRate = s.calls === 0 ? 1 : s.successes / s.calls;
      const ageDays = s.lastCallAt
        ? (now.getTime() - s.lastCallAt.getTime()) / 86_400_000
        : Infinity;

      observations.push({
        session_id: `mcp-${s.server}-${s.tool}-${now.getTime()}`,
        observed_at: now,
        signal_type:
          s.calls >= BROKEN_MIN_CALLS && successRate < BROKEN_SUCCESS_RATE
            ? "correction"
            : s.blocked > 0 && s.trustScore > TRUST_BLOCKED_THRESHOLD
              ? "repeated_trigger"
              : "orphan",
        verbatim: sanitizeObservationContent(
          JSON.stringify({
            server: s.server,
            tool: s.tool,
            calls: s.calls,
            success_rate: Math.round(successRate * 100) / 100,
            blocked: s.blocked,
            trust_score: s.trustScore,
            age_days: Number.isFinite(ageDays) ? Math.round(ageDays) : null,
          }),
          500,
        ),
        metadata: {
          subject: "mcp_plugin",
          server: s.server,
          tool: s.tool,
          calls: s.calls,
          success_rate: successRate,
          blocked: s.blocked,
          trust_score: s.trustScore,
          age_days: Number.isFinite(ageDays) ? ageDays : null,
        },
      });
    }

    // ── Capability-gap face: needs detected from the operator's OWN behaviour ──
    // (session transcripts = trusted internal data; no external source can inject
    // a need). A gap ≥ the min becomes an observation → a governed install offer.
    // Install-aware: suppress a gap whose capability is ALREADY provisioned by an
    // installed mcpServers entry (not just "a tool was used this session").
    const providedCapabilities: string[] = [];
    try {
      if (existsSync(this.settingsPath)) {
        const st = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Record<string, unknown>;
        const servers = Object.keys((st.mcpServers as Record<string, unknown>) ?? {});
        for (const e of allRegistryEntries({ registryPath: this.registryPath })) {
          if (e.capability && servers.includes(e.pluginId)) providedCapabilities.push(e.capability);
        }
      }
    } catch {
      /* ignore malformed settings */
    }
    let gaps: CapabilityGap[] = [];
    try {
      gaps = this.gapDetector({ transcriptDirs: this.transcriptDirs, since, providedCapabilities });
    } catch {
      gaps = [];
    }
    for (const g of gaps) {
      if (g.unmetIntentCount < this.capabilityGapMin) continue;
      observations.push({
        session_id: `mcp-capgap-${g.capability}-${now.getTime()}`,
        observed_at: now,
        signal_type: "repeated_trigger",
        verbatim: sanitizeObservationContent(
          JSON.stringify({
            capability: g.capability,
            unmet: g.unmetIntentCount,
            sessions_with_gap: g.sessionsWithGap,
            examples: g.examples,
          }),
          500,
        ),
        metadata: {
          subject: "mcp_plugin",
          kind: "capability_gap",
          capability: g.capability,
          unmet: g.unmetIntentCount,
          sessions_with_gap: g.sessionsWithGap,
          examples: g.examples,
        },
      });
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];
    const broken: Observation[] = [];
    const dead: Observation[] = [];
    const blockedAllow: Observation[] = [];
    const capGap: Observation[] = [];

    for (const obs of observations) {
      const meta = obs.metadata as Record<string, unknown>;
      if (meta.kind === "capability_gap") {
        capGap.push(obs);
        continue;
      }
      const calls = (meta.calls as number) ?? 0;
      const successRate = (meta.success_rate as number) ?? 1;
      const blocked = (meta.blocked as number) ?? 0;
      const trust = (meta.trust_score as number) ?? 0;
      const ageDays = meta.age_days as number | null;

      if (calls >= BROKEN_MIN_CALLS && successRate < BROKEN_SUCCESS_RATE) broken.push(obs);
      else if (calls === 0 || (ageDays !== null && ageDays > DEAD_WINDOW_DAYS)) dead.push(obs);
      else if (blocked > 0 && trust > TRUST_BLOCKED_THRESHOLD) blockedAllow.push(obs);
    }

    const clusters: Cluster[] = [];
    if (broken.length > 0) clusters.push(makeCluster("mcp-broken", broken, 0.2, "negative"));
    if (dead.length > 0) clusters.push(makeCluster("mcp-dead", dead, 0.0, "neutral"));
    if (blockedAllow.length > 0)
      clusters.push(makeCluster("mcp-blocked-allow", blockedAllow, 0.6, "neutral"));
    // One cluster per distinct missing capability.
    const byCap = new Map<string, Observation[]>();
    for (const o of capGap) {
      const cap = String((o.metadata as Record<string, unknown>).capability ?? "unknown");
      const arr = byCap.get(cap) ?? [];
      arr.push(o);
      byCap.set(cap, arr);
    }
    for (const [cap, obs] of byCap) {
      clusters.push(makeCluster(`mcp-capability-gap:${cap}`, obs, 0.8, "neutral"));
    }
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const firstObs = cluster.observations[0];
    if (!firstObs) throw new Error("mcp-plugin-subject.proposeChange: cluster empty");
    const meta = firstObs.metadata as Record<string, unknown>;
    // ── Capability-gap → offer an APPROVED plugin install (need from the
    //    operator's behaviour, offer from the operator-approved registry). ──
    if (meta.kind === "capability_gap") return this.proposeCapabilityInstall(cluster, meta);
    const server = meta.server as string;
    const tool = meta.tool as string;

    let settings: Record<string, unknown> = { allowedTools: [] };
    if (existsSync(this.settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      } catch {
        /* keep default */
      }
    }

    const allowed = Array.isArray(settings.allowedTools)
      ? [...(settings.allowedTools as string[])]
      : [];
    const removeTool = `mcp__${server}__${tool}`;
    const removed = allowed.filter((t) => t !== removeTool);
    const added = allowed.includes(removeTool) ? allowed : [...allowed, removeTool];
    const disabledServer = {
      ...settings,
      mcpServers: {
        ...((settings.mcpServers as Record<string, unknown>) ?? {}),
        [server]: { disabled: true },
      },
    };

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: "mcp_plugin",
      kind: "patch",
      target_path: this.settingsPath,
      alternatives: [
        {
          id: "remove-tool",
          label: `Remove ${removeTool} from allowedTools`,
          diff_or_content: stableJson({ ...settings, allowedTools: removed }),
          tradeoff: "Stops dead calls; reversible.",
        },
        {
          id: "add-tool",
          label: `Add ${removeTool} to allowedTools`,
          diff_or_content: stableJson({ ...settings, allowedTools: added }),
          tradeoff: "Unblocks high-trust tool; widens surface.",
        },
        {
          id: "disable-server",
          label: `Disable MCP server ${server}`,
          diff_or_content: stableJson(disabledServer),
          tradeoff: "Heavy-handed; cuts all tools from that server.",
        },
      ],
      pattern_signature: `mcp_plugin:${cluster.id}:${server}:${tool}`,
      created_at: new Date(),
    };
  }

  /**
   * Turn a detected capability gap into a governed install proposal. The NEED
   * came from the operator's own transcripts; the OFFER comes from the approved
   * registry (`lookupCapability`). Approved (verified) entries first; if none,
   * seeds are surfaced flagged UNVERIFIED; if the registry has nothing, a
   * detect-only note (nothing is ever written without an approved entry). Each
   * install alternative carries a `PluginInstallSpec` → apply() routes it through
   * the confined, reversible install path.
   */
  private proposeCapabilityInstall(
    cluster: Cluster,
    meta: Record<string, unknown>,
  ): UnsignedProposal {
    const capability = String(meta.capability ?? "unknown");
    const unmet = Number(meta.unmet ?? 0);
    let offers = lookupCapability(capability, { registryPath: this.registryPath });
    if (offers.length === 0) {
      offers = lookupCapability(capability, {
        registryPath: this.registryPath,
        includeUnverified: true,
      });
    }
    const alternatives = offers.map((e) => ({
      id: `install:${e.pluginId}`,
      label: `Install ${e.pluginId} for ${capability}${e.verified ? "" : " (UNVERIFIED — verify at gate)"}`,
      diff_or_content: stableJson({
        op: INSTALL_OP,
        pluginId: e.pluginId,
        manager: e.manager,
        source: e.source,
        server: e.server,
      }),
      tradeoff: `${e.description}${e.note ? ` — ${e.note}` : ""}`,
    }));
    if (alternatives.length === 0) {
      alternatives.push({
        id: "detect-only",
        label: `Capability gap: ${capability} — no approved plugin in the registry`,
        diff_or_content: stableJson({
          note: `${unmet} unmet ${capability} intents. Curate an approved entry in the registry to offer an install.`,
        }),
        tradeoff: "Detect-only: nothing is installed until an approved entry exists.",
      });
    }
    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: "mcp_plugin",
      kind: "patch",
      target_path: this.settingsPath,
      alternatives,
      pattern_signature: `mcp_plugin:capability_gap:${capability}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find((a) => a.id === alternativeId);
    if (!alt) throw new Error(`mcp-plugin-subject.apply: alternative ${alternativeId} not found`);
    // Confinement: the only file this subject may ever write is its managed
    // settings — never engine code or anything outside it.
    this.assertManagedSettings(proposal.target_path);

    const parsed = JSON.parse(alt.diff_or_content);
    // ── NEW-plugin install path (architectural capability as a confined plugin) ──
    if (isInstallSpec(parsed)) {
      return this.applyInstall(parsed, proposal.target_path);
    }

    // ── allowedTools / disable-server path (existing behaviour) ─────────────────
    // Parse + restringify to guarantee stable key order even if alt source skipped it.
    const normalized = stableJson(parsed);
    assertNotSymlink(proposal.target_path);
    if (existsSync(proposal.target_path)) {
      copyFileSync(proposal.target_path, `${proposal.target_path}.bak`);
    }
    writeFileSync(proposal.target_path, normalized, "utf8");
    return {
      target_path: proposal.target_path,
      kind: "patch",
      applied_content: normalized,
    };
  }

  /**
   * Install a NEW plugin (confined + reversible), then write the settings that
   * register it. Order matters: install FIRST — if it fails we throw before
   * touching settings, so a failed install never leaves a dangling mcpServers
   * entry. On success we record a manifest row so revert can uninstall.
   */
  private applyInstall(spec: PluginInstallSpec, settingsTarget: string): Patch {
    // Apply-time approved-list gate: the propose-time `verified` check is not
    // enough — an externally-ingested proposal could carry an off-registry
    // source behind a benign label. Require an EXACT match to a curated entry.
    const registryEntry = matchRegistryEntry(spec, { registryPath: this.registryPath });
    if (!registryEntry) {
      throw new Error(
        `mcp-plugin-subject.applyInstall: spec for '${spec.pluginId}' matches no approved registry entry — refusing install`,
      );
    }
    // Belt-and-braces with the human gate: even a spec that matches a registry
    // entry must match a VERIFIED one. Built-in seeds ship `verified: false` by
    // design (they are recommendations the operator must vet at the gate), so an
    // unverified seed can never be installed even if a proposal reaches apply()
    // carrying its exact spec.
    if (!registryEntry.verified) {
      throw new Error(
        `mcp-plugin-subject.applyInstall: spec for '${spec.pluginId}' matches only an UNVERIFIED registry entry — refusing install`,
      );
    }
    const destDir = this.pluginDir(spec.pluginId);
    this.assertInsidePlugins(destDir);

    // Compute the post-install settings: current settings + the new server entry.
    // The subject OWNS the settings shape; the proposer only supplies the server.
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsTarget)) {
      try {
        settings = JSON.parse(readFileSync(settingsTarget, "utf8"));
      } catch {
        settings = {};
      }
    }
    const normalizedSettings = stableJson({
      ...settings,
      mcpServers: {
        ...((settings.mcpServers as Record<string, unknown>) ?? {}),
        [spec.pluginId]: { command: spec.server.command, args: spec.server.args },
      },
    });

    // Clean any stale dir from a previous failed attempt, then install.
    // Symlink guard BEFORE any fs mutation: a planted symlink at the managed
    // plugins dir or at the specific install dir would make rmSync/mkdir/clone
    // follow it OUT of the managed surface. assertInsidePlugins(destDir) above
    // already realpath-resolves the whole chain; these lstat checks are the
    // direct belt-and-braces the settings-file path uses.
    assertNotSymlink(this.managedPluginsDir);
    assertNotSymlink(destDir);
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    const res = this.installer({ manager: spec.manager, source: spec.source, destDir });
    if (!res.ok) {
      rmSync(destDir, { recursive: true, force: true });
      throw new Error(
        `mcp-plugin-subject.applyInstall: install failed for ${spec.pluginId}: ${res.output.slice(0, 300)}`,
      );
    }

    // Register the server in settings (.bak first), then record the manifest.
    assertNotSymlink(settingsTarget);
    if (existsSync(settingsTarget)) copyFileSync(settingsTarget, `${settingsTarget}.bak`);
    writeFileSync(settingsTarget, normalizedSettings, "utf8");
    this.recordInstall({
      pluginId: spec.pluginId,
      installDir: destDir,
      manager: spec.manager,
      source: spec.source,
      installedAt: new Date().toISOString(),
    });

    return {
      target_path: settingsTarget,
      kind: "plugin_install",
      applied_content: normalizedSettings,
    };
  }

  /**
   * Pre-apply snapshot the pipeline persists as the inverse patch: the CURRENT
   * settings content. On revert we write this back AND reconcile the install
   * manifest (any tuner-installed plugin no longer present in the restored
   * settings is uninstalled) — so an install fully rolls back.
   */
  async snapshotInverse(target: string): Promise<string> {
    this.assertManagedSettings(target);
    return existsSync(target) ? readFileSync(target, "utf8") : "{}";
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(patch.applied_content);
    } catch (e) {
      return { valid: false, reason: `not valid JSON: ${(e as Error).message}` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { valid: false, reason: "JSON must be an object" };
    }
    const obj = parsed as Record<string, unknown>;
    if ("allowedTools" in obj) {
      if (!Array.isArray(obj.allowedTools)) {
        return { valid: false, reason: "allowedTools must be an array" };
      }
      if (!(obj.allowedTools as unknown[]).every((t) => typeof t === "string")) {
        return { valid: false, reason: "allowedTools must contain only strings" };
      }
    }
    return { valid: true };
  }

  /**
   * Observation-window health probe (MEDIUM risk). Runs AFTER apply: re-reads
   * the just-applied settings file and re-runs validate() — the allowlist /
   * config must still be valid JSON and `allowedTools` (if present) a string[].
   * Failed on malformed JSON or a schema regression. Artifact-based +
   * deterministic. A file gone from disk is not a break.
   */
  async healthProbe(target: string): Promise<{ failed: boolean; errors: string[] }> {
    if (!existsSync(target)) return { failed: false, errors: [] };
    let content: string;
    try {
      content = readFileSync(target, "utf8");
    } catch (e) {
      return {
        failed: true,
        errors: [`unreadable settings: ${(e as Error).message.slice(0, 120)}`],
      };
    }
    const validation = await this.validate({
      target_path: target,
      kind: "patch",
      applied_content: content,
    });
    return validation.valid
      ? { failed: false, errors: [] }
      : { failed: true, errors: [validation.reason ?? "validation failed"] };
  }

  async revert(inversePatch: Patch): Promise<void> {
    this.assertManagedSettings(inversePatch.target_path);
    // Roundtrip parse to keep formatting stable + reject malformed inputs early.
    const restored = JSON.parse(inversePatch.applied_content) as Record<string, unknown>;
    assertNotSymlink(inversePatch.target_path);
    writeFileSync(inversePatch.target_path, inversePatch.applied_content, "utf8");
    // Reconcile installs: uninstall any tuner-installed plugin that the restored
    // settings no longer reference (so reverting an install also removes it).
    this.reconcileManifest(restored);
  }

  // ── Install confinement + manifest (the reversibility spine) ─────────────────

  private pluginDir(pluginId: string): string {
    return join(this.managedPluginsDir, sanitizePluginId(pluginId));
  }

  /** The only writable file: the managed settings. Anything else → throw. */
  private assertManagedSettings(target: string): void {
    if (resolve(target) !== resolve(this.settingsPath)) {
      throw new Error(`target_path is not the managed settings file: ${target}`);
    }
  }

  /**
   * Installs may only ever land inside the managed plugins dir — enforced on TWO
   * axes so neither a `..` nor a symlink can escape:
   *   1. Lexical: `resolve()` (no fs touch) rejects `..` traversal.
   *   2. Symlink: resolve symlinks on the existing part of the chain and require
   *      the REAL target to stay under a root canonicalised the same way. The
   *      target (e.g. `<managed>/<plugin>`) does not exist yet, so we realpath the
   *      nearest EXISTING ancestor and re-append the not-yet-created suffix —
   *      catching a planted symlink AT the managed dir or any component of the
   *      install path, while tolerating benign symlinks ABOVE it (e.g. /tmp).
   */
  private assertInsidePlugins(target: string): void {
    const lexicalRoot = resolve(this.managedPluginsDir);
    const lexicalTarget = resolve(target);
    // 1. Lexical confinement — a `..` can never point the install outside.
    if (lexicalTarget !== lexicalRoot && !lexicalTarget.startsWith(`${lexicalRoot}/`)) {
      throw new Error(`install path outside managedPluginsDir: ${target}`);
    }
    // 2. Symlink confinement — canonicalise ONLY the ancestry above the managed
    //    dir, then keep the managed dir's own name lexical, so a symlink planted
    //    AT the managed dir (or below) diverges the real target and is refused.
    const canonicalRoot = join(
      realpathNearestExisting(dirname(lexicalRoot)),
      basename(lexicalRoot),
    );
    const realTarget = realpathNearestExisting(lexicalTarget);
    if (realTarget !== canonicalRoot && !realTarget.startsWith(`${canonicalRoot}/`)) {
      throw new Error(`install path escapes managedPluginsDir via symlink: ${target}`);
    }
  }

  private readManifest(): ManifestEntry[] {
    if (!existsSync(this.manifestPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8"));
      return Array.isArray(parsed) ? (parsed as ManifestEntry[]) : [];
    } catch {
      return [];
    }
  }

  private writeManifest(entries: ManifestEntry[]): void {
    // Never mkdir/write the manifest through a symlinked managed dir.
    assertNotSymlink(this.managedPluginsDir);
    this.assertInsidePlugins(this.managedPluginsDir);
    mkdirSync(this.managedPluginsDir, { recursive: true });
    writeFileSync(this.manifestPath, stableJson(entries), "utf8");
  }

  private recordInstall(entry: ManifestEntry): void {
    const entries = this.readManifest().filter((e) => e.pluginId !== entry.pluginId);
    entries.push(entry);
    this.writeManifest(entries);
  }

  /** Uninstall (rm managed dir, confined) every manifest plugin absent from `settings.mcpServers`. */
  private reconcileManifest(settings: Record<string, unknown>): void {
    const servers = (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
    const keep: ManifestEntry[] = [];
    for (const e of this.readManifest()) {
      if (e.pluginId in servers) {
        keep.push(e);
        continue;
      }
      // Orphaned → uninstall, but ONLY inside the managed dir.
      try {
        this.assertInsidePlugins(e.installDir);
        rmSync(e.installDir, { recursive: true, force: true });
      } catch {
        // Confinement violation or fs error → drop the row but never rm outside.
      }
    }
    this.writeManifest(keep);
  }

  async healthCheck(): Promise<{
    producer_found: boolean;
    sample_event_match_rate: number;
    reason?: string;
  }> {
    if (!existsSync(this.auditLog)) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `auditLog does not exist: ${this.auditLog}`,
      };
    }
    const since = new Date(Date.now() - 7 * 86_400_000);
    let events: Array<Record<string, unknown>>;
    try {
      events = this.auditReader(this.auditLog, since);
    } catch (e) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `auditReader failed: ${(e as Error).message.slice(0, 120)}`,
      };
    }
    if (events.length === 0) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `no audit events in last 7d at ${this.auditLog}`,
      };
    }
    const mcpCalls = events.filter((e) => e.type === "mcp_tool_call").length;
    return {
      producer_found: true,
      sample_event_match_rate: mcpCalls / events.length,
      reason:
        mcpCalls === 0
          ? `${events.length} audit events but 0 mcp_tool_call entries — instrumentation missing?`
          : undefined,
    };
  }

  /**
   * OutcomeLoop fitness for the mcp_plugin subject (MEDIUM risk).
   *
   * Target — `mcp_tool_failure_rate` (Tier 1, `tool_call`): fraction of MCP tool
   * calls that failed or were blocked over the window. Lower is better. The
   * gameable shortcut is to empty `allowedTools` (no calls → no failures), so it
   * is guarded by `mcp_allowed_tool_count` (Tier 1b artifact, higher_is_better) —
   * a failure-rate drop achieved by removing tools regresses the guardrail.
   * `mcp_allowed_tool_defect_count` (Tier 1b artifact): always-on scan of the
   * managed settings for duplicate / empty allowlist entries.
   */
  fitnessSignals(): Metric[] {
    return [
      {
        name: "mcp_tool_failure_rate",
        source: "tool_call",
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 7,
        guardrails: ["mcp_allowed_tool_count"],
      },
      {
        name: "mcp_allowed_tool_defect_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 1,
      },
      {
        name: "mcp_allowed_tool_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
    ];
  }

  /**
   * Telemetry read ONLY via `provider.query("tool_call", …)`; failure rate is a
   * rate (outlier-robust by construction), not a sum. The artifact metrics scan
   * the managed settings file directly and are omitted only when that file is
   * absent (an empty/absent `allowedTools` legitimately measures as 0).
   */
  async measureFitness(
    range: DateRange,
    provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};

    // ── Tier 1: tool_call stream (value 1 = failed/blocked, 0 = ok) ─────────
    const samples = await provider.query("tool_call", range);
    if (samples.length > 0) {
      out.mcp_tool_failure_rate = nonzeroRate(samples.map((s) => s.value));
    }

    // ── Tier 1b: artifact scan of allowedTools ──────────────────────────────
    const scan = this.scanAllowedTools();
    if (scan !== null) {
      out.mcp_allowed_tool_count = scan.count;
      out.mcp_allowed_tool_defect_count = scan.defects;
    }

    return out;
  }

  /**
   * Scan the managed settings `allowedTools`. defects = duplicate + empty
   * entries. Returns null when the settings file is absent (metric doesn't
   * measure); an existing file with no `allowedTools` measures as `{0,0}`.
   */
  private scanAllowedTools(): { count: number; defects: number } | null {
    if (!existsSync(this.settingsPath)) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(this.settingsPath, "utf8"));
    } catch {
      return null;
    }
    const allowed = Array.isArray(parsed.allowedTools) ? (parsed.allowedTools as unknown[]) : [];
    const seen = new Set<string>();
    let defects = 0;
    for (const t of allowed) {
      if (typeof t !== "string" || t.trim().length === 0) {
        defects += 1;
        continue;
      }
      if (seen.has(t)) defects += 1;
      else seen.add(t);
    }
    return { count: allowed.length, defects };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isInstallSpec(v: unknown): v is PluginInstallSpec {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const server = o.server as Record<string, unknown> | undefined;
  return (
    o.op === INSTALL_OP &&
    typeof o.pluginId === "string" &&
    (o.manager === "npm" || o.manager === "git") &&
    typeof o.source === "string" &&
    typeof server === "object" &&
    server !== null &&
    typeof server.command === "string" &&
    Array.isArray(server.args) &&
    server.args.every((a) => typeof a === "string")
  );
}

/** Plugin id → safe single dir segment (no traversal, no separators, no dot-runs). */
function sanitizePluginId(id: string): string {
  const safe = id
    .replace(/[^A-Za-z0-9._@-]/g, "_") // drop separators + anything exotic
    .replace(/\.{2,}/g, ".") // collapse dot-runs so no ".." can ever appear
    .replace(/^\.+/, "_"); // never start with a dot
  if (!safe) throw new Error(`unusable pluginId: ${id}`);
  return safe;
}

/**
 * Refuse to write THROUGH a symlink. Lexical path confinement (resolve()) does
 * not resolve symlinks, but copyFile/writeFile follow them — a planted symlink
 * at a managed target could redirect the write to engine code. lstat (no follow)
 * catches it before any write.
 */
function assertNotSymlink(target: string): void {
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`refusing to write through a symlink: ${target}`);
    }
  } catch (e) {
    // ENOENT (target doesn't exist yet) is fine; re-throw our own guard error.
    if (e instanceof Error && e.message.startsWith("refusing to write")) throw e;
  }
}

/**
 * realpath the longest EXISTING prefix of `p`, then re-append the not-yet-created
 * suffix lexically. An install leaf (`<managed>/<plugin>`) doesn't exist yet, so
 * we can't realpath it directly — this canonicalises symlinks on the real part of
 * the chain while keeping the pending components literal. Benign symlinks above
 * the managed dir (e.g. `/tmp` → `/private/tmp`) resolve consistently for both
 * the root and the target, so they don't trip confinement; a symlink planted AT
 * or below the managed dir diverges the target and is caught.
 */
function realpathNearestExisting(p: string): string {
  let existing = resolve(p);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return existing; // reached filesystem root
    suffix.unshift(basename(existing));
    existing = parent;
  }
  const realBase = realpathSync(existing);
  return suffix.length ? join(realBase, ...suffix) : realBase;
}

/** https git URL only — blocks file://, ssh, shell metachars, SSRF-ish hosts. */
export function isSafeGitUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  // Reject ALL IPv6 literals (bracketed `.hostname` contains ':') — the IPv4-only
  // denylist below missed `[::1]`, `[::ffff:127.0.0.1]`, `fe80::/10`, `fc00::/7`,
  // `[::]` (SSRF to loopback/link-local/internal). No git host is an IPv6 literal.
  if (h.includes(":") || h.includes("[")) return false;
  if (h === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

/** npm spec: package name (optionally @scope) + optional @version. No shell metachars/paths. */
export function isSafeNpmSpec(spec: string): boolean {
  // Leading char classes exclude '-' so a spec can never begin with a flag
  // (belt-and-suspenders with the `--` end-of-options separator at the call site).
  return /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*(@[\w.\-^~*x>=<| ]+)?$/i.test(spec);
}

/**
 * Real installer: a confined subprocess with array args (no shell), a wall-clock
 * timeout, a bounded output buffer, and a validated source. git → shallow clone
 * into the dest; npm → install the package under the dest prefix.
 */
function defaultInstaller(spec: { manager: "npm" | "git"; source: string; destDir: string }): {
  ok: boolean;
  output: string;
} {
  const run = (cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) => {
    const r = spawnSync(cmd, args, {
      cwd,
      env,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_MAX_BUFFER,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.error) return { ok: false, output: `${r.error.message}\n${out}` };
    return { ok: r.status === 0, output: out };
  };

  if (spec.manager === "git") {
    if (!isSafeGitUrl(spec.source)) return { ok: false, output: `unsafe git url: ${spec.source}` };
    return run("git", ["clone", "--depth", "1", "--", spec.source, spec.destDir]);
  }
  if (!isSafeNpmSpec(spec.source)) return { ok: false, output: `unsafe npm spec: ${spec.source}` };
  // --ignore-scripts: npm runs package pre/post-install lifecycle scripts by
  // default, which execute arbitrary package-authored code OUTSIDE the managed
  // dir (filesystem confinement doesn't confine execution) — install-time RCE
  // that would break the "tuner never writes engine code" invariant. `--` ends
  // option parsing so a spec can't smuggle a flag. env scrubs npm_config_* too.
  return run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      "--prefix",
      spec.destDir,
      "--",
      spec.source,
    ],
    undefined,
    { ...process.env, npm_config_ignore_scripts: "true" },
  );
}

function makeCluster(
  id: string,
  obs: Observation[],
  successRate: number,
  sentiment: "negative" | "neutral" | "positive",
): Cluster {
  return {
    id,
    subject: "mcp_plugin",
    observations: obs,
    frequency: obs.length,
    success_rate: successRate,
    sentiment,
    subjects_touched: obs.map(
      (o) =>
        `${(o.metadata as Record<string, unknown>).server}::${(o.metadata as Record<string, unknown>).tool}`,
    ),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, sortReplacer, 2);
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

export function defaultAuditReader(path: string, since: Date): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const events: Array<Record<string, unknown>> = [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== "object" || obj === null) continue;
      // A line with no (or an unparseable) timestamp can never age out of the
      // `since` window — it would accumulate on every read and inflate the
      // dead-tool counts. Treat a missing/invalid ts as pre-window and skip it.
      const ts = (obj as Record<string, unknown>).ts;
      if (!ts) continue;
      const tsDate = new Date(ts as string | number);
      if (Number.isNaN(tsDate.getTime()) || tsDate < since) continue;
      events.push(obj as Record<string, unknown>);
    } catch {}
  }
  return events;
}
