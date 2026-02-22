# Agent Teams Spawn Command

After enabling the feature and creating worktrees for Wave 1:

Create an agent team with 3 teammates for Wave 1 of the Baker Street architecture upgrade:

- Teammate 1 (Security): Work in ../Baker Street-security worktree on feat/security-hardening
  branch.
  Add auth middleware to brain API, network policies, pod security contexts, per-pod
  secret scoping.
  Files: api.ts, K8s manifests, gateway brain-client.ts, UI login page.

- Teammate 2 (MCP Infrastructure): Work in ../Baker Street-mcp worktree on
  feat/mcp-infrastructure branch.
  Build McpClientManager (stdio+HTTP), SkillRegistry (SQLite), Tier 0 skill loader.
  Files: NEW mcp-client.ts, skill-registry.ts, skill-loader.ts, db.ts additions, shared
  skill-types.ts.

- Teammate 3 (Model Router): Work in ../Baker Street-model-router worktree on feat/model-router
  branch.
  Build ModelRouter with Anthropic/OpenRouter/Local providers. Parameterize model in
  agent.ts and observer.ts.
  Files: NEW model-router.ts, model-config.ts, agent.ts refactor, observer.ts refactor.

Require plan approval from each teammate before they start coding.
Use Sonnet for each teammate.

## Code Review Protocol

Each teammate must follow this iterative review workflow using `/code-review`:

### During Development
- Run `/code-review --quick` after completing each logical chunk of work
- Fix any Blocker findings immediately before continuing
- Fix High findings before moving to the next chunk
- Medium/Low can wait for full review

### Before Creating PR
- Run `/code-review` (full review) when feature is complete
- Read `.code-review/review-latest.json` for the verdict
- **PASS**: Proceed to create PR. Include report path in PR description.
- **WARN**: Fix all High-severity findings, mark as fixed, run `/code-review --verify`, repeat until no High findings remain.
- **FAIL**: Fix all Blocker findings first, then High, then Medium. Mark as fixed, run `/code-review --verify`, repeat until PASS or WARN-with-no-High.
- **ABORT**: Stop all work. Write `.code-review/abort-reason.md` and wait for human intervention.

### Team Scoping
Each teammate can scope reviews to their team's files:
- Security: `/code-review --scope=team --target=security`
- MCP Infrastructure: `/code-review --scope=team --target=mcp-infrastructure`
- Model Router: `/code-review --scope=team --target=model-router`

Team mappings are defined in `.code-review/config.json`.

## Verification

After each wave merge:
1. pnpm install && pnpm -r build — full workspace build
2. pnpm -r test (Wave 2+) — run all tests
3. scripts/build.sh — Docker images build
4. scripts/deploy.sh — K8s deploy
