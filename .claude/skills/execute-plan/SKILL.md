---
name: execute-plan
description: "Execute an implementation plan end-to-end: reads a plan file, implements each task with build/test cycles, runs acceptance validation, and reports readiness. Use when you have a written plan and want to execute it with quality gates."
---

# /execute-plan — Plan Executor

**Purpose:** Execute a written implementation plan end-to-end with per-task build/test cycles and a final acceptance gate.

## Arguments

- `<path>` — path to the plan file (optional; if omitted, finds most recent file in `docs/plans/`)

## Workflow

### Phase 1: Load Plan

1. **Find the plan file:**
   - If a path argument was provided, read that file.
   - Otherwise, find the most recent `.md` file in `docs/plans/` (by filename date prefix or modification time).
   - If no plan file found, stop: "No plan file found. Provide a path or create a plan in docs/plans/."

2. **Parse the plan** into an ordered task list. Tasks are typically numbered sections, headings, or checklist items in the plan.

3. **Report:** "Found N tasks in <plan-file>. Starting execution."

### Phase 2: Per-Task Loop

For each task in order:

#### 2a. Read Requirements
Read the task description from the plan. Understand what files to create/modify and what behavior is expected.

#### 2b. Implement
Follow the plan exactly. Create/modify files as specified. Do not add unplanned features or refactors.

#### 2c. Build
Run the project build command (from `CLAUDE.md` or `package.json`):
```bash
pnpm -r build
```
- If build fails: diagnose, fix, and retry (max 3 attempts).
- If still failing after 3 attempts: stop and report the build failure.

#### 2d. Test
Run tests for changed packages:
```bash
pnpm --filter <changed-package> test -- --run
```
- If tests fail: diagnose, fix, and retry (max 3 attempts).
- If still failing after 3 attempts: stop and report the test failure.

#### 2e. Quick Review
Apply these code-review specialists against the files changed in this task:
- `code-review/specialists/typescript-quality`
- `code-review/specialists/security`

For each finding:
- **Blocker/High**: auto-fix, then re-build and re-test.
- **Medium/Low/Info**: skip (will be caught in Phase 3 full review).

Max 3 auto-fix cycles per finding set.

#### 2f. Commit
Create a commit with a message referencing the plan task:
```
<type>(<scope>): <description>

Task N from <plan-file>
```

#### 2g. Report
Before moving to the next task, output:
```
Task N/M: DONE — <brief summary>
  Files: <list>
  Commit: <sha>
```

If a task fails after retries, output:
```
Task N/M: BLOCKED — <failure description>
```
And stop execution.

### Phase 3: Acceptance Gate

After all tasks are complete:

#### 3a. Full Code Review
Apply ALL code-review specialists against the cumulative changeset:
```bash
git diff origin/main --name-only
```

For each finding:
- **Blocker/High**: auto-fix → rebuild → retest → re-review (max 3 cycles).
- **Medium/Low/Info**: record for the report but do not auto-fix.

#### 3b. Plan Alignment Check
1. Re-read the original plan file.
2. Compare against the cumulative diff (`git diff origin/main`).
3. Verify:
   - All tasks implemented?
   - Implementation matches the plan spec?
   - No unplanned additions (extra files, features, refactors)?
4. Report gaps as Blocker findings.

#### 3c. Run /checkpoint
Invoke the `/checkpoint` skill (lint, build, test) as the final quality gate.

#### 3d. Calculate Verdict
- **PASS**: All tasks done, no Blocker/High findings remain, checkpoint passes, plan alignment is clean.
- **WARN**: All tasks done, only Medium/Low findings remain, checkpoint passes.
- **FAIL**: Any Blocker/High findings remain, checkpoint fails, or plan alignment has gaps.

### Phase 4: Report

Output a structured report:

```
## Execution Report

**Plan:** <plan-file>
**Tasks:** N/N completed

### Per-Task Summary
| # | Description | Commit | Files Changed | Status |
|---|-------------|--------|---------------|--------|
| 1 | ... | abc1234 | 3 | DONE |
| 2 | ... | def5678 | 2 | DONE |

### Code Review Findings
- Blocker: N (N auto-fixed)
- High: N (N auto-fixed)
- Medium: N
- Low: N

### Plan Alignment
- All tasks implemented: YES/NO
- Unplanned changes: NONE / [list]
- Spec deviations: NONE / [list]

### Checkpoint
- Lint: PASS/FAIL
- Build: PASS/FAIL
- Tests: PASS/FAIL

### Verdict: PASS / WARN / FAIL

[If PASS]: Ready to ship. Run /ship or /pr to continue.
[If WARN]: Review Medium/Low findings before shipping.
[If FAIL]: Fix listed issues before shipping.
```

## Key Rules

- **Follow the plan exactly.** Do not add unplanned features, refactors, or "improvements."
- **Stop on persistent failure.** After 3 retries on build or test, stop and report rather than spiraling.
- **Quick review is fast, full review is thorough.** Per-task uses only typescript-quality + security. Acceptance gate uses all specialists.
- **Commits reference the plan.** Every commit message ties back to the task number and plan file.
