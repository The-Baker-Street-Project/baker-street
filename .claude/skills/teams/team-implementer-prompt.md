# Team Implementer Prompt Template

Dispatch one instance per team in Phase 4. All teams dispatch in a **single message** for concurrency.

## Placeholders

| Placeholder | Description | Example |
|------------|-------------|---------|
| `{TEAM_NAME}` | Human-readable team name | `Security Hardening` |
| `{WORKTREE_PATH}` | Absolute path to worktree | `/Users/gary/repos/myproject/.worktrees/security` |
| `{BRANCH_NAME}` | Git branch name | `feat/security-hardening` |
| `{PLAN_PATH}` | Absolute path to implementation plan | `/Users/gary/repos/myproject/docs/plans/2026-02-17-wave1-implementation.md` |
| `{TASK_RANGE}` | Task numbers to implement | `Tasks 1-7` |
| `{BUILD_CMD}` | Build command for verification | `cd {WORKTREE_PATH} && pnpm -r build` |
| `{TEST_CMD}` | Test command for final verification | `cd {WORKTREE_PATH} && pnpm -r test -- --run` |

## Prompt

```
You are Team: {TEAM_NAME}.

Implement {TASK_RANGE} from the implementation plan in the worktree at
`{WORKTREE_PATH}`.

Branch: `{BRANCH_NAME}`
Plan: `{PLAN_PATH}`

## Instructions

1. Read the plan file first. Find your team's section and understand all tasks before starting.
2. Implement each task in order, following each step exactly as written.
3. After each task:
   - Build: `{BUILD_CMD}`
   - If the build fails, fix the error before moving to the next task.
   - Commit with the message specified in the plan.
4. After completing all tasks:
   - Run the full test suite: `{TEST_CMD}`
   - If tests fail, fix failures and commit the fixes.

## Rules

- Follow each step exactly as written in the plan. Do not improvise or take shortcuts.
- Do NOT modify files outside your worktree at `{WORKTREE_PATH}`.
- Use absolute paths for all file operations.
- If the plan specifies code, use that code. Do not rewrite it in your own style.
- If a step is ambiguous, implement the most straightforward interpretation.

## Report

When complete, report:

1. **Tasks completed:** List each task with its commit SHA
2. **Build status:** Pass/fail (with error if fail)
3. **Test status:** Pass/fail (N tests passing, M failing)
4. **Files changed:** List of files created or modified
5. **Deviations:** Any differences from the plan and why
```

## Dispatch Example

```python
# In Claude Code, send a single message with all Task calls:
Task(
    description="Team 1: Security",
    prompt=filled_template_1,
    subagent_type="general-purpose",
    model="sonnet"
)
Task(
    description="Team 2: MCP Infra",
    prompt=filled_template_2,
    subagent_type="general-purpose",
    model="sonnet"
)
Task(
    description="Team 3: Model Router",
    prompt=filled_template_3,
    subagent_type="general-purpose",
    model="sonnet"
)
```

All dispatched in one message for concurrent execution.
