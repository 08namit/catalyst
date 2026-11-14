# Catalyst examples

Reference copies of the files Catalyst reads or writes. None of them contain secrets: identities, pair keys and
the daemon's API token live only in `<project>/.catalyst/` (`identity.json`, `secrets.json`, `daemon.json`, all
mode 0600), which `catalyst setup` adds to `.gitignore`. Never commit `.catalyst/`.

| File | What it is | Where the real one lives |
|---|---|---|
| `catalyst.config.example.json` | Per-checkout project config (no secrets) | `.catalyst/config.json`, written by `catalyst init` / `catalyst join` |
| `mcp.json.example` | Claude Code project MCP config registering the `catalyst` stdio server | `.mcp.json` (committed) |
| `claude-settings.example.json` | Hooks + `mcp__catalyst` permission | `.claude/settings.json` (committed) |
| `inbox-draft.tool.example.json` | Fallback draft written by an agent when the Catalyst tools are unavailable | `.catalyst/inbox/<uuid>.json` |
| `inbox-draft.event.example.json` | Fallback draft written by a hook (auto-captured activity) when the daemon is down | `.catalyst/inbox/<id>.json` |

`catalyst setup` writes the `.mcp.json` and `.claude/settings.json` entries for you, merging them into any
existing configuration (and `catalyst uninstall` removes only them), so you rarely need to copy these by hand.

## `catalyst.config.example.json` fields

JSON has no comments, so the fields are described here.

- `projectId` — shared by every participant of the project (`prj_` + 24 hex). Created by `catalyst init`.
- `projectName` — display name.
- `participantId` — this checkout's identity (`p_` + 24 hex, derived from its Ed25519 public key). Each checkout is one participant.
- `name` — your display name shown to the teammate.
- `peerPort` — TCP port of the peer listener; `0` picks a free port on first start and persists it.
- `peerBind` — bind address of the peer listener: `0.0.0.0` for LAN, `127.0.0.1` for single-machine tests.
- `apiPort` — loopback API port; `0` = random per start (the actual port is in `daemon.json`).
- `advertiseHosts` — hosts/IPs put into invitations; empty = auto-detect non-internal IPv4 addresses.
- `createdByMe` — `true` on the checkout that ran `catalyst init`.
- `autoHandover` — regenerate `IMPORTANT.md` automatically after material changes (default `true`).
- `createdAt` — ISO timestamp.

## `.mcp.json` and hooks

- The MCP server runs `catalyst mcp` (stdio). Claude Code asks each developer to approve project MCP servers in
  interactive sessions; `claude -p` loads them without asking. Tools appear as `mcp__catalyst__<tool>`, and the
  permission rule `mcp__catalyst` allows all of them.
- Every hook command is guarded with `command -v catalyst … || true`, so a teammate without Catalyst installed is
  unaffected. Hooks print nothing unless they have context for Claude, never block, and only the SessionStart hook
  may start the daemon.

## Inbox drafts (fallback when the daemon is unavailable)

Write one JSON file per update into `.catalyst/inbox/`. The daemon imports drafts idempotently (keyed by
`clientId`, so use a fresh UUID per draft and reuse it when retrying the same update) when it next runs; invalid
files are moved to `.catalyst/inbox/rejected/` with a sibling `.error.txt`. Exactly one of these must be present:

- `tool` + `input` — the same input as the MCP tool. Allowed tools: `publish_decision`, `publish_progress`,
  `send_message`, `claim_task`, `release_task`, `report_issue`, `resolve_issue`, `set_goal`.
- `event` — a raw event (`type`, `payload`, optional `refs`/`supersedes`); used by hooks for `activity.captured`.

`writtenAt` is optional and display-only. The last known shared state is in `.catalyst/snapshot.md` (with its
generation time) while the daemon is down.
