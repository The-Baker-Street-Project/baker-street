# How To Run Parallel Teams In Claude Code

A practitioner's guide to running multiple parallel implementation teams using Claude Code's subagent architecture. Distilled from 5 waves of development on a Kubernetes-native TypeScript monorepo (32 PRs, 200+ tests, 11 deployed services).

---

## The Core Idea

Claude Code can spawn subagents via the `Task` tool. Each subagent gets its own context window, runs autonomously, and returns a result. By combining subagents with **git worktrees** (isolated working directories sharing the same repo), you can run 2-4 teams in parallel on independent feature branches — each team implementing, building, and testing without interfering with others.

The workflow has six phases:

```
Design  ->  Plan  ->  Worktrees  ->  Parallel Build  ->  Review & Fix  ->  Merge & Deploy
```

---

## Phase 1: Design

Before any code, produce a design document that divides the work into parallel teams. You can use AI to help create the PRD, just make it clear you will be using Claude Code Teams for development. Each team needs:

- **Clear scope boundaries** — which files/packages does each team own?
- **Minimal overlap** — teams that edit the same files create merge conflicts
- **Independent testability** — each team's work can build and test in isolation

### Design Doc Structure

Save to `docs/plans/YYYY-MM-DD-<topic>-design.md`:

```markdown
# Wave N: <Title>

## Context
What exists now. What prior waves delivered. What gaps remain.

## Goal
One paragraph on what this wave achieves.

## Team Structure
| Team | Branch | Worktree | Focus |
|------|--------|----------|-------|
| Team 1 | `feat/<name>` | `.worktrees/<slug>` | Brief scope |
| Team 2 | `feat/<name>` | `.worktrees/<slug>` | Brief scope |

## Team 1: <Name>
### Problem
### Solution
### Design Decisions

## Team 2: <Name>
(same structure)

## Verification
Per-team acceptance criteria — how you know it works.

## Deferred to Wave N+1
Explicitly list what was punted.
```

### Identifying Good Team Boundaries

The best splits follow package/service boundaries in a monorepo:

| Good Split | Why |
|-----------|-----|
| Backend API vs. UI pages | Different packages, different file trees |
| New service vs. infrastructure | New files vs. config/K8s changes |
| Test suite vs. feature code | Test files rarely conflict with source |

| Bad Split | Why |
|----------|-----|
| Two teams editing the same `api.ts` | Guaranteed merge conflicts |
| Shared types team + consumer team | Consumer blocks on types being done |

When overlap is unavoidable (e.g., both teams add to a shared `types.ts`), merge one team first and rebase the other.

---

## Phase 2: Implementation Plan

Convert the design into bite-sized tasks with exact file paths, code blocks, build commands, and commit messages. Save to `docs/plans/YYYY-MM-DD-<topic>-implementation.md`.

### Plan Structure

```markdown
# <Feature> Implementation Plan

**Goal:** One sentence.
**Architecture:** 2-3 sentences.
**Tech Stack:** Key libraries.

---

## Pre-Flight: Create Worktrees
(exact shell commands)

## Team 1: <Name>
**Worktree:** `.worktrees/<slug>`
**Branch:** `feat/<name>`

### Task 1: <Component>
**Files:** Create: `path/to/new.ts` | Modify: `path/to/existing.ts`

**Step 1:** Write the code
(code block with complete implementation)

**Step 2:** Build and verify
`pnpm --filter=@scope/pkg build`

**Step 3:** Commit
`git add <files> && git commit -m "feat: description"`

### Task 2: ...

## Post-Implementation
1. Code review each branch
2. Fix findings
3. Push, PR, merge
4. Integration build + test on main
5. Docker build + deploy
```

### Key Principles for Plans

- **Exact file paths** — the subagent has zero context about your project
- **Complete code** — don't write "add validation here," write the actual validation
- **Build after every task** — catch errors immediately, not at the end
- **Commit after every task** — small atomic commits are easier to review and revert
- **One task = one concern** — "add the DB table" and "add the API routes" are separate tasks

---

## Phase 3: Create Worktrees

