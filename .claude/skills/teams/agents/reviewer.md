# Team Reviewer Prompt Template

Dispatch one instance per branch in Phase 5 (first pass). All reviewers dispatch in a **single message** for concurrency.

## Placeholders

| Placeholder | Description | Example |
|------------|-------------|---------|
| `{BRANCH_NAME}` | Branch to review | `feat/security-hardening` |
| `{WORKTREE_PATH}` | Absolute path to worktree | `/Users/gary/repos/myproject/.worktrees/security` |
| `{PLAN_PATH}` | Absolute path to implementation plan | `/Users/gary/repos/myproject/docs/plans/2026-02-17-wave1-implementation.md` |
| `{TEAM_SECTION}` | Team name/section in the plan | `Team 1: Security Hardening` |
| `{BUILD_CMD}` | Build command | `cd {WORKTREE_PATH} && pnpm -r build` |
| `{TEST_CMD}` | Test command | `cd {WORKTREE_PATH} && pnpm -r test -- --run` |

## Prompt

```
Review the code on branch `{BRANCH_NAME}` in the worktree at `{WORKTREE_PATH}`.

Compare against the plan at `{PLAN_PATH}`, section: {TEAM_SECTION}.

## Review Process

### Step 1: Code Review via /code-review

Invoke `/code-review` against the changed files in the worktree. This handles:
- TypeScript quality (types, error handling, logging)
- API patterns (validation, messaging contracts, shutdown)
- Test quality (coverage, isolation, determinism)
- Security (injection, auth, data exposure)

### Step 2: Plan Alignment (manual check)

/code-review does not check plan compliance. Verify these yourself:

1. **Completeness** — Are all tasks in {TEAM_SECTION} implemented? Anything missing?
2. **Accuracy** — Does the implementation match what the plan specifies?
3. **Scope** — Is there extra work beyond the plan? Flag as unplanned additions.

### Step 3: Build & Test

1. Build: `{BUILD_CMD}`
2. Test: `{TEST_CMD}`

## Severity Classification

| Severity | Criteria | Action |
|----------|----------|--------|
| **Blocker** | Data loss risk, security vulnerability, crash on happy path | Must fix before merge |
| **High** | Missing validation, test cleanup leak, type mismatch | Should fix, low risk to defer |
| **Medium** | Accessibility, debouncing, additional test coverage | Defer to future work |
| **Low** | Style nits, naming preferences | Optional |
| **Info** | Observations, suggestions for future | No action needed |

## Output Format

### Summary
One paragraph: overall assessment (good/needs work), scope of changes, notable patterns.

### Code Review Findings
Include the structured findings from `/code-review` (severity, file, issue, recommendation).

### Plan Alignment Findings
For each finding:

**[SEVERITY] Short description**
- Issue: What is wrong
- Recommendation: Specific fix

### Verdict
- **PASS**: No Blocker or High findings
- **WARN**: Has High findings but no Blockers
- **FAIL**: Has Blocker findings (list them)
```
