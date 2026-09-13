import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { LEVEL_PERCENT_MAX, LEVEL_PERCENT_MIN } from './stormControlSyntax';

export interface StormControlHost {
  applyStormControl(words: readonly string[]): string;
  clearStormControl(words: readonly string[]): string;
}

const CONFIG_IF = Object.freeze(['config-if']);

const FORME_POURCENT = /^(100(\.0+)?|\d{1,2}(\.\d+)?)$/;
const FORME_DEBIT = /^\d+(\.\d+)?$/;

const BORNE_POURCENT = `<${LEVEL_PERCENT_MIN}.00-${LEVEL_PERCENT_MAX}.00>`;

const SORTE: ArgumentSpec = {
  name: 'sorte', type: 'ENUM', description: 'Traffic type to police',
  values: [
    { keyword: 'broadcast', description: 'Broadcast address storm control' },
    { keyword: 'multicast', description: 'Multicast address storm control' },
    { keyword: 'unicast', description: 'Unicast address storm control' },
  ],
};

const ACTION: ArgumentSpec = {
  name: 'action', type: 'ENUM', description: 'Action taken when a storm is detected',
  values: [
    { keyword: 'shutdown', description: 'Shutdown this interface when a storm occurs' },
    { keyword: 'trap', description: 'Send an SNMP trap when a storm occurs' },
  ],
};

const pourcent = (name: string, role: string, optional?: boolean): ArgumentSpec => ({
  name, type: 'WORD', literal: BORNE_POURCENT, pattern: FORME_POURCENT,
  description: `${role} threshold, as a percentage of the port bandwidth`,
  ...(optional ? { optional: true } : {}),
});

const debit = (name: string, role: string, unite: string, optional?: boolean):
ArgumentSpec => ({
  name, type: 'WORD', pattern: FORME_DEBIT,
  description: `${role} threshold, in ${unite}`,
  ...(optional ? { optional: true } : {}),
});

const UNITES: ReadonlyArray<readonly [string, string, string]> = [
  ['bps', 'bits per second', 'Enter the rate in bits per second'],
  ['pps', 'packets per second', 'Enter the rate in packets per second'],
];

const valeurs = (args: Readonly<Record<string, string>>, ...noms: string[]): string[] =>
  noms.map((nom) => (args[nom] ?? '').trim()).filter((v) => v.length > 0);

export function stormControlSpecs(ctx: () => StormControlHost): CommandSpec[] {
  const niveaux: CommandSpec[] = UNITES.map(([unite, mot, description]) => ({
    id: `storm-control-level-${unite}`,
    path: ['storm-control', SORTE, 'level', unite,
      debit('haut', 'Rising', mot), debit('bas', 'Falling', mot, true)],
    description,
    modes: CONFIG_IF, minPrivilege: 15,
    run: (_session, args) =>
      ctx().applyStormControl([args.sorte, 'level', unite,
        ...valeurs(args, 'haut', 'bas')]),
    undo: (_session, args) => ctx().clearStormControl([args.sorte]),
  }));

  return [
    {
      id: 'storm-control-action',
      path: ['storm-control', 'action', ACTION],
      description: 'Action taken when a storm is detected',
      modes: CONFIG_IF, minPrivilege: 15,
      run: (_session, args) => ctx().applyStormControl(['action', args.action]),
      undo: () => ctx().clearStormControl(['action']),
    },
    {
      id: 'no-storm-control-action',
      path: ['storm-control', 'action'],
      description: 'Action taken when a storm is detected',
      modes: CONFIG_IF, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => ctx().clearStormControl(['action']),
    },
    {
      id: 'storm-control-level',
      path: ['storm-control', SORTE, 'level',
        pourcent('haut', 'Rising'), pourcent('bas', 'Falling', true)],
      description: 'Set the storm suppression level on this interface',
      modes: CONFIG_IF, minPrivilege: 15,
      run: (_session, args) =>
        ctx().applyStormControl([args.sorte, 'level', ...valeurs(args, 'haut', 'bas')]),
      undo: (_session, args) => ctx().clearStormControl([args.sorte]),
    },
    ...niveaux,
    {
      id: 'no-storm-control-level',
      path: ['storm-control', SORTE, 'level'],
      description: 'Set the storm suppression level on this interface',
      modes: CONFIG_IF, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: (_session, args) => ctx().clearStormControl([args.sorte]),
    },
    {
      id: 'no-storm-control-sorte',
      path: ['storm-control', SORTE],
      description: 'Remove the storm suppression level of a traffic type',
      modes: CONFIG_IF, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: (_session, args) => ctx().clearStormControl([args.sorte]),
    },
  ];
}
