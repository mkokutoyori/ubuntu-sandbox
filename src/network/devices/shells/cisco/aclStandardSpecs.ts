import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';

const MODE = ['config-std-nacl'] as const;

/**
 * Ce que le sous-mode d'une liste STANDARD sait faire d'une ACE.
 *
 * Le port ne rend pas les mots au moteur : il les LUI donne, et c'est
 * `parseCiscoAce` qui tranche, comme avant. Ce lot deplace la
 * DECLARATION, pas la grammaire — les deux moteurs se contrediraient
 * sur la premiere adresse mal formee.
 */
export interface AclStandardHost {
  addEntry(action: 'permit' | 'deny', mots: readonly string[]): string;
  removeEntry(action: 'permit' | 'deny', mots: readonly string[]): string;
}

const ADRESSE = (nom: string, description: string): ArgumentSpec =>
  ({ name: nom, type: 'IP_ADDR', description });

/*
 * `log`, `log-input` et `time-range` s'ecrivent dans n'importe quel
 * ordre et une seule fois : c'est ce que le sac d'options dit, et il
 * est lu par l'analyse comme par l'aide. Les declarer en sequence
 * aurait fixe un ordre qu'IOS n'impose pas.
 */
const SUFFIXES: readonly OptionSpec[] = [
  { keyword: 'log', description: 'Log matches against this entry' },
  {
    keyword: 'log-input',
    description: 'Log matches against this entry, including input interface',
  },
  {
    keyword: 'time-range', description: 'Specify a time-range',
    argument: { name: 'plage', type: 'WORD', description: 'Name of the time range' },
  },
];

function suffixes(args: Record<string, string>): string[] {
  const mots: string[] = [];
  if (args.log !== undefined) mots.push('log');
  if (args['log-input'] !== undefined) mots.push('log-input');
  if (args.plage !== undefined) mots.push('time-range', args.plage);
  return mots;
}

export function aclStandardSpecs(ctx: () => AclStandardHost): CommandSpec[] {
  const forme = (
    action: 'permit' | 'deny',
    suffixe: string,
    chemin: ReadonlyArray<string | ArgumentSpec>,
    source: (args: Record<string, string>) => string[],
  ): CommandSpec => ({
    id: `acl-std-${action}-${suffixe}`,
    path: [action, ...chemin],
    description: action === 'permit'
      ? 'Specify packets to permit' : 'Specify packets to reject',
    modes: MODE, minPrivilege: 15,
    options: SUFFIXES,
    run: (_s, args) => ctx().addEntry(action, [...source(args), ...suffixes(args)]),
    undo: (_s, args) => ctx().removeEntry(action, [...source(args), ...suffixes(args)]),
  });

  return (['permit', 'deny'] as const).flatMap(action => [
    forme(action, 'any', ['any'], () => ['any']),
    forme(action, 'host',
      ['host', ADRESSE('hote', 'A single host address')],
      (args) => ['host', args.hote]),
    /*
     * L'adresse NUE et son masque sont une seule declaration : le masque
     * est facultatif, et l'omettre vaut `host` — c'est ce que le moteur
     * lit (`parseStandardSource`), et c'est pour cela que `permit
     * 10.0.0.5` se relit `permit host 10.0.0.5`.
     */
    forme(action, 'reseau',
      [
        ADRESSE('reseau', 'Source address'),
        { ...ADRESSE('masque', 'Wildcard bits'), optional: true },
      ],
      (args) => (args.masque === undefined
        ? [args.reseau] : [args.reseau, args.masque])),
  ]);
}
