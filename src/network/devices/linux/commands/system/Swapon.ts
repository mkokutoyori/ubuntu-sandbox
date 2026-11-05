import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { MemoryProfile, SwapArea } from '@/network/devices/host/hardware/MemoryProfile';
import { getoptDiagnostic, shortOptions, type LongOption } from '../Getopt';
import { humanSwapSize, permissionsText, readSwapSignature, SWAP_PAGE_BYTES } from './SwapSignature';

const SWAPON_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-s', aliases: ['--summary'], dest: 'summary', description: 'Display swap usage summary by device' },
  { flag: '--show', dest: 'show', description: 'Display a definable table of swap areas' },
  { flag: '--bytes', dest: 'bytes', description: 'Display swap size in bytes in --show output' },
];

type Outcome = { output: string; exitCode: number };

const TRY = (program: string): string => `Try '${program} --help' for more information.`;

const SWAPON_SHORT = 'ahdefp:svVL:U:o:';
const SWAPON_LONG: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'discard', letter: 'd', takesArgument: false, optionalArgument: true },
  { name: 'ifexists', letter: 'e', takesArgument: false },
  { name: 'fixpgsz', letter: 'f', takesArgument: false },
  { name: 'priority', letter: 'p', takesArgument: true },
  { name: 'summary', letter: 's', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'label', letter: 'L', takesArgument: true },
  { name: 'uuid', letter: 'U', takesArgument: true },
  { name: 'options', letter: 'o', takesArgument: true },
  { name: 'show', letter: '', takesArgument: false, optionalArgument: true },
  { name: 'output-all', letter: '', takesArgument: false },
  { name: 'noheadings', letter: '', takesArgument: false },
  { name: 'raw', letter: '', takesArgument: false },
  { name: 'bytes', letter: '', takesArgument: false },
];

const SWAPOFF_SHORT = 'ahvVL:U:';
const SWAPOFF_LONG: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'label', letter: 'L', takesArgument: true },
  { name: 'uuid', letter: 'U', takesArgument: true },
];

const SHOW_COLUMNS: Record<string, { header: string; right: boolean; value: (area: SwapArea, bytes: boolean) => string }> = {
  NAME: { header: 'NAME', right: false, value: (area) => area.path },
  TYPE: { header: 'TYPE', right: false, value: (area) => area.type },
  SIZE: { header: 'SIZE', right: true, value: (area, bytes) => (bytes ? String(area.sizeKib * 1024) : humanSwapSize(area.sizeKib * 1024)) },
  USED: { header: 'USED', right: true, value: (area, bytes) => (bytes ? String(area.usedKib * 1024) : humanSwapSize(area.usedKib * 1024)) },
  PRIO: { header: 'PRIO', right: true, value: (area) => String(area.priority) },
  UUID: { header: 'UUID', right: false, value: (area) => area.uuid },
  LABEL: { header: 'LABEL', right: false, value: (area) => area.label },
};

const DEFAULT_SHOW = ['NAME', 'TYPE', 'SIZE', 'USED', 'PRIO'];

const SWAPON_HELP = `
Usage:
 swapon [options] [<spec>]

Enable devices and files for paging and swapping.

Options:
 -a, --all                enable all swaps from /etc/fstab
 -d, --discard[=<policy>] enable swap discards, if supported by device
 -e, --ifexists           silently skip devices that do not exist
 -f, --fixpgsz            reinitialize the swap space if necessary
 -o, --options <list>     comma-separated list of swap options
 -p, --priority <prio>    specify the priority of the swap device
 -s, --summary            display summary about used swap devices (DEPRECATED)
 -v, --verbose            verbose mode
     --show[=<columns>]   display summary in definable table
     --noheadings         don't print table heading (with --show)
     --raw                use the raw output format (with --show)
     --bytes              display swap size in bytes in --show output

 -h, --help               display this help
 -V, --version            display version

For more details see swapon(8).`;

