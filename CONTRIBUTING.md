<<<<<<< HEAD
# Contributing to ClaudeClaw+

ClaudeClaw+ is the home for **heavy, opinionated, and architecturally significant work** that is out of scope for the lightweight upstream repo ([`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw)). If your idea fits comfortably in the upstream repo — contribute it there. Work submitted here that is actually lightweight or upstream-suitable won't be merged; it'll be redirected back upstream.

Talk first, code second.
=======
# Contributing to ClaudeClaw

Thanks for contributing. ClaudeClaw is a lightweight, open-source Claude Code daemon — keep that in mind when choosing where your work belongs.
>>>>>>> upstream/master

---

## Where does your contribution belong?

<<<<<<< HEAD
Before opening anything, ask yourself:

| This contribution is... | Contribute to |
|---|---|
| A bug fix, small improvement, or new integration | **[moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw)** |
| A new adapter (Slack, WhatsApp, etc.) | **moazbuilds/claudeclaw** |
| Lightweight and broadly useful | **moazbuilds/claudeclaw** |
| A new subsystem (governance, orchestration, policy, memory) | **ClaudeClaw+** |
| A large architectural change upstream wouldn't want | **ClaudeClaw+** |
| Something that adds significant runtime weight or new dependencies | **ClaudeClaw+** |

**If in doubt, open an issue here describing the idea.** We'll tell you quickly whether it fits ClaudeClaw+ or belongs upstream.
=======
Not everything should come here. ClaudeClaw has a sister project, [**ClaudeClaw+**](https://github.com/TerrysPOV/ClaudeClaw-Plus), for heavier and more opinionated work. Use this table to decide:

| This contribution is... | Contribute to |
|---|---|
| A bug fix or small improvement | **ClaudeClaw** (you're in the right place) |
| A new adapter or integration | **ClaudeClaw** |
| Lightweight and broadly useful | **ClaudeClaw** |
| A new subsystem (governance, orchestration, policy, persistent memory) | **[ClaudeClaw+](https://github.com/TerrysPOV/ClaudeClaw-Plus)** |
| A large architectural change that adds significant runtime weight | **ClaudeClaw+** |
| Something opinionated that most users wouldn't opt into | **ClaudeClaw+** |

ClaudeClaw+ syncs from this repo daily, so everything here lands there too. If you're unsure, open an issue on either repo and we'll point you in the right direction.
>>>>>>> upstream/master

---

## Before opening a PR

<<<<<<< HEAD
Open an [issue](https://github.com/TerrysPOV/ClaudeClaw-Plus/issues) or [discussion](https://github.com/TerrysPOV/ClaudeClaw-Plus/discussions) first. Describe what you want to build and why. This keeps wasted effort near zero — if there's an existing design decision or conflict with in-progress work, better to know before you spend a week coding.

For small, obviously-scoped changes (typos, single-function fixes, docs updates) you can skip this and go straight to a PR.

---

## Scope expectations

**Large, multi-file PRs are fine.** Multi-stage feature stacks are fine. We'd rather merge ambitious work than reject it for size — as long as it belongs here.

If your change is the kind of thing that upstream would consider too heavy or opinionated for the lightweight core, that's exactly what ClaudeClaw+ is for. This is the right place.

---

## Validation checklist

Before opening a PR:

- [ ] `bun test` passes locally
- [ ] `bunx tsc --noEmit` is clean
- [ ] Any docs or setup guidance affected by the change is updated
- [ ] If touching core daemon paths (`src/`, `commands/`): run a quick manual smoke test
=======
- Check the [open issues](https://github.com/moazbuilds/claudeclaw/issues) and existing PRs to avoid duplication
- For anything beyond a small fix, open an issue first to discuss the approach
- Keep the "lightweight" principle in mind: ClaudeClaw runs on low-spec machines, so avoid adding heavy dependencies or new long-lived processes without a strong reason

---

## Validation

Before opening a PR:

- [ ] Run the relevant checks locally
- [ ] Update any docs or setup guidance affected by your change
>>>>>>> upstream/master

---

## Plugin version bumps (CI-enforced)

<<<<<<< HEAD
If your PR changes shipped plugin files under `src/`, `commands/`, `prompts/`, or `.claude-plugin/`, the plugin metadata version **must** be bumped. The CI checks will fail if you skip this.
=======
If your PR changes shipped plugin files under `src/`, `commands/`, `prompts/`, or `.claude-plugin/`, bump the version metadata:
>>>>>>> upstream/master

```bash
bun run bump:plugin-version
bun run bump:marketplace-version
```

Typical rule:
- bump `.claude-plugin/plugin.json` when shipped plugin content changes
- bump `.claude-plugin/marketplace.json` when marketplace metadata should reflect the new version

<<<<<<< HEAD
Docs-only and other non-shipped changes do not require these bumps.

---

## Structural health (Sentrux)

If your PR touches core daemon code, run a Sentrux scan before marking it ready for review:

```
/claudeclaw:start  →  run scan in Claude Code session
```

Or via MCP: `mcp__plugin_sentrux_sentrux__scan`. Keep scores above C. Flag any dimension that drops below — include the report in your PR description.

---

## Syncing with upstream

ClaudeClaw+ stays aligned with [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw) via a daily automated sync. The `.github/workflows/sync-upstream.yml` workflow runs at 07:00 UTC and opens a PR if there are new commits upstream.

**If you see a PR titled "chore: sync upstream":** that's the robot. Review the diff, resolve conflicts if any, and merge. Conflicts are expected when Plus has diverged from upstream in the same files — resolve them manually and document why.

**If you're working on a branch:** rebase onto `main` before opening your PR to minimise merge surface.

---

## Governance and policy code

Features under `src/governance/`, `src/policy/`, or anything touching the tool-call evaluation path require extra care — these affect every Claude invocation in the daemon. Document your invariants. Tests are not optional here.

---

## Proposing features for upstream

Found something in Plus that you think belongs in the lightweight core too? Open a PR upstream at [`moazbuilds/claudeclaw`](https://github.com/moazbuilds/claudeclaw) and link it from here. @moazbuilds makes the call on what fits.
=======
Docs-only and other non-shipped changes do not require these bumps. (CI will tell you if you missed one.)
>>>>>>> upstream/master

---

## Code of conduct

<<<<<<< HEAD
Be decent. Critique code, not people. If something isn't clear, ask — don't assume the worst.

---

## Questions?

Open a [discussion](https://github.com/TerrysPOV/ClaudeClaw-Plus/discussions) or ping [@TerrysPOV](https://github.com/TerrysPOV) in an issue.
=======
Be decent. Critique code, not people.
>>>>>>> upstream/master
