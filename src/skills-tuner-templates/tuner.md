---
name: tuner
description: Multi-mode companion skill for skills-tuner platform. Setup new installation, create new TunableSubject entries, adjust existing config, audit framework state, optimize cost/perf, or report upstream issues. Self-improving through the framework it configures.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
risk_tier: critical
auto_merge_default: false
language: english
triggers:
  - /tuner
  - /tuner setup
  - /tuner create
  - /tuner adjust
  - /tuner audit
  - /tuner optimize
  - /tuner report
  - tune this skill
  - tune the skill
  - improve the tuner
  - audit the skills
  - fix this skill
  - review my skills
  - report a tuner bug
  - configure the tuner
  - skills tuner
  - skills-tuner
  - tune-moi
  - tune moi
  - ajuste-moi
  - ajuste ce skill
  - ameliore le tuner
  - audit le tuner
  - audit les skills
  - reviser mes skills
  - configure le tuner
  - report un bug du tuner
  - ouvre une issue tuner
  - tuner audit
  - tuner setup
---

# Tuner — companion skill

You are the companion skill for the **skills-tuner** platform. The user invokes you to manage their skills-tuner installation across six modes. Read the user message carefully to detect the intended mode. If unclear, ask.

## Mode dispatch

Detect mode from the trigger:

- `/tuner` (no arg) or first-time use → **setup**
- `/tuner create` or "new skill" + tuner context or "tune-moi un skill" → **create**
- `/tuner adjust [name]` or "tune this skill X" or "ajuste ce skill X" → **adjust**
- `/tuner audit` or "audit le tuner" or "review tuner state" → **audit**
- `/tuner optimize` or "reduce tuner cost" → **optimize**
- `/tuner report` or "this looks like a tuner bug" or "ouvre une issue" → **report**

If `~/.config/tuner/config.yaml` does not exist and mode is unclear, default to **setup**. If the verbatim is genuinely ambiguous (e.g. just "tune-moi"), ask the user which mode applies before doing anything.

---

## Mode: setup

Goal: produce a working `~/.config/tuner/config.yaml` aligned with the user's actual skills directory and workflow.

### Step 1 — Welcome (one short paragraph)

Tell the user in 3 sentences:
1. Tuner watches their skills + voice + RAG + MCP configs and proposes improvements.
2. Every change is human-approved, git-versioned, and reversible.
3. Default models stratified by role; override per subject in config.

Ask if they want to proceed (yes/no). If no, exit gracefully.

### Step 2 — Detect the git repo

Scan candidate locations:
- `~/agent/skills`
- `~/.claude/skills`
- `~/skills`
- `~/.config/claude/skills`

For each existing path, run:
- `test -d "$path/.git" && echo "git: yes" || echo "git: no"`
- `find "$path" -maxdepth 1 -name "*.md" | wc -l` (skill count)
- Sample 5 skill files, read their frontmatter, infer dominant `language:` field

Show the user a table:

```
Found candidate directories:
  1. ~/agent/skills          12 skills, git: yes, lang: english
  2. ~/.claude/skills          3 skills, git: no,  lang: french
  3. ~/skills                  not found

Which one should be your tunable surface? [1/2/3/other]
```

If user picks one without git → run `git init -b main` + initial commit.
If user picks `other` → ask path → init if needed.

Save the choice as `storage.git_repo` in config.

### Step 3 — Pattern adjustment

Based on the dominant language detected in step 2:

- **English** → use `DEFAULT_EMOTIONAL_PATTERNS` from `tuner.subjects.skills` as-is
- **French/Quebec** → suggest override with French defaults like `["argent", "ostie", "calisse", "tabarnak", "câline", "criss", "fuck", "shit", "broken"]`. Show the proposed override. Ask: "Override `_EMOTIONAL_PATTERNS` for your installation? [yes/no]"
- **Other language** → ask the user for 5-10 frustration words in their language

Write the override in config under `subjects.skills.emotional_patterns` (with commented examples for transparency).

### Step 4 — Risk philosophy

Ask one question:

```
How cautious do you want the tuner to be?

  conservative — every change requires manual approval (recommended for first month)
  balanced     — low-risk changes auto-merge (skill patches, frontmatter tweaks); medium/high need approval
  aggressive   — low + medium auto-merge; only high-risk and code stay manual
```

Translate the choice to per-subject `auto_merge` settings in the config.

### Step 5 — Subject-by-subject evaluation

For each subject (`skills`, `voice`, `archiviste`, `mcp`, `tools`, `code`, `memory`):

1. Show 2-3 sentence description from `~/agent/skills-tuner/DESIGN.md`.
2. Detect if the user has the surface installed:
   - `voice` → check for Greg/voice files
   - `archiviste` → check for archiviste mcp config
   - `mcp` → check `~/.config/claude/mcp.json`
   - `code` → always present
