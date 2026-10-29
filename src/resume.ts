// Where "Resume Session" opens a session. No vscode dependency.

export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
/** Command the Claude Code extension's `/open?session=` URI handler runs. */
export const CLAUDE_OPEN_SESSION_COMMAND = 'claude-vscode.primaryEditor.open';

export type ResumeMode = 'auto' | 'extension' | 'terminal';
export type ResumeTarget = 'extension' | 'terminal';

export interface ResumeContext {
  mode: ResumeMode | string | undefined;
  codex: boolean;
  /** The Claude Code extension is installed. */
  extensionAvailable: boolean;
  /** The session belongs to an open workspace folder. */
  inWorkspace: boolean;
}

/**
 * Codex sessions and machines without the Claude Code extension always use the terminal.
 * `auto` uses the extension only for sessions of the open workspace, since the extension
 * looks sessions up by the workspace's project.
 */
export function resumeTarget(ctx: ResumeContext): ResumeTarget {
  if (ctx.codex || !ctx.extensionAvailable) return 'terminal';
  if (ctx.mode === 'terminal') return 'terminal';
  if (ctx.mode === 'extension') return 'extension';
  return ctx.inWorkspace ? 'extension' : 'terminal';
}

/** URI handled by the Claude Code extension, e.g. `vscode://anthropic.claude-code/open?session=<id>`. */
export function claudeOpenSessionUri(uriScheme: string, sessionId: string): string {
  return `${uriScheme}://${CLAUDE_EXTENSION_ID}/open?session=${encodeURIComponent(sessionId)}`;
}
