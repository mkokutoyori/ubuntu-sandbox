import { resolveCiscoInterfaceName } from '../cli-utils';

export interface FhrpShowSelection {
  brief: boolean;
  iface: string | null;
  group: number | null;
}

export type FhrpShowVerdict = FhrpShowSelection | { at: string };

export interface FhrpShowGrammar {
  readonly groupRange: readonly [number, number];
  readonly interfaceKeyword: boolean;
  readonly acceptsAll: boolean;
}

export const HSRP_SHOW_GRAMMAR: FhrpShowGrammar = {
  groupRange: [0, 4095], interfaceKeyword: false, acceptsAll: true,
};

export const VRRP_SHOW_GRAMMAR: FhrpShowGrammar = {
  groupRange: [1, 255], interfaceKeyword: true, acceptsAll: true,
};

export const GLBP_SHOW_GRAMMAR: FhrpShowGrammar = {
  groupRange: [0, 1023], interfaceKeyword: false, acceptsAll: false,
};

export function fhrpInterfaceResolver(
  names: Iterable<string>,
): (word: string) => string | null {
  const candidates = [...names];
  return (word) => resolveCiscoInterfaceName(candidates, word);
}

export function parseFhrpShowArgs(
  args: readonly string[],
  grammar: FhrpShowGrammar,
  resolveInterface: (word: string) => string | null,
): FhrpShowVerdict {
  const selection: FhrpShowSelection = { brief: false, iface: null, group: null };
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (word === undefined || word === '') continue;
    if (word === 'brief') { selection.brief = true; continue; }
    if (word === 'all' && grammar.acceptsAll) continue;
    if (grammar.interfaceKeyword && word === 'interface') {
      const next = args[i + 1];
      const name = next === undefined ? null : resolveInterface(next);
      if (name === null) return { at: next ?? word };
      selection.iface = name;
      i += 1;
      continue;
    }
    if (/^\d+$/.test(word)) {
      const group = Number(word);
      const [low, high] = grammar.groupRange;
      if (group < low || group > high) return { at: word };
      selection.group = group;
      continue;
    }
    if (!grammar.interfaceKeyword) {
      const name = resolveInterface(word);
      if (name !== null) { selection.iface = name; continue; }
    }
    return { at: word };
  }
  return selection;
}

export function fhrpShowMatches(
  iface: string, group: number, selection: FhrpShowSelection,
): boolean {
  if (selection.iface !== null
    && selection.iface.toLowerCase() !== iface.toLowerCase()) return false;
  return selection.group === null || selection.group === group;
}
