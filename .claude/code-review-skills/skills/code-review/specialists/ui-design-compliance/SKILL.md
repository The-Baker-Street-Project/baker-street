---
name: ui-design-compliance
description: "UI compliance specialist — React patterns, accessibility, component states, design consistency"
---

# UI Compliance Specialist

Reviews UI/frontend code for React best practices, accessibility, and design consistency. Adapts to the project's design system by reading CLAUDE.md.

## Scope

All `*.tsx` files in UI/web/frontend packages identified during project discovery. Also checks `*.ts` files in those packages that contain component logic (hooks, context, utilities).

## Context Required

Before applying rules, read:
- **CLAUDE.md** — for design system, component library, styling approach (Tailwind, CSS modules, styled-components, etc.)
- **Workspace config** — to identify which packages are frontend/UI

If CLAUDE.md defines a design system with specific tokens, icon library, or component conventions, enforce those. The rules below are the universal baseline.

## Rules

### 1. Loading/Empty/Error States (Medium, 0.80)
Page and data-fetching components should handle all three states:
```tsx
// VIOLATION — only renders data
export function ItemsPage() {
  const { data } = useItems();
  return <ItemTable items={data} />;
}

// CORRECT — handles all states
export function ItemsPage() {
  const { data, isLoading, error } = useItems();
  if (isLoading) return <LoadingSkeleton />;
  if (error) return <ErrorMessage error={error} />;
  if (!data || data.length === 0) return <EmptyState message="No items found" />;
  return <ItemTable items={data} />;
}
```

### 2. Accessible Interactive Elements (Medium, 0.75)
```tsx
// VIOLATION — clickable div without keyboard or screen reader support
<div onClick={handleClick}>Click me</div>

// CORRECT — semantic element
<button onClick={handleClick}>Click me</button>

// OR if button isn't appropriate, add ARIA
<div role="button" tabIndex={0} onClick={handleClick} onKeyDown={handleKeyDown}>
  Click me
</div>
```

### 3. Key Prop on List Items (Low, 0.90)
```tsx
// VIOLATION
{items.map((item) => <ItemCard item={item} />)}

// CORRECT
{items.map((item) => <ItemCard key={item.id} item={item} />)}
```

### 4. Centralized API Client (Medium, 0.80)
UI code should use a centralized API client rather than scattered `fetch` calls:
```typescript
// VIOLATION — raw fetch throughout components
const res = await fetch('/api/items');
const data = await res.json();

// CORRECT — centralized client
import { api } from '../api/client';
const data = await api.getItems();
```
Skip if the project uses a data fetching library (React Query, SWR, tRPC client) that centralizes this differently.

### 5. Streaming/SSE Error Handling (High, 0.80)
Components using Server-Sent Events or streaming must handle connection errors:
```typescript
// VIOLATION — no error handling on stream
const eventSource = new EventSource('/api/stream');
eventSource.onmessage = (e) => handleMessage(e.data);

// CORRECT — handle errors
eventSource.onerror = () => {
  setConnectionStatus('disconnected');
  // Show user feedback, attempt reconnection
};
```

### 6. Design System Compliance (Medium, 0.85)
If CLAUDE.md specifies a design system, enforce it:
- **Icon library**: If specified (e.g., "Lucide icons only"), flag other icon imports
- **Color tokens**: If design tokens are defined, flag raw hex colors or arbitrary Tailwind values
- **Component library**: If specified, flag reimplemented primitives

```tsx
// VIOLATION (if design system specifies Lucide)
import { FaCheck } from 'react-icons/fa';

// CORRECT
import { Check } from 'lucide-react';
```

If no design system is documented in CLAUDE.md, skip this rule entirely.

### 7. No Inline Styles for Theming (Medium, 0.75)
```tsx
// VIOLATION — hardcoded colors bypass theme switching
<div style={{ color: '#3B82F6', backgroundColor: '#1a1a1a' }}>

// CORRECT — use project's styling approach (Tailwind classes, CSS variables, etc.)
<div className="text-blue-400 bg-gray-950">
```
Adapt to the project's styling approach (Tailwind, CSS modules, theme providers, etc.).

## Output

Emit findings conforming to `foundations/finding-schema.md` with domain `ui-design-compliance`.
