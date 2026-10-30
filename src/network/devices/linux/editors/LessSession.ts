import { LessEngine, type LessOptions, type LessSource } from './LessEngine';
import type { EditorSession, LessEditorView } from './EditorView';

export interface LessSessionSeed {
  readonly sources: readonly LessSource[];
  readonly options: LessOptions;
  readonly initialKeys: string;
  readonly help: 'only' | 'first' | null;
  readonly rows: number;
  readonly cols: number;
}

export function createLessSession(seed: LessSessionSeed): EditorSession {
  const engine = new LessEngine(seed.sources, seed.options, seed.rows, seed.cols);
  if (seed.help !== null) engine.showHelpFirst(seed.help === 'only');
  if (seed.initialKeys !== '') engine.feed(seed.initialKeys);
  const view = (): LessEditorView => ({
    kind: 'less',
    filePath: '',
    lines: [],
    cursorLine: 0,
    cursorCol: 0,
    modified: false,
    exited: engine.exited,
    savedOnExit: false,
    isReadOnly: true,
    lineNumbersShown: engine.options.lineNumbers,
    isNewFile: false,
    screen: engine.screen,
  });
  return {
    get view() { return view(); },
    applyKey: (key) => { engine.applyKey(key); return view(); },
    resize: (rows, cols) => { engine.resize(rows, cols); return view(); },
    scroll: (up, count) => { engine.scrollView(up, count); return view(); },
    close: () => undefined,
  };
}
