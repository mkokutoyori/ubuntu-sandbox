import { routerRsaKey } from '../../../ipsec/RouterRsaKey';
import { encodeRsaPublicKey, groupedHex } from '../../../ipsec/RsaPublicKeyDer';

import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';
import { showIpTraffic } from './CiscoCommonShow';
import {
  CiscoSecurityConfig,
  newTacacsServerStats,
  tacacsServerPort,
  type AaaServiceKind,
  type AaaPhase,
} from '../../router/security/CiscoSecurityConfig';
import type { CiscoShellContext, CiscoShellMode } from './CiscoConfigCommands';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec, EnumValue } from '@/cli/ArgumentTypes';
import type { OptionSpec } from '@/cli/OptionBag';
import {
  specsFromTrieRegistrations,
} from '@/cli/commands/trieAdapter';
import { CliInvalidInput, CliIncomplete } from '../cli/CliDiagnostic';
import {
  POLICY_MAP_ACTIONS, policyMapActionLine,
} from '../../router/security/policyMapActions';
import { isValidIPv4 } from '@/network/core/ip';
import { CISCO_ERRORS } from '../cli-utils';
import { encryptType7, md5Hex } from '@/crypto';
import { pad2 } from '@/lib/format';
import type { RevocationCheckMode } from '../../../pki/CertificateVerifier';
import { MODES_INTERFACE } from './CiscoConfigCommands';

const SECURITY_KEY = Symbol.for('CiscoSecurityConfig');

const USERNAME_KEYWORDS = new Set(['nohangup', 'nopassword', 'one-time']);

export const RSA_MODULUS_MIN = 360;
export const RSA_MODULUS_MAX = 4096;
export const RSA_MODULUS_DEFAUT = 1024;


interface UsernameValeur {
  keyword: string;
  description: string;
  valeur?: ReadonlyArray<{ keyword: string; description: string }>;
}

export const USERNAME_CONTINUATIONS: ReadonlyArray<{
  keyword: string; description: string; valeur?: ReadonlyArray<UsernameValeur>;
}> = [
  {
    keyword: 'access-class', description: 'Restrict access by access-class',
    valeur: [{ keyword: '<1-199>', description: 'Access-list number' }],
  },
  {
    keyword: 'algorithm-type', description: 'Algorithm used to hash the password',
    valeur: [
      { keyword: 'md5', description: 'Select MD5 as the hashing algorithm' },
      { keyword: 'scrypt', description: 'Select scrypt as the hashing algorithm' },
      { keyword: 'sha256', description: 'Select PBKDF2 with SHA-256 as the hashing algorithm' },
    ],
  },
  {
    keyword: 'autocommand',
    description: 'Automatically issue a command after the user logs in',
    valeur: [{ keyword: 'LINE', description: 'The command to issue' }],
  },
  {
    keyword: 'description', description: 'Description of the user',
    valeur: [{ keyword: 'LINE', description: 'Text describing the user' }],
  },
  { keyword: 'nohangup', description: 'Do not disconnect after an automatic command' },
  { keyword: 'nopassword', description: 'No password is required for this user' },
  { keyword: 'one-time', description: 'Specify a one-time user name' },
  {
    keyword: 'password', description: 'Specify the password for the user',
    valeur: [
      {
        keyword: '0', description: 'Specifies an UNENCRYPTED password will follow',
        valeur: [{ keyword: 'LINE', description: 'The password itself' }],
      },
      {
        keyword: '7', description: 'Specifies a HIDDEN password will follow',
        valeur: [{ keyword: 'LINE', description: 'The password itself' }],
      },
      { keyword: 'LINE', description: 'The UNENCRYPTED (cleartext) user password' },
    ],
  },
  {
    keyword: 'privilege', description: 'Set the privilege level for the user',
    valeur: [{ keyword: '<0-15>', description: 'User privilege level' }],
  },
  {
    keyword: 'secret', description: 'Specify the secret for the user',
    valeur: [
      {
        keyword: '0', description: 'Specifies an UNENCRYPTED secret will follow',
        valeur: [{ keyword: 'LINE', description: 'The secret itself' }],
      },
      {
        keyword: '5', description: 'Specifies a MD5 HASHED secret will follow',
        valeur: [{ keyword: 'LINE', description: 'The secret itself' }],
      },
      {
        keyword: '8', description: 'Specifies a PBKDF2 HASHED secret will follow',
        valeur: [{ keyword: 'LINE', description: 'The secret itself' }],
      },
      {
        keyword: '9', description: 'Specifies a SCRYPT HASHED secret will follow',
        valeur: [{ keyword: 'LINE', description: 'The secret itself' }],
      },
      { keyword: 'LINE', description: 'The UNENCRYPTED (cleartext) user secret' },
    ],
  },
  {
    keyword: 'user-maxlinks', description: 'Limit the number of connections for this user',
    valeur: [{ keyword: '<0-255>', description: 'Maximum number of connections' }],
  },
  {
    keyword: 'view', description: 'Set the view attached to the user',
    valeur: [{ keyword: 'WORD', description: 'Name of the view' }],
  },
];

/**
 * Ce que `aaa ?` peut légitimement proposer, et ce que le gestionnaire
 * accepte : une seule liste, donc l'aide et l'exécution ne peuvent pas
 * se contredire. Auparavant le gestionnaire finissait par `return ''`,
 * si bien que n'importe quelle forme était acceptée en silence.
 */

import { AAA_SERVICES, AAA_METHODS } from './aaaHeadSpecs';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';
export { AAA_METHODS };

export const AAA_COMMAND_LEVEL_RANGE: readonly [number, number] = [0, 15];

const AAA_GROUP_BUILTINS: ReadonlySet<string> = new Set(['radius', 'tacacs+']);

/**
 * Accepts any Cisco device (router or switch) — the config is stashed
 * under a private symbol key, so it works identically regardless of the
 * concrete device class; only CiscoShellBase's `enable secret`/`enable
 * password` handlers (shared across router and switch shells) rely on
 * the wider parameter type.
 */
export function getSecurityConfig(router: object): CiscoSecurityConfig {
  const r = router as unknown as Record<symbol, CiscoSecurityConfig>;
  if (!r[SECURITY_KEY]) r[SECURITY_KEY] = new CiscoSecurityConfig();
  return r[SECURITY_KEY];
}

export interface CiscoSecurityShellContext extends CiscoShellContext {
  setPkiTrustpoint?(name: string | null): void;
  getPkiTrustpoint?(): string | null;
  setClassMap?(name: string | null): void;
  getClassMap?(): string | null;
  setPolicyMap?(name: string | null): void;
  getPolicyMap?(): string | null;
  setPolicyClass?(name: string | null): void;
  getPolicyClass?(): string | null;
  setZone?(name: string | null): void;
  getZone?(): string | null;
  setZonePair?(name: string | null): void;
  getZonePair?(): string | null;
  setTimeRange?(name: string | null): void;
  getTimeRange?(): string | null;
  setControlPlane?(active: boolean): void;
  getControlPlane?(): boolean;
  setRadiusServer?(name: string | null): void;
  getRadiusServer?(): string | null;
  setTacacsServer?(name: string | null): void;
  getTacacsServer?(): string | null;
  setAaaGroup?(name: string | null): void;
  getAaaGroup?(): string | null;
}

