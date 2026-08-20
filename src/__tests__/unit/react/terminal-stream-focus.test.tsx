/**
 * @vitest-environment jsdom
 *
 * Bug report: with two terminals visible at once (e.g. grid tiling) and a
 * foreground stream (`tcpdump`, `tail -f`, …) running in one of them, every
 * new streamed line stole focus back from whichever OTHER terminal the user
 * had since clicked into.
 *
 * Root cause: the hidden capture `<input>` that holds the tty during a
 * foreground stream used an inline arrow-function ref
 * (`ref={(el) => { inputRef.current = el; el?.focus(); }}`). React calls a
 * ref callback on every render where the callback itself is a new function
 * reference — which an inline arrow always is — so `.focus()` fired again
 * on every streamed line, not just when the stream started. The same
 * pattern existed on the pager's hidden input.
 */
import { describe, expect, test } from 'vitest';
import { render, act } from '@testing-library/react';
import { TerminalView } from '@/components/terminal/TerminalView';
import type { TerminalSession, TerminalTheme, InputMode } from '@/terminal/sessions/TerminalSession';

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

function fakeSession(opts: { streaming: boolean }) {
  const listeners = new Set<() => void>();
  let version = 0;
  const inputMode: InputMode = opts.streaming ? { type: 'normal' } : { type: 'normal' };
  const session = {
    getTheme: () => theme,
    getSessionType: () => 'cisco',
    getPrompt: () => 'R1#',
    getInfoBarContent: () => ({ left: 'R1', right: '' }),
    listAsyncJobs: () => [],
    listAttachedStreams: () => (opts.streaming ? ['eth0'] : []),
    lines: [],
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
    bump: () => { act(() => { version++; listeners.forEach((l) => l()); }); },
  };
}

describe('TerminalView — a foreground stream in one terminal must not steal focus from another', () => {
  test('repeated streamed lines in terminal A do not re-steal focus from terminal B', async () => {
    const a = fakeSession({ streaming: true });
    const b = fakeSession({ streaming: false });

    render(<TerminalView session={a.session} />);
    const { container: containerB } = render(<TerminalView session={b.session} />);

    // Let the initial mount effects (which legitimately focus each
    // terminal's own input once) settle, then explicitly move focus to B —
    // simulating the user clicking into the second terminal to type.
    const inputB = containerB.querySelector('input') as HTMLInputElement;
    expect(inputB).toBeTruthy();
    act(() => { inputB.focus(); });
    expect(document.activeElement).toBe(inputB);

    // Simulate several streamed tcpdump lines arriving in terminal A —
    // each one re-renders A's TerminalView exactly like a real packet would.
    for (let i = 0; i < 5; i++) {
      a.bump();
      expect(document.activeElement).toBe(inputB);
    }
  });

  test('the stream-capture input is still focused once when the stream starts', () => {
    const a = fakeSession({ streaming: false });
    const { container, rerender } = render(<TerminalView session={a.session} />);

    // Not streaming yet — no hidden capture input.
    expect(container.querySelectorAll('input').length).toBeGreaterThan(0);

    (a.session as unknown as { listAttachedStreams: () => string[] }).listAttachedStreams = () => ['eth0'];
    act(() => { rerender(<TerminalView session={a.session} />); });

    const hiddenInput = container.querySelector('input') as HTMLInputElement;
    expect(hiddenInput).toBeTruthy();
    expect(document.activeElement).toBe(hiddenInput);
  });
});
