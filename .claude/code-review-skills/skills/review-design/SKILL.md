---
name: review-design
description: "Design system compliance checker. Quick manual check for UI code. Reads CLAUDE.md for project-specific design rules: color tokens, icon library, component states, accessibility, theming."
---

# /review-design — Design System Compliance Checker

**Purpose:** Quick manual verification that UI code follows the project's design system before PRs.

## When to Run

- Before creating any PR that touches TSX files
- After completing any UI component
- As a lightweight alternative to `/code-review` for focused UI checks

## How It Works

1. **Read `CLAUDE.md`** to discover the project's design conventions:
   - Styling approach (Tailwind, CSS modules, styled-components, etc.)
   - Design token system (semantic color classes, CSS variables, etc.)
   - Icon library (Lucide, Heroicons, Material, etc.)
   - Component library (if any)
   - Font conventions
   - Dark/light mode approach

2. **Identify UI packages** from the workspace config

3. **Run the checks below** against those packages

## Checks Performed

### 1. No Raw Hex Colors in Components

```bash
# Find hex color patterns in component files
grep -rn '#[0-9a-fA-F]\{3,6\}' --include="*.tsx" {ui-dirs}/
```

**Pass:** No hardcoded hex colors in components.
**Fail:** Report file:line — suggest using design tokens or utility classes.

Exceptions: Theme config files, CSS token definitions, dynamic computed colors.

### 2. Icon Library Compliance

If CLAUDE.md specifies an icon library:

```bash
# Find imports from unauthorized icon libraries
grep -rn "from ['\"]@heroicons\|from ['\"]react-icons\|from ['\"]@fortawesome\|from ['\"]@mui/icons" --include="*.tsx" {ui-dirs}/
```

**Pass:** Only the project's designated icon library used.
**Fail:** Report file:line for unauthorized icon imports.

Skip if no icon library is specified in CLAUDE.md.

### 3. Loading/Empty/Error States

Check that page components handle all data states:

```bash
# Look for page components
# Verify each has loading, error, and empty state handling
```

**Pass:** All page components handle three states.
**Fail:** Report pages missing state handling.

### 4. Accessibility Basics

```bash
# Find clickable divs without accessibility attributes
grep -rn "onClick=" --include="*.tsx" {ui-dirs}/ | grep -v "button\|Button\|role=\|tabIndex"
```

**Pass:** Interactive elements use semantic HTML or ARIA attributes.
**Warn:** Report potentially inaccessible interactive elements.

### 5. Dark/Light Mode Compliance

If the project supports theme switching:

```bash
# Find hardcoded mode-specific colors
grep -rn "dark:\[#\|dark:bg-\[#" --include="*.tsx" {ui-dirs}/
```

**Pass:** Theme colors use CSS variables or design tokens.
**Fail:** Report hardcoded mode-specific values.

Skip if the project doesn't support dark/light mode.

### 6. Design Token Usage

If CLAUDE.md defines semantic color tokens:

```bash
# Find raw Tailwind color palette classes
grep -rn "bg-blue-\|bg-gray-\|text-blue-\|text-gray-\|border-red-" --include="*.tsx" {ui-dirs}/
```

**Pass:** All colors use semantic token classes.
**Fail:** Report raw palette classes with suggested replacements.

Skip if no design token system is documented.

## Output Format

```
## Design Review Results

### Summary
- Total checks: 6
- Passed: X
- Failed: X
- Skipped: X (no convention documented)

### Violations

#### [FAIL] Raw Hex Colors
- src/components/Header.tsx:45 — Found `#3B82F6`, use design token instead

#### [PASS] Icon Library
Only lucide-react imports found.

#### [SKIP] Design Tokens
No design token system documented in CLAUDE.md.
```

## Integration

The `/code-review` skill provides a more comprehensive, structured version of these checks via the `ui-design-compliance` specialist. Use `/review-design` for quick manual checks; use `/code-review` for formal pre-PR review.
