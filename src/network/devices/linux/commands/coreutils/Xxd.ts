import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

function xxdDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      if (i >= chunk.length) { groups.push(''); continue; }
      const b1 = chunk[i].toString(16).padStart(2, '0');
      const b2 = i + 1 < chunk.length ? chunk[i + 1].toString(16).padStart(2, '0') : '';
      groups.push(b1 + b2);
    }
    const hexPart = groups.map((g) => g.padEnd(4, ' ')).join(' ');
    let ascii = '';
    for (const b of chunk) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    lines.push(`${offset.toString(16).padStart(8, '0')}: ${hexPart}  ${ascii}`);
  }
  if (bytes.length === 0) return '';
  return lines.join('\n');
}

/**
 * Reverse of `xxdDump` (backs `xxd -r`): parse an xxd-style
 * `OFFSET: HEXBYTES  ASCII` dump back into the raw bytes it describes.
 * The ASCII column is ignored — only the offset and hex column matter,
 * exactly like real `xxd -r`, so editing hex text (e.g. deleting a "00"
 * byte pair to strip an embedded NUL) round-trips losslessly.
 */
function xxdReverse(dumpText: string): Uint8Array {
  const bytes: number[] = [];
  for (const line of dumpText.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-fA-F]+):\s*(.*)$/);
    if (!m) continue;
    const offset = parseInt(m[1], 16);
    const hexPart = m[2].split(/ {2,}/)[0] ?? '';
    const hexDigits = hexPart.replace(/\s+/g, '');
    for (let i = 0; i + 1 < hexDigits.length; i += 2) {
      bytes[offset + i / 2] = parseInt(hexDigits.slice(i, i + 2), 16);
    }
  }
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ?? 0;
  return out;
}

export const xxdCommand: LinuxCommand = {
  name: 'xxd',
  package: 'xxd',
  // Despite the name, `needsNetworkContext: true` is this codebase's
  // actual convention for "dispatch through the LinuxCommand registry"
  // (see LinuxMachine.containsNetworkCommand / hasNetworkCommandIn) —
  // matches sibling non-networking utilities like `date`/`uname`/`chage`.
  needsNetworkContext: true,
  readsStdin: true,
  usage: 'xxd [-l length] [-s offset] [-r] [FILE]',
  help: 'Show a hex + ASCII dump of a file (or reverse one back to raw bytes with -r), in the classic xxd 16-bytes-per-line format. Reads from stdin when piped (e.g. a `:%!xxd` filter inside vim) instead of a FILE argument.',
  run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
    let length: number | undefined;
    let offset = 0;
    let reverse = false;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' || a === '--len') { length = parseInt(args[++i], 10); continue; }
      if (a === '-s' || a === '--seek') { offset = parseInt(args[++i], 10); continue; }
      if (a === '-r' || a === '--revert' || a === '--reverse') { reverse = true; continue; }
      if (a.startsWith('-')) continue; // ignore other flags rather than erroring on them
      positional.push(a);
    }
    const arg = positional[0];
    // Piped stdin (from `cmd < file` or a vim `:%!xxd` filter) arrives on
    // its own channel, declared by `readsStdin` — it used to be guessed
    // from the trailing argument holding a newline, which read
    // `printf abc | xxd` as a filename.
    const isStdin = stdin !== undefined;

    if (reverse) {
      let dumpText: string;
      if (isStdin) {
        dumpText = stdin;
      } else if (arg !== undefined) {
        const absPath = ctx.executor.vfs.normalizePath(arg, ctx.executor.getCwd());
        const content = ctx.executor.vfs.readFile(absPath);
        if (content === null) return `xxd: ${arg}: No such file or directory`;
        dumpText = content;
      } else {
        return 'xxd: usage: xxd -r [-l length] [-s offset] FILE';
      }
      return new TextDecoder('utf-8').decode(xxdReverse(dumpText));
    }

    let bytes: Uint8Array;
    if (isStdin) {
      bytes = new TextEncoder().encode(stdin);
    } else {
      if (!arg) return 'xxd: usage: xxd [-l length] [-s offset] FILE';
      const absPath = ctx.executor.vfs.normalizePath(arg, ctx.executor.getCwd());
      const content = ctx.executor.vfs.readFile(absPath);
      if (content === null) return `xxd: ${arg}: No such file or directory`;
      bytes = new TextEncoder().encode(content);
    }
    if (offset > 0) bytes = bytes.subarray(Math.min(offset, bytes.length));
    if (length !== undefined) bytes = bytes.subarray(0, Math.max(0, length));

    return xxdDump(bytes);
  },
};
