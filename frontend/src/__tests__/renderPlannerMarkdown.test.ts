import { describe, it, expect } from 'vitest';
import { Marked } from 'marked';

// We replicate the same renderPlannerMarkdown logic that will live in public/app.js
// by importing `marked` as a module here and configuring it identically.
// This tests the rendering logic independent of the browser global.

function createPlannerRenderer() {
  const marked = new Marked();

  const renderer = {
    // Allow h3 and h4 only — downgrade h1/h2 to h3
    heading(this: { parser: { parseInline(tokens: unknown[]): string } }, { tokens, depth }: { tokens: unknown[]; depth: number }): string {
      const text = this.parser.parseInline(tokens);
      const level = depth < 3 ? 3 : depth > 4 ? 4 : depth;
      return `<h${level}>${text}</h${level}>\n`;
    },
    // Links: open in new tab, rel noopener
    link({ href, text }: { href: string; text: string }) {
      const sanitizedHref = href && href.match(/^https?:\/\//) ? href : '#';
      return `<a href="${sanitizedHref}" target="_blank" rel="noopener noreferrer">${text}</a>`;
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
    // Raw HTML is escaped (rendered as text)
    html({ text }: { text: string }) {
      return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  };

  marked.use({ renderer, breaks: true });
  return marked;
}

function renderPlannerMarkdown(text: string): string {
  const marked = createPlannerRenderer();
  return (marked.parse(text) as string).trim();
}

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

    it('renders line breaks with breaks:true', () => {
      const result = renderPlannerMarkdown('line 1\nline 2');
      expect(result).toContain('<br');
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
});
