# Priority Rubric

Every test specification gets a priority level that determines whether it's a must-have, should-have, or nice-to-have test.

## Priority Levels

| Priority | Label | Description |
|----------|-------|-------------|
| **P1** | Must Have | Directly verifies a core requirement from the task description. If this test fails, the feature doesn't meet its specification. |
| **P2** | Should Have | Correctness beyond bare requirements. Covers defaults, side effects, return type completeness, and constraint boundaries. |
| **P3** | Nice to Have | Extra confidence. Catches subtle issues like error message content, optional field handling, and import boundaries. |

## P1 — Must Have

These tests are non-negotiable. They verify the feature does what was asked.

### Classification Criteria

A test is P1 if it verifies ANY of:

- **Requirement traceability**: A behavior explicitly stated in the task description
  - Task says "create vendor" → test that create returns a vendor
  - Task says "filter by WBS category" → test that list filters by category

- **Valid state transitions**: Every transition defined in the entity's status enum
  - RFI: draft → open, open → answered, answered → closed
  - Each valid transition gets its own P1 test

- **Invalid state transitions**: Every transition NOT in the valid set
  - RFI: closed → open should throw INVALID_STATE
  - At minimum, test 2-3 representative invalid transitions

- **Required field enforcement**: Fields marked as required in Zod schema
  - Create with missing required field → VALIDATION error

- **NOT_FOUND handling**: Entity retrieval with non-existent ID
  - getById with bad ID → NOT_FOUND error

### Examples

```
P1: "Creating a vendor returns all required fields"
P1: "List vendors filters by WBS category"
P1: "RFI submit: draft → open succeeds"
P1: "RFI submit: closed → open throws INVALID_STATE"
P1: "Create with empty title rejects with VALIDATION error"
P1: "Get non-existent vendor ID throws NOT_FOUND"
```

## P2 — Should Have

These tests cover correctness that isn't explicit in the ask but is implied by good engineering.

### Classification Criteria

A test is P2 if it verifies ANY of:

- **Default values**: Fields with defaults are set correctly when omitted from input
  - Created vendor has status 'active' when not specified

- **Side effects**: Timestamps, computed fields, cascading updates
  - createdAt and updatedAt are set on create
  - updatedAt changes on update but createdAt doesn't

- **Constraint boundaries**: Min/max values, string length limits, array constraints
  - Rating value of 0 (at minimum), rating of 5 (at maximum)
  - Rating of -1 (below minimum), rating of 6 (above maximum)

- **Return type completeness**: All expected fields present in response
  - List returns array of vendor objects with id, companyName, etc.

- **Soft-delete behavior**: Deleted records don't appear in list queries
  - After soft-delete, getById still returns the record
  - After soft-delete, list does not include the record

### Examples

```
P2: "Created vendor has default status 'active'"
P2: "createdAt is set automatically on create"
P2: "updatedAt changes on update"
P2: "Rating of 0 is accepted (boundary minimum)"
P2: "Rating of 6 is rejected (above maximum)"
P2: "Soft-deleted vendor excluded from list results"
```

## P3 — Nice to Have

These tests add extra confidence but aren't critical for the feature to be considered implemented.

### Classification Criteria

A test is P3 if it verifies ANY of:

- **Error context quality**: Error messages include relevant IDs or field names
  - NOT_FOUND error includes the requested ID in context

- **Optional field handling**: Behavior when optional fields are omitted vs provided
  - Create without optional 'notes' field succeeds
  - Update with null 'notes' clears the field

- **Import boundary enforcement**: Code imports from correct packages
  - Service doesn't import from router layer
  - All types come from @buildflow/shared

- **Idempotency**: Operations that should be safe to retry
  - Updating with same data doesn't change updatedAt

### Examples

```
P3: "NOT_FOUND error includes vendor ID in context"
P3: "Create without optional notes field succeeds"
P3: "Service does not import from router layer"
P3: "Router uses protectedProcedure (not publicProcedure)"
```

## Priority Distribution Guidelines

For a typical CRUD service with status transitions:

| Priority | Expected % | Typical Count (15-20 total specs) |
|----------|-----------|----------------------------------|
| P1 | 40-50% | 6-10 specs |
| P2 | 30-40% | 5-7 specs |
| P3 | 15-25% | 3-5 specs |

If P1 count is below 40% of total, the analyst is likely missing core requirements. If P3 count exceeds 30%, the analyst is over-indexing on nice-to-haves.

## Priority and Implementation Order

Team agents should implement tests in priority order:
1. All P1 tests pass → feature meets its specification
2. All P2 tests pass → feature is correct beyond the basics
3. All P3 tests pass → feature has comprehensive coverage

A feature can be considered "done" when all P1 and P2 tests pass. P3 failures are noted but don't block merge.