/**
 * La famille IDENTITE : AAA, RADIUS, TACACS+ et la protection contre la
 * force brute.
 *
 * Elle etait ecrite DANS `buildSecurityConfigCommands`, que seul le
 * shell du routeur appelle — et cette fonction enregistre aussi des
 * choses qu'un Catalyst n'a pas (`zone security`, `class-map type
 * inspect`, `control-plane`). Un commutateur n'avait donc AUCUNE de ces
 * commandes : `aaa new-model`, `tacacs server`, `login block-for`,
 * `show tacacs`, `show login` tombaient toutes dans la resolution de nom
 * d'hote (`Translating "aaa"...`), alors qu'un vrai 2960 les connait
 * toutes. Extraite ici, elle est appelee par les deux shells sans leur
 * donner le reste.
 */
export function buildIdentityConfigCommands(
  trie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  trie.registerGreedy('service password-encryption', 'Enable password encryption', () => {
    sec().servicePasswordEncryption = true;
    const r = ctx.r() as unknown as {
      _setServiceFlag?: (n: string, on: boolean) => void;
      getEnablePassword?: () => { value: string; algo: 'plain' | 'type-7' } | null;
      _setEnablePassword?: (v: string, algo: 'plain' | 'type-7') => void;
      listEnablePasswordLevels?: () => ReadonlyArray<{ level: number; value: string; algo: 'plain' | 'type-7' }>;
      _setEnablePasswordForLevel?: (level: number, v: string, algo: 'plain' | 'type-7') => void;
      _listLocalUsers?: () => ReadonlyArray<{ name: string; privilege: number; secret: string; secretAlgo?: string }>;
      _upsertCiscoUsername?: (n: string, kv: { secret?: string; secretAlgo?: 'type-7' }) => void;
    };
    r._setServiceFlag?.('password-encryption', true);
    const encrypt = (value: string): string => {
      const salt = parseInt(md5Hex(`cisco-type7:${value}`).slice(0, 1), 16);
      return encryptType7(value, salt);
    };
    // Real IOS: turning `service password-encryption` ON retroactively
    // obfuscates every currently type-0 password already in the config —
    // enable password (every level), and every `username … password`
    // entry — not just newly-typed ones going forward.
    const ep = r.getEnablePassword?.();
    if (ep && ep.algo === 'plain') r._setEnablePassword?.(encrypt(ep.value), 'type-7');
    for (const e of r.listEnablePasswordLevels?.() ?? []) {
      if (e.algo === 'plain') r._setEnablePasswordForLevel?.(e.level, encrypt(e.value), 'type-7');
    }
    for (const u of r._listLocalUsers?.() ?? []) {
      if (u.secretAlgo === 'plain-password') {
        r._upsertCiscoUsername?.(u.name, { secret: encrypt(u.secret), secretAlgo: 'type-7' });
      }
    }
    return '';
  });

  // Sa negation vivait dans le fourre-tout glouton `no service`, qui
  // rangeait n'importe quel mot ; il a disparu avec lui, et la commande
  // qui l'ecrivait dans la configuration s'est tue. Elle est declaree ou
  // sa forme positive l'est, pour que les deux lisent le meme magasin.
  trie.register('no service password-encryption', 'Disable password encryption', () => {
    sec().servicePasswordEncryption = false;
    (ctx.r() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void })
      ._setServiceFlag?.('password-encryption', false);
    return '';
  });

}

export function buildSecurityConfigCommands(trie: CommandTrie, ctx: CiscoSecurityShellContext): void {
  const sec = () => getSecurityConfig(ctx.r());

  buildIdentityConfigCommands(trie, ctx);


  trie.registerGreedy('no ip cef', 'Disable CEF', () => { sec().ipCef = false; return ''; });
  trie.registerGreedy('ip multicast-routing', 'Enable IP multicast routing', () => {
    sec().ipMulticastRouting = true;
    return '';
  });
  trie.registerGreedy('no ip multicast-routing', 'Disable IP multicast routing', () => {
    sec().ipMulticastRouting = false;
    return '';
  });

  trie.register('control-plane', 'Enter control-plane', () => {
    ctx.setControlPlane?.(true);
    ctx.setMode('config-cp' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('parameter-map type inspect', 'Define parameter-map', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().ensureParameterMapInspect(args[0]);
    return '';
  });

}

export function mapRevocationCheck(mode: string | undefined): RevocationCheckMode {
  if (mode === 'ocsp') return 'ocsp';
  if (mode === 'crl' || mode === 'crl-or-ocsp' || mode === 'crl-then-ocsp') return 'crl-strict';
  return 'none';
}

export function parseAaaMethod(sec: CiscoSecurityConfig, phase: AaaPhase, args: string[]): string {
  // `aaa authentication` seul était ACCEPTÉ en silence : rien n'était
  // enregistré, rien n'apparaissait dans la running-config, et
  // l'opérateur croyait avoir configuré une méthode.
  if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
  if (!AAA_SERVICES[phase].includes(args[0].toLowerCase())) throw new CliInvalidInput({ token: args[0] });
  if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
  const service = args[0] as AaaServiceKind;
  let i = 1;
  let privilegeLevel: number | undefined;
  if (service === 'commands') {
    const brut = args[i];
    if (brut === undefined) return CISCO_ERRORS.INCOMPLETE;
    const [min, max] = AAA_COMMAND_LEVEL_RANGE;
    if (!/^\d+$/.test(brut) || Number(brut) < min || Number(brut) > max) {
      throw new CliInvalidInput({ token: brut });
    }
    privilegeLevel = Number(brut);
    i++;
  }
  const listName = args[i++];
  let recordType: 'start-stop' | 'stop-only' | 'wait-start' | 'none' | undefined;
  if (phase === 'accounting' && (args[i] === 'start-stop' || args[i] === 'stop-only' || args[i] === 'wait-start' || args[i] === 'none')) {
    recordType = args[i] as 'start-stop' | 'stop-only' | 'wait-start' | 'none';
    i++;
  }
  const methods = args.slice(i);
  if (methods.length === 0 && recordType !== 'none') return CISCO_ERRORS.INCOMPLETE;
  const incomplet = verifierMethodesAaa(phase, methods);
  if (incomplet) return incomplet;
  sec.aaaMethods.push({ phase, service, listName, privilegeLevel, recordType, methods });
  return '';
}

/**
 * Les methodes d'une phase, et rien d'autre.
 *
 * Chaque phase a SON jeu : il n'y a pas de `local` en comptabilite —
 * un enregistrement part vers un collecteur, il n'y a rien de local ou
 * l'ecrire — ni de `line` en autorisation. Une methode inventee est une
 * entree que rien ne sait appliquer, donc une liste qui n'authentifie
 * personne la ou l'operateur croit avoir pose un repli.
 */
function verifierMethodesAaa(phase: AaaPhase, methods: readonly string[]): string | null {
  const permis = AAA_METHODS[phase];
  for (let k = 0; k < methods.length; k++) {
    const mot = methods[k].toLowerCase();
    if (!permis.includes(mot)) throw new CliInvalidInput({ token: methods[k] });
    if (mot !== 'group') continue;
    const nom = methods[k + 1];
    if (nom === undefined) return CISCO_ERRORS.INCOMPLETE;
    if (!AAA_GROUP_BUILTINS.has(nom.toLowerCase()) && permis.includes(nom.toLowerCase())) {
      return CISCO_ERRORS.INCOMPLETE;
    }
    k++;
  }
  return null;
}

export function buildSecuritySubmodeCommands(
  pmapClassTrie: CommandTrie,
  ctx: CiscoSecurityShellContext,
): void {
  buildPolicyClassSubmodeOn(pmapClassTrie, ctx);
}

const CMAP_ACL_MIN = 1;
const CMAP_ACL_MAX = 2799;

export function buildPolicyClassSubmodeOn(
  pmapClassTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  for (const spec of POLICY_MAP_ACTIONS) {
    const apply = (args: string[]): string => {
      const problem = spec.problem?.(args) ?? null;
      if (problem?.incomplete) throw new CliIncomplete();
      if (problem) throw new CliInvalidInput({ token: args[problem.at] });

      addAction(ctx, spec.kind, args);
      return '';
    };
    if (spec.greedy) pmapClassTrie.registerGreedy(spec.words, spec.description, apply);
    else pmapClassTrie.register(spec.words, spec.description, () => apply([]));
  }
}

const REVOCATION_MODES: readonly EnumValue[] = [
  { keyword: 'crl', description: 'Certificate revocation list' },
  { keyword: 'crl-or-ocsp', description: 'Try the CRL, then OCSP' },
  { keyword: 'crl-then-ocsp', description: 'Try the CRL, then OCSP' },
  { keyword: 'none', description: 'Do not check the revocation status' },
  { keyword: 'ocsp', description: 'Online Certificate Status Protocol' },
];

function place(
  name: string, type: ArgumentSpec['type'], description: string,
  extra: Partial<ArgumentSpec> = {},
): ArgumentSpec {
  return { name, type, description, ...extra };
}

function formes(
  name: string, description: string, alternatives: readonly EnumValue[],
): ArgumentSpec {
  return { name, type: 'REST', description, alternatives };
}


/**
 * Ce que la configuration globale de securite confie au socle.
 *
 * La liste est NOMMEE plutot que devinee par un prefixe : ce
 * constructeur porte une trentaine de familles aux grammaires tres
 * inegales, et un filtre large y emmenerait des gloutons dont la place
 * n'est pas encore decrite. On y ajoute une famille quand elle est
 * prete, et la liste dit ou en est la migration.
 *
 * `ip multicast-routing` y entre pour une raison de plus que le but :
 * enregistre GLOUTON alors qu'il ne lit aucun argument, il acceptait
 * `ip multicast-routing zorglub` sans rien en faire.
 */
const SECURITE_AU_SOCLE: ReadonlySet<string> = new Set([
  'control-plane',
  'ip multicast-routing',
  'no ip multicast-routing',
  'parameter-map type inspect',
]);

const PLACES_SECURITE_GLOBALE:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'control-plane': null,
  'ip multicast-routing': null,
  'no ip multicast-routing': null,
  'parameter-map type inspect': {
    name: 'nom', type: 'WORD', description: 'Name of the parameter map',
  },
};

export function securityGlobalSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildSecurityConfigCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      skip: (path) => !SECURITE_AU_SOCLE.has(path),
      argumentFor: (path) => PLACES_SECURITE_GLOBALE[path],
    },
  );
}

