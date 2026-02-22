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

## Review Checklist

1. **Plan alignment** - Are all tasks implemented as specified? Anything missing or extra?
2. **Build passes** - Run: `{BUILD_CMD}`
3. **Tests pass** - Run: `{TEST_CMD}`
4. **Code quality:**
   - TypeScript types correct (no `any` unless justified)
   - Error handling present for async operations and external calls
   - Input validation at system boundaries
   - No hardcoded secrets, credentials, or API keys
5. **Test quality:**
   - Edge cases covered (empty arrays, null values, boundary conditions)
   - Error paths tested (invalid input, missing auth, network failure)
   - Mocks cleaned up in afterEach (not inline manual restore)
   - Tests are deterministic (no timing dependencies)
6. **Security:**
   - No SQL/command injection vectors
   - Auth checks on protected routes
   - Sensitive data not logged or exposed in responses

## Severity Classification

| Severity | Criteria | Action |
|----------|----------|--------|
| **Critical** | Data loss risk, security vulnerability, crash on happy path | Must fix before merge |
| **Important** | Missing validation, test cleanup leak, type mismatch | Should fix, low risk to defer |
| **Suggestion** | Accessibility, debouncing, additional test coverage | Defer to future work |

## Output Format

### Summary
One paragraph: overall assessment (good/needs work), scope of changes, notable patterns.

### Findings

For each finding:

**[SEVERITY] Short description**
- File: `path/to/file.ts:LINE`
- Issue: What is wrong
- Recommendation: Specific fix

### Verdict
- PASS: No Critical or Important findings
- NEEDS_FIX: Has Critical or Important findings (list them)
```
