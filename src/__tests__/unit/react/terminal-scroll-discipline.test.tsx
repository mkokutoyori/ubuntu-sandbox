/**
 * @vitest-environment jsdom
 *
 * Terminal auto-scroll discipline (rapport 09 audit, item #53).
 *
 * `TerminalView`'s scroll-to-bottom effect used to run unconditionally
 * on every render (no deps array, no "am I at the bottom" check), so a
 * stream (`tail -f`, continuous ping, `debug ip ospf`) yanked the view
 * back down on every new line — the user could never scroll up to read
 * earlier output. Real terminals (and this codebase's own
 * NetworkLogsPanel live-tail) only stick to the edge while the viewer
 * was already there.
 */
import { describe, expect, test } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { TerminalView } from '@/components/terminal/TerminalView';
import type { TerminalSession, TerminalTheme, InputMode, OutputLine } from '@/terminal/sessions/TerminalSession';

const theme: TerminalTheme = {
  sessionType: 'cisco',
  backgroundColor: '#000',
  textColor: '#0f0',
  errorColor: '#f00',
  promptColor: '#0f0',
  fontFamily: 'monospace',
  infoBarBg: '#222',
  infoBarText: '#fff',
  infoBarBorder: '#333',
};

function fakeSession() {
  const listeners = new Set<() => void>();
  let version = 0;
  const lines: OutputLine[] = [];
  const inputMode: InputMode = { type: 'normal' };
  const session = {
    getTheme: () => theme,
    getSessionType: () => 'cisco',
    getPrompt: () => 'R1#',
    getInfoBarContent: () => ({ left: 'R1', right: '' }),
    listAsyncJobs: () => [],
    listAttachedStreams: () => [],
    lines,
    input: '',
    currentInputMode: inputMode,
    inputMode,
    getGhostSuggestion: () => null,
    setInput: () => {},
    handleKey: () => false,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    getVersion: () => version,
  } as unknown as TerminalSession;
  return {
    session,
    addLine: (text: string) => {
      lines.push({ id: lines.length, type: 'normal', text } as OutputLine);
      act(() => { version++; listeners.forEach((l) => l()); });
    },
  };
}

/** jsdom does no real layout — stub scroll geometry so it behaves like a
 *  container with `total` px of content in a `visible`-px viewport. */
function stubScrollGeometry(el: HTMLElement, total: number, visible: number) {
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => total });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => visible });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v; },
  });
}

describe('TerminalView — scroll-to-bottom only while the user is already there', () => {
  test('a fresh terminal stays pinned to the bottom as new lines arrive', () => {
    const { session, addLine } = fakeSession();
    const { getByTestId } = render(<TerminalView session={session} />);
    const el = getByTestId('terminal-output');
    stubScrollGeometry(el, 500, 200);

    addLine('one');
    expect(el.scrollTop).toBe(500);

    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 540 });
    addLine('two');
    expect(el.scrollTop).toBe(540);
  });

  test('scrolling up to read history is not undone by the next streamed line', () => {
    const { session, addLine } = fakeSession();
    const { getByTestId } = render(<TerminalView session={session} />);
    const el = getByTestId('terminal-output');
    stubScrollGeometry(el, 500, 200);
    addLine('one'); // pinned to bottom (500) after the initial line

    // User scrolls up to read earlier output.
    el.scrollTop = 50;
    fireEvent.scroll(el);

    addLine('two'); // a streamed line arrives while scrolled up
    expect(el.scrollTop).toBe(50);
  });

  test('scrolling back down to the bottom resumes auto-scroll', () => {
    const { session, addLine } = fakeSession();
    const { getByTestId } = render(<TerminalView session={session} />);
    const el = getByTestId('terminal-output');
    stubScrollGeometry(el, 500, 200);
    addLine('one');

    el.scrollTop = 50;
    fireEvent.scroll(el);
    addLine('two');
    expect(el.scrollTop).toBe(50); // still frozen

    // User scrolls back down to (near) the bottom.
    el.scrollTop = 300; // 500 - 200 = 300 is exactly "at the bottom"
    fireEvent.scroll(el);

    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 560 });
    addLine('three');
    expect(el.scrollTop).toBe(560);
  });
});

describe('TerminalView — scrollback lines are CSS-contained (rapport 09, item #53)', () => {
  test('each rendered line opts into content-visibility: auto', () => {
    const { session, addLine } = fakeSession();
    addLine('one');
    addLine('two');
    addLine('three');
    const { getByTestId } = render(<TerminalView session={session} />);
    const output = getByTestId('terminal-output');

    // Scrollback is configurable up to 50,000 lines — without
    // containment, every past line stays a live layout/paint node
    // forever. Every direct child wrapping a line must opt out.
    const lineWrappers = Array.from(output.children).filter(
      (child) => child.querySelector('pre') !== null,
    );
    expect(lineWrappers.length).toBe(3);
    for (const wrapper of lineWrappers) {
      const style = (wrapper as HTMLElement).style;
      expect(style.contentVisibility).toBe('auto');
      expect(style.containIntrinsicSize).toMatch(/\S/);
    }
  });
});
