# Code Review: Feature Flags System

**Review ID:** review-2026-02-19-feature-flags
**Date:** 2026-02-19
**Scope:** changeset (17 files, 1553 insertions, 47 deletions)
**Branch:** feat/feature-flags
**PR:** #42
**Verdict:** PASS

## Summary

| Severity | Count |
|----------|-------|
| Blocker  | 0     |
| High     | 0     |
| Medium   | 1     |
| Low      | 3     |
| Info     | 1     |

The feature flags implementation is well-designed with a clean, extensible registry pattern. The TypeScript types are sound, tests cover core paths, and service integration is consistent. One medium-severity finding relates to information disclosure on the unauthenticated `/ping` endpoint.

## Specialists Run

- typescript-quality
- api-patterns
- security
- test-quality
- ui-design-compliance

---

## Findings

### F1 [Medium] [security] Feature flags exposed on unauthenticated `/ping` endpoint

**File:** `services/brain/src/api.ts:119-125`

The `/ping` endpoint now returns `features.allFlags()` in the response body. This endpoint bypasses authentication (line 31-33) by design since it serves as a health check. This means anyone with network access to the brain service can enumerate which features are enabled/disabled, leaking internal configuration.

**Current code:**
```typescript
res.json({
  status: 'ok',
  service: 'brain',
  mode: features.mode,
  features: features.allFlags(),  // exposed without auth
  timestamp: new Date().toISOString(),
});
```

**Mitigation:** K8s network policies restrict access to brain pods within the `bakerst` namespace. The information is not directly exploitable.

**Recommendation:** Consider either:
- (a) Only include `mode` on `/ping`; move full flag list to an authenticated endpoint (e.g., `GET /system/features`), or
- (b) Accept the risk given network policy isolation and document the decision.

---

### F2 [Low] [typescript-quality] Unsafe type assertion for BAKERST_MODE

**File:** `packages/shared/src/features.ts:74`

```typescript
const mode: BakerstMode = (process.env.BAKERST_MODE as BakerstMode) || 'prod';
```

If `BAKERST_MODE` is set to an invalid value (e.g., `staging`), the `as BakerstMode` cast silently accepts it. Flag resolution then calls `config[mode]` which returns `undefined` (falsy), causing all flags to resolve to `false`. This is unlikely in practice but violates the principle of fail-fast.

**Recommendation:** Validate the mode and fall back to `prod` with a warning:
```typescript
const raw = process.env.BAKERST_MODE;
const mode: BakerstMode = (raw === 'dev' || raw === 'prod') ? raw : 'prod';
if (raw && raw !== mode) {
  logger.warn({ raw, resolved: mode }, 'unknown BAKERST_MODE value, defaulting to prod');
}
```

---

### F3 [Low] [test-quality] No test for invalid BAKERST_MODE values

**File:** `packages/shared/src/__tests__/features.test.ts`

The test suite covers `prod`, `dev`, and unset modes but does not verify behavior when `BAKERST_MODE` is set to an unrecognized value (e.g., `staging`). This is the test-side companion to F2.

**Recommendation:** Add a test case:
```typescript
it('falls back to prod for unknown BAKERST_MODE values', async () => {
  process.env.BAKERST_MODE = 'staging';
  const { createFeatures } = await import('../features.js');
  const f = createFeatures();
  // Should behave like prod (all flags true)
  expect(f.isEnabled('telegram')).toBe(true);
});
```

---

### F4 [Low] [test-quality] No tests for createNoOpMemoryService()

**File:** `services/brain/src/memory.ts:73-87`

The new `createNoOpMemoryService()` function is part of the feature flag integration but has no unit tests. It's a simple stub, but verifying the contract (returns empty arrays, implements all methods) would prevent regression.

**Recommendation:** Add a test in `services/brain/src/__tests__/memory.test.ts`:
```typescript
describe('createNoOpMemoryService', () => {
  it('returns empty results for all operations', async () => {
    const svc = createNoOpMemoryService();
    expect(await svc.search('test')).toEqual([]);
    expect(await svc.list()).toEqual([]);
    const stored = await svc.store('test', 'general');
    expect(stored.id).toBe('noop');
    await expect(svc.remove('id')).resolves.toBeUndefined();
  });
});
```

---

### F5 [Info] [test-quality] Missing integration tests for flag-gated service behavior

**Files:**
- `services/gateway/src/config.ts:38,43` (adapter gating)
- `services/brain/src/brain-state.ts:43-46` (`forceActive()`)
- `services/ui/src/components/Sidebar.tsx` (DEV badge)

No integration tests verify that:
- Gateway disables adapters when feature flags are off
- `forceActive()` correctly bypasses transfer protocol
- Sidebar renders the DEV badge when mode is `dev`

These are lower priority since the feature flag module itself is well-tested, but they would strengthen confidence in the integration layer.

---

## Strengths

1. **Clean, extensible design** — Adding a new flag is a one-liner in `FLAG_REGISTRY`. TypeScript's `keyof typeof` enforces compile-time validity across all consumers.

2. **Proper singleton isolation in tests** — Using `vi.resetModules()` + dynamic `import()` to get fresh module state per test is the correct approach for testing module-level singletons.

3. **Consistent service integration** — All 5 services (brain, worker, gateway, UI, kustomize overlay) follow the same pattern: import `features`, call `isEnabled()`, gate behavior.

4. **No-op stubs** — `createNoOpMemoryService()` and `forceActive()` are clean patterns for gracefully handling disabled features without null checks scattered through business logic.

5. **Good test coverage of core module** — 14 tests covering mode resolution, defaults, overrides, env key conversion, unknown var warnings, and singleton behavior.
