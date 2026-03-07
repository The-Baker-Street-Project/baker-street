# Installer TUI Text — Edit Guide

Edit the **New Text** column, leave blank to keep as-is. Delete rows you don't want to change.

| # | Current Text | What It Is | New Text |
|---|------|-----------|----------|
| 1 | Baker Street Installer v0.1.0 | Header title | |
| 2 | Preflight Checks | Phase 1 heading | |
| 3 | Running checks... | Loading state | |
| 4 | Docker CLI (v{ver}) | Docker check passed | |
| 5 | docker not found in PATH | Docker check failed | |
| 6 | Kubernetes cluster (v{ver}) | K8s check passed | |
| 7 | disconnected | K8s check failed (header) | |
| 8 | Release manifest (v{ver}) | Manifest loaded | |
| 9 | kubectl CLI | kubectl check | |
| 10 | kubectl not found | kubectl check failed | |
| 11 | Authentication & Secrets | Phase 2 heading | |
| 12 | Feature Secrets | Phase 2 heading (feature keys) | |
| 13 | (required) | Secret prompt hint | |
| 14 | (optional, Enter to skip) | Secret prompt hint | |
| 15 | (skipped) | User skipped a secret | |
| 16 | All secrets collected. Advancing... | Secrets done | |
| 17 | Anthropic OAuth token for Claude | ANTHROPIC_OAUTH_TOKEN prompt | |
| 18 | Anthropic API key (fallback if no OAuth token) | ANTHROPIC_API_KEY prompt | |
| 19 | Voyage AI API key for embeddings | VOYAGE_API_KEY prompt | |
| 20 | Optional Features | Phase 3 heading | |
| 21 | Use ↑↓ to navigate, Space to toggle, Enter to confirm | Feature instructions | |
| 22 | No optional features available. Press Enter to continue. | Empty features | |
| 23 | Telegram bot gateway adapter | Telegram feature description | |
| 24 | GitHub extension for repo access | GitHub feature description | |
| 25 | Perplexity AI search and research tools | Perplexity feature description | |
| 26 | AI-driven browser automation extension | Browser feature description | |
| 27 | Obsidian vault extension | Obsidian feature description | |
| 28 | Confirm Installation | Phase 4 heading | |
| 29 | Authentication | Confirm box section | |
| 30 | Method: OAuth Token / API Key / Not set | Auth method display | |
| 31 | Configuration | Confirm box section | |
| 32 | Namespace: {ns} | Confirm box | |
| 33 | Agent Name: {name} | Confirm box | |
| 34 | Version: {ver} | Confirm box | |
| 35 | Features | Confirm box section | |
| 36 | (none) | No features selected | |
| 37 | Confirm / Cancel | Buttons | |
| 38 | Pulling Images | Phase 5 heading | |
| 39 | {done}/{total} images | Pull progress | |
| 40 | pulling... / done / FAILED: {e} / skipped | Per-image status | |
| 41 | Deploying Resources | Phase 6 heading | |
| 42 | {done}/{total} resources | Deploy progress | |
| 43 | applying... / applied / FAILED: {e} / skipped | Per-resource status | |
| 44 | Health Check | Phase 7 heading | |
| 45 | Waiting for pods to start... | Health loading | |
| 46 | POD / STATUS / READY / RESTARTS | Health table headers | |
| 47 | All pods healthy! Advancing... | Health passed | |
| 48 | Some pods failed to become healthy. Check logs above. | Health failed | |
| 49 | Baker Street — Deployed Successfully! | ASCII art completion banner | |
| 50 | Access URL: http://localhost:30080 | Where to open the UI | |
| 51 | Auth Token: {token} | Generated token display | |
| 52 | Save this token — you need it to log in | Token warning | |
| 53 | Press 'o' to open in browser, 'q' to quit | Final key hints | |
| 54 | Enter to submit  \|  Esc to skip optional | Status bar (Secrets) | |
| 55 | ↑↓ move  Space toggle  Enter ▸ | Status bar (Features) | |
| 56 | ←→ select  Enter ▸ | Status bar (Confirm) | |
| 57 | o open browser  q quit | Status bar (Complete) | |
| 58 | q quit  (auto-advancing...) | Status bar (auto phases) | |
