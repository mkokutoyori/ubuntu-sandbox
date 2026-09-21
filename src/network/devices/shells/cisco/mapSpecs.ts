import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

const MODE = ['config'] as const;

export interface MapHost {
  ouvrirClassMap(nom: string, sorte: 'qos' | 'inspect', matchAll: boolean): string;
  retirerClassMap(nom: string): string;
  ouvrirPolicyMap(nom: string, sorte: 'qos' | 'inspect'): string;
  retirerPolicyMap(nom: string): string;
}

const NOM_CLASSE: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Class map name',
};

const NOM_POLITIQUE: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'Policy map name',
};

const SORTES: ReadonlyArray<readonly [readonly string[], 'qos' | 'inspect']> = [
  [[], 'qos'],
  [['type', 'inspect'], 'inspect'],
];

const APPARIEMENTS: ReadonlyArray<readonly [readonly string[], boolean]> = [
  [[], true],
  [['match-all'], true],
  [['match-any'], false],
];

export function mapSpecs(ctx: () => MapHost): CommandSpec[] {
  const specs: CommandSpec[] = [];

  for (const [teteSorte, sorte] of SORTES) {
    for (const [teteAppariement, matchAll] of APPARIEMENTS) {
      specs.push({
        id: ['class-map', ...teteSorte, ...teteAppariement].join('-'),
        path: ['class-map', ...teteSorte, ...teteAppariement, NOM_CLASSE],
        description: 'Define class map',
        undoDescription: 'Remove a class map',
        modes: MODE, minPrivilege: 15,
        run: (_s, args) => ctx().ouvrirClassMap(args.nom, sorte, matchAll),
        undo: (_s, args) => ctx().retirerClassMap(args.nom),
      });
    }

    specs.push({
      id: ['policy-map', ...teteSorte].join('-'),
      path: ['policy-map', ...teteSorte, NOM_POLITIQUE],
      description: 'Define policy map',
      undoDescription: 'Remove a policy map',
      modes: MODE, minPrivilege: 15,
      run: (_s, args) => ctx().ouvrirPolicyMap(args.nom, sorte),
      undo: (_s, args) => ctx().retirerPolicyMap(args.nom),
    });
  }

  return specs;
}

export const MAP_LEGENDS: ReadonlyArray<
  readonly [readonly string[], string, readonly string[]]
> = [
  [['class-map', 'type'], 'Type', [...MODE]],
  [['class-map', 'type', 'inspect'], 'Inspection', [...MODE]],
  [['class-map', 'match-all'], 'Match all criteria', [...MODE]],
  [['class-map', 'match-any'], 'Match any criterion', [...MODE]],
  [['class-map', 'type', 'inspect', 'match-all'], 'Match all criteria', [...MODE]],
  [['class-map', 'type', 'inspect', 'match-any'], 'Match any criterion', [...MODE]],
  [['policy-map', 'type'], 'Type', [...MODE]],
  [['policy-map', 'type', 'inspect'], 'Inspection', [...MODE]],
];
