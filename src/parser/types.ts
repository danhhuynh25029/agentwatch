// Data model produced by the transcript parser. No vscode dependency.

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Part of cacheWrite written with the 1-hour TTL (priced higher). Absent when 0. */
  cacheWrite1h?: number;
}

export interface ModelUsage extends TokenUsage {
  /** Number of distinct API messages (deduped by message.id). */
  messages: number;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
}

export interface McpServerStat {
  server: string;
  calls: number;
  errors: number;
  tools: Record<string, ToolStat>;
}

export interface PromptEntry {
  timestamp?: string;
  text: string;
}

/** Result of an Agent/Task tool call as recorded on the matching user line. */
export interface AgentSpawnResult {
  agentId?: string;
  agentType?: string;
  status?: string;
  resolvedModel?: string;
  isAsync?: boolean;
  totalTokens?: number;
  totalDurationMs?: number;
  totalToolUseCount?: number;
}

export interface AgentSpawn {
  toolUseId: string;
  toolName: string;
  timestamp?: string;
  description?: string;
  subagentType?: string;
  model?: string;
  runInBackground?: boolean;
  result?: AgentSpawnResult;
  isError?: boolean;
  /** Final status from a later <task-notification> (async agents). */
  notifiedStatus?: string;
}

/** A tool call whose tool_result had is_error set. */
export interface ToolErrorEntry {
  timestamp?: string;
  /** Full tool name (MCP tools keep the `mcp__server__tool` form). */
  tool: string;
  /** Truncated JSON of the tool input. */
  input: string;
  /** Truncated error text from the tool_result. */
  error: string;
  /** Set on session totals: which subagent made the call (undefined = main thread). */
  agent?: string;
}

/** Files touched by Edit / Write / MultiEdit / NotebookEdit. */
export interface FileEditStat {
  path: string;
  edits: number;
  writes: number;
  /** Calls whose tool_result was an error. */
  failed: number;
  lastTime?: string;
}

/** Context size (input + cache write + cache read) of one API message, in message order. */
export interface ContextPoint {
  /** Index of the API message in the transcript (0-based). */
  i: number;
  timestamp?: string;
  tokens: number;
}

/** Size of tool results per tool (chars; roughly 4 chars per token). */
export interface ToolResultSize {
  name: string;
  calls: number;
  chars: number;
}

/** One large tool result. */
export interface LargeResult {
  tool: string;
  input: string;
  chars: number;
  timestamp?: string;
  agent?: string;
}

/** Repeated reads of one file via the Read tool. */
export interface FileReadStat {
  path: string;
  reads: number;
  chars: number;
}

/** A `git commit` made through the Bash tool. */
export interface CommitEntry {
  timestamp?: string;
  hash?: string;
  branch?: string;
  message?: string;
  command: string;
  failed?: boolean;
  /** Cumulative usage of this transcript, per model, when the commit was made. */
  usageAtCommit: Record<string, TokenUsage>;
}

/** Stats for a single JSONL transcript file (main session or one subagent). */
export interface TranscriptStats {
  filePath: string;
  sessionId?: string;
  agentId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  aiTitle?: string;
  summaryTitle?: string;
  firstPrompt?: string;
  startTime?: string;
  endTime?: string;
  usage: TokenUsage;
  usageByModel: Record<string, ModelUsage>;
  models: string[];
  apiMessages: number;
  /** Non-MCP tools, keyed by tool name. */
  tools: Record<string, ToolStat>;
  /** MCP servers, keyed by server name. */
  mcp: Record<string, McpServerStat>;
  /** Skill tool invocations keyed by input.skill. */
  skills: Record<string, number>;
  /** All tool_use blocks (MCP + non-MCP). */
  toolCalls: number;
  prompts: PromptEntry[];
  spawns: AgentSpawn[];
  toolErrors: ToolErrorEntry[];
  fileEdits: Record<string, FileEditStat>;
  /** Downsampled context-size series. */
  context: ContextPoint[];
  /** API message indexes (see ContextPoint.i) at which a compaction happened. */
  compactions: ContextPoint[];
  /** Usage per local calendar day (YYYY-MM-DD) and model. */
  usageByDay: Record<string, Record<string, ModelUsage>>;
  /** Names of tool calls that have no tool_result yet (most recent last). */
  pendingTools: string[];
  /** Usage per UTC hour (ISO prefix YYYY-MM-DDTHH) and model, for 5-hour block tracking. */
  usageByHour: Record<string, Record<string, ModelUsage>>;
  resultSizes: Record<string, ToolResultSize>;
  /** Largest tool results, biggest first (capped). */
  largestResults: LargeResult[];
  fileReads: Record<string, FileReadStat>;
  commits: CommitEntry[];
  /** stop_reason of the last assistant message. */
  lastStopReason?: string;
  /** Time of the last end of turn (end_turn message or stop hook summary). */
  turnEndedAt?: string;
  /** Cost Claude Code itself recorded (last cost-state line), in USD. */
  reportedCostUsd?: number;
  lines: number;
  badLines: number;
  /** Set when the file was not parsed (e.g. over the size limit); human-readable reason. */
  skipped?: string;
}

export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  requestShape?: string;
}

export interface SubagentNode {
  agentId: string;
  /** Empty string when no transcript file was found for this agent. */
  transcriptPath: string;
  meta?: AgentMeta;
  spawn?: AgentSpawn;
  agentType: string;
  description: string;
  model?: string;
  status?: string;
  durationMs?: number;
  depth: number;
  /** Tokens reported by toolUseResult when no transcript file exists (not added to totals). */
  reportedTokens?: number;
  stats: TranscriptStats;
  children: SubagentNode[];
  /** Usage of this agent plus all nested agents. */
  totalUsage: TokenUsage;
}

export interface SessionSummary {
  filePath: string;
  sessionId: string;
  title: string;
  main: TranscriptStats;
  subagents: SubagentNode[];
  agentCount: number;
  /** Subagent transcripts not parsed because the per-session limit was reached. */
  subagentFilesSkipped?: number;
  /** Spawn-only subagents (no transcript file) not shown because the per-session limit was reached. */
  spawnNodesSkipped?: number;
  durationMs?: number;
  /** Totals including all subagents (recursive). */
  totalUsage: TokenUsage;
  totalByModel: Record<string, ModelUsage>;
  totalTools: Record<string, ToolStat>;
  totalMcp: Record<string, McpServerStat>;
  totalSkills: Record<string, number>;
  totalToolCalls: number;
  totalByDay: Record<string, Record<string, ModelUsage>>;
  /** Tool errors from main + subagents, oldest first (capped). */
  totalToolErrors: ToolErrorEntry[];
  totalFileEdits: Record<string, FileEditStat>;
  totalByHour: Record<string, Record<string, ModelUsage>>;
  totalResultSizes: Record<string, ToolResultSize>;
  totalLargestResults: LargeResult[];
  totalFileReads: Record<string, FileReadStat>;
  models: string[];
}
