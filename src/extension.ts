import * as vscode from 'vscode';
import { mapPool } from './parser/parser';
import { formatRelativeTime, formatTokens, totalTokens } from './parser/format';
import { expandHome, matchesWorkspace, SessionStore } from './parser/store';
import { SessionTreeProvider, TreeNode } from './sessionTree';
import { TokenStatusBar } from './statusBar';
import { SessionPanelManager } from './webview/panel';

const FILTER_KEY = 'agentwatch.filterCurrentWorkspace';
const WATCH_DEBOUNCE_MS = 3000;
const QUICK_PICK_LIMIT = 200;

function projectsRoot(): string {
  const configured = vscode.workspace.getConfiguration('agentwatch').get<string>('projectsDir') || '~/.claude/projects';
  return expandHome(configured.trim());
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

function matchesCurrentWorkspace(dirName: string, cwd: string | undefined): boolean {
  return matchesWorkspace(dirName, cwd, workspaceFolders());
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new SessionStore();
  let filterActive = context.workspaceState.get<boolean>(FILTER_KEY, false);

  const tree = new SessionTreeProvider(store, projectsRoot, {
    isActive: () => filterActive,
    matches: matchesCurrentWorkspace,
  });
  const view = vscode.window.createTreeView('agentwatch.sessions', { treeDataProvider: tree, showCollapseAll: true });
  const panels = new SessionPanelManager(store);
  const statusBar = new TokenStatusBar(store, () => tree.getProjects(), matchesCurrentWorkspace);
  context.subscriptions.push(tree, view, panels, statusBar);

  const updateFilterUi = () => {
    view.description = filterActive ? 'current workspace' : undefined;
    void vscode.commands.executeCommand('setContext', 'agentwatch.filterActive', filterActive);
  };
  updateFilterUi();

  const refreshAll = () => {
    tree.refresh();
    void statusBar.update();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('agentwatch.refresh', () => {
      store.clear();
      refreshAll();
    }),

    vscode.commands.registerCommand('agentwatch.openSession', async (arg?: string | TreeNode) => {
      let filePath: string | undefined;
      if (typeof arg === 'string') filePath = arg;
      else if (arg && arg.kind === 'session') filePath = arg.info.filePath;
      else filePath = await pickSession(tree, store);
      if (filePath) await panels.open(filePath);
    }),

    vscode.commands.registerCommand('agentwatch.openTranscript', async (arg?: string | TreeNode) => {
      let filePath: string | undefined;
      if (typeof arg === 'string') filePath = arg;
      else if (arg?.kind === 'session') filePath = arg.info.filePath;
      else if (arg?.kind === 'agent') filePath = arg.agent.transcriptPath || undefined;
      else filePath = await pickSession(tree, store);
      if (!filePath) return;
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: true });
      } catch (err) {
        void vscode.window.showErrorMessage(`AgentWatch: cannot open ${filePath}: ${String(err)}`);
      }
    }),

    vscode.commands.registerCommand('agentwatch.filterCurrentWorkspace', async () => {
      filterActive = !filterActive;
      await context.workspaceState.update(FILTER_KEY, filterActive);
      updateFilterUi();
      tree.refresh();
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshAll()),
  );

  // File watcher with debounced refresh; recreated when the projects dir setting changes.
  let watcher: vscode.FileSystemWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      refreshAll();
    }, WATCH_DEBOUNCE_MS);
  };
  const setupWatcher = () => {
    watcher?.dispose();
    watcher = undefined;
    if (!vscode.workspace.getConfiguration('agentwatch').get<boolean>('autoRefresh', true)) return;
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(projectsRoot()), '**/*.jsonl'),
    );
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
  };
  setupWatcher();
  context.subscriptions.push(
    { dispose: () => watcher?.dispose() },
    { dispose: () => debounce && clearTimeout(debounce) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentwatch.projectsDir') || e.affectsConfiguration('agentwatch.autoRefresh')) {
        setupWatcher();
        store.clear();
        refreshAll();
      } else if (e.affectsConfiguration('agentwatch.statusBar')) {
        void statusBar.update();
      }
    }),
  );

  void statusBar.update();
}

async function pickSession(tree: SessionTreeProvider, store: SessionStore): Promise<string | undefined> {
  const projects = await tree.getProjects();
  const sessions = projects
    .flatMap((p) => p.sessions)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, QUICK_PICK_LIMIT);
  const items = await mapPool(sessions, 8, async (s) => {
    const summary = store.getCached(s);
    const peek = await store.peek(s);
    return {
      label: summary?.title ?? peek.title ?? s.sessionId,
      description: `${formatRelativeTime(s.mtimeMs)}${summary ? ' · ' + formatTokens(totalTokens(summary.totalUsage)) + ' tok' : ''}`,
      detail: peek.cwd ?? s.projectDir,
      filePath: s.filePath,
    };
  });
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a Claude Code session', matchOnDetail: true });
  return picked?.filePath;
}

export function deactivate(): void {
  // Everything is disposed via context.subscriptions.
}
