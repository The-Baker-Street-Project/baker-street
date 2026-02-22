# Team Agent Protocol

This document defines how team agents interact with the test-plan skill. Team agents read this as part of their system instructions.

## Overview

You have access to the `/test-plan` skill for TDD-first development. Use it **before writing implementation code** to generate test specifications that define what your code must do. Tests serve as executable specifications — write tests first, then implement to make them pass.

## TDD Workflow

```
Task received
  → /test-plan --task="..."          ← Generate test plan FIRST
  → Review plan, copy test files
  → Implement feature code           ← Code to make tests pass
  → /test-plan --validate            ← Verify tests pass
  → /code-review --quick             ← Quick quality check
  → /code-review                     ← Full quality review
  → Create PR
```

## When to Invoke

| Moment | Mode | Why |
|--------|------|-----|
| Starting a new feature or service | `/test-plan --task="..."` | Define what the code must do before writing it |
| After implementing, ready to verify | `/test-plan --validate` | Run tests, check pass/fail status |
| After significant implementation changes | `/test-plan --refresh` | Update plan to match evolved requirements |

## Mode Details

### Full Plan (`/test-plan --task="..."`)

Generates a complete test plan with:
- Test specifications organized by priority (P1/P2/P3)
- Generated `.test.ts` files with `it.todo()` stubs
- Plan JSON at `.test-plan/plan-latest.json`
- Report at `docs/test-plans/`

**After receiving the plan:**
1. Read `.test-plan/plan-latest.json` to understand the verdict
2. Review the generated test files — they are your implementation spec
3. Start implementing: make P1 tests pass first, then P2, then P3
4. Fill in `it.todo()` stubs with actual test logic as you implement

### Validate (`/test-plan --validate`)

Runs the generated test files and reports results:
- Reads `.test-plan/plan-latest.json` to find test files
- Executes tests via Vitest
- Updates plan with pass/fail/todo counts
- Reports verdict: ALL_PASS, PARTIAL_PASS, or FAILING

**After validation:**

| Verdict | Action |
|---------|--------|
| ALL_PASS | All implemented tests pass. Proceed to `/code-review`. |
| PARTIAL_PASS | Some tests fail. Fix implementation, re-validate. |
| FAILING | >50% tests fail. Major implementation issues — review the plan. |

### Refresh (`/test-plan --refresh`)

Re-analyzes the task after your implementation has evolved:
- Reads current implementation to discover new patterns
- Updates specs for changed function signatures
- Adds specs for functionality you added beyond the original ask
- Removes specs for functionality you decided not to implement

Use when:
- You've implemented more than what the original plan covered
- Function signatures changed significantly during implementation
- The task requirements evolved mid-development

## Working with Generated Test Files

### Test File Structure

Generated test files use `it.todo()` for specs that need implementation:

```typescript
// packages/api/src/services/vendor.service.test.ts
import { describe, it, expect } from 'vitest';
// import { vendorService } from './vendor.service.js';

/**
 * Test Plan: vendor.service (planId: b7e4f1a2)
 * Task: "Implement vendor CRUD service"
 * Analysts: contract-compliance, boundary-validation, integration-surface
 */
describe('vendorService', () => {
  describe('create', () => {
    it.todo('returns created vendor with all required fields');
    it.todo('rejects empty companyName with VALIDATION error');
  });
});
```

### Filling in Tests

As you implement, convert `it.todo()` to full tests:

```typescript
it('returns created vendor with all required fields', async () => {
  const input = {
    companyName: 'Test Vendor',
    email: 'test@vendor.com',
    wbsCategories: [WbsCategory.SITEWORK],
    contactPhone: '555-0100',
  };

  const result = await vendorService.create(db, input);

  expect(result.id).toBeDefined();
  expect(result.companyName).toBe(input.companyName);
  expect(result.email).toBe(input.email);
  expect(result.createdAt).toBeDefined();
});
```

### Implementation Priority

1. **P1 tests first** — these are your core requirements
2. **P2 tests next** — correctness and robustness
3. **P3 tests last** — extra confidence (optional before merge)

A feature is considered "done" when all P1 and P2 tests pass.

## Integration with Code Review

The test-plan and code-review skills complement each other:

- **test-plan**: Defines what the code SHOULD do (before implementation)
- **code-review**: Verifies how the code IS written (after implementation)

Both must pass before creating a PR:

```
/test-plan --validate     → ALL_PASS or PARTIAL_PASS with no P1 failures
/code-review              → PASS or WARN with no Blockers
```

## Example Lifecycle

```
# TDD phase — define tests first
/test-plan --task="Implement vendor CRUD service with rating calculation"
# → Generates vendor.service.test.ts with 18 it.todo() stubs
# → Verdict: READY

# Implementation phase — make tests pass
[implement vendorService.create]
[fill in create tests]
[implement vendorService.getById]
[fill in getById tests]
# ... continue for each operation

# Validation phase — verify implementation
/test-plan --validate
# → PARTIAL_PASS (15 pass, 2 fail, 1 todo)
[fix the 2 failing tests]
/test-plan --validate
# → ALL_PASS

# Quality phase — code review
/code-review --quick
# → PASS
/code-review
# → PASS
[create PR]
```