Worktrees must live **inside the project root** (not as siblings) because Claude Code's macOS sandbox restricts subagent writes to the project directory.

```bash
# Ensure .worktrees/ is gitignored
grep -q '.worktrees/' .gitignore || echo '.worktrees/' >> .gitignore

# Create worktrees from main
git worktree add .worktrees/team-one -b feat/feature-one main
git worktree add .worktrees/team-two -b feat/feature-two main

# Install dependencies in each (required for monorepos)
cd .worktrees/team-one && pnpm install && cd -
cd .worktrees/team-two && pnpm install && cd -
```

### Why Worktrees, Not Just Branches?

- Subagents run concurrently — they can't share a single working directory
- Each worktree has its own `node_modules`, build cache, and file state
- Git worktrees share the `.git` object store, so they're lightweight
- Clean isolation means one team's build errors don't affect another

---

## Phase 4: Dispatch Parallel Teams

Launch one subagent per team using the `Task` tool. All teams dispatch in a **single message** so they run concurrently.

### Agent Prompt Template

Each agent needs:

1. **Full context** — it has no memory of your conversation
2. **Exact paths** — absolute worktree path, not relative
3. **Specific tasks** — reference the plan by task numbers
4. **Build/test commands** — how to verify its own work
5. **Commit instructions** — commit after each task

```
Implement Tasks 1-7 from the Wave 5 plan in the worktree at
`/absolute/path/to/project/.worktrees/team-one`.

The branch is `feat/feature-one`. You are Team 1: Feature Name.

**Plan location:** `/absolute/path/to/project/docs/plans/YYYY-MM-DD-plan.md`

Read the plan file first, then implement each task in order:
- Follow each step exactly as written
- Build after each task: `cd /path/.worktrees/team-one && pnpm -r build`
- Run tests after completing all tasks: `pnpm -r test -- --run`
- Commit after each task with the message specified in the plan
- If a build fails, fix the error before moving to the next task

Do NOT modify files outside your worktree.
```

### Dispatch Pattern

```python
# In Claude Code, send a single message with multiple Task calls:
Task("Team 1: Feature A", agent_prompt_1)  # runs concurrently
Task("Team 2: Feature B", agent_prompt_2)  # runs concurrently
```

### What Model to Use

- **Opus** for complex architectural work (new systems, refactors)
- **Sonnet** for well-specified tasks with clear plans (most implementation work)
- **Sonnet** for fix agents (applying review feedback)

Sonnet is 3-5x faster and significantly cheaper. Use it for any task where the plan provides complete code and clear instructions. Reserve Opus for tasks requiring judgment.

---

## Phase 5: Code Review & Fix

After teams complete, run code review on each branch. This is the quality gate.

### Review Dispatch

Launch review agents in parallel (one per branch):

```
Review the code changes on branch `feat/feature-one` in the worktree at
`/path/.worktrees/team-one`.

Compare against the plan at `/path/docs/plans/YYYY-MM-DD-plan.md`.

Check:
1. Plan alignment — are all tasks implemented as specified?
2. Build passes — `pnpm -r build`
3. Tests pass — `pnpm -r test -- --run`
4. Code quality — TypeScript errors, missing error handling, security issues
5. Test quality — are edge cases covered? Are mocks cleaned up properly?

Classify findings as Critical, Important, or Suggestion.
Report file paths, line numbers, and specific recommendations.
```

### Fix Dispatch

After reviews return, dispatch fix agents in parallel:

```
Fix the code review findings in the worktree at `/path/.worktrees/team-one`.
Branch: `feat/feature-one`.

Findings to fix:
1. [paste Critical and Important findings with file paths and recommendations]

After fixing:
1. Build: `pnpm -r build`
2. Test: `pnpm -r test -- --run`
3. Commit: `git add -A && git commit -m "fix: address code review findings"`
```

### Review Severity Guide

| Severity | Action | Example |
|----------|--------|---------|
| Critical | Must fix before merge | Data loss risk, security vulnerability, crash on happy path |
| Important | Should fix, low risk to defer | Missing input validation, test cleanup leak, type mismatch |
| Suggestion | Nice to have | Accessibility attrs, debouncing, additional test coverage |

