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

export const xxdCommand: LinuxCommand = {
  name: 'xxd',
  // Despite the name, `needsNetworkContext: true` is this codebase's
  // actual convention for "dispatch through the LinuxCommand registry"
  // (see LinuxMachine.containsNetworkCommand / hasNetworkCommandIn) —
  // matches sibling non-networking utilities like `date`/`uname`/`chage`.
  needsNetworkContext: true,
  usage: 'xxd [-l length] [-s offset] FILE',
  help: 'Show a hex + ASCII dump of a file, in the classic xxd 16-bytes-per-line format.',
  run(ctx: LinuxCommandContext, args: string[]): string {
    let length: number | undefined;
    let offset = 0;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' || a === '--len') { length = parseInt(args[++i], 10); continue; }
      if (a === '-s' || a === '--seek') { offset = parseInt(args[++i], 10); continue; }
      if (a.startsWith('-')) continue; // ignore other flags rather than erroring on them
      positional.push(a);
    }
    const path = positional[0];
    if (!path) return 'xxd: usage: xxd [-l length] [-s offset] FILE';

    const absPath = ctx.executor.vfs.normalizePath(path, ctx.executor.getCwd());
    const content = ctx.executor.vfs.readFile(absPath);
    if (content === null) return `xxd: ${path}: No such file or directory`;

    let bytes = new TextEncoder().encode(content);
    if (offset > 0) bytes = bytes.subarray(Math.min(offset, bytes.length));
    if (length !== undefined) bytes = bytes.subarray(0, Math.max(0, length));

    return xxdDump(bytes);
  },
};
