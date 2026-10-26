interface GestureKey {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export async function copySelectionToClipboard(): Promise<boolean> {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  try {
    await navigator.clipboard.writeText(selection.toString());
    return true;
  } catch {
    return false;
  }
}

export async function pasteFromClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

export function isNativePasteGesture(e: GestureKey): boolean {
  if (e.altKey) return false;
  const key = e.key.toLowerCase();
  if (e.metaKey) return key === 'v';
  return (e.ctrlKey && e.shiftKey && key === 'v') || (e.shiftKey && !e.ctrlKey && e.key === 'Insert');
}

export function isCopyGesture(e: GestureKey): boolean {
  if (e.altKey || e.metaKey) return false;
  return (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') || (e.ctrlKey && !e.shiftKey && e.key === 'Insert');
}
