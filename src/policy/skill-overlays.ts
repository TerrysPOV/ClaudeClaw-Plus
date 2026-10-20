/**
 * Skill Policy Overlays
 *
 * Allow skills to declare tool constraints that integrate with the policy engine.
 * Skill overlays are translated into policy-relevant constraints.
 *
 * IMPORTANT: Skill overlays must not become a privilege-escalation path.
 * Skills are increasingly third-party and the registries are large, so an
 * overlay that could widen access would be an escalation primitive: a skill
 * granting itself what the user's policy denied (#258).
 *
 * **An overlay is a ceiling filter applied BEFORE evaluation, not a set of
 * rules merged into the priority ladder.** It narrows the tool set the engine
 * is allowed to consider; the engine then evaluates that narrowed set with its
 * documented semantics unchanged — priority wins, deny first within a tier,
 * allow-exceptions keep working. Two mechanisms, no conflict:
 *
 * - "deniedTools" → the ceiling. A denied tool never reaches the ladder, so no
 *   rule of any priority can re-allow it for that skill. It can only remove.
 * - "requiredTools" surfaces actionable errors when a tool is unavailable; it
 *   never grants anything (an explicit user deny stays absolute).
 * - "preferredTools" influences recommendation, not security.
 */

import type { PolicyRule, ToolRequestContext } from "./engine";
import { resolveSkillPrompt } from "../skills";

// ============================================================================
// Types
// ============================================================================

export interface SkillOverlay {
  skillName: string;
  requiredTools?: string[];
  preferredTools?: string[];
  deniedTools?: string[];
  reason?: string;
}

export interface SkillPolicyResult {
  allowed: boolean;
  reason: string;
  skillOverlay?: SkillOverlay;
  missingTools?: string[];
  deniedTools?: string[];
}

// ============================================================================
// Skill Metadata Parsing
// ============================================================================

/**
 * Parse skill metadata from SKILL.md content.
 * Looks for policy-related frontmatter fields.
 */