export function classMapSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  const base = { modes: ['config-cmap'], minPrivilege: 15 };
  const classMap = () => {
    const name = ctx.getClassMap?.();
    return name ? getSecurityConfig(ctx.r()).classMaps.get(name) : undefined;
  };
  const match = (
    id: string, path: ReadonlyArray<string | ArgumentSpec>, description: string,
    record: (args: Record<string, string>) => { kind: string; value?: string },
  ): CommandSpec => ({
    ...base, id, path: [...path], description,
    run: (_session, args) => {
      const entry = classMap();
      if (entry) (entry.matches as Array<{ kind: string; value?: string }>).push(record(args));
      return '';
    },
  });
  return [
    match('cmap-match-access-group-name',
      ['match', 'access-group', 'name', place('name', 'WORD', 'Named access list')],
      'Named access list',
      (args) => ({ kind: 'access-group-name', value: args.name })),
    match('cmap-match-access-group-number',
      ['match', 'access-group', place('number', 'INT', 'Access list index',
        { range: [CMAP_ACL_MIN, CMAP_ACL_MAX] })],
      'Access list index',
      (args) => ({ kind: 'access-group-num', value: args.number })),
    match('cmap-match-protocol',
      ['match', 'protocol', place('protocol', 'WORD', 'Protocol name')],
      'Protocol', (args) => ({ kind: 'protocol', value: args.protocol })),
    match('cmap-match-any', ['match', 'any'], 'Any packets', () => ({ kind: 'any' })),
  ];
}

export function policyMapSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  const base = { modes: ['config-pmap'], minPrivilege: 15 };
  const enter = (className: string, kind: 'class-default' | 'named' | 'inspect'): string => {
    const name = ctx.getPolicyMap?.();
    const policy = name ? getSecurityConfig(ctx.r()).policyMaps.get(name) : undefined;
    if (!policy) return '';
    if (!policy.classes.find((c) => c.className === className)) {
      policy.classes.push({ className, kind, actions: [] });
    }
    ctx.setPolicyClass?.(className);
    ctx.setMode('config-pmap-c' as CiscoShellMode);
    return '';
  };
  return [
    {
      ...base, id: 'pmap-class-default', path: ['class', 'class-default'],
      description: 'System default class matching otherwise unclassified packets',
      run: () => enter('class-default', 'class-default'),
    },
    {
      ...base, id: 'pmap-class-type-inspect',
      path: ['class', 'type', 'inspect', place('class', 'WORD', 'class-map name')],
      description: 'policy-map class type',
      run: (_session, args) => enter(args.class, 'inspect'),
    },
    {
      ...base, id: 'pmap-class',
      path: ['class', place('class', 'WORD', 'class-map name')],
      description: 'Class for policy',
      run: (_session, args) => enter(args.class, 'named'),
    },
  ];
}

/**
 * Les places d'une action de classe.
 *
 * Aucune n'est bornee, et c'est mesure plutot que neglige : la
 * documentation de Cisco ecrit elle-meme que le debit d'un `police` ou
 * d'un `shape` est exprime en bits par seconde « sauf si la syntaxe
 * propre a la plateforme en decide autrement ». Annoncer une plage
 * decrirait une plateforme et pas cette commande.
 */
