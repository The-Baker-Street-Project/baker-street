# Validating Plans Skill — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a `validating-plans` skill in the superpowers plugin that gates plan execution with 4 parallel specialist sub-agents and human-in-the-loop triage.

**Architecture:** Orchestrator SKILL.md dispatches 4 specialist sub-agents (design, dev, security, backlog) in parallel via Agent tool. Findings are merged, deduplicated, and presented to the user for triage (fix now / create Linear issue / dismiss). Pipeline integrates between `writing-plans` and `executing-plans`.

**Tech Stack:** Superpowers plugin skill system, Agent tool (general-purpose sub-agents), AskUserQuestion for triage, Linear MCP tools for issue creation.

---

### Task 1: Create Skill Directory and Orchestrator SKILL.md

**Files:**
- Create: `~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/SKILL.md`

**Step 1: Create the skill directory**

```bash
mkdir -p ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans
```

**Step 2: Write the orchestrator SKILL.md**

Create `SKILL.md` with this content:

```markdown
---
name: validating-plans
description: Use when an implementation plan has been written and needs validation before execution, or when executing-plans detects a missing validation stamp
---

# Validating Plans

## Overview

Skeptical quality gate between writing and executing plans. Dispatches 4 parallel specialist sub-agents to review a plan from different angles, then presents findings to the user for triage.

**Core principle:** Plans are cheap to revise, expensive to fix mid-execution. Catch problems before they become code.

**Announce at start:** "I'm using the validating-plans skill to validate this plan before execution."

## When to Use

- After `writing-plans` produces a plan document
- When `executing-plans` detects a missing validation stamp
- When manually invoked on any plan file

## The Process

` ` `dot
digraph validation {
    rankdir=TB;

    "Read plan file + CLAUDE.md + project context" [shape=box];
    "Validate plan format" [shape=diamond];
    "Reject: not standard format" [shape=box style=filled fillcolor=lightyellow];
    "Dispatch 4 specialists in parallel" [shape=box];
    "Merge findings, deduplicate, sort by severity" [shape=box];
    "Any findings?" [shape=diamond];
    "Stamp plan + announce ready" [shape=box style=filled fillcolor=lightgreen];
    "Present findings to user for triage" [shape=box];
    "User triages: Fix Now / Create Issue / Dismiss" [shape=box];
    "File Linear issues for Create Issue items" [shape=box];
    "Any Fix Now items?" [shape=diamond];
    "User revises plan" [shape=box];
    "Re-run affected specialists only" [shape=box];

    "Read plan file + CLAUDE.md + project context" -> "Validate plan format";
    "Validate plan format" -> "Reject: not standard format" [label="invalid"];
    "Validate plan format" -> "Dispatch 4 specialists in parallel" [label="valid"];
    "Dispatch 4 specialists in parallel" -> "Merge findings, deduplicate, sort by severity";
    "Merge findings, deduplicate, sort by severity" -> "Any findings?";
    "Any findings?" -> "Stamp plan + announce ready" [label="none"];
    "Any findings?" -> "Present findings to user for triage" [label="yes"];
    "Present findings to user for triage" -> "User triages: Fix Now / Create Issue / Dismiss";
    "User triages: Fix Now / Create Issue / Dismiss" -> "File Linear issues for Create Issue items";
    "File Linear issues for Create Issue items" -> "Any Fix Now items?";
    "Any Fix Now items?" -> "Stamp plan + announce ready" [label="no"];
    "Any Fix Now items?" -> "User revises plan" [label="yes"];
    "User revises plan" -> "Re-run affected specialists only";
    "Re-run affected specialists only" -> "Merge findings, deduplicate, sort by severity";
}
` ` `

## Dispatching Specialists

Read the plan file content, CLAUDE.md, and gather project context (recent git log, file tree of affected paths). Then dispatch all 4 specialists in a SINGLE message with 4 parallel Agent tool calls:

1. **Design Reviewer** — `./design-reviewer-prompt.md`
2. **Dev Reviewer** — `./dev-reviewer-prompt.md`
3. **Security Reviewer** — `./security-reviewer-prompt.md`
4. **Backlog Reviewer** — `./backlog-reviewer-prompt.md`

Each specialist receives: plan text, CLAUDE.md content, and project context. Each returns structured findings (see prompt templates for format).

## Merging Findings

After all 4 specialists return:
1. Collect all findings into one list
2. Deduplicate: if two specialists flag the same task for the same root issue, merge into one finding noting both perspectives
3. Sort: critical first, then warning, then info
4. Number findings sequentially for triage reference

## Triage Presentation

Present findings grouped by severity using AskUserQuestion. For each finding show:
- `[Specialist]` tag
- Finding title and detail
- Suggested fix

User picks per-finding: **Fix Now** / **Create Issue** / **Dismiss**

Use AskUserQuestion with multiSelect per severity group.

## Handling Triage Results

**Fix Now:** Tell the user what needs to change. Wait for them to revise the plan file. Then re-run ONLY the specialists that had findings on the revised tasks.

**Create Issue:** Use Linear MCP tools to file issues:
- Title: finding title
- Description: finding detail + which plan task + specialist reasoning
- Labels: area label from plan context + relevant type label (security, tech-debt, etc.)
- Project: current project from CLAUDE.md

**Dismiss:** Note dismissal, no action.

## Validation Stamp

When all findings are triaged (no remaining Fix Now items), append stamp to plan file header:

```markdown
<!-- Validated: YYYY-MM-DD | Design ✅ | Dev ✅ | Security ✅ | Backlog ✅ -->
```

Insert immediately after the `---` separator in the plan header.

## Remember

- **Never modify the plan yourself** — "Fix Now" means tell the user what to fix and wait
- **Re-validate scoped** — only re-run specialists that had findings on revised tasks
- **Empty findings = stamp immediately** — no triage step needed
- **Plan format required** — reject early if plan doesn't follow writing-plans format
- **Model inherits** — specialists run as general-purpose sub-agents, inherit session model

## Red Flags

- Stamping a plan without running specialists
- Skipping a specialist because "it probably won't find anything"
- Auto-fixing the plan instead of presenting to user
- Re-running all 4 specialists when only 1 had findings on revised tasks
- Dismissing critical findings without user approval
- Creating issues without sufficient context from the finding

## Integration

**Required pipeline skills:**
- **superpowers:writing-plans** — produces the plan this skill validates
- **superpowers:executing-plans** — consumes the validated plan (checks for stamp)

**Uses:**
- `AskUserQuestion` for triage presentation
- `Agent` tool (general-purpose) for specialist dispatch
- Linear MCP tools for issue creation
```