3. Ask: enabled? proposer model? auto-merge per kind?
4. Skip subjects the user clearly does not have.

### Step 6 — Reflection guide

Ask 3-5 open-ended questions, capture verbatim answers in `~/.config/tuner/reflection-baseline.md`:

1. "Which tasks do you find yourself repeating most often?"
2. "What feedback do you give the assistant that feels redundant?"
3. "Which workflows do you wish improved themselves over time?"
4. "Are there surfaces (voice, RAG, MCP) where errors compound silently?"
5. "What would a perfect tuner notice that a normal one would miss?"

These become a **baseline** to compare against in 30 days during audit mode.

### Step 7 — Generate config + dry-run preview

1. Write `~/.config/tuner/config.yaml` based on all answers.
2. Show the generated YAML to the user, ask to confirm.
3. Run `tuner doctor` (CLI command) to validate setup.
4. Run `tuner run --dry --since 7d --max 3` — show 3 candidate proposals from the past 7 days **without** applying.
5. If the user reacts "these do not match what I want" → loop back to step 6 (re-attune patterns).
6. Suggest: "Run for 1 week with everything manual. Use `/tuner audit` to review. Then `/tuner adjust` to enable auto-merge on patterns you trust."

### Step 8 — Cron + next steps

Show the cron setup command:

```bash
# Add to crontab:
0 3 * * * /usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin tuner run --since 24h
```

Pointer to `/tuner audit` for ongoing review.

End setup.

---

## Mode: create

Goal: when the user creates a new skill (via Claude Code native skill flow or manually), this mode complements that by registering the skill with the tuner.

**Note:** The skills-tuner supports two formats:
- **Directory format** (Anthropic standard, recommended): `<scan_dir>/<name>/SKILL.md` with frontmatter `name:` and `description:` only.
- **Flat format** (legacy): `<scan_dir>/<name>.md` with full frontmatter including `triggers:`.

For new skills, always prefer the directory format. Triggers and risk configuration belong in `~/.config/tuner/config.yaml` under `subjects.skills.overrides`, not in the skill file frontmatter.

### Step 1 — Choose format

Ask: "Format for this new skill: directory (recommended, Anthropic standard) or flat .md (legacy)?"

- **directory** → scaffold `<scan_dir>/<name>/SKILL.md`
- **flat** → create `<scan_dir>/<name>.md` (only if user specifically requests for compatibility)

If directory: ask "Bundle helper scripts? (scaffolds an empty `scripts/` subdirectory)" — yes/no.

### Step 2 — Read or identify the new skill

Detect which skill the user just created:
- Check `git status` of `storage.git_repo` for new `.md` or `SKILL.md` files
- Or ask: "Which skill did you just create? (path or name)"

Read its frontmatter and content.

### Step 3 — Frontmatter focus: name + description

The Anthropic standard requires only two frontmatter fields for discovery:

```yaml
---
name: <skill-name>
description: <what the skill does and when to use it — used by Claude Code skill matcher>
---
```

The `description` is the most important field: Claude Code uses it to automatically discover and load relevant skills. It should start with what the skill does and when to use it (e.g. "Checks service health and system status. Use when asked about infrastructure, services, or system monitoring.").

If the skill file already has `triggers:` or `risk_tier:` in frontmatter: inform the user that these fields are deprecated in the Anthropic format and should move to config.yaml (see Step 4).

### Step 4 — Tuner-specific config in config.yaml (not frontmatter)

If the user wants to configure triggers, risk_tier, or auto_merge for this skill, add them to `~/.config/tuner/config.yaml` under `subjects.skills.overrides`:

```yaml
subjects:
  skills:
    overrides:
      <skill-name>:
        triggers:
          - /my-trigger
          - my keyword
        risk_tier: medium        # low | medium | high | critical
        auto_merge_default: false
    scan_dirs:
      - <ensure the new skill parent dir is listed>
```

Show the proposed config block and ask confirmation before writing.

### Step 5 — Suggest triggers (for config, not frontmatter)

If no triggers are configured yet:

1. Sample 5-10 verbatims that would plausibly invoke this skill, based on its name and description.
2. Show suggestions as a config.yaml `overrides` block (not frontmatter).
3. Ask user to accept/edit/reject.
4. Write to config.yaml under `subjects.skills.overrides.<name>.triggers`.

### Step 6 — Suggest risk_tier (for config)

Based on the skill domain:

- Pure information lookup, summarization, formatting → `low`
- Code editing, file modification → `medium` if scoped, `high` if broad
- Network/API calls, sending messages, financial operations → `high`
- Self-modification of the tuner itself → `critical`

Show recommendation, ask confirmation. Write to `subjects.skills.overrides.<name>.risk_tier` in config.

### Step 7 — Domain-specific pattern hints

