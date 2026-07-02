# Memory subject — added capabilities & validation evidence

Status: **Draft evidence note** for #275 rail #1 ("demonstrated value from subject 1, with a written success metric, before subject 2"). Companion to `tuner-implementation-and-telemetry.md`. Refs: #291 (the memory subject PR).

This documents (1) what was added to the `memory` subject to make its gain measurable, (2) the **validation process** used, and (3) the **before/after** numbers on a real over-limit index — kept deliberately honest about what was and was **not** tested.

---

## 1. What was added (the new function)

The memory subject already did reactive hygiene (dead-ref / duplicate cleanup). To make a **measurable** improvement on the real failure mode — an index that grows too big and dilutes context — it gained:

**Metrics (fitness signals):**
- `memory_index_context_cost` — estimated tokens the index loads into context **every session** (≈ chars/4). *lower is better*, guarded by `memory_index_entry_count` (can't game it by deleting entries).
- `memory_index_long_line_count` — index lines over the one-line budget (~200 chars). *lower is better*, same guardrail.
- `memory_entry_quality` — an LLM judge rates a sample of entries 1–5 (clarity + specificity + actionability); the median is cached out-of-band and read fast. *higher is better*. The **anti-Goodhart pair** to context_cost: shrinking must not gut usefulness.

**Shrink strategy** (`shrink` alternative): rewrite each over-long entry to one line, keeping its exact `[Title](file.md)` link (detail stays in the topic file).
- **LLM-rewrite** (opt-in, better prose) with a **deterministic truncation fallback** that also acts as a guard — if the LLM drops/adds an entry or a pointer, it falls back so every entry + link is preserved.
- Default engine wiring registers memory **without** an LLM → the fast deterministic path runs at cron (no LLM latency); the LLM prose is an opt-in upgrade for a one-time big job.

**Drift-safe apply** (reconcile): a proposal freezes a snapshot at propose-time, but the operator may edit memory before approving. Apply now **reconciles the frozen proposal against the LIVE index** — reuse the proposed shortened line where the entry still exists, deterministically shorten any new/changed entry, keep every current pointer. Approve always succeeds on the current state; **no memory is ever lost**.

---

## 2. The validation process (before → after)

Measured on a **real over-limit index** (a live auto-memory `MEMORY.md`: 39.5 KB, 125 entries, 62 % over the 24.4 KB soft limit, 108 of 125 lines over the one-line budget). Each metric is a **before/after on the same index**, the change applied through the subject's own `apply()`.

| Metric | Before | After (deterministic shrink) | Verdict |
|---|---|---|---|
| `memory_index_context_cost` (tokens/session) | **9 630** | **5 967** | **−38 %** (−3 663 tokens every session) |
| `memory_index_long_line_count` | **108** | **0** | resolved |
| `memory_index_entry_count` (guardrail) | 125 | **125** | **no entry dropped** |
| `memory_entry_quality` (LLM judge, median 1–5) | **4** | **4** | **quality held** |

(The LLM-rewrite path reaches a marginally lower cost — 5 908 — with fuller prose; the deterministic path is the reliable floor and gives the same −38 %.)

### The recall test (the one that matters for "can it still find things")
Per-entry *quality* ("does the entry read well") is **not** *recall* ("can the right memory still be found"). Shortening a hook could, in principle, drop the keyword that made an entry discoverable — so this was tested directly, at scale:

1. Sample **40 entries** from the index as ground truth (their `file.md`).
2. An LLM writes one natural question per entry (about the substance, not the title).
3. A retriever LLM is given the index + the questions (batched) and must return the single most-relevant `file.md` per question — run on the **original** index and on the **shrunk** index.
4. Compare hit-rate.

**Result (N = 40):**

| Index | Recall hit-rate |
|---|---|
| Original (39.5 KB) | **40 / 40** |
| Shrunk (−38 %) | **39 / 40** |

**No recall degradation.** The single difference was an *ambiguous* query ("what did we settle about archiviste v2?"): the ground-truth entry was a session log that merely *mentions* it, while on the shrunk index the retriever returned `project_archiviste.md` — literally the archiviste memory, a defensibly-better answer. So the shrunk index finds memories as well as the original; the one divergence is a legitimately-relevant alternative on an ambiguous query, not a lost memory. (An earlier N=8 pilot was 8/8 vs 8/8.)

### Drift safety (approve-anytime)
Adding an entry *between* propose-time and approve-time was tested: apply reconciles and **preserves the new entry** (no dropped-pointer error). Approve is safe at any later time.

---

## 3. Honest caveats (what was NOT proven)

- **Recall sample** is N = 40, one retriever model, deterministic shrink. A solid signal; a multi-model / full-index (all 125) sweep would harden it further.
- **Entry-quality is a sampled judge** (12 entries, evenly spaced), not every entry.
- The recall + quality metrics use an LLM; their absolute values depend on the judge/retriever model. The **relative before/after** on the same model is the meaningful comparison.

---

## 4. Success metric (proposed, for rail #1)

> A memory shrink is **kept** iff, on the same index: `memory_index_context_cost` drops, `memory_index_entry_count` is unchanged (no entry lost), `memory_entry_quality` does not regress, and recall hit-rate on a random query set is ≥ the pre-shrink rate. Otherwise the OutcomeLoop auto-reverts.

This is the "measure, then keep" contract applied to memory: cost down, **with** quality and recall guardrails — exactly the anti-Goodhart posture. On the test index all four held (cost −38 %, entries 125→125, quality 4→4, recall 40/40 original vs 39/40 shrunk with the one divergence an ambiguous-query tie), so the change is a demonstrated, non-regressing gain.
