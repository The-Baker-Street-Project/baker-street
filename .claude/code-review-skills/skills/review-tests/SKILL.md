---
name: review-tests
description: "Test quality verifier. Checks for coverage gaps, behavior-focused testing, proper async assertions, test isolation, and meaningful test descriptions."
---

# /review-tests — Test Quality Verifier

**Purpose:** Verify test quality and identify coverage gaps before PRs.

## When to Run

- Before creating any PR that includes new functionality
- After completing any service or component
- When reviewing any team's work

## How It Works

1. **Read `CLAUDE.md`** to discover the project's test conventions:
   - Test framework (Vitest, Jest, Mocha, etc.)
   - Test runner command (`pnpm test`, `npm test`, `turbo test`, etc.)
   - Test file naming convention (`.test.ts`, `.spec.ts`, `__tests__/`)
   - Test file location (co-located, separate `tests/` dir, etc.)
   - Coverage requirements (if any)
   - Mocking conventions

2. **Identify source directories** from the workspace config

3. **Run the checks below** adapted to the project's conventions

## Checks Performed

### 1. Coverage Gap Detection

For every source file containing core logic (services, handlers, utilities), check for a companion test file:

```bash
# Adapt paths to your project's structure
# Example: find source files and check for companion test files
for f in $(find {source-dirs} -name "*.ts" -not -name "*.test.ts" -not -name "*.d.ts" -not -name "index.ts"); do
  test_file="${f%.ts}.test.ts"
  if [ ! -f "$test_file" ]; then
    echo "MISSING TEST: $f"
  fi
done
```

**Pass:** All core logic files have companion test files.
**Fail:** List files missing tests.

### 2. Behavior vs Implementation Testing

Search for signs of implementation-focused tests:

```bash
# Mock assertion patterns (potential implementation testing)
grep -rn "toHaveBeenCalledWith\|toHaveBeenCalledTimes\|toHaveBeenCalled()" --include="*.test.ts" --include="*.test.tsx" {source-dirs}/
```

**Pass:** Tests primarily assert on return values and state, not mock call counts.
**Warn:** Report files with heavy mock assertions — may be testing implementation.

### 3. Async Assertions

Find assertions that may not be awaited:

```bash
# Missing await on async assertions
grep -rn "expect(.*).rejects\." --include="*.test.ts" {source-dirs}/ | grep -v "await"
grep -rn "expect(.*).resolves\." --include="*.test.ts" {source-dirs}/ | grep -v "await"
```

**Pass:** All async assertions properly awaited.
**Fail:** Report lines with missing await.

### 4. Test Isolation

Check for shared mutable state between tests:

```bash
# Global state without beforeEach cleanup
grep -rn "beforeAll\|afterAll" --include="*.test.ts" {source-dirs}/
# Check if corresponding beforeEach exists for cleanup
```

**Warn:** Report test files using `beforeAll` for mutable state without `beforeEach` cleanup.

### 5. Meaningful Descriptions

Check that test descriptions are specific:

```bash
# Vague test names
grep -rn "it('should work\|it('test\|it('works\|it('check" --include="*.test.ts" {source-dirs}/
```

**Warn:** Report tests with vague descriptions.

### 6. Error Case Testing

Verify services test error scenarios:

```bash
# Check for error assertions in tests (adapt to project's error convention from CLAUDE.md)
grep -rn "toThrow\|rejects\|Error" --include="*.test.ts" {source-dirs}/
```

**Pass:** Test files include error case assertions.
**Warn:** Report test files with no error case testing.

### 7. Hardcoded External Dependencies

Check for tests that depend on external services without mocking:

```bash
# Find real HTTP calls, database connections, or file system access in tests
grep -rn "fetch(\|axios\.\|http\.\|https\.\|createConnection\|mongoose\.connect" --include="*.test.ts" {source-dirs}/
```

**Pass:** Tests mock external dependencies.
**Warn:** Report tests making real external calls.

## Output Format

```
## Test Quality Review Results

### Summary
- Total checks: 7
- Passed: X
- Failed: X
- Warnings: X

### Coverage Gaps
- src/services/vendor.service.ts — NO TEST FILE
- src/models/inspection.ts — NO TEST FILE

### Quality Issues

#### [WARN] Implementation Testing
- src/services/task.service.test.ts:45 — Heavy mock assertions

#### [FAIL] Missing Await
- src/services/rfi.service.test.ts:67 — expect().rejects without await

### Recommendations
1. Add test files for uncovered services
2. Refactor mock-heavy tests to assert on behavior
```

## Integration

```bash
# Run all tests (adapt to project's runner from CLAUDE.md)
pnpm test

# Run with coverage (if supported)
pnpm test -- --coverage
```
