import type { Router } from '../../Router';
import type { CiscoRouter } from '../../CiscoRouter';
import { CommandTrie } from '../CommandTrie';
import { showIpTraffic } from './CiscoCommonShow';
import {
  CiscoSecurityConfig,
  newRadiusServerStats,
  newTacacsServerStats,
  isTimeRangeActive,
  type AaaServiceKind,
  type AaaPhase,
} from '../../router/security/CiscoSecurityConfig';
import type { CiscoShellContext, CiscoShellMode } from './CiscoConfigCommands';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec, EnumValue } from '@/cli/ArgumentTypes';
import {
  specsFromTrieRegistrations, type AdapterKeyword,
} from '@/cli/commands/trieAdapter';
import { CliInvalidInput, CliIncomplete } from '../cli/CliDiagnostic';
import { CISCO_ERRORS } from '../cli-utils';
import { encryptType7, md5Hex } from '@/crypto';
import { pad2 } from '@/lib/format';
import { getOrCreateCA } from '../../../pki/PkiCaRegistry';
import type { RevocationCheckMode } from '../../../pki/CertificateVerifier';
import { MODES_INTERFACE } from './CiscoConfigCommands';

const SECURITY_KEY = Symbol.for('CiscoSecurityConfig');

const USERNAME_KEYWORDS = new Set(['nohangup', 'nopassword', 'one-time']);

export const RADIUS_SERVER_CONTINUATIONS: ReadonlyArray<{
  keyword: string; description: string; leadingOnly?: boolean;
  valeur?: ReadonlyArray<{ keyword: string; description: string }>;
}> = [
  { keyword: 'host', description: 'Specify a RADIUS server', leadingOnly: true,
    valeur: [{ keyword: 'A.B.C.D', description: 'IP address of the RADIUS server' }] },
  { keyword: 'key', description: 'Per-server encryption key',
    valeur: [{ keyword: 'LINE', description: 'The shared key itself' }] },
  { keyword: 'auth-port', description: 'UDP port for RADIUS authentication server',
    valeur: [{ keyword: '<0-65535>', description: 'Port number' }] },
  { keyword: 'acct-port', description: 'UDP port for RADIUS accounting server',
    valeur: [{ keyword: '<0-65535>', description: 'Port number' }] },
  { keyword: 'timeout', description: 'Time to wait for a RADIUS server to reply',
    valeur: [{ keyword: '<1-1000>', description: 'Wait time in seconds' }] },
  { keyword: 'retransmit', description: 'Number of retries to an active server',
    valeur: [{ keyword: '<0-100>', description: 'Number of retries' }] },
];

export const TACACS_SERVER_CONTINUATIONS: ReadonlyArray<{
  keyword: string; description: string; leadingOnly?: boolean;
  valeur?: ReadonlyArray<{ keyword: string; description: string }>;
}> = [
  { keyword: 'host', description: 'Specify a TACACS+ server', leadingOnly: true,
    valeur: [{ keyword: 'A.B.C.D', description: 'IP address of the TACACS+ server' }] },
  { keyword: 'key', description: 'Per-server encryption key',
    valeur: [{ keyword: 'LINE', description: 'The shared key itself' }] },
  { keyword: 'port', description: 'TCP port the server listens on',
    valeur: [{ keyword: '<1-65535>', description: 'Port number' }] },
  { keyword: 'timeout', description: 'Time to wait for a TACACS+ server to reply',
    valeur: [{ keyword: '<1-1000>', description: 'Wait time in seconds' }] },
];

export const RSA_MODULUS_MIN = 360;
export const RSA_MODULUS_MAX = 4096;
export const RSA_MODULUS_DEFAUT = 1024;

const RSA_GENERATE_KEYWORDS: ReadonlySet<string> = new Set([
  'general-keys', 'signature', 'encryption', 'exportable',
]);

export const NO_AAA_CONTINUATIONS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'new-model', description: 'Disable the AAA access control model' },
  { keyword: 'authentication', description: 'Remove an authentication method list' },
  { keyword: 'authorization', description: 'Remove an authorization method list' },
  { keyword: 'accounting', description: 'Remove an accounting method list' },
  { keyword: 'session-id', description: 'Restore the default session ID behaviour' },
];

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
export const AAA_TOP_KEYWORDS: readonly string[] = [
  'new-model', 'authentication', 'authorization', 'accounting',
  'group', 'session-id', 'local',
];

export const AAA_SERVICES: Record<AaaPhase, readonly string[]> = {
  authentication: ['login', 'enable', 'ppp', 'dot1x'],
  authorization: ['exec', 'commands', 'network', 'config-commands', 'reverse-access'],
  accounting: ['exec', 'commands', 'network', 'system', 'connection'],
};

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
export const PASSWORD_MIN_LENGTH_MAX = 16;