If the skill is in a specialized domain, suggest adding domain words to `_EMOTIONAL_PATTERNS`:

- Finance skill → `["loss", "drawdown", "money at stake"]`
- Voice skill → `["bad audio", "cant hear", "static"]`
- Multilingual user (Quebec) → `["tabarnak", "calisse"]` if not already there

User confirms before adding.

End create.
---

## Mode: adjust

Goal: tune an existing skill or subject without going through full setup.

### Step 1 — Identify target

If user wrote `/tuner adjust skill-name` or "tune-moi le skill X", target = that skill.
Otherwise ask: "Which skill or subject? (skill name, or 'voice'/'archiviste'/'skills' for the whole subject)"

### Step 2 — Show current state

Display:
- Current frontmatter (for individual skill)
- Current config block (for whole subject)
- Recent activity from `audit.jsonl` (proposals, approvals, refusals last 30d)
- Any pending proposals for this target

### Step 3 — Offer adjustment menu

```
What would you like to adjust?
  1. Triggers
  2. Risk tier
  3. Auto-merge policy
  4. Proposer model (Sonnet ↔ Opus ↔ Haiku ↔ ML backend)
  5. Scan directories
  6. Emotional/negative/positive patterns
  7. Cool-down period for this skill
  8. Disable / enable
```

For each, walk through the change, show the diff, ask confirmation, write to config.

### Step 4 — Validate + commit config

Run `tuner doctor` to validate.
Commit the config change in the user skills git repo (versioned).

End adjust.

---

## Mode: audit

Goal: surface what is working, what is not, and what to investigate. Read-only — no changes.

### Step 1 — Read tuner state

Read:
- `~/.config/tuner/audit.jsonl` (last 30 days)
- `~/.config/tuner/proposals.jsonl`
- `~/.config/tuner/refused.jsonl`
- `~/.config/tuner/reflection-baseline.md` (the answers from setup step 6)

### Step 2 — Compute metrics per subject

For each enabled subject:
- Total proposals last 30d
- Approval rate
- Top 3 refused pattern_signatures (recurring rejections)
- Top 3 approved pattern_signatures (validated patterns)
- Skills/entities in scan_dirs that **never matched** in 30 days (candidates for removal or trigger improvement)
- Average time-to-decision per proposal
- Survey response rate

### Step 3 — Compute meta-tuner metrics

- Total cost: count Sonnet calls × estimated price + Opus calls × estimated price
- Hardest patterns: clusters that took 3+ proposals before approval
- Self-modify events: any time the `tuner` skill itself was modified (count, last date)

### Step 4 — Render report

Markdown report sectioned per subject:

```
## skills (last 30d)
- 12 proposals, 9 approved (75%), 3 refused
- Top 3 refused: <list pattern_signatures + verbatim sample>
- Skill `find-trading-edge` never matched — candidate for trigger improvement or removal?

## voice (last 30d)
- 4 proposals, 4 approved (100%)
- No refused, perfect approval rate → consider enabling auto_merge?

## meta-tuner
- Cost 30d: $2.34 Sonnet + $12.10 Opus = $14.44
- Avg time-to-decision: 47s (target <60s OK)
- Survey response rate: 84%
- Self-modify events: 1 (2026-04-15: simplified setup mode)
```

### Step 5 — Compare vs reflection baseline

Read `reflection-baseline.md` — the user answers from setup. For each "what I wish improved" item:
- Did the tuner detect related patterns? (search audit log for matching keywords)
- Show: "Goal '<verbatim>' → 0 / 3 / 12 related proposals so far. Try `/tuner adjust` to refine triggers if 0."

### Step 6 — Suggested next actions

Based on metrics, output 1-3 concrete suggestions:
- "Approval rate on `voice` is 100% — enable auto_merge?"
- "3 refused patterns on `skills` recurring weekly — adjust the `_EMOTIONAL_PATTERNS` list?"
- "Skill `X` never matches — `/tuner adjust X` to refine triggers"

Do **not** make changes. User runs `/tuner adjust` for any change.

End audit.

---

## Mode: optimize

Goal: reduce cost and improve perf without sacrificing quality.

### Step 1 — Cost analysis

Compute per role per subject for last 30d:
- Sonnet calls × tokens × $/Mtok
- Opus calls × tokens × $/Mtok
- Haiku calls × tokens × $/Mtok

Identify the top 3 expensive surfaces.

### Step 2 — Suggest model downgrades

For each expensive surface:
- If approval rate >85% **and** subject uses Opus proposer → suggest downgrade to Sonnet, watch for 2 weeks
- If approval rate <50% **and** subject uses Sonnet → suggest upgrade to Opus (quality issue)
- If proposer is `claude_cli` and high call volume → suggest moving to `anthropic_api` with caching

### Step 3 — Latency analysis

