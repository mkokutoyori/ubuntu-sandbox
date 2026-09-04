import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import { CliIncomplete, CliInvalidInput } from '../cli/CliDiagnostic';
import type {
  CiscoSecurityConfig, RadiusServer, TacacsServer,
} from '../../router/security/CiscoSecurityConfig';
import {
  newRadiusServerStats, newTacacsServerStats,
} from '../../router/security/CiscoSecurityConfig';

const MODES = ['config'] as const;

export const RADIUS_SERVER_MODE = 'config-radius-server';
export const TACACS_SERVER_MODE = 'config-tacacs-server';

/**
 * Les bornes des deux familles, declarees UNE fois.
 *
 * Elles l'etaient deux fois : `RADIUS_HOST_RANGES` les portait en
 * nombres pour la forme `host`, et `RADIUS_SERVER_CONTINUATIONS` les
 * reecrivait en chaines (`<1-1000>`) pour l'aide du trie. Deux ecritures
 * d'un meme fait, et c'est la seconde qui TRANCHAIT — le trie appliquait
 * la plage annoncee par les continuations — tandis que le gestionnaire
 * de la forme GLOBALE n'en lisait aucune : `radius-server timeout 99999`
 * passait, sur un reglage que la meme machine annonce `<1-1000>`.
 */
export const RADIUS_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  'auth-port': [0, 65535],
  'acct-port': [0, 65535],
  timeout: [1, 1000],
  retransmit: [0, 100],
};

export const TACACS_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  port: [1, 65535],
  timeout: [1, 1000],
};

const RADIUS_DEFAULTS = { authPort: 1645, acctPort: 1646, retransmit: 3, timeoutSec: 5 };
const TACACS_DEFAULTS = { port: 49, timeoutSec: 5 };

export interface AaaServerHost {
  security(): CiscoSecurityConfig;
  selectRadiusServer(name: string): void;
  selectTacacsServer(name: string): void;
}

const nom = (quoi: string): ArgumentSpec =>
  ({ name: 'nom', type: 'WORD', description: `Name of the ${quoi} server` });

const adresse = (quoi: string): ArgumentSpec =>
  ({ name: 'adresse', type: 'IP_ADDR', description: `IP address of the ${quoi} server` });

const cle: ArgumentSpec =
  { name: 'cle', type: 'REST', literal: 'LINE', description: 'The shared key itself' };

const cleGlobale: ArgumentSpec = { ...cle, optional: true };

/*
 * La valeur est declaree FACULTATIVE parce que la NEGATION s'en passe :
 * `no radius-server timeout` retablit le defaut sans nommer de valeur,
 * comme sur IOS. Le socle ne sait pas encore dire « exigee au positif,
 * facultative au negatif » — `undoRequiresArgument` porte la nuance
 * inverse et n'est lue que par l'aide — donc c'est le gestionnaire qui
 * refuse la forme positive nue, avec le meme `% Incomplete command.`
 * que la machine reelle. La PLAGE, elle, reste declaree et appliquee
 * par l'analyse des que la valeur est presente.
 */
const entier = (
  bornes: readonly [number, number], description: string,
): ArgumentSpec => ({
  name: 'valeur', type: 'INT', range: bornes, description, optional: true,
});

/**
 * Ce qui suit une adresse est un SAC D'OPTIONS, pas une suite.
 *
 * IOS les accepte dans n'importe quel ordre et au plus une fois
 * chacune, ce que le trie exprimait par des continuations lues par
 * l'aide et par une boucle ecrite a la main lue par l'analyse — deux
 * ecritures d'une meme grammaire. Le sac porte la regle une fois, donc
 * `?` apres l'adresse annonce exactement ce que l'analyse accepte, et
 * la borne de chaque option est celle que l'aide affiche.
 */
function optionsDeServeur(
  bornes: Readonly<Record<string, readonly [number, number]>>,
  descriptions: Readonly<Record<string, string>>,
): OptionSpec[] {
  const sac: OptionSpec[] = Object.keys(bornes).map((mot) => ({
    keyword: mot, description: descriptions[mot],
    argument: {
      name: mot, type: 'INT', range: bornes[mot],
      description: mot.endsWith('port') ? 'Port number'
        : mot === 'timeout' ? 'Wait time in seconds' : 'Number of retries',
    } as ArgumentSpec,
  }));
  sac.push({ keyword: 'key', description: 'Per-server encryption key', argument: cle });
  return sac;
}

const RADIUS_OPTIONS = optionsDeServeur(RADIUS_RANGES, {
  'auth-port': 'UDP port for RADIUS authentication server',
  'acct-port': 'UDP port for RADIUS accounting server',
  timeout: 'Time to wait for a RADIUS server to reply',
  retransmit: 'Number of retries to an active server',
});

