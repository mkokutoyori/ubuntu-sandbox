import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';

const CONFIG = ['config'] as const;

export type AclKind = 'standard' | 'extended';

/**
 * Les quatre plages d'IOS, et la SEULE table qui les nomme.
 *
 * Elles ne forment pas un intervalle : 200-1299 n'est pas une ACL IP.
 * Une place `range` unique les fusionnerait donc en une plage que la
 * machine refuse a moitie. Ce sont des FORMES, pas des bornes, et elles
 * sont TOUT ce que la place accepte : l'analyse les applique
 * (`outsideEveryAnnouncedRange`) et l'aide les rend seules.
 */
export const ACL_NUMBER_RANGES: ReadonlyArray<{
  readonly min: number; readonly max: number; readonly description: string;
}> = [
  { min: 1, max: 99, description: 'IP standard access list' },
  { min: 100, max: 199, description: 'IP extended access list' },
  { min: 1300, max: 1999, description: 'IP standard access list (expanded range)' },
  { min: 2000, max: 2699, description: 'IP extended access list (expanded range)' },
];

export const ACL_NUMBER_FORMS: ReadonlyArray<{
  readonly keyword: string; readonly description: string;
}> = ACL_NUMBER_RANGES.map(r => ({
  keyword: `<${r.min}-${r.max}>`, description: r.description,
}));

/** Les quatre plages de numeros qu'IOS accepte pour une liste IP. */
export function isValidIosAclNumber(num: number): boolean {
  return ACL_NUMBER_RANGES.some(r => num >= r.min && num <= r.max);
}

export const ACL_ACTIONS: ReadonlyArray<{
  readonly keyword: string; readonly description: string;
}> = [
  { keyword: 'deny', description: 'Specify packets to reject' },
  { keyword: 'permit', description: 'Specify packets to forward' },
  { keyword: 'remark', description: 'Access list entry comment' },
];

export const ACL_KINDS: ReadonlyArray<{
  readonly keyword: AclKind; readonly description: string;
}> = [
  { keyword: 'extended', description: 'Create a named extended access list' },
  { keyword: 'standard', description: 'Create a named standard access list' },
];

export interface AclHeadHost {
  addNumbered(id: number, action: 'permit' | 'deny', queue: string): string;
  addNumberedRemark(id: number, texte: string): string;
  removeNumbered(id: number): string;
  enterNamed(kind: AclKind, nom: string): string;
  removeNamed(kind: AclKind, nom: string): string;
  resequenceNamed(nom: string, debut: number, pas: number): string;
}

const NUMERO: ArgumentSpec = {
  name: 'numero', type: 'INT',
  description: 'Access list number',
  alternatives: ACL_NUMBER_FORMS.map(f => ({ ...f })),
  formsAreExhaustive: true,
};

const NOM: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Access list name',
};

const QUEUE: ArgumentSpec = {
  name: 'queue', type: 'REST', literal: 'LINE',
  description: 'Access list entry criteria',
};

const SEQUENCE_RANGE: readonly [number, number] = [1, 2147483647];

function descriptionDeLAction(mot: string): string {
  return ACL_ACTIONS.find(a => a.keyword === mot)?.description ?? mot;
}

function numeroValide(brut: string): number {
  const id = Number(brut);
  if (!isValidIosAclNumber(id)) throw new CliInvalidInput({ token: brut });
  return id;
}

export function aclHeadSpecs(ctx: () => AclHeadHost): CommandSpec[] {
  const numerotee = (action: 'permit' | 'deny'): CommandSpec => ({
    id: `access-list-${action}`,
    path: ['access-list', NUMERO, action, QUEUE],
    description: descriptionDeLAction(action),
    modes: CONFIG, minPrivilege: 15,
    run: (_s, args) =>
      ctx().addNumbered(numeroValide(args.numero), action, args.queue),
  });

  const nommee = (kind: AclKind, description: string): CommandSpec => ({
    id: `ip-access-list-${kind}`,
    path: ['ip', 'access-list', kind, NOM],
    description,
    modes: CONFIG, minPrivilege: 15,
    run: (_s, args) => ctx().enterNamed(kind, args.nom),
    undo: (_s, args) => ctx().removeNamed(kind, args.nom),
  });

  return [
    numerotee('permit'),
    numerotee('deny'),
    {
      id: 'access-list-remark',
      path: ['access-list', NUMERO, 'remark', {
        name: 'texte', type: 'REST', literal: 'LINE',
        description: 'Comment up to 100 characters',
      }],
      description: descriptionDeLAction('remark'),
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) =>
        ctx().addNumberedRemark(numeroValide(args.numero), args.texte),
    },
    {
      id: 'access-list-undo',
      path: ['access-list', NUMERO],
      description: 'Add an access list entry',
      undoDescription: 'Remove an access list',
      modes: CONFIG, minPrivilege: 15,
      existsOnlyNegated: true,
      run: (_s, args) => ctx().removeNumbered(numeroValide(args.numero)),
      undo: (_s, args) => ctx().removeNumbered(numeroValide(args.numero)),
    },
    ...ACL_KINDS.map(k => nommee(k.keyword, k.description)),
    {
      id: 'ip-access-list-resequence',
      path: ['ip', 'access-list', 'resequence', NOM, {
        name: 'debut', type: 'INT', range: SEQUENCE_RANGE,
        description: 'First sequence number',
      }, {
        name: 'pas', type: 'INT', range: SEQUENCE_RANGE,
        description: 'Step between sequence numbers',
      }],
      description: 'Resequence an access list',
      modes: CONFIG, minPrivilege: 15,
      run: (_s, args) =>
        ctx().resequenceNamed(args.nom, Number(args.debut), Number(args.pas)),
    },
  ];
}