**Step 3: Verify the file was created correctly**

```bash
cat ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/SKILL.md | head -5
```
Expected: frontmatter with `name: validating-plans`

**Step 4: Commit**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
git add skills/validating-plans/SKILL.md
git commit -m "feat: add validating-plans orchestrator skill"
```

---

### Task 2: Create Design Reviewer Prompt Template

**Files:**
- Create: `~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/design-reviewer-prompt.md`

**Step 1: Write the design reviewer prompt template**

Create `design-reviewer-prompt.md`:

```markdown
# Design Reviewer Prompt Template

Dispatch as a parallel Agent tool call (general-purpose) alongside the other 3 specialists.

**Purpose:** Skeptical architecture review — does this plan follow good design and existing project patterns?

` ` `
Agent tool (general-purpose):
  description: "Design review for plan validation"
  prompt: |
    You are a skeptical Design Reviewer validating an implementation plan.
    Your job is to find architectural problems BEFORE they become code.

    ## Plan Content

    [FULL PLAN TEXT — paste entire plan, do not reference file]

    ## Project Conventions (CLAUDE.md)

    [FULL CLAUDE.md CONTENT]

    ## Project Context

    [Recent git log, file tree of affected paths, any relevant existing code]

    ## Your Review Checklist

    For each task in the plan, evaluate:

    **Pattern compliance:**
    - Does this follow existing project patterns from CLAUDE.md?
    - Are naming conventions respected?
    - Does it use existing utilities/shared code where available?

    **Architecture:**
    - Are there circular dependencies introduced?
    - Are layering boundaries respected (e.g., services don't import from other services)?
    - Is coupling appropriate (not too tight, not artificially loose)?
    - Does the data flow make sense end-to-end?

    **YAGNI:**
    - Does any task introduce unnecessary abstraction?
    - Is there premature generalization (interfaces/factories/strategies for single implementations)?
    - Are there "nice to have" features beyond the stated goal?
    - Could any task be simpler while still meeting requirements?

    **File paths:**
    - Are all file paths consistent with the project structure?
    - Do "Modify" paths reference real files?
    - Are new files placed in the right directories?

    ## Be Skeptical

    Assume the plan author was in a hurry. Question every design decision.
    "Why this approach?" should have a clear answer from the plan.
    If something seems over-engineered, it probably is.

    ## Output Format

    Return ONLY this JSON (no markdown wrapping):

    {
      "specialist": "design",
      "pass": true|false,
      "findings": [
        {
          "severity": "critical|warning|info",
          "task": "Task N",
          "title": "Short description of issue",
          "detail": "Full explanation with reasoning — cite specific plan sections",
          "suggestion": "Concrete fix recommendation"
        }
      ]
    }

    If no issues found, return {"specialist": "design", "pass": true, "findings": []}.
` ` `
```

**Step 2: Verify the file**

```bash
wc -l ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/design-reviewer-prompt.md
```
Expected: ~70 lines

**Step 3: Commit**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
git add skills/validating-plans/design-reviewer-prompt.md
git commit -m "feat: add design reviewer prompt template for plan validation"
```

