# Capability-gap detection → approved plugin install

Status: **Draft design + evidence note** for #275 (companion to `memory-subject-validation.md`). Part of the governed plugin-only boundary (#290): the tuner detects a capability the operator repeatedly **needs but doesn't have**, and offers to install it — only ever as a **human-gated, reversible plugin install** from an **operator-approved list**.

Canonical example: the operator keeps asking research questions with no web-search tool → *"you asked N research questions with no search tool — install Brave Search (or Perplexity)."*

---

## 1. The core safety property: NEED is internal, OFFER is approved

The whole design turns on separating two things:

- **NEED** — what the operator lacks — is derived **only from their own behaviour** (session transcripts = trusted internal data). **No external source can inject a need.** A poisoned web page or marketplace entry can never make the tuner claim you need something.
- **OFFER** — what to install — comes from the **approved technique-plugin registry** (`lookupCapability`), a curated allow-list the operator controls. The tuner recommends a *vetted* capability, never arbitrary code.

So the blast radius of any external manipulation is zero for the *need*, and bounded to the *approved list* for the *offer*.

---

## 2. Detection method + the metric

`detectCapabilityGaps()` scans session transcripts and reports, per capability:

| field | meaning |
|---|---|
| `unmetIntentCount` | intent prompts that occurred in sessions where **no satisfying tool** was ever used |
| `sessionsScanned` / `sessionsWithGap` | denominator / how many sessions showed the gap |
| `examples` | a few example prompts (for the proposal + app display) |

A capability is a `CapabilitySpec { capability, intent: RegExp[], tools: RegExp[] }`. `web_search` ships built-in (research-intent patterns in EN + FR; satisfying tools = brave/perplexity/tavily/web_search/web_fetch/…). The detector is **deterministic + heuristic** — a *signal* ("you asked N research questions with no search tool"), not a proof. **The number carries the argument; the human decides.** It never throws (malformed lines / missing dirs are skipped), and ignores oversized system/harness prompts (`MAX_PROMPT_CHARS`) so only natural asks count.

**The success metric (rail-#1 style, outcome-defined):** after an approved install, the same intent should start routing **through the new tool** — measure *adoption* (the tool gets used for those asks) and the unmet count drops. If the installed capability is never used, the OutcomeLoop flags it for removal. Never "N proposals generated."

---

## 3. Evidence (honest before/after)

Run on this operator's real transcripts (159 sessions):

- **web_search gap = 0.** Correctly finds **no** gap — this operator already has Brave + a web-research tool, so the tuner **does not** recommend what they already have. This is the governance win: **no over-recommendation.**
- The mechanism itself is proven by unit tests: it fires on a synthetic session with research intent + no tool, stays silent when a satisfying tool is present or when there is no research intent, and is injection/robustness-safe (malformed lines, missing dirs).

So the demonstrated property here is **precision** (no false recommendation on a well-equipped operator), with the firing behaviour proven by controlled cases. On an *under-equipped* operator the same metric surfaces the genuine need with a number.

---

## 4. The approved, modifiable list (governance)

The registry (`technique-plugin-registry.ts`) is the allow-list of what the tuner may ever recommend:

- **Built-in seeds** ship `verified: false` — they demonstrate the path (Brave, Perplexity for `web_search`) but are **never auto-trusted**; `lookupCapability` hides them from recommendations unless explicitly surfaced as *UNVERIFIED*.
- **Operator file** `~/.config/tuner/technique-plugins.json` — the operator curates real, pinned, `verified: true` entries. **This is the approved list.** Operator entries override seeds on id collision.
- A capability with no approved entry → **no offer** (the tuner stays silent rather than guess).

This is the exact shape a regulated operator wants: *the tuner can only ever propose from a list I control, and even then it's gated and reversible.*

---

## 5. App display (control-plane)

For each detected gap the app should show:

- **Headline** — `"Capability gap: web_search — 12 unmet research asks across 5 sessions"`.
- **Evidence** — the example prompts (why it thinks so), the sessions/denominator.
- **Offer** — the approved plugin options (`brave-search`, `perplexity-ask`), each with: source (pinned package/repo), `verified` badge (approved vs UNVERIFIED), the exact `mcpServers` entry that would be written, and required secrets (e.g. `BRAVE_API_KEY`).
- **Actions** — Approve (→ gated, confined install), Refuse, Discuss (inject to the agent session). Post-install: an **adoption** readout (is the new tool actually being used?).

---

## 6. Parameters to display + configure

| parameter | what it controls | default |
|---|---|---|
| `capabilitySpecs` | which capabilities are watched + their intent/tool patterns | `web_search` built-in |
| `MAX_PROMPT_CHARS` | max length of a "natural ask" (filters system/harness prompts) | 400 |
| `since` / window | how far back transcripts are scanned | all / configurable |
| gap threshold | minimum `unmetIntentCount` before a proposal is raised | operator-set |
| approved registry path | the operator allow-list file | `~/.config/tuner/technique-plugins.json` |
| `includeUnverified` | whether UNVERIFIED seeds may be surfaced (shown flagged) | false |

All are config, not code — consistent with the plugin-only boundary (the tuner tunes config/data/plugins, never engine code).

---

## 7. Prompts (tunable)

Two LLM touch-points, both optional and out-of-band (detection itself is regex-deterministic):

1. **Intent classifier (optional upgrade)** — instead of / alongside regex, an LLM can label a prompt as "research intent" for fuzzier coverage. Prompt is fixed; the transcript text is **data, never instructions** (injection-safe extraction).
2. **Proposal rendering** — turns a gap + approved offer into the operator-facing message ("you asked N research questions… install X"). This is a `prompt_template` the operator can tune (tone, language — FR/EN), separate from the detection logic.

Keeping detection deterministic and only the *phrasing* LLM-tuned means the security-critical path has no model in it.

---

## 8. Safety summary

- Need from **behaviour only** (no external injection vector for the need).
- Offer from an **operator-approved allow-list** (vetted, pinned, `verified`).
- Install = **gated + confined + reversible** plugin (mcp-plugin-subject, #290) — never auto-run, never engine code.
- Detection is **deterministic**; any LLM use is confined to phrasing and to structured, injection-safe extraction.
