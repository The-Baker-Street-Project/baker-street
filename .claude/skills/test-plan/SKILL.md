---
name: test-plan
description: "TDD-first test planning system. Analyzes task requirements and generates test specifications as executable specs before implementation. Produces it.todo() test stubs, structured plan files, and markdown reports. Supports plan, validate, and refresh modes for team agent integration."
---

# /test-plan — TDD-First Test Planning

**Purpose:** Generate test specifications from task requirements BEFORE implementation. Tests serve as executable specifications that define what the code must do. Designed for iterative use by team agents in a TDD workflow. Project-agnostic — adapts to any TypeScript monorepo.

## Usage

```
/test-plan --task="Implement vendor CRUD service"   # Plan + generate test files
/test-plan --validate                                # Run tests, report pass/fail
/test-plan --refresh                                 # Update plan after implementation changes
```

## Modes

### Full Plan (default — `--task="..."`)

Runs the complete orchestrator FSM. Produces test files with `it.todo()` stubs, a plan JSON file, and a markdown report. Use when starting a new feature.

### Validate (`--validate`)

Runs generated test files and reports results:
- Reads `.test-plan/plan-latest.json` to find generated test files
- Executes tests via Vitest: `pnpm vitest run --reporter=json {files}`
- Updates plan with pass/fail/todo counts
- Does NOT regenerate test files or write a new markdown report

### Refresh (`--refresh`)

Re-analyzes the task after implementation changes:
- Reads current implementation to discover new patterns and changed signatures
- Updates specs for evolved code
- Generates updated test files
- Archives old plan, writes new `plan-latest.json` and markdown report

## Project Discovery (Run Once at Start)

Before entering the FSM, load project context:

1. **Read `CLAUDE.md`** from repo root — learn project conventions, error handling, shared package, test framework
2. **Read `.test-plan/config.json`** if it exists — get team mappings, analyst overrides (see `foundations/project-config.md`)
3. **Read workspace config** — `pnpm-workspace.yaml` or root `package.json` `workspaces` field to discover package boundaries
4. **Identify shared package** — from config `sharedPackage` field, or auto-detect

This context is passed to every analyst.

## Orchestrator FSM (7 States)

### State 1: DISCOVER_ASK

Parse the task description to understand what's being built.

**Inputs:** `--task` argument, current branch name, agent prompt (if team agent)

**Extract:**
- **Entity**: The primary domain entity (vendor, rfi, task, change-order)
- **Package**: Target package (packages/api, packages/db, apps/web)
- **Layer**: Target layer (service, router, schema, component)
- **Operations**: What operations are being built (CRUD, transitions, calculations)

**Layer detection:** Use the task description first. If ambiguous, use file path patterns from `.test-plan/config.json` `layerDetection` field, or defaults:
- `**/services/**` → service
- `**/routers/**` → router
- `**/schema/**` → schema
- `**/*.tsx` → component

**For `--validate` mode:** Skip. Read existing plan from `.test-plan/plan-latest.json`.

**For `--refresh` mode:** Read existing plan, then re-parse to find changes.

### State 2: GATHER_CONTEXT

Read all relevant source files to build the specification context.

**Read in order:**
1. **Zod schemas** from `@buildflow/shared` for the target entity — input schemas, output types, enums
2. **DB schema** from `packages/db` for the target entity — columns, types, defaults, relations, status enums
3. **Enum definitions** from `@buildflow/shared` — status values, WBS categories
4. **Reference implementation** — find an existing service/router for a similar entity to learn the established patterns
5. **CLAUDE.md conventions** — error handling (AppError, ErrorCode), logging, boundary rules, testing expectations

**For `--validate` mode:** Skip. Context already in plan file.

### State 3: SELECT_ANALYSTS

Choose which analysts to run based on the target layer:

| Target Layer | Analysts |
|-------------|----------|
| service | contract-compliance, state-lifecycle, boundary-validation, integration-surface |
| router | contract-compliance, boundary-validation, integration-surface |
| schema | contract-compliance, boundary-validation |
| component | contract-compliance, boundary-validation, integration-surface |

Check `.test-plan/config.json` `analysts` field for overrides (enabled/disabled).

**State-lifecycle exception:** Only include `state-lifecycle` if the entity has a status enum. If no status field exists, skip even for service layer.

**For `--validate` mode:** Skip. Analysts determined by existing plan.