---

### Task 3: Create Dev Reviewer Prompt Template

**Files:**
- Create: `~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/dev-reviewer-prompt.md`

**Step 1: Write the dev reviewer prompt template**

Create `dev-reviewer-prompt.md`:

```markdown
# Dev Reviewer Prompt Template

Dispatch as a parallel Agent tool call (general-purpose) alongside the other 3 specialists.

**Purpose:** Feasibility and completeness review — can this plan actually be executed as written?

` ` `
Agent tool (general-purpose):
  description: "Dev review for plan validation"
  prompt: |
    You are a skeptical Dev Reviewer validating an implementation plan.
    Your job is to find feasibility gaps and missing steps BEFORE execution begins.

    ## Plan Content

    [FULL PLAN TEXT — paste entire plan, do not reference file]

    ## Project Conventions (CLAUDE.md)

    [FULL CLAUDE.md CONTENT]

    ## Project Context

    [Recent git log, file tree of affected paths, package.json / dependencies]

    ## Your Review Checklist

    For each task in the plan, evaluate:

    **Test coverage:**
    - Does every task specify tests?
    - Are test paths real and consistent with the project test structure?
    - Do tests cover behavior (not just happy path)?
    - Are test commands correct (right test runner, right flags)?

    **Task dependencies:**
    - Are tasks ordered correctly? Does Task N depend on something from Task N+1?
    - Are cross-task dependencies explicit?
    - Could a task fail because a prior task's output doesn't match expectations?

    **Missing steps:**
    - Are there missing migration steps?
    - Missing config changes (env vars, k8s manifests, build config)?
    - Missing build/compile steps between tasks?
    - Missing dependency installations (packages, tools)?

    **Code quality:**
    - Do code snippets in the plan make syntactic sense?
    - Are imports correct for the module system (ESM vs CJS)?
    - Do types match between files?
    - Are external dependencies real packages with correct names?

    **Executability:**
    - Could a developer with zero project context follow these steps exactly?
    - Are commands complete (no assumed environment)?
    - Are expected outputs realistic?

    ## Be Skeptical

    Assume the plan will be executed literally, step by step.
    If a step says "add validation" without showing the code, that's a finding.
    If a command has wrong flags, the executor will hit an error.

    ## Output Format

    Return ONLY this JSON (no markdown wrapping):

    {
      "specialist": "dev",
      "pass": true|false,
      "findings": [
        {
          "severity": "critical|warning|info",
          "task": "Task N",
          "title": "Short description of issue",
          "detail": "Full explanation — cite specific steps or code blocks",
          "suggestion": "Concrete fix with correct code/commands"
        }
      ]
    }

    If no issues found, return {"specialist": "dev", "pass": true, "findings": []}.
