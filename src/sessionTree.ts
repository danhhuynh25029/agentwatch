import * as path from 'path';
import * as vscode from 'vscode';
import { formatBytes, formatRelativeTime, formatTokens, totalTokens } from './parser/format';
import { listProjects, ProjectInfo, SessionFileInfo, SessionStore } from './parser/store';
import { mapPool } from './parser/parser';
import { McpServerStat, SessionSummary, SubagentNode, ToolStat } from './parser/types';

const PEEK_CONCURRENCY = 8;

export type TreeNode =
  | { kind: 'project'; project: ProjectInfo; cwd?: string }
  | { kind: 'session'; info: SessionFileInfo }
  | { kind: 'subagents'; info: SessionFileInfo; summary: SessionSummary }
  | { kind: 'agent'; info: SessionFileInfo; agent: SubagentNode }
  | { kind: 'mcp'; info: SessionFileInfo; summary: SessionSummary }
  | { kind: 'mcpServer'; info: SessionFileInfo; server: McpServerStat }
  | { kind: 'tools'; info: SessionFileInfo; summary: SessionSummary }
  | { kind: 'tool'; id: string; tool: ToolStat }
  | { kind: 'message'; id: string; text: string };

export interface WorkspaceFilter {
  isActive(): boolean;
  matches(projectDirName: string, cwd: string | undefined): boolean;
}

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private projectsPromise: Promise<ProjectInfo[]> | undefined;

  constructor(
    private readonly store: SessionStore,
    private readonly getRoot: () => string,
    private readonly filter: WorkspaceFilter,
  ) {}

  refresh(): void {
    this.projectsPromise = undefined;
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
      case 'project': {
        const label = node.cwd ? path.basename(node.cwd) : node.project.decodedPath;
        const item = new vscode.TreeItem(label, C.Collapsed);
        item.id = 'p:' + node.project.dirPath;
        item.description = `${node.project.sessions.length} · ${formatRelativeTime(node.project.latestMtimeMs)}`;
        item.tooltip = node.cwd ?? node.project.decodedPath;
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'project';
        return item;
      }
      case 'session': {
        const info = node.info;
        const summary = this.store.getCached(info);
        const peek = this.store.getCachedPeek(info);
        const title = summary?.title ?? peek?.title ?? info.sessionId;
        const item = new vscode.TreeItem(title, C.Collapsed);
        item.id = 's:' + info.filePath;
        const when = formatRelativeTime(info.mtimeMs);
        item.description = summary
          ? `${when} · ${formatTokens(totalTokens(summary.totalUsage))} tok`
          : `${when} · ${formatBytes(info.size)}`;
        const tip = new vscode.MarkdownString();
        tip.appendText(`${title}\n\n${info.sessionId}\n${new Date(info.mtimeMs).toLocaleString()}`);
        if (summary) {
          tip.appendText(
            `\n${formatTokens(totalTokens(summary.totalUsage))} tokens (main ${formatTokens(totalTokens(summary.main.usage))}), ` +
              `${summary.agentCount} subagents, ${summary.totalToolCalls} tool calls`,
          );
        }
        item.tooltip = tip;
        item.iconPath = new vscode.ThemeIcon('comment-discussion');
        item.contextValue = 'session';
        item.command = { command: 'agentwatch.openSession', title: 'Open Session', arguments: [info.filePath] };
        return item;
      }
      case 'subagents': {
        const n = node.summary.agentCount;
        const item = new vscode.TreeItem(`Subagents (${n})`, n ? C.Collapsed : C.None);
        item.id = 'sa:' + node.info.filePath;
        item.iconPath = new vscode.ThemeIcon('organization');
        return item;
      }
      case 'agent': {
        const a = node.agent;
        const item = new vscode.TreeItem(`${a.agentType} · ${a.description || a.agentId}`, a.children.length ? C.Collapsed : C.None);
        item.id = 'a:' + node.info.filePath + ':' + a.agentId;
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
        item.id = 'm:' + node.info.filePath;
        item.iconPath = new vscode.ThemeIcon('plug');
        return item;
      }
      case 'mcpServer': {
        const s = node.server;
        const item = new vscode.TreeItem(s.server, C.Collapsed);
        item.id = 'ms:' + node.info.filePath + ':' + s.server;
        item.description = `${s.calls}${s.errors ? ` · ${s.errors} err` : ''}`;
        item.iconPath = new vscode.ThemeIcon('server');
        return item;
      }
      case 'tools': {
        const n = Object.keys(node.summary.totalTools).length;
        const item = new vscode.TreeItem('Tools', n ? C.Collapsed : C.None);
        item.id = 't:' + node.info.filePath;
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
      case 'message': {
        const item = new vscode.TreeItem(node.text, C.None);
        item.id = node.id;
        return item;
      }
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) return this.getProjectNodes();
    switch (node.kind) {
      case 'project':
        return this.getSessionNodes(node.project);
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
        return [
          { kind: 'subagents', info: node.info, summary },
          { kind: 'mcp', info: node.info, summary },
          { kind: 'tools', info: node.info, summary },
        ];
      }
      case 'subagents':
        return node.summary.subagents.map((agent) => ({ kind: 'agent', info: node.info, agent }));
      case 'agent':
        return node.agent.children.map((agent) => ({ kind: 'agent', info: node.info, agent }));
      case 'mcp':
        return Object.values(node.summary.totalMcp)
          .sort((a, b) => b.calls - a.calls)
          .map((server) => ({ kind: 'mcpServer', info: node.info, server }));
      case 'mcpServer':
        return sortTools(node.server.tools).map((tool) => ({
          kind: 'tool',
          id: `mt:${node.info.filePath}:${node.server.server}:${tool.name}`,
          tool,
        }));
      case 'tools':
        return sortTools(node.summary.totalTools).map((tool) => ({
          kind: 'tool',
          id: `tt:${node.info.filePath}:${tool.name}`,
          tool,
        }));
      default:
        return [];
    }
  }

  private async getProjectNodes(): Promise<TreeNode[]> {
    let projects: ProjectInfo[];
    try {
      projects = await this.getProjects();
    } catch (err) {
      return [{ kind: 'message', id: 'err:root', text: `Cannot read ${this.getRoot()}: ${String(err)}` }];
    }
    if (projects.length === 0) {
      return [{ kind: 'message', id: 'empty', text: `No sessions found in ${this.getRoot()}` }];
    }
    // Resolve real cwd from the newest session's head (cheap, cached by mtime+size).
    const cwds = await mapPool(projects, PEEK_CONCURRENCY, async (p) => (await this.store.peek(p.sessions[0])).cwd);
    const nodes: TreeNode[] = [];
    projects.forEach((project, i) => {
      if (this.filter.isActive() && !this.filter.matches(project.dirName, cwds[i])) return;
      nodes.push({ kind: 'project', project, cwd: cwds[i] });
    });
    if (nodes.length === 0) {
      return [{ kind: 'message', id: 'empty-filter', text: 'No sessions for the current workspace (filter is on)' }];
    }
    return nodes;
  }

  private async getSessionNodes(project: ProjectInfo): Promise<TreeNode[]> {
    // Peek heads for provisional titles before rendering; full parse happens on expand/open.
    await mapPool(project.sessions, PEEK_CONCURRENCY, (s) => this.store.peek(s));
    return project.sessions.map((info) => ({ kind: 'session', info }));
  }
}

function sortTools(tools: Record<string, ToolStat>): ToolStat[] {
  return Object.values(tools).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}
