// Helpers for building terminal commands from transcript data. No vscode dependency.
import * as path from 'path';

/** Session ids passed to `--resume`; the first character cannot be `-` or `.` so an id never reads as an option. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/** POSIX shell single-quoting. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Drops control characters (escape sequences, carriage returns, ...) except tab and newline. */
export function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

/** True for shells whose single quotes follow POSIX rules (so shellQuote is safe). */
export function isPosixShell(shellPath: string | undefined): boolean {
  if (!shellPath) return false;
  return ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(path.basename(shellPath).toLowerCase());
}