const PMAP_CLASS_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  police: place('debit', 'REST', 'Committed information rate in bits per second'),
  drop: place('option', 'ENUM', 'Log the dropped packets', {
    optional: true, values: [{ keyword: 'log', description: 'Log dropped packets' }],
  }),
  pass: place('option', 'ENUM', 'Log the passed packets', {
    optional: true, values: [{ keyword: 'log', description: 'Log passed packets' }],
  }),
  inspect: place('parametres', 'WORD', 'Parameter map applied to the inspection', { optional: true }),
  'set dscp': place('valeur', 'INT', 'Differentiated services codepoint value', {
    range: [0, 63],
    values: [
      { keyword: 'default', description: 'Match packets with default dscp (000000)' },
      { keyword: 'ef', description: 'Match packets with EF dscp (101110)' },
      { keyword: 'af11', description: 'Match packets with AF11 dscp (001010)' },
      { keyword: 'af12', description: 'Match packets with AF12 dscp (001100)' },
      { keyword: 'af13', description: 'Match packets with AF13 dscp (001110)' },
      { keyword: 'af21', description: 'Match packets with AF21 dscp (010010)' },
      { keyword: 'af22', description: 'Match packets with AF22 dscp (010100)' },
      { keyword: 'af23', description: 'Match packets with AF23 dscp (010110)' },
      { keyword: 'af31', description: 'Match packets with AF31 dscp (011010)' },
      { keyword: 'af32', description: 'Match packets with AF32 dscp (011100)' },
      { keyword: 'af33', description: 'Match packets with AF33 dscp (011110)' },
      { keyword: 'af41', description: 'Match packets with AF41 dscp (100010)' },
      { keyword: 'af42', description: 'Match packets with AF42 dscp (100100)' },
      { keyword: 'af43', description: 'Match packets with AF43 dscp (100110)' },
      { keyword: 'cs1', description: 'Match packets with CS1 (precedence 1) dscp (001000)' },
      { keyword: 'cs2', description: 'Match packets with CS2 (precedence 2) dscp (010000)' },
      { keyword: 'cs3', description: 'Match packets with CS3 (precedence 3) dscp (011000)' },
      { keyword: 'cs4', description: 'Match packets with CS4 (precedence 4) dscp (100000)' },
      { keyword: 'cs5', description: 'Match packets with CS5 (precedence 5) dscp (101000)' },
      { keyword: 'cs6', description: 'Match packets with CS6 (precedence 6) dscp (110000)' },
      { keyword: 'cs7', description: 'Match packets with CS7 (precedence 7) dscp (111000)' },
    ],
  }),
  'set precedence': place('valeur', 'INT', 'IP precedence value', {
    range: [0, 7],
    values: [
      { keyword: 'routine', description: 'Match packets with routine precedence (0)' },
      { keyword: 'priority', description: 'Match packets with priority precedence (1)' },
      { keyword: 'immediate', description: 'Match packets with immediate precedence (2)' },
      { keyword: 'flash', description: 'Match packets with flash precedence (3)' },
      { keyword: 'flash-override', description: 'Match packets with flash override precedence (4)' },
      { keyword: 'critical', description: 'Match packets with critical precedence (5)' },
      { keyword: 'internet', description: 'Match packets with internetwork control precedence (6)' },
      { keyword: 'network', description: 'Match packets with network control precedence (7)' },
    ],
  }),
  priority: formes('debit', 'Reserved bandwidth for the priority queue', [
    { keyword: '<kbps>', description: 'Reserved bandwidth in kilobits per second' },
    { keyword: 'percent', description: 'Reserved bandwidth as a percentage' },
  ]),
  bandwidth: formes('debit', 'Reserved bandwidth for this class', [
    { keyword: '<kbps>', description: 'Reserved bandwidth in kilobits per second' },
    { keyword: 'percent', description: 'Reserved bandwidth as a percentage' },
    { keyword: 'remaining', description: 'Percentage of the remaining bandwidth' },
  ]),
  'random-detect': place('mode', 'REST', 'Weighted random early detection parameters'),
  shape: formes('mode', 'Traffic shaping parameters', [
    { keyword: 'average', description: 'Shape to the committed rate' },
    { keyword: 'peak', description: 'Shape to the peak rate' },
  ]),
  'service-policy': place('politique', 'WORD', 'Name of the nested policy map'),
  'queue-limit': place('paquets', 'REST', 'Maximum queue depth in packets'),
  compression: place('mode', 'REST', 'Header compression parameters'),
};

export function policyClassSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildPolicyClassSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-pmap-c'], minPrivilege: 15,
      argumentFor: (path) => PMAP_CLASS_ARGUMENTS[path],
    },
  );
}


export function controlPlaneSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  const base = { modes: ['config-cp'], minPrivilege: 15 };
  const direction = (
    keyword: 'input' | 'output', field: 'servicePolicyInput' | 'servicePolicyOutput',
  ): CommandSpec => ({
    ...base, id: `cp-service-policy-${keyword}`,
    path: ['service-policy', keyword, place('policy', 'WORD', 'Policy map name')],
    description: `Assign a policy map to the ${keyword} of the control plane`,
    run: (_session, args) => {
      getSecurityConfig(ctx.r()).controlPlane[field] = args.policy;
      return '';
    },
  });
  return [direction('input', 'servicePolicyInput'), direction('output', 'servicePolicyOutput')];
}

export function zoneSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return [{
    id: 'zone-description', modes: ['config-zone'], minPrivilege: 15,
    path: ['description', place('text', 'REST',
      'Up to 200 characters describing this zone', { literal: 'LINE' })],
    description: 'Zone description',
    run: (_session, args) => {
      const name = ctx.getZone?.();
      const zone = name ? getSecurityConfig(ctx.r()).zones.get(name) : undefined;
      if (zone) zone.description = args.text.trim();
      return '';
    },
  }];
}

export function zonePairSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return [{
    id: 'zone-pair-service-policy', modes: ['config-zone-pair'], minPrivilege: 15,
    path: ['service-policy', 'type', 'inspect',
      place('policy', 'WORD', 'Inspection policy map to apply')],
    description: 'Apply policy',
    run: (_session, args) => {
      const name = ctx.getZonePair?.();
      const pair = name ? getSecurityConfig(ctx.r()).zonePairs.get(name) : undefined;
      if (pair) pair.servicePolicy = args.policy;
      return '';
    },
  }];
}

export function radiusServerSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  const base = { modes: ['config-radius-server'], minPrivilege: 15 };
  const server = () => {
    const name = ctx.getRadiusServer?.();
    return name ? getSecurityConfig(ctx.r()).radiusServers.get(name) : undefined;
  };
  const portOption = (keyword: string, description: string): OptionSpec => ({
    keyword, description,
    argument: { name: keyword, type: 'INT', range: [1, 65535], description: 'Port number' },
  });
  return [
    {
      ...base, id: 'radius-server-address-ipv4',
      path: ['address', 'ipv4',
        place('address', 'IP_ADDR', 'IP address of the RADIUS server')],
      options: [
        portOption('auth-port', 'UDP port for RADIUS authentication server'),
        portOption('acct-port', 'UDP port for RADIUS accounting server'),
      ],
      description: 'IPv4 address of the RADIUS server',
      run: (_session, args) => {
        const entry = server();
        if (!entry) return '';
        entry.address = args.address;
        if (args['auth-port'] !== undefined) entry.authPort = Number(args['auth-port']);
        if (args['acct-port'] !== undefined) entry.acctPort = Number(args['acct-port']);
        return '';
      },
    },
    {
      ...base, id: 'radius-server-key',
      path: ['key', place('key', 'REST', 'The shared key itself', { literal: 'LINE' })],
      description: 'Radius key',
      run: (_session, args) => {
        const entry = server();
        if (entry) entry.key = args.key.trim();
        return '';
      },
    },
  ];
}

