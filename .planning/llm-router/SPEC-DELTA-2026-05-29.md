# SPEC-DELTA — LLM router Phase B scope (#70)

**Date:** 2026-05-29. Amends `.planning/llm-router/SPEC.md` (Phase A, merged in #202).
**Driver:** Stage-3 review with Terrence. Model selection is the operator's choice,
not a baked-in opinion; the catalogue should be discoverable.

## Changes to the frozen design

### D1 — Tiers are operator-configured; no hardcoded model defaults
`DEFAULT_SETTINGS.llmRouter.tiers` ships **empty**. The router does not bundle an
opinion about which model is "fast"/"balanced"/"reasoning". An `llm_call({ tier })`
against an unconfigured tier returns a clear, actionable error
("tier 'fast' has no models configured — search with `llm_models` and add ids to
settings.llmRouter.tiers.fast"), never a silent default.

Supersedes Phase A §3's "Tier → model resolution from a new `settings.llmRouter`
section" only in that the section starts empty — the resolution mechanism is
unchanged.

### D2 — Per-call `model` override (full catalogue, immediately)
`llm_call` accepts an optional `model` (any OpenRouter model id, e.g.
`"anthropic/claude-opus"`). When present it bypasses tier resolution entirely and
calls that model directly. This is the "full selection" path — it works before any
tier is configured. `tier` and `model` are mutually exclusive; if both are given,
`model` wins and a note is added to the result.

### D3 — New discovery tool: `llm_models`
A second MCP tool on the same plugin proxies OpenRouter's `GET /api/v1/models`
catalogue (cached ~1h in-process), making the full selection **searchable**:

```
llm_models({ query?: string, maxPromptPrice?: number, minContext?: number, limit?: number })
  -> { models: Array<{ id, name, context_length, pricing: { prompt, completion } }>, cachedAt }
```

`query` is a case-insensitive substring/fuzzy match over `id` + `name`; the price /
context filters are optional. Agents (and, later, the dashboard) search the
catalogue, then either populate `settings.llmRouter.tiers` or pass a per-call
`model`.

### D4 — Audit via own-process bridge
The standalone stdio server is its own process and cannot share the in-process
`mcp-bridge` singleton. It instantiates its own `getMcpBridge()` which appends to
the shared `~/.config/plus/plugin-audit.jsonl`. Events: `llm_call_dispatched`,
`llm_call_failed`, `llm_call_fallback_taken`, `llm_models_listed` (caller, tier,
provider, model, latency, token usage). Confirmed acceptable (Terrence, 2026-05-29).

### D5 — `schema` → `response_format` best-effort (v1)
When `llm_call({ schema })` is supplied, it's passed as an OpenRouter
`response_format: { type: "json_schema", json_schema }`. If the chosen model doesn't
support structured output, the call proceeds without it and the result carries a
`schemaApplied: false` note. No client-side validation in v1. Confirmed (Terrence).

## Deferred to Phase C (not this PR)
- **Dashboard model picker** — a searchable model list in the web UI settings that
  assigns models to tiers, calling the same catalogue proxy that backs `llm_models`.
  Terrence chose "tool now, UI later": the `llm_models` tool is the substrate the UI
  will reuse.

## Unchanged from Phase A
Standalone stdio MCP server hosted as a multiplexer shared server (no multiplexer
changes); OpenRouter breadth (+ optional Ollama); keys from env/Doppler only
(`OPENROUTER_API_KEY`); non-streaming v1; tier-ordered 429/5xx fallback; billing
nuance.
