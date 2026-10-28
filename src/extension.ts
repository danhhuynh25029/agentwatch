import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnnotationStore, parseTags } from './annotations';
import { BlockTracker } from './blockTracker';
import { BudgetMonitor } from './budget';
import { FileHistoryCodeLens, FileHistoryIndex, FileHistoryProvider } from './fileHistory';
import { SessionNotifier } from './notifier';
import { codexSessionId, collectCodexFileEdits, isCodexTranscript, listCodexSessions, parseCodexFile } from './parser/codex';
import { buildDiffSides } from './parser/editDiff';
import { readConfiguredServers, unusedServers } from './parser/mcpConfig';
import { reportToJson, reportToMarkdown, rowsToCsv, sessionRows } from './parser/report';
import { describeFilter, isFilterEmpty, SessionFilter, sinceMs } from './filter';
import { buildDashboard, compareSessions, dayNDaysAgo, DashboardSession } from './parser/aggregate';
import { collectFileEdits, Conversation, readConversation } from './parser/conversation';
import { sessionToMarkdown } from './parser/export';
import { formatRelativeTime, formatTokens, totalTokens } from './parser/format';
import { mapPool } from './parser/parser';
import { Pricing } from './parser/pricing';
import { expandHome, matchesWorkspace, ProjectInfo, resolveTranscriptUnderRoot, SessionFileInfo, SessionStore } from './parser/store';
import { SessionSummary, ToolErrorEntry } from './parser/types';
import { SessionTreeProvider, TreeNode } from './sessionTree';
import { TokenStatusBar } from './statusBar';
import { KeyedPanels, SessionPanelManager } from './webview/panel';
import { flattenAgents } from './webview/render';
import { renderCompare, renderConversation, renderDashboard } from './webview/views';

const FILTER_KEY = 'agentwatch.filterCurrentWorkspace';
const SESSION_FILTER_KEY = 'agentwatch.sessionFilter';
const WATCH_DEBOUNCE_MS = 3000;
const LIVE_STATUS_DEBOUNCE_MS = 1500;
const LIVE_WINDOW_MS = 2 * 60 * 1000;
const QUICK_PICK_LIMIT = 500;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('agentwatch');
}

function projectsRoot(): string {
  const configured = config().get<string>('projectsDir') || '~/.claude/projects';
  return expandHome(configured.trim());
}

function codexRoot(): string | undefined {
  if (!config().get<boolean>('codex.enabled', true)) return undefined;
  return expandHome((config().get<string>('codex.sessionsDir') || '~/.codex/sessions').trim());
}

/**
 * Commands can be invoked by any extension with arbitrary arguments: only accept .jsonl files
 * under the configured projects root (or the Codex sessions root).
 */
async function validateTranscriptArg(filePath: string): Promise<string | undefined> {
  const codex = codexRoot();
  const resolved =
    (await resolveTranscriptUnderRoot(projectsRoot(), filePath)) ??
    (codex && isCodexTranscript(filePath) ? await resolveTranscriptUnderRoot(codex, filePath) : undefined);
  if (!resolved) {
    void vscode.window.showWarningMessage(
      `AgentWatch: refusing to open ${filePath}: not a .jsonl transcript under ${projectsRoot()}.`,
    );
  }
  return resolved;
}

let codexCache: Promise<SessionFileInfo[]> | undefined;

/** Codex rollouts as session infos (cached until the next refresh). */
function codexSessions(): Promise<SessionFileInfo[]> {
  const root = codexRoot();
  if (!root) return Promise.resolve([]);
  codexCache ??= listCodexSessions(root)
    .then((files) =>
      files.map((f) => ({ filePath: f.filePath, sessionId: path.basename(f.filePath, '.jsonl'), projectDir: path.dirname(f.filePath), mtimeMs: f.mtimeMs, size: f.size })),
    )
    .catch(() => []);
  return codexCache;
}

