# Sample Prompt: Divide a PRD Into Waves and Parallel Teams

Copy and adapt this prompt to kick off a multi-wave, multi-team project in Claude Code. Replace the bracketed sections with your project specifics.

---

## The Prompt

```
I have a PRD for [PROJECT NAME] that I want to implement using parallel teams.

Here is the PRD:
[PASTE PRD OR REFERENCE FILE PATH]

Here is the current project state:
- Monorepo structure: [list packages/services]
- Build command: [e.g., pnpm -r build]
- Test command: [e.g., pnpm -r test -- --run]
- Deploy command: [e.g., scripts/build.sh && scripts/deploy.sh]
- Current test count: [N] tests passing
- Main branch: main

Please:

1. **Divide the PRD into sequential waves**, where each wave delivers
   a coherent, deployable increment. Earlier waves should deliver
   foundational pieces that later waves build on. Each wave should be
   completable in one session.

2. **For Wave 1, divide the work into 2-4 parallel teams.** Each team
   should:
   - Own a distinct set of files/packages with minimal overlap
   - Be independently buildable and testable
   - Have a clear branch name (`feat/<name>`) and worktree slug

3. **Produce a design document** at `docs/plans/YYYY-MM-DD-wave1-design.md`
   with this structure:
   - Context (what exists, what's missing)
   - Goal (one paragraph)
   - Team Structure table (team, branch, worktree, focus)
   - Per-team sections: Problem, Solution, Design Decisions
   - Execution Plan (worktree creation, agent dispatch, review, merge)
   - Verification criteria per team
   - Deferred items for Wave 2+

4. **Produce an implementation plan** at
   `docs/plans/YYYY-MM-DD-wave1-implementation.md` with:
   - Pre-flight: exact worktree creation commands
   - Per-team task list with:
     - Exact file paths (create/modify)
     - Complete code for each step (not pseudocode)
     - Build verification after each task
     - Commit command with descriptive message
   - Post-implementation checklist (review, fix, PR, merge, deploy)

5. **For each team, include tests.** Every team's last 1-2 tasks should
   be writing tests for what they built. Test tasks should include:
   - The test file path
   - Complete test code with setup, mocking, and assertions
   - The command to run just those tests

6. **Plan for code review after each team completes.** The review should
   check:
   - Plan alignment (all tasks implemented?)
   - Build and test pass
   - Input validation and error handling
   - Type safety
   - Test quality (mocking cleanup, edge cases, failure paths)
   - Security (injection, auth, data exposure)

   Classify findings as Critical (must fix), Important (should fix),
   or Suggestion (nice to have). Only Critical and Important get fixed
   before merge.

After I approve the design and plan, execute as follows:

a. Create the worktrees (inside `.worktrees/`, gitignored)
b. Run `pnpm install` in each worktree
c. Dispatch all teams as parallel subagents (one Task per team, all
   in one message, using Sonnet model for implementation)
d. When teams complete, dispatch parallel code review agents (one per branch)
e. Dispatch parallel fix agents for any Critical/Important findings
f. Push branches, create PRs, merge sequentially (rebase later branches
   on main after earlier ones merge)
g. Run integration build + test on main
h. Build Docker images and deploy
i. Clean up worktrees and branches

Wave 1 should focus on: [DESCRIBE PRIORITIES]
```

---

## Customization Notes

### Adjusting Team Count

- **2 teams**: Best when the work has a natural backend/frontend split
- **3 teams**: Good for backend + frontend + infrastructure/testing
- **4 teams**: Maximum before merge conflicts dominate; use for large refactors

### Adjusting Wave Scope

Each wave should be:
- **Deployable independently** — the system works after each wave
- **Completable in one session** — 8-15 tasks per team max
- **Testable end-to-end** — you can verify the wave's features work

### Emphasizing Test Quality

Add to the prompt if you want stricter testing:

```
For test tasks, require:
- Happy path tests for every new function/endpoint
- Error path tests (invalid input, missing auth, network failure)
- Edge cases (empty arrays, null values, boundary conditions)
- Mock cleanup in afterEach (not inline manual restore)
- No use of array index as React key in test assertions
- Minimum 80% line coverage for new code
```

### Emphasizing Review Rigor

Add to the prompt if you want stricter review:

```
Code review must check:
- All public functions have input validation
- All async operations have error handling
- All DB queries use parameterized values (no string interpolation)
- All API responses have consistent shape (even error responses)
- All timers/intervals are cleaned up on shutdown
- All test mocks are restored in afterEach, not inline
- No TODO/FIXME/HACK comments left in code
- No console.log left in production code
```

---

## Example: What the Output Looks Like

After running this prompt on a real PRD, you get:

**Wave plan:**
```
Wave 1: Foundation (auth, core types, DB schema)
Wave 2: API + UI (CRUD endpoints, pages)
Wave 3: Integration (external services, webhooks, cron)
Wave 4: Polish (error handling, observability, CI/CD)
```

**Team structure (Wave 1):**
```
| Team | Branch              | Worktree           | Focus              |
|------|---------------------|--------------------|--------------------|
| 1    | feat/auth-system    | .worktrees/auth    | Auth + middleware   |
| 2    | feat/core-schema    | .worktrees/schema  | DB schema + types  |
| 3    | feat/test-infra     | .worktrees/testing | Test setup + CI    |
```

**Task example (Team 1, Task 3):**
```markdown
### Task 3: Auth middleware tests

**Files:** Create: `services/api/src/__tests__/auth.test.ts`

**Step 1:** Write the tests
[complete test file with 8-10 test cases]

**Step 2:** Run tests
`pnpm --filter=@project/api test -- --run`
Expected: all tests pass

**Step 3:** Commit
`git add services/api/src/__tests__/auth.test.ts`
`git commit -m "test: add auth middleware unit tests"`
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Subagent can't write to worktree | Worktree is outside project root | Move to `.worktrees/` inside project |
| Build fails in worktree | Missing `pnpm install` | Run install after creating worktree |
| Merge conflicts between teams | Teams edited same file | Merge one first, rebase the other |
| Tests pass per-branch, fail on main | Import conflicts from parallel additions | Create fix/integration PR after merge |
| Agent ignores plan and improvises | Prompt too vague | Add "Follow each step exactly as written" |
| Review finds no issues | Review prompt too generic | Add specific checklist (security, types, cleanup) |
| Deploy fails after merge | K8s manifests unchanged, old pods running | `kubectl rollout restart deployment/<name>` |