export function buildIdentityConfigCommands(
  trie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  trie.registerGreedy('aaa', 'AAA configuration', (args) => {
    if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
    if (!AAA_TOP_KEYWORDS.includes((args[0] ?? '').toLowerCase())) {
      throw new CliInvalidInput({ token: args[0] });
    }
    if (args[0] === 'new-model') { sec().aaaNewModel = true; return ''; }
    if (args[0] === 'session-id' && args[1]) { sec().aaaSessionId = args[1]; return ''; }
    if (args[0] === 'local' && args[1] === 'authentication' && args[2] === 'attempts' && args[3] === 'max-fail' && args[4]) {
      const n = parseInt(args[4], 10);
      if (isNaN(n)) return '% Incomplete command.';
      sec().localAuthMaxFailAttempts = n;
      const r = ctx.r() as unknown as { _configureLocalAuthMaxFail?: (n: number) => void };
      r._configureLocalAuthMaxFail?.(n);
      return '';
    }
    if (args[0] === 'authentication' || args[0] === 'authorization' || args[0] === 'accounting') {
      return parseAaaMethod(sec(), args[0] as AaaPhase, args.slice(1));
    }
    if (args[0] === 'group' && args[1] === 'server' && args[2] && args[3]) {
      const kind = args[2] === 'tacacs+' ? 'tacacs+' : 'radius';
      const name = args[3];
      const existing = sec().aaaGroups.get(name) ?? { name, kind: kind as 'radius' | 'tacacs+', members: [] };
      sec().aaaGroups.set(name, existing);
      ctx.setAaaGroup?.(name);
      ctx.setMode('config-aaa-group' as CiscoShellMode);
      return '';
    }
    return '';
  });

  trie.registerGreedy('no aaa', 'Disable AAA', (args) => {
    if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
    const quoi = (args[0] ?? '').toLowerCase();
    if (!AAA_TOP_KEYWORDS.includes(quoi)) throw new CliInvalidInput({ token: args[0] });
    if (quoi === 'new-model') {
      const s = sec();
      s.aaaNewModel = false;
      s.aaaMethods.length = 0;
      return '';
    }
    if (quoi === 'session-id') { sec().aaaSessionId = undefined; return ''; }
    if (quoi === 'authentication' || quoi === 'authorization' || quoi === 'accounting') {
      const phase = quoi as AaaPhase;
      const service = (args[1] ?? '').toLowerCase();
      const nom = (args[2] ?? '').toLowerCase() === 'default' ? 'default' : args[2];
      const s = sec();
      s.aaaMethods = s.aaaMethods.filter((m) =>
        !(m.phase === phase && m.service === service && (!nom || m.listName === nom)));
      return '';
    }
    return '';
  }, NO_AAA_CONTINUATIONS);

  trie.registerGreedy('username', 'Local user', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    let privilege: number | undefined;
    let secret: string | undefined;
    let secretAlgo: 'plain' | 'plain-password' | 'md5' | 'sha256' | 'scrypt' | 'type-7' = 'plain';
    let nopassword = false;
    let description: string | undefined;
    // Set only for forms where the operator typed a real cleartext password
    // (type 0, or the bare/unqualified form) — never for a pre-computed
    // hash pasted in via `secret 5|8|9|4` / `password 7`, which `security
    // passwords min-length` does not (and cannot) validate.
    let plaintextEntered: string | undefined;
    // Real IOS: entering a type-0 (cleartext) password via `password`
    // triggers a deprecation warning as the command's own output — never
    // for `secret`, which real IOS always hashes on save.
    let type0PasswordWarning = false;
    // `username X algorithm-type {md5|sha256|scrypt} secret <pwd>` : le
    // mot-cle etait accepte et JETE, si bien qu'un secret demande en
    // scrypt etait range en MD5 -- la commande de durcissement produisait
    // exactement l'inverse de ce qu'elle promet, en silence. Son
    // homologue `enable algorithm-type` fonctionne depuis toujours : meme
    // famille, deux comportements.
    let algoDemande: 'md5' | 'sha256' | 'scrypt' | undefined;
    let vue: string | undefined;
    let autocommand: string | undefined;
    let nohangup = false;
    let oneTime = false;
    let accessClass: number | undefined;
    let maxLinks: number | undefined;
    for (let i = 1; i < args.length; i++) {
      const t = args[i];
      if (t === 'privilege' && args[i + 1]) {
        const niveau = Number(args[i + 1]);
        if (!Number.isInteger(niveau) || niveau < 0 || niveau > 15) {
          throw new CliInvalidInput({ token: args[i + 1] });
        }
        privilege = niveau; i++;
      }
      else if (t === 'algorithm-type') {
        const nom = (args[i + 1] ?? '').toLowerCase();
        if (nom !== 'md5' && nom !== 'sha256' && nom !== 'scrypt') {
          throw new CliInvalidInput({ token: args[i + 1] });
        }
        algoDemande = nom; i++;
      }
      else if (t === 'view' && args[i + 1]) {
        // `username X view NOC_VIEW` — la vue attachee au compte. Le
        // mot-cle etait avale en silence par la boucle, donc le lien
        // entre un compte et son role disparaissait de la
        // configuration ; refuser une vue inexistante evite d'attacher
        // un role qui n'a jamais ete decrit.
        vue = args[i + 1]; i++;
      }
      else if (t === 'nopassword') { nopassword = true; }
      else if (t === 'nohangup') { nohangup = true; }
      else if (t === 'one-time') { oneTime = true; }
      else if (t === 'access-class') {
        const n = Number(args[i + 1]);
        if (!Number.isInteger(n) || n < 1 || n > 199) {
          throw new CliInvalidInput({ token: args[i + 1] ?? t });
        }
        accessClass = n; i++;
      }
      else if (t === 'user-maxlinks') {
        const n = Number(args[i + 1]);
        if (!Number.isInteger(n) || n < 0 || n > 255) {
          throw new CliInvalidInput({ token: args[i + 1] ?? t });
        }
        maxLinks = n; i++;
      }
      else if (t === 'description') { description = args.slice(i + 1).join(' '); break; }
      else if (t === 'secret') {
        const next = args[i + 1];
        if (next === '0') { secret = args.slice(i + 2).join(' '); secretAlgo = 'plain'; plaintextEntered = secret; break; }
        if (next === '5') { secret = args.slice(i + 2).join(' '); secretAlgo = 'md5'; break; }
        if (next === '8') { secret = args.slice(i + 2).join(' '); secretAlgo = 'sha256'; break; }
        if (next === '9') { secret = args.slice(i + 2).join(' '); secretAlgo = 'scrypt'; break; }
        if (next === '4') { secret = args.slice(i + 2).join(' '); secretAlgo = 'sha256'; break; }
        // Bare `secret <pwd>` is hashed (type 5) by real IOS, unless
        // `algorithm-type` named another one. Un chiffre explicite
        // (`secret 5|8|9`) decrit un condense DEJA calcule et sort plus
        // haut : l'algorithme demande ne porte que sur du clair a hacher.
        secret = args.slice(i + 1).join(' ');
        secretAlgo = algoDemande ?? 'md5';
        plaintextEntered = secret; break;
      }
      else if (t === 'password') {
        const next = args[i + 1];
        if (next === '0') {
          secret = args.slice(i + 2).join(' '); secretAlgo = 'plain-password';
          plaintextEntered = secret; type0PasswordWarning = true; break;
        }
        if (next === '7') { secret = args.slice(i + 2).join(' '); secretAlgo = 'type-7'; break; }
        secret = args.slice(i + 1).join(' '); secretAlgo = 'plain-password';
        plaintextEntered = secret; type0PasswordWarning = true; break;
      }
      else if (t === 'autocommand') { autocommand = args.slice(i + 1).join(' '); break; }
      else if (!USERNAME_KEYWORDS.has(t.toLowerCase())) {
        throw new CliInvalidInput({ token: t });
      }
    }
    if (vue !== undefined && !sec().parserViews.has(vue)) {
      return `%Error: View ${vue} is not present in the system`;
    }
    const minLength = sec().passwords.minLength;
    if (!nopassword && plaintextEntered !== undefined && minLength && plaintextEntered.length < minLength) {
      return `Password too short - must be at least ${minLength} characters. Password configuration failed`;
    }
    const router = ctx.r() as unknown as {
      _upsertCiscoUsername?: (n: string, kv: {
        privilege?: number; secret?: string;
        secretAlgo?: 'plain' | 'plain-password' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
        nopassword?: boolean; description?: string; view?: string;
        autocommand?: string; nohangup?: boolean; oneTime?: boolean;
        accessClass?: number; maxLinks?: number;
      }) => void;
    };
    if (router._upsertCiscoUsername) {
      router._upsertCiscoUsername(name, {
        privilege, secret, secretAlgo, nopassword, description, view: vue,
        autocommand, nohangup, oneTime, accessClass, maxLinks,
      });
    }
    if (type0PasswordWarning) {
      return "WARNING: Command has been added to the configuration using a type 0\n"
        + "password. However, type 0 passwords will soon be deprecated. Migrate\n"
        + "to a supported password type";
    }
    return '';
  }, USERNAME_CONTINUATIONS);

  trie.registerGreedy('radius', 'Radius configuration', (args) => {
    if (args[0] === 'server' && args[1]) {
      const name = args[1];
      const s = sec().radiusServers.get(name) ?? {
        name, authPort: 1645, acctPort: 1646, retransmit: 3, timeoutSec: 5,
        stats: newRadiusServerStats(),
      };
      sec().radiusServers.set(name, s);
      ctx.setRadiusServer?.(name);
      ctx.setMode('config-radius-server' as CiscoShellMode);
      return '';
    }
    return '';
  });

  trie.registerGreedy('tacacs', 'TACACS+ configuration', (args) => {
    if (args[0] === 'server' && args[1]) {
      const name = args[1];
      const s = sec().tacacsServers.get(name) ?? {
        name, port: 49, timeoutSec: 5, singleConnection: false,
        stats: newTacacsServerStats(),
      };
      sec().tacacsServers.set(name, s);
      ctx.setTacacsServer?.(name);
      ctx.setMode('config-tacacs-server' as CiscoShellMode);
      return '';
    }
    return '';
  });

  /*
   * `radius-server host <ip> [auth-port P] [acct-port P] [key K]` — le
   * JUMEAU exact du defaut de `tacacs-server host` : range dans
   * `legacyHosts`, un tableau que seul le rendu de la configuration
   * lisait, donc `show radius statistics` repondait « No RADIUS servers
   * configured » pendant que la configuration decrivait le serveur.
   *
   * RADIUS a DEUX ports la ou TACACS+ n'en a qu'un, et c'est la seule
   * difference qui compte ici : l'authentification et la comptabilite ne
   * vont pas au meme endroit, donc les confondre enverrait les traces sur
   * le port des demandes.
   */
  trie.registerGreedy('radius-server', 'Legacy radius host', (args) => {
    if (args[0] === 'key' && args[1]) { sec().radiusDefaults.key = args.slice(1).join(' '); return ''; }
    if (args[0] === 'timeout' || args[0] === 'retransmit') {
      if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 0) throw new CliInvalidInput({ token: args[1] });
      if (args[0] === 'timeout') sec().radiusDefaults.timeoutSec = n;
      else sec().radiusDefaults.retransmit = n;
      return '';
    }
    if (args[0] !== 'host' || !args[1]) return '';
    const host = args[1];
    let key: string | undefined;
    let authPort = 1645;
    let acctPort = 1646;
    let timeoutSec: number | undefined;
    let retransmit: number | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === 'key' && args[i + 1]) { key = args[i + 1]; i++; }
      else if (args[i] === 'auth-port' && args[i + 1]) { authPort = Number(args[i + 1]) || authPort; i++; }
      else if (args[i] === 'acct-port' && args[i + 1]) { acctPort = Number(args[i + 1]) || acctPort; i++; }
      else if (args[i] === 'timeout' && args[i + 1]) { timeoutSec = Number(args[i + 1]) || timeoutSec; i++; }
      else if (args[i] === 'retransmit' && args[i + 1]) { retransmit = Number(args[i + 1]) || retransmit; i++; }
    }
    const existant = sec().radiusServers.get(host);
    if (existant) {
      existant.key = key ?? existant.key;
      existant.authPort = authPort;
      existant.acctPort = acctPort;
      existant.timeoutSec = timeoutSec ?? existant.timeoutSec;
      existant.retransmit = retransmit ?? existant.retransmit;
      return '';
    }
    sec().radiusServers.set(host, {
      name: host, address: host, key, authPort, acctPort,
      timeoutSec, retransmit, legacySpelling: true,
      stats: newRadiusServerStats(),
    });
    return '';
  }, RADIUS_SERVER_CONTINUATIONS);
  trie.registerGreedy('no radius-server', 'Remove legacy radius host', (args) => {
    if (args[0] === 'host' && args[1]) sec().radiusServers.delete(args[1]);
    return '';
  }, [{ keyword: 'host', description: 'Specify a RADIUS server' }]);

  /*
   * `tacacs-server host <ip> [port P] [timeout T] [key K]` — la forme
   * HERITEE, et de loin la plus tapee dans les cours et les guides.
   *
   * Elle etait rangee dans `legacyHosts`, un tableau que SEUL le rendu de
   * la configuration lisait : la machine decrivait donc un serveur
   * qu'elle n'avait pas. `show tacacs` repondait « No TACACS+ servers
   * configured » sur la meme machine au meme instant, et surtout
   * l'authentification ne trouvait rien — un laboratoire monte
   * entierement a l'ancienne echouait en silence.
   *
   * Elle alimente desormais le MEME magasin que `tacacs server <nom>`.
   * Le serveur n'a pas de nom dans cette forme : IOS le designe par son
   * adresse, et c'est donc l'adresse qui sert de cle — ce qui rend aussi
   * `server <ip>` utilisable comme membre de groupe.
   */
  trie.registerGreedy('tacacs-server', 'Legacy tacacs host', (args) => {
    if (args[0] === 'key' && args[1]) { sec().tacacsDefaults.key = args.slice(1).join(' '); return ''; }
    if (args[0] === 'timeout') {
      if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 0) throw new CliInvalidInput({ token: args[1] });
      sec().tacacsDefaults.timeoutSec = n;
      return '';
    }
    if (args[0] !== 'host' || !args[1]) return '';
    const host = args[1];
    let key: string | undefined;
    let port = 49;
    let timeoutSec: number | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === 'key' && args[i + 1]) { key = args[i + 1]; i++; }
      else if (args[i] === 'port' && args[i + 1]) { port = Number(args[i + 1]) || 49; i++; }
      else if (args[i] === 'timeout' && args[i + 1]) { timeoutSec = Number(args[i + 1]) || 5; i++; }
    }
    const existant = sec().tacacsServers.get(host);
    if (existant) {
      existant.key = key ?? existant.key;
      existant.port = port;
      existant.timeoutSec = timeoutSec ?? existant.timeoutSec;
      return '';
    }
    sec().tacacsServers.set(host, {
      name: host, address: host, key, port, timeoutSec,
      singleConnection: false, legacySpelling: true,
      stats: newTacacsServerStats(),
    });
    return '';
  }, TACACS_SERVER_CONTINUATIONS);
  trie.registerGreedy('no tacacs-server', 'Remove legacy tacacs host', (args) => {
    if (args[0] === 'host' && args[1]) sec().tacacsServers.delete(args[1]);
    return '';
  });



  trie.registerGreedy('crypto key generate rsa', 'Generate RSA key', (args) => {
    // Le nom de domaine se lit de deux facons selon la plateforme : un
    // routeur le tient dans son service de gestion, un Catalyst
    // directement. Ne consulter que la premiere faisait repondre
    // « definissez d'abord un nom de domaine » a un commutateur qui
    // venait d'en poser un.
    const dev = ctx.r() as unknown as {
      getManagementService?: () => { domainName?: string };
      _getDnsConfig?: () => { domainName: string };
      getDomainName?: () => string | null | undefined;
    };
    const domain = dev._getDnsConfig?.().domainName
      || dev.getManagementService?.().domainName || dev.getDomainName?.() || '';
    if (!domain) {
      return '% Please define a domain-name first.';
    }
    let modulus = RSA_MODULUS_DEFAUT;
    // Sans `label`, IOS nomme la paire d'après l'identité pleinement
    // qualifiée du routeur — c'est pour cela qu'il exige un nom de
    // domaine avant de la générer.
    const hote = (ctx.r() as unknown as { getHostname?: () => string }).getHostname?.() ?? 'Router';
    let label = `${hote}.${domain}`;
    // `crypto key generate rsa` produit une paire à usage GÉNÉRAL ; ce
    // sont `usage-keys` qui en produisent deux, dont une de signature.
    let general = true;
    for (let i = 0; i < args.length; i++) {
      const mot = args[i].toLowerCase();
      if (mot === 'modulus') {
        const brut = args[i + 1];
        if (brut === undefined) throw new CliIncomplete();
        if (!/^\d+$/.test(brut)) throw new CliInvalidInput({ token: brut });
        const taille = Number(brut);
        if (taille < RSA_MODULUS_MIN || taille > RSA_MODULUS_MAX) {
          throw new CliInvalidInput({ token: brut });
        }
        modulus = taille; i++; continue;
      }
      if (mot === 'label') {
        if (args[i + 1] === undefined) throw new CliIncomplete();
        label = args[i + 1]; i++; continue;
      }
      if (mot === 'usage-keys') { general = false; continue; }
      if (RSA_GENERATE_KEYWORDS.has(mot)) continue;
      throw new CliInvalidInput({ token: args[i] });
    }
    const generatedAtMs = Date.now();
    sec().cryptoKeys.push({ label, modulus, general, generatedAtMs });
    // Generating the keys is what brings the SSH server up on IOS, so the
    // listener has to follow — the config and the service cannot disagree.
    (ctx.r() as unknown as { _refreshSshAvailability?: () => void })._refreshSshAvailability?.();
    const elapsedSec = Math.max(1, Math.round(modulus / 1024));
    return [
      `The name for the keys will be: ${label}`,
      `% The key modulus size is ${modulus} bits`,
      `% Generating ${modulus} bit RSA keys, keys will be non-exportable...`,
      `[OK] (elapsed time was ${elapsedSec} seconds)`,
    ].join('\n');
  });

  trie.registerGreedy('crypto key zeroize rsa', 'Delete RSA host keys', () => {
    const dev = ctx.r() as unknown as {
      getManagementService?: () => { domainName?: string };
      _getDnsConfig?: () => { domainName: string };
      getDomainName?: () => string | null | undefined;
      getHostname?: () => string;
      _refreshSshAvailability?: () => void;
    };
    if (sec().cryptoKeys.length === 0) return '% No Signature RSA Keys found in configuration.';
    const domaine = dev._getDnsConfig?.().domainName
      || dev.getManagementService?.().domainName || dev.getDomainName?.() || '';
    const fqdn = `${dev.getHostname?.() ?? ''}.${domaine}`;
    sec().cryptoKeys = [];
    // Wiping the keys really disables SSH — this is the router's F7.2, and
    // the classic way to lock yourself out of a box you reach over SSH.
    dev._refreshSshAvailability?.();
    return `% Keys to be removed are named ${fqdn}.`;
  });

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

  trie.registerGreedy('security passwords min-length', 'Min password length', (args) => {
    if (args[0] === undefined) return CISCO_ERRORS.INCOMPLETE;
    if (!/^\d+$/.test(args[0])) throw new CliInvalidInput({ token: args[0] });
    const n = Number(args[0]);
    if (n > PASSWORD_MIN_LENGTH_MAX) throw new CliInvalidInput({ token: args[0] });
    sec().passwords.minLength = n;
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

  trie.registerGreedy('time-range', 'Define time-range', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().ensureTimeRange(args[0]);
    ctx.setTimeRange?.(args[0]);
    ctx.setMode('config-time-range' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('class-map', 'Define class map', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    let kind: 'qos' | 'inspect' = 'qos';
    let matchAll = true;
    let i = 0;
    if (args[i] === 'type' && args[i + 1] === 'inspect') { kind = 'inspect'; i += 2; }
    if (args[i] === 'match-all') { matchAll = true; i++; }
    else if (args[i] === 'match-any') { matchAll = false; i++; }
    const name = args[i];
    if (!name) return '% Incomplete command.';
    sec().ensureClassMap(name, kind, matchAll);
    ctx.setClassMap?.(name);
    ctx.setMode('config-cmap' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('policy-map', 'Define policy map', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    let kind: 'qos' | 'inspect' = 'qos';
    let i = 0;
    if (args[i] === 'type' && args[i + 1] === 'inspect') { kind = 'inspect'; i += 2; }
    const name = args[i];
    if (!name) return '% Incomplete command.';
    sec().ensurePolicyMap(name, kind);
    ctx.setPolicyMap?.(name);
    ctx.setMode('config-pmap' as CiscoShellMode);
    return '';
  });

  trie.register('control-plane', 'Enter control-plane', () => {
    ctx.setControlPlane?.(true);
    ctx.setMode('config-cp' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('crypto pki trustpoint', 'Declare a PKI trustpoint', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().ensurePkiTrustpoint(args[0]);
    ctx.setPkiTrustpoint?.(args[0]);
    ctx.setMode('config-ca-trustpoint' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('no crypto pki trustpoint', 'Remove a PKI trustpoint', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().pkiTrustpoints.delete(args[0]);
    return '';
  });

  trie.registerGreedy('crypto pki authenticate', 'Authenticate trustpoint CA', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    const tp = sec().pkiTrustpoints.get(name);
    if (!tp) return `% Trustpoint ${name} not configured`;
    const ca = getOrCreateCA(tp.enrollmentUrl || `trustpoint:${name}`);
    tp.caCert = ca.rootCertificate;
    return `% Trustpoint ${name} CA certificate accepted`;
  });
  trie.registerGreedy('crypto pki enroll', 'Enroll trustpoint', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    const tp = sec().pkiTrustpoints.get(name);
    if (!tp) return `% Trustpoint ${name} not configured`;
    if (!tp.caCert) return `% Trustpoint ${name} is not authenticated — run 'crypto pki authenticate ${name}' first`;
    const ca = getOrCreateCA(tp.enrollmentUrl || `trustpoint:${name}`);
    const now = Date.now();
    const subject = tp.subjectName || `CN=${ctx.r()._getHostnameInternal()}`;
    const issued = ca.issueCertificate({
      subject, notBefore: now, notAfter: now + 365 * 24 * 3600 * 1000,
      subjectAltNames: tp.fqdn ? [tp.fqdn] : undefined,
    });
    tp.localCert = issued.cert;
    tp.localKey = issued.privateKey;
    (ctx.r() as CiscoRouter).installIkeCertAuth({
      localCert: issued.cert,
      localKey: issued.privateKey,
      trustAnchors: [tp.caCert],
      revocationCheck: mapRevocationCheck(tp.revocationCheck),
    });
    return `% Start certificate enrollment for trustpoint ${name}\n`
      + '% Certificate request sent to Certificate Authority\n'
      + '% Certificate successfully received and installed';
  });
  trie.registerGreedy('crypto pki import', 'Import certificate', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    const tp = sec().pkiTrustpoints.get(name);
    if (!tp) return `% Trustpoint ${name} not configured`;
    const what = args[1]?.toLowerCase();
    if (what === 'certificate' || what === 'pem') {
      (tp as unknown as { importedCertificate?: { format: string; importedAtMs: number } }).importedCertificate = {
        format: what,
        importedAtMs: Date.now(),
      };
      if (tp.localCert && tp.localKey && tp.caCert) {
        (ctx.r() as CiscoRouter).installIkeCertAuth({
          localCert: tp.localCert,
          localKey: tp.localKey,
          trustAnchors: [tp.caCert],
          revocationCheck: mapRevocationCheck(tp.revocationCheck),
        });
      }
      return `% Certificate imported into trustpoint ${name}`;
    }
    return `% Unknown import type "${what}"`;
  });

  trie.registerGreedy('parameter-map type inspect', 'Define parameter-map', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().ensureParameterMapInspect(args[0]);
    return '';
  });

  trie.registerGreedy('zone security', 'Define security zone', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().zones.set(args[0], { name: args[0] });
    ctx.setZone?.(args[0]);
    ctx.setMode('config-zone' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('zone-pair security', 'Define zone-pair', (args) => {
    if (args.length < 5) return '% Incomplete command.';
    const name = args[0];
    let src = '', dst = '';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === 'source' && args[i + 1]) src = args[i + 1];
      if (args[i] === 'destination' && args[i + 1]) dst = args[i + 1];
    }
    sec().zonePairs.set(name, { name, source: src, destination: dst });
    ctx.setZonePair?.(name);
    ctx.setMode('config-zone-pair' as CiscoShellMode);
    return '';
  });
}

function mapRevocationCheck(mode: string | undefined): RevocationCheckMode {
  if (mode === 'ocsp') return 'ocsp';
  if (mode === 'crl' || mode === 'crl-or-ocsp' || mode === 'crl-then-ocsp') return 'crl';
  return 'none';
}

function parseAaaMethod(sec: CiscoSecurityConfig, phase: AaaPhase, args: string[]): string {
  // `aaa authentication` seul était ACCEPTÉ en silence : rien n'était
  // enregistré, rien n'apparaissait dans la running-config, et
  // l'opérateur croyait avoir configuré une méthode.
  if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
  if (!AAA_SERVICES[phase].includes(args[0].toLowerCase())) throw new CliInvalidInput({ token: args[0] });
  if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
  const service = args[0] as AaaServiceKind;
  let i = 1;
  let privilegeLevel: number | undefined;
  if (service === 'commands' && args[i] !== undefined) {
    const lvl = parseInt(args[i], 10);
    if (!isNaN(lvl)) { privilegeLevel = lvl; i++; }
  }
  const listName = args[i++];
  let recordType: 'start-stop' | 'stop-only' | 'wait-start' | 'none' | undefined;
  if (phase === 'accounting' && (args[i] === 'start-stop' || args[i] === 'stop-only' || args[i] === 'wait-start' || args[i] === 'none')) {
    recordType = args[i] as 'start-stop' | 'stop-only' | 'wait-start' | 'none';
    i++;
  }
  const methods = args.slice(i);
  if (methods.length === 0) return CISCO_ERRORS.INCOMPLETE;
  // Les methodes d'ACCOUNTING ne sont pas celles d'authentification.
  // IOS n'accepte ici que `group <nom>`, `group radius|tacacs+`, `none`
  // et `broadcast` : il n'y a PAS de methode `local`, parce qu'un
  // enregistrement de comptabilite part vers un collecteur — il n'y a
  // rien de local ou l'ecrire. `aaa accounting exec default start-stop
  // local` etait accepte, range, rendu dans la configuration, et
  // n'emettait jamais rien : la commande promettait une trace qui ne
  // venait pas, ce qui est pire que son refus.
  if (phase === 'accounting') {
    const permis = new Set(['group', 'none', 'broadcast', 'radius', 'tacacs+']);
    for (let k = 0; k < methods.length; k++) {
      const mot = methods[k].toLowerCase();
      if (permis.has(mot)) { if (mot === 'group') k++; continue; }
      throw new CliInvalidInput({ token: methods[k] });
    }
  }
  sec.aaaMethods.push({ phase, service, listName, privilegeLevel, recordType, methods });
  return '';
}

/**
 * Les trois sous-modes de la famille identite : `config-radius-server`,
 * `config-tacacs-server` et `config-aaa-group`. Extraits pour la meme
 * raison que les deux fonctions ci-dessus — sans eux, `tacacs server X`
 * ouvrirait un mode ou aucune commande n'existe.
 */
export function buildIdentitySubmodeCommands(
  radiusTrie: CommandTrie,
  tacacsTrie: CommandTrie,
  aaaGroupTrie: CommandTrie,
  ctx: CiscoSecurityShellContext,
): void {
  buildRadiusServerSubmodeOn(radiusTrie, ctx);
  buildTacacsServerSubmodeOn(tacacsTrie, ctx);
  buildAaaGroupSubmodeOn(aaaGroupTrie, ctx);
}

export function buildRadiusServerSubmodeOn(
  radiusTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  radiusTrie.registerGreedy('address', 'Radius address', (args) => {
    const name = ctx.getRadiusServer?.();
    if (!name) return '';
    const s = sec().radiusServers.get(name);
    if (!s) return '';
    if (args[0] === 'ipv4' && args[1]) s.address = args[1];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'auth-port' && args[i + 1]) s.authPort = parseInt(args[i + 1], 10);
      if (args[i] === 'acct-port' && args[i + 1]) s.acctPort = parseInt(args[i + 1], 10);
    }
    return '';
  });
  radiusTrie.registerGreedy('key', 'Radius key', (args) => {
    const name = ctx.getRadiusServer?.();
    if (!name) return '';
    const s = sec().radiusServers.get(name);
    if (s) s.key = args.join(' ');
    return '';
  });
}

export function buildTacacsServerSubmodeOn(
  tacacsTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  tacacsTrie.registerGreedy('address', 'Tacacs address', (args) => {
    const name = ctx.getTacacsServer?.();
    if (!name) return '';
    const s = sec().tacacsServers.get(name);
    if (!s) return '';
    if (args[0] === 'ipv4' && args[1]) s.address = args[1];
    return '';
  });
  tacacsTrie.registerGreedy('key', 'Tacacs key', (args) => {
    const name = ctx.getTacacsServer?.();
    if (!name) return '';
    const s = sec().tacacsServers.get(name);
    if (s) s.key = args.join(' ');
    return '';
  });
  tacacsTrie.registerGreedy('port', 'Tacacs port', (args) => {
    const name = ctx.getTacacsServer?.();
    if (!name) return '';
    const s = sec().tacacsServers.get(name);
    const n = parseInt(args[0], 10);
    if (s && !isNaN(n)) s.port = n;
    return '';
  });
  tacacsTrie.registerGreedy('timeout', 'Tacacs timeout', (args) => {
    const name = ctx.getTacacsServer?.();
    if (!name) return '';
    const s = sec().tacacsServers.get(name);
    const n = parseInt(args[0], 10);
    if (s && !isNaN(n)) s.timeoutSec = n;
    return '';
  });
}

export function buildAaaGroupSubmodeOn(
  aaaGroupTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  /*
   * Un groupe accepte DEUX formes de membre, et seule la moderne etait
   * lue : `server name <nom>` designe un serveur declare par
   * `tacacs server <nom>`, tandis que `server <ip>` — la forme heritee,
   * celle qui accompagne `tacacs-server host` et que tous les cours
   * emploient — etait acceptee et JETEE en silence. Un groupe monte a
   * l'ancienne etait donc vide, et l'authentification ne trouvait aucun
   * serveur sans que rien ne le dise.
   */
  aaaGroupTrie.registerGreedy('server', 'Add server', (args) => {
    const name = ctx.getAaaGroup?.();
    if (!name) return '';
    const g = sec().aaaGroups.get(name);
    if (!g) return '';
    const membre = args[0] === 'name' ? args[1] : args[0];
    if (!membre) return CISCO_ERRORS.INCOMPLETE;
    if (!g.members.includes(membre)) g.members.push(membre);
    return '';
  });
  aaaGroupTrie.registerGreedy('no server', 'Remove server', (args) => {
    const name = ctx.getAaaGroup?.();
    const g = name ? sec().aaaGroups.get(name) : undefined;
    if (!g) return '';
    const membre = args[0] === 'name' ? args[1] : args[0];
    const i = membre ? g.members.indexOf(membre) : -1;
    if (i >= 0) g.members.splice(i, 1);
    return '';
  });
}

export function buildSecuritySubmodeCommands(
  cmapTrie: CommandTrie,
  pmapTrie: CommandTrie,
  pmapClassTrie: CommandTrie,
  cpTrie: CommandTrie,
  zoneTrie: CommandTrie,
  zonePairTrie: CommandTrie,
  trTrie: CommandTrie,
  radiusTrie: CommandTrie,
  tacacsTrie: CommandTrie,
  aaaGroupTrie: CommandTrie,
  trustpointTrie: CommandTrie,
  ctx: CiscoSecurityShellContext,
): void {
  buildClassMapSubmodeOn(cmapTrie, ctx);
  buildPolicyMapSubmodeOn(pmapTrie, ctx);
  buildPolicyClassSubmodeOn(pmapClassTrie, ctx);
  buildControlPlaneSubmodeOn(cpTrie, ctx);
  buildZoneSubmodeOn(zoneTrie, ctx);
  buildZonePairSubmodeOn(zonePairTrie, ctx);
  buildTimeRangeSubmodeOn(trTrie, ctx);
  buildIdentitySubmodeCommands(radiusTrie, tacacsTrie, aaaGroupTrie, ctx);
  buildTrustpointSubmodeOn(trustpointTrie, ctx);
}

export function buildClassMapSubmodeOn(
  cmapTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  cmapTrie.registerGreedy('match', 'Match criteria', (args) => {
    const name = ctx.getClassMap?.();
    if (!name) return '';
    const cm = sec().classMaps.get(name);
    if (!cm) return '';
    if (args[0] === 'access-group') {
      if (args[1] === 'name' && args[2]) cm.matches.push({ kind: 'access-group-name', value: args[2] });
      else if (args[1]) cm.matches.push({ kind: 'access-group-num', value: args[1] });
    } else if (args[0] === 'protocol' && args[1]) {
      cm.matches.push({ kind: 'protocol', value: args[1] });
    } else if (args[0] === 'any') {
      cm.matches.push({ kind: 'any' });
    }
    return '';
  });
}

export function buildPolicyMapSubmodeOn(
  pmapTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  pmapTrie.registerGreedy('class', 'Class for policy', (args) => {
    const pname = ctx.getPolicyMap?.();
    if (!pname) return '';
    const pm = sec().policyMaps.get(pname);
    if (!pm) return '';
    let cname: string;
    let kind: 'class-default' | 'named' | 'inspect' = 'named';
    let i = 0;
    if (args[i] === 'type' && args[i + 1] === 'inspect') { kind = 'inspect'; i += 2; }
    cname = args[i] ?? '';
    if (cname === 'class-default') kind = 'class-default';
    let cls = pm.classes.find(c => c.className === cname);
    if (!cls) {
      cls = { className: cname, kind, actions: [] };
      pm.classes.push(cls);
    }
    ctx.setPolicyClass?.(cname);
    ctx.setMode('config-pmap-c' as CiscoShellMode);
    return '';
  });
}

export function buildPolicyClassSubmodeOn(
  pmapClassTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  pmapClassTrie.registerGreedy('police', 'Police traffic', (args) => {
    addAction(ctx, 'police', args);
    return '';
  });
  pmapClassTrie.register('inspect', 'Inspect', () => { addAction(ctx, 'inspect', []); return ''; });
  pmapClassTrie.registerGreedy('drop', 'Drop', (args) => { addAction(ctx, 'drop', args); return ''; });
  pmapClassTrie.register('pass', 'Pass', () => { addAction(ctx, 'pass', []); return ''; });
  pmapClassTrie.registerGreedy('set dscp', 'Set DSCP', (args) => { addAction(ctx, 'set-dscp', args); return ''; });
  pmapClassTrie.registerGreedy('set precedence', 'Set precedence', (args) => { addAction(ctx, 'set-precedence', args); return ''; });
  pmapClassTrie.registerGreedy('priority', 'Reserve bandwidth for priority', (args) => { addAction(ctx, 'priority', args); return ''; });
  pmapClassTrie.registerGreedy('bandwidth', 'Reserve bandwidth', (args) => { addAction(ctx, 'bandwidth', args); return ''; });
  pmapClassTrie.register('fair-queue', 'Enable WFQ', () => { addAction(ctx, 'fair-queue', []); return ''; });
  pmapClassTrie.registerGreedy('random-detect', 'WRED configuration', (args) => { addAction(ctx, 'random-detect', args); return ''; });
  pmapClassTrie.registerGreedy('shape', 'Traffic shape', (args) => { addAction(ctx, 'shape', args); return ''; });
  pmapClassTrie.registerGreedy('service-policy', 'Nested service-policy', (args) => { addAction(ctx, 'service-policy', args); return ''; });
  pmapClassTrie.registerGreedy('queue-limit', 'Queue depth', (args) => { addAction(ctx, 'queue-limit', args); return ''; });
  pmapClassTrie.registerGreedy('compression', 'Compression', (args) => { addAction(ctx, 'compression', args); return ''; });
}

export function buildControlPlaneSubmodeOn(
  cpTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  cpTrie.registerGreedy('service-policy', 'Apply policy', (args) => {
    if (args[0] === 'input' && args[1]) sec().controlPlane.servicePolicyInput = args[1];
    if (args[0] === 'output' && args[1]) sec().controlPlane.servicePolicyOutput = args[1];
    return '';
  });
}

export function buildZoneSubmodeOn(
  zoneTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  zoneTrie.registerGreedy('description', 'Zone description', (args) => {
    const name = ctx.getZone?.();
    if (!name) return '';
    const z = sec().zones.get(name);
    if (z) (z as unknown as { description?: string }).description = args.join(' ');
    return '';
  });
}

export function buildZonePairSubmodeOn(
  zonePairTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  zonePairTrie.registerGreedy('service-policy', 'Apply policy', (args) => {
    const name = ctx.getZonePair?.();
    if (!name) return '';
    const zp = sec().zonePairs.get(name);
    if (!zp) return '';
    if (args[0] === 'type' && args[1] === 'inspect' && args[2]) zp.servicePolicy = args[2];
    return '';
  });
}

export function buildTimeRangeSubmodeOn(
  trTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  trTrie.registerGreedy('periodic', 'Periodic time-range', (args) => {
    const name = ctx.getTimeRange?.();
    if (!name) return '';
    const tr = sec().ensureTimeRange(name);
    let days = '';
    let i = 0;
    while (i < args.length && args[i] !== 'to' && !/^\d/.test(args[i])) {
      days += (days ? ' ' : '') + args[i];
      i++;
    }
    if (i >= args.length) return '';
    const [sh, sm] = parseHourMinute(args[i]);
    if (args[i + 1] !== 'to' || !args[i + 2]) return '';
    const [eh, em] = parseHourMinute(args[i + 2]);
    tr.periodic.push({ days, startHour: sh, startMinute: sm, endHour: eh, endMinute: em });
    return '';
  });
  trTrie.registerGreedy('absolute', 'Absolute time-range', (args) => {
    const name = ctx.getTimeRange?.();
    if (!name) return '';
    const tr = sec().ensureTimeRange(name);
    const parsed = parseAbsolute(args);
    if (parsed) tr.absolute = parsed;
    return '';
  });
}

export function buildTrustpointSubmodeOn(
  trustpointTrie: CommandTrie, ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  const tp = () => {
    const name = ctx.getPkiTrustpoint?.();
    return name ? sec().pkiTrustpoints.get(name) ?? null : null;
  };
  trustpointTrie.registerGreedy('enrollment', 'Enrollment configuration', (args) => {
    const t = tp(); if (!t) return '';
    if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
    const mot = args[0].toLowerCase();
    if (mot === 'url') {
      if (!args[1]) return CISCO_ERRORS.INCOMPLETE;
      t.enrollmentUrl = args[1];
      delete t.enrollmentProfile;
      delete t.source;
      return '';
    }
    if (mot === 'profile') {
      if (!args[1]) return CISCO_ERRORS.INCOMPLETE;
      t.enrollmentProfile = args[1];
      delete t.enrollmentUrl;
      delete t.source;
      return '';
    }
    if (mot === 'selfsigned' || mot === 'self-signed') t.source = 'selfsigned';
    else if (mot === 'terminal') t.source = 'terminal';
    else throw new CliInvalidInput({ token: args[0] });
    delete t.enrollmentUrl;
    delete t.enrollmentProfile;
    return '';
  });
  trustpointTrie.registerGreedy('subject-name', 'Set subject name', (args) => {
    const t = tp(); if (!t) return '';
    t.subjectName = args.join(' ');
    return '';
  });
  trustpointTrie.registerGreedy('revocation-check', 'Set revocation check method', (args) => {
    const t = tp(); if (!t) return '';
    const mode = args.join(' ').toLowerCase();
    if (mode === 'crl' || mode === 'none' || mode === 'ocsp' || mode === 'crl-or-ocsp' || mode === 'crl-then-ocsp') {
      t.revocationCheck = mode as 'crl' | 'none' | 'ocsp' | 'crl-or-ocsp' | 'crl-then-ocsp';
    }
    return '';
  });
  trustpointTrie.registerGreedy('rsakeypair', 'Bind RSA keypair', (args) => {
    const t = tp(); if (!t) return '';
    t.rsaKeypair = args[0];
    return '';
  });
  trustpointTrie.registerGreedy('fqdn', 'Set FQDN', (args) => {
    const t = tp(); if (!t) return '';
    t.fqdn = args[0];
    return '';
  });
  trustpointTrie.registerGreedy('ip-address', 'Set IP', (args) => {
    const t = tp(); if (!t) return '';
    t.ipAddress = args[0];
    return '';
  });
  trustpointTrie.registerGreedy('serial-number', 'Set serial number', (args) => {
    const t = tp(); if (!t) return '';
    t.serialNumber = args[0];
    return '';
  });
  trustpointTrie.registerGreedy('auto-enroll', 'Auto-enrollment', (args) => {
    const t = tp(); if (!t) return '';
    const cfg: { percent?: number; regenerate?: boolean } = {};
    for (let i = 0; i < args.length; i++) {
      const n = parseInt(args[i], 10);
      if (!isNaN(n)) cfg.percent = n;
      if (args[i] === 'regenerate') cfg.regenerate = true;
    }
    t.autoEnroll = cfg;
    return '';
  });
  trustpointTrie.registerGreedy('fingerprint', 'Set fingerprint', (args) => {
    const t = tp(); if (!t) return '';
    t.fingerprint = args.join(' ');
    return '';
  });
}

const JOURS_SEMAINE: readonly EnumValue[] = [
  { keyword: 'Monday', description: 'Monday' },
  { keyword: 'Tuesday', description: 'Tuesday' },
  { keyword: 'Wednesday', description: 'Wednesday' },
  { keyword: 'Thursday', description: 'Thursday' },
  { keyword: 'Friday', description: 'Friday' },
  { keyword: 'Saturday', description: 'Saturday' },
  { keyword: 'Sunday', description: 'Sunday' },
  { keyword: 'daily', description: 'Every day of the week' },
  { keyword: 'weekdays', description: 'Monday through Friday' },
  { keyword: 'weekend', description: 'Saturday and Sunday' },
];

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

const CMAP_KEYWORDS: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'access-group', description: 'Access group',
    argument: formes('liste', 'Access list to match', [
      { keyword: '<1-2799>', description: 'Access list index' },
      { keyword: 'name', description: 'Named access list' },
    ]),
  },
  {
    keyword: 'protocol', description: 'Protocol',
    argument: place('protocole', 'WORD', 'Protocol name'),
  },
  { keyword: 'any', description: 'Any packets', argument: null },
];

