// `dashlint diff --format text` (spec 6.7.5): the PR comment's rows and sentences for a terminal,
// then the ignore warnings, the result line and the closing sentence (G11). Every string comes from
// messages.ts.
import { commentNotes, commentRows, fixedItems, type CommentInput } from './markdown.js';
import { CLOSING_SENTENCE, commentText, diffText, reportText } from './messages.js';
import { wrap } from './text.js';

export function renderDiffText(input: CommentInput): string {
  const { diff, head } = input;
  const lines = [
    diffText.header(head.report.tool, diff.base.commit, diff.head.commit),
    diffText.title(diff.worse.length, diff.alerts.worse.length),
  ];
  for (const row of commentRows(input)) {
    lines.push('', ...wrap(row.change, 0));
    for (const b of row.breaks) lines.push(...wrap(diffText.breaks(b), 2));
  }
  const fixed = fixedItems(input);
  if (fixed.length > 0) lines.push('', ...wrap(commentText.fixed(fixed), 0));
  lines.push('');
  for (const note of commentNotes(input)) lines.push(...wrap(note, 0));
  for (const w of diff.warnings)
    lines.push(
      w.code === 'ignore-expired'
        ? reportText.ignoreExpired(w.entry.id, w.entry.until ?? '')
        : reportText.ignoreUnmatched(w.entry.id),
    );
  lines.push(diffText.result(diff.worse.filter((w) => w.fails).length, diff.failOn));
  lines.push(CLOSING_SENTENCE);
  return `${lines.join('\n')}\n`;
}
