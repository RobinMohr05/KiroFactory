import { describe, it, expect } from 'vitest';
import { renderPlannerMarkdown } from '../utils/renderPlannerMarkdown';

describe('renderPlannerMarkdown', () => {
  describe('inline formatting', () => {
    it('renders bold text', () => {
      const result = renderPlannerMarkdown('**hello**');
      expect(result).toContain('<strong>hello</strong>');
    });

    it('renders italic text', () => {
      const result = renderPlannerMarkdown('*hello*');
      expect(result).toContain('<em>hello</em>');
    });

    it('renders inline code', () => {
      const result = renderPlannerMarkdown('use `npm install`');
      expect(result).toContain('<code>npm install</code>');
    });
  });

  describe('block elements', () => {
    it('renders unordered lists', () => {
      const result = renderPlannerMarkdown('- item 1\n- item 2');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>item 1</li>');
      expect(result).toContain('<li>item 2</li>');
    });

    it('renders ordered lists', () => {
      const result = renderPlannerMarkdown('1. first\n2. second');
      expect(result).toContain('<ol>');
      expect(result).toContain('<li>first</li>');
      expect(result).toContain('<li>second</li>');
    });

    it('renders fenced code blocks', () => {
      const result = renderPlannerMarkdown('```js\nconst x = 1;\n```');
      expect(result).toContain('<pre>');
      expect(result).toContain('<code');
      expect(result).toContain('const x = 1;');
    });

    it('renders h3 headers', () => {
      const result = renderPlannerMarkdown('### Title');
      expect(result).toContain('<h3>Title</h3>');
    });

    it('renders h4 headers', () => {
      const result = renderPlannerMarkdown('#### Subtitle');
      expect(result).toContain('<h4>Subtitle</h4>');
    });

    it('downgrades h1 to h3', () => {
      const result = renderPlannerMarkdown('# Big Title');
      expect(result).toContain('<h3>Big Title</h3>');
      expect(result).not.toContain('<h1>');
    });

    it('downgrades h2 to h3', () => {
      const result = renderPlannerMarkdown('## Medium Title');
      expect(result).toContain('<h3>Medium Title</h3>');
      expect(result).not.toContain('<h2>');
    });

    it('renders paragraphs', () => {
      const result = renderPlannerMarkdown('Hello world');
      expect(result).toContain('<p>Hello world</p>');
    });

    it('does not insert <br> for single newlines (no breaks:true)', () => {
      // Single \n should NOT produce a <br> — it should flow as a space
      const result = renderPlannerMarkdown('line 1\nline 2');
      expect(result).not.toContain('<br');
    });

    it('separates blank-line-delimited paragraphs into distinct <p> blocks', () => {
      const result = renderPlannerMarkdown('paragraph one\n\nparagraph two');
      expect(result).toContain('<p>');
      // Both paragraphs should be present
      expect(result).toContain('paragraph one');
      expect(result).toContain('paragraph two');
    });
  });

  describe('links', () => {
    it('renders links with target=_blank and rel=noopener', () => {
      const result = renderPlannerMarkdown('[click](https://example.com)');
      expect(result).toContain('href="https://example.com"');
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
    });

    it('sanitizes non-http links to #', () => {
      const result = renderPlannerMarkdown('[xss](javascript:alert(1))');
      expect(result).toContain('href="#"');
      expect(result).not.toContain('javascript:');
    });

    it('escapes special characters in href attributes', () => {
      const result = renderPlannerMarkdown('[click](https://example.com/path?a=1&b=2)');
      expect(result).toContain('href="https://example.com/path?a=1&amp;b=2"');
    });
  });

  describe('stripped elements', () => {
    it('strips images', () => {
      const result = renderPlannerMarkdown('![alt](http://img.png)');
      expect(result).not.toContain('<img');
      expect(result).not.toContain('img.png');
    });

    it('strips horizontal rules', () => {
      const result = renderPlannerMarkdown('---');
      expect(result).not.toContain('<hr');
    });

    it('strips tables', () => {
      const result = renderPlannerMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
      expect(result).not.toContain('<table');
      expect(result).not.toContain('<td');
    });
  });

  describe('XSS prevention', () => {
    it('escapes raw HTML tags', () => {
      const result = renderPlannerMarkdown('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes HTML in inline context', () => {
      const result = renderPlannerMarkdown('hello <b>world</b>');
      expect(result).not.toContain('<b>world</b>');
      expect(result).toContain('&lt;b&gt;');
    });

    it('strips valid image markdown entirely', () => {
      const result = renderPlannerMarkdown('![alt text](https://example.com/img.png)');
      expect(result).not.toContain('<img');
      expect(result).not.toContain('example.com/img.png');
    });
  });

  describe('question card grouping', () => {
    const TWO_QUESTION_INPUT = [
      'Here are your questions:',
      '',
      '**Q1 - Project scope**: What is the scope of this project?',
      '(A) Small',
      '(B) Large',
      'Rec: (A) Small',
      '',
      '**Q2 - Timeline**: When should this be done?',
      '(A) One week',
      '(B) One month',
      'Rec: (B) One month',
      '',
      'Please answer the questions above.',
    ].join('\n');

    it('wraps each **Qn** block in a .planner-question card', () => {
      const result = renderPlannerMarkdown(TWO_QUESTION_INPUT);
      // Should have exactly 2 question cards
      const matches = result.match(/class="planner-question"/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(2);
    });

    it('places intro text outside any question card', () => {
      const result = renderPlannerMarkdown(TWO_QUESTION_INPUT);
      // The intro "Here are your questions" must appear before the first card
      const introIdx = result.indexOf('Here are your questions');
      const firstCardIdx = result.indexOf('planner-question');
      expect(introIdx).toBeGreaterThanOrEqual(0);
      expect(firstCardIdx).toBeGreaterThanOrEqual(0);
      expect(introIdx).toBeLessThan(firstCardIdx);
    });

    it('places outro text outside any question card', () => {
      const result = renderPlannerMarkdown(TWO_QUESTION_INPUT);
      const lastCardEnd = result.lastIndexOf('</div>');
      const outroIdx = result.lastIndexOf('Please answer the questions above');
      expect(outroIdx).toBeGreaterThanOrEqual(0);
      expect(outroIdx).toBeGreaterThan(lastCardEnd);
    });

    it('wraps Rec: line in .planner-question-rec element', () => {
      const result = renderPlannerMarkdown(TWO_QUESTION_INPUT);
      expect(result).toContain('planner-question-rec');
    });

    it('contains both question headers inside their cards', () => {
      const result = renderPlannerMarkdown(TWO_QUESTION_INPUT);
      expect(result).toContain('Q1 - Project scope');
      expect(result).toContain('Q2 - Timeline');
    });

    it('passes through text with no **Qn** blocks unchanged (no cards)', () => {
      const input = 'This is just a regular message with **bold** text.';
      const result = renderPlannerMarkdown(input);
      expect(result).not.toContain('planner-question');
      expect(result).toContain('<strong>bold</strong>');
    });

    it('handles Q1: syntax (colon after number)', () => {
      const input = '**Q1: What is your goal?**\nSome body text\nRec: Answer A';
      const result = renderPlannerMarkdown(input);
      expect(result).toContain('planner-question');
    });

    it('handles Q1 — syntax (em-dash after number)', () => {
      const input = '**Q1 — What is your goal?**\nSome body text\nRec: Answer A';
      const result = renderPlannerMarkdown(input);
      expect(result).toContain('planner-question');
    });

    it('emphasizes the "Rec" label within the .planner-question-rec sub-line', () => {
      const input = '**Q1 - Scope**: What is the scope?\n(A) Small\nRec: (A) Small';
      const result = renderPlannerMarkdown(input);
      // The "Rec:" label itself must be bolded, distinct from the answer text
      expect(result).toMatch(/<strong>Rec:<\/strong>/);
    });

    it('keeps option lines on separate lines inside a question card', () => {
      const input = [
        '**Q1 - Size**: What size?',
        '(A) Small',
        '(B) Large',
        '(C) Neither',
        'Rec: (A) Small',
      ].join('\n');
      const result = renderPlannerMarkdown(input);
      // Options must not collapse onto a single line; expect <br> separators
      const bodyMatch = result.match(/<div class="planner-question-body">([\s\S]*?)<\/div>/);
      expect(bodyMatch).not.toBeNull();
      const body = bodyMatch![1];
      expect(body).toContain('<br');
      // All three options should be present
      expect(body).toContain('(A) Small');
      expect(body).toContain('(B) Large');
      expect(body).toContain('(C) Neither');
    });
  });

  describe('rendering-bug fixes (task #1670)', () => {
    // Defect 1: literal markdown leaking in the header. A header whose closing
    // ** has a space before it (`**Q1 — Title **:`) is not treated as strong
    // emphasis by CommonMark, so the raw ** would leak as visible text.
    it('renders a header with ** as bold with no literal * characters', () => {
      const input = '**Q1 — Title**: What is the scope?\nRec: yes';
      const result = renderPlannerMarkdown(input);
      const headerMatch = result.match(/<div class="planner-question-header">([\s\S]*?)<\/div>/);
      expect(headerMatch).not.toBeNull();
      const header = headerMatch![1];
      expect(header).toContain('<strong>');
      expect(header).not.toContain('*');
    });

    it('does not leak ** when the closing marker has a stray space', () => {
      const input = '**Q1 — Title **: What is the scope?\nRec: yes';
      const result = renderPlannerMarkdown(input);
      const headerMatch = result.match(/<div class="planner-question-header">([\s\S]*?)<\/div>/);
      expect(headerMatch).not.toBeNull();
      const header = headerMatch![1];
      expect(header).toContain('<strong>');
      expect(header).not.toContain('*');
      expect(header).toContain('Q1');
      expect(header).toContain('Title');
    });

    // Defect 4 + (b): a full multi-question message renders as N separate cards.
    it('renders a full multi-question message as N separate .planner-question cards', () => {
      const input = [
        'Here are your questions:',
        '',
        '**Q1 — Scope**: What is the scope?',
        '(A) Small',
        'Rec: (A) Small',
        '',
        '**Q2 — Timeline**: When?',
        '(A) One week',
        'Rec: (A) One week',
        '',
        '**Q3 — Budget**: How much?',
        '(A) Low',
        'Rec: (A) Low',
      ].join('\n');
      const result = renderPlannerMarkdown(input);
      const matches = result.match(/class="planner-question"/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(3);
    });

    // Defect 4 regression: the second question lost its bold ** (bare `Q3 —`)
    // and previously got swallowed into the prior card. Must still produce two
    // separate cards.
    it('splits a bare (un-bolded) Q header into its own card', () => {
      const input = [
        '**Q2 — Timeline**: When?',
        '(A) week',
        'Rec: (A) week',
        'Q3 — Budget: How much?',
        '(A) low',
        'Rec: (A) low',
      ].join('\n');
      const result = renderPlannerMarkdown(input);
      const matches = result.match(/class="planner-question"/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(2);
      // The bare header must be normalized to bold with no literal *
      expect(result).toContain('Q3');
      expect(result).toContain('Budget');
    });

    it('normalizes a bare Q header to a bold header with no leaked markers', () => {
      const input = 'Q1 — Scope: What is the scope?\nRec: (A) Small';
      const result = renderPlannerMarkdown(input);
      const headerMatch = result.match(/<div class="planner-question-header">([\s\S]*?)<\/div>/);
      expect(headerMatch).not.toBeNull();
      const header = headerMatch![1];
      expect(header).toContain('<strong>');
      expect(header).not.toContain('*');
    });

    // Defect 3: the full Rec: line renders inside its card as <strong>Rec:</strong> …
    it('renders the full Rec: line inside its card', () => {
      const input = '**Q1 — Scope**: What is the scope?\nRec: (A) Small — recommended for the given constraints';
      const result = renderPlannerMarkdown(input);
      const recMatch = result.match(/<div class="planner-question-rec">([\s\S]*?)<\/div>/);
      expect(recMatch).not.toBeNull();
      const rec = recMatch![1];
      expect(rec).toContain('<strong>Rec:</strong>');
      expect(rec).toContain('(A) Small — recommended for the given constraints');
    });

    // Defect 5 / streaming: a partial snippet with an unclosed ** must not throw.
    it('does not throw on a partial streaming snippet with an unclosed **', () => {
      expect(() => renderPlannerMarkdown('**Q1 — Scope**: partial with `code frag')).not.toThrow();
      expect(() => renderPlannerMarkdown('**Q1 — Sco')).not.toThrow();
      expect(() => renderPlannerMarkdown('some prose with an unterminated ```code fence')).not.toThrow();
    });

    // General catch-all: no raw ** leaks into a completed multi-question render.
    it('leaks no ** into the final rendered output of a completed message', () => {
      const input = [
        '**Q1 — Scope **: What is the scope?',
        '(A) Small',
        'Rec: (A) Small',
        '',
        'Q2 — Timeline: When?',
        '(A) week',
        'Rec: (A) week',
      ].join('\n');
      const result = renderPlannerMarkdown(input);
      expect(result).not.toContain('**');
    });
  });
});
