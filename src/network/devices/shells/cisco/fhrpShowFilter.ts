import type { CommandSpec } from '@/cli/CommandTable';
import { resolveCiscoInterfaceName } from '../cli-utils';
import { CliInvalidInput, CliIncomplete } from '../cli/CliDiagnostic';

export interface FhrpShowSelection {
  brief: boolean;
  iface: string | null;
  group: number | null;
}

export type FhrpShowVerdict = FhrpShowSelection | { at: string } | { incomplete: true };

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
      if (next === undefined) return { incomplete: true };
      const name = resolveInterface(next);
      if (name === null) return { at: next };
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

/**
 * La commande `show <protocole>` d'une famille FHRP, declaree au socle.
 *
 * Les trois vues etaient enregistrees SIX fois — trois par plateforme,
 * chacune dans les deux vues EXEC — alors qu'elles ne different que par
 * leur grammaire et leur rendu, tous deux deja passes en parametre. Une
 * commande du socle declare ses deux modes en UNE declaration.
 *
 * La queue reste une place LIBRE parce que la grammaire est PROPRE a
 * chaque protocole — la plage de groupe, le mot-cle `interface`,
 * l'existence de `all` — et qu'elle est deja lue par
 * `parseFhrpShowArgs`, qui refuse en nommant le jeton fautif. Ce que la
 * declaration apporte est ce que `?` doit annoncer : les formes que
 * cette vue-la accepte, et pas celles de ses soeurs. `show vrrp ?`
 * taisait `interface`, le seul mot-cle qui la distingue des deux autres.
 */
export function fhrpShowSpec(
  protocole: string,
  description: string,
  grammar: FhrpShowGrammar,
  portNames: () => Iterable<string>,
  rendre: (selection: FhrpShowSelection) => string,
): CommandSpec {
  const formes: Array<{ keyword: string; description: string }> = [
    { keyword: 'brief', description: 'Brief output' },
  ];
  if (grammar.acceptsAll) {
    formes.push({ keyword: 'all', description: 'Include inactive groups' });
  }
  if (grammar.interfaceKeyword) {
    formes.push({ keyword: 'interface', description: 'Groups on one interface' });
  }
  formes.push({
    keyword: `<${grammar.groupRange[0]}-${grammar.groupRange[1]}>`,
    description: 'Group number',
  });

  return {
    id: `show-${protocole}`,
    path: ['show', protocole, {
      name: 'filtre', type: 'REST', optional: true, leadingOnly: true,
      description: 'What to display', alternatives: formes,
    }],
    description,
    modes: ['user', 'privileged'], minPrivilege: 1,
    run: (_session, args) => {
      const mots = (args.filtre ?? '').trim();
      const verdict = parseFhrpShowArgs(
        mots.length === 0 ? [] : mots.split(/\s+/),
        grammar, fhrpInterfaceResolver(portNames()));
      if ('incomplete' in verdict) throw new CliIncomplete();
      if ('at' in verdict) throw new CliInvalidInput({ token: verdict.at });
      return rendre(verdict);
    },
  };
}
