import { Marked } from 'marked';

const marked = new Marked();

marked.use({
  renderer: {
    // Allow h3 and h4 only — downgrade h1/h2 to h3, cap h5/h6 at h4
    heading(this: { parser: { parseInline(tokens: unknown[]): string } }, { tokens, depth }: { tokens: unknown[]; depth: number }): string {
      const text = this.parser.parseInline(tokens);
      const level = depth < 3 ? 3 : depth > 4 ? 4 : depth;
      return `<h${level}>${text}</h${level}>\n`;
    },
    // Links: open in new tab, sanitize non-http(s) hrefs
    link({ href, text }: { href: string; text: string }) {
      const sanitizedHref = href && href.match(/^https?:\/\//) ? href : '#';
      const escapedHref = sanitizedHref.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<a href="${escapedHref}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    // Strip images
    image() {
      return '';
    },
    // Strip horizontal rules
    hr() {
      return '';
    },
    // Strip tables
    table() {
      return '';
    },
    tablerow() {
      return '';
    },
    tablecell() {
      return '';
    },
    // Raw HTML is escaped (rendered as text, not injected)
    html({ text }: { text: string }) {
      return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  },
  // breaks: true is intentionally NOT set here — single newlines should flow
  // as spaces, not become <br> tags. Only blank lines (real paragraph breaks)
  // or two trailing spaces should produce breaks. The CSS on .planner-message
  // (no white-space: pre-wrap) also relies on this for assistant bubbles.
});

/**
 * IMPORTANT — the renderer is the single source of truth for how planner
 * output is displayed. It must NOT rely on the planner prompt (see
 * TASK_PLANNER_SYSTEM_PROMPT in backend/src/routes/task-planner.ts) actually
 * following its own formatting hint. The prompt only *suggests* a shape
 * (`**Qn — Title**:` on its own line, blank-line separated, `Rec:` on its own
 * line); this renderer is authoritative and must degrade gracefully for any
 * reasonable markdown the planner emits, including headers whose bold markers
 * are malformed or missing entirely.
 *
 * Regex that matches the start of a question block. It detects a question
 * header by the `Q<number>` + separator pattern, whether or not the bold
 * `**...**` markers are present. Matches lines like:
 *   **Q1 - Title**: body    (hyphen separator, bold)
 *   **Q1 — Title**: body    (em-dash separator, bold)
 *   **Q1: Title**           (colon separator, bold)
 *   **Q2 Some title**       (whitespace separator, bold)
 *   Q3 — Budget: body       (em-dash separator, NO bold — was previously
 *                            swallowed into the prior card; see defect #4)
 *   Q4: body                (colon separator, no bold)
 *
 * The key is: line starts (optionally with whitespace), then optional `**`,
 * then "Q" followed by one or more digits, then a separator (`—`, `–`, `-`,
 * `:`, or whitespace). Requiring a separator avoids misfiring on prose that
 * merely starts with a "Q<number>" token with no delimiter.
 */
const QUESTION_LINE_RE = /^\s*(?:\*\*\s*)?Q\d+\s*(?:[—–:-]|\s)/;

/**
 * Normalizes a question header line into leak-free HTML where the header label
 * always renders bold. Two cases, both guaranteed to emit no literal `*`:
 *
 *  1. The line contains a (possibly malformed) bold span around the label —
 *     e.g. `**Q1 — Title**: rest` or the malformed `**Q1 — Title **: rest`
 *     (stray space before the closer, which CommonMark refuses to treat as
 *     strong emphasis and would otherwise leak `**`). We split at the label's
 *     closing `**`, bold the label, and render the trailing remainder as normal
 *     inline text — preserving the original "bold label + regular body" look.
 *  2. No usable bold span (a bare `Q3 — …` header that lost its markers, or a
 *     line with a single stray `*`). We strip every `*` and bold the whole
 *     header line.
 *
 * In all cases any inline markup inside the parts (e.g. `` `code` ``) is
 * preserved via inline rendering, and no `*` survives into the output.
 */
function renderQuestionHeader(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';

  const inline = (s: string): string =>
    s ? (marked.parseInline(s) as string).trim() : '';

  // Try to isolate a leading bold label: `**<label>**<rest>`. Tolerate a stray
  // space just inside the markers (`** label **`) that would break CommonMark.
  const boldMatch = trimmed.match(/^\*\*\s*([\s\S]*?)\s*\*\*(.*)$/);
  if (boldMatch) {
    const label = boldMatch[1].replace(/\*/g, '').trim();
    const rest = boldMatch[2].replace(/\*/g, '');
    const restHtml = inline(rest);
    return restHtml
      ? `<strong>${inline(label)}</strong>${restHtml}`
      : `<strong>${inline(label)}</strong>`;
  }

  // No bold span present — strip any stray * and bold the whole header line.
  const bare = trimmed.replace(/\*/g, '').trim();
  return bare ? `<strong>${inline(bare)}</strong>` : '';
}

/**
 * Matches a "Rec:" line (recommendation), optionally with leading whitespace.
 */
const REC_LINE_RE = /^\s*Rec:/;

/**
 * Given an array of lines belonging to a question block (starts at the **Qn**
 * line), find the index just past the last "question content" line. Lines after
 * that index that are separated by at least one blank line from the last
 * question content are considered "outro" content that should render outside
 * the card.
 *
 * A question content line is: the header line, any body/option line, or a
 * Rec: line. The end-of-content boundary is determined by finding the last
 * non-blank line in the block that isn't separated from the Q-header by a
 * significant (2+) blank-line gap AFTER a Rec: line.
 *
 * In practice, the separator between question content and trailing outro is
 * a blank line that follows the last Rec: line (or last body line if no Rec:).
 *
 * Returns [questionLines, outroLines].
 */
function splitQuestionAndOutro(lines: string[]): [string[], string[]] {
  // Find the index of the last Rec: line or, if none, the last non-blank line
  let lastContentIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      lastContentIdx = i;
      break;
    }
  }

  if (lastContentIdx < 0) return [[], []];

  // Look for the first blank line that appears after the last Rec: line
  // (or after the content, if no Rec: line).
  // The blank line marks the boundary between question content and outro.
  // Walk backward from lastContentIdx + 1 to find a blank-line gap before
  // lastContentIdx that separates trailing content from question content.
  // Simpler: find the last Rec: line, then check if there's non-blank content
  // after a blank line that follows the last Rec: line.

  let lastRecIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (REC_LINE_RE.test(lines[i])) {
      lastRecIdx = i;
    }
  }

  // The "pivot" is either the last Rec: line or the last non-blank content line
  const pivotIdx = lastRecIdx >= 0 ? lastRecIdx : lastContentIdx;

  // Find the first blank line after the pivot
  let firstBlankAfterPivot = -1;
  for (let i = pivotIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      firstBlankAfterPivot = i;
      break;
    }
  }

  // If there's no blank line after the pivot, everything is question content
  if (firstBlankAfterPivot < 0) {
    return [lines, []];
  }

  // Check if there's any non-blank content after the blank gap
  let hasOutro = false;
  for (let i = firstBlankAfterPivot + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      hasOutro = true;
      break;
    }
  }

  if (!hasOutro) {
    return [lines, []];
  }

  // Split: question content is lines[0..firstBlankAfterPivot-1],
  // outro is lines[firstBlankAfterPivot+1..]
  return [
    lines.slice(0, firstBlankAfterPivot),
    lines.slice(firstBlankAfterPivot + 1),
  ];
}

