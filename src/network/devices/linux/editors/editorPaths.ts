/**
 * Both nano (file-locking, since nano 2.3) and vim name their
 * concurrent-edit guard file `.<basename>.swp` in the same directory as
 * the file being edited. Shared here so NanoEngine/VimEngine agree.
 */
export function dotSwapPathFor(absolutePath: string): string {
  const idx = absolutePath.lastIndexOf('/');
  const dir = idx >= 0 ? absolutePath.slice(0, idx) : '';
  const base = idx >= 0 ? absolutePath.slice(idx + 1) : absolutePath;
  return `${dir}/.${base}.swp`;
}