For each subject:
- p50 / p90 / p99 time-to-decision
- If p90 > 5 minutes → user might not be seeing notifications. Suggest checking adapter config.

### Step 4 — Storage optimization

- `audit.jsonl` size — if >50MB, suggest archiving old entries
- `proposals.jsonl` size — same
- Backup retention — if `backup_keep` >7 and storage tight, suggest reducing

### Step 5 — Threshold tuning

If a subject has many false positives:
- Suggest raising `confidence_floor` from default 0.65 to 0.75
- Suggest raising `orphan_min_observations` from 2 to 3

### Step 6 — Render plan

Show the user the proposed optimizations, sorted by est. monthly $$ saved + quality risk level. Each item = one-click apply (writes to config) or skip.

End optimize.

---

## Mode: report

Goal: when something is genuinely broken in the framework (not user skill content), help draft an upstream issue with sanitized context.

### Step 1 — Detect or accept the trigger

Trigger sources:
- User invokes `/tuner report` directly
- `/tuner audit` flagged a "framework anomaly" (signed proposal failed verification, schema migration crashed, observation collector hung repeatedly)

If user-invoked, ask: "What seems wrong? Describe in 1-2 sentences."

### Step 2 — Categorize

Classify the issue:
- **Critical bug** — security, data corruption, signature failures
- **Perf/integration bug** — hangs, errors, adapter failures
- **Detection gap** — framework should have caught a pattern but did not
- **Doc bug** — DESIGN.md or README contradicts observed behavior

### Step 3 — Gather environment

```bash
tuner --version
python --version
uname -srm
grep "version" ~/Projects/ClaudeClaw-Plus/package.json 2>/dev/null
```

### Step 4 — Draft issue body

Compose markdown with sections:
- Severity (emoji + tier)
- Category
- Tuner version, Plus version, Python version, OS
- Problem (user 1-2 sentence description)
- Detection logic gap or repro steps
- Suggested investigation
- Logs (sanitized excerpts)
- Footer with "Auto-drafted by /tuner report. User reviewed."

### Step 5 — Sanitize before showing

Apply sanitization to the entire draft:
- Replace `/home/{user}/` → `~/`
- Replace IPs `192.168.x.x` and `100.x.x.x` → `<redacted-ip>`
- Replace emails → `<redacted-email>`
- Replace API key patterns (`sk-ant-`, `ghp_`, `xoxb-`, etc.) → `<redacted-token>`
- Replace absolute paths to `~/.config/`, `~/.ssh/`, `~/.env` → `<redacted-path>`
- Replace any string >32 chars matching `[A-Za-z0-9+/=]+` → `<redacted-base64>`

### Step 6 — Show + approve

Display the full sanitized draft. Ask:

```
[Post Now] [Edit First] [Save Draft] [Cancel]
```

If `Edit First` → open in editor, accept the edited version, re-sanitize, re-show.

### Step 7 — Submit

If `Post Now`:
- Check `~/.config/tuner/config.yaml` for `upstream.allowed_repos` (default: `["TerrysPOV/ClaudeClaw-Plus"]`)
- Try `gh issue create --repo <repo> --label tuner-report --title <title> --body <body>`
- If `gh` not authenticated → fallback: copy markdown to clipboard + open `https://github.com/<repo>/issues/new` in browser

### Step 8 — Log

Append to `audit.jsonl`:

```json
{"event": "upstream_issue_filed", "repo": "...", "issue_url": "...", "category": "...", "ts": "..."}
```

### Step 9 — Rate limit check

Before posting, check audit.jsonl for `upstream_issue_filed` events:
- Last 30 days same category → if ≥3, warn "you have filed 3 similar reports recently — sure?"
- Last 30 days total → if ≥5, require explicit confirmation

End report.

---

## Self-improvement notes (for the framework that watches this skill)

This skill lives in the user tunable surface (e.g. `~/agent/skills/tuner.md`) and is itself a `TunableSubject`. The framework watches user reactions to `/tuner` invocations. If patterns emerge ("the setup questionnaire is too long", "audit output is too verbose", "create mode misses obvious triggers"), the tuner proposes alternatives to this very file.

**Special safeguards** for self-modification:
- This file has `risk_tier: critical` — never auto-merge regardless of global config
- Dead-man switch: if a modification is not re-validated within 7 days post-apply, auto-revert
- Cool-down: 30 days minimum between accepted self-modifications
- Modifications must include a diff (not just A/B/C alternatives) for transparency
- Audit log entries for self-modifications are tagged `event: meta_tuner_self_modify`

If you (Claude Code, reading this skill at runtime) ever propose a modification to your own file, surface the safeguards explicitly to the user before applying.

---

## Closing note

If you are unsure which mode applies, say so and ask the user. Do not guess. The user can combine modes (`/tuner audit` then `/tuner adjust`) — sequential, not nested.
