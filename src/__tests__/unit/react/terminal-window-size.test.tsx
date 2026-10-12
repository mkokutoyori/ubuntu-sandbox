/**
 * @vitest-environment jsdom
 *
 * Le terminal dit sa taille a sa session : le nombre de colonnes et de lignes que la zone de
 * sortie peut tenir, mesure avec la chasse reelle de la police, et remesuree quand la fenetre
 * change.  C'est ce que `stty size`, `tput`, `$COLUMNS` et, par `window-change`, un shell
 * distant lisent ensuite.  Avant, la vue ne mesurait rien : la session ne connaissait que
 * 24x80, quelle que soit la fenetre.
 *
 * Mesure avec `git stash push -u -- src/components src/terminal src/network` : les 4 cas tombent
 * avant (`setWindowSize` n'est jamais appele).  Aucun ne passe des deux cotes ; le TEMOIN est
 * terminal-scroll-discipline.test.tsx, qui monte le meme composant avec la meme fausse session et
 * passe avant comme apres.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { TerminalView } from '@/components/terminal/TerminalView';
import type { TerminalSession, TerminalTheme, InputMode } from '@/terminal/sessions/TerminalSession';

const theme: TerminalTheme = {
  sessionType: 'linux',
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
  const setWindowSize = vi.fn();
  const inputMode: InputMode = { type: 'normal' };
  const session = {
    getTheme: () => theme,
    getSessionType: () => 'cisco',
    getPrompt: () => '$',
    getInfoBarContent: () => ({ left: 'PC', right: '' }),
    listAsyncJobs: () => [],
    listAttachedStreams: () => [],
    lines: [],
    input: '',
    currentInputMode: inputMode,
    inputMode,
    getGhostSuggestion: () => null,
    setInput: () => {},
    handleKey: () => false,
    subscribe: () => () => {},
    getVersion: () => 0,
    setWindowSize,
  } as unknown as TerminalSession;
  return { session, setWindowSize };
}

let observers: Array<() => void> = [];
let width = 800;
let height = 400;

beforeEach(() => {
  observers = [];
  width = 800;
  height = 400;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { observers.push(callback); }
    observe(): void {}
    disconnect(): void {}
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: 400, height: 20 } as DOMRect));
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
    const style = real(element);
    return new Proxy(style, {
      get(target, property) {
        if (property === 'lineHeight') return '20px';
        if (property === 'fontSize') return '14px';
        if (typeof property === 'string' && /^padding(Left|Right|Top|Bottom)$/.test(property)) return '0px';
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the terminal view reports the size of its output area to the session', () => {
  test('rows and columns that the area holds, in the font\'s real cell size', () => {
    const { session, setWindowSize } = fakeSession();
    render(<TerminalView session={session} />);
    expect(setWindowSize).toHaveBeenCalledWith(20, 80);
  });

  test('reports again when the window changes size', () => {
    const { session, setWindowSize } = fakeSession();
    render(<TerminalView session={session} />);
    width = 600;
    height = 200;
    act(() => { for (const callback of observers) callback(); });
    expect(setWindowSize).toHaveBeenLastCalledWith(10, 60);
  });

  test('does not repeat itself when the size did not change', () => {
    const { session, setWindowSize } = fakeSession();
    render(<TerminalView session={session} />);
    act(() => { for (const callback of observers) callback(); });
    expect(setWindowSize).toHaveBeenCalledTimes(1);
  });

  test('tells a new session the size it never heard of', () => {
    const first = fakeSession();
    const second = fakeSession();
    const view = render(<TerminalView session={first.session} />);
    view.rerender(<TerminalView session={second.session} />);
    expect(second.setWindowSize).toHaveBeenCalledWith(20, 80);
  });
});