export function tacacsServerSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  const base = { modes: ['config-tacacs-server'], minPrivilege: 15 };
  const server = () => {
    const name = ctx.getTacacsServer?.();
    return name ? getSecurityConfig(ctx.r()).tacacsServers.get(name) : undefined;
  };
  return [
    {
      ...base, id: 'tacacs-server-address-ipv4',
      path: ['address', 'ipv4',
        place('address', 'IP_ADDR', 'IP address of the TACACS+ server')],
      description: 'IPv4 address of the TACACS+ server',
      run: (_session, args) => {
        const entry = server();
        if (entry) entry.address = args.address;
        return '';
      },
    },
    {
      ...base, id: 'tacacs-server-key',
      path: ['key', place('key', 'REST', 'The shared key itself', { literal: 'LINE' })],
      description: 'Tacacs key',
      run: (_session, args) => {
        const entry = server();
        if (entry) entry.key = args.key.trim();
        return '';
      },
    },
    {
      ...base, id: 'tacacs-server-port',
      path: ['port', place('port', 'INT', 'Port number', { range: [1, 65535] })],
      description: 'Tacacs port',
      run: (_session, args) => {
        const entry = server();
        if (entry) entry.port = Number(args.port);
        return '';
      },
    },
    {
      ...base, id: 'tacacs-server-timeout',
      path: ['timeout', place('seconds', 'INT', 'Wait time in seconds', { range: [1, 1000] })],
      description: 'Tacacs timeout',
      run: (_session, args) => {
        const entry = server();
        if (entry) entry.timeoutSec = Number(args.seconds);
        return '';
      },
    },
  ];
}

export function aaaGroupSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  const base = { modes: ['config-aaa-group'], minPrivilege: 15 };
  const group = () => {
    const name = ctx.getAaaGroup?.();
    return name ? getSecurityConfig(ctx.r()).aaaGroups.get(name) : undefined;
  };
  const member = (path: ReadonlyArray<string | ArgumentSpec>, id: string, description: string,
    placeName: string): CommandSpec => ({
    ...base, id, path: [...path], description, undoDescription: 'Remove server',
    run: (_session, args) => {
      const entry = group();
      if (entry && !entry.members.includes(args[placeName])) entry.members.push(args[placeName]);
      return '';
    },
    undo: (_session, args) => {
      const entry = group();
      const index = entry ? entry.members.indexOf(args[placeName]) : -1;
      if (entry && index >= 0) entry.members.splice(index, 1);
      return '';
    },
  });
  return [
    member(['server', 'name', place('name', 'WORD', 'Name of a server declared by `tacacs server`')],
      'aaa-group-server-name', 'Name of a server declared by `tacacs server`', 'name'),
    member(['server', place('address', 'IP_ADDR', 'Address of a server declared the legacy way')],
      'aaa-group-server-address', 'Address of a server declared the legacy way', 'address'),
  ];
}

export function trustpointSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  const base = { modes: ['config-ca-trustpoint'], minPrivilege: 15 };
  const trustpoint = () => {
    const name = ctx.getPkiTrustpoint?.();
    return name ? getSecurityConfig(ctx.r()).pkiTrustpoints.get(name) : undefined;
  };
  const setting = (
    id: string, path: ReadonlyArray<string | ArgumentSpec>, description: string,
    apply: (entry: NonNullable<ReturnType<typeof trustpoint>>, args: Record<string, string>) => void,
  ): CommandSpec => ({
    ...base, id, path: [...path], description,
    run: (_session, args) => {
      const entry = trustpoint();
      if (entry) apply(entry, args);
      return '';
    },
  });
  const forgetEnrollment = (entry: NonNullable<ReturnType<typeof trustpoint>>): void => {
    delete entry.enrollmentUrl;
    delete entry.enrollmentProfile;
    delete entry.source;
  };
  const selfSigned = (keyword: string): CommandSpec => setting(
    `trustpoint-enrollment-${keyword}`, ['enrollment', keyword],
    'Generate a self-signed certificate',
    (entry) => { forgetEnrollment(entry); entry.source = 'selfsigned'; });
  return [
    setting('trustpoint-enrollment-url',
      ['enrollment', 'url', place('url', 'WORD', 'The enrollment URL itself')],
      'Enrollment URL of the certification authority',
      (entry, args) => { forgetEnrollment(entry); entry.enrollmentUrl = args.url; }),
    setting('trustpoint-enrollment-profile',
      ['enrollment', 'profile', place('profile', 'WORD', 'Enrollment profile name')],
      'Name of an enrollment profile',
      (entry, args) => { forgetEnrollment(entry); entry.enrollmentProfile = args.profile; }),
    selfSigned('self-signed'),
    selfSigned('selfsigned'),
    setting('trustpoint-enrollment-terminal', ['enrollment', 'terminal'],
      'Cut and paste the certificate at the terminal',
      (entry) => { forgetEnrollment(entry); entry.source = 'terminal'; }),
    setting('trustpoint-subject-name',
      ['subject-name', place('subject', 'REST',
        'Distinguished name of the certificate subject', { literal: 'LINE' })],
      'Set subject name', (entry, args) => { entry.subjectName = args.subject.trim(); }),
    setting('trustpoint-revocation-check',
      ['revocation-check', place('method', 'ENUM', 'How to check the revocation status',
        { values: REVOCATION_MODES })],
      'Set revocation check method',
      (entry, args) => { entry.revocationCheck = args.method.toLowerCase() as typeof entry.revocationCheck; }),
    setting('trustpoint-rsakeypair',
      ['rsakeypair', place('key', 'WORD', 'Name of the RSA key pair to bind')],
      'Bind RSA keypair', (entry, args) => { entry.rsaKeypair = args.key; }),
    setting('trustpoint-fqdn',
      ['fqdn', place('name', 'WORD', 'Fully qualified domain name of the certificate',
        { alternatives: [
          { keyword: 'WORD', description: 'The domain name itself' },
          { keyword: 'none', description: 'Do not include a domain name' },
        ] })],
      'Set FQDN', (entry, args) => { entry.fqdn = args.name; }),
    setting('trustpoint-ip-address',
      ['ip-address', place('address', 'IP_ADDR', 'The address itself')],
      'Set IP', (entry, args) => { entry.ipAddress = args.address; }),
    setting('trustpoint-ip-address-none', ['ip-address', 'none'],
      'Do not include an IP address', (entry) => { entry.ipAddress = 'none'; }),
    setting('trustpoint-serial-number-none', ['serial-number', 'none'],
      'Do not include a serial number', (entry) => { entry.serialNumber = 'none'; }),
    {
      ...base, id: 'trustpoint-auto-enroll',
      path: ['auto-enroll', place('percent', 'INT',
        'Percentage of the certificate lifetime after which to re-enrol',
        { optional: true, range: [1, 100] })],
      options: [{
        keyword: 'regenerate', description: 'Generate a new key pair when re-enrolling',
      }],
      description: 'Auto-enrollment',
      run: (_session, args) => {
        const entry = trustpoint();
        if (entry) {
          entry.autoEnroll = {
            ...(args.percent !== undefined ? { percent: Number(args.percent) } : {}),
            ...(args.regenerate !== undefined ? { regenerate: true } : {}),
          };
        }
        return '';
      },
    },
    setting('trustpoint-fingerprint',
      ['fingerprint', place('fingerprint', 'REST',
        'Fingerprint the certificate must carry', { literal: 'LINE' })],
      'Set fingerprint', (entry, args) => { entry.fingerprint = args.fingerprint.trim(); }),
  ];
}


