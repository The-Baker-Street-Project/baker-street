---
name: test-quality
description: "Test quality specialist — coverage gaps, behavior testing, async assertions, test isolation"
---

# Test Quality Specialist

Reviews test files for quality and identifies missing test coverage. These rules are universal to any TypeScript project using vitest, jest, or similar test runners.

## Scope

- `**/*.test.ts` and `**/*.test.tsx` (test file quality)
- Source files WITHOUT corresponding test files (coverage gaps)

## Context Required

Before applying rules, read:
- **CLAUDE.md** — for testing conventions, test runner, coverage expectations
- **Workspace config** — to identify which packages should have tests

## Rules

### 1. Missing Test Files for Core Logic (Medium, 0.85)
Source files containing core business logic should have companion test files. Look for:
- Service files (`*.service.ts`, `*Service.ts`)
- Handler/action files (`handlers.ts`, `actions.ts`)
- Utility/helper files with exported functions
- Route/controller files (at least integration tests)

The exact naming convention depends on the project — check for `*.test.ts`, `*.spec.ts`, or `__tests__/` patterns already in use.

If no tests exist in the entire project, emit a single Info finding noting this, not individual findings per file.

### 2. Tests Asserting Implementation Not Behavior (Medium, 0.75)
```typescript
// VIOLATION — testing internal implementation
expect(mockDb.insert).toHaveBeenCalledWith(table);
expect(mockDb.insert).toHaveBeenCalledTimes(1);

// CORRECT — testing observable behavior
const result = await service.create(input);
expect(result.name).toBe(input.name);
expect(result.id).toBeDefined();
```
Lower confidence because mock assertions are sometimes appropriate (e.g., verifying a message was published, an email was sent).

### 3. Missing Error Path Tests (Medium, 0.70)
For services with error handling, verify tests cover:
- Successful execution (happy path)
- Invalid input (returns error or throws)
- Dependency failure (database down, API error)
- Edge cases relevant to the domain

### 4. Test Isolation Issues (High, 0.80)
```typescript
// VIOLATION — tests share mutable state without cleanup
let db: Database;
beforeAll(async () => { db = await createTestDb(); });
// Tests modify db without resetting between tests

// CORRECT — isolated per test
beforeEach(async () => {
  db = await createTestDb();
  // OR reset state between tests
});
afterEach(async () => {
  await db.close();
});
```

### 5. Missing async/await in Assertions (High, 0.85)
```typescript
// VIOLATION — assertion never executes the rejection
expect(service.create(badInput)).rejects.toThrow();

// CORRECT
await expect(service.create(badInput)).rejects.toThrow();
```

### 6. Meaningful Test Descriptions (Low, 0.80)
```typescript
// VIOLATION — vague descriptions
it('works', async () => { ... });
it('test 1', async () => { ... });

// CORRECT — describes expected behavior
it('returns 400 when input is missing required fields', async () => { ... });
it('publishes status update after job completion', async () => { ... });
```

### 7. Hardcoded External Dependencies in Unit Tests (Medium, 0.70)
Unit tests should not depend on live external services:
```typescript
// SUSPICIOUS — requires live service for unit test
const nc = await connect({ servers: 'nats://localhost:4222' });
const res = await fetch('http://localhost:3000/api/data');

// BETTER — mock external dependencies
const mockNc = { publish: vi.fn(), subscribe: vi.fn() };
```
Lower confidence because integration tests legitimately use real services.

## Output

Emit findings conforming to `foundations/finding-schema.md` with domain `test-quality`.
