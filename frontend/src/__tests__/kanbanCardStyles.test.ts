import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Kanban task card styles', () => {
  const css = readFileSync(resolve(__dirname, '../style.css'), 'utf-8');

  it('.task-card should not clip content with overflow: hidden', () => {
    // Extract the .task-card rule (not nested inside a dark-mode selector)
    const taskCardMatch = css.match(/(?<!\[data-theme[^\]]*\]\s*)\.task-card\s*\{([^}]*)\}/);
    expect(taskCardMatch).not.toBeNull();
    const taskCardBody = taskCardMatch![1];
    // It should NOT have overflow: hidden (which would clip title and metadata)
    expect(taskCardBody).not.toMatch(/overflow:\s*hidden/);
  });

  it('.card-title should have word-wrap: break-word for proper wrapping', () => {
    const cardTitleMatch = css.match(/\.card-title\s*\{([^}]*)\}/);
    expect(cardTitleMatch).not.toBeNull();
    const cardTitleBody = cardTitleMatch![1];
    expect(cardTitleBody).toMatch(/word-wrap:\s*break-word/);
  });

  it('.card-title should have overflow-wrap: break-word for proper wrapping', () => {
    const cardTitleMatch = css.match(/\.card-title\s*\{([^}]*)\}/);
    expect(cardTitleMatch).not.toBeNull();
    const cardTitleBody = cardTitleMatch![1];
    expect(cardTitleBody).toMatch(/overflow-wrap:\s*break-word/);
  });

  it('.kanban grid should ensure columns have proper minimum width', () => {
    const kanbanMatch = css.match(/\.kanban\s*\{([^}]*)\}/);
    expect(kanbanMatch).not.toBeNull();
    const kanbanBody = kanbanMatch![1];
    // Should have minmax(260px, ...) in grid-template-columns
    expect(kanbanBody).toMatch(/grid-template-columns:.*minmax\(260px/);
  });
});
