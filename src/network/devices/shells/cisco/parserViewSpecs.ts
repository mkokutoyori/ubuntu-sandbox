import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { AUTH_SCOPE_VALUES, type AuthScope } from '../cli/CliAuthorization';

const CONFIG = ['config'] as const;
export const PARSER_VIEW_MODE = 'config-view';
const VUE = [PARSER_VIEW_MODE] as const;

export const PARSER_VIEW_SENSES: ReadonlyArray<{
  readonly keyword: 'include' | 'include-exclusive' | 'exclude';
  readonly description: string;
}> = [
  { keyword: 'exclude', description: 'Remove a command from the view' },
  { keyword: 'include', description: 'Add a command to the view' },
  {
    keyword: 'include-exclusive',
    description: 'Add a command to the view and reserve it for this view',
  },
];

export type ParserViewSense = (typeof PARSER_VIEW_SENSES)[number]['keyword'];

export interface ParserViewHost {
  declareView(name: string, superview: boolean): string;
  removeView(name: string): string;
  setSecret(brut: string): string;
  addMember(name: string): string;
  applyCommands(
    scope: AuthScope, sense: ParserViewSense, all: boolean, command: string,
  ): string;
}

const NOM: ArgumentSpec = {
  name: 'nom', type: 'WORD', description: 'View name',
};

/*
 * Les MOTS viennent d'`AUTH_SCOPE_VALUES`, qui les tient pour tout le
 * moteur d'autorisation ; les PHRASES sont celles que la vue emploie et
 * qui ne sont pas celles de `privilege <mode> level` — IOS dit ici
 * « EXEC mode commands » et la-bas « Exec mode ». Deux listes de mots
 * auraient fini par differer d'un espace de nommage ; deux tables de
 * phrases ne le peuvent pas, chacune n'etant ecrite qu'une fois.
 */
const PHRASES_DE_VUE: Readonly<Record<AuthScope, string>> = {
  configure: 'Global configuration commands',
  exec: 'EXEC mode commands',
  interface: 'Interface configuration commands',
  line: 'Line configuration commands',
};

const ESPACE: ArgumentSpec = {
  name: 'espace', type: 'ENUM',
  description: 'Mode the rule applies to',
  values: AUTH_SCOPE_VALUES.map(v => ({
    keyword: v.keyword, description: PHRASES_DE_VUE[v.keyword],
  })),
};

const SENS: ArgumentSpec = {
  name: 'sens', type: 'ENUM',
  description: 'What the rule does with the command',
  values: PARSER_VIEW_SENSES.map(v => ({ ...v })),
};

const COMMANDE: ArgumentSpec = {
  name: 'commande', type: 'REST', literal: 'LINE',
  description: 'The command the rule applies to',
};

export function parserViewSpecs(ctx: () => ParserViewHost): CommandSpec[] {
  const regle = (avecTous: boolean): CommandSpec => ({
    id: avecTous ? 'view-commands-all' : 'view-commands',
    path: avecTous
      ? ['commands', ESPACE, SENS, 'all', COMMANDE]
      : ['commands', ESPACE, SENS, COMMANDE],
    description: 'Configure the commands of a view',
    modes: VUE, minPrivilege: 15,
    run: (_s, args) => ctx().applyCommands(
      args.espace as AuthScope, args.sens as ParserViewSense,
      avecTous, args.commande),
  });

  return [
    {
      id: 'parser-view',
      path: ['parser', 'view', NOM],
      description: 'Define a CLI view',
      undoDescription: 'Remove a CLI view',
      modes: CONFIG, minPrivilege: 15,
      enters: PARSER_VIEW_MODE,
      run: (_s, args) => ctx().declareView(args.nom, false),
      undo: (_s, args) => ctx().removeView(args.nom),
    },
    {
      id: 'parser-view-superview',
      path: ['parser', 'view', NOM, 'superview'],
      description: 'Define this view as a superview',
      modes: CONFIG, minPrivilege: 15,
      enters: PARSER_VIEW_MODE,
      run: (_s, args) => ctx().declareView(args.nom, true),
      undo: (_s, args) => ctx().removeView(args.nom),
    },
    {
      id: 'view-secret',
      path: ['secret', {
        name: 'mot', type: 'REST', literal: 'LINE',
        description: 'The password itself, or a digest already computed',
        alternatives: [
          { keyword: '0', description: 'Specifies an UNENCRYPTED password will follow' },
          { keyword: '5', description: 'Specifies a MD5 HASHED password will follow' },
          { keyword: '7', description: 'Specifies a HIDDEN password will follow' },
          { keyword: '8', description: 'Specifies a PBKDF2 HASHED password will follow' },
          { keyword: '9', description: 'Specifies a SCRYPT HASHED password will follow' },
          { keyword: 'LINE', description: 'The UNENCRYPTED (cleartext) view password' },
        ],
      }],
      description: 'Set the view password',
      modes: VUE, minPrivilege: 15,
      run: (_s, args) => ctx().setSecret(args.mot),
    },
    {
      id: 'view-member',
      path: ['view', { ...NOM, description: 'Name of the member view' }],
      description: 'Add a member view to this superview',
      modes: VUE, minPrivilege: 15,
      run: (_s, args) => ctx().addMember(args.nom),
    },
    regle(false),
    regle(true),
  ];
}
