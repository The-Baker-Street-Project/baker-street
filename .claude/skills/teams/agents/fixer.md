# Team Fixer Prompt Template

Dispatch for branches with Blocker or High review findings (Phase 5, second pass). Only dispatch if the reviewer verdict is FAIL or WARN.

## Placeholders

| Placeholder | Description | Example |
|------------|-------------|---------|
| `{BRANCH_NAME}` | Branch to fix | `feat/security-hardening` |
| `{WORKTREE_PATH}` | Absolute path to worktree | `/Users/gary/repos/myproject/.worktrees/security` |
| `{FINDINGS}` | Pasted Blocker and High findings from reviewer | (see below) |
| `{BUILD_CMD}` | Build command | `cd {WORKTREE_PATH} && pnpm -r build` |
| `{TEST_CMD}` | Test command | `cd {WORKTREE_PATH} && pnpm -r test -- --run` |

## Prompt

```
Fix the code review findings on branch `{BRANCH_NAME}` in the worktree at
`{WORKTREE_PATH}`.

## Findings to Fix

{FINDINGS}

## Rules

1. Fix **Blocker** findings first, then **High**.
2. Ignore **Medium**, **Low**, and **Info** findings entirely — do not fix them.
3. Make minimal, targeted changes. Do not refactor surrounding code.
4. If you disagree with a finding, explain why in your report instead of fixing it.

## After Fixing

1. Build: `{BUILD_CMD}`
2. Test: `{TEST_CMD}`
3. Stage only the files you changed: `git add <file1> <file2> ...`
4. Commit: `git commit -m "fix: address code review findings"`

If build or tests fail after your fixes, debug and fix until they pass.

## Report

For each finding, report one of:
- **Fixed** — What you changed and why
- **Could not fix** — What you tried and what blocked you
- **Disagree** — Why the finding is incorrect or unnecessary

Format:

### Finding: [short description]
**Severity:** Blocker / High
**Status:** Fixed / Could not fix / Disagree
**Details:** [explanation]
```
