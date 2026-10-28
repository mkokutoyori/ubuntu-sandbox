import { INTERFACE_NAME } from '@/cli/ArgumentTypes';
import { isValidIPv4 } from '../../../core/ip';
import { CliInvalidInput } from '../cli/CliDiagnostic';

export interface SelectorWords {
  readonly keywords?: readonly string[];
  readonly interfaces?: boolean;
  readonly addresses?: boolean;
  readonly integer?: readonly [number, number];
  readonly max: number;
}

function fits(word: string, allowed: SelectorWords): boolean {
  if (allowed.keywords?.includes(word.toLowerCase())) return true;
  if (allowed.interfaces && INTERFACE_NAME.test(word)) return true;
  if (allowed.addresses && isValidIPv4(word)) return true;
  if (allowed.integer && /^\d+$/.test(word)) {
    const value = Number(word);
    return value >= allowed.integer[0] && value <= allowed.integer[1];
  }
  return false;
}

export function refuseUnknownSelector(args: readonly string[], allowed: SelectorWords): void {
  const bad = args.findIndex((word, at) => at >= allowed.max || !fits(word, allowed));
  if (bad >= 0) throw new CliInvalidInput({ token: args[bad] });
}

const NEIGHBOR_TAIL: SelectorWords = { keywords: ['detail'], interfaces: true, max: 2 };
const SINGLE_INTERFACE: SelectorWords = { interfaces: true, max: 1 };
const NO_TAIL: SelectorWords = { max: 0 };

export function refuseUnknownDiscoveryArgs(protocol: 'cdp' | 'lldp', words: readonly string[]): void {
  if (words.length === 0) return;
  const first = words[0].toLowerCase();
  const tail = words.slice(1);
  const stems: ReadonlyArray<readonly [string, SelectorWords | 'free']> = [
    ['neighbor', NEIGHBOR_TAIL], ['interface', SINGLE_INTERFACE], ['traffic', NO_TAIL],
    ['entry', 'free'],
    ...(protocol === 'lldp'
      ? [['local', NO_TAIL], ['errors', NO_TAIL]] as const
      : []),
  ];
  const match = stems.find(([stem]) => first.startsWith(stem));
  if (!match) throw new CliInvalidInput({ token: words[0] });
  if (match[1] === 'free') {
    if (tail.length > 1) throw new CliInvalidInput({ token: tail[1] });
    return;
  }
  refuseUnknownSelector(tail, match[1]);
}

export const EXEC_SHOW_SELECTORS: Readonly<Record<string, SelectorWords>> = {
  memory: { keywords: ['statistics', 'summary', 'free', 'io', 'processor', 'allocating-process', 'dead', 'fragment', 'failures'], max: 2 },
  boot: { max: 0 },
  flash: { keywords: ['all', 'chips', 'detail', 'err', 'summary'], max: 1 },
  controllers: { interfaces: true, keywords: ['ethernet', 'gigabitethernet', 'fastethernet', 'serial'], integer: [0, 65535], max: 2 },
  environment: { keywords: ['all', 'fan', 'power', 'temperature', 'status', 'table', 'voltage', 'alarm', 'leds'], max: 1 },
};

export function refuseUnknownExecShowTail(view: keyof typeof EXEC_SHOW_SELECTORS, tail: string | undefined): void {
  const words = (tail ?? '').trim().split(/\s+/).filter(Boolean);
  const base = EXEC_SHOW_SELECTORS[view];
  const tokens = view === 'controllers' && words.length === 2 && /^\d+(\/\d+)*$/.test(words[1])
    ? [words[0] + words[1]]
    : words;
  refuseUnknownSelector(tokens, base);
}