const SWAPOFF_HELP = `
Usage:
 swapoff [options] [<spec>]

Disable devices and files for paging and swapping.

Options:
 -a, --all              disable all swaps from /proc/swaps
 -v, --verbose          verbose mode

 -h, --help             display this help
 -V, --version          display version

The <spec> parameter:
 -L <label>             LABEL of device to be used
 -U <uuid>              UUID of device to be used
 LABEL=<label>          LABEL of device to be used
 UUID=<uuid>            UUID of device to be used
 <device>               name of device to be used
 <file>                 name of file to be used

For more details see swapoff(8).`;

export function renderProcSwaps(mem: Pick<MemoryProfile, 'swapAreas'>): string {
  const header = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority';
  const rows = mem.swapAreas.map((area) => {
    const name = area.path.length < 39 ? area.path.padEnd(40) : `${area.path} `;
    return `${name}${area.type}\t\t${area.sizeKib}\t\t${area.usedKib}\t\t${area.priority}`;
  });
  return `${[header, ...rows].join('\n')}\n`;
}

function renderShow(areas: readonly SwapArea[], columns: readonly string[], opts: { raw: boolean; noHeadings: boolean; bytes: boolean }): string {
  const cells = areas.map((area) => columns.map((c) => SHOW_COLUMNS[c].value(area, opts.bytes)));
  if (opts.raw) {
    const lines = cells.map((row) => row.join(' '));
    return (opts.noHeadings ? lines : [columns.map((c) => SHOW_COLUMNS[c].header).join(' '), ...lines]).join('\n');
  }
  const headers = columns.map((c) => SHOW_COLUMNS[c].header);
  const widths = columns.map((c, i) => Math.max(headers[i].length, ...cells.map((row) => row[i].length)));
  const format = (row: readonly string[]): string => row
    .map((cell, i) => {
      const last = i === row.length - 1;
      if (SHOW_COLUMNS[columns[i]].right) return cell.padStart(widths[i]);
      return last ? cell : cell.padEnd(widths[i]);
    })
    .join(' ');
  return (opts.noHeadings ? cells.map(format) : [format(headers), ...cells.map(format)]).join('\n');
}

interface ActivationRequest {
  readonly given: string;
  readonly priority: number | undefined;
  readonly verbose: boolean;
  readonly ifExists: boolean;
}

function activate(ctx: LinuxCommandContext, request: ActivationRequest): { lines: string[]; failed: boolean } {
  const { executor } = ctx;
  const memory = executor.hardware.memory;
  const abs = executor.vfs.normalizePath(request.given, executor.getCwd());
  const lines: string[] = [];
  const existing = memory.findSwap(abs);
  if (existing) return { lines: [`swapon: ${abs}: swapon failed: Device or resource busy`], failed: true };
  const inode = executor.vfs.resolveInode(abs);
  if (!inode) {
    if (request.ifExists) return { lines, failed: false };
    return { lines: [`swapon: cannot open ${request.given}: No such file or directory`], failed: true };
  }
  if (executor.userMgr.currentUid !== 0) return { lines: [`swapon: ${abs}: swapon failed: Operation not permitted`], failed: true };
  if ((inode.permissions & 0o077) !== 0) {
    lines.push(`swapon: ${abs}: insecure permissions ${permissionsText(inode.permissions)}, 0600 suggested.`);
  }
  const signature = inode.type === 'file' ? readSwapSignature(inode.content) : null;
  if (!signature) return { lines: [...lines, `swapon: ${abs}: read swap header failed`], failed: true };
  const usableKib = Math.max(0, Math.floor(inode.size / 1024) - SWAP_PAGE_BYTES / 1024);
  memory.addSwap({
    path: abs, type: 'file', sizeKib: usableKib, usedKib: 0,
    priority: request.priority ?? memory.nextAutomaticSwapPriority(), uuid: signature.uuid, label: signature.label,
  });
  if (request.verbose) {
    lines.push(
      `swapon: ${abs}: found signature [pagesize=${SWAP_PAGE_BYTES}, signature=swap]`,
      `swapon: ${abs}: pagesize=${SWAP_PAGE_BYTES}, swapsize=${inode.size}, devsize=${inode.size}`,
      `swapon ${abs}`,
    );
  }
  return { lines, failed: false };
}

