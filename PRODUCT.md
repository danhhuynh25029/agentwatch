# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Individual developers who use Claude Code for hours every day. They keep AgentWatch open beside the editor in VS Code (or Cursor) and come back to it right after a session ends, or while one is running, to see what it cost, why, and what it did.

## Product Purpose

AgentWatch (marketed as "Agent Session Watch") turns the transcripts Claude Code already writes to `~/.claude/projects` into a readable account of each session: estimated cost, tokens and cache use, what filled the context, which subagents and MCP tools ran, which files and commits it produced, and which tool calls failed. Success: a developer opens a session and within seconds knows what it cost and what drove that cost, then can drill into the cause.

## Positioning

It works entirely from local transcript files, inside the editor, with no account, server, or network request. It reads subagent transcripts and links them to the calls that spawned them, so cost and context are explained per agent, not only summed.

## Operating Context

- Runs as VS Code webview panels (Session, Conversation, Usage dashboard, Compare sessions) next to a tree view in the activity bar, a status bar item, and CodeLens.
- Users open a panel from the session tree, often in a narrow editor column or split beside code, sometimes full width.
- Sessions can be live: panels re-render as the transcript grows.
- Also reads OpenAI Codex CLI sessions (basic support).

## Capabilities and Constraints

- Webview HTML is generated as strings in `src/webview/*.ts`. The Content Security Policy allows only nonce-tagged `<style>` and `<script>`; inline `style` attributes are blocked, so all styling goes through classes. `localResourceRoots` is empty.
- The webview sends the extension only `{command, index}`; it never sends paths or commands.
- Must follow the user's VS Code theme (dark, light, high contrast), taking colors from `--vscode-*` variables.
- The README promises no network requests: no remote fonts, images, or scripts.
- Costs are estimates from public list prices; Claude Code's own recorded cost is shown alongside when present.
- Terminology in the UI: session, subagent, tool call, MCP server, context, compaction, cache hit, 5-hour block, prompt.

## Evidence on Hand

- Fictional demo transcripts (used for README screenshots and `media/demo.gif`) live outside the repo; screenshots in `media/screenshots/` are rendered from them and labeled fictional.
- No user counts, testimonials, or benchmarks exist; none may be invented.

## Product Principles

1. Cost first, then cause: every view leads with what it cost and points to what drove it.
2. Local and private: nothing leaves the machine, and the UI never implies otherwise.
3. Explain, don't just total: break numbers down by agent, model, tool, and day so the user can act.
4. Native to the editor: feels like part of VS Code in any theme and at any panel width.