` ` `
```

**Step 2: Verify and commit**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
git add skills/validating-plans/dev-reviewer-prompt.md
git commit -m "feat: add dev reviewer prompt template for plan validation"
```

---

### Task 4: Create Security Reviewer Prompt Template

**Files:**
- Create: `~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/security-reviewer-prompt.md`

**Step 1: Write the security reviewer prompt template**

Create `security-reviewer-prompt.md`:

```markdown
# Security Reviewer Prompt Template

Dispatch as a parallel Agent tool call (general-purpose) alongside the other 3 specialists.

**Purpose:** Threat-first security review — does this plan introduce vulnerabilities?

` ` `
Agent tool (general-purpose):
  description: "Security review for plan validation"
  prompt: |
    You are a skeptical Security Reviewer validating an implementation plan.
    Your job is to find security vulnerabilities BEFORE they become code.

    ## Plan Content

    [FULL PLAN TEXT — paste entire plan, do not reference file]

    ## Project Conventions (CLAUDE.md)

    [FULL CLAUDE.md CONTENT]

    ## Project Context

    [Security-relevant context: existing auth patterns, network policies, secrets setup]

    ## Your Review Checklist

    For each task in the plan, evaluate:

    **OWASP Top 10:**
    - Injection: SQL, command, template injection risks in new code?
    - Broken auth: Does new functionality respect existing auth patterns?
    - Sensitive data exposure: Are secrets, tokens, PII handled correctly?
    - XXE / deserialization: Any XML parsing or untrusted deserialization?
    - Broken access control: Does new functionality check authorization?
    - Security misconfiguration: Any defaults left open?
    - XSS: User input rendered without sanitization?
    - Insecure deserialization: Untrusted data being deserialized?
    - Known vulnerabilities: Are new dependencies up to date?
    - Insufficient logging: Are security events logged?

    **Secrets handling:**
    - Are new secrets scoped correctly (not in monolithic secret)?
    - Are secrets ever logged, returned in API responses, or stored in state?
    - Are secrets passed via environment variables (not hardcoded)?
    - Does the plan reference .env-secrets or k8s secrets correctly?

    **Auth & authz:**
    - Do new endpoints require authentication?
    - Is authorization checked (not just authentication)?
    - Are tokens validated correctly?
    - Is the Bearer token pattern from CLAUDE.md followed?

    **Network exposure:**
    - Does anything change the attack surface?
    - Are new ports or services exposed?
    - Do network policies need updating?
    - Are new services properly isolated?

    **Input validation:**
    - Is user input validated at system boundaries?
    - Are file paths sanitized (no path traversal)?
    - Are sizes/lengths bounded?

    ## Be Paranoid

    Assume an attacker will read this plan and target the new code.
    Every new endpoint is an attack surface. Every new input is an injection vector.
    If the plan doesn't explicitly address security for a new feature, that's a finding.

    ## Output Format

    Return ONLY this JSON (no markdown wrapping):

    {
      "specialist": "security",
      "pass": true|false,
      "findings": [
        {
          "severity": "critical|warning|info",
          "task": "Task N",
          "title": "Short description of vulnerability",
          "detail": "Threat explanation — describe the attack scenario",
          "suggestion": "Concrete mitigation with code/config"
        }
      ]
    }

    If no issues found, return {"specialist": "security", "pass": true, "findings": []}.
` ` `
```

**Step 2: Verify and commit**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
git add skills/validating-plans/security-reviewer-prompt.md
git commit -m "feat: add security reviewer prompt template for plan validation"
```

