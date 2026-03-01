# Validating Plans — Skill Design

**Date:** 2026-03-01
**Status:** Approved

## Motivation

Implementation plans written by `writing-plans` go directly to `executing-plans` with no quality gate. Bad plans (missing tests, security gaps, scope creep, architectural violations) get caught during execution — when fixing them is expensive. A skeptical validation step between writing and execution catches problems early while the plan is still cheap to revise.

## Decision

Build a `validating-plans` skill in the superpowers plugin that:
- Auto-gates the `writing-plans → executing-plans` pipeline
- Dispatches 4 parallel specialist sub-agents for focused review
- Presents findings to the user for human-in-the-loop triage
- Supports "Fix Now", "Create Issue" (Linear), and "Dismiss" per finding
- Iterates until the user is satisfied, then stamps the plan as validated

## Architecture

### File Structure

```
superpowers/skills/validating-plans/
├── SKILL.md                          # Orchestrator skill
├── design-reviewer-prompt.md         # Architecture & patterns specialist
├── dev-reviewer-prompt.md            # Feasibility & test coverage specialist
├── security-reviewer-prompt.md       # OWASP, auth, secrets specialist
└── backlog-reviewer-prompt.md        # Scope & Linear alignment specialist
```

### Pipeline Position

```
writing-plans → validating-plans → executing-plans
```

- `writing-plans` closing directive updated to invoke `validating-plans`
- `executing-plans` checks for a validation stamp; if missing, invokes `validating-plans` first
- Validation stamp appended to plan file header on pass:

```markdown
<!-- Validated: YYYY-MM-DD | Design ✅ | Dev ✅ | Security ✅ | Backlog ✅ -->
```

## Orchestrator Flow

```
1. Read the plan file
2. Read CLAUDE.md + project context
3. Dispatch all 4 specialists in parallel (Agent tool, general-purpose)
4. Collect findings, deduplicate, merge into unified list
5. Present findings to user grouped by severity (Critical → Warning → Info)
6. User triages each finding: Fix Now / Create Issue / Dismiss
7. "Fix Now" → user revises plan → re-run ONLY affected specialists
8. "Create Issue" → file to Linear with finding context, labels, project link
9. Loop until all items triaged
10. Stamp the plan file, announce ready for execution
```

### Triage UX

Findings presented grouped by severity with per-finding action choice:

```
## Plan Validation Findings

### Critical (2)
1. [Security] No input validation on the new API endpoint in Task 3
   → Fix Now | Create Issue | Dismiss

2. [Design] Task 5 introduces a circular dependency between worker and brain
   → Fix Now | Create Issue | Dismiss

### Warning (3)
3. [Dev] Task 2 modifies shared/types.ts but no test covers the new type
   → Fix Now | Create Issue | Dismiss
...
```

User picks actions via `AskUserQuestion` with multiSelect per severity group.

### Re-validation Scope

On "Fix Now" revisions, only specialists that flagged the revised tasks re-run. If a revision touches a new task, all 4 re-run for that task.

## Specialist Designs

### Design Reviewer — Skeptical Architecture Lens

- Does the plan follow existing project patterns (from CLAUDE.md)?
- Circular dependencies, layering violations, coupling issues?
- YAGNI: unnecessary abstraction or premature generalization?
- Are file paths real and consistent with project structure?
- Does the data flow make sense end-to-end?

### Dev Reviewer — Feasibility & Completeness Lens

- Does every task have test coverage specified?
- Are task dependencies correct?
- Missing steps (migrations, config changes, build steps)?
- Do code snippets compile / make syntactic sense?
- Are external dependencies pinned and real?

### Security Reviewer — Threat-First Lens

- OWASP Top 10 against new endpoints, inputs, data flows
- Secrets handling: properly scoped, never hardcoded?
- Auth/authz: respects existing patterns?
- Network exposure: attack surface changes?
- Injection risks in dynamic queries, templates, shell commands

### Backlog Reviewer — Scope & Alignment Lens

- Does scope match the original issue/requirement?
- Scope creep: tasks beyond what was asked?
- Overlap with existing Linear issues?
- Missing follow-up issues the plan assumes but doesn't create?
- Alignment with current milestone and project priorities?

### Shared Output Format

Each specialist returns:

```json
{
  "specialist": "design|dev|security|backlog",
  "pass": true|false,
  "findings": [
    {
      "severity": "critical|warning|info",
      "task": "Task N",
      "title": "Short description",
      "detail": "Full explanation with reasoning",
      "suggestion": "How to fix it"
    }
  ]
}
```

Orchestrator merges, deduplicates (two specialists may flag the same issue from different angles), and sorts by severity.

## Constraints

- **No auto-fix**: The skill never modifies the plan. "Fix Now" means tell the user what to fix and wait.
- **Plan format required**: Expects standard `writing-plans` format (mandatory header, task structure). Rejects non-conforming plans early.
- **Empty findings**: If all specialists pass, stamp immediately — no triage step.
- **Model inherits**: Specialists run as `general-purpose` sub-agents, inheriting the session model.
- **Linear integration**: "Create Issue" files to Linear with title, description (finding detail + task context), auto-applied labels (area + type).

## Integration

- Modifies: `superpowers:writing-plans` (closing directive)
- Modifies: `superpowers:executing-plans` (stamp check)
- Uses: `AskUserQuestion` for triage
- Uses: Linear MCP tools for issue creation
- Uses: `Agent` tool for parallel specialist dispatch