export function parseSkillMetadata(skillContent: string, skillName: string): SkillOverlay | null {
  // Parse YAML frontmatter
  const fmMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return null;
  }

  const fm = fmMatch[1];

  // Look for policy-related fields
  let requiredTools: string[] | undefined;
  let preferredTools: string[] | undefined;
  let deniedTools: string[] | undefined;

  // A deny that silently matches nothing is the worst kind of deny, and two
  // ordinary YAML shapes produced one: a quoted entry (`- "Bash"`) parsed with
  // its quotes, and a trailing comment (`- Bash # why`) parsed into the value.
  // Tool names carry neither, so both are stripped (comment first — the `#` of
  // a comment is never inside the quoted scalar we keep).
  const stripQuotes = (v: string): string =>
    v
      .replace(/\s+#.*$/, "")
      .replace(/^["']|["']$/g, "")
      .trim();

  // Helper to parse array fields (handles both multiline and inline formats)
  function parseArrayField(fieldName: string): string[] | undefined {
    // Match multiline format:
    // requiredTools:
    //   - item1
    //   - item2
    const multilineMatch = fm.match(new RegExp(`^${fieldName}:\\s*\\n((?:\\s*-\\s*.+\\n?)+)`, "m"));
    if (multilineMatch) {
      return multilineMatch[1]
        .split("\n")
        .map((line) => stripQuotes(line.replace(/^\s*-\s*/, "").trim()))
        .filter(Boolean);
    }

    // Match inline empty array: requiredTools: []
    const emptyMatch = fm.match(new RegExp(`^${fieldName}:\\s*\\[\\s*\\]`, "m"));
    if (emptyMatch) {
      return [];
    }

    // Match inline array: requiredTools: [item1, item2]
    const inlineMatch = fm.match(new RegExp(`^${fieldName}:\\s*\\[([^\\]]+)\\]`, "m"));
    if (inlineMatch) {
      return inlineMatch[1]
        .split(",")
        .map((item) => stripQuotes(item.trim()))
        .filter(Boolean);
    }

    return undefined;
  }

  // Parse requiredTools
  const parsedRequired = parseArrayField("requiredTools");
  if (parsedRequired !== undefined) {
    requiredTools = parsedRequired;
  }

  // Parse preferredTools
  const parsedPreferred = parseArrayField("preferredTools");
  if (parsedPreferred !== undefined) {
    preferredTools = parsedPreferred;
  }

  // Parse deniedTools
  const parsedDenied = parseArrayField("deniedTools");
  if (parsedDenied !== undefined) {
    deniedTools = parsedDenied;
  }

  // If no policy fields found, return null
  if (!requiredTools && !preferredTools && !deniedTools) {
    return null;
  }

  return {
    skillName,
    requiredTools,
    preferredTools,
    deniedTools,
  };
}

// ============================================================================
// Skill Overlay Resolution
// ============================================================================

/**
 * Get the skill overlay for a given skill name.
 * Loads and parses the skill's SKILL.md to extract policy metadata.
 */
export async function getSkillOverlay(skillName: string): Promise<SkillOverlay | null> {
  // Resolve skill prompt (reads SKILL.md)
  const content = await resolveSkillPrompt(skillName);
  if (!content) {
    return null;
  }

  return parseSkillMetadata(content, skillName);
}

/**
 * Get skill overlay synchronously from cached content.
 */
export function getSkillOverlayFromContent(
  content: string,
  skillName: string,
): SkillOverlay | null {
  return parseSkillMetadata(content, skillName);
}

// ============================================================================
// Overlay to Rules Conversion
// ============================================================================

/**
 * Convert a skill overlay into policy rules.
 *
 * Rules generated:
 * - deniedTools → high-priority deny rules (restrictive)
 * - requiredTools → no direct rules, tracked for validation
 * - preferredTools → informational only (not security-critical)
 */
/**
 * @deprecated #258: overlay denies are a ceiling applied before evaluation
 * (`skillDeniesTool`), not rules in the priority ladder — as rules they could be
 * outranked by a higher-priority allow, which is the escalation this must not
 * permit. Kept for callers that render an overlay as policy-shaped data; the
 * engine does not consult these.
 */
export function overlayToRules(overlay: SkillOverlay, basePriority: number = 100): PolicyRule[] {
  const rules: PolicyRule[] = [];

  // Denied tools become deny rules (high priority)
  if (overlay.deniedTools && overlay.deniedTools.length > 0) {
    for (const tool of overlay.deniedTools) {
      rules.push({
        id: `skill-${overlay.skillName}-deny-${tool}`,
        // Above typical rules so an overlay deny outranks a broad allow — but
        // NOT absolute: an equal/higher-priority allow still wins (see sortRules).
        priority: basePriority + 50,
        scope: {
          skillName: overlay.skillName,
        },
        tool,
        action: "deny",
        reason: overlay.reason || `Tool ${tool} denied by skill ${overlay.skillName} policy`,
      });
    }
  }

  return rules;
}

// ============================================================================
// Sync Overlay Rules Cache (#258 item 2)
// ============================================================================

/**
 * Skill overlays live in SKILL.md files (async to read). The policy engine's
 * getApplicableRules is synchronous, so overlay-derived deny rules are cached
 * here keyed by skillName. The cache is populated when a surface resolves a
 * slash command to a skill (the SKILL.md content is already in hand at that
 * point), then read synchronously during evaluation.
 *
 * Lifecycle (#284 LOW): a long-running daemon must not hold overlay rules
 * forever. Each entry carries `cachedAt`; entries older than OVERLAY_CACHE_TTL_MS
 * expire (forcing re-population on the next slash-command resolve, which is
 * where fresh SKILL.md content is available, so an edited SKILL.md is not served
 * stale indefinitely), and the cache is bounded to OVERLAY_CACHE_MAX entries
 * (oldest evicted first) so it can't grow unbounded.
 */
interface CachedOverlay {
  /** The tools this skill refuses — the ceiling the engine applies (#258). */
  deniedTools: string[];
  /** The skill's own reason, shown when the ceiling refuses a tool. */
  reason?: string;
  cachedAt: number;
}
const overlayRulesCache = new Map<string, CachedOverlay>();
const OVERLAY_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OVERLAY_CACHE_MAX = 256;

/** Drop expired entries and bound the cache to OVERLAY_CACHE_MAX (oldest first). */
function pruneOverlayCache(now: number): void {
  for (const [name, entry] of overlayRulesCache) {
    if (now - entry.cachedAt > OVERLAY_CACHE_TTL_MS) overlayRulesCache.delete(name);
  }
  // Map preserves insertion order, so the first key is the oldest.
  while (overlayRulesCache.size > OVERLAY_CACHE_MAX) {
    const oldest = overlayRulesCache.keys().next().value;
    if (oldest === undefined) break;
    overlayRulesCache.delete(oldest);
  }
}

/**
 * Parse a skill's overlay from its (already-loaded) SKILL.md content and cache
 * the derived deny rules under skillName. Overlay-less skills cache an empty
 * array so repeat lookups stay sync and allocation-free.
 */
export function cacheSkillOverlayFromContent(skillName: string, content: string): void {
  const overlay = parseSkillMetadata(content, skillName);
  const now = Date.now();
  // Delete-then-set so a refreshed entry moves to the most-recent insertion
  // slot, keeping the size-based eviction order meaningful.
  overlayRulesCache.delete(skillName);
  overlayRulesCache.set(skillName, {
    deniedTools: overlay?.deniedTools ?? [],
    ...(overlay?.reason ? { reason: overlay.reason } : {}),
    cachedAt: now,
  });
  pruneOverlayCache(now);
}

/**
 * The cached overlay rendered as policy-shaped rules (empty if none/expired).
 * The engine does NOT consult these — it applies `skillDeniesTool` as a ceiling
 * (#258); this is for surfaces that display an overlay next to real rules.
 * Derived on demand rather than precomputed, so nothing pays for it.
 */
export function getCachedSkillOverlayRules(skillName?: string): PolicyRule[] {
  if (!skillName) return [];
  const entry = overlayRulesCache.get(skillName);
  if (!entry) return [];
  if (Date.now() - entry.cachedAt > OVERLAY_CACHE_TTL_MS) {
    overlayRulesCache.delete(skillName);
    return [];
  }
  if (entry.deniedTools.length === 0) return [];
  return overlayToRules({
    skillName,
    deniedTools: entry.deniedTools,
    ...(entry.reason ? { reason: entry.reason } : {}),
  });
}

/**
 * Whether a non-expired overlay entry is cached for this skill. Lets callers
 * distinguish "skill declared no deny overlay" (cached empty) from "overlay was
 * never resolved in this process / has expired" — the process-local-cache gap
 * the engine surfaces for observability (#284 LOW).
 */
export function hasCachedSkillOverlay(skillName?: string): boolean {
  if (!skillName) return false;
  const entry = overlayRulesCache.get(skillName);
  if (!entry) return false;
  if (Date.now() - entry.cachedAt > OVERLAY_CACHE_TTL_MS) {
    overlayRulesCache.delete(skillName);
    return false;
  }
  return true;
}

/**
 * #258: the ceiling. `null` when this skill lets the request through — because
 * it declared no overlay, or none that names this tool — and a reason when it
 * refuses. The engine calls this BEFORE it evaluates any rule, so a refusal
 * cannot be outranked by an allow of any priority: an overlay only ever
 * removes from the set the engine considers. An overlay that was never
 * resolved in this process caches nothing and is reported by
 * `hasCachedSkillOverlay`, which the engine surfaces once per skill.
 */
export function skillDeniesTool(
  skillName: string | undefined,
  toolName: string,
): { id: string; reason: string } | null {
  if (!skillName) return null;
  const entry = overlayRulesCache.get(skillName);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > OVERLAY_CACHE_TTL_MS) {
    overlayRulesCache.delete(skillName);
    return null;
  }
  // `*` denies every tool for this skill — the most restrictive thing a SKILL.md
  // can say ("I am read-only, deny me everything"), and the shape the old rule
  // form honoured through the engine's `matchesTool`. An exact-match-only
  // ceiling would have turned it into a silent no-op (adversarial pass).
  const denied = entry.deniedTools.includes("*") || entry.deniedTools.includes(toolName);
  if (!denied) return null;
  return {
    // Reads as what it is — a ceiling, not a rule in the ladder.
    id: `skill-overlay-ceiling:${skillName}:${toolName}`,
    reason:
      entry.reason ??
      `Tool ${toolName} is denied by skill ${skillName} (skill overlay; skills can only narrow)`,
  };
}

/** Clear the overlay rules cache (tests / skill reload). */
export function clearSkillOverlayRulesCache(): void {
  overlayRulesCache.clear();
}

// ============================================================================
// Skill Policy Evaluation
// ============================================================================

/**
 * Evaluate a tool request in the context of skill policy.
 * Checks if the requested tool is allowed given the skill's policy overlay.
 *
 * @deprecated #258: `allowed: true` here means "this skill's overlay does not
 * refuse it", NOT "permitted" — the user policy still decides, and an explicit
 * user deny is absolute. Do not treat this as a grant; the engine's `evaluate`
 * is the only thing that decides. No production caller consults it.
 */
export function evaluateSkillPolicy(overlay: SkillOverlay, toolName: string): SkillPolicyResult {
  // Check if tool is explicitly denied
  if (overlay.deniedTools && overlay.deniedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool ${toolName} is explicitly denied by skill ${overlay.skillName}`,
      skillOverlay: overlay,
      deniedTools: [toolName],
    };
  }

  // Check if required tools are missing (but not for the requested tool)
  if (overlay.requiredTools) {
    const missingTools = overlay.requiredTools.filter((t) => t !== toolName);
    if (missingTools.length > 0) {
      // Tool requested is not missing, but some required tools might be
      // This is informational - not a blocking error
    }
  }

  // If we get here, the tool is allowed by the skill overlay
  return {
    allowed: true,
    reason: `Tool ${toolName} is allowed by skill ${overlay.skillName} policy`,
    skillOverlay: overlay,
  };
}

/**
 * Validate that all required tools for a skill are available.
 * Returns information about missing required tools.
 */
export function validateRequiredTools(
  overlay: SkillOverlay,
  availableTools: string[],
): { valid: boolean; missingTools: string[] } {
  if (!overlay.requiredTools || overlay.requiredTools.length === 0) {
    return { valid: true, missingTools: [] };
  }

  const missingTools = overlay.requiredTools.filter(
    (required) => !availableTools.includes(required),
  );

  return {
    valid: missingTools.length === 0,
    missingTools,
  };
}

// ============================================================================
// Example Skill Overlays
// ============================================================================

/**
 * Get example skill overlay configurations for documentation.
 */
export function getExampleSkillOverlays(): Record<string, SkillOverlay> {
  return {
    "code-review": {
      skillName: "code-review",
      requiredTools: ["View", "GlobTool", "GrepTool"],
      preferredTools: ["View", "GlobTool", "GrepTool"],
      deniedTools: ["Bash", "Edit", "Write"],
      reason: "Code review skill is read-only by default",
    },
    "web-scrape": {
      skillName: "web-scrape",
      requiredTools: ["WebFetch", "Bash"],
      preferredTools: ["WebFetch"],
      deniedTools: [],
      reason: "Web scraping requires network access and shell",
    },
    admin: {
      skillName: "admin",
      requiredTools: ["Bash", "Write", "Edit", "View"],
      preferredTools: ["Bash", "Write", "Edit", "View"],
      deniedTools: [],
      reason: "Admin skill has full tool access",
    },
  };
}