export function classMapSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildClassMapSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-cmap'], minPrivilege: 15,
      keywordsFor: () => CMAP_KEYWORDS,
      argumentFor: () => null,
    },
  );
}

export function policyMapSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildPolicyMapSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-pmap'], minPrivilege: 15,
      argumentFor: () => formes('classe', 'class-map name', [
        { keyword: 'WORD', description: 'class-map name' },
        {
          keyword: 'class-default',
          description: 'System default class matching otherwise unclassified packets',
        },
        { keyword: 'type', description: 'policy-map class type' },
      ]),
    },
  );
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
  drop: null,
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
  priority: place('debit', 'REST', 'Reserved bandwidth in kilobits per second'),
  bandwidth: place('debit', 'REST', 'Reserved bandwidth in kilobits per second'),
  'random-detect': place('mode', 'REST', 'Weighted random early detection parameters'),
  shape: place('mode', 'REST', 'Traffic shaping parameters'),
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

const SERVICE_POLICY_SENS: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'input', description: 'Assign a policy map to the input of the control plane',
    argument: place('politique', 'WORD', 'Policy map name'),
  },
  {
    keyword: 'output', description: 'Assign a policy map to the output of the control plane',
    argument: place('politique', 'WORD', 'Policy map name'),
  },
];

