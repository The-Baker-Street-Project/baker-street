# Test Case Schema

Every test specification from any analyst MUST conform to this schema.

## TypeScript Interface

```typescript
interface TestSpecification {
  analyst: 'contract-compliance' | 'state-lifecycle' | 'boundary-validation' | 'integration-surface';
  priority: 'P1' | 'P2' | 'P3';
  category: 'happy-path' | 'error-path' | 'edge-case' | 'state-transition' | 'integration' | 'side-effect';
  testFile: string;           // repo-relative path to target .test.ts file
  describeBlock: string;      // describe() label
  testName: string;           // it() label — imperative, specific
  arrangement: string;        // test setup: what data/mocks/state to prepare
  action: string;             // operation to call: function name + args description
  assertions: Assertion[];    // what to verify after the action
  requiresImplementation: boolean; // true = it.todo(), false = full test can be generated
  traceability: string;       // link back to requirement source (task description, schema field, enum value)
}

interface Assertion {
  type: 'equals' | 'contains' | 'throws' | 'defined' | 'undefined' | 'type-check' | 'called-with' | 'length' | 'matches';
  target: string;             // what to check (e.g., "result.companyName", "error.code")
  expected?: string;          // expected value (omit for 'defined'/'undefined')
  description: string;        // human-readable assertion description
}
```

## Field Guidelines

### analyst
The analyst that produced this specification. Must match one of the four analyst identifiers.

### priority
Classification per the priority rubric (`foundations/priority-rubric.md`):
- **P1**: Core requirement from the task ask — must test
- **P2**: Correctness beyond bare requirements — should test
- **P3**: Extra confidence, subtle issues — nice to test

### category
- **happy-path**: Normal operation, valid inputs, expected outcomes
- **error-path**: Invalid inputs, missing data, expected errors
- **edge-case**: Boundary values, empty collections, max lengths
- **state-transition**: Status changes, valid and invalid transitions
- **integration**: Cross-boundary wiring, router-to-service binding
- **side-effect**: Timestamps, computed fields, cascading updates

### testFile
Repo-relative path to where the test file should be created. Follows the project convention: test files live alongside source files.

```
packages/api/src/services/vendor.service.test.ts
packages/api/src/routers/vendor.router.test.ts
packages/db/src/schema/vendor.test.ts
```

### describeBlock
The `describe()` label. Use the function or module name:

```typescript
describe('vendorService', () => {
  describe('create', () => { ... });
});
```

Nested describes group by operation (create, getById, list, update, delete, transition methods).

### testName
The `it()` label. Write as a requirement statement — what the code MUST do:

```typescript
it('returns created vendor with all required fields');
it('rejects empty companyName with VALIDATION error');
it('throws NOT_FOUND for non-existent ID');
```

Rules:
- Start with a verb: returns, throws, rejects, creates, updates, sets, transitions
- Be specific about the expected outcome
- Include the error code or status when testing error paths
- Max 120 characters

### arrangement
Describe test setup in plain English. The test writer uses this to generate setup code:

```
"Create a valid vendor input object with companyName, email, wbsCategories, and contactPhone"
"Insert a vendor record with status 'active' and known ID"
"Prepare input with empty string for companyName"
```

### action
Describe the operation to invoke:

```
"Call vendorService.create(db, input)"
"Call vendorService.getById(db, nonExistentId)"
"Call vendorRouter.createVendor.mutate(input)"
```

### assertions
Array of specific checks. Each assertion maps to an `expect()` call:

```json
[
  {
    "type": "defined",
    "target": "result.id",
    "description": "Returns a UUID id"
  },
  {
    "type": "equals",
    "target": "result.companyName",
    "expected": "input.companyName",
    "description": "Company name matches input"
  },
  {
    "type": "throws",
    "target": "error.code",
    "expected": "VALIDATION",
    "description": "Throws VALIDATION error code"
  }
]
```

### requiresImplementation
- `true`: The implementation doesn't exist yet — generate `it.todo('...')`
- `false`: Enough context exists to generate a full test (e.g., testing a Zod schema directly, or testing an existing utility)

Most specs in a TDD workflow will be `true`. The test writer generates `it.todo()` stubs that are filled in as implementation progresses.

### traceability
Links the spec back to its requirement source. Examples:

```
"Task: Implement vendor CRUD service → create operation"
"Zod schema: createVendorInput requires companyName (string, min 1)"
"Enum: VendorStatus has values active, inactive, suspended"
"CLAUDE.md §Error Handling: use AppError with ErrorCode"
```

## Example Specification

```json
{
  "analyst": "contract-compliance",
  "priority": "P1",
  "category": "happy-path",
  "testFile": "packages/api/src/services/vendor.service.test.ts",
  "describeBlock": "vendorService > create",
  "testName": "returns created vendor with all required fields",
  "arrangement": "Create a valid CreateVendorInput with companyName, email, wbsCategories [SITEWORK], and contactPhone",
  "action": "Call vendorService.create(db, input)",
  "assertions": [
    {
      "type": "defined",
      "target": "result.id",
      "description": "Returns a UUID id"
    },
    {
      "type": "equals",
      "target": "result.companyName",
      "expected": "input.companyName",
      "description": "Company name matches input"
    },
    {
      "type": "equals",
      "target": "result.email",
      "expected": "input.email",
      "description": "Email matches input"
    },
    {
      "type": "defined",
      "target": "result.createdAt",
      "description": "Timestamps are set"
    }
  ],
  "requiresImplementation": true,
  "traceability": "Task: Implement vendor CRUD service → create operation"
}
```
