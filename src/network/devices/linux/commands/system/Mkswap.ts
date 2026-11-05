import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { getoptDiagnostic, shortOptions, type LongOption } from '../Getopt';
import { humanSizeForFallocate } from '../fs/Fallocate';
import { permissionsText, SWAP_PAGE_BYTES, swapHeader } from './SwapSignature';

const SHORT = 'cfL:p:U:vhV';
const LONG: readonly LongOption[] = [
  { name: 'check', letter: 'c', takesArgument: false },
  { name: 'force', letter: 'f', takesArgument: false },
  { name: 'label', letter: 'L', takesArgument: true },
  { name: 'pagesize', letter: 'p', takesArgument: true },
  { name: 'uuid', letter: 'U', takesArgument: true },
  { name: 'swapversion', letter: 'v', takesArgument: true },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const HELP = `
Usage:
 mkswap [options] device [size]

Set up a Linux swap area.

Options:
 -c, --check               check bad blocks before creating the swap area
 -f, --force               allow swap size area be larger than device
 -p, --pagesize SIZE       specify page size in bytes
 -L, --label LABEL         specify label
 -v, --swapversion NUM     specify swap-space version number
 -U, --uuid UUID           specify the uuid to use
     --verbose             verbose output

 -h, --help                display this help
 -V, --version             display version

For more details see mkswap(8).`;

const MINIMUM_KIB = 40;
const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Outcome = { output: string; exitCode: number };

function runMkswap(ctx: LinuxCommandContext, args: string[]): Outcome {
  const { executor } = ctx;
  const operands: string[] = [];
  let label = '';
  let uuid: string | undefined;
  for (const item of shortOptions(args, SHORT, LONG)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return { output: `${getoptDiagnostic('mkswap', item)}\nTry 'mkswap --help' for more information.`, exitCode: 1 };
    if (item.letter === 'h') return { output: HELP, exitCode: 0 };
    if (item.letter === 'V') return { output: 'mkswap from util-linux 2.37.2', exitCode: 0 };
    if (item.letter === 'L') label = item.argument ?? '';
    if (item.letter === 'U') uuid = item.argument ?? '';
  }
  if (operands.length === 0) {
    return { output: "mkswap: error: Nowhere to set up swap on?\nTry 'mkswap --help' for more information.", exitCode: 1 };
  }
  if (uuid !== undefined && !UUID_FORM.test(uuid)) return { output: `mkswap: error: parsing UUID failed`, exitCode: 1 };

  const given = operands[0];
  const abs = executor.vfs.normalizePath(given, executor.getCwd());
  const inode = executor.vfs.resolveInode(abs);
  if (!inode) return { output: `mkswap: cannot open ${given}: No such file or directory`, exitCode: 1 };
  if (inode.type === 'directory') return { output: `mkswap: cannot determine size of ${given}: Block device required`, exitCode: 1 };
  const lines: string[] = [];
  const requestedKib = operands[1] === undefined ? undefined : Number(operands[1]);
  const sizeBytes = requestedKib !== undefined && Number.isFinite(requestedKib) ? requestedKib * 1024 : inode.size;
  if (sizeBytes / 1024 < MINIMUM_KIB) return { output: [...lines, `mkswap: error: swap area needs to be at least ${MINIMUM_KIB} KiB`].join('\n'), exitCode: 1 };
  if ((inode.permissions & 0o077) !== 0) {
    lines.push(`mkswap: ${given}: insecure permissions ${permissionsText(inode.permissions)}, fix with: chmod 0600 ${given}`);
  }
  const usable = sizeBytes - SWAP_PAGE_BYTES;
  const identifier = uuid ?? executor.randomUuid();
  const written = executor.vfs.writeFile(
    abs, swapHeader(identifier, label, sizeBytes / SWAP_PAGE_BYTES - 1),
    executor.userMgr.currentUid, executor.userMgr.currentGid, executor.getUmask(), false, inode.size, false,
  );
  if (!written) return { output: [...lines, `mkswap: ${given}: unable to write signature page: No space left on device`].join('\n'), exitCode: 1 };
  lines.push(`Setting up swapspace version 1, size = ${humanSizeForFallocate(usable)} (${usable} bytes)`);
  lines.push(label === '' ? `no label, UUID=${identifier}` : `LABEL=${label}, UUID=${identifier}`);
  return { output: lines.join('\n'), exitCode: 0 };
}

export const mkswapCommand: LinuxCommand = {
  name: 'mkswap',
  package: 'util-linux',
  needsNetworkContext: true,
  usage: 'mkswap [options] device [size]',
  manSection: 8,
  binaryPath: '/usr/sbin/mkswap',
  help: 'Set up a Linux swap area.',
  run(ctx, args) { return runMkswap(ctx, args).output; },
  runWithStatusSync(ctx, args) { return runMkswap(ctx, args); },
};
