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

/**
 * Le nom de la liste, puis les methodes — DEUX places et non une.
 *
 * Une seule place `REST` prenait toute la fin de la ligne, donc
 * `aaa authentication login ?` annoncait `<cr>` pour une frappe que
 * `parseAaaMethod` declare incomplete : il exige un nom de liste ET au
 * moins une methode. Les separer fait plus que corriger l'annonce, elle
 * ouvre le rang ou vivent les mots-cles de la comptabilite
 * (`start-stop`, `stop-only`…), qu'une place gloutonne avalait.
 *
 * La suite est EXIGEE, et la forme qui s'arrete au nom de la liste est
 * declaree a part, comme n'existant QUE niee. La rendre facultative
 * aurait pose la commande au rang du nom de liste, donc rendu son `<cr>`
 * a `aaa authentication login default ?` pour une frappe que la machine
 * declare incomplete — le meme defaut deplace d'un rang.
 */
const NOM_DE_LISTE: ArgumentSpec = {
  name: 'liste', type: 'WORD', description: 'Named method list, or `default`',
  alternatives: [
    { keyword: 'default', description: 'The default method list' },
    { keyword: 'WORD', description: 'Name of a method list' },
  ],
};

const METHODES: ArgumentSpec = {
  name: 'methodes', type: 'REST', literal: 'LINE',
  description: 'Methods to try, in order',
};

const NIVEAU_DE_COMMANDE: ArgumentSpec = {
  name: 'niveau', type: 'INT', range: [0, 15],
  description: 'Enable level of the commands concerned',
};

/**
 * Ce qu'IOS ecrit entre la liste et les methodes, en comptabilite seule.
 *
 * Ce sont des MOTS-CLES : declares comme une valeur possible de la suite,
 * ils la remplissaient — `aaa accounting exec default start-stop ?`
 * annoncait alors `<cr>` alors qu'il manque encore les methodes.
 */
const TYPES_D_ENREGISTREMENT: ReadonlyArray<readonly [string, string]> = [
  ['none', 'No accounting'],
  ['start-stop', 'Record start and stop without waiting'],
  ['stop-only', 'Record stop when service terminates'],
  ['wait-start', 'Same as start-stop but wait for start-record commit'],
];

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

  const oublier = (nom: AaaPhase, service: string, mots: readonly string[]): string => {
    const liste = mots[0]?.toLowerCase() === 'default' ? 'default' : mots[0];
    const config = sec();
    config.aaaMethods = config.aaaMethods.filter((m) =>
      !(m.phase === nom && m.service === service && (!liste || m.listName === liste)));
    return '';
  };

  const phase = (nom: AaaPhase): CommandSpec => {
    const [description, placeDescription] = PHASE_DESCRIPTIONS[nom];
    return {
      id: `aaa-${nom}`,
      path: ['aaa', nom, {
        name: 'service', type: 'ENUM', description: placeDescription,
        values: AAA_SERVICE_VALUES[nom].filter((v) => v.keyword !== 'commands'),
      }, NOM_DE_LISTE, METHODES],
      description,
      modes: MODES, minPrivilege: 15,
      run: (_s, args) =>
        ctx().parseMethodList(nom, [args.service, args.liste, ...decoupe(args.methodes)]),
      undo: (_s, args) => oublier(nom, args.service, [args.liste]),
    };
  };

  /*
   * `commands` prend un NIVEAU avant le nom de la liste, et les autres
   * services non. Une place unique ne sait pas le dire : declare avec
   * les autres, `aaa authorization commands 15 ?` promettait `<cr>` a un
   * rang ou il manque encore les methodes. Le service devient donc un
   * mot-cle avec sa propre suite — et il quitte les valeurs de la place,
   * sans quoi `?` l'annoncerait deux fois.
   */
  const commandes = (nom: AaaPhase): CommandSpec => ({
    id: `aaa-${nom}-commands`,
    path: ['aaa', nom, 'commands', NIVEAU_DE_COMMANDE, NOM_DE_LISTE, METHODES],
    description: 'For exec (shell) commands',
    modes: MODES, minPrivilege: 15,
    run: (_s, args) => ctx().parseMethodList(
      nom, ['commands', args.niveau, args.liste, ...decoupe(args.methodes)]),
    undo: (_s, args) => oublier(nom, 'commands', [args.liste]),
  });

  /**
   * La forme qui s'arrete au nom de la liste : elle n'existe que NIEE.
   *
   * `no aaa authentication login default` se tape sans les methodes —
   * on retire une liste, on ne la redecrit pas — tandis que la forme
   * positive les exige. Le socle porte deja cette notion, et c'est elle
   * qui permet d'EXIGER les methodes sans casser la negation.
   */
  const seulementNiee = (
    id: string, chemin: CommandSpec['path'], nom: AaaPhase, service: string,
    description: string,
  ): CommandSpec => ({
    id,
    path: chemin,
    description,
    modes: MODES, minPrivilege: 15,
    existsOnlyNegated: true,
    run: () => '% Incomplete command.',
    undo: (_s, args) => oublier(nom, service === '' ? args.service : service, [args.liste]),
  });

  const enregistrement = (mot: string, description: string): CommandSpec[] => [{
    id: `aaa-accounting-${mot}`,
    path: ['aaa', 'accounting', {
      name: 'service', type: 'ENUM',
      description: PHASE_DESCRIPTIONS.accounting[1],
      values: AAA_SERVICE_VALUES.accounting.filter((v) => v.keyword !== 'commands'),
    }, NOM_DE_LISTE, mot, METHODES],
    description,
    modes: MODES, minPrivilege: 15,
    run: (_s, args) => ctx().parseMethodList(
      'accounting', [args.service, args.liste, mot, ...decoupe(args.methodes)]),
    undo: (_s, args) => oublier('accounting', args.service, [args.liste]),
  }, {
    id: `aaa-accounting-commands-${mot}`,
    path: ['aaa', 'accounting', 'commands', NIVEAU_DE_COMMANDE, NOM_DE_LISTE,
      mot, METHODES],
    description,
    modes: MODES, minPrivilege: 15,
    run: (_s, args) => ctx().parseMethodList(
      'accounting', ['commands', args.niveau, args.liste, mot,
        ...decoupe(args.methodes)]),
    undo: (_s, args) => oublier('accounting', 'commands', [args.liste]),
  }];

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
    commandes('authorization'),
    commandes('accounting'),
    ...TYPES_D_ENREGISTREMENT.flatMap(([mot, description]) =>
      enregistrement(mot, description)),
    ...(['authentication', 'authorization', 'accounting'] as AaaPhase[]).map((nom) =>
      seulementNiee(`no-aaa-${nom}`, ['aaa', nom, {
        name: 'service', type: 'ENUM', description: PHASE_DESCRIPTIONS[nom][1],
        values: AAA_SERVICE_VALUES[nom].filter((v) => v.keyword !== 'commands'),
      }, NOM_DE_LISTE], nom, '', PHASE_DESCRIPTIONS[nom][0])),
    ...(['authorization', 'accounting'] as AaaPhase[]).map((nom) =>
      seulementNiee(`no-aaa-${nom}-commands`,
        ['aaa', nom, 'commands', NIVEAU_DE_COMMANDE, NOM_DE_LISTE], nom, 'commands',
        'For exec (shell) commands')),
  ];
}
