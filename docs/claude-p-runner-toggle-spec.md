# Spec — `claude -p` runner toggle (re-enable as a user option)

**Status:** draft, rev 2 (addresses the #263 review) · **Author:** Fox · **Date:** 2026-06-16, rev 2026-06-19
**Context:** Anthropic delayed (not cancelled) credit-billing for programmatic `claude -p`. We want users to choose `claude -p` vs the Bus/PTY runner, and switch to Bus if/when usage limits return.

---

## 1. TL;DR

The toggle is **already in the data model** — `AgentConfig.supervision` overrides the per-origin runner. `claude -p` is the `process-stream-json` supervision mode, which the Bus already runs in production for non-channel origins. Making it a real *user* option for chat agents is **scoping + wiring + graceful degradation**, not a new runtime.

The decision that shaped this spec: I empirically re-tested the two things people assume block `claude -p`. Results below.

### Why the prior move *off* `claude -p` is now reversible (migration history)

The project deliberately moved off `claude -p`: **PR #62** introduced the PTY migration, **PR #159** flipped the runtime default to `bus`, and **PR #162** reframed PTY/`runtime` as a permanent first-class option rather than a transitional one. The driver was the impending credit-billing for programmatic `claude -p` use — the Bus/PTY path keeps agents on the interactive-subscription billing.

That reversal is reversible *now*, and specifically *additively*, for two reasons:

1. **The driver is delayed, not gone.** Anthropic pulled the credit-billing rollout; the cost pressure that justified leaving `claude -p` is paused. Re-offering it is optionality against a delay, with the Bus ready underneath for when limits return (see §8).
2. **#162 already established a multi-runner posture.** Once `runtime`/`supervision` became permanent first-class config (not a migration artifact), adding `claude -p` as a *parallel* first-class runner is consistent with that design — **not** a re-reversal of the migration. The Bus stays the default (§6); this only restores `claude -p` as a documented, supported opt-in. Nothing about #62/#159/#162 is undone.

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
| Slash-command relay (`/compact`, `/clear`, `/quit`) | ✅ (via PTY) | ✅ (via **stdin** — `send_slash`, `session-agent-process.ts:52,180`; Probe 0.6 Q5 confirms slash commands work over the stream-json stdin) |
| Long-lived multi-turn session | ✅ | ✅ (verified) |
| Receipts (#211), governance (#257), silent-drop net (#215/#217), reply nudge | ✅ | ✅ at bus-core level **iff** delivery seam is wired (see §5) |
| Interactive permission surfaced to channel | ✅ | ❌ → must run `bypassPermissions` |
| `ask` (non-blocking question) | ✅ | ❌ (answer rides `claude/channel`) |
| `request_human` (blocking) | ✅ | ❌ (answer rides `claude/channel`) |
| Reliability bug class (wedge, silent-drop, reconciler) | present (PTY parsing) | **absent** (structured JSON I/O) |
| Per-turn compute overhead | higher (PTY + tailer) | lower |

> **On slash commands (review note):** #106 flagged that `isatty(0)` checks can quietly drop slash-command *relay*. That risk is specific to the non-TTY *interactive* path; the Bus's `process-stream-json` runner does **not** rely on a TTY for slash relay — it writes `/<cmd>\n` to the child's stdin via `send_slash` (`session-agent-process.ts:180`), which Probe 0.6 confirmed works. So `claude -p` agents keep `/compact` / `/clear` / `/quit`. (The `process` Windows-fallback mode is the only runner that drops slash relay.)

## 5. Wiring work to make it production-safe for chat agents

1. **Inbound delivery seam — this is a `BusCore` interface change, not just routing.** Bus core delivers channel-driven prompts through `streamPromptHandler`, which is a **single global handler typed and documented as PTY-stdin-only** (`src/bus/core.ts:140-210`). There is no per-agent seam selection today. Wiring stream-json delivery therefore requires a `BusCore` *interface* change — either a second handler slot (e.g. `streamJsonPromptHandler`) or a mode-discriminated dispatch inside `deliverOrQueuePrompt` keyed on the agent's `SupervisionMode` — that routes a `process-stream-json` agent to `send_prompt_stream` (stdin JSON) instead. Treat this as a core change with its own review, not a leaf edit. *The reply-tool nudge (#240/#215) rides the same seam (`deliverOrQueuePrompt`) and must follow the same dispatch.*
   - **Preserve the channel-XML wrapping (#140).** Today's PTY seam wraps every prompt as a `<channel source=... chat_id=... user_id=... ts=...>…</channel>` block with security-hardened escaping (PR #140 established this as the canonical inbound contract). The stream-json seam **must wrap inbound prompts in the identical channel-XML envelope** (just carried as the `text` of a stream-json user message) — or explicitly document a substitute — so that an agent which falls back from `-p` to `bus` (or vice-versa) sees a consistent prompt format and the same escaping guarantees. Do **not** hand a `process-stream-json` agent a bare prompt string.
2. **Graceful degradation of channel-only tools.** In `process-stream-json` mode, `ask` / `request_human` cannot get answers back. Options: (a) hard-disable them from the tool list for these agents (cleanest — the model never offers a dead affordance), or (b) degrade `request_human`→ log + auto-`reply` a "human input unavailable in this mode" notice. Recommend (a).
3. **Force `bypassPermissions`.** No channel ⇒ no interactive approval. A `process-stream-json` agent must run `permission_mode: "bypassPermissions"` (the bus already defaults headless to this). Reject/warn on a `process-stream-json` agent configured with an interactive permission mode.
4. **Verify the silent-drop net + nudge end-to-end** in stream-json mode. *Why it should work regardless of runner:* `claude` writes its session transcript to the same path under both runners — `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — because the transcript location is a function of `--session-id` + cwd, not of stdio mode. The Bus's `JsonlTailer` watches that file, so it observes the `response.turn_end` (`stop_reason: "end_turn"`) line that drives the #215/#217 silent-drop net the same way for a `process-stream-json` agent as for a `pty-stdin` one. This is the mechanism a future auditor of #233/#235 silent-drop coverage needs to rely on — so it must be stated, and a test must pin it (spawn a `process-stream-json` agent, confirm `turn_end` is tailed and the net/nudge fire).

## 6. Config / UX surface

- **Per-agent (exists):** `agents[].supervision: "process-stream-json"` in `settings.json`. Keep, document.
- **Friendly alias (recommended):** accept `agents[].runner: "claude-p" | "bus"` mapping to `process-stream-json` / `pty-stdin`. This is **new parsing in `src/config.ts`**, not just a rename — it needs:
  - **Its own parser**, alongside `parseRuntimeMode` / the `supervision` parse, that maps the alias to a `SupervisionMode` and **rejects/warns on unknown values** (mirror `VALID_RUNTIMES`'s warn-and-fallback, e.g. `parseRunnerAlias` → `process-stream-json | pty-stdin | undefined`).
  - **A precedence rule vs the existing `supervision` field**, since both can be set on an agent. Proposed: explicit `supervision` **wins** (it's the precise, lower-level field); `runner` only fills `supervision` when the latter is absent; setting both to *conflicting* values is a parse-time warning. Document this in the `AgentConfig` doc-comment so the two fields don't silently fight.
  - **No change to the existing `runtime` top-level field** — `runner`/`supervision` are per-agent (Bus-runtime) selectors and orthogonal to `runtime: "pty" | "bus"`.
- **Global default (optional):** `settings.defaultRunner: "claude-p" | "bus"` so a whole deployment can opt in, with per-agent `runner`/`supervision` overriding. **Default stays `bus`.** Same parser + warn-on-unknown applies.

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
