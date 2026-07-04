# SPEC — Bash-exec hardening (PR 2/3 of #296)

Prevents the root cause of the #295 outage at the source; PR 2 of the 3-PR path in #296. (PR 1 — the stall watchdog — is merged as the *recovery* net; this PR is the *prevention*.)

## 1. Problem statement

The #295 outage: a persistent bus PTY session wedged ~11h because a `Bash` tool call backgrounded jobs with `nohup … &`. The backgrounded processes held the Bash tool's output stream open, so a later `Bash` call never saw EOF and the single-threaded session loop blocked forever. PR 1 recovers from such a wedge (kill + respawn within a ceiling); this PR stops the specific footgun from happening at all: **an inline `&`-backgrounded job launched from a `Bash` tool call that isn't fully detached wedges the session.**

## 2. Current behaviour (as-is)

- **No guard exists.** The plugin ships **no hooks** — `hooks/hooks.json` is `{"hooks":{}}` on main. Any `Bash` tool call runs verbatim, including `nohup cmd &` / `cmd &` that leave a job holding the session's pipe.
- **The Bash timeout does not help** (verified against the Claude Code docs, code-guide research): `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` (default 120s, hard max 600s) bound the **foreground command's runtime**, *not* the tool's post-command pipe-drain. A backgrounded child holding fd1/fd2 keeps the pipe open regardless of the timeout, so the tool blocks past it. So an env-timeout lever is **ineffective** for this hang (see §4 / §6).
- **The correct primitive exists but the agent didn't use it.** Claude Code's `Bash` tool has a `run_in_background: true` parameter that starts the job as a framework-tracked task (listed/stopped via `/tasks`) which does **not** hold the tool's pipe. Inline `&` does not decouple the pipe. In the incident Claw hand-rolled `nohup … &` instead of `run_in_background`.

## 3. Target behaviour (to-be)

A **`PreToolUse(Bash)` hook** shipped in the plugin (`hooks/hooks.json` + a zero-dep `.mjs`) that inspects `tool_input.command` and, when it detects an **unsafe inline background job**, **denies** the call with guidance steering the agent to the pipe-safe primitive.

- **Detection (unsafe = all of):**
  - contains a background operator `&` (a lone `&` terminating a command / before `;`/newline/end — **not** `&&`), and
  - the backgrounded job is **not** already detached with `setsid`, and
  - the command does **not** `wait` for its background jobs (a trailing `wait` means the tool blocks on them deterministically, no dangling holder).
- **Action (see §4 for the block-vs-rewrite decision):** return `permissionDecision: "deny"` + a `permissionDecisionReason` that names the hazard (it caused #295) and gives the two safe options: **(1) `run_in_background: true`** (preferred — tracked, readable via `/tasks`, pipe-safe), or **(2)** if inline is truly needed, `setsid <cmd> </dev/null >logfile 2>&1 &` (new session + all fds off the pipe).
- **Never blocks** legitimate work: `&&`, `cmd & … wait`, `setsid … &`, and any command with no background operator all pass untouched. Best-effort + fail-open: any hook error (parse failure, malformed input) allows the command (a guard must never break the tool).

Net: the exact `nohup … &` pattern from #295 is refused with a one-line fix, so it can't wedge the session in the first place. PR 1 remains the backstop for any hang that slips through.

## 4. Architecture decisions (frozen)

- **A `PreToolUse(Bash)` hook, not an env-timeout.** The timeout provably doesn't catch the pipe-holding hang (§2); the hook prevents the footgun directly. (Rejected: setting `BASH_MAX_TIMEOUT_MS` in the spawn env — ineffective for this hang, and lowering the global Bash cap would break legitimate long commands; PR 1's per-tool ceilings already bound wall-clock at the recovery layer.)
- **DECISION NEEDED — block vs rewrite.** Claude Code hooks can either `deny` (block with a message) or `allow` + `updatedInput` (rewrite the command). **Recommendation: block.** Rationale: (a) safely rewriting arbitrary shell is fragile (compound commands, multiple `&`, quoting), (b) a blind detach-rewrite to `/dev/null` would destroy output the agent may want to read (Claw wanted to `tail` its job's log), and (c) block-and-steer teaches the correct primitive (`run_in_background`), which is exactly what the agent lacked in #295. The only cost is one retry, which is beneficial. (Rejected: rewrite — fragile + can silently change intent.)
- **Ships in the plugin's hooks, enabled.** Applies to every claude the plugin spawns, including the bus PTY sessions (the incident path). Fail-open so it can never wedge the tool it guards.
- **Zero-dependency `.mjs`** (Node only), mirroring the existing `hooks/` convention.

## 5. Key file references

**New:**
- `hooks/guard-bash-backgrounding.mjs` — the hook: read the PreToolUse JSON on stdin, run the detection on `tool_input.command`, emit the `deny`+reason JSON (or nothing = allow). A pure `isUnsafeBackground(command): boolean` split out for unit testing.
- `hooks/hooks.json` — wire `PreToolUse` matcher `Bash` → the script (currently `{"hooks":{}}`).
- `src/__tests__/bash-backgrounding-guard.test.ts` — unit (`isUnsafeBackground` truth table: `nohup cmd &` / `cmd &` / `cmd & echo x` flagged; `&&`, `cmd & wait`, `setsid … &`, plain `cmd`, no-`&` all allowed) + hook integration (stdin JSON → deny for unsafe, allow/empty for safe; malformed input → allow).

**Reference:**
- Claude Code hook output schema (`permissionDecision`/`permissionDecisionReason`/`updatedInput`) — docs.
- `hooks/log-skill-access.mjs` shape (from #289, if merged) — the `.mjs` stdin-JSON hook convention to mirror.

**Overlap to flag:** #289 (skill_access producer, open) also edits `hooks/hooks.json` (adds a `PostToolUse(Read)` entry). Whichever merges second must merge the JSON (add both entries), not clobber. Call it out on the PR.

## 6. Out of scope (deferred)

- **Env-timeout / `BASH_MAX_TIMEOUT_MS`** — considered and rejected (ineffective for the pipe hang; §2/§4). Not built.
- **Auto-rewriting the command** — the rejected alternative to the block decision (§4).
- **A first-class agent-job primitive** so Claw never hand-rolls background jobs → **PR 3** (own SPEC). This PR blocks the unsafe pattern; PR 3 gives jobs a proper home.
- **Guarding non-Bash tools** — only `Bash` backgrounding caused #295.
