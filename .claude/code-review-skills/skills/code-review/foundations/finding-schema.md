# Finding Schema

Every finding from any specialist MUST conform to this schema.

## TypeScript Interface

```typescript
interface CodeReviewFinding {
  domain: 'typescript-quality' | 'api-patterns' | 'ui-design-compliance' | 'security' | 'test-quality';
  severity: 'Blocker' | 'High' | 'Medium' | 'Low' | 'Info';
  confidence: number;      // 0.50-1.00, never emit below 0.50
  file: string;            // repo-relative path (e.g., "src/services/auth.ts")
  lineRange?: string;      // e.g., "42-58" or "42"
  title: string;           // max 120 chars, describes the issue
  rationale: string;       // root cause, risk, and impact explanation
  recommendation: string;  // concrete fix instruction
  evidence: string;        // code snippet proving the issue exists
  suggestedPatch?: string; // optional unified-diff format patch
  ruleRef?: string;        // reference to CLAUDE.md rule (e.g., "CLAUDE.md §Error Handling")
}
```

## Field Guidelines

### title
- Max 120 characters
- Start with the issue type: "Missing...", "Invalid...", "Unsafe...", "Unused..."
- Be specific: "Missing input validation on POST /webhook handler" not "Missing validation"

### rationale
- Explain WHY this is a problem, not just WHAT is wrong
- Include risk: "This could lead to..." or "Without this, users can..."
- Reference the CLAUDE.md rule if applicable

### recommendation
- Concrete, actionable instruction
- Include the exact import/code to add when possible
- "Wrap the handler in try-catch and log with the project's logger"

### evidence
- Include the actual code snippet that demonstrates the issue
- Keep to 5-10 lines of relevant code
- Use markdown code blocks with language annotation

### suggestedPatch
- Optional unified diff format
- Only include for straightforward, unambiguous fixes
- Omit for complex refactors that need human judgment

## Example Finding

```json
{
  "domain": "api-patterns",
  "severity": "High",
  "confidence": 0.90,
  "file": "src/api/routes.ts",
  "lineRange": "45-50",
  "title": "Missing error handling on async route handler",
  "rationale": "The /webhook endpoint calls service.process() without try-catch. If the service throws, Express will crash with an unhandled rejection, taking down the server process.",
  "recommendation": "Wrap the route handler in try-catch, log with the project's logger, and return a 500 response",
  "evidence": "```typescript\napp.post('/webhook', async (req, res) => {\n  const result = await service.process(req.body);\n  res.json(result);\n});\n```",
  "suggestedPatch": "```diff\n app.post('/webhook', async (req, res) => {\n+  try {\n     const result = await service.process(req.body);\n     res.json(result);\n+  } catch (err) {\n+    log.error({ err }, 'Webhook processing failed');\n+    res.status(500).json({ error: 'internal server error' });\n+  }\n });\n```",
  "ruleRef": "CLAUDE.md §Error Handling"
}
```