function addAction(
  ctx: CiscoSecurityShellContext,
  kind: import('../../router/security/CiscoSecurityConfig').PolicyMapAction['kind'],
  args: string[],
): void {
  const pname = ctx.getPolicyMap?.();
  const cname = ctx.getPolicyClass?.();
  if (!pname || !cname) return;
  const sec = getSecurityConfig(ctx.r());
  const pm = sec.policyMaps.get(pname);
  if (!pm) return;
  const cls = pm.classes.find(c => c.className === cname);
  if (!cls) return;
  cls.actions.push({ kind, args });
}

const SECURITY_IF_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'ip verify unicast': {
    name: 'mode', type: 'REST', description: 'Unicast reverse-path forwarding check',
    alternatives: [
      { keyword: 'reverse-path', description: 'Strict reverse-path check' },
      { keyword: 'source', description: 'Check the source, then `reachable-via`' },
    ],
  },
};

export function securityInterfaceSpecs(
  ctx: CiscoSecurityShellContext,
): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildSecurityInterfaceCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: MODES_INTERFACE, minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => SECURITY_IF_ARGUMENTS[path] ?? null,
    },
  );
}

export function buildSecurityInterfaceCommands(trie: CommandTrie, ctx: CiscoSecurityShellContext): void {
  const sec = () => getSecurityConfig(ctx.r());

  trie.registerGreedy('ip verify unicast', 'Configure uRPF', (args) => {
    const i = ctx.getSelectedInterface(); if (!i) return '';
    const aclOf = (word: string | undefined): string | undefined => {
      if (word === undefined) return undefined;
      const n = Number(word);
      const valid = /^\d+$/.test(word) && ((n >= 1 && n <= 199) || (n >= 1300 && n <= 2699));
      if (!valid) throw new CliInvalidInput({ token: word });
      return word;
    };
    if (args[0] === 'reverse-path') {
      if (args.length > 2) throw new CliInvalidInput({ token: args[2] });
      sec().ifaceFlags(i).urpf = { mode: 'strict', acl: aclOf(args[1]) };
      return '';
    }
    if (args[0] !== 'source') throw new CliInvalidInput({ token: args[0] ?? '' });
    if (args[1] !== 'reachable-via') {
      if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
      throw new CliInvalidInput({ token: args[1] });
    }
    if (args[2] === undefined) return CISCO_ERRORS.INCOMPLETE;
    if (args[2] !== 'any' && args[2] !== 'rx') throw new CliInvalidInput({ token: args[2] });
    const urpf: { mode: 'strict' | 'loose'; allowDefault?: boolean; allowSelfPing?: boolean; acl?: string } = {
      mode: args[2] === 'any' ? 'loose' : 'strict',
    };
    for (let k = 3; k < args.length; k++) {
      if (args[k] === 'allow-default' && urpf.allowDefault === undefined) urpf.allowDefault = true;
      else if (args[k] === 'allow-self-ping' && urpf.allowSelfPing === undefined) urpf.allowSelfPing = true;
      else if (k === args.length - 1 && urpf.acl === undefined) urpf.acl = aclOf(args[k]);
      else throw new CliInvalidInput({ token: args[k] });
    }
    sec().ifaceFlags(i).urpf = urpf;
    return '';
  });

  trie.registerGreedy('no ip verify unicast', 'Disable uRPF', () => {
    const i = ctx.getSelectedInterface(); if (!i) return '';
    delete sec().ifaceFlags(i).urpf;
    return '';
  });
}

/**
 * Les vues de la famille identite. Meme raison que
 * `buildIdentityConfigCommands` : elles vivaient dans le module de
 * securite du routeur, si bien qu'un Catalyst configure en TACACS+
 * n'avait ni `show tacacs` ni `show login` pour verifier ce qu'il
 * venait de poser.
 */
export interface IdentityShowView {
  readonly path: readonly string[];
  readonly description: string;
  readonly niveau: number;
  render(): string;
}

