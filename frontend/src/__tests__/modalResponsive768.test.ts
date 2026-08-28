import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Modal responsive styles (≤768px)', () => {
  const css = readFileSync(resolve(__dirname, '../style.css'), 'utf-8');

  // Extract the *last* 768px media query block (the one containing modal rules).
  // There are multiple 768px blocks; the modal rules live in the one near the end of the file.
  function get768ModalBlock(): string {
    const blocks: string[] = [];
    const re = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{([\s\S]*?)^\}/gm;
    let m;
    while ((m = re.exec(css)) !== null) {
      blocks.push(m[1]);
    }
    // Find the block that contains modal-backdrop (i.e. the modal-specific one)
    const modalBlock = blocks.find(b => b.includes('.modal-backdrop'));
    expect(modalBlock).toBeDefined();
    return modalBlock!;
  }

  describe('full-screen modals on mobile', () => {
    it('should stretch .modal-backdrop on mobile', () => {
      const block = get768ModalBlock();
      expect(block).toMatch(/\.modal-backdrop\s*\{[^}]*align-items:\s*stretch/);
      expect(block).toMatch(/\.modal-backdrop\s*\{[^}]*justify-content:\s*stretch/);
    });

    it('should make .modal (excluding .modal-confirm) full viewport width', () => {
      const block = get768ModalBlock();
      expect(block).toMatch(/\.modal:not\(\.modal-confirm\)[^{]*\{[^}]*width:\s*100vw/);
    });

    it('should make .modal (excluding .modal-confirm) full viewport height', () => {
      const block = get768ModalBlock();
      expect(block).toMatch(/\.modal:not\(\.modal-confirm\)[^{]*\{[^}]*height:\s*100dvh/);
    });

    it('should remove border-radius for full-screen modals', () => {
      const block = get768ModalBlock();
      expect(block).toMatch(/\.modal:not\(\.modal-confirm\)[^{]*\{[^}]*border-radius:\s*0/);
    });

    it('should set max-height: 100dvh for full-screen modals', () => {
      const block = get768ModalBlock();
      expect(block).toMatch(/\.modal:not\(\.modal-confirm\)[^{]*\{[^}]*max-height:\s*100dvh/);
    });

    it('should set max-width: none for full-screen modals', () => {
      const block = get768ModalBlock();
      expect(block).toMatch(/\.modal:not\(\.modal-confirm\)[^{]*\{[^}]*max-width:\s*none/);
    });

    it('should include .modal-wide in full-screen rules', () => {
      const block = get768ModalBlock();
      // .modal-wide should appear in the same selector group
      expect(block).toMatch(/\.modal-wide[\s,][^{]*\{[^}]*width:\s*100vw/);
    });

    it('should include .task-planner-modal in full-screen rules', () => {
      const block = get768ModalBlock();
      expect(block).toMatch(/\.task-planner-modal[^{]*\{[^}]*width:\s*100vw/);
    });
  });

  describe('.modal-confirm stays compact on mobile', () => {
    it('should NOT apply full-screen sizing to .modal-confirm (excluded via :not())', () => {
      const block = get768ModalBlock();
      // The selector explicitly excludes .modal-confirm
      expect(block).toMatch(/\.modal:not\(\.modal-confirm\)/);
      // And .modal-confirm should NOT appear as a standalone selector getting full-screen rules
      expect(block).not.toMatch(/\.modal-confirm[^)][^{]*\{[^}]*width:\s*100vw/);
    });

    it('should prevent .modal-confirm from being stretched by backdrop align-items: stretch', () => {
      const block = get768ModalBlock();
      // .modal-confirm needs align-self: center to override the backdrop stretch
      expect(block).toMatch(/\.modal-confirm\s*\{[^}]*align-self:\s*center/);
    });

    it('should horizontally center .modal-confirm with margin-inline: auto', () => {
      const block = get768ModalBlock();
      // The backdrop uses justify-content: stretch, which left-aligns items that don't
      // fill the container. .modal-confirm keeps its constrained width (max-width: 420px),
      // so it needs margin-inline: auto (or margin: 0 auto) for horizontal centering.
      expect(block).toMatch(/\.modal-confirm\s*\{[^}]*margin-inline:\s*auto/);
    });
  });
});
