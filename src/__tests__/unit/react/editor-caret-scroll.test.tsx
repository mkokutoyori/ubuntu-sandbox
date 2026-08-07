/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { scrollCaretIntoView, lineHeightOf } from '@/components/editors/caretScroll';

function textarea(opts: { clientHeight: number; scrollTop?: number }): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  Object.defineProperty(ta, 'clientHeight', { value: opts.clientHeight, configurable: true });
  Object.defineProperty(ta, 'scrollHeight', { value: 20 * 200, configurable: true });
  ta.style.lineHeight = '20px';
  document.body.appendChild(ta);
  ta.scrollTop = opts.scrollTop ?? 0;
  return ta;
}

describe('the caret drags the viewport with it', () => {
  it('a caret below the fold scrolls the view down', () => {
    const ta = textarea({ clientHeight: 200 });
    scrollCaretIntoView(ta, 30, 200);
    expect(ta.scrollTop).toBe(30 * 20 + 20 - 200);
  });

  it('a caret above the fold scrolls the view up', () => {
    const ta = textarea({ clientHeight: 200, scrollTop: 600 });
    scrollCaretIntoView(ta, 5, 200);
    expect(ta.scrollTop).toBe(100);
  });

  it('a caret already visible moves nothing', () => {
    const ta = textarea({ clientHeight: 200, scrollTop: 100 });
    scrollCaretIntoView(ta, 7, 200);
    expect(ta.scrollTop).toBe(100);
  });

  it('a viewport of unknown height is left alone rather than guessed', () => {
    const ta = textarea({ clientHeight: 0, scrollTop: 42 });
    scrollCaretIntoView(ta, 100, 200);
    expect(ta.scrollTop).toBe(42);
  });

  it('the line height comes from the style, not from a guess', () => {
    const ta = textarea({ clientHeight: 200 });
    expect(lineHeightOf(ta, 200)).toBe(20);
  });
});
