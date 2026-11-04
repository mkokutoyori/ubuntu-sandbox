import { getoptDiagnostic, shortOptions, type LongOption } from '../commands/Getopt';
import { InputQueue, Streams, docsResult, quoteLocale, quotef, readFailureText, usageFailure, type CoreutilsIO, type CoreutilsRun } from './CoreutilsKit';

const LONG_OPTIONS: readonly LongOption[] = [
  { name: 'help', letter: 'H', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
];

interface Node {
  readonly name: string;
  count: number;
  printed: boolean;
  qlink: Node | null;
  successors: Node[];
}

const compareNames = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

export function runTsort(args: readonly string[], io: CoreutilsIO): CoreutilsRun {
  const operands: string[] = [];
  for (const item of shortOptions(args, '', LONG_OPTIONS)) {
    if (item.kind === 'operand') { operands.push(item.value); continue; }
    if (item.kind !== 'option') return usageFailure('tsort', getoptDiagnostic('tsort', item));
    return docsResult('tsort', item.letter === 'H' ? 'help' : 'version');
  }
  if (operands.length > 1) return usageFailure('tsort', `tsort: extra operand ${quoteLocale(operands[1])}`);
  const streams = new Streams();
  const name = operands[0] ?? '-';
  const read = new InputQueue(io).read(name);
  if (read.kind !== 'ok') {
    streams.diagnostic(`tsort: ${quotef(name)}: ${readFailureText(read)}`);
    streams.exitCode = 1;
    return streams.result();
  }
  const tokens = read.text.split(/\s+/).filter((token) => token !== '');
  const nodes = new Map<string, Node>();
  const nodeOf = (token: string): Node => {
    let node = nodes.get(token);
    if (node === undefined) { node = { name: token, count: 0, printed: false, qlink: null, successors: [] }; nodes.set(token, node); }
    return node;
  };
  if (tokens.length % 2 !== 0) {
    streams.diagnostic(`tsort: ${quotef(name)}: input contains an odd number of tokens`);
    streams.exitCode = 1;
    return streams.result();
  }
  for (let at = 0; at < tokens.length; at += 2) {
    const first = nodeOf(tokens[at]);
    const second = nodeOf(tokens[at + 1]);
    if (first !== second) {
      second.count++;
      first.successors.unshift(second);
    }
  }
  const sorted = [...nodes.values()].sort((a, b) => compareNames(a.name, b.name));
  let head: Node | null = null;
  let zeros: Node | null = null;
  let loop: Node | null = null;
  let remaining = sorted.length;
  let output = '';
  const label = quotef(name);
  const flushOutput = (): void => {
    streams.stdout(output);
    output = '';
  };
  const scanZeros = (node: Node): void => {
    if (node.count === 0 && !node.printed) {
      if (head === null) head = node;
      else (zeros as Node).qlink = node;
      zeros = node;
    }
  };
  const detectLoop = (node: Node): boolean => {
    if (node.count <= 0) return false;
    if (loop === null) { loop = node; return false; }
    for (let index = 0; index < node.successors.length; index++) {
      if (node.successors[index] !== loop) continue;
      if (node.qlink !== null) {
        flushOutput();
        while (loop !== null) {
          const next: Node | null = loop.qlink;
          streams.diagnostic(`tsort: ${loop.name}`);
          if (loop === node) {
            const removed = node.successors.splice(index, 1)[0];
            removed.count--;
            break;
          }
          loop.qlink = null;
          loop = next;
        }
        while (loop !== null) {
          const next: Node | null = loop.qlink;
          loop.qlink = null;
          loop = next;
        }
        return true;
      }
      node.qlink = loop;
      loop = node;
      break;
    }
    return false;
  };
  while (remaining > 0) {
    for (const node of sorted) scanZeros(node);
    while (head !== null) {
      const current: Node = head;
      output += `${current.name}\n`;
      current.printed = true;
      remaining--;
      for (const successor of current.successors) {
        successor.count--;
        if (successor.count === 0) {
          (zeros as Node).qlink = successor;
          zeros = successor;
        }
      }
      head = current.qlink;
    }
    if (remaining > 0) {
      flushOutput();
      streams.diagnostic(`tsort: ${label}: input contains a loop:`);
      streams.exitCode = 1;
      do {
        for (const node of sorted) if (detectLoop(node)) break;
      } while (loop !== null);
    }
  }
  flushOutput();
  return streams.result();
}