export function controlPlaneSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildControlPlaneSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-cp'], minPrivilege: 15,
      keywordsFor: () => SERVICE_POLICY_SENS,
      argumentFor: () => null,
    },
  );
}

export function zoneSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildZoneSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-zone'], minPrivilege: 15,
      argumentFor: () => place('texte', 'REST',
        'Up to 200 characters describing this zone', { literal: 'LINE' }),
    },
  );
}

export function zonePairSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildZonePairSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-zone-pair'], minPrivilege: 15,
      argumentFor: () => null,
      keywordsFor: () => [{
        keyword: 'type', description: 'Type of the service policy',
        argument: formes('inspection', 'Inspection policy map to apply', [
          { keyword: 'inspect', description: 'Apply an inspection policy map' },
        ]),
      }],
    },
  );
}

const TIME_RANGE_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  periodic: formes('jours', 'Days of the week the range covers', JOURS_SEMAINE),
  absolute: formes('bornes', 'Start and end of the range', [
    { keyword: 'start', description: 'Time the range starts' },
    { keyword: 'end', description: 'Time the range ends' },
  ]),
};

export function timeRangeSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildTimeRangeSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-time-range'], minPrivilege: 15,
      argumentFor: (path) => TIME_RANGE_ARGUMENTS[path],
    },
  );
}