/**
 * Pre-process the raw markdown text: detect question blocks and wrap them
 * in placeholder markers. Then render markdown, then replace the markers
 * with actual HTML divs.
 *
 * Strategy: split into lines, detect question boundaries, group them.
 * Pre-processing is done on the raw text (before markdown rendering) to
 * keep the question grouping logic simple. Rec: lines are also handled
 * at this stage.
 *
 * Returns the fully rendered HTML string.
 */
function renderWithQuestionCards(text: string): string {
  const lines = text.split('\n');

  // Find question block boundaries (indices of lines matching QUESTION_LINE_RE)
  const questionStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (QUESTION_LINE_RE.test(lines[i])) {
      questionStarts.push(i);
    }
  }

  if (questionStarts.length === 0) {
    // No question blocks — render normally
    return (marked.parse(text) as string).trim();
  }

  // Build segments: each segment is either "normal text" or a "question block"
  type Segment =
    | { type: 'normal'; lines: string[] }
    | { type: 'question'; lines: string[] };

  const segments: Segment[] = [];

  // Text before the first question block
  if (questionStarts[0] > 0) {
    segments.push({ type: 'normal', lines: lines.slice(0, questionStarts[0]) });
  }

  for (let qi = 0; qi < questionStarts.length; qi++) {
    const start = questionStarts[qi];
    const end = qi + 1 < questionStarts.length ? questionStarts[qi + 1] : lines.length;
    const blockLines = lines.slice(start, end);

    // For the last question block, split off any trailing outro text
    // (content after a blank-line gap following the last Rec: line)
    if (qi === questionStarts.length - 1) {
      const [questionLines, outroLines] = splitQuestionAndOutro(blockLines);
      segments.push({ type: 'question', lines: questionLines });
      if (outroLines.length > 0) {
        segments.push({ type: 'normal', lines: outroLines });
      }
    } else {
      segments.push({ type: 'question', lines: blockLines });
    }
  }

  // Build the output HTML by processing each segment
  let html = '';
  for (const segment of segments) {
    if (segment.type === 'normal') {
      const normalText = segment.lines.join('\n').trim();
      if (normalText) {
        html += (marked.parse(normalText) as string).trim() + '\n';
      }
    } else {
      // Question block: render the question lines with internal differentiation
      html += renderQuestionCard(segment.lines);
    }
  }

  return html.trim();
}