export function buildIdentityShowCommands(
  getDevice: () => object,
): IdentityShowView[] {
  const sec = () => getSecurityConfig(getDevice());

  const vues: IdentityShowView[] = [];
  const vue = (
    path: readonly string[], description: string, niveau: number, render: () => string,
  ): void => { vues.push({ path, description, niveau, render }); };

  vue(['show', 'aaa', 'local', 'user', 'lockout'],
    'Local users currently locked out', 1, () => {
    const lines = [
      'Local-user            Lock time            Unlock time',
      '-------------------------------------------------------------',
    ];
    for (const a of getDevice().getCredentialStore().list()) {
      if (!a.locked) continue;
      lines.push(`${padToWidth(a.name, 22)}${a.lockReason ?? 'locked'}`);
    }
    return lines.join('\n');
  });

  /*
   * `show accounting` — la vue qui dit combien d'enregistrements sont
   * REELLEMENT partis vers le collecteur. Elle repondait
   * `% Invalid input detected`, si bien que le controle A10 d'une liste
   * d'audit (« echecs = 0 ») ne portait sur rien.
   *
   * Le tutoriel ecrit `show aaa accounting` ; cette commande n'existe pas
   * sur un vrai IOS, et l'inventer pour coller au tutoriel apprendrait
   * une commande que la machine reelle refuse. C'est `show accounting`
   * qui est rendue, avec le tableau « Overall Accounting Traffic » du
   * vrai IOS.
   */
  vue(['show', 'accounting'], 'Display accounting records', 1, () => {
    const auth = (getDevice() as unknown as {
      getAaaAuthenticator?: () => { accountingTraffic: () => ReadonlyMap<string, { starts: number; stops: number; failed: number }> };
    }).getAaaAuthenticator?.();
    const trafic = auth?.accountingTraffic();
    const lines = ['Overall Accounting Traffic:', '                       Starts   Stops    Failed'];
    if (!trafic || trafic.size === 0) {
      lines.push('     (no accounting records)');
      return lines.join('\n');
    }
    for (const [service, c] of trafic) {
      lines.push(`     ${padToWidth(service, 18)}${padToWidth(String(c.starts), 6, 'right')}`
        + `${padToWidth(String(c.stops), 9, 'right')}${padToWidth(String(c.failed), 10, 'right')}`);
    }
    return lines.join('\n');
  });

  vue(['show', 'aaa', 'sessions'], 'Display AAA sessions', 1, () => {
    const reg = (getDevice() as unknown as { getSshSessionRegistry?: () =>{ list: () => readonly { id: string; user: string; fromIp: string; line: string; loginAt: number }[]; history: () => readonly { id: string }[] } }).getSshSessionRegistry?.();
    if (!reg) return 'Total sessions since last reload: 0';
    const active = reg.list();
    const past = reg.history();
    const lines = [`Total sessions since last reload: ${active.length + past.length}`];
    if (active.length > 0) {
      lines.push('Session-Id Unique Id User       IP Address    Session Type');
      for (const s of active) lines.push(`${padToWidth(s.id, 11)}1          ${padToWidth(s.user, 11)}${padToWidth(s.fromIp, 14)}${s.line}`);
    }
    return lines.join('\n');
  });

  vue(['show', 'tacacs'], 'Display TACACS', 1, () => {
    const s = sec();
    const auth = (getDevice() as unknown as {
      getAaaAuthenticator?: () => { failedAccounting: () => number };
    }).getAaaAuthenticator?.();
    const lines: string[] = [];
    for (const t of s.tacacsServers.values()) {
      const st = t.stats;
      lines.push(`Tacacs+ Server : ${t.address ?? t.name}/${tacacsServerPort(t, s.tacacsDefaults)}`);
      lines.push(`Socket opens: ${st.socketOpens}, closes: ${st.socketCloses}`);
      lines.push(`Authen: request ${st.authRequests}, success ${st.authAccepts}, fail ${st.authRejects}`);
      // `Failed accounting` est le controle A10 d'une liste d'audit : un
      // compteur qui monte veut dire que des traces sont PERDUES. Il
      // n'existait pas, donc le controle ne portait sur rien.
      lines.push(`Failed accounting: ${auth?.failedAccounting() ?? 0}`);
    }
    return lines.length ? lines.join('\n') : 'No TACACS+ servers configured';
  });

  vue(['show', 'login'], 'Display login config', 1, () => {
    const s = sec();
    const r = getDevice() as unknown as {
      getLoginBlocker?: () => {
        isBlocked: () => boolean;
        remainingBlockSeconds: () => number;
        windowRemainingSeconds: () => number;
        currentWindowFailureCount: () => number;
      } | null;
      getSecurityAuditLog?: () => { entries: () => readonly { mnemonic: string }[] } | null;
    };
    const blocker = r.getLoginBlocker?.();
    const totalFailures = r.getSecurityAuditLog?.()?.entries().filter(e => e.mnemonic === 'LOGIN_FAILED').length ?? 0;
    // Real IOS applies a default 1-second inter-attempt delay once
    // `login block-for` is active, unless `login delay` overrides it.
    const delay = s.login.delay ?? (s.login.blockFor ? 1 : 0);
    const lines = [`A login delay of ${delay} seconds is applied.`];
    lines.push(s.login.quietModeAcl
      ? `Quiet-Mode access list ${s.login.quietModeAcl} is applied.`
      : 'No Quiet-Mode access list has been configured.');
    lines.push('');
    if (!s.login.blockFor) {
      lines.push('Router NOT enabled to watch for login Attacks');
      return lines.join('\n');
    }
    const { seconds: blockSeconds, attempts, withinSeconds } = s.login.blockFor;
    if (blocker?.isBlocked()) {
      lines.push('Router presently in Quiet-Mode.');
      lines.push(`Will remain in Quiet-Mode for ${blocker.remainingBlockSeconds()} more secs.`);
      if (s.login.quietModeAcl) lines.push(`Permitted List: ${s.login.quietModeAcl}`);
      return lines.join('\n');
    }
    lines.push('Router enabled to watch for login Attacks.');
    lines.push(`If more than ${attempts} login failures occur in ${withinSeconds} seconds`);
    lines.push(`or less, logins will be disabled for ${blockSeconds} seconds.`);
    lines.push('');
    lines.push('Router presently in Normal-Mode.');
    lines.push('Current Watch Window');
    lines.push(`    Time remaining: ${blocker?.windowRemainingSeconds() ?? 0} seconds`);
    lines.push(`    Login failures for current window: ${blocker?.currentWindowFailureCount() ?? 0}`);
    lines.push(`Total login failures: ${totalFailures}`);
    return lines.join('\n');
  });

  vue(['show', 'login', 'failures'], 'Display login failures', 1, () => {
    const r = getDevice() as unknown as { getSecurityAuditLog?: () => { entries: () => readonly { mnemonic: string; message: string; at: number }[] } | null };
    const audit = r.getSecurityAuditLog?.();
    if (!audit) return "Information about login failure's with the device\n\n*** No failures recorded ***";
    const failures = audit.entries().filter(e => e.mnemonic === 'LOGIN_FAILED');
    if (failures.length === 0) return "Information about login failure's with the device\n\n*** No failures recorded ***";
    const lines = ["Information about login failure's with the device", '', 'Username   SourceIPAddr  lPort Count  TimeStamp'];
    const groups = new Map<string, { count: number; last: number; ip: string }>();
    for (const e of failures) {
      const ip = /\[Source: ([^\]]+)\]/.exec(e.message)?.[1] ?? 'unknown';
      const user = /\[user: ([^\]]+)\]/.exec(e.message)?.[1] ?? 'unknown';
      const key = `${user}@${ip}`;
      const g = groups.get(key) ?? { count: 0, last: 0, ip };
      g.count++;
      g.last = e.at;
      groups.set(key, g);
    }
    for (const [k, g] of groups) {
      const user = k.split('@')[0];
      lines.push(`${padToWidth(user, 11)}${padToWidth(g.ip, 14)}22    ${padToWidth(String(g.count), 7)}${new Date(g.last).toISOString().replace('T', ' ').slice(0, 19)}`);
    }
    return lines.join('\n');
  });

  vue(['show', 'crypto', 'key', 'mypubkey', 'rsa'], 'Show RSA public keys', 1, () => {
    const s = sec();
    if (s.cryptoKeys.length === 0) return '% No RSA key generated.';
    return s.cryptoKeys.map((k) => [
      `% Key pair was generated at: ${formatIosKeyDate(k.generatedAtMs)}`,
      `Key name: ${k.label}`,
      ' Storage Device: not specified',
      ` Usage: ${k.general ? 'General Purpose' : 'Signature'} Key`,
      k.exportable ? ' Key is exportable.' : ' Key is not exportable.',
      ' Key Data:',
      ...pubkeyDataLines(getDevice() as { getHostname(): string }, k.modulus),
    ].join('\n')).join('\n\n');
  });

  return vues;
}

/*
 * Un nom de classificateur, de politique ou de plage horaire est LIBRE :
 * la place l'annonce en `WORD` et la vue dit elle-meme qu'elle n'a rien
 * a montrer quand il ne designe rien — c'est ce qui distingue une vue
 * qui FILTRE d'une commande qui refuse.
 *
 * `show ip cef` et `show policy-map interface` gardent une place
 * GLOUTONNE facultative : leurs gestionnaires ignorent en silence ce
 * qu'ils ne reconnaissent pas, donc une place typee refuserait au caret
 * ce que la machine avale.
 */
const SECURITY_SHOW_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'show crypto pki trustpoints': null,
  'show crypto key mypubkey rsa': null,
  'show policy-map control-plane': null,
  'show ip traffic': null,
  'show parameter-map type inspect': { name: 'nom', type: 'WORD', optional: true,
    description: 'Name of the inspect parameter-map' },
  'show policy-map': { name: 'nom', type: 'WORD', optional: true,
    description: 'Policy-map name' },
  'show class-map': { name: 'nom', type: 'WORD', optional: true,
    description: 'Class-map name' },
  'show ip cef': { name: 'prefixe', type: 'REST', optional: true,
    description: 'Prefix to display',
    alternatives: [{ keyword: 'A.B.C.D', description: 'Prefix to display' }] },
  'show policy-map interface': { name: 'interface', type: 'REST', optional: true,
    description: 'Interface the policy-map is applied on' },
};