const RADIUS_SUBMODE_KEYWORDS: ReadonlyArray<AdapterKeyword> = [{
  keyword: 'ipv4', description: 'IPv4 address of the RADIUS server',
  argument: [
    place('adresse', 'IP_ADDR', 'IP address of the RADIUS server'),
    place('ports', 'REST', 'auth-port and acct-port of this server', { optional: true }),
  ],
}];

export function radiusServerSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildRadiusServerSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-radius-server'], minPrivilege: 15,
      argumentFor: (path) => path === 'key'
        ? place('cle', 'REST', 'The shared key itself', { literal: 'LINE' }) : null,
      keywordsFor: (path) => path === 'address' ? RADIUS_SUBMODE_KEYWORDS : undefined,
    },
  );
}

const TACACS_SUBMODE_KEYWORDS: ReadonlyArray<AdapterKeyword> = [{
  keyword: 'ipv4', description: 'IPv4 address of the TACACS+ server',
  argument: place('adresse', 'IP_ADDR', 'IP address of the TACACS+ server'),
}];

const TACACS_SUBMODE_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  address: null,
  key: place('cle', 'REST', 'The shared key itself', { literal: 'LINE' }),
  port: place('port', 'INT', 'Port number', { range: [1, 65535] }),
  timeout: place('secondes', 'INT', 'Wait time in seconds', { range: [1, 1000] }),
};

