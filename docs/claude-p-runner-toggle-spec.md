# Spec — `claude -p` runner toggle (re-enable as a user option)

**Status:** draft for review · **Author:** Fox · **Date:** 2026-06-16
**Context:** Anthropic delayed (not cancelled) credit-billing for programmatic `claude -p`. We want users to choose `claude -p` vs the Bus/PTY runner, and switch to Bus if/when usage limits return.

---

## 1. TL;DR

The toggle is **already in the data model** — `AgentConfig.supervision` overrides the per-origin runner. `claude -p` is the `process-stream-json` supervision mode, which the Bus already runs in production for non-channel origins. Making it a real *user* option for chat agents is **scoping + wiring + graceful degradation**, not a new runtime.

The decision that shaped this spec: I empirically re-tested the two things people assume block `claude -p`. Results below.

## 2. Empirical findings (current CLI: 2.1.178 / 2.1.179)

| Claim | Result | Evidence |
|---|---|---|
| `claude -p` downshifts/can't do long sessions | **FALSE** | 3-turn long-lived session, 5s gaps, process never dropped, recalled turn-1 context in turn 2. (The ~3s downshift is Spike 0.4 = the *interactive* REPL with non-TTY stdin, NOT `claude -p`.) |
| `claude -p` supports the `claude/channel` capability now | **NO — still dropped** | Ran `claude -p` against a probe MCP server declaring `claude/channel`. claude's client capabilities = `{roots, elicitation}` only; it emitted **zero** `claude/channel` notifications; on a permission-gated tool it declined rather than routing via channel. No CLI flag enables it. Spike 0.6 holds. |

**Net:** `claude -p` does the core request→reply loop (stdin in, `reply`/`edit_message` tools out) reliably and efficiently. It does **not** support the experimental `claude/channel` capability that powers interactive permission approval, non-blocking `ask`, and `request_human`.

## 3. What already exists

- `SupervisionMode = "pty-stdin" | "process-stream-json" | "tmux" | "process"` (`src/bus/types.ts`).
- `defaultSupervisionFor(origin)` → `pty-stdin` for channel-driven origins, `process-stream-json` (= `claude -p --input-format=stream-json --output-format=stream-json --verbose`) otherwise.
- **Per-agent override already wired:** `session-manager.ts:593` → `const mode = agent.supervision ?? defaultSupervisionFor(origin)`. So `AgentConfig.supervision: "process-stream-json"` already forces `claude -p` for that agent, including channel-driven ones.

So a power user can *technically* flip it today. This spec is about making it **safe, documented, and complete**.

## 4. Feature parity matrix (`pty-stdin` vs `process-stream-json`)

| Capability | Bus / `pty-stdin` | `claude -p` / `process-stream-json` |
|---|---|---|
| Inbound prompt delivery | `notifications/claude/channel` | **stdin stream-json** (`send_prompt_stream`) — already implemented |
| `reply` / `edit_message` | ✅ | ✅ (normal MCP tools) |
| Long-lived multi-turn session | ✅ | ✅ (verified) |
| Receipts (#211), governance (#257), silent-drop net (#215/#217), reply nudge | ✅ | ✅ at bus-core level **iff** delivery seam is wired (see §5) |
| Interactive permission surfaced to channel | ✅ | ❌ → must run `bypassPermissions` |
| `ask` (non-blocking question) | ✅ | ❌ (answer rides `claude/channel`) |
| `request_human` (blocking) | ✅ | ❌ (answer rides `claude/channel`) |
| Reliability bug class (wedge, silent-drop, reconciler) | present (PTY parsing) | **absent** (structured JSON I/O) |
| Per-turn compute overhead | higher (PTY + tailer) | lower |

## 5. Wiring work to make it production-safe for chat agents

1. **Inbound delivery seam.** Bus core delivers channel-driven prompts via `streamPromptHandler` (pty-stdin) today. For a `process-stream-json` agent the seam is `send_prompt_stream` (stdin JSON). Confirm/route the adapter→bus→agent path to the stream-json seam when the agent's mode is `process-stream-json`. *Same applies to the reply-tool nudge I just added (#240/#215): it currently delivers via `deliverOrQueuePrompt`; it must use the stream-json seam for these agents.*
2. **Graceful degradation of channel-only tools.** In `process-stream-json` mode, `ask` / `request_human` cannot get answers back. Options: (a) hard-disable them from the tool list for these agents (cleanest — the model never offers a dead affordance), or (b) degrade `request_human`→ log + auto-`reply` a "human input unavailable in this mode" notice. Recommend (a).
3. **Force `bypassPermissions`.** No channel ⇒ no interactive approval. A `process-stream-json` agent must run `permission_mode: "bypassPermissions"` (the bus already defaults headless to this). Reject/warn on a `process-stream-json` agent configured with an interactive permission mode.
4. **Verify the silent-drop net + nudge end-to-end** in stream-json mode (the JSONL tailer reads claude's session file regardless of runner, so `response.turn_end` detection should work — needs a test).

## 6. Config / UX surface

- **Per-agent (exists):** `agents[].supervision: "process-stream-json"` in `settings.json`. Keep, document.
- **Friendly alias (recommended):** accept `agents[].runner: "claude-p" | "bus"` that maps to `process-stream-json` / `pty-stdin`, so operators don't need to know the internal mode names.
- **Global default (optional):** `settings.defaultRunner: "claude-p" | "bus"` so a whole deployment can opt in, with per-agent override winning. **Default stays `bus`.**

## 7. Permission & governance posture (for the regulated-finance lens)

- `claude -p` mode = `bypassPermissions` = trusted/headless agents. This is the **same** posture the Bus already uses for headless by default — not a new exposure.
- Governance, audit log, and budget enforcement (#257) wrap the bus's tool dispatch and are **runner-agnostic**, so a `claude -p` agent stays inside the governance envelope. (The thing it loses is *interactive* approval, which is a UX/HITL feature, not the audit/policy layer.)
- Document clearly: `claude -p` mode trades interactive HITL for simplicity + the structured-I/O robustness. Suitable for trusted automation; the Bus stays the choice where human-in-the-loop / interactive approval matters.

## 8. Switch story

`claude -p` ↔ Bus is a **config flip** (`runner` / `supervision`), no data migration. So Terry's framing works directly: users run `claude -p` now; when usage limits return, flip to `bus`. The Bus is the future-proof default underneath.

## 9. Rollout

Opt-in, low blast radius (per-agent, Bus stays default). Phase it:
1. Document + alias the existing `supervision` override; add the `runner` alias.
2. Wire the stream-json inbound/nudge seam + degrade `ask`/`request_human` (§5.1–5.2).
3. Force-`bypassPermissions` guard (§5.3) + an end-to-end test (§5.4).
4. Optional global `defaultRunner`.

## 10. Open questions for Terry

1. **Granularity:** per-agent only, or also a global `defaultRunner`?
2. **`ask`/`request_human` in claude -p mode:** hard-hide the tools (recommended) vs degrade-with-notice?
3. **Naming:** expose the friendly `runner: "claude-p" | "bus"` alias, or keep the raw `supervision` mode names?
4. Do we want a one-line capability note surfaced to the user when they pick `claude -p` ("interactive approval / ask / request_human are unavailable in this mode")?
