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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const t = (c as Block[])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join(" ");
    return t.length > 0 ? t : null;
  }
  return null;
}

function toolNames(ev: Ev): string[] {
  const c = content(ev);
  if (!Array.isArray(c)) return [];
  return (c as Block[])
    .filter((b) => b?.type === "tool_use" && typeof b.name === "string")
    .map((b) => b.name as string);
}

function walk(dir: string, out: string[]): void {
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
      const st = statSync(p);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir) walk(p, out);
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
  } = {},
): CapabilityGap[] {
  const dirs = (opts.transcriptDirs ?? [join(homedir(), ".claude", "projects")]).map(expandHome);
  const specs = opts.specs ?? DEFAULT_CAPABILITY_SPECS;
  const sinceMs = opts.since ? opts.since.getTime() : 0;
  const maxEx = opts.maxExamples ?? 5;

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
      if (sinceMs && statSync(f).mtimeMs < sinceMs) continue;
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
      const a = acc.get(s.capability);
      if (!a) continue;
      a.sessions++;
      if (tools.some((n) => s.tools.some((re) => re.test(n)))) continue;
      const hits = prompts.filter((p) => s.intent.some((re) => re.test(p)));
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
