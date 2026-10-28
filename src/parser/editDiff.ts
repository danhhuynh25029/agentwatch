// Turns a session's edit calls on one file into two documents for a side-by-side diff.
// No vscode dependency.
import { FileEditOp } from './conversation';

export interface DiffSides {
  before: string;
  after: string;
}

/**
 * Each edit becomes one block with the same header on both sides: the old text on the left and the
 * new text on the right, so the diff editor lines the blocks up. A Write shows its whole content as
 * added. We do not know the file's full state, only what each call replaced.
 */
export function buildDiffSides(ops: FileEditOp[], mainTranscript: string): DiffSides {
  const before: string[] = [];
  const after: string[] = [];
  ops.forEach((op, i) => {
    const flags = [
      op.tool,
      op.replaceAll ? 'replace all' : '',
      op.isError ? 'FAILED' : '',
      op.source === mainTranscript ? '' : 'subagent',
      op.timestamp ? new Date(op.timestamp).toLocaleString() : '',
    ].filter(Boolean);
    const header = `──── ${i + 1}/${ops.length} · ${flags.join(' · ')} ────`;
    before.push(header, op.oldText, '');
    after.push(header, op.newText, '');
  });
  return { before: before.join('\n'), after: after.join('\n') };
}
