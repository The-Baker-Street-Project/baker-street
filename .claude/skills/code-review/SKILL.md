---
name: code-review
description: "Multi-specialist code review system. Runs targeted specialists on changed files and produces structured findings reports with severity ratings and fix recommendations. Supports full review, quick check, and verify-fix modes for team agent integration."
---

# /code-review — Multi-Specialist Code Review

**Purpose:** Automated code review with structured findings, severity ratings, and actionable recommendations. Designed for iterative use by team agents during development. Project-agnostic — adapts to any TypeScript monorepo.

## Usage

```
/code-review                    # Full review: changeset since master
/code-review --quick            # Quick check: uncommitted changes, fast specialists only
/code-review --verify           # Verify fixes: re-check items marked "fixed" in verdict file
/code-review --scope=package --target=packages/api
/code-review --scope=team --target=team-1
/code-review --scope=file --target=src/services/auth.ts
```

## Modes

### Full Review (default)

Runs the complete orchestrator FSM. Produces a markdown report and a verdict JSON file. Use when a feature is complete or at major checkpoints.

### Quick Check (`--quick`)

Lightweight mid-development check:
- Runs only `typescript-quality` and `security` specialists
- Scoped to uncommitted changes: `git diff --name-only`
- Writes `.code-review/review-latest.json` with `mode: "quick"`
- Does NOT generate a markdown report
- Quick verdicts are ephemeral — not archived, replaced by next full review

### Verify Fixes (`--verify`)

Targeted re-check after team agent fixes issues:
- Reads `.code-review/review-latest.json`
- Re-checks ONLY findings with `status: "fixed"`
- Updates each to `"verified"` (resolved) or `"reopened"` (still present)
- Recalculates verdict from remaining `open` + `reopened` findings
- Mutates verdict file in place, bumps timestamp
- Does NOT run a full specialist sweep

## Project Discovery (Run Once at Start)

Before entering the FSM, load project context. This makes all specialists project-aware without hardcoding:

1. **Read `CLAUDE.md`** from repo root — learn project conventions, patterns, allowed tools
2. **Read `.code-review/config.json`** if it exists — get team mappings, scope overrides (see `foundations/project-config.md`)
3. **Read workspace config** — `pnpm-workspace.yaml` or root `package.json` `workspaces` field to discover package boundaries
4. **Identify shared package** — from config `sharedPackage` field, or auto-detect (workspace named `shared`, `common`, or `core`)

This context is passed to every specialist. Specialists use it to apply rules correctly for the specific project.

## Orchestrator FSM (6 States)

### State 1: GATHER_SCOPE

Determine what to review based on scope mode:

**changeset** (default): Files changed since branching from master
```bash
git diff origin/master --name-only
```

**package**: All source files in a named workspace package
```bash
# Path resolved from workspace config
find {package-path}/src -name '*.ts' -o -name '*.tsx'
```

**team**: All packages owned by a specific team
- Read team definitions from `.code-review/config.json` `teams` field
- If no config exists, report error: "Team scope requires `.code-review/config.json` with `teams` defined"

**file**: Single file deep review

**For `--quick` mode:** Override scope to uncommitted changes only:
```bash
git diff --name-only
```

**For `--verify` mode:** Skip this state. Scope is determined by the existing verdict file.

### State 2: SELECT_SPECIALISTS

Based on the files in scope, select which specialists to run:

| File Pattern | Specialist |
|-------------|-----------|
| `*.ts`, `*.tsx` (any) | typescript-quality |
| Files in service/API/server packages (non-UI) | api-patterns |
| `*.tsx` files in UI/web/frontend packages | ui-design-compliance |
| Service code, `.env*`, K8s manifests, scripts, middleware | security |
| `*.test.ts`, `*.test.tsx`, or source files missing test companions | test-quality |

Determine which packages are "service/API" vs "UI" from the workspace config and directory structure. When ambiguous, include the specialist — false negatives are worse than false positives.