---

### Task 5: Create Backlog Reviewer Prompt Template

**Files:**
- Create: `~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/backlog-reviewer-prompt.md`

**Step 1: Write the backlog reviewer prompt template**

Create `backlog-reviewer-prompt.md`:

```markdown
# Backlog Reviewer Prompt Template

Dispatch as a parallel Agent tool call (general-purpose) alongside the other 3 specialists.

**Purpose:** Scope and alignment review — does this plan stay in scope and align with the backlog?

` ` `
Agent tool (general-purpose):
  description: "Backlog review for plan validation"
  prompt: |
    You are a skeptical Backlog Reviewer validating an implementation plan.
    Your job is to catch scope creep, missing issues, and backlog misalignment
    BEFORE execution begins.

    ## Plan Content

    [FULL PLAN TEXT — paste entire plan, do not reference file]

    ## Project Conventions (CLAUDE.md)

    [FULL CLAUDE.md CONTENT — especially the Linear section for project/label conventions]

    ## Backlog Context

    [If available: current Linear issues, milestone status, project priorities.
     Use Linear MCP tools to fetch: list_issues for the team, get_project status]

    ## Your Review Checklist

    **Scope alignment:**
    - Does the plan's stated Goal match the original issue/requirement?
    - Does every task contribute to that goal?
    - Are there tasks that go beyond what was asked? (scope creep)
    - Are there tasks that are "while we're here" improvements? (gold plating)

    **Missing work:**
    - Does the plan assume follow-up work that isn't tracked?
    - Are there implied dependencies on work that doesn't exist yet?
    - Should any tasks be separate issues instead of part of this plan?
    - Is there documentation, migration, or cleanup work missing?

    **Backlog overlap:**
    - Do any tasks duplicate existing Linear issues?
    - Could any tasks be covered by existing planned work?
    - Are there conflicts with in-progress work by others?

    **Project alignment:**
    - Does this plan fit the current milestone?
    - Is the priority right (is this the most important thing to work on)?
    - Are labels/areas consistent with Linear conventions?

    **Sizing:**
    - Is the plan sized appropriately? (too many tasks for stated scope?)
    - Are individual tasks right-sized (2-5 minutes each per writing-plans convention)?
    - Could the plan be split into smaller deliverables?

    ## Be Skeptical

    Assume the plan author is enthusiastic and wants to build more than necessary.
    Every task should justify its existence against the stated goal.
    "Nice to have" means "shouldn't be in this plan."

    ## Output Format

    Return ONLY this JSON (no markdown wrapping):

    {
      "specialist": "backlog",
      "pass": true|false,
      "findings": [
        {
          "severity": "critical|warning|info",
          "task": "Task N or General",
          "title": "Short description of issue",
          "detail": "Full explanation — reference specific tasks and scope boundaries",
          "suggestion": "Concrete recommendation (remove task, create separate issue, etc.)"
        }
      ]
    }

    If no issues found, return {"specialist": "backlog", "pass": true, "findings": []}.
` ` `
```

**Step 2: Verify and commit**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
git add skills/validating-plans/backlog-reviewer-prompt.md
git commit -m "feat: add backlog reviewer prompt template for plan validation"
```

---

### Task 6: Modify writing-plans to Invoke Validation

**Files:**
- Modify: `~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/writing-plans/SKILL.md`

**Step 1: Read the current writing-plans SKILL.md**

Confirm the current "Execution Handoff" section content.

**Step 2: Add validation gate to the Execution Handoff section**

Insert validation step between saving the plan and offering execution choices. Replace the current "Execution Handoff" section with:

```markdown
## Validation Gate

