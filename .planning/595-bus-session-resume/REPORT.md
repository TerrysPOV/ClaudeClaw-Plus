# #595 — bus agent session not resumed after a restart ("already in use")

Branch `fix/595-bus-session-resume`, off `4e491076` (the #562 soak head). Nothing is pushed to `feat/550-pty-default`.

## Verdict

**Cause 1 is the verified cause. Causes 2 and 3 are ruled out as the source of this symptom.**
The fault is inside ClaudeClaw, and the fix needs no change to the #562 fence/quarantine design, so the stop condition does not apply.

The bus spawns every agent with `--session-id <stored id>` (create). The CLI treats `--session-id <id>` as "create this session" and refuses it when the transcript file for that id already exists. After any restart where the agent had held a conversation, the transcript exists, so the first spawn dies with `code=1`. The "already in use" recovery then mints a fresh id, which discards the conversation.

## Evidence

### Cause 1 — verified: restart builds `--session-id` (create), never `--resume`

- `src/bus/session-manager.ts:708` — `buildClaudeArgs` ends with `args.push("--session-id", agent.session_id)`. It has no resume branch, and it is the only place the bus builds the flag. `spawnAgentInternal` (`:832`) calls it for every spawn, first boot and restart alike.
- The legacy PTY path does this correctly: `src/runner/pty-process.ts:627-631` emits `--resume <id>` for an existing session and `--session-id <id>` only for a new one. The bus never got that distinction.
- The CLI's own check, from the installed binary (`~/.local/share/claude/versions/2.1.309`, grepped with `rg -a`). In the `--session-id` argument handling:
  `if(Oe){if(!ke){let s=zt(Oe);if(!s)return fn("Error: Invalid session ID. Must be a valid UUID.");if(!(o.forkSession&&o.resume===s)&&kzn(s))return fn(\`Error: Session ID ${s} is already in use.\`,Fvn)}}`
  and the predicate:
  `function kzn(e){if(J())return!1;let n=C8(),r=Lc(n,\`${e}.jsonl\`),s=ie();try{return s.statSync(r),!0}catch{return!1}}`
  So **"already in use" means "`<projects>/<cwd-slug>/<id>.jsonl` exists"**. It is a `statSync` and nothing else. `J()` is the diskless-mode switch, which skips the check; ClaudeClaw never sets it.
- `--resume <id>` is the correct way to continue an existing transcript. When the transcript is missing the CLI exits 1 with `No conversation found with session ID: <id>` (`failure_reason: not_found_explicit_id`).
- This matches the soak report: one `code=1` exit, the retry works, and the conversation is gone. The retry works because the fresh id has no transcript.

Consequence beyond restart: `restart(id, { freshSession: false })` is documented as "resume the same transcript" (`session-manager.ts:1319`), but it too goes through `buildClaudeArgs`, so it hits the same refusal and silently rotates.

### Cause 3 — ruled out: stale per-session lock or marker

- The check above is the only source of "already in use" for a session id, and it reads no lock, pid or registry. The other "already in use" strings in the binary are unrelated (port `EADDRINUSE`, OAuth callback ports, a scheduler id validator).
- The resume failure reasons the binary reports are `not_found_explicit_id`, `processing_error`, `worker_state_unread`, `drop_guard_refused`, `not_found_picker`. None is a lock or liveness refusal. `--resume` does not consult any process state.
- Corollary: the comment at `session-manager.ts:1315` ("claude's locked-`--resume` refusal") is not supported by 2.1.309. I left it alone: it is a comment, and the version the soak server runs is pinned older (2.1.220), which I could not inspect.

### Cause 2 — ruled out as the cause of this symptom; a related hazard remains

- A surviving previous-daemon `claude` cannot produce "already in use": the check never looks at processes. With every old process dead, the refusal still happens.
- Shutdown path, for the record: `runtime-mount.ts:750-756` calls `sessionManager.stop(id)` for each spawned agent. `stop()` (`session-manager.ts:1254-1300`) sends `/quit`, then SIGTERMs after 2 s via `PtyAgentProcess._kill` (`session-agent-process.ts:1302`), which calls the raw `pty.kill()` on the bun-pty handle. It resolves on the exit **event**, and bun-pty fires that event at once without proving the process gone. Bus PTYs are not in the `pty-quarantine` registry, so nothing confirms their exit.
- **Residual hazard (not fixed here):** the CLI has no lock on `--resume`, so a `claude` that outlives its daemon (daemon SIGKILLed, or a `/quit`/SIGTERM that did not land) and a new `--resume`d `claude` would both append to one transcript. Before this change that case was masked, because the create-refusal forced a fresh id. Closing it means bringing bus PTYs under the confirmed-exit/quarantine machinery, or reaping orphans by pid at boot. Either one touches the #562 round-9 design, which this task must not change, so I am reporting it rather than patching it.

### Other residual

- After `/clear` the CLI writes a new transcript, but the stored id stays the pre-clear one (`jsonl-tailer.ts:167`). A restart now resumes the **pre-clear** conversation (before, it silently started empty). I did not change the stored-id handling.

## Fix (smallest change that closes cause 1)

1. `buildClaudeArgs(agent, mode, { resume })` emits `--resume <id>` when `resume` is true, otherwise `--session-id <id>` as before (default, so existing callers and tests keep their argv).
2. `spawnAgentInternal` decides `resume` from the transcript: the same file the CLI stats, resolved with the existing `resolveTranscriptPath` (honours the child's `CLAUDE_CONFIG_DIR`; realpath'd cwd) or `options.projectsDir` in tests. The decision is a filesystem fact, not screen text.
3. Rotation only when resume genuinely fails: a resumed spawn that exits non-zero inside the detection window **and** whose last output names `No conversation found with session ID` (the CLI's own refusal). The screen is used only to fail the spawn over to a fresh id, never to mark anything successful. The log line carries a fixed reason code, never screen text. Rotation happens at most once (existing `retry` guard).
4. The existing `--session-id` collision rotation stays for the create path, now logged with a reason code as well.

Nothing under `src/runner/pty-quarantine.ts` or the supervisor changes: `assertSessionWritable` and `assertSessionSpawnable` still run in the same places, in the same order.

## Tests, injections, gates

(Filled in after the fix.)
