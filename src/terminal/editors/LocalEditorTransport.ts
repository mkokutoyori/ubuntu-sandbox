import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorSession, EditorView } from '@/network/devices/linux/editors/EditorView';
import type { RemoteEditorTransport } from './RemoteEditorController';

export function localEditorTransport(session: EditorSession): RemoteEditorTransport {
  const handlers = new Set<(view: EditorView) => void>();
  const publish = (view: EditorView | null | undefined): void => {
    if (view) for (const handler of [...handlers]) handler(view);
  };
  return {
    sendEditorKey: (key: EditorKeyInput) => Promise.resolve(session.applyKey(key)),
    pasteIntoEditor: (text) => Promise.resolve(session.applyPaste?.(text) ?? null),
    clickEditor: (row, col) => Promise.resolve(session.click?.(row, col) ?? null),
    scrollEditor: (up, count) => Promise.resolve(session.scroll?.(up, count) ?? null),
    onEditorView: (handler) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    resize: (cols, rows) => publish(session.resize?.(rows, cols)),
    closeEditor: () => session.close(),
  };
}
