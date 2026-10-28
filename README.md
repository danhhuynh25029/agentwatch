# Agent Session Watch

A VS Code extension for browsing past Claude Code sessions stored in `~/.claude/projects`. For each session it shows the subagents that ran, token usage, and which tools and MCP tools were called.

## Features

- **Sessions view** (AgentWatch in the activity bar). The tree goes Project → Session, newest first, with a **Pinned** group on top. Each session shows its age, tokens, estimated cost and `#tags`. Under each session you get:
  - `Subagents (n)`: each agent is shown as `agentType · description` with its token count. Nested subagents expand underneath.
  - `MCP (n calls)`: server → tool, with call and error counts.
  - `Tools`: each non-MCP tool with call and error counts.
  - `Files changed (n)`: files touched by `Edit` / `MultiEdit` / `Write` / `NotebookEdit`. Click to open the file; the diff button shows every change the session made to it.
  - `Errors (n)`: every failed tool call with its input and error text.
- **Session panel** (click a session) shows:
  - Header: title, cwd, branch, models, start/end/duration, CLI version, entrypoint, and a live badge while the session is running.
  - Token cards with **estimated cost** and **cache hit rate**, for the whole session and for the main thread.
  - A **context size chart** per API message, with compactions marked.
  - Tables: tokens and cost per model, subagents (nested, with cost), files changed, tool errors, MCP tools, tools and skills.
  - A timeline of user prompts.
  - Buttons: view conversation, open raw transcript, resume, export, compare, pin, tags, note.
- **Conversation viewer**: the transcript as a chat, with tool calls folded (and a toggle to hide them).
- **Usage dashboard**: cost and tokens per day, per project and per model, the most expensive sessions, top subagent types, MCP tools and tools. The range is configurable (7 days to all time) and it follows the current-workspace filter.
- **Compare sessions**: two sessions side by side (cost, tokens, cache hit rate, duration, tool calls, errors, files, compactions, peak context) with the difference.
- **Search and filter**: `Search Sessions` searches titles, first prompts, projects, branches, tags and notes. `Filter Sessions…` limits the tree by time range, text or pinned only.
- **Resume**: runs `claude --resume <sessionId>` in a new terminal in the session's folder.
- **Export**: writes a session as Markdown (summary only, with the conversation, or with tool calls too).
- **Pins, tags and notes** per session, stored in VS Code global state.
- **Status bar**: tokens and estimated cost of the most recent session for the current workspace. While a session is running it spins and shows the tool it is waiting on. Click it to open the session.
- **Budgets**: optional warnings when a session or the day's total crosses a USD amount.
- **Auto refresh**: the projects directory is watched and the view refreshes 3 seconds after changes stop. Open session panels of a running session reload as the transcript grows.

- **Notifications**: while VS Code is in the background, get notified when a running session finishes its turn, or has been waiting on a tool call (permission prompt or long command) for a while.
- **5-hour blocks**: the status bar shows tokens used in the current 5-hour window (across all projects) and the time until it resets. The dashboard adds burn rate, projected cost and recent blocks. Set `agentwatch.blocks.tokenLimit` to see a percentage.
- **What fills the context**: the session panel ranks tool results by size (approx. tokens), lists the largest results and files read more than once.
- **Insights**: hints per session, such as low cache hit rate, repeated reads, huge tool results, the same error repeated, failing MCP servers, subagents on top-tier models, and repeated compactions.
- **Unused MCP servers**: the dashboard lists MCP servers configured in `~/.claude.json` / `.mcp.json` that no session in the range called. Only server names are read.
- **Subagent timeline**: a Gantt chart of subagents in the session panel.
- **Commits**: `git commit`s made through Bash are listed with hash, branch and the cost since the previous commit. `Find Session for Commit…` finds the session that made a commit.
- **Current File History**: a view and a CodeLens ("Edited in N Claude sessions") for the file in the editor; click to see the changes each session made.
- **Prompt library**: `Search Prompts…` searches every prompt of recent sessions, then copies it, opens its session, or runs it in a new Claude session.
- **Usage report**: `Export Usage Report…` writes Markdown, CSV (one row per session, protected against formula injection) or JSON.
- **Replay**: the conversation viewer can step through or play a session entry by entry.
- **Codex CLI** (basic): sessions from `~/.codex/sessions` appear under "Codex" with tokens, model, tools, errors, prompts, conversation and context size. Codex models have no built-in price; add one with `agentwatch.pricing`.

### Cost estimates

Costs are computed from the token counts in the transcripts and first-party Claude API list prices (USD per million tokens). Cache writes are priced by TTL (5-minute: 1.25× input, 1-hour: 2× input, as recorded in each message) and cache reads at the model's cache read price. The session panel also shows the cost Claude Code recorded itself (`cost-state`), which may only cover the latest run of a resumed session. These are estimates: they do not reflect subscription plans, Bedrock/Vertex pricing, 1-hour cache writes, or long-context surcharges. Use `agentwatch.pricing` to override prices or add models. Models with no known price count as $0 and are listed under the cost cards.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `agentwatch.projectsDir` | `~/.claude/projects` | Where the transcripts live |
| `agentwatch.autoRefresh` | `true` | Watch the directory for changes |
| `agentwatch.statusBar.enabled` | `true` | Show the status bar item |
| `agentwatch.statusBar.showCost` | `true` | Show the estimated cost in the status bar |
| `agentwatch.pricing` | `{}` | Price overrides per model id prefix, e.g. `{ "claude-opus-5-5": { "input": 4, "output": 20 } }` |
| `agentwatch.live.enabled` | `true` | Live indicator and panel reload for running sessions |
| `agentwatch.budget.sessionUsd` | `0` | Warn when the latest workspace session reaches this cost (0 = off) |
| `agentwatch.budget.dailyUsd` | `0` | Warn when today's total cost reaches this amount (0 = off) |
| `agentwatch.dashboard.days` | `30` | Default dashboard range in days (0 = all time) |
| `agentwatch.claudeCommand` | `claude` | Command used to resume a session |
| `agentwatch.notify.onFinish` / `onWaiting` | `true` | Notifications for running sessions |
| `agentwatch.notify.waitingSeconds` | `30` | Wait before the "waiting on a tool" notification |
| `agentwatch.notify.onlyWhenUnfocused` | `true` | Only notify when VS Code is in the background |
| `agentwatch.statusBar.showBlock` | `true` | Show the current 5-hour block in the status bar |
| `agentwatch.blocks.tokenLimit` | `0` | Token budget per 5-hour block (0 = show raw tokens) |
| `agentwatch.codeLens.enabled` | `true` | "Edited in N Claude sessions" CodeLens |
| `agentwatch.prompts.sessionLimit` | `300` | Sessions scanned by prompt search and commit lookup |
| `agentwatch.claudeConfigPath` | `~/.claude.json` | Where configured MCP server names are read |
| `agentwatch.codex.enabled` | `true` | Show Codex CLI sessions |
| `agentwatch.codex.sessionsDir` | `~/.codex/sessions` | Codex rollout directory |
| `agentwatch.codexCommand` | `codex` | Command used to resume a Codex session |

## How data is read

- The session list comes from file stats. Each file's first 128 KB is read to get a provisional title and the cwd.
- A full parse runs only when you expand or open a session. It streams the file line by line, so large transcripts are never loaded into memory all at once. Files over 512 MB and single lines over 16 MB are skipped.
- Results are cached by path + mtime + size. While a session is running, each change re-parses that session (a few hundred ms for very large transcripts).
- The conversation viewer, export and file changes read the transcript again on demand; text is cut at a few thousand characters per message and 5000 entries per conversation.
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
