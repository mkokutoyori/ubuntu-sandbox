import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliIncomplete, CliInvalidInput } from '../cli/CliDiagnostic';
import {
  ROUTE_MAP_MATCH_CLAUSES, ROUTE_MAP_SET_CLAUSES,
  type RouteMapClauseKind, type RouteMapClauseSpec,
} from '../../router/policy/routeMapClauses';

const CONFIG = ['config'] as const;
export const ROUTE_MAP_MODE = 'config-route-map';
const CARTE = [ROUTE_MAP_MODE] as const;

export const ROUTE_MAP_SEQ_RANGE: readonly [number, number] = [0, 65535];

export const ROUTE_MAP_ACTIONS: ReadonlyArray<{
  readonly keyword: 'permit' | 'deny'; readonly description: string;
}> = [
  { keyword: 'deny', description: 'Specify packets to reject' },
  { keyword: 'permit', description: 'Specify packets to forward' },
];

export interface RouteMapHost {
  enterClause(name: string, action: 'permit' | 'deny', seq: number): string;
  removeMap(name: string): string;
  addClause(kind: RouteMapClauseKind, mots: readonly string[], queue: string): string;
  removeClause(kind: RouteMapClauseKind, mots: readonly string[]): string;
  setDescription(texte: string): string;
}

const QUEUES: Readonly<Record<RouteMapClauseKind, string>> = {
  match: 'Criterion the route must satisfy',
  set: 'Value the route-map applies to a matching route',
};

const FAMILLES: Readonly<Record<RouteMapClauseKind, readonly RouteMapClauseSpec[]>> = {
  match: ROUTE_MAP_MATCH_CLAUSES,
  set: ROUTE_MAP_SET_CLAUSES,
};

/**
 * Le juge de la clause DIT si sa queue est facultative.
 *
 * `set automatic-tag` ne prend rien, `match as-path` exige un numero, et
 * la seule chose qui le sache est le juge que le moteur applique. Le
 * relire ici plutot que dresser une seconde liste des clauses sans
 * queue : cette liste-la aurait fini par differer de celle qui decide.
 */
function queueFacultative(clause: RouteMapClauseSpec): boolean {
  return clause.judge([]) === null;
}

function specDeClause(
  genre: RouteMapClauseKind, clause: RouteMapClauseSpec, ctx: () => RouteMapHost,
): CommandSpec {
  const facultative = queueFacultative(clause);
  const queue: ArgumentSpec = {
    name: 'queue', type: 'REST', literal: 'LINE',
    description: QUEUES[genre],
    optional: facultative || undefined,
  };
  return {
    id: `route-map-${genre}-${clause.words.join('-')}`,
    path: [genre, ...clause.words, queue],
    description: clause.description,
    modes: CARTE, minPrivilege: 15,
    undoOmitsArguments: !facultative || undefined,
    run: (_s, args) => ctx().addClause(genre, clause.words, args.queue ?? ''),
    undo: () => ctx().removeClause(genre, clause.words),
  };
}

export function routeMapSpecs(ctx: () => RouteMapHost): CommandSpec[] {
  const clauses = (Object.keys(FAMILLES) as RouteMapClauseKind[])
    .flatMap(genre => FAMILLES[genre].map(c => specDeClause(genre, c, ctx)));

  return [
    {
      id: 'route-map',
      path: ['route-map',
        { name: 'nom', type: 'WORD', description: 'Route map tag' },
        {
          name: 'action', type: 'ENUM', optional: true,
          description: 'Access control action',
          values: ROUTE_MAP_ACTIONS.map(v => ({ ...v })),
        },
        {
          name: 'sequence', type: 'INT', optional: true,
          range: ROUTE_MAP_SEQ_RANGE,
          description: 'Sequence to insert to/delete from existing route-map entry',
        },
      ],
      description: 'Create route-map or enter route-map command mode',
      undoDescription: 'Remove a route-map',
      modes: CONFIG, minPrivilege: 15,
      enters: ROUTE_MAP_MODE,
      run: (_s, args) => ctx().enterClause(
        args.nom,
        (args.action ?? 'permit') as 'permit' | 'deny',
        args.sequence === undefined ? 10 : Number(args.sequence)),
      undo: (_s, args) => ctx().removeMap(args.nom),
    },
    {
      id: 'route-map-description',
      path: ['description', {
        name: 'texte', type: 'REST', literal: 'LINE',
        description: 'Description of this route-map clause',
      }],
      description: 'Route-map description',
      modes: CARTE, minPrivilege: 15,
      undoOmitsArguments: true,
      run: (_s, args) => ctx().setDescription(args.texte),
      undo: () => ctx().setDescription(''),
    },
    ...clauses,
  ];
}

/**
 * Le verdict du juge, rendu dans les mots de la CLI.
 *
 * Le juge rend un RANG dans la queue ; le caret veut le mot. Les deux
 * moteurs le traduisaient chacun de leur cote, donc pas toujours de la
 * meme facon.
 */
export function refuserSelonLeJuge(
  genre: RouteMapClauseKind, mots: readonly string[], queue: readonly string[],
): never {
  const clause = FAMILLES[genre].find(
    c => c.words.length === mots.length && c.words.every((w, i) => w === mots[i]));
  const verdict = clause?.judge(queue) ?? null;
  if (verdict === 'incomplete' || verdict === null) throw new CliIncomplete();
  throw new CliInvalidInput({ token: queue[verdict.at] });
}