---

## Phase 6: Merge & Deploy

### Merge Strategy

Merge teams **sequentially** with rebase to handle conflicts:

```bash
# Team 1: push and merge first
cd .worktrees/team-one
git push -u origin feat/feature-one
gh pr create --title "feat: Feature One" --body "..."
gh pr merge <number> --merge --admin

# Pull merged result into main
cd /project/root
git pull origin main

# Team 2: rebase on updated main, resolve conflicts, then merge
cd .worktrees/team-two
git fetch origin main
git rebase origin/main
# (resolve any conflicts)
git push -u origin feat/feature-two --force-with-lease
gh pr create --title "feat: Feature Two" --body "..."
gh pr merge <number> --merge --admin
```

### Merge Order

If teams have dependencies, merge the dependency first:
- Team that adds shared types merges before team that consumes them
- Team that modifies infrastructure merges before team that depends on it
- If no dependencies, merge smallest diff first (fewer conflict surfaces)

### Post-Merge Verification

Always verify integration on main after all PRs merge:

```bash
git pull origin main
pnpm install && pnpm -r build && pnpm -r test
```

If integration tests fail (usually import conflicts from parallel type additions), create a small `fix/integration` PR to resolve.

### Deploy

```bash
scripts/build.sh    # Docker images
scripts/deploy.sh   # K8s apply + rollout wait
```

After deploy, verify key endpoints respond:
```bash
curl -s http://localhost:<port>/ping
```

---

## Cleanup

After everything is merged and deployed:

```bash
# Remove worktrees
git worktree remove .worktrees/team-one
git worktree remove .worktrees/team-two

# Delete merged branches
git branch -d feat/feature-one feat/feature-two
```

---

## Lessons Learned

### What Works

- **2-4 teams per wave** is the sweet spot. More teams means more merge conflicts.
- **Sonnet for implementation, Opus for design/review** balances speed and quality.
- **Build after every task** catches errors early instead of compounding them.
- **Code review as a gate** catches real bugs — ID collision risks, stale closures, missing cleanup in tests.
- **Fix agents are fast** — give them the specific findings and they execute precisely.

### Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Worktrees as sibling dirs | Put them in `.worktrees/` inside the project (sandbox) |
| Subagent doesn't know project structure | Include absolute paths and full context in the prompt |
| Teams edit same file | Merge one first, rebase the other |
| Tests pass per-branch but fail on main | Run integration test after all merges |
| Agent takes shortcuts instead of following plan | Be explicit: "Follow each step exactly as written" |
| Review finds too many issues | Fix Critical + Important only; defer Suggestions |
| Forgetting `pnpm install` in worktrees | Include it in the worktree creation script |

### Scaling

| Project Size | Teams per Wave | Tasks per Team | Typical Duration |
|-------------|---------------|----------------|-----------------|
| Small feature | 2 | 3-5 | 5-10 minutes |
| Medium feature set | 3 | 5-8 | 10-20 minutes |
| Large architecture change | 4 | 8-15 | 20-40 minutes |

Above 4 teams, merge conflicts and coordination overhead start to dominate. Split into multiple waves instead.

---

## Quick Reference: The Full Cycle

```
1. Write design doc         docs/plans/YYYY-MM-DD-<topic>-design.md
2. Write implementation plan docs/plans/YYYY-MM-DD-<topic>-implementation.md
3. Create worktrees          git worktree add .worktrees/<slug> -b feat/<name> main
4. Install deps              cd .worktrees/<slug> && pnpm install
5. Dispatch build agents     Task tool, one per team, all in one message
6. Dispatch review agents    Task tool, one per branch, all in one message
7. Dispatch fix agents       Task tool, one per branch, all in one message
8. Push + PR + merge         Sequential: push, gh pr create, gh pr merge
9. Integration test          pnpm -r build && pnpm -r test on main
10. Build + deploy           scripts/build.sh && scripts/deploy.sh
11. Cleanup                  git worktree remove, git branch -d
```
