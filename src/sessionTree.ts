import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore } from './annotations';
import { isFilterEmpty, matchesFilter, SessionFilter } from './filter';
import { formatBytes, formatRelativeTime, formatTokens, totalTokens } from './parser/format';
import { listProjects, ProjectInfo, SessionFileInfo, SessionStore } from './parser/store';
import { mapPool, splitMcpName } from './parser/parser';
import { formatUsd, Pricing } from './parser/pricing';
import { FileEditStat, McpServerStat, SessionSummary, SubagentNode, ToolErrorEntry, ToolStat } from './parser/types';

const PEEK_CONCURRENCY = 8;

export type TreeNode =
  | { kind: 'pinned'; sessions: SessionFileInfo[] }
  | { kind: 'codex'; sessions: SessionFileInfo[] }
  | { kind: 'project'; project: ProjectInfo; cwd?: string; sessions: SessionFileInfo[] }
  | { kind: 'session'; info: SessionFileInfo; pin?: boolean }
  | { kind: 'subagents'; info: SessionFileInfo; pin?: boolean; summary: SessionSummary }
  | { kind: 'agent'; info: SessionFileInfo; pin?: boolean; agent: SubagentNode }
  | { kind: 'mcp'; info: SessionFileInfo; pin?: boolean; summary: SessionSummary }
  | { kind: 'mcpServer'; info: SessionFileInfo; pin?: boolean; server: McpServerStat }
  | { kind: 'tools'; info: SessionFileInfo; pin?: boolean; summary: SessionSummary }
  | { kind: 'tool'; id: string; tool: ToolStat }
  | { kind: 'errors'; info: SessionFileInfo; pin?: boolean; summary: SessionSummary }
  | { kind: 'toolError'; id: string; error: ToolErrorEntry }
  | { kind: 'files'; info: SessionFileInfo; pin?: boolean; summary: SessionSummary }
  | { kind: 'file'; info: SessionFileInfo; pin?: boolean; file: FileEditStat }
  | { kind: 'message'; id: string; text: string };

export interface WorkspaceFilter {
  isActive(): boolean;
  matches(projectDirName: string, cwd: string | undefined): boolean;
}