export function tacacsServerSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildTacacsServerSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-tacacs-server'], minPrivilege: 15,
      argumentFor: (path) => TACACS_SUBMODE_ARGUMENTS[path],
      keywordsFor: (path) => path === 'address' ? TACACS_SUBMODE_KEYWORDS : undefined,
    },
  );
}

export function aaaGroupSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildAaaGroupSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-aaa-group'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: () => formes('serveur', 'Server that joins the group', [
        { keyword: 'A.B.C.D', description: 'Address of a server declared the legacy way' },
        { keyword: 'name', description: 'Name of a server declared by `tacacs server`' },
      ]),
    },
  );
}

const TRUSTPOINT_ENROLLMENT: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'profile', description: 'Name of an enrollment profile',
    argument: place('profil', 'WORD', 'Enrollment profile name'),
  },
  { keyword: 'self-signed', description: 'Generate a self-signed certificate', argument: null },
  { keyword: 'selfsigned', description: 'Generate a self-signed certificate', argument: null },
  { keyword: 'terminal', description: 'Cut and paste the certificate at the terminal', argument: null },
  {
    keyword: 'url', description: 'Enrollment URL of the certification authority',
    argument: place('url', 'WORD', 'The enrollment URL itself'),
  },
];

const TRUSTPOINT_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  enrollment: null,
  'subject-name': place('sujet', 'REST',
    'Distinguished name of the certificate subject', { literal: 'LINE' }),
  'revocation-check': place('methode', 'ENUM', 'How to check the revocation status', {
    values: REVOCATION_MODES,
  }),
  rsakeypair: place('cle', 'WORD', 'Name of the RSA key pair to bind'),
  fqdn: formes('nom', 'Fully qualified domain name of the certificate', [
    { keyword: 'WORD', description: 'The domain name itself' },
    { keyword: 'none', description: 'Do not include a domain name' },
  ]),
  'ip-address': formes('adresse', 'IP address of the certificate', [
    { keyword: 'A.B.C.D', description: 'The address itself' },
    { keyword: 'none', description: 'Do not include an IP address' },
  ]),
  'serial-number': formes('serie', 'Serial number of the certificate', [
    { keyword: 'none', description: 'Do not include a serial number' },
  ]),
  'auto-enroll': place('pourcentage', 'INT',
    'Percentage of the certificate lifetime after which to re-enrol', {
      optional: true,
    }),
  fingerprint: place('empreinte', 'WORD', 'Fingerprint the certificate must carry'),
};