Always include typescript-quality. Other specialists selected by file pattern match.

Check `.code-review/config.json` `specialists` field for overrides (enabled/disabled, custom scope).

**For `--quick` mode:** Only `typescript-quality` and `security`, regardless of file patterns.

**For `--verify` mode:** Skip this state. Specialists are determined by the domains of `"fixed"` findings.

### State 3: DISPATCH_SPECIALISTS

For each selected specialist:
1. Read `skills/code-review/specialists/{name}/SKILL.md`
2. Pass the project context (CLAUDE.md conventions, workspace structure, shared package identity)
3. Apply the specialist's rules against each file in scope
4. Collect findings in the standard schema (see `foundations/finding-schema.md`)

**For `--verify` mode:** For each finding with `status: "fixed"`:
1. Identify the specialist by `domain`
2. Re-check ONLY that specific rule against the file at the indicated line range
3. If the issue is resolved → set `status: "verified"`
4. If the issue persists → set `status: "reopened"`

### State 4: REDUCE_FINDINGS

Apply deduplication rules (see `foundations/severity.md`):
1. Same file + overlapping lines + same domain → keep higher severity
2. Same file + overlapping lines + different domains → keep BOTH
3. Same pattern across multiple files → collapse into ONE finding with file list

Apply finding caps:
- file scope: max 25 findings
- changeset scope: max 30 findings
- package scope: max 30 findings
- team scope: max 40 findings

**For `--verify` mode:** Skip deduplication. Only update statuses of existing findings.

### State 5: WRITE_REPORT

Generate report using template from `foundations/report-template.md`.
Save to `docs/code-reviews/` with timestamp filename.
Update `docs/code-reviews/index.md` and `docs/code-reviews/latest.md`.

**Additionally (all modes):** Write the verdict JSON file. See `foundations/verdict-schema.md` for the full contract.

- **Full review:** Archive existing `review-latest.json` to `review-{reviewId}.json`. Write fresh `review-latest.json`.
- **Quick check:** Write `review-latest.json` with `mode: "quick"`. No markdown report. No archive.
- **Verify:** Mutate `review-latest.json` in place. Bump timestamp.

### State 6: RESPOND

Present summary to the caller:
- Verdict (PASS/WARN/FAIL/ABORT)
- Finding counts by severity
- Top 3 most critical findings (for full and quick modes)
- Newly reopened findings (for verify mode)
- Path to verdict file: `.code-review/review-latest.json`
- Path to full report (full mode only)

**Critical:** Always include the verdict file path in your response. The calling team agent needs this to read and act on the results. See `foundations/team-agent-protocol.md` for the action protocol team agents follow.

## Verdict Logic

- **PASS**: 0 open/reopened Blockers, 0 open/reopened High
- **WARN**: 0 open/reopened Blockers, >=1 open/reopened High
- **FAIL**: >=1 open/reopened Blocker (fixable by team agent)
- **ABORT**: >=1 open/reopened Blocker that is system-breaking (architectural flaw, data loss risk, security vulnerability the team should not attempt to fix)

Verdict is calculated from findings where `status` is `open` or `reopened` only. Findings with `fixed`, `verified`, or `wont_fix` do not count toward the verdict.

## Team Agent Integration

This skill is designed for iterative use by team agents in separate worktree sessions. The typical lifecycle:

```
working → /code-review --quick    (periodic mid-development check)
working → /code-review --quick    (periodic)
"done"  → /code-review            (full review)
fixing  → /code-review --verify   (targeted re-check)
passing → create PR
```

See `foundations/team-agent-protocol.md` for the complete team agent action protocol, including how to mark fixes and handle each verdict.

## Integration

This skill produces structured output. The standalone `/review-api`, `/review-design`, and `/review-tests` skills remain available for quick manual checks but may reference project-specific patterns — check their content before use.
