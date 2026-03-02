# System Prompt Redesign — 2nd Brain / Digital Assistant

**Date:** 2026-03-02
**Status:** Approved

## Goal

Replace the minimal SOUL.md and functional BRAIN.md with rich personality and operational prompts that position the agent as a proactive 2nd brain and personal assistant.

## Design Parameters

- **User scope:** Single user (personal assistant)
- **Personality:** Warm & opinionated — genuine, helpful, has perspective
- **Theming:** None — "Baker" is just a name, no Sherlock Holmes references
- **Use cases:** Equal weight on homelab/dev ops AND personal knowledge/life management
- **Proactivity:** High — anticipatory, makes connections, surfaces relevant context

## Architecture

No code changes. Same two-file pattern loaded by `loadStaticPrompt()` in `services/brain/src/agent.ts`:

1. **SOUL.md** — Identity, personality, values, communication style, proactivity stance
2. **BRAIN.md** — Decision-making, job dispatch, memory philosophy, multi-surface awareness, synthesis

Files are read from `OS_DIR` (default `/etc/bakerst`), `{{AGENT_NAME}}` is replaced with the env var (default "Baker"), and they're joined with `---` separators.

## Key Design Decisions

1. **No USER.md file** — Vector memory (Qdrant) already handles user profile via auto-retrieved memories with categories (personal, gear, homelab, preferences, work). Adding a static user profile file would duplicate this.

2. **"Store aggressively, curate actively"** — Memory philosophy encourages the agent to store facts proactively rather than waiting to be asked, with corresponding guidance on cleanup/correction.

3. **Multi-surface tone adaptation** — Explicit guidance for web (full formatting) vs chat apps (concise, minimal formatting) rather than one-size-fits-all.

4. **Proactivity with boundaries** — Agent should volunteer connections and observations but "know when to stop" — read the room, don't over-help.

## Files Changed

- `operating_system/SOUL.md` — Full rewrite (~50 lines)
- `operating_system/BRAIN.md` — Full rewrite (~120 lines)
- `operating_system/WORKER.md` — Unchanged
