/**
 * capability-gap — detect a capability the operator repeatedly NEEDS but does
 * not have, from their own behaviour (session transcripts = trusted internal
 * data; no external source can inject a "need"). Example: many research-intent
 * prompts with no web-search tool available → the operator needs Brave/Perplexity.
 *
 * The detected NEED is anchored in the operator's transcripts; the OFFER comes
 * from the approved technique-plugin-registry (`lookupCapability`). A gap becomes
 * a human-gated, reversible plugin install (mcp-plugin-subject) — never auto-run.
 *
 * Deliberately deterministic + heuristic (regex intent/tool matching). It is a
 * signal ("you asked N research questions with no search tool"), not a proof;
 * the number carries the argument, the human decides. Never throws.
 */
import { existsSync, readdirSync, readFileSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Bound transcript-tree recursion + per-file read so a hostile/huge tree can't DoS the scan. */
const MAX_WALK_DEPTH = 12;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/** Prompts longer than this are treated as system/tool/harness text, not a natural operator ask. */
const MAX_PROMPT_CHARS = 400;

export interface CapabilitySpec {
  /** Capability tag; matches `PluginEntry.capability` in the registry. */
  capability: string;
  /** User-prompt patterns signalling the need. */
  intent: RegExp[];
  /** Tool-name patterns that would already satisfy the need (→ no gap). */
  tools: RegExp[];
}

export interface CapabilityGap {
  capability: string;
  /** Intent prompts that occurred in sessions with NO satisfying tool. */
  unmetIntentCount: number;
  sessionsScanned: number;
  sessionsWithGap: number;
  /** A few example prompts (truncated) for the proposal / app display. */
  examples: string[];
}

/** Built-in specs. web_search is the canonical first gap (Brave / Perplexity). */
export const DEFAULT_CAPABILITY_SPECS: CapabilitySpec[] = [
  {
    capability: "web_search",
    intent: [
      /\b(latest|newest|current|most recent)\b.{0,24}\b(version|release|news|price|rate|score)\b/i,
      /\bsearch (the web|online|for it|for the)\b/i,
      /\blook (it|this|that) up\b/i,
      /\bwhat'?s the (latest|current|newest)\b/i,
      /\bgoogle (it|this|that)\b/i,
      /\bweb ?search\b/i,
      /\bfind (out )?(online|on the web|the latest)\b/i,
      /\bc'?est quoi (la |le )?(derni[eè]re|nouvelle|dernier)\b/i,
      /\b(cherche|recherche)\b.{0,30}\b(web|internet|en ligne|google)\b/i,
    ],
    tools: [
      /brave|perplexity|tavily|serper|\bexa\b|web_?search|websearch|web_?fetch|google_?search/i,
    ],
  },
];

/**
 * Negation / meta-discussion guard: a prompt that mentions searching only to
 * decline it ("I'll look it up myself", "no need to search", "the web search
 * tool is broken") is NOT an unmet need. A prompt matching this is excluded even
 * if it matches an intent pattern — cuts the biggest false-positive class.
 */
const INTENT_NEGATION =
  /\b(don'?t|do not|won'?t|will not|myself|already|no need|not (?:need|going|gonna)|is broken|isn'?t working|pas besoin|moi-?même|d[eé]j[aà])\b/i;

type Ev = {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  content?: unknown;
};
type Block = { type?: string; text?: string; name?: string };

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

function content(ev: Ev): unknown {
  return ev.message?.content ?? ev.content;
}

function isUser(ev: Ev): boolean {
  return ev.type === "user" || ev.message?.role === "user" || ev.role === "user";
}

function userText(ev: Ev): string | null {
  const c = content(ev);
  const raw =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? (c as Block[])
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join(" ")
        : "";
  // Strip injected scaffolding (hook system-reminders, command wrappers) so only
  // the operator's own words count — and a short ask sharing a turn with a big
  // reminder isn't pushed over MAX_PROMPT_CHARS and dropped.
  const clean = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ")
    .replace(/<command-[a-z-]*>[\s\S]*?<\/command-[a-z-]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 0 ? clean : null;
}

function toolNames(ev: Ev): string[] {
  const c = content(ev);
  if (!Array.isArray(c)) return [];
  return (c as Block[])
    .filter((b) => b?.type === "tool_use" && typeof b.name === "string")
    .map((b) => b.name as string);
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > MAX_WALK_DEPTH) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    let isDir = false;
    let isFile = false;
    try {
      // lstat (no symlink follow) → a symlinked dir can't redirect/loop the walk.
      const st = lstatSync(p);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir) walk(p, out, depth + 1);
    else if (isFile && name.endsWith(".jsonl")) out.push(p);
  }
}

/**
 * Scan session transcripts and report, per capability, how many research-intent
 * prompts occurred in sessions that never used a satisfying tool.
 */
export function detectCapabilityGaps(
  opts: {
    transcriptDirs?: string[];
    since?: Date;
    specs?: CapabilitySpec[];
    maxExamples?: number;
    /** Capabilities already provisioned (e.g. an installed MCP server) → never a gap. */
    providedCapabilities?: string[];
  } = {},
): CapabilityGap[] {
  const dirs = (opts.transcriptDirs ?? [join(homedir(), ".claude", "projects")]).map(expandHome);
  const specs = opts.specs ?? DEFAULT_CAPABILITY_SPECS;
  const sinceMs = opts.since ? opts.since.getTime() : 0;
  const maxEx = opts.maxExamples ?? 5;
  const provided = new Set(opts.providedCapabilities ?? []);

  const acc = new Map<
    string,
    { unmet: number; sessions: number; gap: number; examples: string[] }
  >();
  for (const s of specs) acc.set(s.capability, { unmet: 0, sessions: 0, gap: 0, examples: [] });

  const files: string[] = [];
  for (const d of dirs) if (existsSync(d)) walk(d, files);

  for (const f of files) {
    let lines: string[];
    try {
      const st = statSync(f);
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      if (st.size > MAX_TRANSCRIPT_BYTES) continue; // skip pathologically huge files
      lines = readFileSync(f, "utf8").split("\n");
    } catch {
      continue;
    }
    const prompts: string[] = [];
    const tools: string[] = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let ev: Ev;
      try {
        ev = JSON.parse(ln) as Ev;
      } catch {
        continue;
      }
      if (isUser(ev)) {
        const t = userText(ev);
        // Natural asks are short; skip giant system/tool/harness-injected prompts
        // (they aren't the operator expressing a need and skew the signal).
        if (t && t.length <= MAX_PROMPT_CHARS) prompts.push(t);
      }
      tools.push(...toolNames(ev));
    }
    if (prompts.length === 0) continue;
    for (const s of specs) {
      if (provided.has(s.capability)) continue; // capability already provisioned → no gap
      const a = acc.get(s.capability);
      if (!a) continue;
      a.sessions++;
      if (tools.some((n) => s.tools.some((re) => re.test(n)))) continue;
      const hits = prompts.filter(
        (p) => !INTENT_NEGATION.test(p) && s.intent.some((re) => re.test(p)),
      );
      if (hits.length > 0) {
        a.unmet += hits.length;
        a.gap++;
        for (const h of hits) if (a.examples.length < maxEx) a.examples.push(h.slice(0, 120));
      }
    }
  }

  return specs.map((s) => {
    const a = acc.get(s.capability) ?? { unmet: 0, sessions: 0, gap: 0, examples: [] };
    return {
      capability: s.capability,
      unmetIntentCount: a.unmet,
      sessionsScanned: a.sessions,
      sessionsWithGap: a.gap,
      examples: a.examples,
    };
  });
}
