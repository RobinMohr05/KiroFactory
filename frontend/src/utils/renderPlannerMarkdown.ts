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
  breaks: true,
});

export function renderPlannerMarkdown(text: string): string {
  return (marked.parse(text) as string).trim();
}
