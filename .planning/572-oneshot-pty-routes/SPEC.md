# Problem

Issue #572: trusted session one-shot fallbacks still default to print while agent turns default to PTY.

# Current behaviour (file:line)

- src/oneshot/config.ts:37 resolves exact route, family wildcard, then a parsed default of print (:82).
- src/oneshot/engine.ts:63 reads loaded settings at each call; its resolver currently receives no PTY setting.
- src/runner/live-session-actions.ts:130 forwards explicit session id/cwd to the one-shot after not-live or retirement. src/rotation.ts:116 summarizes an explicit old session id. src/shutdown-memory-save.ts:255 resumes the stored global id.
- src/runner/pty-supervisor.ts:1674 already provides ephemeral resume, total deadline/abort, explicit cwd and exact compact REPL-command opt-in. Ephemeral resume bypasses fallback/global session stores, so the supplied id must be authoritative.

# Target behaviour

The compact, rotation.summary, memory.save.precompact and memory.save.stop routes default to PTY when pty.enabled is true, print otherwise. Explicit route, wildcard and oneShot.default settings win. Untrusted routes keep print and reject PTY. Not-live compact resumes the supplied id in the supplied cwd, including agent/fallback keys. No-daemon shutdown save resumes stored global id and is bounded.

# Frozen decisions

- Compute the implicit engine at resolution time from current pty.enabled, matching runner hot reload. Keep the absence of an explicit oneShot.default in parsed/serialized settings instead of manufacturing print; explicit existing print defaults remain authoritative.
- Preserve OneShotRequest/Result and engine isolation capabilities. Do not select PTY for untrusted routes. Retain explicit resume ids and cwd; no session-store lookup by one-shot engine.
- Verify compact exact-match command permission, session forwarding and shutdown deadline using PTY doubles; no live paid CLI calls.
- Version entries (plugin, marketplace plugin and marketplace top level) become 2.2.344. Follow-up is stacked on povai/feat/550-pty-default; no PR commands or Orca lifecycle messages.

# Key files

src/oneshot/config.ts, engine.ts and tests; src/runner/live-session-actions.ts; src/runner/pty-supervisor.ts; src/rotation.ts; src/shutdown-memory-save.ts; caller tests; docs/oneshot-engines.md; docs/pty-migration.md; plugin manifests.

# Out of scope

Untrusted PTY isolation spike, HTTP engines, #559, README, production rollout/soak, PR creation/merge.
