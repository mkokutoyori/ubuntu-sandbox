import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { actorOf, type ShellContext } from '../LinuxFileCommands';
import { Streams, docsResult, parseSizeWithSuffix, quoteLocale, quoteShell, usageFailure, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'no-create', letter: 'c', takesArgument: false },
  { name: 'io-blocks', letter: 'o', takesArgument: false },
  { name: 'reference', letter: 'r', takesArgument: true },
  { name: 'size', letter: 's', takesArgument: true },
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

const IO_BLOCK_BYTES = 4096;
const MATERIALIZED_LIMIT = 1 << 20;
const MAX_SIZE = BigInt(Number.MAX_SAFE_INTEGER);

type Modifier = '' | '+' | '-' | '<' | '>' | '/' | '%';

interface SizeSpec {
  readonly modifier: Modifier;
  readonly amount: number;
}

function parseSizeSpec(text: string): SizeSpec | string {
  const modifier = ('+-<>/%'.includes(text[0] ?? ' ') ? text[0] : '') as Modifier;
  const body = modifier === '' ? text : text.slice(1);
  const match = /^(\d+)(.*)$/.exec(body);
  if (match === null) return `truncate: Invalid number: ${quoteLocale(text)}`;
  let factor = 1;
  if (match[2] !== '') {
    const parsed = parseSizeWithSuffix(`1${match[2]}`);
    if (parsed === null) return `truncate: Invalid number: ${quoteLocale(text)}`;
    factor = parsed;
  }
  const value = BigInt(match[1]) * BigInt(factor);
  if (value > MAX_SIZE) return `truncate: Invalid number: ${quoteLocale(text)}: Value too large for defined data type`;
  return { modifier, amount: Number(value) };
}

function resolveSize(spec: SizeSpec, current: number): number | null {
  switch (spec.modifier) {
    case '+': return current + spec.amount;
    case '-': return Math.max(0, current - spec.amount);
    case '<': return Math.min(current, spec.amount);
    case '>': return Math.max(current, spec.amount);
    case '/': return spec.amount === 0 ? null : Math.floor(current / spec.amount) * spec.amount;
    case '%': return spec.amount === 0 ? null : Math.ceil(current / spec.amount) * spec.amount;
    default: return spec.amount;
  }
}

export function runTruncate(ctx: ShellContext, args: readonly string[], onFile: (absolute: string) => void): CoreutilsRun {
  let noCreate = false;
  let ioBlocks = false;
  let reference: string | null = null;
  let sizeText: string | null = null;
  const operands: string[] = [];
  for (const item of shortOptions(args, 'cor:s:', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('truncate', getoptDiagnostic('truncate', item));
    switch (item.letter) {
      case 'H': return docsResult('truncate', 'help');
      case 'V': return docsResult('truncate', 'version');
      case 'c': noCreate = true; break;
      case 'o': ioBlocks = true; break;
      case 'r': reference = item.argument ?? null; break;
      case 's': sizeText = item.argument ?? null; break;
      default: break;
    }
  }
  const streams = new Streams();
  if (reference === null && sizeText === null) {
    return usageFailure('truncate', operands.length === 0
      ? 'truncate: you must specify either ‘--size’ or ‘--reference’'
      : `truncate: you must specify either ${quoteLocale('--size')} or ${quoteLocale('--reference')}`);
  }
  let spec: SizeSpec = { modifier: '', amount: 0 };
  if (sizeText !== null) {
    const parsed = parseSizeSpec(sizeText);
    if (typeof parsed === 'string') {
      streams.diagnostic(parsed);
      streams.exitCode = 1;
      return streams.result();
    }
    spec = ioBlocks ? { modifier: parsed.modifier, amount: parsed.amount * IO_BLOCK_BYTES } : parsed;
  }
  if (reference !== null && sizeText !== null && spec.modifier === '') {
    return usageFailure('truncate', `truncate: you must specify a relative ${quoteLocale('--size')} with ${quoteLocale('--reference')}`);
  }
  if (operands.length === 0) return usageFailure('truncate', 'truncate: missing file operand');
  const actor = actorOf(ctx);
  let referenceSize: number | null = null;
  if (reference !== null) {
    const node = ctx.vfs.path(reference, ctx.cwd, actor).inode();
    if (node === null) {
      streams.diagnostic(`truncate: cannot stat ${quoteShell(reference)}: No such file or directory`);
      streams.exitCode = 1;
      return streams.result();
    }
    referenceSize = node.size;
  }
  for (const operand of operands) {
    const path = ctx.vfs.path(operand, ctx.cwd, actor);
    const node = path.inode();
    const fail = (reason: string): void => {
      streams.diagnostic(`truncate: cannot open ${quoteShell(operand)} for writing: ${reason}`);
      streams.exitCode = 1;
    };
    if (node === null && noCreate) continue;
    if (node !== null && node.type === 'directory') { fail('Is a directory'); continue; }
    if (node === null) {
      const parent = path.parent().inode();
      if (parent === null) { fail('No such file or directory'); continue; }
      if (parent.type !== 'directory') { fail('Not a directory'); continue; }
      if (ctx.uid !== 0 && !path.parent().isWritableDir()) { fail('Permission denied'); continue; }
    } else if (ctx.uid !== 0 && !path.canWrite()) { fail('Permission denied'); continue; }
    const current = referenceSize ?? node?.size ?? 0;
    const target = sizeText === null ? current : resolveSize(spec, current);
    if (target === null) {
      streams.diagnostic('truncate: division by zero');
      streams.exitCode = 1;
      return streams.result();
    }
    onFile(path.value);
    const kept = fileTextToBytes(node?.content ?? '');
    let content: string;
    let declared: number | undefined;
    if (target <= MATERIALIZED_LIMIT) {
      const bytes = new Uint8Array(target);
      bytes.set(kept.subarray(0, target));
      content = bytesToFileText(bytes);
    } else {
      content = bytesToFileText(kept);
      declared = target;
    }
    if (!ctx.vfs.writeFile(path.value, content, ctx.uid, ctx.gid, ctx.umask, false, declared)) fail('No space left on device');
  }
  return streams.result();
}
