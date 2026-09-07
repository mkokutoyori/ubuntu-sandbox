import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { CiscoSecurityConfig } from '../../router/security/CiscoSecurityConfig';

const MODES = ['config'] as const;

export const AAA_GROUP_MODE = 'config-aaa-group';

export type AaaPhase = 'authentication' | 'authorization' | 'accounting';

type Valeur = { readonly keyword: string; readonly description: string };

export const AAA_SERVICE_VALUES: Readonly<Record<AaaPhase, readonly Valeur[]>> = {
  authentication: [
    { keyword: 'dot1x', description: 'Set authentication lists for IEEE 802.1x' },
    { keyword: 'enable', description: 'Set authentication list for enable' },
    { keyword: 'login', description: 'Set authentication lists for logins' },
    { keyword: 'ppp', description: 'Set authentication lists for ppp' },
  ],
  authorization: [
    { keyword: 'commands', description: 'For exec (shell) commands' },
    { keyword: 'config-commands', description: 'For configuration mode commands' },
    { keyword: 'exec', description: 'For starting an exec (shell)' },
    { keyword: 'network', description: 'For network services (PPP, SLIP, ARAP)' },
    { keyword: 'reverse-access', description: 'For reverse access connections' },
  ],
  accounting: [
    { keyword: 'commands', description: 'For exec (shell) commands' },
    { keyword: 'connection', description: 'For outbound connections' },
    { keyword: 'exec', description: 'For starting an exec (shell)' },
    { keyword: 'network', description: 'For network services (PPP, SLIP, ARAP)' },
    { keyword: 'system', description: 'For system events' },
  ],
};

export const AAA_SERVICES: Readonly<Record<AaaPhase, readonly string[]>> = {
  authentication: AAA_SERVICE_VALUES.authentication.map((v) => v.keyword),
  authorization: AAA_SERVICE_VALUES.authorization.map((v) => v.keyword),
  accounting: AAA_SERVICE_VALUES.accounting.map((v) => v.keyword),
};

export const AAA_GROUP_KINDS: readonly Valeur[] = [
  { keyword: 'radius', description: 'RADIUS server group' },
  { keyword: 'tacacs+', description: 'TACACS+ server group' },
];

export interface AaaHeadHost {
  security(): CiscoSecurityConfig;
  selectAaaGroup(name: string): void;
  setLocalAuthMaxFail(n: number): void;
  parseMethodList(phase: AaaPhase, args: readonly string[]): string;
}

const PHASE_DESCRIPTIONS: Readonly<Record<AaaPhase, readonly [string, string]>> = {
  authentication: ['Authentication configurations parameters', 'Service to authenticate'],
  authorization: ['Authorization configurations parameters', 'Service to authorize'],
  accounting: ['Accounting configurations parameters', 'Service to account for'],
};

const decoupe = (reste: string | undefined): string[] =>
  (reste ?? '').trim().length === 0 ? [] : (reste as string).trim().split(/\s+/);

const suiteDeMethodes: ArgumentSpec = {
  name: 'reste', type: 'REST', literal: 'LINE', optional: true,
  description: 'List name, then the methods to try in order',
};

/**
 * Les cinq formes de la tete `aaa`, declarees au lieu d'etre avalees.
 *
 * Le gestionnaire glouton validait bien son PREMIER mot contre
 * `AAA_TOP_KEYWORDS`, puis finissait par un `return ''` que six formes
 * atteignaient : `aaa group`, `aaa group server`, `aaa group server
 * radius`, `aaa local`, `aaa local authentication attempts max-fail` —
 * toutes acceptees sans un mot. Et la SORTE d'un groupe etait choisie
 * par `args[2] === 'tacacs+' ? 'tacacs+' : 'radius'`, donc n'importe
 * quel mot declarait un groupe RADIUS : `aaa group server zorglub G1`
 * posait un groupe dont le protocole n'est pas celui qu'on a nomme.
 */
export function aaaHeadSpecs(ctx: () => AaaHeadHost): CommandSpec[] {
  const sec = () => ctx().security();

  const phase = (nom: AaaPhase): CommandSpec => {
    const [description, placeDescription] = PHASE_DESCRIPTIONS[nom];
    return {
      id: `aaa-${nom}`,
      path: ['aaa', nom, {
        name: 'service', type: 'ENUM', description: placeDescription,
        values: AAA_SERVICE_VALUES[nom],
      }, suiteDeMethodes],
      description,
      modes: MODES, minPrivilege: 15,
      run: (_s, args) =>
        ctx().parseMethodList(nom, [args.service, ...decoupe(args.reste)]),
      undo: (_s, args) => {
        const mots = decoupe(args.reste);
        const liste = mots[0]?.toLowerCase() === 'default' ? 'default' : mots[0];
        const config = sec();
        config.aaaMethods = config.aaaMethods.filter((m) =>
          !(m.phase === nom && m.service === args.service
            && (!liste || m.listName === liste)));
        return '';
      },
    };
  };

  return [
    {
      id: 'aaa-new-model',
      path: ['aaa', 'new-model'],
      description: 'Enable NEW access control commands and functions',
      modes: MODES, minPrivilege: 15,
      run: () => { sec().aaaNewModel = true; return ''; },
      undo: () => {
        const config = sec();
        config.aaaNewModel = false;
        config.aaaMethods.length = 0;
        return '';
      },
    },
    {
      id: 'aaa-session-id',
      path: ['aaa', 'session-id', {
        name: 'type', type: 'ENUM',
        description: 'AAA session ID behaviour',
        values: [
          { keyword: 'common', description: 'Use same session-id for all services' },
          { keyword: 'unique', description: 'Use unique session-id for each service' },
        ],
      }],
      description: 'AAA Session ID',
      modes: MODES, minPrivilege: 15,
      undoOmitsArguments: true,
      run: (_s, args) => { sec().aaaSessionId = args.type; return ''; },
      undo: () => { sec().aaaSessionId = undefined; return ''; },
    },
    {
      id: 'aaa-group-server',
      path: ['aaa', 'group', 'server', {
        name: 'sorte', type: 'ENUM', description: 'Server protocol',
        values: AAA_GROUP_KINDS,
      }, { name: 'nom', type: 'WORD', description: 'AAA server-group name' }],
      description: 'AAA server-group definitions',
      modes: MODES, minPrivilege: 15,
      enters: AAA_GROUP_MODE,
      run: (_s, args) => {
        const kind = args.sorte as 'radius' | 'tacacs+';
        const groupes = sec().aaaGroups;
        groupes.set(args.nom, groupes.get(args.nom)
          ?? { name: args.nom, kind, members: [] });
        ctx().selectAaaGroup(args.nom);
        return '';
      },
      undo: (_s, args) => { sec().aaaGroups.delete(args.nom); return ''; },
    },
    {
      id: 'aaa-local-max-fail',
      path: ['aaa', 'local', 'authentication', 'attempts', 'max-fail', {
        name: 'nombre', type: 'INT',
        description: 'Number of unsuccessful attempts before lockout',
      }],
      description: 'AAA local authentication parameters',
      modes: MODES, minPrivilege: 15,
      undoOmitsArguments: true,
      run: (_s, args) => {
        const n = Number(args.nombre);
        sec().localAuthMaxFailAttempts = n;
        ctx().setLocalAuthMaxFail(n);
        return '';
      },
      undo: () => { sec().localAuthMaxFailAttempts = undefined; return ''; },
    },
    phase('authentication'),
    phase('authorization'),
    phase('accounting'),
  ];
}