export interface TreeOptions {
  workspace: WorkspaceFilter;
  getFilter(): SessionFilter;
  annotations: AnnotationStore;
  getPricing(): Pricing;
  /** Codex CLI rollouts, newest first (empty when disabled). */
  getCodexSessions(): Promise<SessionFileInfo[]>;
}

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private projectsPromise: Promise<ProjectInfo[]> | undefined;

  constructor(
    private readonly store: SessionStore,
    private readonly getRoot: () => string,
    private readonly opts: TreeOptions,
  ) {}

  refresh(): void {
    this.projectsPromise = undefined;
    this.emitter.fire(undefined);
  }

  /** Re-render labels (pins, tags, filters) without re-reading the projects directory. */
  rerender(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /** Project listing shared by tree, quick pick and status bar (re-read after each refresh). */
  getProjects(): Promise<ProjectInfo[]> {
    if (!this.projectsPromise) {
      this.projectsPromise = listProjects(this.getRoot());
      this.projectsPromise.catch(() => (this.projectsPromise = undefined));
    }
    return this.projectsPromise;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case 'pinned': {
        const item = new vscode.TreeItem('Pinned', C.Expanded);
        item.id = 'pinned';
        item.description = String(node.sessions.length);
        item.iconPath = new vscode.ThemeIcon('pinned');
        return item;
      }
      case 'codex': {
        const item = new vscode.TreeItem('Codex', C.Collapsed);
        item.id = 'codex';
        item.description = String(node.sessions.length);
        item.tooltip = 'OpenAI Codex CLI sessions (basic support: tokens, tools, prompts, conversation)';
        item.iconPath = new vscode.ThemeIcon('terminal');
        return item;
      }
      case 'project': {
        const label = node.cwd ? path.basename(node.cwd) : node.project.decodedPath;
        const item = new vscode.TreeItem(label, C.Collapsed);
        item.id = 'p:' + node.project.dirPath;
        const total = node.project.sessions.length;
        const shown = node.sessions.length;
        item.description = `${shown === total ? total : `${shown}/${total}`} · ${formatRelativeTime(node.project.latestMtimeMs)}`;
        item.tooltip = node.cwd ?? node.project.decodedPath;
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'project';
        return item;
      }
      case 'session':
        return this.sessionItem(node.info, !!node.pin);
      case 'subagents': {
        const n = node.summary.agentCount;
        const item = new vscode.TreeItem(`Subagents (${n})`, n ? C.Collapsed : C.None);
        item.id = (node.pin ? 'P' : '') + 'sa:' + node.info.filePath;
        item.iconPath = new vscode.ThemeIcon('organization');
        return item;
      }
      case 'agent': {
        const a = node.agent;
        const item = new vscode.TreeItem(`${a.agentType} · ${a.description || a.agentId}`, a.children.length ? C.Collapsed : C.None);
        item.id = (node.pin ? 'P' : '') + 'a:' + node.info.filePath + ':' + a.agentId;
        const tok = a.transcriptPath ? formatTokens(totalTokens(a.totalUsage)) : `~${formatTokens(a.reportedTokens ?? 0)}`;
        item.description = `${tok} tok${a.status ? ' · ' + a.status : ''}`;
        item.tooltip = `${a.agentType}\n${a.description}\nmodel: ${a.model ?? '-'}\nagentId: ${a.agentId}`;
        item.iconPath = new vscode.ThemeIcon(a.status === 'error' ? 'error' : 'hubot');
        item.contextValue = a.transcriptPath ? 'agent' : 'agentNoTranscript';
        return item;
      }
      case 'mcp': {
        const calls = Object.values(node.summary.totalMcp).reduce((n, s) => n + s.calls, 0);
        const item = new vscode.TreeItem(`MCP (${calls} calls)`, calls ? C.Collapsed : C.None);
        item.id = (node.pin ? 'P' : '') + 'm:' + node.info.filePath;
        item.iconPath = new vscode.ThemeIcon('plug');
        return item;
      }
      case 'mcpServer': {
        const s = node.server;
        const item = new vscode.TreeItem(s.server, C.Collapsed);
        item.id = (node.pin ? 'P' : '') + 'ms:' + node.info.filePath + ':' + s.server;
        item.description = `${s.calls}${s.errors ? ` · ${s.errors} err` : ''}`;
        item.iconPath = new vscode.ThemeIcon('server');
        return item;
      }
      case 'tools': {
        const n = Object.keys(node.summary.totalTools).length;
        const item = new vscode.TreeItem('Tools', n ? C.Collapsed : C.None);
        item.id = (node.pin ? 'P' : '') + 't:' + node.info.filePath;
        item.description = `${n} distinct`;
        item.iconPath = new vscode.ThemeIcon('tools');
        return item;
      }
      case 'tool': {
        const item = new vscode.TreeItem(node.tool.name, C.None);
        item.id = node.id;
        item.description = `${node.tool.calls}${node.tool.errors ? ` · ${node.tool.errors} err` : ''}`;
        item.iconPath = new vscode.ThemeIcon('symbol-method');
        return item;
      }
      case 'errors': {
        const item = new vscode.TreeItem(`Errors (${node.summary.totalToolErrors.length})`, C.Collapsed);
        item.id = (node.pin ? 'P' : '') + 'e:' + node.info.filePath;
        item.iconPath = new vscode.ThemeIcon('warning');
        return item;
      }
      case 'toolError': {
        const e = node.error;
        const mcp = splitMcpName(e.tool);
        const item = new vscode.TreeItem(mcp ? `${mcp.server} › ${mcp.tool}` : e.tool, C.None);
        item.id = node.id;
        item.description = e.error.replace(/\s+/g, ' ').slice(0, 80);
        const tip = new vscode.MarkdownString();
        tip.appendText(`${e.tool}${e.agent ? ` (subagent: ${e.agent})` : ''}${e.timestamp ? `\n${new Date(e.timestamp).toLocaleString()}` : ''}`);
        if (e.input) tip.appendCodeblock(e.input, 'json');
        tip.appendCodeblock(e.error || '(no error text)', 'text');
        item.tooltip = tip;
        item.iconPath = new vscode.ThemeIcon('error');
        item.command = { command: 'agentwatch.showToolError', title: 'Show Error', arguments: [e] };
        return item;
      }
      case 'files': {
        const n = Object.keys(node.summary.totalFileEdits).length;
        const item = new vscode.TreeItem(`Files changed (${n})`, C.Collapsed);
        item.id = (node.pin ? 'P' : '') + 'f:' + node.info.filePath;
        item.iconPath = new vscode.ThemeIcon('files');
        return item;
      }
      case 'file': {
        const f = node.file;
        const item = new vscode.TreeItem(path.basename(f.path), C.None);
        item.id = (node.pin ? 'P' : '') + 'fe:' + node.info.filePath + ':' + f.path;
        const parts = [];
        if (f.edits) parts.push(`${f.edits} edit${f.edits > 1 ? 's' : ''}`);
        if (f.writes) parts.push(`${f.writes} write${f.writes > 1 ? 's' : ''}`);
        if (f.failed) parts.push(`${f.failed} failed`);
        item.description = parts.join(' · ');
        item.tooltip = f.path;
        item.resourceUri = vscode.Uri.file(f.path);
        item.iconPath = vscode.ThemeIcon.File;
        item.contextValue = 'file';
        item.command = { command: 'agentwatch.openEditedFile', title: 'Open File', arguments: [node] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, C.None);
        item.id = node.id;
        return item;
      }
    }
  }

  private sessionItem(info: SessionFileInfo, inPinned: boolean): vscode.TreeItem {
    const summary = this.store.getCached(info);
    const peek = this.store.getCachedPeek(info);
    const ann = this.opts.annotations.get(info.sessionId);
    const title = summary?.title ?? peek?.title ?? info.sessionId;
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = (inPinned ? 'ps:' : 's:') + info.filePath;
    const when = formatRelativeTime(info.mtimeMs);
    const tags = ann.tags?.length ? ' · ' + ann.tags.map((t) => '#' + t).join(' ') : '';
    item.description = summary
      ? `${when} · ${formatTokens(totalTokens(summary.totalUsage))} tok · ${formatUsd(this.opts.getPricing().costByModel(summary.totalByModel))}${tags}`
      : `${when} · ${formatBytes(info.size)}${tags}`;
    const tip = new vscode.MarkdownString();
    tip.appendText(`${title}\n\n${info.sessionId}\n${new Date(info.mtimeMs).toLocaleString()}`);
    if (peek?.cwd) tip.appendText(`\n${peek.cwd}${peek.gitBranch ? ` (${peek.gitBranch})` : ''}`);
    if (summary) {
      tip.appendText(
        `\n${formatTokens(totalTokens(summary.totalUsage))} tokens (main ${formatTokens(totalTokens(summary.main.usage))}), ` +
          `${summary.agentCount} subagents, ${summary.totalToolCalls} tool calls`,
      );
    }
    if (ann.note) tip.appendText(`\n\nNote: ${ann.note}`);
    item.tooltip = tip;
    item.iconPath = new vscode.ThemeIcon(ann.pinned ? 'pinned' : 'comment-discussion');
    item.contextValue = ann.pinned ? 'session.pinned' : 'session';
    item.command = { command: 'agentwatch.openSession', title: 'Open Session', arguments: [info.filePath] };
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) return this.getRootNodes();
    switch (node.kind) {
      case 'pinned':
        await mapPool(node.sessions, PEEK_CONCURRENCY, (s) => this.store.peek(s));
        return node.sessions.map((info) => ({ kind: 'session', info, pin: true }));
      case 'codex':
        await mapPool(node.sessions, PEEK_CONCURRENCY, (s) => this.store.peek(s));
        return node.sessions.map((info) => ({ kind: 'session', info }));
      case 'project':
        // Peek heads for provisional titles before rendering; full parse happens on expand/open.
        await mapPool(node.sessions, PEEK_CONCURRENCY, (s) => this.store.peek(s));
        return node.sessions.map((info) => ({ kind: 'session', info }));
      case 'session': {
        const wasCached = !!this.store.getCached(node.info);
        let summary: SessionSummary;
        try {
          summary = await this.store.getSummary(node.info);
        } catch (err) {
          return [{ kind: 'message', id: 'err:' + node.info.filePath, text: `Failed to parse: ${String(err)}` }];
        }
        // Update this session's label/description with title + tokens (only once, avoids loops).
        if (!wasCached) setTimeout(() => this.emitter.fire(node), 0);
        const children: TreeNode[] = [
          { kind: 'subagents', info: node.info, summary, pin: node.pin },
          { kind: 'mcp', info: node.info, summary, pin: node.pin },
          { kind: 'tools', info: node.info, summary, pin: node.pin },
        ];
        if (Object.keys(summary.totalFileEdits).length) children.push({ kind: 'files', info: node.info, summary, pin: node.pin });
        if (summary.totalToolErrors.length) children.push({ kind: 'errors', info: node.info, summary, pin: node.pin });
        return children;
      }
      case 'subagents':
        return node.summary.subagents.map((agent) => ({ kind: 'agent', info: node.info, agent, pin: node.pin }));
      case 'agent':
        return node.agent.children.map((agent) => ({ kind: 'agent', info: node.info, agent, pin: node.pin }));
      case 'mcp':
        return Object.values(node.summary.totalMcp)
          .sort((a, b) => b.calls - a.calls)
          .map((server) => ({ kind: 'mcpServer', info: node.info, server, pin: node.pin }));
      case 'mcpServer':
        return sortTools(node.server.tools).map((tool) => ({
          kind: 'tool',
          id: `${node.pin ? 'P' : ''}mt:${node.info.filePath}:${node.server.server}:${tool.name}`,
          tool,
        }));
      case 'tools':
        return sortTools(node.summary.totalTools).map((tool) => ({
          kind: 'tool',
          id: `${node.pin ? 'P' : ''}tt:${node.info.filePath}:${tool.name}`,
          tool,
        }));
      case 'errors':
        return node.summary.totalToolErrors.map((error, i) => ({ kind: 'toolError', id: `${node.pin ? 'P' : ''}te:${node.info.filePath}:${i}`, error }));
      case 'files':
        return Object.values(node.summary.totalFileEdits)
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({ kind: 'file', info: node.info, file, pin: node.pin }));
      default:
        return [];
    }
  }

  private async getRootNodes(): Promise<TreeNode[]> {
    let projects: ProjectInfo[];
    try {
      projects = await this.getProjects();
    } catch (err) {
      return [{ kind: 'message', id: 'err:root', text: `Cannot read ${this.getRoot()}: ${String(err)}` }];
    }
    if (projects.length === 0) {
      return [{ kind: 'message', id: 'empty', text: `No sessions found in ${this.getRoot()}` }];
    }
    const filter = this.opts.getFilter();
    // Resolve real cwd from the newest session's head (cheap, cached by mtime+size).
    const cwds = await mapPool(projects, PEEK_CONCURRENCY, async (p) => (await this.store.peek(p.sessions[0])).cwd);
    const pinnedIds = this.opts.annotations.pinnedIds();
    const pinned: SessionFileInfo[] = [];
    const nodes: TreeNode[] = [];
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      if (this.opts.workspace.isActive() && !this.opts.workspace.matches(project.dirName, cwds[i])) continue;
      const sessions = await this.filterSessions(project.sessions, filter);
      for (const s of sessions) if (pinnedIds.has(s.sessionId)) pinned.push(s);
      if (sessions.length) nodes.push({ kind: 'project', project, cwd: cwds[i], sessions });
    }
    const codex = await this.opts.getCodexSessions().catch(() => [] as SessionFileInfo[]);
    if (codex.length) {
      let shown = await this.filterSessions(codex.slice(0, 500), filter);
      if (this.opts.workspace.isActive()) {
        await mapPool(shown, PEEK_CONCURRENCY, (s) => this.store.peek(s));
        shown = shown.filter((s) => this.opts.workspace.matches('', this.store.getCachedPeek(s)?.cwd));
      }
      for (const s of shown) if (pinnedIds.has(s.sessionId)) pinned.push(s);
      if (shown.length) nodes.push({ kind: 'codex', sessions: shown });
    }
    if (pinned.length) {
      pinned.sort((a, b) => b.mtimeMs - a.mtimeMs);
      nodes.unshift({ kind: 'pinned', sessions: pinned });
    }
    if (nodes.length === 0) {
      const why = this.opts.workspace.isActive() ? 'current workspace filter is on' : 'no session matches the filter';
      return [{ kind: 'message', id: 'empty-filter', text: `No sessions (${why})` }];
    }
    return nodes;
  }

  private async filterSessions(sessions: SessionFileInfo[], filter: SessionFilter): Promise<SessionFileInfo[]> {
    if (isFilterEmpty(filter)) return sessions;
    // Peeks are only needed for text queries; they are cached by mtime+size.
    if (filter.query) await mapPool(sessions, PEEK_CONCURRENCY, (s) => this.store.peek(s));
    return sessions.filter((s) =>
      matchesFilter(filter, s, this.store.getCachedPeek(s), this.store.getCached(s), this.opts.annotations.get(s.sessionId)),
    );
  }
}

function sortTools(tools: Record<string, ToolStat>): ToolStat[] {
  return Object.values(tools).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}