/**
 * Render a single question block (array of lines) as a .planner-question card.
 * The first line is the header (**Qn - ...**), Rec: lines get special treatment,
 * remaining lines are the body.
 */
function renderQuestionCard(lines: string[]): string {
  // Trim trailing blank lines from the card content
  const trimmedLines = [...lines];
  while (trimmedLines.length > 0 && trimmedLines[trimmedLines.length - 1].trim() === '') {
    trimmedLines.pop();
  }

  if (trimmedLines.length === 0) return '';

  const headerLine = trimmedLines[0];
  const bodyLines = trimmedLines.slice(1);

  // Normalize the header to a single, consistent bold form. This guarantees the
  // header always renders bold with no leaked `*` characters, regardless of
  // whether the original line used well-formed bold, malformed bold (stray
  // space before the closing **), or no bold at all (a bare `Q3 — …`).
  const headerHtml = renderQuestionHeader(headerLine);

  // Separate body lines from Rec: lines
  const recLines: string[] = [];
  const regularBodyLines: string[] = [];

  for (const line of bodyLines) {
    if (REC_LINE_RE.test(line)) {
      recLines.push(line);
    } else {
      regularBodyLines.push(line);
    }
  }

  let cardHtml = '<div class="planner-question">\n';

  // Header section — rendered as its own block
  if (headerHtml) {
    cardHtml += `<div class="planner-question-header">${headerHtml}</div>\n`;
  }

  // Body content — option lines (e.g. "(A) ...", "(B) ...") are emitted one
  // per line by the planner and are semantically list-like, so they must stay
  // on separate lines even though breaks:true is off for prose reflow. Append
  // two trailing spaces to each body line so real markdown hard breaks (<br>)
  // apply within the card body.
  const bodyText = regularBodyLines
    .map((line) => (line.trim() === '' ? line : line.replace(/\s+$/, '') + '  '))
    .join('\n')
    .trim();
  if (bodyText) {
    const bodyHtml = (marked.parse(bodyText) as string).trim();
    cardHtml += `<div class="planner-question-body">${bodyHtml}</div>\n`;
  }

  // Rec: lines
  for (const recLine of recLines) {
    // Render the Rec: line as inline markdown, but wrap in the rec class.
    // Emphasize the leading "Rec:" label itself so it stands out from the
    // recommended answer text (the .planner-question-rec wrapper only mutes/
    // indents the whole line).
    const recContent = recLine.trim();
    const recBody = recContent.replace(REC_LINE_RE, '').trim();
    const recBodyHtml = recBody ? (marked.parseInline(recBody) as string).trim() : '';
    const recHtml = recBodyHtml
      ? `<strong>Rec:</strong> ${recBodyHtml}`
      : '<strong>Rec:</strong>';
    cardHtml += `<div class="planner-question-rec">${recHtml}</div>\n`;
  }

  cardHtml += '</div>\n';
  return cardHtml;
}

export function renderPlannerMarkdown(text: string): string {
  return renderWithQuestionCards(text);
}
