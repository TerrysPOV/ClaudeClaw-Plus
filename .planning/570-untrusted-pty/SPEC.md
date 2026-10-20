# #570: interactive untrusted isolation spike

## Problem

Untrusted utility calls currently need print or an explicitly selected HTTP engine. Terry selected interactive PTY isolation (brief v2, 2026-10-20); an HTTP default would leave users without API credentials on print.

## Current behaviour (file:line)

- `src/runner/pty-process.ts:388`: the untrusted argv branch already spreads `UNTRUSTED_CLAUDE_ARGS`, without session, tool grants, persona or MCP flags.
- `src/runner/pty-supervisor.ts:1674`: `runOnceOnPty` creates/removes an empty cwd, disables multiplexer configuration, but does not remove Claude's external project transcript directory.
- `src/runner/pty-supervisor.ts:1485`: PTY uses the general runner environment; print's per-caller allowlist is not consulted here. This is a suspected isolation gap to measure, not assume safe.
- `src/oneshot/registry.ts:20`: PTY advertises isolation false. `src/oneshot/config.ts:40` only gives trusted resume routes an implicit PTY default.
- `src/oneshot/print.ts:50`: print consults its async-local caller environment. `src/commands/discord.ts:612` supplies the classifier allowlist.
- Installed local Claude 2.1.304 help explicitly documents `--no-session-persistence` as print-only. Throwaway-config local auth returned loggedIn false; no credentials were accessed/copied. The addendum authorizes CI's existing secret-scoped workflow instead.

## Target behaviour

Capture argv through the actual untrusted `runOnceOnPty` path; prove tools, MCP, settings/hooks, memory, commands, cwd/transcript and environment isolation against real Claude on disposable CI. Every property has a control-removed twin. Remove the unique temp-cwd transcript directory after PTY retirement as compensation for the print-only flag.

Only after every probe and twin succeeds: advertise PTY isolation and default untrusted routes to PTY with pty.enabled true; explicit routes/defaults win, false/Windows defaults use print. Otherwise retain the gate and report the measured failures.

## Frozen decisions

- Brief v2 and addendum replace option B. HTTP stays explicit opt-in. The option B draft and its tests remain in named stashes.
- No local live authentication/model calls. Integration tests run only when CI=true and GITHUB_ACTIONS=true, on a throwaway HOME/config with the workflow's existing token environment; never inspect/log/copy the token.
- A temporary in-test capability override permits the spike to exercise the gated path; it is restored after every test and does not enable production routing.
- Record only argv, nonsecret canaries, statuses and booleans. Do not log raw PTY screens, environments or transcripts, which might contain credentials.
- Use unique temporary directories and restore environment/test seams. Transcript cleanup removes only the project directory derived from that unique temporary cwd, never a parent or another project's files.
- No retrying into a different engine. Red probes block the capability/default change.

## Key files

`src/oneshot/isolation.ts`, `src/oneshot/registry.ts`, `src/oneshot/config.ts`, `src/runner/pty-process.ts`, `src/runner/pty-supervisor.ts`, `tests/integration/untrusted-pty-isolation.test.ts`, `.github/workflows/integration.yml`, `docs/spikes/0.7-interactive-isolation.md`.

## Out of scope

Operator credentials/configuration, #559, unrelated integration failures, PR creation/merge, HTTP defaults, memory-recall Python migration. Leave existing untracked `.planning/559-pty-submit/`, `.serena/` and scratchpad files alone.

## Execution checklist

1. Add CI-only real probes/twins, argv parity and transcript cleanup tests.
2. Observe unit RED, add compensation, inject one missing argv flag and restore.
3. Run scoped unit contracts/lint, bump both versions, commit and push spike only.
4. Dispatch/watch one integration workflow. Record each measured result.
5. If all properties green and twins red, implement Step 3 and dispatch once more; otherwise stop and report blockers.

## r3 ruling (2026-10-20)

The previous failure was a startup blocker, not a red isolation property. Continue with the same branch. Declare the explicit print-only subset beside the canonical constant and derive interactive args by removing exactly it; transcript removal compensates for the persistence flag. Tests pin the subset to only that known exception and reject excluding tools/MCP/settings/commands.

Use the same async-local caller environment as print for untrusted PTYs, without trusted provider augmentation. Because bun-pty merges native parent environment, constrain both its supplied environment and libc inheritance during the synchronous spawn; restore the parent's JS/native state afterwards. No credentials in argv, files or logs. Capture-only and native-inheritance unit tests precede implementation.

Confirm remaining flags with local help without authentication, run unit checks and fault probes, bump both versions and publish. Allow one live workflow plus one startup-blocker retry. Any measured baseline canary leak stops rollout. Only all-green properties with demonstrated red twins authorize capability/default changes and the final workflow.

## r4 fixture diagnosis authorization

Add an unrestricted-argv positive control on the actual ephemeral path with the same child HOME/config fixture. MCP startup, hooks and a question answered from user memory must all fire before their baseline/twin rows count as evidence. Assert the actual child config path mapping and log only its normalized shape; implement a real JSON-RPC MCP stub and bounded marker waits.

Readiness is structural: an assistant transcript entry must exist, without a prescribed answer token. The command flag is probed independently of the sanitizer through an internal spawn-only test callback, never exposed through settings or OneShotRequest. The default sanitizer remains unchanged and its existing unit contracts still apply. Permit one diagnosis workflow and one confirmation after fixture fixes, then a final capability/default workflow only if all rows are proved. Any observed baseline leak stops the rollout immediately.
