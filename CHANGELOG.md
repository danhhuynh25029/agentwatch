# Changelog

## 0.3.0

- Notifications when a running session finishes or waits on a tool.
- 5-hour usage blocks in the status bar and dashboard (burn rate, projected cost, reset time).
- "What fills the context": tool result sizes, largest results, files read repeatedly; per-session insights.
- Unused configured MCP servers on the dashboard.
- Subagent timeline (Gantt), commits made in a session with cost per commit, Find Session for Commit.
- Current File History view and CodeLens; prompt library; usage report export (Markdown/CSV/JSON); conversation replay.
- Basic OpenAI Codex CLI session support.
- Cost estimates now price 1-hour cache writes at 2× input; the cost Claude Code recorded is shown alongside.
- Refined, minimal webview design; panels keep their scroll position, collapsed sections and toggles across live reloads, and hidden panels refresh when shown again.
- "Show Changes" opens VS Code's diff editor (also for Codex `apply_patch` edits).
- Running sessions are parsed incrementally (only appended bytes), with independent snapshots per summary.
- Fixed tool calls shown as "running" after an interrupted or finished turn (Claude and Codex), duplicate "finished" notifications with slow Stop hooks, newest Codex sessions dropped past the listing cap, and prompts starting with `-` being read as CLI options.

## 0.2.0

- Estimated cost (built-in price table, `agentwatch.pricing` overrides) and cache hit rate in the tree, panel, status bar and export.
- Context size chart per API message with compactions marked.
- Files changed (open the file, or see every edit the session made) and failed tool calls with input and error text.
- Conversation viewer, Markdown export, resume in terminal.
- Usage dashboard (per day, project, model; top sessions, subagent types, MCP tools and tools) and session comparison.
- Session search, filters (time range, text, pinned) and per-session pins, tags and notes.
- Live mode: status bar shows the running tool and panels of running sessions reload; optional per-session and daily budget warnings.

## 0.1.0

- Initial release: Sessions tree (project → session → subagents / MCP / tools), session detail panel with token breakdown, subagent table, MCP and tool usage, prompt timeline, and status bar token counter.