After saving the plan, validation is REQUIRED before execution:

**"Plan complete and saved. Now validating before execution."**

**REQUIRED SUB-SKILL:** Use superpowers:validating-plans to validate this plan.

Validation must pass (plan stamped) before proceeding to execution handoff.

## Execution Handoff

After validation passes, offer execution choice:

**"Plan validated and ready. Two execution options:**

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

**Which approach?"**

**If Subagent-Driven chosen:**
- **REQUIRED SUB-SKILL:** Use superpowers:subagent-driven-development
- Stay in this session
- Fresh subagent per task + code review

**If Parallel Session chosen:**
- Guide them to open new session in worktree
- **REQUIRED SUB-SKILL:** New session uses superpowers:executing-plans
```

**Step 3: Verify the edit**

Confirm the "Validation Gate" section appears before "Execution Handoff".

**Step 4: Commit**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
git add skills/writing-plans/SKILL.md
git commit -m "feat: add validation gate to writing-plans handoff"
```

---

### Task 7: Modify executing-plans to Check for Validation Stamp

**Files:**
- Modify: `~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/executing-plans/SKILL.md`

**Step 1: Read the current executing-plans SKILL.md**

Confirm the current "Step 1: Load and Review Plan" section.

**Step 2: Add stamp check to Step 1**

Insert a validation stamp check as the first action in "Step 1: Load and Review Plan". Add after "1. Read plan file":

```markdown
### Step 1: Load and Review Plan
1. Read plan file
2. **Check for validation stamp** — look for `<!-- Validated:` comment in plan header
   - If stamp present: proceed to step 3
   - If stamp missing: **REQUIRED SUB-SKILL:** Use superpowers:validating-plans before continuing
3. Review critically - identify any questions or concerns about the plan
4. If concerns: Raise them with your human partner before starting
5. If no concerns: Create TodoWrite and proceed
```

**Step 3: Add validating-plans to the Integration section**

Add to the Integration section:

```markdown
- **superpowers:validating-plans** - REQUIRED: Validates the plan before execution (checks for stamp)
```

**Step 4: Verify the edits**

Confirm stamp check appears in Step 1 and integration reference is added.

**Step 5: Commit**

```bash
cd ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1
git add skills/executing-plans/SKILL.md
git commit -m "feat: add validation stamp check to executing-plans"
```

---

### Task 8: End-to-End Smoke Test

**Files:**
- No files created or modified — this is a verification task

**Step 1: Verify all files exist**

```bash
ls -la ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/
```
Expected: SKILL.md + 4 prompt template files (5 files total)

**Step 2: Verify SKILL.md frontmatter**

```bash
head -4 ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/SKILL.md
```
Expected: YAML frontmatter with `name: validating-plans`

**Step 3: Verify writing-plans has validation gate**

```bash
grep -c "validating-plans" ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/writing-plans/SKILL.md
```
Expected: at least 1 match

**Step 4: Verify executing-plans has stamp check**

```bash
grep -c "Validated:" ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/executing-plans/SKILL.md
```
Expected: at least 1 match

**Step 5: Word count check on SKILL.md**

```bash
wc -w ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/SKILL.md
```
Expected: under 500 words (per writing-skills guidelines)

**Step 6: Verify no syntax issues in YAML frontmatter**

```bash
head -3 ~/.claude/plugins/cache/claude-plugins-official/superpowers/4.3.1/skills/validating-plans/SKILL.md | grep "^name:"
```
Expected: `name: validating-plans`

**Step 7: Final commit for any fixups, then announce completion**

Announce: "Validating-plans skill created. Ready for TDD testing per writing-skills guidelines."
