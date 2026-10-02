# AgentWatch

A VS Code extension for browsing past Claude Code sessions stored in `~/.claude/projects`. For each session it shows the subagents that ran, token usage, and which tools and MCP tools were called.

## Features

- **Sessions view** (AgentWatch in the activity bar). The tree goes Project → Session, newest first. Under each session you get:
  - `Subagents (n)`: each agent is shown as `agentType · description` with its token count. Nested subagents expand underneath.
  - `MCP (n calls)`: server → tool, with call and error counts.
  - `Tools`: each non-MCP tool with call and error counts.
- **Session panel** (click a session) shows:
  - Header: title, cwd, branch, models, start/end/duration, CLI version, entrypoint.
  - Token cards for the whole session (including subagents) and for the main thread only.
  - Tables: tokens per model, subagents (nested), MCP tools, tools and skills.
  - A timeline of user prompts.
- **Commands**: `AgentWatch: Refresh`, `Open Session Details`, `Open Raw Transcript (JSONL)`, `Toggle Filter: Current Workspace Only`.
- **Status bar**: total tokens of the most recent session for the current workspace. Click it to open the session.
- **Auto refresh**: the projects directory is watched and the view refreshes 3 seconds after changes stop.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `agentwatch.projectsDir` | `~/.claude/projects` | Where the transcripts live |
| `agentwatch.autoRefresh` | `true` | Watch the directory for changes |
| `agentwatch.statusBar.enabled` | `true` | Show the status bar item |

## How data is read

- The session list comes from file stats. Each file's first 128 KB is read to get a provisional title and the cwd.
- A full parse runs only when you expand or open a session. It streams the file with `readline`, so large transcripts are never loaded into memory all at once.
- Results are cached by path + mtime + size.
- Malformed or truncated lines are skipped. This happens when a file is still being written.
- Token usage is deduplicated by `message.id`, because one API message can be split across several lines.
- Subagent transcripts (`<session>/subagents/agent-<id>.jsonl`) are linked to the `Agent`/`Task` tool call that spawned them. The link uses `toolUseId` from `agent-<id>.meta.json`, falling back to the `agentId` in the tool result.
- Some subagent spawns have no transcript file (older Claude Code versions). They still appear, using the token count reported in the tool result, but those tokens are not added to the session totals.

## Development

Requires Node.js 18+ (`node:test`).

```sh
npm install
npm run compile      # tsc -> out/
npm test             # compile + node:test on fixtures/
npm run scan         # print summaries of the 5 newest sessions
node out/scripts/scan.js -n 10 path/to/session.jsonl
```

Press **F5** in VS Code ("Run Extension") to start an Extension Development Host. The default build task runs `npm run watch`.