export function trustpointSubmodeSpecs(ctx: CiscoSecurityShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildTrustpointSubmodeOn(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ca-trustpoint'], minPrivilege: 15,
      argumentFor: (path) => TRUSTPOINT_ARGUMENTS[path],
      keywordsFor: (path) => path === 'enrollment' ? TRUSTPOINT_ENROLLMENT
        : path === 'auto-enroll' ? AUTO_ENROLL_KEYWORDS : undefined,
    },
  );
}

const AUTO_ENROLL_KEYWORDS: ReadonlyArray<AdapterKeyword> = [{
  keyword: 'regenerate', description: 'Generate a new key pair when re-enrolling',
  argument: null, afterArguments: true,
}];

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

function parseHourMinute(token: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (!m) return [0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

const MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseAbsolute(args: string[]): import('../../router/security/CiscoSecurityConfig').TimeRangeAbsolute | null {
  const result: import('../../router/security/CiscoSecurityConfig').TimeRangeAbsolute = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'start' || args[i] === 'end') {
      const which = args[i];
      const [h, m] = parseHourMinute(args[i + 1] ?? '');
      const day = parseInt(args[i + 2] ?? '', 10);
      const month = MONTH_MAP[args[i + 3]?.toLowerCase() ?? ''] ?? 0;
      const year = parseInt(args[i + 4] ?? '', 10);
      if (isNaN(day) || isNaN(year) || month === 0) continue;
      const entry = { year, month, day, hour: h, minute: m };
      if (which === 'start') result.start = entry;
      else result.end = entry;
      i += 4;
    }
  }
  return result;
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
  'zone-member security': {
    name: 'zone', type: 'WORD', description: 'Name of the security zone',
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
    const allowDefault = args.includes('allow-default');
    if (args[0] === 'reverse-path') {
      sec().ifaceFlags(i).urpf = { mode: 'strict', allowDefault };
    } else if (args[0] === 'source' && args[1] === 'reachable-via' && args[2]) {
      sec().ifaceFlags(i).urpf = {
        mode: args[2] === 'any' ? 'loose' : 'strict', allowDefault,
      };
    }
    return '';
  });
  trie.registerGreedy('zone-member security', 'Assign zone', (args) => {
    const i = ctx.getSelectedInterface(); if (!i || !args[0]) return '';
    sec().ifaceFlags(i).zoneMember = args[0];
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

  vue(['show', 'aaa', 'servers'], 'Display AAA servers', 1, () => {
    const s = sec();
    const lines: string[] = [];
    let idx = 1;
    for (const r of s.radiusServers.values()) {
      const st = r.stats;
      lines.push(`RADIUS: id ${idx++}, priority 1, host ${r.address ?? '<no address>'}, auth-port ${r.authPort}, acct-port ${r.acctPort}`);
      lines.push(`    State: current UP, duration ${secondsSince(st.upSinceMs)}s, previous duration 0s`);
      lines.push(`    Authen: request ${st.authRequests}, timeouts ${st.authTimeouts}, retransmission ${st.authRetransmits}`);
      lines.push(`            Response: accept ${st.authAccepts}, reject ${st.authRejects}, challenge 0`);
      lines.push(`    Account: request ${st.acctRequests}, timeouts ${st.acctTimeouts}, retransmission ${st.acctRetransmits}`);
      lines.push(`            Response: ${st.acctResponses}`);
    }
    for (const t of s.tacacsServers.values()) {
      const st = t.stats;
      lines.push(`TACACS+: id ${idx++}, host ${t.address ?? '<no address>'}, port ${t.port}`);
      lines.push(`    Socket opens: ${st.socketOpens}, closes: ${st.socketCloses}, aborts: ${st.socketAborts}, errors: ${st.socketErrors}`);
      lines.push(`    Authen: request ${st.authRequests}, success ${st.authAccepts}, fail ${st.authRejects}`);
    }
    return lines.length ? lines.join('\n') : 'No AAA servers configured';
  });

  vue(['show', 'aaa', 'local', 'user', 'lockout'],
    'Local users currently locked out', 1, () => {
    const lines = [
      'Local-user            Lock time            Unlock time',
      '-------------------------------------------------------------',
    ];
    for (const a of getDevice().getCredentialStore().list()) {
      if (!a.locked) continue;
      lines.push(`${a.name.padEnd(22)}${a.lockReason ?? 'locked'}`);
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
      lines.push(`     ${service.padEnd(18)}${String(c.starts).padStart(6)}`
        + `${String(c.stops).padStart(9)}${String(c.failed).padStart(10)}`);
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
      for (const s of active) lines.push(`${s.id.padEnd(11)}1          ${s.user.padEnd(11)}${s.fromIp.padEnd(14)}${s.line}`);
    }
    return lines.join('\n');
  });

  vue(['show', 'radius', 'statistics'], 'Display Radius stats', 1, () => {
    const s = sec();
    if (s.radiusServers.size === 0) return 'No RADIUS servers configured';
    const lines = ['  Radius Statistics:'];
    for (const r of s.radiusServers.values()) {
      const st = r.stats;
      lines.push(`  Server: ${r.name} (${r.address ?? 'unconfigured'})`);
      lines.push(`    Auth requests: ${st.authRequests}, retransmits: ${st.authRetransmits}, accepts: ${st.authAccepts}, rejects: ${st.authRejects}`);
      lines.push(`    Acct requests: ${st.acctRequests}, retransmits: ${st.acctRetransmits}, responses: ${st.acctResponses}`);
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
      lines.push(`Tacacs+ Server : ${t.address ?? t.name}/${t.port}`);
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
      lines.push(`${user.padEnd(11)}${g.ip.padEnd(14)}22    ${String(g.count).padEnd(7)}${new Date(g.last).toISOString().replace('T', ' ').slice(0, 19)}`);
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
      ' Key is not exportable.',
      ' Key Data:',
      ` ${rsaPublicKeyMaterial(k.label, k.modulus, k.generatedAtMs)}`,
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
  'show crypto pki certificates': null,
  'show crypto key mypubkey rsa': null,
  'show policy-map control-plane': null,
  'show zone security': null,
  'show zone-pair security': null,
  'show policy-map type inspect zone-pair': null,
  'show ip traffic': null,
  'show parameter-map type inspect': { name: 'nom', type: 'WORD', optional: true,
    description: 'Name of the inspect parameter-map' },
  'show policy-map': { name: 'nom', type: 'WORD', optional: true,
    description: 'Policy-map name' },
  'show class-map': { name: 'nom', type: 'WORD', optional: true,
    description: 'Class-map name' },
  'show time-range': { name: 'nom', type: 'WORD', optional: true,
    description: 'Time-range name' },
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
  trie.register('show crypto pki certificates', 'PKI certificates', () => {
    const tps = [...sec().pkiTrustpoints.values()];
    if (tps.length === 0) return 'No PKI certificates installed';
    return tps.map(tp => {
      if (!tp.localCert) return `Certificate (Trustpoint ${tp.name}):\n  Status: Pending enrollment`;
      const lines = [
        `Certificate (Trustpoint ${tp.name}):`,
        '  Status: Available',
        `  Certificate Serial Number: ${tp.localCert.serialNumber}`,
        `  Subject: ${tp.localCert.subject}`,
        `  Issuer: ${tp.localCert.issuer}`,
        `  Validity: ${new Date(tp.localCert.notBefore).toISOString()} to ${new Date(tp.localCert.notAfter).toISOString()}`,
      ];
      if (tp.caCert) {
        lines.push(
          `CA Certificate (Trustpoint ${tp.name}):`,
          '  Status: Available',
          `  Certificate Serial Number: ${tp.caCert.serialNumber}`,
          `  Subject: ${tp.caCert.subject}`,
        );
      }
      return lines.join('\n');
    }).join('\n\n');
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

  trie.register('show zone security', 'Display zones', () => {
    const s = sec();
    if (s.zones.size === 0) return 'No zones configured';
    return [...s.zones.values()].map(z => {
      const description = (z as unknown as { description?: string }).description ?? `${z.name} security zone`;
      const members: string[] = [];
      for (const [iface, f] of s.interfaceFlags) {
        if (f.zoneMember === z.name) members.push(`    ${iface}`);
      }
      return [
        `Zone: ${z.name}`,
        `  Description: ${description}`,
        '  Member Interfaces:',
        ...(members.length === 0 ? ['    None'] : members),
      ].join('\n');
    }).join('\n');
  });

  trie.register('show zone-pair security', 'Display zone-pairs', () => {
    const s = sec();
    if (s.zonePairs.size === 0) return 'No zone-pairs configured';
    return [...s.zonePairs.values()].map(zp => `Zone-pair name: ${zp.name}\n  Source-Zone: ${zp.source}  Destination-Zone: ${zp.destination}\n  service-policy ${zp.servicePolicy ?? 'not configured'}`).join('\n');
  });

  trie.register('show policy-map type inspect zone-pair', 'Show inspect policy', () => {
    const s = sec();
    return [...s.zonePairs.values()].map(zp => `policy exists on zp ${zp.name}`).join('\n');
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
      lines.push(`${dst.padEnd(21)}${next.padEnd(21)}${r.iface ?? ''}`);
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
        for (const a of cls.actions) lines.push(`    ${a.kind}${a.args.length ? ' ' + a.args.join(' ') : ''}`);
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
  trie.registerGreedy('show time-range', 'Show time-range', (args) => {
    const s = sec();
    const list = args[0] ? [s.timeRanges.get(args[0])].filter((x): x is NonNullable<typeof x> => !!x) : [...s.timeRanges.values()];
    if (list.length === 0) return '';
    // `(inactive)` était écrit EN DUR, quelle que soit l'heure : la seule
    // vue qui répond à « ma plage est-elle en cours ? » ne consultait pas
    // l'horloge. Elle lit désormais celle de l'ÉQUIPEMENT — celle que
    // `clock set` pose et que le plan de données consulte — et non celle
    // de la machine hôte, sans quoi la vue et le filtrage se
    // contrediraient à nouveau.
    const dev = getRouter();
    const now = new Date(dev.getSystemClockMs());
    const utilisee = (nom: string): boolean =>
      dev._getAccessListsInternal()
        .some(acl => acl.entries.some(e => e.timeRange === nom));
    const lines: string[] = [];
    for (const tr of list) {
      const etat = isTimeRangeActive(tr, now) ? 'active' : 'inactive';
      lines.push(`time-range entry: ${tr.name} (${etat})`);
      for (const p of tr.periodic) lines.push(`   periodic ${p.days} ${p.startHour}:${pad2(p.startMinute)} to ${p.endHour}:${pad2(p.endMinute)}`);
      if (utilisee(tr.name)) lines.push('   used in: IP ACL entry');
    }
    return lines.join('\n');
  });
}

function secondsSince(ms: number): number {
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
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

function rsaPublicKeyMaterial(label: string, modulus: number, generatedAtMs: number): string {
  let h1 = 2166136261 >>> 0;
  let h2 = 0x811C9DC5 >>> 0;
  const seed = `${label}|${modulus}|${generatedAtMs}`;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  const blocks = Math.max(4, Math.floor(modulus / 64));
  const out: string[] = [];
  for (let i = 0; i < blocks; i++) {
    h1 = Math.imul(h1 ^ (i + 1), 0x9E3779B1) >>> 0;
    h2 = Math.imul(h2 ^ (i + 1), 0xBB67AE85) >>> 0;
    out.push(h1.toString(16).padStart(8, '0').toUpperCase());
    out.push(h2.toString(16).padStart(8, '0').toUpperCase());
  }
  const hex = out.join('');
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 64) {
    lines.push(hex.slice(i, i + 64));
  }
  return lines.join('\n  ');
}
