# Governed self-tuning — status overview (the tour)

Status: **Draft reference** for #275. Single map of what the tuner does, what is **wired end-to-end**, what is proven vs experimental, and how supply/discovery connects. Detailed evidence lives in `memory-subject-validation.md` and `capability-gap-detection.md`; this ties them together.

---

## 1. The shape (unchanged)

Detect (from telemetry / behaviour) → **human gate** (signed proposal) → apply (confined) → measure fitness window → **keep or auto-revert**. Two hard boundaries: the tuner **never writes engine code** (capabilities arrive only as gated, reversible plugin installs), and every apply targets exactly one managed file.

---

## 2. Subjects — what each does + what is WIRED now

| Subject | Reactive (product) | Metric(s) | Wired end-to-end? |
|---|---|---|---|
| **memory** | index hygiene + **shrink** (LLM / deterministic), drift-safe apply | `context_cost` ↓, `long_line_count` ↓, `entry_count` guardrail, `entry_quality` (judge) | ✅ collect→detect→propose→apply→fitness; quality-judge refresh wired (llm-gated) |
| **skills** | dead-skill + **description quality** | `description_context_cost` ↓, `count` guardrail, `dead_ratio`, `description_quality` (judge) | ✅ `fitnessSignals`+`measureFitness` added (was missing → now governed/measurable); quality-judge refresh wired |
| **mcp_plugin** | dead/broken tool hygiene **+ capability-gap** | tool success/trust; **capability gap = unmet-intent count** | ✅ capability-gap now collect→detect→propose **approved install** |
| others (model_routing, hook, cron, prompt_template, agent, claude_md) | reference implementations | per-subject | reactive present; proactive experimental |

**This pass closed every "dead function":** the capability-gap detector, `lookupCapability`, and both quality judges were defined-but-uncalled — they are now invoked from the subjects' own `collectObservations`. Nothing built is left unwired.

---

## 3. Evidence (honest)

- **memory** — on a real over-limit index: `context_cost` **−38 %**, `long_lines` 108→0, `entry_count` 125→125, `entry_quality` 4→4, **recall 40/40 vs 39/40** (the one divergence an ambiguous-query tie). Demonstrated, non-regressing. → `memory-subject-validation.md`.
- **skills** — description optimization: **context_cost −23 %**, discoverability held (18–20/20, noisy). Honest: only 2 near-duplicate pairs, targeted overlap test flat → real value = **fixing vague descriptions** (e.g. "Gestion documentaire intelligente" → a discriminative description) + **order/quality**, not consolidation.
- **mcp_plugin / capability-gap** — on this operator: web_search gap **= 0** (already equipped) → **no over-recommendation** (the governance win). Firing proven by unit tests on synthetic gaps. → `capability-gap-detection.md`.

---

## 4. Capability-gap: NEED internal, OFFER approved

- **NEED** from the operator's own transcripts (trusted) — no external source can inject a need.
- **OFFER** from the **approved registry** (`technique-plugin-registry`): operator-curated `~/.config/tuner/technique-plugins.json`, `verified` flag = the approved-list gate. Seeds (Brave, Perplexity) ship `verified:false` → surfaced only as UNVERIFIED, never auto-trusted.
- Install = confined + reversible plugin (mcp_plugin), human-gated. Never engine code.

---

## 5. Supply / discovery bridge (DESIGNED — documented, not yet wired to the gate)

There are already two periodic jobs on the host:

- **`github-skill-scanner.py`** (cron, weekly) — searches GitHub for relevant skills/tools (hubitat, trading, mqtt, claudeclaw…) → writes `~/agent/data/github-skills-found.json`.
- **`wisecron-research-scout.timer`** (weekly) — runs the pilot proactive scout (`docs/research-scout-pilot/`) for subject *design* research.

**Gap:** the scanner **discovers** but its output is **not connected to the governed pipeline** — findings sit in a JSON, nothing proposes them. **The designed wire:**

```
github-skill-scanner  →  candidate entries (verified:false)
                      →  technique-plugin-registry (operator reviews/approves → verified:true)
                      →  capability-gap / skills subject surfaces the APPROVED option
                      →  human-gated, confined, reversible install
```

Same safety spine as capability-gap: **discovery is untrusted supply**; nothing acts until an entry is **operator-approved** in the registry. Two additions complete it (scoped, not in this PR):
1. a **bridge** `loadScannerCandidates()` reading the scanner JSON → unverified candidates for operator review;
2. an **update-check** (installed plugin/skill version vs upstream) — currently **absent**: nothing flags an installed capability as outdated.

External research sources (for FORM, not need): Tier-1 = Anthropic (docs, `anthropics/*` repos); Tier-3 = skills.sh / arbitrary repos / web search — **discovery-only, injection-sandboxed** (content is data, never instructions; convergence ≥3 + ≥1 high-trust).

---

## 6. Proven (product) vs experimental (research) — Terry's rail #2

- **Product (ship):** reactive faces — memory hygiene/shrink, skills description quality, mcp dead-tool + capability-gap. Deterministic by default; LLM is opt-in.
- **Experimental (keep gated/dormant):** the proactive scout/feeder, the **sequence-mining** (missing skills from repeated action sequences; "2 calls always after skill X" → fold in), the supply bridge above. All human-gated, none auto-acts.

---

## 7. Governance properties (for regulated operators)

Human gate on every change · signed proposals + tamper-evident audit · **plugin-only boundary** (never engine code) · **operator-approved allow-list** for any capability · **auto-revert** if fitness regresses · needs from behaviour only (no injected needs) · confined single-file apply.

---

## 8. Honest caveats

- skills discoverability is noisy (18–20/20) and overlap-resolution is unproven; the solid win is cost + description quality/order.
- capability-gap real value = 0 on a well-equipped operator (validates precision; the firing case is an under-equipped operator).
- the supply bridge + update-check are **designed and documented here, not built**.
- quality judges are LLM-based, refreshed out-of-band, llm-gated (dormant by default).
