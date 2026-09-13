import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';

export interface AclEntryHost {
  addEntry(
    action: 'permit' | 'deny', mots: readonly string[], sequence?: number,
  ): string;
  removeEntry(action: 'permit' | 'deny', mots: readonly string[]): string;
  removeSequence(sequence: number): string;
  addRemark(texte: string): string;
  addEvaluate(nom: string): string;
}

export const SEQUENCE: ArgumentSpec = {
  name: 'sequence', type: 'INT', range: [1, 2147483647],
  description: 'Sequence Number',
};

export function numeroDeSequence(args: Record<string, string>): number | undefined {
  return args.sequence === undefined ? undefined : parseInt(args.sequence, 10);
}

export function avecNumeroDeSequence(
  specs: readonly CommandSpec[],
): CommandSpec[] {
  return specs.flatMap(spec => [spec, {
    ...spec,
    id: `${spec.id}-sequence`,
    path: [SEQUENCE, ...spec.path],
  }]);
}

export function aclSubmodeSpecs(
  mode: 'config-std-nacl' | 'config-ext-nacl',
  ctx: () => AclEntryHost,
): CommandSpec[] {
  const modes = [mode] as const;
  const specs: CommandSpec[] = [
    {
      id: `acl-${mode}-remark`,
      path: ['remark', {
        name: 'texte', type: 'REST', literal: 'LINE',
        description: 'Comment up to 100 characters',
      }],
      description: 'Access list entry comment',
      modes, minPrivilege: 15,
      run: (_s, args) => ctx().addRemark(args.texte),
    },
    {
      id: `acl-${mode}-supprime-sequence`,
      path: [SEQUENCE],
      description: 'Sequence Number',
      modes, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '',
      undo: (_s, args) => ctx().removeSequence(parseInt(args.sequence, 10)),
    },
  ];

  if (mode === 'config-ext-nacl') {
    specs.push({
      id: 'acl-ext-evaluate',
      path: ['evaluate', {
        name: 'miroir', type: 'WORD',
        description: 'Access list name',
      }],
      description: 'Evaluate an access list',
      modes, minPrivilege: 15,
      run: (_s, args) => ctx().addEvaluate(args.miroir),
    });
  }

  return specs;
}