const TACACS_OPTIONS = optionsDeServeur(TACACS_RANGES, {
  port: 'TCP port the server listens on',
  timeout: 'Time to wait for a TACACS+ server to reply',
});

/**
 * `radius-server`, `tacacs-server`, `radius server` et `tacacs server`
 * declares au lieu d'etre avales.
 *
 * Les quatre tetes etaient GLOUTONNES, et les quatre finissaient par un
 * `return ''` : `radius zorglub`, `radius server` sans nom,
 * `radius-server zorglub` et `no tacacs-server zorglub` etaient donc
 * acceptes EN SILENCE — l'operateur croyait avoir declare un serveur et
 * n'avait rien declare, sur la famille dont c'est justement le defaut le
 * plus couteux, puisqu'une authentification qui ne trouve pas son
 * serveur echoue sans dire pourquoi.
 *
 * Ce que la declaration apporte, et que le gestionnaire ne pouvait pas
 * porter : le nom du serveur est EXIGE, chaque reglage global porte sa
 * plage — donc `radius-server timeout 1001` est refuse par la meme
 * declaration qui l'annonce — et un mot de trop ne se perd plus.
 */
export function aaaServerSpecs(ctx: () => AaaServerHost): CommandSpec[] {
  const radius = (): Map<string, RadiusServer> => ctx().security().radiusServers;
  const tacacs = (): Map<string, TacacsServer> => ctx().security().tacacsServers;

  const globalRadius = (
    id: string, mot: string, bornes: readonly [number, number],
    description: string, valeurDescription: string,
    pose: (n: number) => void, defait: () => void,
  ): CommandSpec => ({
    id, path: ['radius-server', mot, entier(bornes, valeurDescription)],
    description, modes: MODES, minPrivilege: 15,
    run: (_s, args) => {
      if (args.valeur === undefined) throw new CliIncomplete();
      pose(Number(args.valeur));
      return '';
    },
    undo: () => { defait(); return ''; },
  });

  const globalTacacs = (
    id: string, mot: string, bornes: readonly [number, number],
    description: string, valeurDescription: string,
    pose: (n: number) => void, defait: () => void,
  ): CommandSpec => ({
    id, path: ['tacacs-server', mot, entier(bornes, valeurDescription)],
    description, modes: MODES, minPrivilege: 15,
    run: (_s, args) => {
      if (args.valeur === undefined) throw new CliIncomplete();
      pose(Number(args.valeur));
      return '';
    },
    undo: () => { defait(); return ''; },
  });

  return [
    {
      id: 'radius-server-named',
      path: ['radius', 'server', nom('RADIUS')],
      description: 'RADIUS server configuration',
      undoDescription: 'Remove a named RADIUS server',
      modes: MODES, minPrivilege: 15,
      enters: RADIUS_SERVER_MODE,
      run: (_s, args) => {
        const nomServeur = args.nom;
        const existant = radius().get(nomServeur);
        radius().set(nomServeur, existant ?? {
          name: nomServeur, ...RADIUS_DEFAULTS, stats: newRadiusServerStats(),
        });
        ctx().selectRadiusServer(nomServeur);
        return '';
      },
      undo: (_s, args) => { radius().delete(args.nom); return ''; },
    },
    {
      id: 'tacacs-server-named',
      path: ['tacacs', 'server', nom('TACACS+')],
      description: 'TACACS+ server configuration',
      undoDescription: 'Remove a named TACACS+ server',
      modes: MODES, minPrivilege: 15,
      enters: TACACS_SERVER_MODE,
      run: (_s, args) => {
        const nomServeur = args.nom;
        const existant = tacacs().get(nomServeur);
        tacacs().set(nomServeur, existant ?? {
          name: nomServeur, ...TACACS_DEFAULTS, singleConnection: false,
          stats: newTacacsServerStats(),
        });
        ctx().selectTacacsServer(nomServeur);
        return '';
      },
      undo: (_s, args) => { tacacs().delete(args.nom); return ''; },
    },
    {
      id: 'radius-server-host',
      path: ['radius-server', 'host', adresse('RADIUS')],
      description: 'Specify a RADIUS server',
      modes: MODES, minPrivilege: 15,
      options: RADIUS_OPTIONS,
      run: (_s, args) => {
        const hote = args.adresse;
        const nombre = (mot: string): number | undefined =>
          args[mot] === undefined ? undefined : Number(args[mot]);
        const existant = radius().get(hote);
        if (existant) {
          existant.key = args.cle ?? existant.key;
          existant.authPort = nombre('auth-port');
          existant.acctPort = nombre('acct-port');
          existant.timeoutSec = nombre('timeout') ?? existant.timeoutSec;
          existant.retransmit = nombre('retransmit') ?? existant.retransmit;
          return '';
        }
        radius().set(hote, {
          name: hote, address: hote, key: args.cle,
          authPort: nombre('auth-port'), acctPort: nombre('acct-port'),
          timeoutSec: nombre('timeout'), retransmit: nombre('retransmit'),
          legacySpelling: true, stats: newRadiusServerStats(),
        });
        return '';
      },
      undo: (_s, args) => { radius().delete(args.adresse); return ''; },
    },
    {
      id: 'tacacs-server-host',
      path: ['tacacs-server', 'host', adresse('TACACS+')],
      description: 'Specify a TACACS+ server',
      modes: MODES, minPrivilege: 15,
      options: TACACS_OPTIONS,
      run: (_s, args) => {
        const hote = args.adresse;
        const nombre = (mot: string): number | undefined =>
          args[mot] === undefined ? undefined : Number(args[mot]);
        const existant = tacacs().get(hote);
        if (existant) {
          existant.key = args.cle ?? existant.key;
          existant.port = nombre('port');
          existant.timeoutSec = nombre('timeout') ?? existant.timeoutSec;
          return '';
        }
        tacacs().set(hote, {
          name: hote, address: hote, key: args.cle,
          port: nombre('port'), timeoutSec: nombre('timeout'),
          singleConnection: false, legacySpelling: true,
          stats: newTacacsServerStats(),
        });
        return '';
      },
      undo: (_s, args) => { tacacs().delete(args.adresse); return ''; },
    },
    {
      id: 'radius-server-key',
      path: ['radius-server', 'key', cleGlobale],
      description: 'Encryption key shared with the RADIUS servers',
      modes: MODES, minPrivilege: 15,
      run: (_s, args) => {
        if (args.cle === undefined) throw new CliIncomplete();
        ctx().security().radiusDefaults.key = args.cle;
        return '';
      },
      undo: () => { ctx().security().radiusDefaults.key = undefined; return ''; },
    },
    {
      id: 'tacacs-server-key',
      path: ['tacacs-server', 'key', cleGlobale],
      description: 'Encryption key shared with the TACACS+ servers',
      modes: MODES, minPrivilege: 15,
      run: (_s, args) => {
        if (args.cle === undefined) throw new CliIncomplete();
        ctx().security().tacacsDefaults.key = args.cle;
        return '';
      },
      undo: () => { ctx().security().tacacsDefaults.key = undefined; return ''; },
    },
    globalRadius('radius-server-timeout', 'timeout', RADIUS_RANGES.timeout,
      'Time to wait for a RADIUS server to reply', 'Wait time in seconds',
      (n) => { ctx().security().radiusDefaults.timeoutSec = n; },
      () => { ctx().security().radiusDefaults.timeoutSec = undefined; }),
    globalRadius('radius-server-retransmit', 'retransmit', RADIUS_RANGES.retransmit,
      'Number of retries to an active server', 'Number of retries',
      (n) => { ctx().security().radiusDefaults.retransmit = n; },
      () => { ctx().security().radiusDefaults.retransmit = undefined; }),
    globalRadius('radius-server-auth-port', 'auth-port', RADIUS_RANGES['auth-port'],
      'UDP port for RADIUS authentication server', 'Port number',
      (n) => { ctx().security().radiusDefaults.authPort = n; },
      () => { ctx().security().radiusDefaults.authPort = undefined; }),
    globalRadius('radius-server-acct-port', 'acct-port', RADIUS_RANGES['acct-port'],
      'UDP port for RADIUS accounting server', 'Port number',
      (n) => { ctx().security().radiusDefaults.acctPort = n; },
      () => { ctx().security().radiusDefaults.acctPort = undefined; }),
    globalTacacs('tacacs-server-timeout', 'timeout', TACACS_RANGES.timeout,
      'Time to wait for a TACACS+ server to reply', 'Wait time in seconds',
      (n) => { ctx().security().tacacsDefaults.timeoutSec = n; },
      () => { ctx().security().tacacsDefaults.timeoutSec = undefined; }),
    globalTacacs('tacacs-server-port', 'port', TACACS_RANGES.port,
      'TCP port the TACACS+ servers listen on', 'Port number',
      (n) => { ctx().security().tacacsDefaults.port = n; },
      () => { ctx().security().tacacsDefaults.port = undefined; }),
  ];
}