### State 4: DISPATCH_ANALYSTS

For each selected analyst:
1. Read `skills/test-plan/analysts/{name}/SKILL.md`
2. Pass the task context, Zod schemas, DB schema, reference implementation, and CLAUDE.md conventions
3. Analyst produces `TestSpecification[]` (see `foundations/test-case-schema.md`)

Analysts run conceptually in parallel — each operates on the same context independently.

**For `--validate` mode:** Skip. Specifications already in plan file.

### State 5: CONSOLIDATE_PLAN

Merge analyst outputs into a unified plan:

1. **Deduplicate**: If two analysts produced specs for the same behavior (same testFile + describeBlock + similar testName), keep the higher-priority one. If same priority, keep the one with more assertions.

2. **Assign to test files**: Group specs by `testFile` path. Each unique path becomes one generated file.

3. **Calculate summary**: Count totals by priority, analyst, and category.

4. **Determine verdict**:
   - **READY**: All P1 specs generated, context was complete
   - **PARTIAL**: P1 specs generated but some context was missing (e.g., no Zod schema found)
   - **BLOCKED**: Critical context missing (no entity found, no schemas, can't determine layer)

**For `--validate` mode:** Skip. Proceed to running tests.

### State 6: GENERATE_OUTPUT

#### Full/Refresh Mode

1. **Generate test files**: Pass grouped specs to the test writer (see `test-writer/SKILL.md`). The test writer creates `.test.ts` files with `it.todo()` stubs.

2. **Write plan JSON**: Write `.test-plan/plan-latest.json` conforming to `foundations/plan-schema.md`.
   - Archive existing `plan-latest.json` to `plan-{planId}.json` first (if exists)

3. **Write markdown report**: Use template from `foundations/report-template.md`. Save to `docs/test-plans/`.

4. **Update report index**: Prepend to `docs/test-plans/index.md`. Update `docs/test-plans/latest.md`.

#### Validate Mode

1. **Run tests**: Execute generated test files:
   ```bash
   pnpm vitest run --reporter=json {test-file-paths}
   ```

2. **Parse results**: Count passed, failed, todo tests.

3. **Calculate validation verdict**:
   - **ALL_PASS**: All non-todo tests pass
   - **PARTIAL_PASS**: Some pass, some fail
   - **FAILING**: >50% of non-todo tests fail

4. **Update plan**: Add `validation` field to `.test-plan/plan-latest.json`. Bump timestamp.

### State 7: RESPOND

Present summary to the caller.

#### Full/Refresh Mode Response

```
Test Plan: {entity}.{layer} — {verdict}

Task: "{task description}"
Analysts: {list}

Specs: {total} ({p1} P1, {p2} P2, {p3} P3)

Generated files:
  {path} — {testCount} tests ({todoCount} todos)

Plan: .test-plan/plan-latest.json
Report: {reportPath}

Next steps:
  1. Review generated test files
  2. Implement the feature, making tests pass in P1 → P2 → P3 order
  3. Run /test-plan --validate when ready
```

#### Validate Mode Response

```
Test Plan Validation: {entity}.{layer} — {validation verdict}

Results: {passed} passed, {failed} failed, {todo} todo

{If FAILING: list failed tests with error messages}

Plan updated: .test-plan/plan-latest.json

Next steps:
  {ALL_PASS: "Proceed to /code-review"}
  {PARTIAL_PASS: "Fix failing tests, then re-validate"}
  {FAILING: "Major implementation issues — review failing tests"}
```

**Critical:** Always include the plan file path in your response. The calling team agent needs this to track progress.

## Team Agent Integration

This skill is designed for TDD use by team agents. The typical lifecycle:

```
task received → /test-plan --task="..."    (generate specs)
implementing  → fill in it.todo() stubs   (TDD)
"done"        → /test-plan --validate      (verify tests pass)
refactored    → /test-plan --refresh       (update specs)
passing       → /code-review               (quality check)
clean         → create PR
```

See `foundations/team-agent-protocol.md` for the complete workflow.

## Integration with Code Review

The test-plan and code-review skills are complementary:

| Skill | When | What |
|-------|------|------|
| `/test-plan` | Before implementation | Defines what the code SHOULD do |
| `/code-review` | After implementation | Verifies how the code IS written |

Both must pass before creating a PR. See `foundations/team-agent-protocol.md` for the combined workflow.