/** Every Claude and Codex session, newest first. */
async function allSessions(tree: SessionTreeProvider): Promise<SessionFileInfo[]> {
  const [projects, codex] = await Promise.all([tree.getProjects(), codexSessions()]);
  return [...projects.flatMap((p) => p.sessions), ...codex].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function readConversationAny(filePath: string): Promise<Conversation> {
  return isCodexTranscript(filePath) ? (await parseCodexFile(filePath)).conversation : readConversation(filePath);
}

/** POSIX shell single-quoting. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

function matchesCurrentWorkspace(dirName: string, cwd: string | undefined): boolean {
  return matchesWorkspace(dirName, cwd, workspaceFolders());
}

function isLive(mtimeMs: number): boolean {
  return mtimeMs > 0 && Date.now() - mtimeMs < LIVE_WINDOW_MS;
}

/** Argument shape used by panels for file commands. */
interface FileArg {
  sessionPath: string;
  file: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new SessionStore();
  const annotations = new AnnotationStore(context.globalState);
  let filterActive = context.workspaceState.get<boolean>(FILTER_KEY, false);
  let sessionFilter = context.workspaceState.get<SessionFilter>(SESSION_FILTER_KEY, {});
  let pricing = new Pricing(config().get('pricing'));
  const getPricing = () => pricing;

  const tree = new SessionTreeProvider(store, projectsRoot, {
    workspace: { isActive: () => filterActive, matches: matchesCurrentWorkspace },
    getFilter: () => sessionFilter,
    annotations,
    getPricing,
    getCodexSessions: codexSessions,
  });
  const view = vscode.window.createTreeView('agentwatch.sessions', { treeDataProvider: tree, showCollapseAll: true });
  const panels = new SessionPanelManager({
    store,
    annotations,
    getPricing,
    isLive,
    liveReload: () => config().get<boolean>('live.enabled', true),
  });
  const conversations = new KeyedPanels('agentwatch.conversation');
  const dashboards = new KeyedPanels('agentwatch.dashboard');
  const comparisons = new KeyedPanels('agentwatch.compare');
  const getProjects = () => tree.getProjects();
  const budget = new BudgetMonitor(context.globalState, store, () => allSessions(tree), getPricing);
  const statusBar = new TokenStatusBar(store, getProjects, matchesCurrentWorkspace, getPricing, isLive, (info, s) => budget.check(info, s));
  const notifier = new SessionNotifier(store);
  const blocks = new BlockTracker(store, () => allSessions(tree), getPricing);
  const fileIndex = new FileHistoryIndex(store, getProjects, getPricing);
  const fileHistory = new FileHistoryProvider(fileIndex);
  const fileHistoryView = vscode.window.createTreeView('agentwatch.fileHistory', { treeDataProvider: fileHistory });
  const codeLens = new FileHistoryCodeLens(fileIndex);
  const diffDocs = new DiffDocuments();
  context.subscriptions.push(
    tree, view, panels, conversations, dashboards, comparisons, statusBar, notifier, blocks, fileIndex, fileHistory, fileHistoryView, codeLens,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLens),
    vscode.workspace.registerTextDocumentContentProvider(DiffDocuments.scheme, diffDocs),
  );

  const updateFilterUi = () => {
    const parts = [filterActive ? 'current workspace' : undefined, describeFilter(sessionFilter)].filter(Boolean);
    view.description = parts.length ? parts.join(' · ') : undefined;
    void vscode.commands.executeCommand('setContext', 'agentwatch.filterActive', filterActive);
    void vscode.commands.executeCommand('setContext', 'agentwatch.sessionFilterActive', !isFilterEmpty(sessionFilter));
  };
  updateFilterUi();

  const refreshAll = () => {
    codexCache = undefined;
    tree.refresh();
    fileIndex.invalidate();
    void statusBar.update();
    void blocks.update();
  };

  annotations.onDidChange(() => {
    tree.rerender();
    panels.reloadAll();
  });

  const setSessionFilter = async (f: SessionFilter) => {
    sessionFilter = f;
    await context.workspaceState.update(SESSION_FILTER_KEY, f);
    updateFilterUi();
    tree.rerender();
  };

  /** Resolve a command argument (path string, tree node, or nothing → quick pick) to a validated session path. */
  const sessionArg = async (arg: unknown, placeHolder = 'Select a Claude Code session'): Promise<string | undefined> => {
    let filePath: string | undefined;
    if (typeof arg === 'string') filePath = arg;
    else if (isTreeNode(arg) && arg.kind === 'session') filePath = arg.info.filePath;
    else filePath = await pickSession(tree, store, annotations, { placeHolder });
    if (!filePath) return undefined;
    return validateTranscriptArg(filePath);
  };

  /** Summaries of the most recent sessions (Claude + Codex), with a progress notification. */
  const recentSummaries = (title: string, limit: number) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
      const sessions = (await allSessions(tree)).slice(0, limit);
      const out = await mapPool(sessions, 4, async (info) => {
        try {
          return { info, summary: await store.getSummary(info) };
        } catch {
          return undefined;
        }
      });
      return out.filter((x): x is { info: SessionFileInfo; summary: SessionSummary } => !!x);
    });

  const summaryFor = (filePath: string) => store.getSummaryByPath(filePath);

  /** Resolve a file-command argument; the file must be one the session actually edited. */
  const fileArg = async (arg: unknown): Promise<{ sessionPath: string; file: string; summary: SessionSummary } | undefined> => {
    let sessionPath: string | undefined;
    let file: string | undefined;
    if (isTreeNode(arg) && arg.kind === 'file') {
      sessionPath = arg.info.filePath;
      file = arg.file.path;
    } else if (typeof arg === 'object' && arg !== null) {
      const a = arg as Partial<FileArg>;
      if (typeof a.sessionPath === 'string' && typeof a.file === 'string') {
        sessionPath = a.sessionPath;
        file = a.file;
      }
    }
    if (!sessionPath || !file) return undefined;
    const valid = await validateTranscriptArg(sessionPath);
    if (!valid) return undefined;
    const summary = await summaryFor(valid);
    if (!Object.prototype.hasOwnProperty.call(summary.totalFileEdits, file)) return undefined;
    return { sessionPath: valid, file, summary };
  };

  const transcriptsOf = (s: SessionSummary) => [s.filePath, ...flattenAgents(s.subagents).map((a) => a.transcriptPath).filter(Boolean)];

  const reportError = (what: string, err: unknown) => void vscode.window.showErrorMessage(`AgentWatch: ${what}: ${String(err)}`);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentwatch.refresh', () => {
      store.clear();
      refreshAll();
    }),

    vscode.commands.registerCommand('agentwatch.openSession', async (arg?: unknown) => {
      const filePath = await sessionArg(arg);
      if (filePath) await panels.open(filePath);
    }),

    vscode.commands.registerCommand('agentwatch.openTranscript', async (arg?: unknown) => {
      let filePath: string | undefined;
      if (typeof arg === 'string') filePath = arg;
      else if (isTreeNode(arg) && arg.kind === 'session') filePath = arg.info.filePath;
      else if (isTreeNode(arg) && arg.kind === 'agent') filePath = arg.agent.transcriptPath || undefined;
      else filePath = await pickSession(tree, store, annotations);
      if (!filePath) return;
      filePath = await validateTranscriptArg(filePath);
      if (!filePath) return;
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: true });
      } catch (err) {
        reportError(`cannot open ${filePath}`, err);
      }
    }),

    vscode.commands.registerCommand('agentwatch.filterCurrentWorkspace', async () => {
      filterActive = !filterActive;
      await context.workspaceState.update(FILTER_KEY, filterActive);
      updateFilterUi();
      tree.refresh();
    }),

    vscode.commands.registerCommand('agentwatch.search', async () => {
      const filePath = await pickSession(tree, store, annotations, {
        placeHolder: 'Search sessions by title, first prompt, project, branch, #tag or note',
        peekAll: true,
      });
      if (filePath) await vscode.commands.executeCommand('agentwatch.openSession', filePath);
    }),

    vscode.commands.registerCommand('agentwatch.setFilter', async () => {
      const f = sessionFilter;
      const ranges: Array<[string, number | undefined]> = [
        ['Today', 0],
        ['Last 7 days', 7],
        ['Last 30 days', 30],
        ['Last 90 days', 90],
        ['Any time', undefined],
      ];
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(calendar) Time range…', id: 'range', description: describeFilter({ sinceDays: f.sinceDays }) ?? 'any time' },
          { label: '$(search) Text…', id: 'text', description: f.query ? `"${f.query}"` : 'none' },
          { label: `$(pinned) Pinned only`, id: 'pinned', description: f.pinnedOnly ? 'on' : 'off' },
          { label: '$(clear-all) Clear all filters', id: 'clear' },
        ],
        { placeHolder: 'Filter the session list' },
      );
      if (!pick) return;
      if (pick.id === 'range') {
        const r = await vscode.window.showQuickPick(ranges.map(([label, days]) => ({ label, days })), { placeHolder: 'Show sessions modified…' });
        if (r) await setSessionFilter({ ...f, sinceDays: r.days });
      } else if (pick.id === 'text') {
        const q = await vscode.window.showInputBox({
          prompt: 'Match title, first prompt, project path, branch, #tag, note, model or MCP server (empty to clear)',
          value: f.query ?? '',
        });
        if (q !== undefined) await setSessionFilter({ ...f, query: q.trim() || undefined });
      } else if (pick.id === 'pinned') {
        await setSessionFilter({ ...f, pinnedOnly: !f.pinnedOnly || undefined });
      } else {
        await setSessionFilter({});
      }
    }),

    vscode.commands.registerCommand('agentwatch.clearFilter', () => setSessionFilter({})),

    vscode.commands.registerCommand('agentwatch.togglePin', async (arg?: unknown) => {
      const filePath = await sessionArg(arg, 'Select a session to pin or unpin');
      if (filePath) await annotations.togglePin(path.basename(filePath, '.jsonl'));
    }),

    vscode.commands.registerCommand('agentwatch.editTags', async (arg?: unknown) => {
      const filePath = await sessionArg(arg, 'Select a session to tag');
      if (!filePath) return;
      const id = path.basename(filePath, '.jsonl');
      const current = annotations.get(id).tags ?? [];
      const input = await vscode.window.showInputBox({
        prompt: 'Tags, separated by commas or spaces (empty to remove all)',
        value: current.join(', '),
      });
      if (input !== undefined) await annotations.set(id, { tags: parseTags(input) });
    }),

    vscode.commands.registerCommand('agentwatch.editNote', async (arg?: unknown) => {
      const filePath = await sessionArg(arg, 'Select a session to annotate');
      if (!filePath) return;
      const id = path.basename(filePath, '.jsonl');
      const input = await vscode.window.showInputBox({ prompt: 'Note for this session (empty to remove)', value: annotations.get(id).note ?? '' });
      if (input !== undefined) await annotations.set(id, { note: input.trim() });
    }),

    vscode.commands.registerCommand('agentwatch.resumeSession', async (arg?: unknown) => {
      const filePath = await sessionArg(arg, 'Select a session to resume');
      if (!filePath) return;
      const summary = await summaryFor(filePath).catch(() => undefined);
      // The file name is what `claude --resume` and the annotations are keyed by.
      const codex = isCodexTranscript(filePath);
      const sessionId = codex ? codexSessionId(filePath) : path.basename(filePath, '.jsonl');
      if (!SESSION_ID_RE.test(sessionId)) {
        void vscode.window.showWarningMessage(`AgentWatch: unexpected session id "${sessionId}", not resuming.`);
        return;
      }
      let cwd = summary?.main.cwd;
      if (cwd && !(await isDirectory(cwd))) {
        void vscode.window.showWarningMessage(`AgentWatch: ${cwd} no longer exists; the terminal opens in your home folder.`);
        cwd = undefined;
      }
      const cmd = codex ? (config().get<string>('codexCommand') || 'codex').trim() : (config().get<string>('claudeCommand') || 'claude').trim();
      const terminal = vscode.window.createTerminal({ name: `${codex ? 'Codex' : 'Claude'} · ${summary?.title.slice(0, 30) ?? sessionId}`, cwd: cwd ?? os.homedir() });
      terminal.show();
      terminal.sendText(codex ? `${cmd} resume ${sessionId}` : `${cmd} --resume ${sessionId}`);
    }),

    vscode.commands.registerCommand('agentwatch.viewConversation', async (arg?: unknown) => {
      const filePath = await sessionArg(arg, 'Select a session to read');
      if (!filePath) return;
      await conversations.show(filePath, async (cspSource, nonce) => {
        const [summary, conv] = await Promise.all([summaryFor(filePath), readConversationAny(filePath)]);
        return {
          title: '💬 ' + summary.title,
          html: renderConversation(summary.title, conv, nonce, cspSource),
          onAction: (a) => {
            if (a.command === 'export') void vscode.commands.executeCommand('agentwatch.exportSession', filePath);
          },
        };
      });
    }),

    vscode.commands.registerCommand('agentwatch.exportSession', async (arg?: unknown) => {
      const filePath = await sessionArg(arg, 'Select a session to export');
      if (!filePath) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Summary and conversation', includeConversation: true, includeTools: false },
          { label: 'Summary, conversation and tool calls', includeConversation: true, includeTools: true },
          { label: 'Summary only', includeConversation: false, includeTools: false },
        ],
        { placeHolder: 'What should the Markdown export contain?' },
      );
      if (!mode) return;
      try {
        const summary = await summaryFor(filePath);
        const conv = mode.includeConversation ? await readConversationAny(filePath) : undefined;
        const ann = annotations.get(path.basename(filePath, '.jsonl'));
        const md = sessionToMarkdown(summary, conv, pricing, { includeTools: mode.includeTools, tags: ann.tags, note: ann.note });
        const base = workspaceFolders()[0] ?? os.homedir();
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(base, `claude-session-${summary.sessionId.slice(0, 8)}.md`)),
          filters: { Markdown: ['md'] },
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
        const open = await vscode.window.showInformationMessage(`AgentWatch: exported to ${target.fsPath}`, 'Open');
        if (open) await vscode.window.showTextDocument(target);
      } catch (err) {
        reportError('export failed', err);
      }
    }),

    vscode.commands.registerCommand('agentwatch.compareSessions', async (arg?: unknown) => {
      const a = await sessionArg(arg, 'Select the first session (A)');
      if (!a) return;
      const bPick = await pickSession(tree, store, annotations, { placeHolder: 'Select the session to compare with (B)', exclude: a });
      if (!bPick) return;
      const b = await validateTranscriptArg(bPick);
      if (!b) return;
      await comparisons.show(`${a}|${b}`, async (cspSource, nonce) => {
        const [sa, sb] = await Promise.all([summaryFor(a), summaryFor(b)]);
        return {
          title: '⚖ Compare sessions',
          html: renderCompare(sa, sb, compareSessions(sa, sb, pricing), nonce, cspSource),
          onAction: (act) => {
            if (act.command === 'openSession' && (act.index === 0 || act.index === 1)) void panels.open(act.index === 0 ? a : b);
          },
        };
      });
    }),

    vscode.commands.registerCommand('agentwatch.openDashboard', async () => {
      const defaultDays = config().get<number>('dashboard.days', 30);
      let days = Number.isFinite(defaultDays) && defaultDays >= 0 ? defaultDays : 30;
      const render = async (cspSource: string, nonce: string) => {
        const scopeWorkspace = filterActive;
        const projects = (await tree.getProjects()).slice();
        const since = days > 0 ? sinceMs(days - 1) : 0;
        const sessions = await collectDashboardSessions(projects, await codexSessions(), since, scopeWorkspace, store);
        const data = buildDashboard(sessions, pricing, days > 0 ? dayNDaysAgo(days - 1) : undefined);
        const folders = scopeWorkspace ? workspaceFolders() : [...new Set(sessions.map((x) => x.summary.main.cwd).filter((c): c is string => !!c))];
        const configured = await readConfiguredServers(expandHome(config().get<string>('claudeConfigPath') || '~/.claude.json'), folders);
        const used = new Set<string>();
        for (const x of sessions) for (const srv of Object.keys(x.summary.totalMcp)) used.add(srv);
        const { html, sessions: paths } = renderDashboard(data, scopeWorkspace ? 'Current workspace' : 'All projects', nonce, cspSource, {
          blocks: await blocks.compute(),
          blockTokenLimit: blocks.tokenLimit(),
          unusedMcp: unusedServers(configured, used),
          mcpChecked: true,
        });
        return {
          title: '📊 AgentWatch dashboard',
          html,
          onAction: (a: { command: string; index?: number }) => {
            if (a.command === 'openSession' && a.index !== undefined && paths[a.index]) void panels.open(paths[a.index]);
            if (a.command === 'range') {
              void vscode.window
                .showQuickPick(
                  [7, 14, 30, 90, 365, 0].map((d) => ({ label: d ? `Last ${d} days` : 'All time', d })),
                  { placeHolder: 'Dashboard range' },
                )
                .then((pick) => {
                  if (!pick) return;
                  days = pick.d;
                  void dashboards.show('dashboard', render);
                });
            }
          },
        };
      };
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AgentWatch: building dashboard…' },
        () => dashboards.show('dashboard', render),
      );
    }),

    vscode.commands.registerCommand('agentwatch.searchPrompts', async () => {
      const limit = Math.max(10, config().get<number>('prompts.sessionLimit', 300));
      const items = (await recentSummaries('AgentWatch: collecting prompts…', limit)).flatMap(({ info, summary }) =>
        summary.main.prompts.map((p) => ({
          label: p.text.replace(/\s+/g, ' '),
          description: `${summary.title} · ${p.timestamp ? formatRelativeTime(Date.parse(p.timestamp)) : formatRelativeTime(info.mtimeMs)}${isCodexTranscript(info.filePath) ? ' · Codex' : ''}`,
          prompt: p,
          filePath: info.filePath,
          cwd: summary.main.cwd,
          time: p.timestamp ?? '',
        })),
      );
      items.sort((a, b) => b.time.localeCompare(a.time));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: `Search ${items.length} prompts`, matchOnDescription: true });
      if (!picked) return;
      // Stats keep prompts truncated; read the full text from the conversation.
      let full = picked.prompt.text;
      try {
        const conv = await readConversationAny(picked.filePath);
        const hit = conv.entries.find((e) => e.kind === 'user' && e.timestamp === picked.prompt.timestamp);
        if (hit && hit.kind === 'user') full = hit.text;
      } catch {
        // keep the truncated text
      }
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(copy) Copy prompt', id: 'copy' },
          { label: '$(terminal) Run in a new Claude session', id: 'run' },
          { label: '$(preview) Open the session', id: 'open' },
        ],
        { placeHolder: full.slice(0, 120) },
      );
      if (!action) return;
      if (action.id === 'copy') {
        await vscode.env.clipboard.writeText(full);
        void vscode.window.showInformationMessage('AgentWatch: prompt copied.');
      } else if (action.id === 'open') {
        await panels.open(picked.filePath);
      } else {
        const cwd = picked.cwd && (await isDirectory(picked.cwd)) ? picked.cwd : workspaceFolders()[0] ?? os.homedir();
        const cmd = (config().get<string>('claudeCommand') || 'claude').trim();
        const terminal = vscode.window.createTerminal({ name: 'Claude · prompt', cwd });
        terminal.show();
        if (process.platform === 'win32') {
          await vscode.env.clipboard.writeText(full);
          terminal.sendText(cmd);
          void vscode.window.showInformationMessage('AgentWatch: prompt copied; paste it into Claude.');
        } else {
          // `--` ends option parsing, so a prompt that looks like a flag stays a prompt.
          terminal.sendText(`${cmd} -- ${shellQuote(full)}`);
        }
      }
    }),

    vscode.commands.registerCommand('agentwatch.findCommit', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Commit hash (at least 7 characters)',
        validateInput: (v) => (/^[0-9a-fA-F]{7,40}$/.test(v.trim()) ? undefined : 'Enter 7-40 hex characters'),
      });
      if (!input) return;
      const hash = input.trim().toLowerCase();
      const limit = Math.max(10, config().get<number>('prompts.sessionLimit', 300));
      const hits = (await recentSummaries('AgentWatch: searching commits…', limit)).flatMap(({ info, summary }) =>
        summary.main.commits
          .filter((c) => c.hash && (c.hash.startsWith(hash) || hash.startsWith(c.hash)))
          .map((c) => ({ label: summary.title, description: `${c.hash} · ${c.branch ?? ''}`, detail: c.message, filePath: info.filePath })),
      );
      if (hits.length === 0) {
        void vscode.window.showInformationMessage(`AgentWatch: no session among the ${limit} most recent made commit ${hash}.`);
        return;
      }
      const pick = hits.length === 1 ? hits[0] : await vscode.window.showQuickPick(hits, { placeHolder: 'Sessions that made this commit' });
      if (pick) await panels.open(pick.filePath);
    }),

    vscode.commands.registerCommand('agentwatch.exportReport', async () => {
      const range = await vscode.window.showQuickPick(
        [7, 14, 30, 90, 0].map((d) => ({ label: d ? `Last ${d} days` : 'All time', d })),
        { placeHolder: 'Report range' },
      );
      if (!range) return;
      const format = await vscode.window.showQuickPick(
        [
          { label: 'Markdown report', ext: 'md' },
          { label: 'CSV (one row per session)', ext: 'csv' },
          { label: 'JSON', ext: 'json' },
        ],
        { placeHolder: 'Format' },
      );
      if (!format) return;
      try {
        const since = range.d > 0 ? sinceMs(range.d - 1) : 0;
        const sessions = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AgentWatch: building report…' },
          async () => collectDashboardSessions(await tree.getProjects(), await codexSessions(), since, filterActive, store),
        );
        const data = buildDashboard(sessions, pricing, range.d > 0 ? dayNDaysAgo(range.d - 1) : undefined);
        const rows = sessionRows(sessions, pricing);
        const scope = filterActive ? 'Current workspace' : 'All projects';
        const text = format.ext === 'csv' ? rowsToCsv(rows) : format.ext === 'json' ? reportToJson(data, rows) : reportToMarkdown(data, rows, scope);
        const base = workspaceFolders()[0] ?? os.homedir();
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(base, `claude-usage-${dayNDaysAgo(0)}.${format.ext}`)),
          filters: { [format.label]: [format.ext] },
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
        const open = await vscode.window.showInformationMessage(`AgentWatch: report saved to ${target.fsPath}`, 'Open');
        if (open) await vscode.window.showTextDocument(target);
      } catch (err) {
        reportError('report failed', err);
      }
    }),

    vscode.commands.registerCommand('agentwatch.fileHistory', async (arg?: unknown) => {
      const file =
        typeof arg === 'string' ? arg : arg instanceof vscode.Uri && arg.scheme === 'file' ? arg.fsPath : vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!file) return;
      const entries = await fileIndex.sessionsFor(file);
      const pick = await vscode.window.showQuickPick(
        entries.map((e) => ({
          label: e.title,
          description: `${e.stat.edits + e.stat.writes} change(s)${e.stat.lastTime ? ' · ' + formatRelativeTime(Date.parse(e.stat.lastTime)) : ''}`,
          entry: e,
        })),
        { placeHolder: `Sessions that changed ${path.basename(file)}` },
      );
      if (pick) await vscode.commands.executeCommand('agentwatch.showFileEdits', { sessionPath: pick.entry.info.filePath, file });
    }),

    vscode.commands.registerCommand('agentwatch.showToolError', async (arg?: unknown) => {
      if (!isToolError(arg)) return;
      const lines = [
        `# ${arg.tool}`,
        '',
        arg.timestamp ? `Time: ${new Date(arg.timestamp).toLocaleString()}` : '',
        arg.agent ? `Subagent: ${arg.agent}` : '',
        '',
        '## Input',
        '',
        fenced(arg.input || '(not recorded)', 'json'),
        '',
        '## Error',
        '',
        fenced(arg.error || '(no error text)'),
      ];
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.filter((l, i) => l || lines[i - 1]).join('\n') });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('agentwatch.openEditedFile', async (arg?: unknown) => {
      const resolved = await fileArg(arg);
      if (!resolved) return;
      if (!path.isAbsolute(resolved.file) || !(await isFile(resolved.file))) {
        const pick = await vscode.window.showWarningMessage(`AgentWatch: ${resolved.file} does not exist anymore.`, 'Show Changes');
        if (pick) await vscode.commands.executeCommand('agentwatch.showFileEdits', { sessionPath: resolved.sessionPath, file: resolved.file });
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(resolved.file), { preview: true });
    }),

    vscode.commands.registerCommand('agentwatch.showFileEdits', async (arg?: unknown) => {
      const resolved = await fileArg(arg);
      if (!resolved) return;
      const ops = isCodexTranscript(resolved.sessionPath)
        ? await collectCodexFileEdits(resolved.sessionPath, resolved.file)
        : await collectFileEdits(transcriptsOf(resolved.summary), resolved.file);
      if (ops.length === 0) {
        void vscode.window.showInformationMessage(`AgentWatch: no edit calls found for ${path.basename(resolved.file)}.`);
        return;
      }
      const { before, after } = buildDiffSides(ops, resolved.summary.filePath);
      const [left, right] = diffDocs.put(resolved.file, before, after);
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${path.basename(resolved.file)}: ${ops.length} change${ops.length > 1 ? 's' : ''} in "${resolved.summary.title.slice(0, 40)}"`,
        { preview: true },
      );
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshAll()),
  );

  // File watcher with debounced refresh; recreated when the projects dir setting changes.
  let watcher: vscode.FileSystemWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let liveDebounce: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      refreshAll();
    }, WATCH_DEBOUNCE_MS);
  };
  const onChange = (uri: vscode.Uri) => {
    scheduleRefresh();
    if (SessionNotifier.isMainTranscript(uri.fsPath, projectsRoot())) notifier.onChanged(uri.fsPath);
    if (!config().get<boolean>('live.enabled', true)) return;
    panels.notifyChanged(uri.fsPath);
    // Faster status bar refresh while a session is running.
    if (liveDebounce) clearTimeout(liveDebounce);
    liveDebounce = setTimeout(() => {
      liveDebounce = undefined;
      void statusBar.update();
      void blocks.update();
    }, LIVE_STATUS_DEBOUNCE_MS);
  };
  let codexWatcher: vscode.FileSystemWatcher | undefined;
  const setupWatcher = () => {
    watcher?.dispose();
    codexWatcher?.dispose();
    watcher = codexWatcher = undefined;
    if (!config().get<boolean>('autoRefresh', true)) return;
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(projectsRoot()), '**/*.jsonl'),
    );
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(scheduleRefresh);
    const codex = codexRoot();
    if (codex) {
      codexWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(codex), '**/rollout-*.jsonl'));
      codexWatcher.onDidCreate(scheduleRefresh);
      codexWatcher.onDidChange(onChange);
    }
  };
  setupWatcher();
  context.subscriptions.push(
    { dispose: () => watcher?.dispose() },
    { dispose: () => codexWatcher?.dispose() },
    { dispose: () => debounce && clearTimeout(debounce) },
    { dispose: () => liveDebounce && clearTimeout(liveDebounce) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentwatch.projectsDir') || e.affectsConfiguration('agentwatch.autoRefresh') || e.affectsConfiguration('agentwatch.codex')) {
        setupWatcher();
        store.clear();
        refreshAll();
        return;
      }
      if (e.affectsConfiguration('agentwatch.pricing')) {
        pricing = new Pricing(config().get('pricing'));
        tree.rerender();
        panels.reloadAll();
      }
      if (e.affectsConfiguration('agentwatch.statusBar') || e.affectsConfiguration('agentwatch.pricing') || e.affectsConfiguration('agentwatch.live')) {
        void statusBar.update();
      }
      if (e.affectsConfiguration('agentwatch.statusBar') || e.affectsConfiguration('agentwatch.pricing') || e.affectsConfiguration('agentwatch.blocks')) {
        void blocks.update();
      }
    }),
  );

  void statusBar.update();
  void blocks.update();
  // Block countdown and live state change with time, not only with file changes.
  const clock = setInterval(() => void blocks.update(), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(clock) });
}

/** Read-only in-memory documents for the "changes in session" diff editor. */
class DiffDocuments implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'agentwatch-diff';
  private readonly docs = new Map<string, string>();
  private seq = 0;

  /** Store both sides; the file name keeps its extension so syntax highlighting works. */
  put(file: string, before: string, after: string): [vscode.Uri, vscode.Uri] {
    const id = ++this.seq;
    const name = path.basename(file);
    const left = vscode.Uri.from({ scheme: DiffDocuments.scheme, path: `/${id}/before/${name}` });
    const right = vscode.Uri.from({ scheme: DiffDocuments.scheme, path: `/${id}/after/${name}` });
    this.docs.set(left.path, before);
    this.docs.set(right.path, after);
    // Bounded: keep the documents of the last 20 diffs.
    while (this.docs.size > 40) this.docs.delete(this.docs.keys().next().value as string);
    return [left, right];
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? '';
  }
}

function isTreeNode(v: unknown): v is TreeNode {
  return typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string';
}

function isToolError(v: unknown): v is ToolErrorEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.tool === 'string' && typeof e.input === 'string' && typeof e.error === 'string';
}

function fenced(text: string, lang = ''): string {
  let longest = 2;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function collectDashboardSessions(
  projects: ProjectInfo[],
  codex: SessionFileInfo[],
  sinceMsValue: number,
  workspaceOnly: boolean,
  store: SessionStore,
): Promise<DashboardSession[]> {
  const jobs: Array<{ info: SessionFileInfo; project: string }> = [];
  for (const p of projects) {
    const cwd = (await store.peek(p.sessions[0])).cwd;
    if (workspaceOnly && !matchesCurrentWorkspace(p.dirName, cwd)) continue;
    const project = cwd ? path.basename(cwd) : p.decodedPath;
    for (const s of p.sessions) if (s.mtimeMs >= sinceMsValue) jobs.push({ info: s, project });
  }
  for (const s of codex) {
    if (s.mtimeMs < sinceMsValue) continue;
    const cwd = (await store.peek(s)).cwd;
    if (workspaceOnly && !(cwd && matchesCurrentWorkspace('', cwd))) continue;
    jobs.push({ info: s, project: `${cwd ? path.basename(cwd) : 'unknown'} (Codex)` });
  }
  const results = await mapPool(jobs, 4, async (j) => {
    try {
      return { summary: await store.getSummary(j.info), project: j.project };
    } catch {
      return undefined;
    }
  });
  return results.filter((r): r is DashboardSession => !!r);
}

interface PickOptions {
  placeHolder?: string;
  exclude?: string;
  /** Peek every session (slower) so first prompts and branches are searchable. */
  peekAll?: boolean;
}

async function pickSession(
  tree: SessionTreeProvider,
  store: SessionStore,
  annotations: AnnotationStore,
  opts: PickOptions = {},
): Promise<string | undefined> {
  const sessions = (await allSessions(tree))
    .filter((s) => s.filePath !== opts.exclude)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, opts.peekAll ? QUICK_PICK_LIMIT : 200);
  const items = await mapPool(sessions, 8, async (s) => {
    const summary = store.getCached(s);
    const peek = await store.peek(s);
    const ann = annotations.get(s.sessionId);
    const cwd = peek.cwd ?? s.projectDir;
    const bits = [
      formatRelativeTime(s.mtimeMs),
      path.basename(cwd),
      peek.gitBranch,
      summary ? `${formatTokens(totalTokens(summary.totalUsage))} tok` : undefined,
      ...(ann.tags ?? []).map((t) => '#' + t),
    ].filter(Boolean);
    return {
      label: `${ann.pinned ? '$(pinned) ' : ''}${summary?.title ?? peek.title ?? s.sessionId}`,
      description: bits.join(' · '),
      detail: [peek.firstPrompt, ann.note ? `📝 ${ann.note}` : undefined, cwd].filter(Boolean).join(' — '),
      filePath: s.filePath,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: opts.placeHolder ?? 'Select a Claude Code session',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.filePath;
}

export function deactivate(): void {
  // Everything is disposed via context.subscriptions.
}
