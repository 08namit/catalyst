# IMPORTANT — Catalyst handover

> Read this before starting work. Update it when goals, decisions, ongoing tasks or known bugs materially change,
> and before ending a session. No credentials here.

**Last update:** 2026-11-14 — Tiam's lead agent (Claude Opus 5.5)

## Current goal
Build Catalyst v0.1: CLI + per-project daemon (SQLite event log) + stdio MCP adapter + Claude Code hooks + direct
TLS-PSK peer sync + local dashboard, so two developers' Claude Code sessions share goals, tasks, decisions,
progress and questions, work offline/asynchronously, and replay missed updates on reconnect. Full spec: `PLAN.md`.

## Key decisions
- TypeScript, Node ≥22.13, built-in `node:sqlite` (no native deps), `@modelcontextprotocol/sdk` v1, zod v4, commander.
- Peer link: TLS 1.2 PSK `ECDHE-PSK-CHACHA20-POLY1305` (verified working on Node 26); invitations carry addresses + a single-use secret.
- Events signed with Ed25519; id = sha256(canonical body); ordering by Lamport clock, never by timestamp.
- Conflicts = multiple live "heads" (decisions per topic, claims per task, goal); resolved only by explicit `conflict.resolved`.
- Contracts frozen in `src/core/{protocol,state,api,interfaces,config,paths}.ts`, `src/sync/frames.ts`, `src/client/index.ts`.

## Work in progress
| Area | Owner | Status |
|---|---|---|
| Contracts + scaffold | Tiam lead agent | done |
| Storage/projections/handover (`src/store`, `src/handover`) | Claude subagent | in progress |
| Networking (`src/sync`) | Codex | in progress |
| Daemon + CLI (`src/daemon`, `src/cli`) | Claude subagent | in progress |
| MCP + hooks + setup (`src/mcp`, `src/hooks`, `src/setup`) | Claude subagent | in progress |
| Dashboard, setup page, sample app | Claude subagent | in progress |

## Known bugs / blockers
- The user-level `codex` MCP server (`codex mcp-server`) fails to connect: Codex CLI 0.164 has no such subcommand. Use the Codex plugin companion script instead.

## Verification
- `npm run typecheck`: passes for the contracts (2026-11-14).

## Branches / commits
- `main` (local only, no remote).

## Next steps
1. Integrate the subagent outputs; `npm run build && npm run typecheck && npm test`.
2. Run the two-node e2e test, then the live `claude -p` verification, then dashboard inspection.
3. Write README/PROTOCOL/DEMO; update this file.
