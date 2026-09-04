import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import {
  ALIAS_MODE_VALUES, parseAliasMode, type AliasMode, type AliasRepository,
} from '../../inspection/config/AliasRepository';

const MODES = ['config'] as const;

export const LEGACY_LIST_RANGE: readonly [number, number] = [1, 16];
export const PASSWORD_MIN_LENGTH_RANGE: readonly [number, number] = [0, 16];

const ALIAS_MODE_PLACE: ArgumentSpec = {
  name: 'mode', type: 'ENUM',
  description: 'Command mode of the alias',
  values: ALIAS_MODE_VALUES.map((v) => ({ ...v })),
};

export interface GlobalHeadHost {
  aliases(): AliasRepository;
  setMinPasswordLength(n: number): void;
  recordConfigLine(line: string): void;
  removeConfigLine(needle: string): void;
}

/**
 * `alias`, declaree une fois pour les deux plateformes.
 *
 * Le trie la servait en GLOUTON, avec un gestionnaire qui relisait
 * lui-meme le nom du mode — et deux formes reelles d'IOS lui
 * manquaient. `alias line eo exec-timeout` etait REFUSE : le mode `line`
 * ne figurait pas dans la table des modes, donc la place l'ecartait et
 * l'aide le taisait, alors que c'est le mode ou l'on abrege le plus
 * (`exec-timeout`, `logging synchronous`, `transport input`). Et `no
 * alias exec` sans nom repondait `% Incomplete command.` alors que
 * c'est la commande documentee pour DESACTIVER les alias d'usine — la
 * seule facon de retirer `p`, `s` ou `w`, qui existent des l'allumage.
 */
export function aliasSpecs(ctx: () => GlobalHeadHost): CommandSpec[] {
  const mode = (args: Record<string, string>) =>
    parseAliasMode(args.mode) as AliasMode;

  return [
    {
      id: 'alias',
      path: ['alias', ALIAS_MODE_PLACE,
        { name: 'nom', type: 'WORD', description: 'Alias name' },
        { name: 'commande', type: 'REST', literal: 'LINE',
          description: 'Command the alias stands for' }],
      description: 'Create a command alias',
      undoDescription: 'Remove a command alias',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        if (args.nom.length > 31) return '% Alias name exceeds 31 characters.';
        ctx().aliases().set(mode(args), args.nom, args.commande);
        return '';
      },
      undo: (_session, args) => {
        ctx().aliases().remove(mode(args), args.nom);
        return '';
      },
    },
    {
      id: 'alias-nom',
      path: ['alias', ALIAS_MODE_PLACE,
        { name: 'nom', type: 'WORD', description: 'Alias name' }],
      description: 'Create a command alias',
      undoDescription: 'Remove a command alias',
      modes: MODES, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: (_session, args) => {
        ctx().aliases().remove(mode(args), args.nom);
        return '';
      },
    },
    {
      id: 'alias-mode',
      path: ['alias', ALIAS_MODE_PLACE],
      description: 'Create a command alias',
      undoDescription: 'Remove every alias of a command mode',
      modes: MODES, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: (_session, args) => {
        ctx().aliases().removeMode(mode(args));
        return '';
      },
    },
  ];
}

/**
 * Un reglage global RANGE ET RENDU, que rien n'evalue.
 *
 * `priority-list`, `queue-list` et `clock calendar-valid` sont des
 * commandes que ce simulateur accepte pour ne pas les perdre a l'import
 * d'une topologie — leur file d'attente et leur calendrier materiel
 * n'existent pas ici — et le trie les enregistrait en glouton avec, a
 * chaque fois, la meme ligne de rangement recopiee. Ce que la migration
 * ferme n'est donc pas leur inertie mais leur NEGATION : `clock
 * calendar-valid` etait range et rendu, et `no clock calendar-valid`
 * n'existait pas, donc le reglage revenait au rechargement d'une
 * topologie ou l'operateur venait de l'oter.
 */
export function recordedGlobalSpec(
  id: string, mots: readonly string[], description: string,
  ctx: () => GlobalHeadHost, place?: readonly ArgumentSpec[],
): CommandSpec {
  const tete = mots.join(' ');
  return {
    id,
    path: [...mots, ...(place ?? [])],
    description,
    undoDescription: `Remove ${description.toLowerCase()}`,
    modes: MODES, minPrivilege: 15,
    run: (_session, args) => {
      const suite = (place ?? []).map((p) => args[p.name]).join(' ');
      ctx().recordConfigLine(suite ? `${tete} ${suite}` : tete);
      return '';
    },
    undo: (_session, args) => {
      const suite = (place ?? []).map((p) => args[p.name]).join(' ');
      ctx().removeConfigLine(suite ? `${tete} ${suite}` : tete);
      return '';
    },
  };
}

const LEGACY_LIST_PLACES = (description: string): readonly ArgumentSpec[] => [
  { name: 'numero', type: 'INT', range: LEGACY_LIST_RANGE, description },
  { name: 'regle', type: 'REST', literal: 'LINE',
    description: 'Rule this list entry declares' },
];

export function globalHeadSpecs(ctx: () => GlobalHeadHost): CommandSpec[] {
  return [
    ...aliasSpecs(ctx),
    {
      id: 'security-passwords-min-length',
      path: ['security', 'passwords', 'min-length',
        { name: 'longueur', type: 'INT', range: PASSWORD_MIN_LENGTH_RANGE,
          description: 'Minimum password length' }],
      description: 'Minimum length of all user and enable passwords',
      modes: MODES, minPrivilege: 15,
      run: (_session, args) => {
        ctx().setMinPasswordLength(Number(args.longueur));
        return '';
      },
    },
    recordedGlobalSpec('priority-list', ['priority-list'],
      'Build a priority list', ctx,
      LEGACY_LIST_PLACES('Priority list number')),
    recordedGlobalSpec('queue-list', ['queue-list'],
      'Build a custom queue list', ctx,
      LEGACY_LIST_PLACES('Custom queue list number')),
    recordedGlobalSpec('clock-calendar-valid', ['clock', 'calendar-valid'],
      'Hardware calendar is a valid time source', ctx),
  ];
}