function fstabSwaps(ctx: LinuxCommandContext): Array<{ spec: string; options: string[] }> {
  return (ctx.executor.vfs.readFile('/etc/fstab') ?? '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[2] === 'swap')
    .map((parts) => ({ spec: parts[0], options: (parts[3] ?? 'defaults').split(',') }));
}

export function runSwapon(ctx: LinuxCommandContext, args: string[]): Outcome {
  const memory = ctx.executor.hardware.memory;
  const operands: string[] = [];
  const flags = new Set<string>();
  let priorityText: string | undefined;
  let showSpec: string | undefined;
  let showSeen = false;
  let specifier = '';
  for (const item of shortOptions(args, SWAPON_SHORT, SWAPON_LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return { output: `${getoptDiagnostic('swapon', item)}\n${TRY('swapon')}`, exitCode: 1 };
    const name = item.long ?? item.letter;
    if (name === 'help' || item.letter === 'h') return { output: SWAPON_HELP, exitCode: 0 };
    if (name === 'version' || item.letter === 'V') return { output: 'swapon from util-linux 2.37.2', exitCode: 0 };
    if (item.letter === 'L' || item.letter === 'U') specifier = item.argument ?? '';
    if (item.letter === 'p') { priorityText = item.argument ?? ''; continue; }
    if (name === 'show') { showSeen = true; showSpec = item.argument; continue; }
    if (item.letter === 'd' && item.argument !== undefined && !['once', 'pages', ''].includes(item.argument)) {
      return { output: `swapon: unsupported discard policy: ${item.argument}`, exitCode: 1 };
    }
    flags.add(name);
  }

  let priority: number | undefined;
  if (priorityText !== undefined) {
    if (!/^-?\d+$/.test(priorityText)) return { output: `swapon: failed to parse priority: '${priorityText}'`, exitCode: 1 };
    priority = Number(priorityText);
  }

  const bytes = flags.has('bytes');
  const showOptions = { raw: flags.has('raw'), noHeadings: flags.has('noheadings'), bytes };
  const wantsTable = showSeen || (operands.length === 0 && !flags.has('a') && !flags.has('all') && !flags.has('s') && !flags.has('summary'));
  const summary = flags.has('s') || flags.has('summary');
  const all = flags.has('a') || flags.has('all');

  if (flags.has('L') || flags.has('U')) {
    return { output: `swapon: cannot find the device for ${specifier}`, exitCode: 255 };
  }

  if (all) {
    const lines: string[] = [];
    let failed = false;
    for (const entry of fstabSwaps(ctx)) {
      if (entry.options.includes('noauto')) continue;
      const abs = ctx.executor.vfs.normalizePath(entry.spec, ctx.executor.getCwd());
      if (memory.findSwap(abs)) continue;
      const pri = entry.options.map((o) => /^pri=(-?\d+)$/.exec(o)).find((m) => m !== null);
      const outcome = activate(ctx, { given: entry.spec, priority: pri ? Number(pri[1]) : priority, verbose: flags.has('v') || flags.has('verbose'), ifExists: false });
      lines.push(...outcome.lines);
      failed = failed || outcome.failed;
    }
    return { output: lines.join('\n'), exitCode: failed ? 255 : 0 };
  }

  if (operands.length > 0) {
    if (flags.has('e') || flags.has('ifexists')) return { output: `swapon: bad usage\n${TRY('swapon')}`, exitCode: 1 };
    const lines: string[] = [];
    let failed = false;
    for (const given of operands) {
      const outcome = activate(ctx, { given, priority, verbose: flags.has('v') || flags.has('verbose'), ifExists: flags.has('e') || flags.has('ifexists') });
      lines.push(...outcome.lines);
      failed = failed || outcome.failed;
    }
    return { output: lines.join('\n'), exitCode: failed ? 255 : 0 };
  }

  if (summary && !showSeen) {
    return { output: memory.swapAreas.length === 0 ? '' : renderProcSwaps(memory).replace(/\n$/, ''), exitCode: 0 };
  }

  if (wantsTable) {
    const columns = showSpec === undefined || showSpec === '' ? DEFAULT_SHOW : showSpec.toUpperCase().split(',');
    const unknown = columns.find((c) => SHOW_COLUMNS[c] === undefined);
    if (unknown !== undefined) return { output: `swapon: unknown column: ${unknown}`, exitCode: 1 };
    if (memory.swapAreas.length === 0) return { output: '', exitCode: 0 };
    return { output: renderShow(memory.swapAreas, columns, showOptions), exitCode: 0 };
  }

  return { output: `swapon: bad usage\n${TRY('swapon')}`, exitCode: 1 };
}

export function runSwapoff(ctx: LinuxCommandContext, args: string[]): Outcome {
  const memory = ctx.executor.hardware.memory;
  const operands: string[] = [];
  const flags = new Set<string>();
  for (const item of shortOptions(args, SWAPOFF_SHORT, SWAPOFF_LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return { output: `${getoptDiagnostic('swapoff', item)}\n${TRY('swapoff')}`, exitCode: 16 };
    const name = item.long ?? item.letter;
    if (name === 'help' || item.letter === 'h') return { output: SWAPOFF_HELP, exitCode: 0 };
    if (name === 'version' || item.letter === 'V') return { output: 'swapoff from util-linux 2.37.2', exitCode: 0 };
    flags.add(name);
  }
  const verbose = flags.has('v') || flags.has('verbose');
  const lines: string[] = [];
  if (flags.has('a') || flags.has('all')) {
    for (const area of [...memory.swapAreas].reverse()) {
      memory.removeSwap(area.path);
      if (verbose) lines.push(`swapoff ${area.path}`);
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }
  if (operands.length === 0) return { output: `swapoff: bad usage\n${TRY('swapoff')}`, exitCode: 16 };
  let failed = false;
  for (const given of operands) {
    const abs = ctx.executor.vfs.normalizePath(given, ctx.executor.getCwd());
    if (memory.findSwap(abs)) {
      memory.removeSwap(abs);
      if (verbose) lines.push(`swapoff ${given}`);
      continue;
    }
    failed = true;
    const reason = ctx.executor.vfs.exists(abs) ? 'Invalid argument' : 'No such file or directory';
    lines.push(`swapoff: ${given}: swapoff failed: ${reason}`);
  }
  return { output: lines.join('\n'), exitCode: failed ? 4 : 0 };
}

export const swaponCommand: LinuxCommand = {
  name: 'swapon',
  needsNetworkContext: true,
  usage: 'swapon [options] [<spec>]',
  manSection: 8,
  binaryPath: '/usr/sbin/swapon',
  options: SWAPON_OPTIONS,
  help: 'Enable devices and files for paging and swapping, or list those in use.',
  run(ctx, args) { return runSwapon(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runSwapon(ctx, args); },
};

export const swapoffCommand: LinuxCommand = {
  name: 'swapoff',
  needsNetworkContext: true,
  usage: 'swapoff [options] [<spec>]',
  manSection: 8,
  binaryPath: '/usr/sbin/swapoff',
  help: 'Disable devices and files for paging and swapping.',
  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) { return runSwapoff(ctx, args); },
  run(ctx: LinuxCommandContext, args: string[]): string { return runSwapoff(ctx, args).output; },
};
