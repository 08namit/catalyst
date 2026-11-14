# AGENTS.md

Instructions for coding agents (Codex, Claude Code, others) working in this repository.

1. **Read `IMPORTANT.md` first.** It is the project handover: goal, ongoing tasks and owners, known bugs,
   verification results, branches/commits and next steps. Update it when any of those materially change and
   before you end a session. Keep it concise and free of credentials; preserve conflicting entries for review.
2. Follow `CLAUDE.md` (behavioural guidelines: think first, simplicity, surgical changes, verifiable goals).
3. Architecture and milestones: `PLAN.md`. Wire/event semantics: `PROTOCOL.md`. Shared contracts live in
   `src/core/` and `src/sync/frames.ts` — change them only with the lead's agreement, since every module depends on them.
4. Checks: `npm run typecheck && npm test && npm run build`.
5. Logs must never go to stdout in the MCP adapter or hooks (stdout is a protocol/context channel).
