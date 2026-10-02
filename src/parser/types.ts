// Data model produced by the transcript parser. No vscode dependency.

export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
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
  lines: number;
  badLines: number;
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
  durationMs?: number;
  /** Totals including all subagents (recursive). */
  totalUsage: TokenUsage;
  totalByModel: Record<string, ModelUsage>;
  totalTools: Record<string, ToolStat>;
  totalMcp: Record<string, McpServerStat>;
  totalSkills: Record<string, number>;
  totalToolCalls: number;
  models: string[];
}