export function securityShowSpecs(getRouter: () => Router): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildSecurityShowCommands(collector as unknown as CommandTrie, getRouter),
    {
      modes: ['user', 'privileged'], minPrivilege: 1,
      argumentFor: (path) => SECURITY_SHOW_ARGUMENTS[path],
    },
  );
}

export function buildSecurityShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  const sec = () => getSecurityConfig(getRouter());

  trie.register('show crypto pki trustpoints', 'PKI trustpoints', () => {
    const tps = [...sec().pkiTrustpoints.values()];
    if (tps.length === 0) return 'No trustpoints configured';
    return tps.map(tp => [
      `Trustpoint ${tp.name}:`,
      `    Subject Name: ${tp.subjectName ?? '<not configured>'}`,
      `    Enrollment URL: ${tp.enrollmentUrl ?? 'terminal'}`,
      `    Revocation Check: ${tp.revocationCheck ?? 'crl'}`,
      `    RSA Keypair: ${tp.rsaKeypair ?? '<auto>'}`,
      tp.fqdn ? `    FQDN: ${tp.fqdn}` : '',
      tp.serialNumber ? `    Serial Number: ${tp.serialNumber}` : '',
    ].filter(Boolean).join('\n')).join('\n');
  });
  trie.register('show policy-map control-plane', 'Show CoPP policy', () => {
    const s = sec();
    const pm = s.controlPlane.servicePolicyInput;
    if (!pm) return '';
    return `Control Plane\n\n  Service-policy input: ${pm}`;
  });

  trie.registerGreedy('show parameter-map type inspect', 'Show parameter-map', (args) => {
    const s = sec();
    const all = [...s.parameterMapsInspect.values()];
    const target = args[0];
    const list = target ? all.filter(p => p.name === target) : all;
    if (list.length === 0) {
      return 'parameter-map type inspect default\n  audit-trail off\n  alert on\n  max-incomplete low unlimited\n  max-incomplete high unlimited';
    }
    return list.map(pm => [
      `parameter-map type inspect ${pm.name}`,
      `  audit-trail ${pm.auditTrail ? 'on' : 'off'}`,
      `  alert ${pm.alert !== false ? 'on' : 'off'}`,
      `  max-incomplete low ${pm.maxIncompleteLow ?? 'unlimited'}`,
      `  max-incomplete high ${pm.maxIncompleteHigh ?? 'unlimited'}`,
      `  one-minute low ${pm.oneMinuteLow ?? 'unlimited'}`,
      `  one-minute high ${pm.oneMinuteHigh ?? 'unlimited'}`,
      `  tcp idle-time ${pm.tcpIdleTimeSec ?? 3600}`,
      `  udp idle-time ${pm.udpIdleTimeSec ?? 30}`,
      `  dns-timeout ${pm.dnsTimeoutSec ?? 5}`,
    ].join('\n')).join('\n');
  });

  trie.register('show ip traffic', 'IP traffic statistics', () =>
    showIpTraffic(getRouter()._getPortsInternal().values()));

  trie.registerGreedy('show ip cef', 'Display CEF FIB', (args) => {
    if (!sec().ipCef) return 'IP CEF is not enabled';
    const router = getRouter();
    const installed = router.installedRoutes();
    const prefixe = args.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    const lines = ['Prefix               Next Hop             Interface'];
    // `0.0.0.0/0 no route` décrit l'ABSENCE de route par défaut : c'est
    // un fait de la table entière, pas de l'entrée demandée. Il
    // traversait le filtre, si bien que `show ip cef 172.16.0.0`
    // répondait sur deux préfixes dont un que personne n'avait demandé.
    if (!prefixe && !installed.some((r) => `${r.network}/${r.mask.toCIDR()}` === '0.0.0.0/0')) {
      lines.push('0.0.0.0/0            no route');
    }
    for (const r of installed) {
      const dst = `${r.network}/${r.mask.toCIDR()}`;
      if (prefixe && !dst.startsWith(`${prefixe}/`) && r.network.toString() !== prefixe) continue;
      const attachee = !r.nextHop || String(r.nextHop) === '0.0.0.0';
      const next = attachee ? 'attached' : r.nextHop!.toString();
      lines.push(`${padToWidth(dst, 21)}${padToWidth(next, 21)}${r.iface ?? ''}`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('show policy-map interface', 'Show policy-map applied on interfaces', () => {
    const s = sec();
    const lines: string[] = [];
    for (const [iface, f] of s.interfaceFlags) {
      if (f.zoneMember) lines.push(` ${iface}\n  Zone member: ${f.zoneMember}`);
    }
    return lines.length ? lines.join('\n') : '';
  });
  trie.registerGreedy('show policy-map', 'Show policy-map', (args) => {
    const s = sec();
    const target = args[0];
    const pms = target ? [s.policyMaps.get(target)].filter((x): x is NonNullable<typeof x> => !!x) : [...s.policyMaps.values()];
    if (pms.length === 0) return '';
    const lines: string[] = [];
    for (const pm of pms) {
      lines.push(`Policy Map ${pm.name}`);
      for (const cls of pm.classes) {
        lines.push(`  Class ${cls.className}`);
        for (const a of cls.actions) lines.push(`    ${policyMapActionLine(a)}`);
      }
    }
    return lines.join('\n');
  });
  trie.registerGreedy('show class-map', 'Show class-map', (args) => {
    const s = sec();
    const target = args[0];
    const cms = target ? [s.classMaps.get(target)].filter((x): x is NonNullable<typeof x> => !!x) : [...s.classMaps.values()];
    if (cms.length === 0) return '';
    return cms.map(cm => {
      const lines = [`Class Map ${cm.matchAll ? 'match-all' : 'match-any'} ${cm.name}`];
      for (const m of cm.matches) {
        if (m.kind === 'access-group-name') lines.push(`  Match access-group name ${m.value}`);
        else if (m.kind === 'access-group-num') lines.push(`  Match access-group ${m.value}`);
        else if (m.kind === 'protocol') lines.push(`  Match protocol ${m.value}`);
        else if (m.kind === 'any') lines.push('  Match any');
      }
      return lines.join('\n');
    }).join('\n');
  });
}

/** `10:04:36 UTC Aug 6 2026` — la date telle qu'IOS l'écrit ici. */
function formatIosKeyDate(ms: number): string {
  const d = new Date(ms);
  const mois = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const deux = (n: number) => String(n).padStart(2, '0');
  return `${deux(d.getUTCHours())}:${deux(d.getUTCMinutes())}:${deux(d.getUTCSeconds())} UTC `
    + `${mois} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

function pubkeyDataLines(device: { getHostname(): string }, modulus: number): string[] {
  const key = routerRsaKey(device.getHostname(), modulus);
  if (key === null) return [];
  return groupedHex(encodeRsaPublicKey(key.publicKey)).map((row) => `  ${row}`);
}
