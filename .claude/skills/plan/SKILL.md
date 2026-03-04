---
name: plan
description: "Create an implementation plan: explores the codebase, estimates scope, writes a TDD-style task plan, and validates it. Use when you have requirements and need a plan before writing code."
---

# /plan — Implementation Planning

**Purpose:** Explore the codebase, understand the problem, write a validated implementation plan. Enriches the superpowers planning pipeline with codebase discovery and scope estimation.

## Arguments

- `<description>` — what to plan (feature, bug fix, refactor, etc.)
- `--skip-validation` — skip the validation gate (for quick/small plans)
- `--type <bug|feature|refactor|infra>` — hint the plan type (auto-detected if omitted)

## Workflow

### Phase 1: Understand the Problem

1. **Read the request.** Parse the description, issue link, or spec. If an argument references a file path, Linear issue, or GitHub issue, read it.

2. **Classify the plan type** (if not provided via `--type`):

   | Type | Signals | Plan Shape |
   |------|---------|------------|
   | **bug** | "fix", "broken", error messages, stack traces | Root cause → test → fix → verify |
   | **feature** | "add", "implement", "create", new behavior | Interface → tests → impl → integration |
   | **refactor** | "rename", "extract", "move", "clean up" | Characterization tests → transform → verify |
   | **infra** | "deploy", "config", "CI", "k8s", manifests | Config → apply → smoke test |

3. **Ask clarifying questions** if requirements are ambiguous. One question at a time, prefer multiple choice. Don't proceed with assumptions — ask.

### Phase 2: Explore the Codebase

4. **Identify affected areas.** From the requirements, determine which packages/services/files are likely involved.

5. **Read existing code.** For each affected area:
   - Read the main source files
   - Read existing tests (understand current coverage and test patterns)
   - Read relevant types/interfaces from shared packages
   - Check `CLAUDE.md` for project conventions

6. **Map dependencies.** Identify:
   - What imports what (which packages depend on which)
   - Shared types or interfaces that multiple tasks will touch
   - External dependencies (APIs, databases, config) that constrain the design

7. **Check for existing work.** Search for:
   - Related PRs or branches (`gh pr list`, `git branch -a`)
   - Partial implementations or TODOs in the codebase
   - Similar patterns already solved elsewhere in the project

### Phase 3: Scope & Estimate

8. **List the tasks** at a high level (not detailed yet). One line per task.

9. **Estimate scope:**

   | Tasks | Scope | Approach |
   |-------|-------|----------|
   | 1-3 | Small | Write plan inline, skip validation |
   | 4-10 | Medium | Standard plan file with validation |
   | 11+ | Large | Consider splitting into phases/milestones |

10. **Identify risks and blockers:**
    - Tasks that block other tasks (dependency order)
    - Tasks that touch shared files (merge conflict risk)
    - Tasks that are parallelizable (for `/teams` dispatch)
    - Unknowns that need spiking first

11. **Report scope to user** before writing the detailed plan:
    ```
    Scope: M tasks across N packages
    Type: feature/bug/refactor/infra
    Risks: [list]
    Parallelizable: yes/no (N independent streams)

    Proceed with detailed plan?
    ```

### Phase 4: Write the Plan

12. **Invoke `superpowers:writing-plans`** to write the detailed plan.

    Provide it with everything gathered in Phases 1-3:
    - Requirements and clarifications
    - Affected files and existing code context
    - Dependency map
    - Scope estimate and task ordering
    - Risk notes

    The writing-plans skill will produce the full TDD-style plan with exact code, paths, and test commands.

### Phase 5: Validate (unless --skip-validation)

13. **Invoke `superpowers:validating-plans`** to run the 4-specialist validation gate.

    This dispatches design, dev, security, and backlog reviewers in parallel, then presents findings for triage.

### Phase 6: Ready

14. After validation passes (or is skipped), report:
    ```
    Plan ready: docs/plans/YYYY-MM-DD-<feature>.md
    Tasks: N | Scope: small/medium/large
    Validated: yes/no

    Next: run /execute-plan or superpowers:executing-plans to implement.
    ```

## Plan Type Templates

### Bug Fix
```
1. Reproduce: write a failing test that demonstrates the bug
2. Root cause: trace the failure to the source
3. Fix: minimal change to make the test pass
4. Regression: add edge case tests
5. Verify: run full test suite
```

### Feature
```
1. Interface: define types/schemas
2. Tests: write failing tests for each behavior
3. Implementation: make tests pass (one component at a time)
4. Integration: wire components together
5. Edge cases: error handling, validation, boundary conditions
```

### Refactor
```
1. Characterization: write tests that capture current behavior
2. Transform: apply the refactor in small steps
3. Verify: existing + characterization tests still pass
4. Clean up: remove dead code, update imports
```

### Infrastructure
```
1. Config: write/modify manifests, configs, scripts
2. Apply: deploy to target environment
3. Smoke test: verify the change works end-to-end
4. Rollback plan: document how to undo if needed
```

## Notes

- This skill orchestrates — it delegates the heavy lifting to `superpowers:writing-plans` and `superpowers:validating-plans`.
- For small plans (1-3 tasks), `--skip-validation` is reasonable.
- For large plans (11+ tasks), suggest splitting into phases before writing.
- The plan file is the contract. `/execute-plan` reads it literally.
