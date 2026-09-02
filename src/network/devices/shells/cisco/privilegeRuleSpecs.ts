import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { AUTH_SCOPE_VALUES } from '../cli/CliAuthorization';

export interface PrivilegeRuleHost {
  applyPrivilegeRule(words: string[], negate: boolean): string;
}

const MODE: ArgumentSpec = {
  name: 'mode', type: 'ENUM', description: 'Command mode',
  values: AUTH_SCOPE_VALUES.map((v) => ({ ...v })),
};

const NIVEAU: ArgumentSpec = {
  name: 'niveau', type: 'INT', range: [0, 15],
  description: 'Privilege level',
};

const COMMANDE: ArgumentSpec = {
  name: 'commande', type: 'REST',
  description: 'Initial keywords of the command to modify',
};

const DESCRIPTION = 'Configure command privilege levels';

export function privilegeRuleSpecs(ctx: () => PrivilegeRuleHost): CommandSpec[] {
  const forme = (
    id: string, milieu: ReadonlyArray<string | ArgumentSpec>, description: string,
  ): CommandSpec => ({
    id: `config-privilege-${id}`,
    path: ['privilege', MODE, ...milieu, COMMANDE],
    description,
    undoDescription: 'Remove a command privilege rule',
    modes: ['config'], minPrivilege: 15,
    run: (_session, args) => ctx().applyPrivilegeRule(mots(args, milieu), false),
    undo: (_session, args) => ctx().applyPrivilegeRule(mots(args, milieu), true),
  });

  return [
    forme('level', ['level', NIVEAU], DESCRIPTION),
    forme('all-level', ['all', 'level', NIVEAU],
      'Configure the privilege level of a command and its suboptions'),
    forme('reset', ['reset'], 'Reset a command to its default privilege level'),
    forme('all-reset', ['all', 'reset'],
      'Reset a command and its suboptions to their default privilege level'),
  ];
}

function mots(
  args: Record<string, string>, milieu: ReadonlyArray<string | ArgumentSpec>,
): string[] {
  const out = [args.mode ?? ''];
  for (const pas of milieu) {
    if (typeof pas === 'string') out.push(pas);
    else out.push(args[pas.name] ?? '');
  }
  return [...out, ...(args.commande ?? '').trim().split(/\s+/).filter(Boolean)];
}
