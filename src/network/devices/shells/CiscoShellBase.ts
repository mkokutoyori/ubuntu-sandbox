/**
 * CiscoShellBase — Abstract base class for Cisco IOS CLI shells.
 *
 * Factorizes the execute loop, FSM transitions, prompt generation,
 * help/tab-complete, and shared command registration that were previously
 * duplicated between CiscoIOSShell (Router) and CiscoSwitchShell (Switch).
 *
 * Template Method pattern: subclasses override hooks to provide
 * device-specific behavior (mode tries, prompt maps, etc.)
 *
 * @typeParam TDevice  The concrete device type (Router or Switch).
 *                     Subclasses use this for typed access to device-specific APIs.
 */

import { CiscoFileSystem } from './cisco/CiscoFileSystem';
import { IPAddress } from '@/network/core/types';
import { IOS_SSH } from '@/terminal/ssh/sshDialect';
import { CommandTable } from '@/cli/CommandTable';
import {
  specsFromTrieRegistrations, isCollector, type AdapterKeyword,
} from '@/cli/commands/trieAdapter';
import { newSession, type CliSession } from '@/cli/CliSession';
import { parseCommand, uniqueChild } from '@/cli/CommandParser';
import { applyTransition } from '@/cli/CliEngine';
import { argumentAccepts } from '@/cli/ArgumentTypes';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { SOCLE, continuationsPourLeSocle } from './cisco/ciscoContinuations';
import type { ContinuationTable } from './cisco/ciscoContinuations';
import type { CommandSpec, TreeNode, LiveValuesPort } from '@/cli/CommandTable';

/**
 * Un libelle de noeud, et les modes ou il vaut.
 *
 * Sans les modes, un chemin n'a qu'un seul nom pour toute la CLI :
 * `authentication` porterait les mots de la politique ISAKMP jusque dans
 * un profil IKEv2, ou la commande n'est pas la meme.
 */
export type SocleLegend = readonly [readonly string[], string, (readonly string[])?];
import { showIpDhcpSpecs, type DhcpViewServer } from '@/cli/commands/show/showIpDhcp';
import { showConfigViewSpecs } from '@/cli/commands/show/showSlice';
import { debugFamily, type DebugPair } from '@/cli/commands/debug/debugFamily';
import { legacyFamily } from '@/cli/LegacyDeclaration';
import { loggingFamily, type LoggingEntry } from '@/cli/commands/logging/loggingFamily';
import { sequenceFamily, type SequenceEntry } from '@/cli/commands/SequenceFamily';
import {
  FACILITY_NAMES, BUFFERED_SIZE_MIN, BUFFERED_SIZE_MAX,
  HISTORY_SIZE_MIN, HISTORY_SIZE_MAX, RATE_LIMIT_MIN, RATE_LIMIT_MAX,
} from '../inspection/config/LoggingConfig';
import { complete as socleComplete, type CompletionTrigger } from '@/cli/CompletionEngine';
import { projectLoggingOntoSyslogAgent } from '@/network/syslog/loggingProjection';
import { projectSnmpServiceOntoAgent } from '@/network/snmp/snmpProjection';
import { renderStartupConfig } from './cisco/ciscoConfigSerializer';
import { CommandTrie, type ParamType } from './CommandTrie';
import { EquipmentParamResolver, type SessionParamRanges, type CompletableDevice } from './EquipmentParamResolver';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { runSshClient } from '../linux/network/LinuxSshClient';
import { findHostByAddress } from '../linux/network/HostLookup';
import type { Router } from '../Router';
import {
  getSecurityConfig, buildIdentityShowCommands, buildIdentityConfigCommands,
} from './cisco/CiscoSecurityCommands';
import { parserViewMode } from '../router/security/CiscoSecurityConfig';
import type { CiscoDevice } from './CiscoDevice';
import type { PromptMap } from './PromptBuilder';
import { buildPrompt } from './PromptBuilder';
import { CLIStateMachine, type ModeHierarchy } from './CLIStateMachine';
import { estGenreAcces } from '../../ntp/accessGroups';
import { NTP_VERSION } from '../../ntp/types';
import {
  getGlobalConfig, CEF_LOAD_SHARING_ALGORITHMS, CEF_ACCOUNTING_KINDS,
} from '../router/config/CiscoGlobalConfig';
import { hms } from '@/lib/format';

/**
 * Les sous-commandes de `ntp` en configuration globale, avec la
 * description qu'IOS en donne.
 *
 * Elles sont declarees plutot qu'extraites : la liste que `?` proposait
 * etait scrapee du code source du gestionnaire, d'ou `md5`, `prefer` et
 * `mode` — trois arguments ou fuites d'autres commandes, jamais des
 * sous-commandes de `ntp`. Ce qui n'est pas ici est refuse.
 */
const NTP_SOUS_COMMANDES: ReadonlyArray<{
  mot: string;
  desc: string;
  /**
   * Une sous-commande SANS argument se declare non gloutonne : sinon
   * `ntp authenticate ?` propose un `WORD` qui recopie la description de
   * son parent, exactement le defaut que ce lot ferme.
   */
  args?: false;
}> = [
  { mot: 'access-group', desc: 'Control NTP access' },
  { mot: 'allow', desc: 'Allow processing of packets' },
  { mot: 'authenticate', desc: 'Authenticate time sources', args: false },
  { mot: 'authentication-key', desc: 'Authentication key for trusted time sources' },
  { mot: 'master', desc: 'Act as NTP master clock' },
  { mot: 'peer', desc: 'Configure NTP peer' },
  { mot: 'server', desc: 'Configure NTP server' },
  { mot: 'source', desc: 'Configure interface for source address' },
  { mot: 'trusted-key', desc: 'Key numbers for trusted time sources' },
  { mot: 'update-calendar', desc: 'Periodically update calendar from NTP', args: false },
];
import { CISCO_ERRORS, parsePipeFilter, applyPipeFilter, PIPE_WRITERS, PIPE_MODIFIERS, type PipeFilter } from './cli-utils';
import { isValidIPv4 } from '../../core/ip';
import {
  registerArpShowCommands, registerArpConfigCommands,
} from './cisco/CiscoArpCommands';
import {
  showClock, showUsers, showInventory, showProcessesCpu, showProcessesMemory,
  showMemoryStatistics, showPrivilege,
  showCdp, showLldp, showSnmp, showSnmpCommunity, showSnmpHost,
  showSnmpGroup, showSnmpUser, showSnmpView, showSnmpEngineId,
  showNtpStatus, showNtpAssociations, showNtpAssociationsDetail, showNtpAuthenticationKeys,
  showNtpPackets,
  showLine, showIpSsh, showSshSessions, showHosts, showIpDnsStatistics, showVrf,
  showVrfDetail, showVrfInterfaces, showAdjacency,
  showRedundancy, showFileSystems, showCalendar, showTerminal,
  showBuffers, showTcpBrief, showSockets, type TcpBriefSource,
  showStacks, showReload, showAaa, showEnvironment, showControllers,
  chassisSerial, CISCO_HARDWARE_PROFILES, licenseTable,
  type ShowStateDevice,
} from './cisco/CiscoCommonShow';
import {
  registerCiscoDnsCommands, registerCiscoDnsExecCommands, type DnsCommandContext,
} from './cisco/CiscoDnsCommands';
import type { CiscoDnsConfig } from '../router/dns/CiscoDnsConfig';
import type { RouterHostsTable } from '../router/dns/RouterHostsTable';
import { CiscoConfigState, getConfigState } from '../inspection/config/CiscoConfigState';
import { AliasRepository, type AliasMode } from '../inspection/config/AliasRepository';
import { LoggingConfig, disabledTimestampSpec, bareTimestampSpec, deviceClockSource } from '../inspection/config/LoggingConfig';
import type { TimestampSpec } from '../inspection/config/LoggingConfig';
import { isPathReachable } from '../linux/network/HostLookup';
import { OutgoingSessionRegistry, renderSessions } from './OutgoingSessionRegistry';
import { registerArchiveExecCommands, archiveOnWriteMemory,
  archiveSubmodeSpecs, archiveLogSubmodeSpecs } from './cisco/CiscoArchiveCommands';
import {
  radiusServerSubmodeSpecs, tacacsServerSubmodeSpecs, aaaGroupSubmodeSpecs,
  type CiscoSecurityShellContext,
} from './cisco/CiscoSecurityCommands';
import { registerLineExecCommands } from './cisco/CiscoLineCommands';
import { setupInteractionPlan } from './cisco/CiscoSetupDialog';
import {
  scopedTrie, PRIVILEGED_ONLY_SHOW_CHILDREN, PRIVILEGED_ONLY_PATHS,
  PRIVILEGED_EXEC_ONLY, type ExecScope,
} from './cisco/CiscoExecScope';
import {
  registerLoggingConfigCommands, loggingShowViews, severityValues,
  registerSequenceNumbersCommand, registerLoggingClearCommands,
} from './cisco/CiscoLoggingCommands';
import type { LoggingCommandContext } from './cisco/CiscoLoggingCommands';
import { encryptType7 as _encryptType7, md5Hex as _md5Hex } from '@/crypto';
import { ciscoPasswordMatches } from './cisco/ciscoPasswordVerify';
import {
  getManagementService, getSnmpService, getSnmpAgent, getNtpAgent, getHttpService,
  getSessionRegistry,
} from '../../equipment/RouterServiceCapabilities';
import {
  HTTP_AUTH_METHODS, HTTP_MAX_CONNECTIONS_MIN, HTTP_MAX_CONNECTIONS_MAX,
  type HttpAuthMethod,
} from '../router/management/CiscoHttpService';
import { runTestAaaGroup } from '../router/aaa/TestAaaGroup';
import type { AaaAuthenticator } from '../router/aaa/AaaAuthenticator';
import type { TftpEndpoint } from '@/network/tftp/types';
import { parseTftpUrl, tftpGet, tftpPut, TFTP_NO_HOST } from './cisco/CiscoTftpCopy';
import {
  CliAuthorization, CommandLevelTable, ParserViewRegistry, scopeForMode,
  type CliPrincipal, type AuthScope, AUTH_SCOPES, filterConfigForLevel,
} from './cli/CliAuthorization';
import { ensurePrivilegeRules } from '../router/security/CiscoPrivilegeStore';
import { CommandCanonicalizer } from './cli/CommandCanonicalizer';
import type {
  CommandInteractionPlan,
  InteractionPlanContext,
} from '@/shell/interaction/CommandInteraction';
import {
  CliInvalidInput, CliIncomplete, renderCliDiagnostic, offsetForInvalidInput, argumentOffset,
  tokenSpans, INVALID_INPUT_MESSAGE,
} from './cli/CliDiagnostic';
import { renderTable, IOS_RULED_TABLE } from './cli/TextTable';
import type { TableColumn } from './cli/TextTable';
import { parseVlanList, compactVlanList } from './cli/vlanList';
import { createDefaultSnoopingConfig } from '../../dhcp/types';
import type { DHCPSnoopingConfig, DHCPSnoopingBinding } from '../../dhcp/types';

const SNOOPING_BINDING_COLUMNS: ReadonlyArray<TableColumn<DHCPSnoopingBinding>> = [
  { header: 'MacAddress', width: 18, value: (b) => b.macAddress },
  { header: 'IpAddress', width: 16, value: (b) => b.ipAddress },
  { header: 'Lease(sec)', width: 10, value: (b) => String(b.lease) },
  { header: 'Type', width: 13, value: (b) => b.type },
  { header: 'VLAN', width: 4, value: (b) => String(b.vlan) },
  { header: 'Interface', width: 20, value: (b) => b.port },
];

const SNOOPING_TRUST_COLUMNS = (
  cfg: DHCPSnoopingConfig,
): ReadonlyArray<TableColumn<string>> => [
  { header: 'Interface', value: (nom) => nom },
  { header: 'Trusted', value: (nom) => (cfg.trustedPorts.has(nom) ? 'yes' : 'no') },
  { header: 'Allow option', value: (nom) => (cfg.trustedPorts.has(nom) ? 'yes' : 'no') },
  {
    header: 'Rate limit (pps)',
    value: (nom) => {
      const debit = cfg.rateLimits.get(nom);
      return debit !== undefined && debit > 0 ? String(debit) : 'unlimited';
    },
  },
];

/**
 * Ce qu'IOS affiche pendant qu'il écrit : un `!` par tranche envoyée.
 * `tee` affiche EN PLUS la sortie, `redirect` et `append` seulement
 * ceci — c'est ce qui distingue les trois.
 */
const EIGRP_DEBUG_SUBJECTS: Readonly<Record<string, string>> = {
  packets: 'EIGRP Packets debugging is on\n'
    + '    (UPDATE, REQUEST, QUERY, REPLY, HELLO, IPXSAP, PROBE, ACK, STUB, SIAQUERY, SIAREPLY)',
  neighbors: 'EIGRP Neighbors debugging is on',
  fsm: 'EIGRP FSM Events/Actions debugging is on',
  transmit: 'EIGRP Transmission Events debugging is on',
  notifications: 'EIGRP Event notifications debugging is on',
  summary: 'EIGRP Summary Events debugging is on',
};

const PIPE_WRITE_BANNER = '!!';

/** La taille d'historique d'IOS quand aucune ligne ne l'a fixee. */
/**
 * Le nombre maximal de vues et superviews qu'IOS accepte, vue racine non
 * comprise (Cisco, Role-Based CLI Access).
 */
const MAX_PARSER_VIEWS = 15;

const HISTORIQUE_PAR_DEFAUT = 20;

/** Le texte que `help` imprime sur IOS, mot pour mot. */
/**
 * L'ordre d'une liste d'aide IOS : les octets, et `<cr>` en dernier.
 *
 * `<cr>` est PLACE, pas classe. Le trier avec les autres le remettrait en
 * tete, `<` valant 0x3C — c'est exactement ce que faisait le
 * `localeCompare` que cette fonction remplace, et qui annulait au passage
 * le classement que l'arbre venait de produire.
 *
 * Le tri est sur les octets et non sur la locale : IOS place `/verify`
 * puis `LINE` puis `at`, ordre qu'un tri insensible a la casse rend faux
 * des qu'un substitut en majuscules cotoie des mots-cles.
 */
function ordonnerCommeIos(
  entrees: Array<{ keyword: string; description: string }>,
): void {
  entrees.sort((a, b) => {
    if (a.keyword === b.keyword) return 0;
    if (a.keyword === '<cr>') return 1;
    if (b.keyword === '<cr>') return -1;
    return a.keyword < b.keyword ? -1 : 1;
  });
}

const HELP_SYSTEM_TEXT = [
  'Help may be requested at any point in a command by entering',
  'a question mark \'?\'.  If nothing matches, the help list will',
  'be empty and you must backup until entering a \'?\' shows the',
  'available options.',
  'Two styles of help are provided:',
  '1. Full help is available when you are ready to enter a',
  '   command argument (e.g. \'show ?\') and describes each possible',
  '   argument.',
  '2. Partial help is provided when an abbreviated argument is entered',
  '   and you want to know what arguments match the input',
  '   (e.g. \'show pr?\'.)',
].join('\n');


/**
 * Les services qu'IOS connait, moins les quatre que cette machine
 * honore par une declaration a elle.
 *
 * Liste de la Configuration Fundamentals Command Reference, recoupee
 * avec le module `cisco.ios.ios_service` d'Ansible — deux sources qui
 * decrivent la meme commande reelle.
 */
const SERVICES_IOS: ReadonlyArray<readonly [string, string]> = [
  ['compress-config', 'Compress the configuration file'],
  ['config', 'TFTP load config files'],
  ['counters', 'Control aging of interface counters'],
  ['disable-ip-fast-frag', 'Disable IP particle-based fast fragmentation'],
  ['exec-callback', 'Enable EXEC callback'],
  ['exec-wait', 'Delay EXEC startup on noisy lines'],
  ['finger', 'Allow responses to finger requests'],
  ['hide-telnet-addresses', 'Hide destination addresses in telnet command'],
  ['internal', 'Enable/disable internal commands'],
  ['linenumber', 'Enable line number banner for each EXEC'],
  ['log', 'Configure logging for a service'],
  ['nagle', 'Enable Nagle\'s congestion control algorithm'],
  ['old-slip-prompts', 'Allow old scripts to operate with slip/ppp'],
  ['pad', 'Enable PAD commands'],
  ['password-recovery', 'Password recovery'],
  ['prompt', 'Enable mode specific prompt'],
  ['pt-vty-logging', 'Log significant VTY-Async events'],
  ['slave-log', 'Enable log capability of slave IPs'],
  ['tcp-keepalives-in', 'Generate keepalives on idle incoming network connections'],
  ['tcp-keepalives-out', 'Generate keepalives on idle outgoing network connections'],
  ['tcp-small-servers', 'Enable small TCP servers (e.g., ECHO)'],
  ['telnet-zeroidle', 'Set TCP window 0 when connection is idle'],
  ['udp-small-servers', 'Enable small UDP servers (e.g., ECHO)'],
  ['unsupported-transceiver', 'Enable support for third-party transceivers'],
];

const ARCHIVE_EXEC: ReadonlySet<string> = new Set([
  'show archive', 'show archive config differences', 'show archive log config',
  'archive config', 'configure replace',
]);

const ARCHIVE_EXEC_PLACES: Readonly<Record<string, readonly ArgumentSpec[]>> = {
  'show archive config differences': [
    {
      name: 'avant', type: 'WORD', optional: true,
      description: 'File to compare from (defaults to the latest archive)',
    },
    {
      name: 'apres', type: 'WORD', optional: true,
      description: 'File to compare to (defaults to the running configuration)',
    },
  ],
  'configure replace': [
    {
      name: 'url', type: 'WORD',
      description: 'URL of the configuration file to roll back to',
    },
    {
      name: 'options', type: 'REST', optional: true,
      description: 'How the rollback is performed', literal: 'LINE',
      alternatives: [
        { keyword: 'force', description: 'Do not prompt for confirmation' },
        { keyword: 'list', description: 'List the commands, apply nothing' },
        { keyword: 'nolock', description: 'Do not lock the configuration' },
        { keyword: 'revert', description: 'Set the revert options' },
        { keyword: 'time', description: 'Time for automatic rollback' },
      ],
    },
  ],
  'show archive log config': [{
    name: 'selection', type: 'REST', optional: true,
    description: 'Records to show', literal: 'LINE',
    alternatives: [
      { keyword: 'all', description: 'All the records' },
      { keyword: 'statistics', description: 'Memory held by the log' },
      { keyword: 'user', description: 'Records of one user' },
    ],
  }],
};

interface DhcpConfigServer {
  getPool(name: string): unknown;
  createPool(name: string): void;
  deletePool(name: string): void;
  addExcludedRange(start: string, end: string): boolean;
  addDatabaseAgent(url: string): void;
  removeDatabaseAgent(url: string): void;
  enable(): void;
  disable(): void;
}

type BannerKind = 'motd' | 'login' | 'exec' | 'incoming';

const BANNER_SORTES: ReadonlyArray<readonly [BannerKind, string]> = [
  ['exec', 'Set EXEC process creation banner'],
  ['incoming', 'Set incoming terminal line banner'],
  ['login', 'Set login banner'],
  ['motd', 'Set Message of the Day banner'],
];

const SERVICES_A_MOTEUR: ReadonlySet<string> = new Set([
  'service sequence-numbers', 'service timestamps',
]);

const SERVICE_PLACES: Readonly<Record<string, readonly ArgumentSpec[]>> = {
  'service timestamps': [
    {
      name: 'channel', type: 'ENUM', optional: true,
      description: 'Message class to timestamp',
      values: [
        { keyword: 'debug', description: 'Timestamp debug messages' },
        { keyword: 'log', description: 'Timestamp log messages' },
      ],
    },
    {
      name: 'format', type: 'REST', optional: true,
      description: 'Timestamp format and options',
      literal: 'LINE',
    },
  ],
};

const LINE_ACCESS_CLASS: readonly ArgumentSpec[] = [
  {
    name: 'access-list', type: 'WORD', description: 'Access-list name',
    alternatives: [
      { keyword: '<1-199>', description: 'IP access list (standard or extended)' },
      { keyword: 'WORD', description: 'Access-list name' },
    ],
  },
  enumeration('direction', 'Filter direction', [
    ['in', 'Inbound packets'], ['out', 'Outbound packets'],
  ]),
];

const LINE_ARGUMENTS: Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'access-class': LINE_ACCESS_CLASS,
  'motd-banner': null,
  length: { name: 'lines', type: 'INT', description: 'Number of lines on a screen', range: [0, 512] },
  width: { name: 'characters', type: 'INT', description: 'Width of the display terminal', range: [0, 512] },
  'session-timeout': { name: 'minutes', type: 'INT', description: 'Timeout in minutes', range: [0, 35791] },
  'absolute-timeout': { name: 'minutes', type: 'INT', description: 'Absolute session lifetime in minutes', range: [0, 35791] },
  rotary: { name: 'group', type: 'INT', description: 'Rotary group number', range: [1, 100] },
  autocommand: { name: 'command', type: 'REST', optional: true, description: 'Command to execute on connection' },
  password: { name: 'password', type: 'REST', literal: 'LINE', description: 'The UNENCRYPTED (cleartext) line password' },
  'login-timeout': { name: 'seconds', type: 'INT', optional: true, range: [1, 300], description: 'Timeout in seconds' },
  speed: enumeration('bps', 'Transmit and receive speeds', [
    ['300', '300 bps'], ['1200', '1200 bps'], ['2400', '2400 bps'],
    ['4800', '4800 bps'], ['9600', '9600 bps'], ['19200', '19200 bps'],
    ['38400', '38400 bps'], ['57600', '57600 bps'], ['115200', '115200 bps'],
  ]),
  databits: enumeration('bits', 'Number of data bits per character', [
    ['5', 'Five data bits'], ['6', 'Six data bits'],
    ['7', 'Seven data bits'], ['8', 'Eight data bits'],
  ]),
  stopbits: enumeration('bits', 'Number of stop bits', [
    ['1', 'One stop bit'], ['2', 'Two stop bits'],
  ]),
  parity: enumeration('parity', 'Set terminal parity', [
    ['even', 'Even parity'], ['none', 'No parity'], ['odd', 'Odd parity'],
  ]),
  flowcontrol: enumeration('method', 'Set the flow control', [
    ['hardware', 'Hardware flow control'],
    ['none', 'Set no flow control'],
    ['software', 'Software flow control'],
  ]),
  'escape-character': {
    name: 'caractere', type: 'INT', optional: true, range: [0, 255],
    description: 'ASCII decimal value of the escape character',
    values: [
      { keyword: 'break', description: 'Use the BREAK signal as the escape character' },
      { keyword: 'default', description: 'Restore the default escape character' },
      { keyword: 'none', description: 'Disable the escape character' },
      { keyword: 'soft', description: 'Use a soft escape character' },
    ],
  },
  'exec-timeout': { name: 'minutes', type: 'REST', optional: true, literal: '<0-35791>', description: 'Timeout in minutes' },
};

const LINE_KEYWORD_ARGUMENTS: Readonly<Record<string, ArgumentSpec>> = {
  'privilege level': { name: 'level', type: 'INT', optional: true, description: 'Privilege level', range: [0, 15] },
  'history size': { name: 'size', type: 'INT', optional: true, description: 'Size of history buffer', range: [0, 256] },
};

const LINE_TRANSPORT_PROTOCOLS: ArgumentSpec = {
  name: 'protocol', type: 'ENUM', optional: true, description: 'Transport protocol',
  values: [
    { keyword: 'all', description: 'All protocols' },
    { keyword: 'none', description: 'No protocols' },
    { keyword: 'ssh', description: 'TCP/IP SSH protocol' },
    { keyword: 'telnet', description: 'TCP/IP Telnet protocol' },
  ],
};

const LINE_TRANSPORT_KEYWORDS:
ReadonlyArray<{ keyword: string; description: string; argument: ArgumentSpec }> = [
  {
    keyword: 'input', argument: LINE_TRANSPORT_PROTOCOLS,
    description: 'Define which protocols to use when connecting to the terminal server',
  },
  {
    keyword: 'output', argument: LINE_TRANSPORT_PROTOCOLS,
    description: 'Define which protocols to use for outgoing connections',
  },
];

function enumeration(
  name: string, description: string, valeurs: ReadonlyArray<readonly [string, string]>,
): ArgumentSpec {
  return {
    name, type: 'ENUM', optional: true, description,
    values: valeurs.map(([keyword, texte]) => ({ keyword, description: texte })),
  };
}

/**
 * Quel MODE chaque arbre porte.
 *
 * L'elagage des chemins migres etait aveugle au mode : il retirait de
 * TOUS les arbres tout chemin declare au socle. Tant que les familles
 * migrees etaient des vues (`show ...`, plusieurs mots, uniques), cela
 * ne se voyait pas ; le premier mot-cle d'un seul mot l'a montre —
 * `privilege`, declare pour `config-line`, effacait le `privilege exec
 * level` de la configuration globale, une AUTRE commande du meme nom.
 * Un arbre absent de cette table est elague comme avant.
 */
const MODE_DU_TRIE: Readonly<Record<string, readonly string[]>> = {
  userTrie: ['user', 'privileged'],
  privilegedTrie: ['user', 'privileged'],
  configPmapClassTrie: ['config-pmap-c'],
  // Une sous-interface est une interface : le meme arbre sert les deux
  // modes, et l'elagage doit retirer les chemins des DEUX.
  configIfTrie: ['config-if', 'config-subif'],
  configIpSlaTrie: ['config-ipsla'],
  configIpSlaHttpRawTrie: ['config-ipsla-http-raw'],
};

/**
 * Le nom du champ DIT le mode : `configRouterOspfTrie` porte
 * `config-router-ospf`. Les deux arbres d'EXEC sont l'exception — ils
 * partagent un espace de noms — et sont nommes explicitement. Une
 * derivation qui tomberait a cote n'elague RIEN pour cet arbre, ce qui
 * est le cote sur lequel se tromper.
 */
function modesDuTrie(champ: string): readonly string[] {
  const explicite = MODE_DU_TRIE[champ];
  if (explicite) return explicite;
  return [champ.replace(/Trie$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()];
}

const LINE_KEYWORD_SUITES: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ['login', [['authentication', 'Use an AAA method list'], ['local', 'Use the local user database']]],
  ['logging', [['synchronous', 'Synchronize logging output with EXEC output']]],
  ['privilege', [['level', 'Set the privilege level of the line']]],
  ['exec', [['banner', 'Enable the display of the EXEC banner']]],
  ['history', [['size', 'Set the size of the history buffer']]],
  ['no', [
    ['absolute-timeout', 'Clear the absolute session limit'],
    ['escape-character', 'Restore the default escape character'],
    ['exec', 'Disable the EXEC process'],
    ['history', 'Disable the command history'],
    ['login', 'Disable authentication on the line'],
    ['logging', 'Disable synchronous logging'],
    ['password', 'Clear the line password'],
    ['privilege', 'Clear the privilege level'],
  ]],
  ['authorization', [['commands', 'Authorize commands'], ['exec', 'Authorize EXEC sessions']]],
  ['accounting', [['commands', 'Account for commands'], ['connection', 'Account for connections'], ['exec', 'Account for EXEC sessions']]],
];


/**
 * Les places du sous-mode `config-view`.
 *
 * `commands` en prend TROIS avant la commande elle-meme — le mode, le
 * sens, puis un `all` facultatif — et les annoncer comme un mot muet
 * laissait l'operateur deviner l'ordre d'une commande dont l'ordre EST
 * la difficulte.
 */
const VIEW_SUBMODE_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  secret: {
    name: 'secret', type: 'REST', literal: 'LINE',
    description: 'The password itself, or a digest already computed',
  },
  view: { name: 'membre', type: 'WORD', description: 'Name of the member view' },
  commands: [{
    name: 'mode', type: 'ENUM', description: 'Mode the commands belong to',
    values: [
      { keyword: 'exec', description: 'EXEC mode commands' },
      { keyword: 'configure', description: 'Global configuration commands' },
      { keyword: 'interface', description: 'Interface configuration commands' },
      { keyword: 'line', description: 'Line configuration commands' },
    ],
  }],
};

const VIEW_COMMANDS_KEYWORDS: ReadonlyArray<AdapterKeyword> = [
  {
    keyword: 'include', description: 'Add a command to the view',
    afterArguments: true,
    argument: { name: 'commande', type: 'REST', literal: 'LINE',
      description: 'The command, optionally preceded by `all`' },
  },
  {
    keyword: 'include-exclusive',
    description: 'Add a command to the view and reserve it for this view',
    afterArguments: true,
    argument: { name: 'commande', type: 'REST', literal: 'LINE',
      description: 'The command, optionally preceded by `all`' },
  },
  {
    keyword: 'exclude', description: 'Remove a command from the view',
    afterArguments: true,
    argument: { name: 'commande', type: 'REST', literal: 'LINE',
      description: 'The command, optionally preceded by `all`' },
  },
];


/*
 * Les declarations viennent de `ciscoArgumentHelp`, ou elles etaient
 * posees sur la trie privilegiee : les porter ici est ce qui les garde
 * VIVANTES, une declaration accrochee a un arbre vide ne decrivant plus
 * rien. Trois d'entre elles gagnent une place `REST` la ou le trie
 * annoncait un mot unique : le gestionnaire de `dir`, `verify` et
 * `delete` filtre les options en `/`, donc il en accepte plusieurs et
 * une place unique aurait refuse `dir /all flash:`.
 */
const FICHIER_CISCO = (nom: string, description: string): ArgumentSpec => ({
  name: nom, type: 'REST', literal: 'WORD', description,
});

/*
 * `disconnect` et `resume` NOMMENT leurs deux formes sans restreindre :
 * le gestionnaire lit un numero et repond lui-meme a ce qui n'en est
 * pas un (`disconnect all` rend « No information for this connection »,
 * ce qu'un test epingle), donc une place bornee refuserait au caret ce
 * que la machine accepte. Les deux libelles sont ceux qu'IOS ecrit.
 */
const CONNEXION_SORTANTE: ArgumentSpec = {
  name: 'connexion', type: 'REST', optional: true,
  description: 'Connection number or name',
  alternatives: [
    { keyword: '<1-16>', description: 'Connection number' },
    { keyword: 'WORD', description: 'Connection name' },
  ],
};

/*
 * Ce que ce lot prend de `registerCommonShowCommands`. Nommer les
 * chemins plutot que de tout collecter est ce qui laisse ses
 * DELEGATIONS — systeme de fichiers, sessions sortantes, EXEC du DNS —
 * la ou elles sont, migrees ou non.
 */
const SHOW_PARTAGEES: ReadonlySet<string> = new Set([
  'show interfaces counters errors', 'show mac address-table', 'terminal',
  'show ntp packets', 'show cdp', 'show lldp', 'show snmp', 'show parser view',
  'show hosts', 'show ip dns statistics', 'show ip vrf', 'show vrf',
  'show redundancy', 'show aaa',
]);
/*
 * `show adjacency` n'est PAS partagee : le commutateur en enregistre une
 * autre, plus riche (elle lit sa table ARP et connait `detail` et
 * `summary`), qui gagnait dans le trie parce qu'elle est declaree apres.
 * La declarer au socle la ferait perdre — mesure par
 * `cisco-switch-l3-referential`.
 */

const SHARED_SHOW_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'show snmp': { name: 'vue', type: 'REST', optional: true,
    description: 'SNMP detail to display' },
  'show hosts': null,
  'show adjacency': { name: 'reste', type: 'REST', optional: true,
    description: 'Adjacency detail to display' },
  'show ip dns statistics': null,
  'show interfaces counters errors': null,
  'show redundancy': null,
  'show aaa': { name: 'reste', type: 'REST', optional: true,
    description: 'AAA detail to display' },
  'show mac address-table': { name: 'filtre', type: 'REST', optional: true,
    description: 'Filter the MAC address table' },
  /*
   * La place est EXIGEE : `terminal` seul est declare incomplet par le
   * gestionnaire, et la place facultative de l'adaptateur ferait
   * annoncer `<cr>` a une commande qui ne s'ecrit jamais seule.
   */
  terminal: { name: 'reglage', type: 'REST', description: 'Terminal parameter to set' },
};

const SESSION_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  where: null,
  disconnect: CONNEXION_SORTANTE,
  resume: CONNEXION_SORTANTE,
  /*
   * La place est GLOUTONNE : les deux gestionnaires filtrent les options
   * en `-`, donc `ssh -l zoe 10.0.0.9` porte trois mots et une place
   * unique l'aurait refusee.
   */
  ssh: { name: 'hote', type: 'REST', literal: 'WORD',
    description: 'IP address or hostname of a remote system' },
  telnet: { name: 'hote', type: 'REST', literal: 'WORD',
    description: 'IP address or hostname of a remote system' },
};

const FILESYSTEM_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  dir: { ...FICHIER_CISCO('filesystem', 'Filesystem or directory to list'),
    optional: true },
  more: FICHIER_CISCO('file', 'File to display'),
  verify: FICHIER_CISCO('file', 'File to verify'),
  delete: FICHIER_CISCO('file', 'File to be deleted'),
  mkdir: FICHIER_CISCO('directory', 'Directory to create'),
  rmdir: FICHIER_CISCO('directory', 'Directory to remove'),
  squeeze: FICHIER_CISCO('filesystem', 'Filesystem to squeeze'),
  pwd: null,
};

const HTTP_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'ip http server': null,
  'ip http secure-server': null,
  'ip http port': { name: 'port', type: 'INT', description: 'Port the HTTP server listens on',
    range: [1, 65535] },
  'ip http secure-port': { name: 'port', type: 'INT',
    description: 'Port the HTTPS server listens on', range: [1, 65535] },
  'ip http max-connections': { name: 'nombre', type: 'REST',
    description: 'Number of concurrent connections allowed' },
  'ip http access-class': { name: 'liste', type: 'REST',
    description: 'Access list restricting who may connect',
    /*
     * La forme historique est NOMMEE et non bornee : le gestionnaire
     * accepte un nom comme un numero, et annoncer `<1-99>` promettrait
     * une plage que `probe-plage-annoncee-est-appliquee` ferait alors
     * appliquer — donc refuserait une liste nommee que la machine
     * accepte.
     */
    alternatives: [
      { keyword: 'WORD', description: 'Access list name or number' },
      { keyword: 'ipv4', description: 'IPv4 access list, then its name' },
    ] },
  'ip http authentication': { name: 'methode', type: 'REST',
    description: 'How the server authenticates a request' },
  'ip http timeout-policy': { name: 'reste', type: 'REST',
    description: '`idle`, `life` and `requests`, with their values' },
};

/*
 * `source-interface` est le seul mot que `ip domain-lookup` prenne, et
 * il etait declare par `registerSuggestions` sur le trie — donc perdu le
 * jour ou la famille a migre, l'elagage ayant lieu avant. Un mot-cle le
 * declare des deux cotes a la fois : l'aide l'annonce et l'analyse le
 * reconnait.
 */
const DOMAIN_LOOKUP_KEYWORDS: ReadonlyArray<AdapterKeyword> = [{
  keyword: 'source-interface', description: 'Source interface for packets',
  /*
   * `WORD` et non `IFACE` : c'est ce que le trie annoncait, et
   * `probe-cli-arguments-types` l'epingle — la place accepte un nom
   * d'interface abrege que le type `INTERFACE` refuserait.
   */
  argument: { name: 'interface', type: 'WORD',
    description: 'Interface used as the source address' },
}];

const DNS_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'ip domain-lookup': null,
  'ip domain lookup': null,
  'ip domain round-robin': null,
  'ip dns server': null,
  'ip domain-name': { name: 'nom', type: 'WORD', description: 'Default domain name' },
  'ip domain name': { name: 'nom', type: 'WORD', description: 'Default domain name' },
  'ip domain-list': { name: 'nom', type: 'WORD', description: 'Domain name to append to the list' },
  'ip domain list': { name: 'nom', type: 'WORD', description: 'Domain name to append to the list' },
  'ip domain retry': { name: 'essais', type: 'REST',
    description: 'Number of times a resolution is retried' },
  'ip domain timeout': { name: 'secondes', type: 'REST',
    description: 'Time waited for a resolution' },
  'ip dns spoofing': { name: 'adresse', type: 'REST',
    description: 'Address answered to every query' },
  'ip dns primary': { name: 'reste', type: 'REST',
    description: 'Zone, then `soa` with its name server and mailbox' },
  /*
   * Le gestionnaire prend PLUSIEURS serveurs — `setNameServers(args)` —
   * donc une place unique refuserait le second ; la premiere est typee
   * pour qu'`?` annonce `A.B.C.D` comme IOS, la suite est libre.
   */
  'ip name-server': [
    { name: 'adresse', type: 'IP_ADDR', description: 'Domain server IP address' },
    { name: 'reste', type: 'REST', optional: true,
      description: 'Further domain server addresses' },
  ],
  /*
   * `ip host <nom> <adresse>...` ou `ip host <nom> ns <adresse>` : le
   * gestionnaire exige deux mots, donc la seconde place n'est pas
   * facultative — sans quoi `ip host ?` annonce `<cr>` pour une frappe
   * que la meme machine declare incomplete.
   */
  'ip host': [
    { name: 'nom', type: 'WORD', description: 'Name of host' },
    /*
     * La seconde place est FACULTATIVE alors que le gestionnaire exige
     * deux mots, et c'est la NEGATION qui l'impose : `no ip host r2` ne
     * prend qu'un nom, et la negation reprend les places de la forme
     * positive. La rendre exigee faisait repondre « Incomplete » a une
     * suppression parfaitement formee. `ip host ?` n'annonce pas `<cr>`
     * pour autant, le NOM etant exige.
     */
    { name: 'reste', type: 'REST', optional: true,
      description: 'Host addresses, or `ns` then the name server address' },
  ],
};

/*
 * Les sortes de ligne, et jusqu'ou chacune est numerotee.
 *
 * Un chassis a UNE console et UNE auxiliaire — IOS annonce `<0-0>` pour
 * les deux — et seize terminaux virtuels, `<0-15>`, ce que la
 * documentation Cisco donne comme le maximum par defaut d'IOS moderne.
 * `tty` prend la meme borne faute d'une reference propre : ce simulateur
 * n'a aucune ligne asynchrone, donc la borne exacte n'y est pas
 * observable, et l'ancienne — aucune — etait la seule certainement
 * fausse.
 */
const SORTES_DE_LIGNE: Readonly<Record<string, {
  canonique: 'console' | 'vty' | 'aux' | 'tty'; max: number; description: string;
}>> = {
  aux: { canonique: 'aux', max: 0, description: 'Auxiliary line' },
  con: { canonique: 'console', max: 0, description: 'Primary terminal line' },
  console: { canonique: 'console', max: 0, description: 'Primary terminal line' },
  tty: { canonique: 'tty', max: 15, description: 'Terminal controller' },
  vty: { canonique: 'vty', max: 15, description: 'Virtual terminal' },
};

type TeteLigne =
  | { sorte: 'console' | 'vty' | 'aux' | 'tty'; premiere: number; derniere: number }
  | { erreur: string };

/**
 * La designation d'une ligne, lue UNE fois pour `line` et pour `no line`.
 *
 * Les deux commandes en avaient chacune leur lecture, et elles avaient
 * diverge jusqu'a l'absurde : `no line` verifiait la sorte, exigeait un
 * numero, le voulait entier et refusait une plage a l'envers, quand
 * `line` n'examinait rien du tout — `line zorglub`, `line vty` seul,
 * `line vty 99`, `line vty zorglub` et `line vty 5 2` etaient tous
 * acceptes et faisaient entrer dans le sous-mode. L'operateur pouvait
 * donc poser une plage que la negation refusait ensuite de retirer, et
 * taper ses reglages d'acces dans un sous-mode qui ne designait aucune
 * ligne.
 */
function analyserTeteLigne(args: readonly string[]): TeteLigne {
  const mot = (args[0] ?? '').toLowerCase();
  if (mot === '') return { erreur: CISCO_ERRORS.INCOMPLETE };
  const sorte = SORTES_DE_LIGNE[mot];
  if (!sorte) throw new CliInvalidInput({ token: args[0] });
  if (args[1] === undefined) return { erreur: CISCO_ERRORS.INCOMPLETE };

  const borne = (jeton: string): number => {
    if (!/^\d+$/.test(jeton)) throw new CliInvalidInput({ token: jeton });
    const valeur = Number.parseInt(jeton, 10);
    if (valeur > sorte.max) throw new CliInvalidInput({ token: jeton });
    return valeur;
  };
  const premiere = borne(args[1]);
  const derniere = args[2] === undefined ? premiere : borne(args[2]);
  if (derniere < premiere) throw new CliInvalidInput({ token: args[2] as string });
  if (args[3] !== undefined) throw new CliInvalidInput({ token: args[3] });
  return { sorte: sorte.canonique, premiere, derniere };
}

const IDENTITE_ET_AMORCAGE: ReadonlySet<string> = new Set([
  'boot system', 'boot enable-break', 'boot manual', 'config-register',
  'hostname', 'enable secret', 'enable algorithm-type', 'enable password',
]);

const ALGORITHM_TYPE_PLACES: readonly ArgumentSpec[] = [
  {
    name: 'algorithm', type: 'ENUM', description: 'Algorithm to hash the secret with',
    values: [
      { keyword: 'md5', description: 'Select MD5 as the hashing algorithm' },
      { keyword: 'scrypt', description: 'Select scrypt as the hashing algorithm' },
      { keyword: 'sha256', description: 'Select PBKDF2 with SHA256 as the hashing algorithm' },
    ],
  },
  {
    name: 'kind', type: 'ENUM', description: 'What to set',
    values: [{ keyword: 'secret', description: 'Assign the privileged level secret' }],
  },
  { name: 'secret', type: 'LINE', description: 'The UNENCRYPTED (cleartext) enable secret' },
];

const IDENTITE_PLACES:
  Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[]>> = {
  hostname: { name: 'nom', type: 'WORD', description: 'This system\'s network name' },
  'config-register': {
    name: 'valeur', type: 'WORD', description: 'Config register value, in hex',
  },
  'boot system': {
    name: 'image', type: 'REST', description: 'System image file', literal: 'WORD',
  },
  'enable secret': {
    name: 'reste', type: 'REST',
    description: 'Assign the privileged level secret', literal: 'LINE',
  },
  'enable password': {
    name: 'reste', type: 'REST',
    description: 'Assign the privileged level password', literal: 'LINE',
  },
  'enable algorithm-type': ALGORITHM_TYPE_PLACES,
};

type HardeningEntry = readonly [
  readonly string[], string, string,
  (sec: ReturnType<typeof getSecurityConfig>, on: boolean) => void,
];

const IOS_HARDENING: readonly HardeningEntry[] = [
  [['ip', 'source-route'], 'Accept source-routed packets',
    'Drop source-routed packets', (sec, on) => { sec.ipSourceRoute = on; }],
  [['ip', 'bootp', 'server'], 'Enable BOOTP server',
    'Disable BOOTP server', (sec, on) => { sec.ipBootpServer = on; }],
  [['ip', 'gratuitous-arps'], 'Send gratuitous ARP',
    'Stop sending gratuitous ARP', (sec, on) => { sec.ipGratuitousArps = on; }],
  [['ip', 'finger'], 'Enable finger service',
    'Disable finger service', (sec, on) => { sec.ipFinger = on; }],
];

export abstract class CiscoShellBase<TDevice extends CiscoDevice> {
  // ─── State ───────────────────────────────────────────────────────
  protected mode: string = 'user';
  /**
   * Le niveau 0-15 de la session. `mode` reste une machine a etats plus
   * simple, qui choisit l'arbre ; ce champ-ci est la seule source de
   * verite pour `show privilege`, l'escalade par `enable N` et le
   * filtrage par `privilege exec level N`. Ce que l'INVITE affiche est
   * decide par `buildDevicePrompt` seul.
   */
  protected currentPrivilegeLevel: number = 1;
  /** Recent commands for `show history` (shared switch + router). */
  protected cmdHistory: string[] = [];
  protected deviceRef: TDevice | null = null;

  /**
   * Config-driven global feature state (cdp/lldp/ip routing…) — a real
   * Repository the CLI mutates and `show` projects (no silent no-ops).
   */
  protected get configState(): CiscoConfigState {
    return getConfigState(this.d() as object);
  }

  /** Config-driven CLI aliases — real, working, projected by show. */
  protected readonly aliases = new AliasRepository();

  /** Config-driven syslog/logging state, projected by `show logging`. */
  protected readonly logging = new LoggingConfig();
  protected readonly outgoingSessions = new OutgoingSessionRegistry();
  private reloadTimer: TimerHandle | null = null;
  private scheduledReloadAtMs: number | null = null;

  private schedulerFor(device: TDevice): IScheduler {
    const dev = device as unknown as { getScheduler?: () => IScheduler };
    return dev.getScheduler?.() ?? getDefaultScheduler();
  }

  private armReloadTimer(ms: number): void {
    const device = this.d();
    const scheduler = this.schedulerFor(device);
    if (this.reloadTimer !== null) scheduler.clear(this.reloadTimer);
    this.scheduledReloadAtMs = Date.now() + ms;
    this.reloadTimer = scheduler.setTimeout(() => {
      this.reloadTimer = null;
      this.scheduledReloadAtMs = null;
      this.performScheduledReload(device);
    }, ms);
  }

  protected getScheduledReloadMs(): number | null {
    return this.scheduledReloadAtMs;
  }

  /**
   * La ROM lit le registre de configuration AU DÉMARRAGE — c'est tout le
   * sens de `(will be 0x2142 at next reload)`. La valeur préparée devient
   * donc la valeur courante ici, et nulle part ailleurs : l'appliquer à la
   * frappe ferait ignorer `nvram:` tout de suite, ce qu'aucun IOS ne fait,
   * et la manœuvre de récupération de mot de passe n'aurait plus de sens.
   */
  protected adoptPendingConfigRegister(device: TDevice): void {
    const avant = this.deviceRef;
    this.deviceRef = device;
    this.fs().applyPendingConfigRegister();
    this.deviceRef = avant;
  }

  /** Vrai quand le registre demande d'ignorer `nvram:` au démarrage (bit 0x40). */
  protected bootIgnoresStartupConfig(device: TDevice): boolean {
    const avant = this.deviceRef;
    this.deviceRef = device;
    const ignore = this.fs().ignoreStartupConfig();
    this.deviceRef = avant;
    return ignore;
  }

  protected performImmediateReload(): string {
    // Le tampon est en mémoire vive : il part avec le redémarrage, et
    // `logging reload` décide de ce qui est journalisé pendant celui-ci.
    this.attachLoggingToDevice(this.d());
    this.logging.startReload();
    this.adoptPendingConfigRegister(this.d());
    this.d().powerOff();
    this.d().powerOn();
    this.logging.noteRestart();
    this.reinitialiserSessionApresRedemarrage();
    this.terminalMonitor = false;
    this.cmdHistory = [];
    this.aliases.reset();
    this.debugConsole.length = 0;
    (this.d() as unknown as { getDebugService?: () => { disableAll?: () => void } }).getDebugService?.().disableAll?.();
    return 'Proceed with reload? [confirm]\nReload requested.\nSystem restarting...';
  }

  protected performScheduledReload(device: TDevice): void {
    this.attachLoggingToDevice(device);
    this.logging.startReload();
    this.adoptPendingConfigRegister(device);
    device.powerOff();
    device.powerOn();
    this.logging.noteRestart();
    this.reinitialiserSessionApresRedemarrage();
    this.terminalMonitor = false;
    this.cmdHistory = [];
    this.debugConsole.length = 0;
    (device as unknown as { getDebugService?: () => { disableAll?: () => void } }).getDebugService?.().disableAll?.();
  }

  /**
   * Une machine qui redemarre repart en EXEC UTILISATEUR.
   *
   * Les deux redemarrages ne posaient que `mode`, et c'est le meme
   * oubli que `exit` avait : `show privilege` et `modeDeRetour` lisent
   * `currentPrivilegeLevel`, pas `mode`. Un routeur qui venait de
   * redemarrer repondait donc `Current privilege level is 15` — et le
   * mode privilegie revenait de lui-meme des la premiere sortie de
   * configuration, sans que le secret d'activation soit redemande.
   */
  protected reinitialiserSessionApresRedemarrage(): void {
    this.mode = 'user';
    this.fsm.mode = 'user';
    this.clearSocleFields(Object.keys(this.socleFields));
    this.currentPrivilegeLevel = 1;
    this.activeParserView = null;
  }

  protected attachLoggingToDevice(device: TDevice): void {
    (device as unknown as { _loggingConfig?: LoggingConfig })._loggingConfig = this.logging;
    // A timestamp has to come from the machine it dates: its own boot
    // counter, its own `clock set` clock, its own `clock timezone`, and
    // its own NTP state for the `*` marker. A switch carries none of the
    // last three and takes the defaults.
    this.logging.attachClockSource(deviceClockSource(device));
    this.attacherPolitiqueDeConnexion(device);
  }

  /**
   * `login on-success log` / `login on-failure log` gouvernent pour de
   * bon : sans elles, une vraie machine ne journalise NI l'une NI
   * l'autre.
   *
   * La politique est LUE a chaque message plutot que copiee, pour qu'une
   * commande tapee apres l'attache prenne effet sur la connexion
   * suivante ; et elle est posee des l'attache au BUS plutot que dans
   * `attachLoggingToDevice`, qui n'est appele que sur les chemins de
   * redemarrage — donc presque jamais. Attachee la, la porte restait
   * fermee sur une machine qui venait pourtant de taper la commande.
   */
  protected attacherPolitiqueDeConnexion(device: unknown): void {
    if (!device) return;
    this.logging.attachLoginLoggingPolicy({
      logSuccess: () => getSecurityConfig(device as object).login.onSuccessLog === true,
      logFailure: () => getSecurityConfig(device as object).login.onFailureLog === true,
    });
  }

  attachLoggingToBus(
    bus: import('@/events/EventBus').IEventBus, deviceId: string, device?: unknown,
  ): void {
    this.logging.attachToBus(bus, deviceId);
    this.attacherPolitiqueDeConnexion(device);
  }

  getLoggingConfig(): LoggingConfig {
    return this.logging;
  }

  /**
   * Ce dont les commandes `logging` ont besoin de la coquille, et rien de
   * plus : la configuration, son rattachement à l'horloge de la machine,
   * et le reprovisionnement de l'agent syslog. Le même contexte sert au
   * routeur et au commutateur, qui ne peuvent donc pas diverger sur ce
   * que la même commande fait.
   */
  protected loggingCommandContext(): LoggingCommandContext {
    return {
      config: () => this.logging,
      beforeApply: () => {
        this.attachLoggingToDevice(this.d());
        // Le journal persistant écrit dans le `flash:` de l'équipement —
        // le MÊME objet que `dir` et `more` lisent, pas une copie, sinon
        // `logging persistent` produirait des fichiers que nul ne voit.
        this.logging.attachFileStore({
          write: (name, content) => { this.fs().write(name, content); },
          read: (name) => this.fs().get(name)?.content ?? null,
          remove: (name) => this.fs().remove(name),
          list: (prefix) => this.fs().list()
            .map(f => f.name).filter(n => n.startsWith(prefix)),
        });
      },
      afterApply: () => { this.syncSyslogAgent(); },
    };
  }

  /** Async escape hatch: commands that return a Promise (e.g. ping on routers) */
  protected _pendingAsync: Promise<string> | null = null;

  /**
   * Per-vty pager / display preferences. Real Cisco IOS stores these on
   * the line, not on the device: each vty (and the console) has its own
   * `terminal length` (24 default) and `terminal width` (80 default).
   * `terminal length 0` disables the pager for the current session.
   *
   * These fields exist on the shared shell so `terminal length N` has a
   * real handler, but they rotate per-session via snapshotVtyState /
   * applyVtyState. See terminal_gap.md §5.3/§5.4.
   */
  protected terminalLength: number = 24;
  protected terminalWidth: number = 80;
  protected terminalHistorySize: number = HISTORIQUE_PAR_DEFAUT;
  protected terminalHistoryEnabled: boolean = true;

  protected selectedConsoleLine: number | null = null;
  protected consoleLinePassword: string | null = null;
  protected consoleLinePasswordEncrypted: boolean = false;
  protected consoleLineLogin: 'password' | 'local' | 'none' | 'aaa' | null = null;
  /**
   * La liste de methodes nommee d'un `login authentication <nom>` pose
   * sur la console. C'est la ligne de secours de toute activation d'AAA :
   * elle garde la console sur la base LOCALE, pour qu'un serveur TACACS+
   * en panne ne ferme pas la porte. Elle etait acceptee, comprise comme
   * un `login` nu, et rendue nulle part — donc perdue au rechargement,
   * ce qui est precisement le cas dangereux.
   */
  protected consoleLineLoginAuthList: string | null = null;
  /**
   * Le niveau de la ligne console vit sur l'EQUIPEMENT : ces deux
   * accesseurs sont la seule voie, pour qu'aucun shell ne puisse en
   * garder une copie a lui.
   */
  protected consolePrivilegeLevel(): number | null;
  protected consolePrivilegeLevel(level: number | null): void;
  protected consolePrivilegeLevel(level?: number | null): number | null | void {
    const dev = this.deviceRef as unknown as {
      getConsoleLinePrivilege?: () => number | null;
      _setConsoleLinePrivilege?: (l: number | null) => void;
    } | null;
    if (level === undefined) return dev?.getConsoleLinePrivilege?.() ?? null;
    dev?._setConsoleLinePrivilege?.(level);
  }
  protected consoleLineExecTimeoutMin: number | null = null;
  protected consoleLineExecTimeoutSec: number = 0;
  protected consoleLineLoggingSynchronous: boolean = false;
  /**
   * `history size N` sous `line console 0` — le DEFAUT des sessions
   * ouvertes sur cette ligne, distinct de `terminal history size` qui ne
   * vaut que pour la session en cours. Les deux existaient et n'etaient
   * relies a rien : la valeur de ligne etait jetee par la branche
   * console, celle de session etait figee a 10 dans l'instantane, et le
   * shell lisait un troisieme champ que personne n'ecrivait.
   */
  protected consoleLineHistorySize: number | null = null;
  protected consoleLineHistoryEnabled: boolean = true;

  /**
   * Le numero de serie du chassis, derive de l'identifiant de CETTE
   * machine. Quatre vues l'ecrivaient en dur (`show platform`,
   * `show license udi`, `show diag`, `show inventory`), donc toute une
   * topologie etait un troupeau de jumeaux.
   */
  protected numeroDeSerie(): string {
    return chassisSerial(
      CISCO_HARDWARE_PROFILES[this.getChassisProfile()],
      (this.deviceRef as unknown as { id?: string } | null)?.id ?? 'unknown');
  }

  /** La taille par defaut d'une session ouverte sur cette ligne. */
  protected tailleHistoriqueDeLigne(): number {
    if (!this.consoleLineHistoryEnabled) return 0;
    return this.consoleLineHistorySize ?? HISTORIQUE_PAR_DEFAUT;
  }

  // `line aux 0` — real storage for `no exec` / `transport input`, which
  // used to be silently swallowed (any directive typed under the AUX
  // sub-mode fell through the console/VTY branches and was dropped).
  protected selectedAuxLine: number | null = null;
  protected auxLineNoExec: boolean = false;
  protected auxLineTransportInput: 'ssh' | 'telnet' | 'all' | 'none' | null = null;

  _getAliasRunningConfigLines(): string[] {
    return this.aliases.toRunningConfig();
  }

  _getConsoleLineConfig(): {
    line: number;
    password: string | null;
    passwordEncrypted: boolean;
    login: 'password' | 'local' | 'none' | 'aaa' | null;
    loginAuthList: string | null;
    privilegeLevel: number | null;
    execTimeoutMin: number | null;
    execTimeoutSec: number;
    loggingSynchronous: boolean;
    historySize: number | null;
    historyEnabled: boolean;
  } | null {
    if (this.consoleLinePassword == null && this.consoleLineLogin == null
      && this.consolePrivilegeLevel() == null && this.consoleLineExecTimeoutMin == null
      && !this.consoleLineLoggingSynchronous
      && this.consoleLineHistorySize == null && this.consoleLineHistoryEnabled) return null;
    return {
      line: this.selectedConsoleLine ?? 0,
      password: this.consoleLinePassword,
      passwordEncrypted: this.consoleLinePasswordEncrypted,
      login: this.consoleLineLogin,
      loginAuthList: this.consoleLineLoginAuthList,
      privilegeLevel: this.consolePrivilegeLevel(),
      execTimeoutMin: this.consoleLineExecTimeoutMin,
      execTimeoutSec: this.consoleLineExecTimeoutSec,
      loggingSynchronous: this.consoleLineLoggingSynchronous,
      historySize: this.consoleLineHistorySize,
      historyEnabled: this.consoleLineHistoryEnabled,
    };
  }

  _getAuxLineConfig(): { line: number; noExec: boolean; transportInput: 'ssh' | 'telnet' | 'all' | 'none' | null } | null {
    if (!this.auxLineNoExec && this.auxLineTransportInput == null) return null;
    return {
      line: this.selectedAuxLine ?? 0,
      noExec: this.auxLineNoExec,
      transportInput: this.auxLineTransportInput,
    };
  }
  protected terminalMonitor = false;
  /** Set once `terminal [no] monitor` has been typed on this line. */
  protected terminalMonitorExplicit = false;
  protected readonly debugConsole: string[] = [];
  private debugSourceAttached = false;
  private offDebugSource: (() => void) | null = null;
  private asyncOutputLive = false;

  receivesAsyncOutput(): { debug: boolean; syslog: boolean } {
    return { debug: this.terminalMonitor, syslog: this.terminalMonitor };
  }

  setAsyncOutputLive(live: boolean): void {
    this.asyncOutputLive = live;
    if (live) this.debugConsole.length = 0;
  }

  protected attachDebugSource(src?: { subscribe(listener: (line: string) => void): () => void } | null): void {
    if (this.debugSourceAttached || !src) return;
    this.debugSourceAttached = true;
    this.offDebugSource = src.subscribe((line) => {
      if (!this.terminalMonitor || this.asyncOutputLive) return;
      this.debugConsole.push(line);
      if (this.debugConsole.length > 500) this.debugConsole.shift();
    });
  }

  /**
   * The debug registry is the device's and outlives any one line, so a
   * shell that goes away has to take its listener with it. A VTY mints a
   * fresh shell per session; without this, every SSH login left one more
   * dead listener on the router for as long as it stayed powered on.
   */
  releaseDebugSource(): void {
    this.offDebugSource?.();
    this.offDebugSource = null;
    this.debugSourceAttached = false;
    this.debugConsole.length = 0;
  }

  protected drainDebugConsole(): string {
    if (this.debugConsole.length === 0) return '';
    const out = this.debugConsole.join('\n');
    this.debugConsole.length = 0;
    return out;
  }

  // ─── FSM ─────────────────────────────────────────────────────────
  protected abstract readonly fsm: CLIStateMachine;

  // ─── Command Tries (common modes) ───────────────────────────────
  enumerateAllCommandPaths(): string[] {
    const seen = new Set<string>();
    for (const value of Object.values(this as unknown as Record<string, unknown>)) {
      if (!(value instanceof CommandTrie)) continue;
      for (const path of value.enumerateCommandPaths()) seen.add(path);
    }
    return [...seen];
  }

  /**
   * Les chemins qu'un trie EXECUTE, par opposition a ceux qu'il porte.
   *
   * Un noeud intermediaire n'execute rien : le compter comme une commande
   * gonfle l'inventaire, et le compter comme un second moteur ferait
   * echouer le garde-fou de migration sur un noeud que l'elagage laisse
   * volontairement debout pour ses enfants non migres.
   */
  enumerateAllExecutablePaths(): string[] {
    const seen = new Set<string>();
    for (const value of Object.values(this as unknown as Record<string, unknown>)) {
      if (!(value instanceof CommandTrie)) continue;
      for (const path of value.enumerateExecutablePaths()) seen.add(path);
    }
    return [...seen];
  }

  protected userTrie = new CommandTrie();
  protected privilegedTrie = new CommandTrie();
  protected configTrie = new CommandTrie();
  protected configIfTrie = new CommandTrie();
  /** Shared `line …` sub-mode trie (switch + router). */
  protected configLineTrie = new CommandTrie();
  /** `parser view <nom>` — le sous-mode qui declare une vue CLI. */
  protected configViewTrie = new CommandTrie();
  /** La vue en cours de declaration sous `parser view …`. */
  protected selectedParserView: string | null = null;
  /**
   * La vue ACTIVE de cette session, ou null pour la vue racine.
   *
   * C'est une propriete de la SESSION et non de l'equipement : deux vty
   * peuvent etre dans deux vues differentes au meme instant, et une vue
   * posee sur l'une ne doit rien changer a l'autre. C'est la meme lecon
   * que `terminal monitor`, qui etait a tort un booleen d'equipement.
   */
  protected activeParserView: string | null = null;
  /** Currently-selected VTY range under `line vty <first> [last]`. */
  protected selectedVtyRange: { first: number; last: number } | null = null;

  /**
   * Une ligne console/aux est un PORT SÉRIE, une vty est une session
   * réseau : les deux ne portent pas les mêmes réglages. Un seul arbre
   * les servait, donc `speed 9600` était accepté sur une vty (qui n'a
   * pas de débit) et `access-class` sur la console (qui n'a pas
   * d'adresse d'où filtrer). `databits`, `parity` et `flowcontrol`
   * manquaient entièrement, alors qu'ils existent là où ils ont un sens.
   *
   * Table unique : le gestionnaire la lit pour refuser, l'aide pour ne
   * pas proposer.
   */
  private static readonly LINE_KEYWORD_OWNERS:
    ReadonlyMap<string, ReadonlyArray<'console' | 'vty' | 'aux'>> = new Map([
      ['speed', ['console', 'aux']],
      ['databits', ['console', 'aux']],
      ['stopbits', ['console', 'aux']],
      ['parity', ['console', 'aux']],
      ['flowcontrol', ['console', 'aux']],
      ['access-class', ['vty']],
      ['rotary', ['vty', 'aux']],
    ]);

  protected currentLineKind(): 'console' | 'vty' | 'aux' | null {
    if (this.selectedVtyRange) return 'vty';
    if (this.selectedAuxLine != null) return 'aux';
    if (this.selectedConsoleLine != null) return 'console';
    return null;
  }

  protected lineKeywordAllowed(keyword: string): boolean {
    const owners = CiscoShellBase.LINE_KEYWORD_OWNERS.get(keyword.toLowerCase());
    if (!owners) return true;
    const kind = this.currentLineKind();
    return kind === null || owners.includes(kind);
  }

  private requireLineKind(keyword: string): void {
    if (!this.lineKeywordAllowed(keyword)) throw new CliInvalidInput();
  }

  // ─── Abstract hooks (Template Method) ───────────────────────────

  /** Return the CommandTrie for the current mode */
  protected abstract getActiveTrie(): CommandTrie;

  executablePathsInCurrentMode(): string[] {
    return this.getActiveTrie().enumerateExecutablePaths();
  }

  commandPathsInCurrentMode(): string[] {
    return this.getActiveTrie().enumerateCommandPaths();
  }

  derivedContinuationsInCurrentMode(): string[] {
    return this.getActiveTrie().enumerateDerivedContinuations();
  }

  undescribedContinuationsInCurrentMode(): string[] {
    return this.getActiveTrie().enumerateUndescribedContinuations();
  }

  /** Clear state fields when FSM exits a mode (e.g. selectedInterface) */
  protected abstract clearFields(fields: string[]): void;

  /** Prompt template map for this device type */
  protected abstract getPromptMap(): PromptMap;

  /** Optional: called on 'write memory' / 'copy running-config startup-config' */
  protected abstract onSave(): string;

  /**
   * `archive` + `write-memory` : une sauvegarde archive la
   * configuration. Le mot-clé était mémorisé et lu par personne, donc
   * l'archivage automatique — la raison d'être de la fonction — ne se
   * produisait jamais. Appelé par le `onSave()` des deux shells.
   */
  protected archiveAfterSave(): void {
    archiveOnWriteMemory(
      () => this.archiveService(),
      () => (this.d() as unknown as { getRunningConfig?: () => string }).getRunningConfig?.() ?? '',
    );
  }

  /**
   * Le service d'archivage de l'équipement, avec SON `flash:` branché.
   *
   * Le branchement se fait ici et pas dans le constructeur de
   * l'appareil, parce que le profil châssis n'est connu que du shell ;
   * `this.fs()` rend désormais le système de fichiers de la MACHINE,
   * partagé par toutes ses sessions : c'est le même objet que
   * `dir flash:` et `more flash:` lisent, donc une archive écrite est
   * une archive que ces commandes voient. Deux systèmes de fichiers
   * distincts feraient de `show archive` un catalogue de fichiers
   * introuvables.
   */
  protected archiveService(): import('../router/archive/ArchiveService').ArchiveService | undefined {
    const s = (this.d() as unknown as {
      getArchiveService?: () => import('../router/archive/ArchiveService').ArchiveService;
    }).getArchiveService?.();
    if (s && !s.hasStorage()) {
      s.attachStorage(this.fs());
      // `$h` dans `archive path` est le nom de la MACHINE : sans cette
      // source, le chemin gardait la variable telle quelle et le fichier
      // s'appelait littéralement `$h-config-1`.
      s.attachHostname(() => this.d().getHostname());
    }
    return s;
  }

  /**
   * Called on 'erase startup-config' / 'write erase' / 'erase nvram:'.
   * Subclasses that keep a shell-level saved-config snapshot MUST clear it
   * here, so `show startup-config` reflects the erase. The base default
   * only clears the device-level snapshot; overrides should call super.
   */
  protected onErase(): void {
    (this.d() as unknown as { _eraseStartupConfig?: () => void })._eraseStartupConfig?.();
  }

  /** Register device-specific commands on the tries (called from constructor) */
  protected abstract registerDeviceCommands(): void;

  // ─── Command-owned interactive flows (IoC) ───────────────────────

  /**
   * Declare the interactive dialogue of the commands this shell owns.
   * The terminal renders the plan; the plan's run steps execute the REAL
   * device commands through the session's normal path. Matching goes
   * through the privileged trie, so every IOS keyword abbreviation the
   * device accepts ("era sta", "wr er", "cop run star") is honored — no
   * string comparisons in the terminal layer.
   */
  interactionPlanFor(
    commandLine: string,
    ctx?: InteractionPlanContext,
  ): CommandInteractionPlan | null {
    const mode = ctx?.mode ?? 'privileged';
    const line = commandLine.trim();
    if (!line) return null;

    if (!this.commandVisibleTo(line, mode, ctx)) return null;

    // `enable` vit dans les DEUX EXEC depuis qu'elle n'a plus qu'une
    // declaration, donc sa porte aussi : `enable 7` tape depuis `#`
    // traverse le meme secret que depuis `>`. `enable view [<nom>]` a la
    // sienne — le secret de la vue, ou celui d'activation pour la
    // racine — et la laisser tomber dans le plan d'`enable` faisait
    // echouer `parseInt('view')`, donc aucun plan et aucune
    // verification.
    if (mode === 'user' || mode === 'privileged') {
      const em = this.resoudreEnable(line);
      if (em?.vue === true) return this.enableViewInteractionPlan(em.args, ctx?.device);
      if (em) {
        return this.enableInteractionPlan(em.args, ctx?.device, ctx?.onVtyLine === true);
      }
    }
    if (mode === 'user') return null;

    // Config-mode dialogue: `banner <kind> <delim>` with nothing after the
    // delimiter opens real IOS's multi-line capture (lines accumulate
    // until one contains the delimiter). The single-line
    // `banner <kind> <delim>TEXT<delim>` form stays synchronous in the
    // config-trie handler.
    if (mode === 'config') {
      const bm = /^banner\s+(motd|login|exec|incoming)\s+(\S)\s*$/i.exec(line);
      if (bm) {
        return this.bannerCaptureInteractionPlan(
          bm[1].toLowerCase() as 'motd' | 'login' | 'exec' | 'incoming', bm[2], ctx?.device,
        );
      }
      return null;
    }

    if (mode !== 'privileged') return null;

    const m = this.privilegedTrie.match(line);
    // Une commande MIGREE n'est plus dans le trie, donc `match` ne la
    // reconnait plus : sans ce repli, `erase startup-config` perdait son
    // dialogue `[confirm]` le jour de sa migration.
    const migre = m.status === 'ok' && m.node
      ? null : this.cheminCanoniqueDuSocle(`${line} `, mode);
    if (migre === null && (m.status !== 'ok' || !m.node)) return null;
    const path = (migre ?? m.matchedKeywords).join(' ').toLowerCase();

    if (path === 'setup') {
      const target = (ctx?.device ?? this.deviceRef) as unknown as {
        getHostname?: () => string;
      } | null;
      return setupInteractionPlan({
        hostname: target?.getHostname?.() ?? 'Router',
        interfaceNames: this.setupConfigurableInterfaces(ctx?.device),
      });
    }
    if (path === 'erase startup-config' || path === 'write erase' || path === 'erase nvram:') {
      return this.eraseInteractionPlan();
    }
    if (path === 'reload' && m.args.length === 0) {
      return this.reloadInteractionPlan();
    }
    if (path === 'debug all') {
      return {
        steps: [
          {
            kind: 'confirmation',
            prompt: 'This may severely impact network performance. Continue? (yes/[no]):',
            defaultAnswer: 'no',
            storeAs: 'debug_all_confirmed',
          },
          {
            kind: 'run',
            run: async (rt) => {
              const answer = (rt.values.get('debug_all_confirmed') ?? 'no').toLowerCase();
              if (answer.startsWith('y')) rt.output(await rt.exec('debug all'));
            },
          },
        ],
      };
    }
    if (path === 'clear ip ospf' && m.args[0]?.toLowerCase() === 'process') {
      return {
        steps: [
          {
            kind: 'confirmation',
            prompt: 'Reset ALL OSPF processes? [no]:',
            defaultAnswer: 'no',
            storeAs: 'ospf_reset_confirmed',
          },
          { kind: 'run', run: async (rt) => { await rt.exec('clear ip ospf process'); } },
        ],
      };
    }
    if (path === 'send') {
      const cible = this.cibleDeSend(m.args);
      if (cible === null) return { steps: [{ kind: 'output', lines: [CISCO_ERRORS.INVALID_INPUT] }] };
      if (cible === 'incomplet') {
        return { steps: [{ kind: 'output', lines: [CISCO_ERRORS.INCOMPLETE] }] };
      }
      return this.sendInteractionPlan(cible, ctx?.device);
    }
    if (path === 'copy' && m.args.length === 2) {
      const norm = (a: string): string => {
        const t = a.toLowerCase();
        if (t && 'running-config'.startsWith(t)) return 'running-config';
        if (t && 'startup-config'.startsWith(t)) return 'startup-config';
        return t;
      };
      if (norm(m.args[0]) === 'running-config' && norm(m.args[1]) === 'startup-config') {
        return this.copyRunStartInteractionPlan();
      }
    }
    return null;
  }

  /**
   * `send {line-number | * | aux n | console n | tty n | vty n}` — porter
   * un message a une session vivante.
   *
   * La commande n'existait pas du tout : `send` tombait dans le
   * rattrapage « mot inconnu » et partait en RESOLUTION DNS
   * (`Translating "send"...domain server`), c'est-a-dire que la machine
   * prenait le nom d'une de ses propres commandes pour un nom d'hote.
   *
   * Note de syntaxe, verifiee sur la reference Cisco : la forme est
   * `send *` pour toutes les lignes et `send vty 0` pour une ligne — les
   * orthographes `send all` et `send line vty 0` qu'on lit dans les
   * supports de cours n'existent sur aucune machine, et les accepter
   * apprendrait une commande que le materiel refuse.
   */
  /**
   * `null` = ce mot-la ne convient pas ; `'incomplet'` = il en manque un.
   *
   * `send vty` etait refuse au caret alors que son aide venait de
   * proposer `vty` : il manquait seulement le rang de la ligne, ce
   * qu'IOS dit par « % Incomplete command. ». Les deux reponses etaient
   * confondues parce que la fonction n'avait qu'une facon d'echouer.
   */
  private cibleDeSend(args: string[]): 'all' | number | 'incomplet' | null {
    const a = args.map((x) => x.toLowerCase()).filter((x) => x.length > 0);
    if (a.length === 0) return 'incomplet';
    if (a[0] === '*') return a.length === 1 ? 'all' : null;
    if (a[0] === 'vty' || a[0] === 'tty' || a[0] === 'aux' || a[0] === 'console' || a[0] === 'con') {
      if (a.length === 1) return 'incomplet';
      const n = Number.parseInt(a[1] ?? '', 10);
      if (!Number.isInteger(n) || n < 0 || a.length > 2) return null;
      // La console et l'AUX sont les lignes 0 et 1 ; une vty prend son rang.
      return a[0] === 'console' || a[0] === 'con' ? 0 : n;
    }
    const n = Number.parseInt(a[0], 10);
    if (!Number.isInteger(n) || n < 0 || a.length > 1) return null;
    return n;
  }

  private sendInteractionPlan(cible: 'all' | number, deviceCtx?: unknown): CommandInteractionPlan {
    return {
      steps: [
        { kind: 'output', lines: ['Enter message, end with CTRL/Z; abort with CTRL/C:'] },
        {
          kind: 'collect',
          prompt: '',
          storeAs: 'send_message',
          // IOS termine la saisie sur Ctrl-Z. Le terminal rend cette
          // frappe par `^Z` sur la ligne, donc c'est ce mot qui clot —
          // et la ligne qui le porte n'entre pas dans le message.
          accept: (ligne, accumulees) => {
            const fin = /\^Z\s*$/i.test(ligne) || ligne.trim() === '\u001a';
            if (!fin) return { done: false };
            const reste = ligne.replace(/\^Z\s*$/i, '');
            const corps = [...accumulees, ...(reste.trim() ? [reste] : [])];
            return { done: true, body: corps.join('\n') };
          },
        },
        {
          kind: 'run',
          run: async (rt) => {
            const corps = rt.values.get('send_message') ?? '';
            // L'appareil est capture a la CONSTRUCTION du plan : `this.d()`
            // n'est valide que pendant `execute`, et un plan interactif
            // s'execute par definition entre deux commandes.
            const reg = (deviceCtx as {
              getSshSessionRegistry?: () => { deliverMessage?: (c: 'all' | number, t: string) => number };
            } | undefined)?.getSshSessionRegistry?.();
            const entete = cible === 'all'
              ? `*** Message from tty0 to all terminals: ***`
              : `*** Message from tty0 to tty${cible}: ***`;
            const texte = ['', '***', entete, '', corps, '***', ''].join('\n');
            reg?.deliverMessage?.(cible, texte);
          },
        },
      ],
    };
  }

  /**
   * `enable` / `enable N` — a real IOS "Password:" prompt gated by
   * `enable secret` (level 15) or `enable secret|password level N`
   * (intermediate levels), with `enable secret` winning silently when
   * both exist at the same level (real IOS behaviour — no warning). When
   * nothing is configured for the target level, real IOS asks nothing
   * and grants immediately — modeled here by returning null, which lets
   * the terminal fall through to the underlying `enable` trie handler
   * (the same one non-interactive callers like `device.executeCommand()`
   * hit directly).
   */
  private enableInteractionPlan(
    args: string[], deviceCtx: unknown, surVty = false,
  ): CommandInteractionPlan | null {
    const lvl = args[0] ? parseInt(args[0], 10) : 15;
    if (!Number.isFinite(lvl) || lvl < 0 || lvl > 15) return null;
    // Un palier SANS coffre a lui retombe sur celui du niveau 15.
    //
    // Sans ce repli, `enable 7` etait accorde SANS RIEN DEMANDER des lors
    // qu'aucun `enable secret level 7` n'existait — sur une machine
    // pourtant fermee par `enable secret`. N'importe quel visiteur de
    // niveau 1 montait donc au niveau 7 et recevait tout ce que
    // l'operateur y avait delegue : la commande `privilege exec level N`
    // ne protegeait plus rien. La regle d'IOS est l'inverse, et sa
    // documentation l'ecrit dans l'autre sens : « if users know the
    // password to a higher privilege level, they can use that password
    // to enable the higher privilege level ».
    const gate = this.enableGateFor(lvl, deviceCtx);
    /**
     * Le mot de passe tape correspond-il a la porte ?
     *
     * Il etait compare a la FORME STOCKEE (`value === gate.value`), ce
     * qui rendait `enable` IMPOSSIBLE des que cette forme n'etait plus le
     * texte en clair. La regle de verification vit dans
     * `ciscoPasswordVerify`, avec la liste des trois situations tres
     * ordinaires qui produisaient ce refus — dont l'aller-retour d'une
     * topologie, qui reecrit tout secret en condense.
     */
    const correspond = (saisi: string): boolean =>
      !!gate && ciscoPasswordMatches(saisi, gate.value, gate.algo);
    // Sans mot de passe d'activation, IOS distingue les deux portes
    // depuis toujours : la console passe, une ligne RESEAU est refusee.
    // La raison est de securite et non de commodite — une vty joignable
    // depuis le reseau ne doit pas offrir le mode privilegie a qui sait
    // taper `enable`, alors qu'un acces console suppose deja d'etre
    // devant la machine.
    if (!gate) {
      if (!surVty) return null;
      return { steps: [{ kind: 'output', lines: ['% No password set'] }] };
    }
    // Le compteur vit dans CETTE invocation d'`enable` : le plan est
    // reconstruit a chaque frappe de la commande, donc les trois essais
    // se comptent par invocation, comme sur une vraie machine.
    let essais = 0;
    return {
      steps: [
        {
          // IOS laisse TROIS essais sur une meme invocation d'`enable` :
          // il redemande `Password:` apres chaque refus, puis abandonne
          // sur `% Bad secrets` et rend la main au mode UTILISATEUR — il
          // ne ferme pas la ligne, et le nombre d'essais n'est pas
          // reglable. Le refus etait ici a un seul coup (`maxRetries: 0`),
          // donc l'invite ne revenait jamais : il fallait retaper
          // `enable` a chaque fois, ce qu'aucune machine reelle ne
          // demande, et `% Bad secrets` n'existait nulle part.
          kind: 'password',
          prompt: 'Password: ',
          validate: (value) => {
            if (correspond(value)) return { valid: true };
            essais += 1;
            // Le troisieme refus est celui qui abandonne, et IOS ne dit
            // pas la meme chose : `% Access denied` tant qu'il redemande,
            // `% Bad secrets` quand il renonce.
            return essais >= 3
              ? { valid: false, errorMessage: '% Bad secrets', maxRetries: 2 }
              : { valid: false, errorMessage: '% Access denied', maxRetries: 2 };
          },
        },
        {
          kind: 'run',
          run: async (rt) => {
            this.authorizeEnable(lvl);
            await rt.exec(`enable ${lvl}`);
          },
        },
      ],
    };
  }

  private declaredModeLevel(mode?: string): number {
    if (mode === undefined) return this.currentPrivilegeLevel;
    return mode === 'user' ? this.currentPrivilegeLevel : 15;
  }

  private commandVisibleTo(
    cmdPart: string, mode: string, ctx?: InteractionPlanContext,
  ): boolean {
    const borrowed = this.deviceRef === null && ctx?.device !== undefined;
    if (borrowed) this.deviceRef = ctx!.device as TDevice;
    try {
      return this.commandVisibleToNow(cmdPart, mode, ctx);
    } finally {
      if (borrowed) this.deviceRef = null;
    }
  }

  private commandVisibleToNow(
    cmdPart: string, mode: string, ctx?: InteractionPlanContext,
  ): boolean {
    const niveau = ctx?.level ?? this.declaredModeLevel(ctx?.mode);
    const vue = ctx && 'view' in ctx ? (ctx.view ?? null) : this.activeParserView;
    // Hors d'une vue, le niveau 15 voit tout : rien ne peut etre
    // au-dessus. Le dire ici epargne a la frappe la plus courante le
    // parcours des descendants, qui ne pourrait rendre que `true`.
    if (vue === null && niveau >= 15) return true;
    const defaut = this.niveauParDefautDe(cmdPart);
    if (defaut !== null) {
      const accordee = this.autorisation().authorize({
        // `??` confondrait une vue RACINE explicitement transmise
        // (`null`) avec une absence de contexte, et retomberait alors
        // sur la vue du shell — donc sur celle d'une autre session.
        principal: { level: niveau, view: vue },
        scope: scopeForMode(mode as typeof this.mode),
        command: cmdPart,
        defaultLevel: defaut,
      }) === 'run';
      // Hissee au-dessus de la session : invisible, quoi qu'il y ait
      // dessous.
      if (!accordee) return false;
      // Validable ICI : elle se suffit, meme si tout ce qui la complete
      // est hors de portee. `show running-config` descendue au niveau 10
      // doit paraitre a ce niveau bien que `show running-config all`
      // reste au 15.
      if (this.executableTelleQuelle(cmdPart, mode)) return true;
    }
    return this.meneAQuelqueChoseDeVisible(cmdPart, mode, ctx);
  }

  /** Peut-on valider cette ligne telle quelle dans l'un des arbres du mode ? */
  private executableTelleQuelle(cmdPart: string, mode: string): boolean {
    for (const trie of this.arbresDe(scopeForMode(mode as typeof this.mode))) {
      if (trie.estExecutableTelQuel(cmdPart)) return true;
    }
    return false;
  }

  /**
   * Un noeud qui a des enfants est visible s'il MENE a quelque chose de
   * visible.
   *
   * Atteindre `show ip` ne demande que d'atteindre `show`, donc le
   * niveau propre de ce noeud vaut 1 — mais hisser `show ip route` au
   * niveau 5 hisse chacun de ses freres avec lui, si bien qu'au niveau 1
   * rien sous ce noeud ne s'execute. Le noeud etait donc juge sur son
   * propre niveau, qui ne dit rien de ce a quoi il donne acces, et il
   * paraissait dans la liste en ne menant nulle part.
   *
   * Le noeud lui-meme est exclu de la recherche, sans quoi un noeud
   * executable se justifierait par lui-meme — et la recursion ne
   * s'arreterait jamais.
   *
   * Le repli est OUVERT, et c'est delibere : un chemin sans aucun
   * descendant executable connu reste propose. Masquer ici n'est pas une
   * frontiere de securite — l'execution l'est, et elle refuse — donc en
   * cas de doute une liste trop large vaut mieux qu'une CLI amputee.
   */
  private meneAQuelqueChoseDeVisible(
    cmdPart: string, mode: string, ctx?: InteractionPlanContext,
  ): boolean {
    const cible = cmdPart.trim();
    let juge = false;
    for (const trie of this.arbresDe(scopeForMode(mode as typeof this.mode))) {
      const verdict = trie.someExecutableUnder(
        cible, (chemin) => this.commandVisibleToNow(chemin, mode, ctx));
      if (verdict === true) return true;
      if (verdict === false) juge = true;
    }
    return !juge;
  }

  /**
   * Cette commande EXISTE-t-elle dans cet espace de modes ?
   *
   * La question doit etre posee aux DEUX moteurs. Elle ne l'etait qu'aux
   * arbres, si bien qu'une commande migree vers le socle devenait
   * inconnue de `privilege <mode> level N <commande>` : la delegation
   * etait refusee, et l'operateur voyait une commande qu'il venait
   * d'executer traitee comme inexistante par la commande qui sert a la
   * deleguer. Une famille d'EXEC ne pouvait donc pas migrer sans
   * emporter ses delegations avec elle.
   */
  private commandeConnueDansMode(scope: AuthScope, commande: string): boolean {
    for (const trie of this.arbresDe(scope)) {
      const r = trie.match(commande);
      if (r.status === 'ok' || r.status === 'incomplete') return true;
    }
    return this.socleConnaitDansPortee(scope, commande);
  }

  /**
   * Une commande ACCORDEE peut porter ses arguments.
   *
   * `privilege exec level 5 show archive log config all` nomme une
   * commande dont le dernier mot est un ARGUMENT, et ce controle
   * exigeait que la declaration soit au moins aussi LONGUE que la ligne
   * tapee : la regle etait donc refusee des que la commande passait au
   * socle, en silence, et l'operateur avait une ligne de moins que ce
   * qu'il croyait avoir posee. Le trie, lui, l'acceptait — son noeud
   * glouton avale ce qui suit. Ici la declaration dit ou sont les
   * places : les mots-cles se comparent par prefixe, une place consomme
   * un mot, une place libre consomme la fin.
   */
  private socleConnaitDansPortee(scope: AuthScope, commande: string): boolean {
    const table = this.socleTable();
    if (!table) return false;

    const mots = commande.trim().toLowerCase().split(/\s+/);
    for (const spec of table.specs()) {
      if (!spec.modes.some(mode => scopeForMode(mode) === scope)) continue;
      if (CiscoShellBase.specCouvreLesMots(spec, mots)) return true;
    }
    return false;
  }

  private static specCouvreLesMots(
    spec: CommandSpec, mots: readonly string[],
  ): boolean {
    let rang = 0;
    for (const etape of spec.path) {
      if (rang >= mots.length) return true;
      if (typeof etape === 'string') {
        if (!etape.toLowerCase().startsWith(mots[rang])) return false;
        rang += 1;
        continue;
      }
      if (etape.type === 'REST') return true;
      rang += 1;
    }
    return rang >= mots.length;
  }

  /**
   * La meme verification, rendue avec le curseur sous le PREMIER mot de
   * la commande citee : c'est lui qu'IOS pointe, et lui que l'operateur
   * doit relire, meme quand la faute porte sur un mot suivant.
   */
  private exigerCommandeConnue(scope: AuthScope, mots: readonly string[]): void {
    if (this.commandeConnueDansMode(scope, mots.join(' '))) return;
    throw new CliInvalidInput({ token: mots[0] });
  }

  /**
   * `[no] privilege <mode> [all] {level <n> | reset} <commande>`, lue une
   * seule fois pour les deux formes.
   *
   * `no privilege` portait sa propre analyse, plus pauvre : elle rendait
   * `% Incomplete command.` pour un mot-cle mal ecrit — donc « continue
   * de taper » a qui doit effacer —, posait le curseur ailleurs que sur
   * le mot fautif, acceptait une commande inexistante et REFUSAIT `all`
   * que la forme positive accepte. Deux analyses d'une meme commande
   * finissent toujours par rendre deux verdicts.
   */
  private analyserRegleDePrivilege(args: string[]): {
    scope: AuthScope; tous: boolean; niveau: number | null; commande: string;
  } {
    if (args.length === 0) throw new CliIncomplete();
    const mode = args[0].toLowerCase();
    if (!AUTH_SCOPES.includes(mode as AuthScope)) {
      throw new CliInvalidInput({ token: args[0] });
    }
    const scope = mode as AuthScope;
    let i = 1;
    const tous = args[i]?.toLowerCase() === 'all';
    if (tous) i += 1;
    const verbe = args[i]?.toLowerCase();
    if (verbe === undefined) throw new CliIncomplete();
    if (verbe !== 'level' && verbe !== 'reset') {
      throw new CliInvalidInput({ token: args[i] });
    }
    let niveau: number | null = null;
    if (verbe === 'level') {
      const brut = args[i + 1];
      if (brut === undefined) throw new CliIncomplete();
      if (!/^\d+$/.test(brut) || Number(brut) > 15) {
        throw new CliInvalidInput({ token: brut });
      }
      niveau = Number(brut);
      i += 1;
    }
    const mots = args.slice(i + 1);
    if (mots.length === 0) throw new CliIncomplete();
    this.exigerCommandeConnue(scope, mots);
    return { scope, tous, niveau, commande: mots.join(' ') };
  }

  protected setupConfigurableInterfaces(deviceCtx?: unknown): string[] {
    const dev = (deviceCtx ?? this.deviceRef) as unknown as {
      getPorts?: () => Array<{ getName(): string }>;
    } | null;
    return (dev?.getPorts?.() ?? []).map((p) => p.getName());
  }

  private enableGateFor(
    lvl: number, deviceCtx?: unknown,
  ): { value: string; algo: string } | null {
    const dev = (deviceCtx ?? this.deviceRef ?? undefined) as {
      getEnableSecretForLevel?: (l: number) => { value: string; algo: string } | null;
      getEnablePasswordForLevel?: (l: number) => { value: string; algo: string } | null;
    } | undefined;
    const porteDe = (n: number) => {
      const s = dev?.getEnableSecretForLevel?.(n) ?? null;
      return s ?? dev?.getEnablePasswordForLevel?.(n) ?? null;
    };
    return porteDe(lvl) ?? (lvl < 15 ? porteDe(15) : null);
  }

  private enableAuthorizedLevel: number | null = null;

  private authorizeEnable(lvl: number): void {
    this.enableAuthorizedLevel = lvl;
  }

  private consumeEnableAuthorization(lvl: number): boolean {
    const granted = this.enableAuthorizedLevel === lvl;
    this.enableAuthorizedLevel = null;
    return granted;
  }

  private eraseInteractionPlan(): CommandInteractionPlan {
    return {
      steps: [
        {
          kind: 'confirmation',
          prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]',
          defaultAnswer: 'yes',
          storeAs: 'erase_confirmed',
        },
        // The device command performs the erase; its inline confirm text is
        // dropped because this plan already rendered the prompt.
        { kind: 'run', run: async (rt) => { await rt.exec('erase startup-config'); } },
        { kind: 'output', lines: ['[OK]', 'Erase of nvram: complete'] },
      ],
    };
  }

  private reloadInteractionPlan(): CommandInteractionPlan {
    return {
      steps: [
        {
          kind: 'confirmation',
          prompt: 'Proceed with reload? [confirm]',
          defaultAnswer: 'yes',
          storeAs: 'reload_confirmed',
        },
        { kind: 'run', run: async (rt) => { await rt.exec('reload'); } },
      ],
    };
  }

  /** Apply a banner — single write path shared by the config-trie handler
   *  and the multi-line capture plan (motd also feeds the SSH banner). */
  protected setBanner(
    kind: BannerKind,
    text: string,
    target?: unknown,
  ): void {
    const dev = (target ?? this.deviceRef) as {
      _setSshBanner?: (b: string) => void;
      _setMotdBanner?: (b: string) => void;
      _setLoginBanner?: (b: string) => void;
      _setExecBanner?: (b: string) => void;
      _setIncomingBanner?: (b: string) => void;
    } | null;
    if (!dev) return;
    if (kind === 'motd') { dev._setMotdBanner?.(text); dev._setSshBanner?.(text); }
    else if (kind === 'login') dev._setLoginBanner?.(text);
    else if (kind === 'exec') dev._setExecBanner?.(text);
    else if (kind === 'incoming') dev._setIncomingBanner?.(text);
  }

  private bannerCaptureInteractionPlan(
    kind: 'motd' | 'login' | 'exec' | 'incoming',
    delim: string,
    device?: unknown,
  ): CommandInteractionPlan {
    return {
      steps: [
        { kind: 'output', lines: [`Enter TEXT message.  End with the character '${delim}'.`] },
        {
          kind: 'collect',
          prompt: '',
          storeAs: 'banner_body',
          accept: (line, accumulated) => {
            const idx = line.indexOf(delim);
            if (idx < 0) return { done: false };
            const finalChunk = line.slice(0, idx);
            const parts = finalChunk.length > 0 ? [...accumulated, finalChunk] : [...accumulated];
            return { done: true, body: parts.join('\n') };
          },
        },
        {
          kind: 'run',
          run: async (rt) => { this.setBanner(kind, rt.values.get('banner_body') ?? '', device); },
        },
      ],
    };
  }

  private copyRunStartInteractionPlan(): CommandInteractionPlan {
    return {
      steps: [
        {
          kind: 'text',
          prompt: 'Destination filename [startup-config]? ',
          allowEmpty: true,
          storeAs: 'destination_filename',
        },
        { kind: 'run', run: async (rt) => { await rt.exec('write memory'); } },
        { kind: 'output', lines: ['Building configuration...', '', '[OK]'] },
      ],
    };
  }

  protected getChassisProfile(): import('./cisco/CiscoCommonShow').CiscoChassisProfile {
    return 'switch-c3560';
  }

  /**
   * Un ISR 2911 sans module EtherSwitch ne porte aucun ASIC de
   * commutation : table MAC, VLAN, `switchport` et VXLAN ne sont pas
   * « non implémentés », ils n'existent pas sur cette plateforme. Les
   * nœuds correspondants ne sont donc pas enregistrés du tout, et le
   * parseur répond au caret comme pour n'importe quelle saisie inconnue.
   */
  protected hasSwitchingHardware(): boolean {
    return this.getChassisProfile() !== 'router-isr2911';
  }

  /**
   * Le registre de configuration est une notion de ROUTEUR. Un Catalyst
   * de configuration fixe affiche bien `Configuration register is 0xF`
   * dans `show version`, mais la valeur est décorative : la commande
   * `config-register` n'existe pas en configuration globale et sa
   * manœuvre de récupération passe par le bouton MODE et le chargeur
   * d'amorçage (`flash_init`, `rename flash:config.text`), pas par
   * 0x2142. L'accepter ici rangeait une valeur que `show version`
   * démentait sur la même machine au même instant.
   */
  protected hasConfigRegister(): boolean {
    return this.getChassisProfile() === 'router-isr2911';
  }

  /**
   * Le shell pose-t-il sa PROPRE vue de la table d'adresses MAC ?
   *
   * La question est tranchée ici et non en lisant l'appareil, pour deux
   * raisons mesurées : l'appareil n'est pas encore lié quand les
   * commandes s'enregistrent, et l'ordre des inscriptions décidait
   * silencieusement du gagnant — la base inscrivant sur
   * `privilegedTrie` APRÈS le shell du commutateur, elle écrasait la
   * vue complète de celui-ci.
   */
  protected providesOwnMacAddressTableView(): boolean {
    return false;
  }

  /**
   * Aucun ISR G2 ni aucun Catalyst 3560 n'encapsule du VXLAN, quelle que
   * soit la licence : le VTEP est une fonction de plateforme, pas une
   * option. `VxlanAgent` reste entier et testé — c'est la porte CLI qui
   * n'a pas de châssis où s'ouvrir, et ce prédicat est l'endroit unique
   * où le premier profil qui la porterait la rouvrirait.
   */
  protected hasVxlanHardware(): boolean {
    return false;
  }

  /**
   * Le système de fichiers de l'équipement — UN par MACHINE.
   *
   * Il vivait sur le shell, et `createVtyShell()` en fabrique un neuf par
   * session : un fichier écrit depuis la console était donc invisible
   * depuis SSH, et une archive écrite depuis SSH invisible depuis la
   * console. Mesuré : `dir flash:` niait un fichier que `show archive`
   * listait, sur la même machine au même instant. C'est le même défaut
   * que celui déjà refermé pour IP SLA et `track` — un état de MACHINE
   * rangé sur un objet de SESSION.
   *
   * Le repli sur un système local n'est pas mort : un shell peut être
   * construit sans appareil lié (les tries s'enregistrent avant), et il
   * lui faut alors un `flash:` à décrire.
   */
  private _fs: CiscoFileSystem | null = null;



  protected showStartupConfig(): string {
    const dev = this.deviceRef as unknown as {
      getStartupConfigSnapshot?: () => string | null;
      getStartupConfig?: () => string | null;
    } | null;
    const snapshot = dev?.getStartupConfigSnapshot?.() ?? dev?.getStartupConfig?.() ?? null;
    if (snapshot === null) return '% startup-config is not present';
    // La NVRAM porte la MEME configuration que la memoire vive : la lire
    // par l'autre commande ne doit pas contourner le filtre par niveau.
    return this.filtrerConfigurationParNiveau(
      renderStartupConfig(snapshot, this.fs().nvramTotalBytes()),
    );
  }

  protected fs(): CiscoFileSystem {
    const dev = this.deviceRef as unknown as {
      _getCiscoFileSystem?: (
        profile: import('./cisco/CiscoCommonShow').CiscoChassisProfile,
      ) => CiscoFileSystem;
    } | null;
    const partage = dev?._getCiscoFileSystem?.(this.getChassisProfile());
    if (partage) return partage;
    if (!this._fs) this._fs = new CiscoFileSystem(this.getChassisProfile());
    return this._fs;
  }

  /**
   * `dir`, `more`, `delete`, `verify`, `pwd` — et la séquence de
   * démarrage (`boot system`, `config-register`, `show bootvar`).
   *
   * Enregistré sur la trie privilégiée uniquement : sur un vrai IOS,
   * l'EXEC utilisateur n'a accès à aucune de ces commandes.
   */
  private registerFileSystemCommands(trie: CommandTrie): void {
    trie.registerGreedy('dir', 'List files on a filesystem', (args) => {
      // `/all` liste aussi les fichiers marqués supprimés ; ce système de
      // fichiers en libère l'espace tout de suite (comme un IOS moderne),
      // donc il n'y a jamais rien de plus à montrer — l'option est
      // acceptée et ne ment pas.
      const cible = args.filter((a) => !a.startsWith('/'))[0] ?? 'flash:';
      if (/^nvram:/i.test(cible)) return this.renderNvramDir();
      if (!/^(flash|bootflash|disk0)(:|$)/i.test(cible) && cible !== '') {
        return `%Error opening ${cible} (No such file or directory)`;
      }
      return this.fs().renderDir(cible.replace(/\/$/, '') || 'flash:');
    });

    trie.registerGreedy('more', 'Display a file', (args) => {
      const nom = args[0] ?? '';
      if (!nom) return '% Incomplete command.';
      if (/^nvram:startup-config$/i.test(nom)) {
        return this.readStartupConfig() ?? '% startup-config is not present';
      }
      const f = this.fs().get(nom);
      if (!f) return `%Error opening ${nom} (No such file or directory)`;
      // Une image IOS n'a pas de contenu ici, et en inventer un serait
      // une fausseté vérifiable : le vrai `more` sur du binaire crache
      // des octets illisibles, pas une page blanche.
      return f.content ?? `%Error opening ${nom} (Is a binary file)`;
    });

    /*
     * `verify [/md5] <fichier>` — le controle A22 d'une liste d'audit.
     *
     * L'option etait retiree du PREMIER argument par une expression
     * reguliere, comme si elle etait collee au nom de fichier — alors que
     * la CLI la decoupe en un jeton a part. `verify /md5 flash:image.bin`
     * laissait donc le nom dans `args[1]`, jamais lu, et repondait
     * `% Incomplete command`.
     * Seule la forme sans option etait atteignable — c'est-a-dire pas
     * celle que l'on tape.
     *
     * Quand le fichier a un CONTENU — une configuration archivee, un
     * fichier ecrit par l'operateur — la somme est la vraie somme MD5 de
     * ce contenu, calculee par le meme moteur que `sha256sum` cote Linux.
     * Un fichier sans contenu (l'image livree avec le chassis n'a que son
     * nom et sa taille) garde une valeur DERIVEE, stable et reproductible,
     * et la ligne `CCO Hash` est alors omise : annoncer une somme de
     * reference publiee par Cisco pour une image qui n'existe pas ferait
     * croire a une comparaison qui n'a pas lieu.
     */
    trie.registerGreedy('verify', 'Verify a file', (args) => {
      const mots = args.filter((a) => a.length > 0);
      const md5Demande = mots.some((a) => a.toLowerCase() === '/md5');
      const nom = mots.find((a) => !a.startsWith('/')) ?? '';
      if (!nom) throw new CliIncomplete();
      const f = this.fs().get(nom);
      if (!f) return `%Error opening ${nom} (No such file or directory)`;
      void md5Demande;
      const contenu = this.fs().read(nom);
      const somme = contenu !== null ? _md5Hex(contenu) : pseudoMd5(f.name, f.size);
      const lignes = [
        `Verifying file integrity of flash:${f.name}`,
        '.................................................................. Done!',
        `Embedded Hash   MD5 : ${somme}`,
        `Computed Hash   MD5 : ${somme}`,
      ];
      if (contenu === null) {
        lignes.push(`CCO Hash        MD5 : ${pseudoMd5(`cco:${f.name}`, f.size)}`);
      }
      lignes.push('', `Digital signature successfully verified in file flash:${f.name}`);
      return lignes.join('\n');
    });

    trie.registerGreedy('delete', 'Delete a file', (args) => {
      const nom = args.filter((a) => !a.startsWith('/')).pop() ?? '';
      if (!nom) return '% Incomplete command.';
      if (!this.fs().exists(nom)) {
        return `%Error deleting ${nom} (No such file or directory)`;
      }
      this.fs().remove(nom);
      // IOS demande DEUX fois — le nom, puis la suppression elle-même —
      // et une suppression muette est celle qu'on croit avoir annulée.
      // `mkdir`/`rmdir`/`squeeze` juste en dessous rendent déjà leurs
      // confirmations ; `delete`, la plus destructrice des quatre, ne
      // rendait rien du tout.
      const court = nom.replace(/^[a-z]+:\/?/i, '');
      const chemin = /^[a-z]+:/i.test(nom) ? nom.replace(/^([a-z]+):\/?/i, '$1:/') : `flash:/${court}`;
      return `Delete filename [${court}]?\nDelete ${chemin}? [confirm]`;
    });

    /**
     * `mkdir` / `rmdir` — un `flash:` a des répertoires, et le tutoriel
     * en crée un pour ranger ses sauvegardes. Ils n'existaient pas :
     * `mkdir flash:backups` tombait dans la résolution de nom d'hôte et
     * répondait `Translating "mkdir"...`.
     */
    trie.registerGreedy('mkdir', 'Create a directory', (args) => {
      const nom = args[0];
      if (!nom) throw new CliIncomplete();
      const propre = nom.replace(/\/+$/, '');
      if (this.fs().exists(propre)) return `%Error Creating dir ${propre} (File exists)`;
      this.fs().makeDirectory(propre);
      return `Create directory filename [${propre.replace(/^[a-z]+:\/?/i, '')}]? [confirm]\n`
        + `Created dir ${propre}`;
    });
    trie.registerGreedy('rmdir', 'Remove a directory', (args) => {
      const nom = args[0];
      if (!nom) throw new CliIncomplete();
      const propre = nom.replace(/\/+$/, '');
      const verdict = this.fs().removeDirectory(propre);
      if (verdict === 'absent') return `%Error Removing dir ${propre} (No such file or directory)`;
      if (verdict === 'non-vide') return `%Error Removing dir ${propre} (Directory not empty)`;
      return `Remove directory filename [${propre.replace(/^[a-z]+:\/?/i, '')}]? [confirm]\n`
        + `Removed dir ${propre}`;
    });

    /**
     * `squeeze` — sur un IOS ancien, `delete` marquait le fichier et
     * `squeeze` récupérait l'espace. Ce système de fichiers le récupère
     * tout de suite, comme un IOS moderne : la commande existe, elle
     * DIT qu'il n'y avait rien à récupérer plutôt que de prétendre
     * l'avoir fait.
     */
    trie.registerGreedy('squeeze', 'Squeeze a filesystem', (args) => {
      const cible = args[0] ?? 'flash:';
      if (!/^(flash|bootflash|disk0):?$/i.test(cible.replace(/\/$/, ''))) {
        return `%Error squeezing ${cible} (No such device)`;
      }
      return 'All deleted files will be removed. Continue? [confirm]\n'
        + 'Squeeze operation may take a while. Continue? [confirm]\n'
        + 'Squeeze of flash complete\n'
        + '%No files were deleted: this filesystem reclaims space on delete.';
    });

    trie.register('pwd', 'Display current working directory', () => 'flash:');

    // Greedy comme l'inscription figée qu'elle remplace, pour que
    // `show boot` suivi d'un mot continue de résoudre.
  }

  /** `dir nvram:` — deux entrées, comme sur le vrai. */
  private renderNvramDir(): string {
    const startup = this.readStartupConfig();
    const taille = startup ? startup.length : 0;
    return [
      'Directory of nvram:/',
      '',
      `  190  -rw-        ${String(taille).padStart(6)}                    <no date>  startup-config`,
      '  191  ----             5                    <no date>  private-config',
      '',
      `${this.fs().nvramTotalBytes()} bytes total `
        + `(${this.fs().nvramFreeBytes(taille)} bytes free)`,
    ].join('\n');
  }

  /**
   * La configuration de démarrage, quel que soit l'équipement : le
   * switch l'expose par `getStartupConfig`, le routeur par
   * `getStartupConfigSnapshot`. Une seule lecture pour `more`, `dir` et
   * la séquence de démarrage.
   */
/**
   * Une copie vers ou depuis le réseau (`tftp:`, `ftp:`, `scp:`…).
   *
   * Elle répondait `[OK]` sans qu'un octet quitte la machine : une
   * sauvegarde annoncée réussie et inexistante. Tant que le transfert
   * n'est pas réel, la commande DIT ce qui manque plutôt que de
   * prétendre — c'est la règle de ce dépôt pour tout ce qu'il ne sait
   * pas encore faire, et c'est la seule réponse qui n'égare pas
   * l'opérateur au moment où il croit avoir une sauvegarde.
   */
  /**
   * L'écriture d'un contenu à sa DESTINATION, quel que soit d'où il
   * vient. Elle était écrite dans le corps de `copy` et donc inatteignable
   * depuis le chemin réseau, qui aurait dû la recopier — deux façons de
   * déposer le même fichier finissent toujours par diverger.
   */
  protected deposerCopie(
    appareil: TDevice, dstBrut: string, dst: string, texte: string, srcBrut = dstBrut,
  ): string {
    const avant = this.deviceRef;
    this.deviceRef = appareil;
    try {
      const dev = appareil as unknown as {
        _applyConfigText?: (text: string) => void;
        _captureStartupConfig?: (t: string) => void;
        setStartupConfigText?: (t: string) => void;
      };
      if (dst === 'running-config' || dst === 'system:running-config') {
        dev._applyConfigText?.(texte);
        return `Destination filename [running-config]?\n${texte.length} bytes copied`;
      }
      if (dst === 'startup-config' || dst === 'nvram:startup-config' || dst === 'nvram:') {
        if (dev._captureStartupConfig) dev._captureStartupConfig(texte);
        else if (dev.setStartupConfigText) dev.setStartupConfigText(texte);
        else return '%% Non-volatile configuration memory is not present';
        return `Destination filename [startup-config]?\n${texte.length} bytes copied`;
      }
      if (this.fs().freeBytes() < texte.length) {
        return `%Error copying ${srcBrut} (No space left on device)`;
      }
      this.fs().write(dstBrut, texte);
      return `Destination filename [${dstBrut.replace(/^[a-z]+:\/?/i, '')}]?\n`
        + `${texte.length} bytes copied`;
    } finally {
      this.deviceRef = avant;
    }
  }

  protected copieReseauIndisponible(cible: string): string {
    const schema = /^([a-z]+):/i.exec(cible)?.[1]?.toLowerCase() ?? cible;
    return `%Error: copy ${schema}: is not implemented in this simulator `
      + `(no ${schema.toUpperCase()} client on this device yet).`;
  }

  protected readStartupConfig(): string | null {
    const dev = this.d() as unknown as {
      getStartupConfig?: () => string | null;
      getStartupConfigSnapshot?: () => string | null;
    };
    return dev.getStartupConfig?.() ?? dev.getStartupConfigSnapshot?.() ?? null;
  }

  // ─── Device accessor ────────────────────────────────────────────

  /** Get typed device reference. Throws if called outside execute(). */
  protected d(): TDevice {
    if (!this.deviceRef) throw new Error('Device reference not set (BUG: called outside execute)');
    return this.deviceRef;
  }

  /** Device as the real-state surface the shared show helpers read. */
  protected cs(): ShowStateDevice {
    return this.d() as unknown as ShowStateDevice;
  }

  protected asPathLists(): Map<string, string[]> {
    const r = this.d() as unknown as { _ciscoAsPathLists?: Map<string, string[]> };
    return (r._ciscoAsPathLists ??= new Map());
  }

  protected communityLists(): Map<string, string[]> {
    const r = this.d() as unknown as { _ciscoCommunityLists?: Map<string, string[]> };
    return (r._ciscoCommunityLists ??= new Map());
  }

  /** Hand the device's CDP agent (if any) to `fn`. No-op on non-Cisco. */
  protected applyToCdpAgent(fn: (a: import('@/network/cdp/CdpAgent').CdpAgent) => void): void {
    const agent = (this.d() as unknown as { getCdpAgent?: () => import('@/network/cdp/CdpAgent').CdpAgent }).getCdpAgent?.();
    if (agent) fn(agent);
  }

  protected syncSyslogAgent(): void {
    const agent = (this.d() as unknown as {
      getSyslogAgent?: () => import('@/network/syslog/SyslogAgent').SyslogAgent;
    }).getSyslogAgent?.();
    if (!agent) return;

    projectLoggingOntoSyslogAgent(this.logging, agent);
  }

  protected syncSnmpAgent(): void {
    const agent = getSnmpAgent(this.d());
    const svc = getSnmpService(this.d());
    if (!agent || !svc) return;
    projectSnmpServiceOntoAgent(svc, agent);
  }

  syncNetflowAgent(): void {
    const dev = this.d() as unknown as {
      getNetflowService?: () => import('../router/netflow/NetflowService').NetflowService;
      getNetFlowAgent?: () => import('@/network/netflow/NetFlowAgent').NetFlowAgent | null;
    };
    const svc = dev.getNetflowService?.();
    const agent = dev.getNetFlowAgent?.();
    if (!svc || !agent) return;

    const exporters = new Map<string, import('../router/netflow/NetflowService').FlowExporter>();
    for (const e of svc.getExporters()) exporters.set(e.name, e);

    const attachedMonitors = new Set<string>();
    for (const a of svc.getInterfaceAttachments()) attachedMonitors.add(a.monitorName);

    const desiredCollectors = new Map<string, number>();
    for (const m of svc.getMonitors()) {
      if (!attachedMonitors.has(m.name)) continue;
      for (const en of m.exporterNames) {
        const e = exporters.get(en);
        if (!e?.destination) continue;
        const port = e.transportPort ?? 2055;
        desiredCollectors.set(e.destination, port);
      }
    }
    const legacy = svc.getLegacy();
    const hasLegacyIface = [...legacy.ifaceModes.values()].some((m) => m.ingress || m.egress);
    if (hasLegacyIface || legacy.destinations.length > 0) {
      for (const d of legacy.destinations) desiredCollectors.set(d.ip, d.port);
    }

    let activeSec: number | undefined;
    let inactiveSec: number | undefined;
    for (const m of svc.getMonitors()) {
      if (!attachedMonitors.has(m.name)) continue;
      if (activeSec === undefined && m.cacheTimeoutActiveSec !== undefined) activeSec = m.cacheTimeoutActiveSec;
      if (inactiveSec === undefined && m.cacheTimeoutInactiveSec !== undefined) inactiveSec = m.cacheTimeoutInactiveSec;
    }
    if (activeSec === undefined && legacy.cacheTimeoutActiveMin !== undefined) activeSec = legacy.cacheTimeoutActiveMin * 60;
    if (inactiveSec === undefined && legacy.cacheTimeoutInactiveSec !== undefined) inactiveSec = legacy.cacheTimeoutInactiveSec;
    if (activeSec !== undefined) agent.setActiveTimeoutSec(activeSec);
    if (inactiveSec !== undefined) agent.setInactiveTimeoutSec(inactiveSec);

    if (legacy.source) agent.setSourceInterface(legacy.source);

    const existing = new Set(agent.listCollectors().map((c) => c.ip));
    for (const ip of existing) {
      if (!desiredCollectors.has(ip)) agent.removeCollector(ip);
    }
    for (const [ip, port] of desiredCollectors) agent.addCollector(ip, port);

    const shouldRun = desiredCollectors.size > 0;
    agent.setEnabled(shouldRun);
    if (shouldRun) agent.start();
    else agent.stop();
  }

  protected applyToLldpAgent(fn: (a: import('@/network/lldp/LldpAgent').LldpAgent) => void): void {
    const agent = (this.d() as unknown as { getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
    if (agent) fn(agent);
  }

  /**
   * Resolve the per-interface scope selected in `config-if`. The base
   * implementation returns the single `selectedInterface`; switch shells
   * override to spread a range / a multi-port `interface range`.
   */
  protected selectedPortsForConfigIf(): string[] {
    const dev = this as unknown as { getSelectedInterface?: () => string | null; getSelectedInterfaceRange?: () => string[] };
    const range = dev.getSelectedInterfaceRange?.();
    if (range && range.length > 0) return range;
    const single = dev.getSelectedInterface?.();
    return single ? [single] : [];
  }

  // ─── Initialization ─────────────────────────────────────────────

  /**
   * Call from subclass constructor after setting up FSM and additional tries.
   * Registers all shared commands, then device-specific commands.
   */
  protected initializeCommands(): void {
    this.registerCommonUserCommands();
    this.registerCommonPrivilegedCommands();
    this.registerCommonConfigCommands();
    this.registerDeviceCommands();
    this.pruneMigratedFromTries();
    this.privilegedTrie.importMissingFrom(this.userTrie);
    this.privilegedTrie.copySubtreeChildrenInto('show', this.userTrie, PRIVILEGED_ONLY_SHOW_CHILDREN);
    this.userTrie.pruneSubtreeChildren('show', PRIVILEGED_ONLY_SHOW_CHILDREN);
    this.userTrie.prunePaths(PRIVILEGED_ONLY_PATHS);
    this.applyCanonicalDescriptions();
  }

  /**
   * Top-level keywords that only ever exist as a prefix of longer commands
   * (e.g. `show ...`, `configure terminal`) keep the placeholder description
   * equal to their keyword. These canonical descriptions give the ? help a
   * proper line for them, shared by every Cisco device.
   */
  protected applyCanonicalDescriptions(): void {
    const exec: Array<[string, string]> = [
      ['configure', 'Enter configuration mode'],
      ['show', 'Show running system information'],
      ['no', 'Negate a command or set its defaults'],
      ['clear', 'Reset functions'],
      ['erase', 'Erase persistent storage'],
      ['sntp', 'Configure SNTP'],
      ['copy', 'Copy from one file to another'],
      ['debug', 'Enable debugging functions'],
      ['undebug', 'Disable debugging functions'],
      ['write', 'Write running configuration to memory'],
      ['event', 'Embedded Event Manager'],
    ];
    for (const trie of [this.userTrie, this.privilegedTrie]) {
      for (const [k, d] of exec) trie.setCanonicalDescription(k, d);
    }
    const config: Array<[string, string]> = [
      ['configure', 'Enter configuration mode'],
      ['no', 'Negate a command or set its defaults'],
      ['show', 'Show running system information'],
      ['sntp', 'Configure SNTP'],
      ['cdp', 'CDP global configuration'],
      ['lldp', 'LLDP global configuration'],
      ['ip', 'Global IP configuration subcommands'],
      ['ipv6', 'Global IPv6 configuration subcommands'],
      ['mac', 'MAC address table configuration'],
      ['errdisable', 'Error-disable recovery configuration'],
      ['vtp', 'VTP configuration'],
      ['enable', 'Modify enable password parameters'],
      ['router', 'Enable a routing protocol'],
      ['key', 'Key management'],
      ['security', 'Security configuration'],
      ['event', 'Embedded Event Manager'],
      ['flow', 'Flow monitoring configuration'],
      ['parameter-map', 'Parameter map configuration'],
      ['zone', 'Security zone'],
      ['zone-pair', 'Security zone-pair'],
    ];
    for (const [k, d] of config) this.configTrie.setCanonicalDescription(k, d);
  }

  // ─── Execute Loop (shared) ──────────────────────────────────────

  /**
   * Multi-line banner entry state: `banner motd #` without a closing
   * delimiter on the same line switches the console into verbatim
   * collection until a line containing the delimiter arrives (IOS
   * truncates at the FIRST occurrence — text before it is kept, the
   * rest of that line is discarded).
   */
  private bannerCollector: {
    type: BannerKind;
    delimiter: string;
    lines: string[];
  } | null = null;

  /** True while a `banner …` command is collecting its multi-line body. */
  isCollectingBanner(): boolean {
    return this.bannerCollector !== null;
  }

  private collectBannerLine(rawLine: string): string {
    const c = this.bannerCollector!;
    const idx = rawLine.indexOf(c.delimiter);
    if (idx === -1) {
      c.lines.push(rawLine);
      return '';
    }
    if (idx > 0) c.lines.push(rawLine.slice(0, idx));
    this.bannerCollector = null;
    this.setBanner(c.type, c.lines.join('\n'));
    return '';
  }

  /**
   * Core execute logic shared by both router and switch shells.
   * Handles: empty input, pipe filtering, ?, exit/end, do prefix,
   * show shortcut, trie matching, async support, error formatting.
   */
  private applyLineEditing(input: string): string {
    let left: string[] = [];
    let right: string[] = [];
    for (const ch of input) {
      if (ch === '\b' || ch === '\x7f') { left.pop(); continue; }
      if (ch === '\x01') { right = left.concat(right); left = []; continue; }
      if (ch === '\x05') { left = left.concat(right); right = []; continue; }
      if (ch === '\x0b') { right = []; continue; }
      if (ch === '\x17') {
        while (left.length && left[left.length - 1] === ' ') left.pop();
        while (left.length && left[left.length - 1] !== ' ') left.pop();
        continue;
      }
      left.push(ch);
    }
    return left.concat(right).join('');
  }

  protected executeOnDevice(device: TDevice, rawInput: string): string | Promise<string> {
    rawInput = this.applyLineEditing(rawInput);
    // Multi-line banner entry: every line is verbatim content (leading
    // spaces, empty lines, would-be commands) until the delimiter shows up.
    if (this.bannerCollector) {
      this.deviceRef = device;
      const out = this.collectBannerLine(rawInput);
      this.deviceRef = null;
      return out;
    }
    if (rawInput.endsWith('\t')) {
      const stem = rawInput.replace(/\s+$/, '');
      // L'equipement est connu ici : sans lui, la completion retombe sur
      // le trie seul et une commande migree n'est jamais completee.
      const completed = this.tabComplete(stem, device);
      return (completed ?? stem).trimEnd();
    }
    const trimmed = rawInput.trim();
    if (!trimmed) return '';
    // IOS comment lines: `!` (optionally followed by text) is a silent
    // no-op at EVERY prompt and never leaves the current sub-mode —
    // pasting a show running-config must not spray "% Invalid input".
    if (trimmed.startsWith('!')) return '';
    // Les caractères de contrôle sont ICI le sujet — une ligne qui n'en
    // contient que doit être ignorée — donc la règle ne s'applique pas.
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x1f]+$/.test(trimmed) && trimmed !== '\x03' && trimmed !== '\x1a') return '';
    if (!trimmed.endsWith('?') && this.terminalHistoryEnabled
        && this.terminalHistorySize > 0
        && trimmed.toLowerCase() !== 'show history'
        && trimmed.toLowerCase() !== 'clear history') {
      this.cmdHistory.push(trimmed);
      if (this.cmdHistory.length > this.terminalHistorySize) {
        this.cmdHistory = this.cmdHistory.slice(-this.terminalHistorySize);
      }
    } else if (this.terminalHistorySize === 0) {
      this.cmdHistory = [];
    }

    const parsed = parsePipeFilter(trimmed);
    let cmdPart = parsed.cmd;
    const pipeFilter = parsed.filter;
    if (pipeFilter && PIPE_WRITERS.has(pipeFilter.type)) {
      return this.runPipeWriter(cmdPart, pipeFilter, device);
    }

    // Context-sensitive help
    if (cmdPart.endsWith('?')) {
      this.deviceRef = device;
      const helpResult = this.getHelp(cmdPart.slice(0, -1));
      this.deviceRef = null;
      return helpResult;
    }

    // Exec alias expansion (real AliasRepository state): in
    // user/privileged mode, an alias head expands to its command.
    if (!this.isConfigMode()) {
      const sp = cmdPart.indexOf(' ');
      const head = sp === -1 ? cmdPart : cmdPart.slice(0, sp);
      const expansion = this.aliases.resolve('exec', head);
      if (expansion) cmdPart = expansion + (sp === -1 ? '' : cmdPart.slice(sp));
    }

    this.configExitLogTarget = device;

    // La fenêtre du redémarrage se referme à la commande SUIVANTE, pas à
    // la fin de `powerOn()` : les remontées d'interface arrivent par le
    // bus, donc APRÈS. La fermer trop tôt laissait `logging reload` ne
    // rien borner du tout — le défaut que ce câblage corrige.
    this.logging.endReloadWindow();

    // Global shortcuts (no device ref needed)
    const lower = cmdPart.toLowerCase();
    const firstWord = cmdPart.split(/\s+/)[0];
    if (/[A-Z]/.test(firstWord) && (firstWord.toLowerCase() === 'debug' || firstWord.toLowerCase() === 'undebug')) {
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (this.mode === 'user' && /^(un)?deb(u(g)?)?\b/i.test(cmdPart)) {
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (lower === 'exit' || lower === 'exi' || lower === 'ex') return this.cmdExit();
    if (lower === 'end' || cmdPart === '\x03' || cmdPart === '\x1a') return this.cmdEnd();
    // `help` n'existait pas : en EXEC il partait vers la résolution de
    // noms (« Translating "help"… »), en configuration il répondait au
    // caret. C'est le texte d'IOS, mot pour mot.
    if (lower === 'help') return HELP_SYSTEM_TEXT;
    if (lower === 'logout' && (this.mode === 'user' || this.mode === 'privileged')) {
      return this.fermerSessionExec();
    }
    // `disable [niveau]` — IOS accepte un niveau de destination, et
    // c'est la moitie de la manoeuvre d'escalade temporaire : on monte a
    // 15 pour l'intervention, on REDESCEND ensuite. Seul `disable` nu
    // etait reconnu, donc `disable 10` repondait au caret et laissait
    // l'operateur a 15 en croyant en etre redescendu.
    if ((lower === 'disable' || lower.startsWith('disable '))
      && (this.mode === 'user' || this.mode === 'privileged')) {
      const arg = cmdPart.trim().split(/\s+/)[1];
      const cible = arg === undefined ? 1 : Number.parseInt(arg, 10);
      if (!Number.isFinite(cible) || cible < 0 || cible > 15) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      // Descendre seulement : `disable` ne fait jamais monter, sinon ce
      // serait un `enable` sans mot de passe.
      if (cible > this.currentPrivilegeLevel) return CISCO_ERRORS.INVALID_INPUT;
      this.currentPrivilegeLevel = cible;
      this.mode = cible >= 15 ? 'privileged' : 'user';
      return '';
    }

    // Bind device reference for command closures
    this.deviceRef = device;

    // `default <commande>` remet une commande à sa valeur d'usine. IOS
    // l'implémente comme la négation SUIVIE de la valeur par défaut ;
    // ici, la seule valeur par défaut connue d'une commande est son
    // absence, donc `default X` est exécuté comme `no X` — ce qui est
    // exact pour tout ce que ce simulateur configure, et honnête : la
    // commande n'est plus refusée au caret alors qu'IOS l'accepte.
    if (this.isConfigMode() && (lower === 'default' || lower.startsWith('default '))) {
      const reste = cmdPart.slice('default'.length).trim();
      if (!reste) return CISCO_ERRORS.INCOMPLETE;
      this.deviceRef = device;
      return applyPipeFilter(this.executeOnTrie(`no ${reste}`), pipeFilter);
    }

    // 'do' prefix in config modes — delegate to privileged trie
    if (this.isConfigMode() && lower === 'do') return CISCO_ERRORS.INCOMPLETE;
    if (this.isConfigMode() && lower.startsWith('do ')) {
      const subCmd = cmdPart.slice(3).trim();
      const savedMode = this.mode;
      this.mode = 'privileged';
      const output = this.executeOnTrie(subCmd);
      this.mode = savedMode;
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    if (this.isConfigMode() && lower.startsWith('show ')) {
      const savedMode = this.mode;
      this.mode = 'privileged';
      const output = this.executeOnTrie(cmdPart);
      this.mode = savedMode;
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    if (this.isAclSubMode() && /^\d/.test(cmdPart)) {
      const output = this.executeOnTrie('sequence ' + cmdPart);
      this.deviceRef = null;
      return applyPipeFilter(output, pipeFilter);
    }

    const modeAvant = this.mode;
    const output = this.executeOnTrie(cmdPart);
    this.journaliserCommandeDeConfig(modeAvant, cmdPart, output);
    this.comptabiliserCommande(cmdPart, output);

    // Async escape hatch (e.g. ping on routers sets this)
    if (this._pendingAsync) {
      const asyncOp = this._pendingAsync;
      this._pendingAsync = null;
      this.deviceRef = null;
      return asyncOp.then(result => applyPipeFilter(result, pipeFilter));
    }

    this.deviceRef = null;
    return applyPipeFilter(output, pipeFilter);
  }

  // ─── Trie Matching ──────────────────────────────────────────────

  /**
   * Une commande GLOBALE tapee depuis un sous-mode de configuration
   * s'applique et change de contexte — c'est la regle d'IOS, et c'est ce
   * qui rend une configuration rendue REJOUABLE : elle ne contient aucun
   * `exit`, seulement des `!`.
   *
   * Il y avait ici une table de sous-modes, chacun avec une liste de
   * onze verbes autorises. Elle etait REDONDANTE — cette fonction n'est
   * consultee que dans la branche `'invalid'`, une fois que l'arbre du
   * sous-mode a renonce, et elle rejoue la commande contre l'arbre
   * global, qui refuse tout seul ce qu'il ne connait pas. Son seul effet
   * etait d'ecarter des commandes globales valides : `privilege …`,
   * `parser view …` et `archive` etaient refusees des qu'une interface
   * avait ete configuree avant elles, et les sous-modes absents de la
   * table (`config-archive` et les siens) ne retombaient nulle part —
   * une seule ligne `archive` dans la configuration bloquait donc TOUT
   * le reste du rejeu.
   *
   * Ce n'est pas de l'ergonomie : l'import d'une topologie rejoue cette
   * configuration, et elle place les blocs `interface` avant la
   * delegation par niveau et les vues d'analyseur. Les unes comme les
   * autres etaient perdues a chaque aller-retour, en silence.
   */
  protected tryGlobalConfigNavigation(cmdPart: string): string | null {
    if (!this.isConfigMode() || this.mode === 'config') return null;
    // `config-view` : ce qui est CERTAIN est qu'une commande venue de
    // l'arbre global ne doit pas DEPLACER la session. `interface Gi0/0`
    // y changeait de mode, si bien que le `exit` suivant ne quittait
    // plus la vue mais l'interface, et la definition de la vue restait a
    // moitie faite.
    //
    // Ce qui n'est PAS certain, et n'est donc pas fait : savoir si IOS
    // refuse aussi les commandes globales qui ne changent pas de mode
    // (`hostname`, `username`). La documentation ne le dit pas, et
    // l'indice le plus fort va dans l'autre sens — une configuration
    // rendue enchaine `parser view X`, ses lignes, puis les comptes,
    // SANS `exit` entre les deux, donc IOS doit pouvoir les rejouer
    // depuis ce sous-mode. Inventer un refus serait aussi faux
    // qu'inventer une ligne `exit` dans la configuration.
    const modeAvant = this.mode;
    const result = this.configTrie.match(cmdPart);
    if (result.status === 'ok' && result.node?.action) {
      try {
        const sortie = result.node.action(result.args, cmdPart);
        if (modeAvant === 'config-view' && this.mode !== modeAvant) {
          this.mode = modeAvant;
          this.fsm.mode = modeAvant;
          return renderCliDiagnostic('invalid', {
            line: cmdPart,
            tokenOffset: argumentOffset(cmdPart, result.matchedKeywords.length, 0),
          });
        }
        return sortie;
      } catch (err) {
        if (err instanceof CliInvalidInput) {
          if (err.motAbsent()) return renderCliDiagnostic('incomplete', { line: cmdPart });
          return renderCliDiagnostic('invalid', {
            line: cmdPart,
            tokenOffset: offsetForInvalidInput(cmdPart, result.matchedKeywords.length, err),
          });
        }
        throw err;
      }
    }
    return null;
  }

  /**
   * `enable view [<nom>]` — basculer dans une vue, ou revenir a la racine.
   *
   * Sans nom, on entre dans la vue RACINE : c'est la condition qu'IOS
   * pose pour declarer ou modifier une vue, et c'est aussi la sortie
   * d'une vue restreinte. Avec un nom, la vue doit exister — sinon on
   * annoncerait un role qui n'a jamais ete decrit.
   *
   * Le mot de passe de la vue n'est PAS demande ici : comme pour
   * `enable`, l'authentification interactive se joue dans le plan
   * d'interaction, et un appelant non interactif (un test, un script)
   * ne pourrait de toute facon pas y repondre.
   */
  protected entrerDansUneVue(args: string[]): string {
    const sec = getSecurityConfig(this.d());
    const nom = args.length === 0 ? null : args[0];
    if (nom !== null && !sec.parserViews.has(nom)) {
      return `%Error: View ${nom} is not present in the system`;
    }
    if (this.porteDeVue(nom) && !this.consommerAutorisationDeVue(nom)) {
      return '% Access denied';
    }
    this.activeParserView = nom;
    this.mode = 'privileged';
    this.currentPrivilegeLevel = 15;
    return '';
  }

  /**
   * Ce qui garde l'entree dans une vue : le secret de la vue nommee, ou
   * — pour la vue RACINE, qui confere le niveau 15 — le secret
   * d'activation.
   *
   * `ParserView.secret` etait ecrit par sa commande, rendu dans la
   * configuration, et lu par personne : depuis n'importe quelle vue
   * restreinte, `enable view` seul rendait la racine et le niveau 15
   * sans rien demander, et `enable view AUTRE` sautait d'une vue a
   * l'autre. Un compte porteur d'une vue etait donc, en pratique, un
   * compte de niveau 15.
   *
   * `null` veut dire « aucune porte » : la vue s'ouvre alors sans rien
   * demander, exactement comme `enable` sur une machine sans `enable
   * secret`. L'inverse ferait d'une vue sans secret une souriciere sur
   * toute topologie deja enregistree.
   */
  private porteDeVue(nom: string | null): { value: string; algo: string } | null {
    if (nom === null) return this.enableGateFor(15);
    const vue = getSecurityConfig(this.d()).parserViews.get(nom);
    if (!vue || vue.secret === undefined || vue.secret === '') return null;
    return { value: vue.secret, algo: vue.secretAlgo ?? 'md5' };
  }

  private vueAutorisee: string | null | undefined = undefined;

  private autoriserVue(nom: string | null): void {
    this.vueAutorisee = nom;
  }

  private consommerAutorisationDeVue(nom: string | null): boolean {
    const accorde = this.vueAutorisee === nom;
    this.vueAutorisee = undefined;
    return accorde;
  }

  /**
   * Le dialogue d'`enable view [<nom>]`, calque sur celui d'`enable` :
   * trois essais sur une meme invocation, `% Access denied` tant qu'IOS
   * redemande, `% Bad secrets` quand il renonce.
   *
   * Rend `null` quand il n'y a rien a demander — vue inexistante (le
   * gestionnaire produit alors le message d'IOS) ou aucune porte — de
   * sorte que le cas courant ne traverse aucune logique nouvelle.
   */
  private enableViewInteractionPlan(
    args: string[], deviceCtx?: unknown,
  ): CommandInteractionPlan | null {
    const emprunte = this.deviceRef === null && deviceCtx !== undefined;
    if (emprunte) this.deviceRef = deviceCtx as TDevice;
    try {
      const nom = args.length === 0 ? null : args[0];
      if (nom !== null && !getSecurityConfig(this.d()).parserViews.has(nom)) return null;
      const gate = this.porteDeVue(nom);
      if (!gate) return null;
      let essais = 0;
      return {
        steps: [
          {
            kind: 'password',
            prompt: 'Password: ',
            validate: (value) => {
              if (ciscoPasswordMatches(value, gate.value, gate.algo)) return { valid: true };
              essais += 1;
              return essais >= 3
                ? { valid: false, errorMessage: '% Bad secrets', maxRetries: 2 }
                : { valid: false, errorMessage: '% Access denied', maxRetries: 2 };
            },
          },
          {
            kind: 'run',
            run: async (rt) => {
              this.autoriserVue(nom);
              await rt.exec(nom === null ? 'enable view' : `enable view ${nom}`);
            },
          },
        ],
      };
    } finally {
      if (emprunte) this.deviceRef = null;
    }
  }

  /** La vue que `parser view <nom>` est en train de declarer. */
  protected vueEnCours(): import('../router/security/CiscoSecurityConfig').ParserView | undefined {
    if (!this.selectedParserView) return undefined;
    return getSecurityConfig(this.d()).parserViews.get(this.selectedParserView);
  }

  private _autorisation: CliAuthorization | null = null;

  /**
   * L'autorisation est reconstruite par shell mais lit les tables de
   * l'EQUIPEMENT : une regle posee sur la console vaut pour une session
   * SSH ouverte ensuite, ce qui ne serait pas le cas si elle vivait ici.
   */
  protected autorisation(): CliAuthorization {
    if (!this._autorisation) {
      this._autorisation = new CliAuthorization(
        new CommandLevelTable(() => ensurePrivilegeRules(this.deviceRef)),
        new ParserViewRegistry(() => {
          if (!this.deviceRef) return new Map();
          return getSecurityConfig(this.d()).parserViews;
        }),
        new CommandCanonicalizer({
          triesFor: (scope) => this.arbresDe(scope),
          socleParts: (scope, commande) => this.socleCanonicalParts(scope, commande),
        }),
      );
    }
    return this._autorisation;
  }

  /**
   * Les arbres consultes pour resoudre une abreviation, dans le MEME
   * ordre que `niveauParDefautDe` consulte les siens.
   *
   * L'ordre n'est pas un detail : si la canonicalisation et le niveau
   * par defaut lisaient deux arbres differents, ils pourraient decider
   * de deux commandes differentes pour une meme frappe — c'est
   * exactement la classe de defaut que ce chantier referme.
   */
  private arbresDe(scope: AuthScope): readonly CommandTrie[] {
    if (scope === 'exec') return [this.userTrie, this.privilegedTrie];
    // Les espaces `interface` et `line` nomment un arbre que le mode
    // COURANT n'est pas : `privilege interface level 5 shutdown` se tape
    // en configuration globale. Les nommer explicitement est ce qui
    // permet de canonicaliser une regle depuis le mode ou on l'ecrit.
    if (scope === 'interface') return [this.configIfTrie, this.configTrie];
    if (scope === 'line') return [this.configLineTrie, this.configTrie];
    return [this.configTrie, this.getActiveTrie()];
  }

  protected mandataire(): CliPrincipal {
    return { level: this.currentPrivilegeLevel, view: this.activeParserView };
  }

  /**
   * Le niveau d'une commande QUAND l'operateur n'a rien deplace.
   *
   * C'est la seule chose que l'autorisation ne peut pas savoir seule, et
   * elle etait jusqu'ici IMPLICITE — encodee dans « quel arbre porte la
   * commande ». L'ecrire rend la regle unique : une commande de l'arbre
   * utilisateur nait au niveau 1, tout le reste au niveau 15, et c'est
   * exactement ce que dit IOS.
   */
  protected niveauParDefautDe(cmdPart: string): number | null {
    const connue = (trie: CommandTrie): boolean => {
      const r = trie.match(cmdPart);
      return r.status === 'ok' || r.status === 'incomplete' || r.status === 'ambiguous';
    };
    if (this.mode === 'user' || this.mode === 'privileged') {
      if (connue(this.userTrie)) return 1;
      if (connue(this.privilegedTrie)) return 15;
    } else if (connue(this.getActiveTrie()) || connue(this.configTrie)) {
      return 15;
    }
    // Une commande MIGREE n'est plus dans aucun trie : sans cette
    // question au socle, elle passerait pour inconnue et IOS en ferait
    // un nom d'hote a joindre — donc `do write memory` refuse au niveau
    // reduit repondait par une resolution de nom.
    return this.niveauDeclareParLeSocle(cmdPart);
  }

  /**
   * La forme canonique d'une commande que seul le socle porte.
   *
   * Le chemin le plus LONG gagne, comme la marche du trie : sinon
   * `ip address` serait canonicalisee par `ip`, et une regle de niveau
   * ecrite sur l'une couvrirait l'autre. Deux chemins de meme longueur
   * rendent `null` — une abreviation ambigue ne doit pas faire porter
   * la decision d'autorisation sur une commande que l'operateur n'a pas
   * designee, ce que le canonicaliseur documente deja pour les tries.
   */
  private socleCanonicalParts(
    scope: AuthScope, commande: string,
  ): { keywords: string; full: string } | null {
    const table = this.socleTable();
    if (!table) return null;
    const mots = commande.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (mots.length === 0) return null;

    const candidats: string[][] = [];
    for (const chemin of this.cheminsDuSocle(table, scope)) {
      if (chemin.length > mots.length) continue;
      if (!chemin.every((mot, rang) => mot.startsWith(mots[rang]))) continue;
      candidats.push(chemin);
    }
    /*
     * Un mot TAPE EN ENTIER l'emporte sur un mot dont il n'est que le
     * debut, ET RANG PAR RANG.
     *
     * `sh ip traf` a deux candidats — `show ip traffic` et
     * `show ipv6 traffic`, `ipv6` commencant bien par `ip` — que juger
     * sur la ligne ENTIERE declarait ambigus, puisque `sh` n'est exact
     * dans aucun des deux. C'est la marche du trie qu'il faut refaire :
     * a chaque rang, si un candidat porte le mot EXACT, les autres
     * tombent. Sans cette regle, une regle de niveau ecrite en abrege
     * n'etait rangee nulle part.
     */
    let pool = candidats;
    for (let rang = 0; rang < mots.length; rang++) {
      const exacts = pool.filter(
        chemin => rang >= chemin.length || chemin[rang] === mots[rang]);
      if (exacts.length > 0 && exacts.length < pool.length) pool = exacts;
    }

    let meilleur: string[] | null = null;
    let ambigu = false;
    for (const chemin of pool) {
      if (meilleur === null || chemin.length > meilleur.length) {
        meilleur = chemin;
        ambigu = false;
      } else if (chemin.length === meilleur.length
        && chemin.join(' ') !== meilleur.join(' ')) {
        ambigu = true;
      }
    }
    if (meilleur === null || ambigu) return null;
    return {
      keywords: meilleur.join(' '),
      full: [...meilleur, ...mots.slice(meilleur.length)].join(' '),
    };
  }

  private cheminsDuSocle(table: CommandTable, scope: AuthScope): readonly string[][] {
    if (!this.socleCheminsParPortee) {
      const index = new Map<string, string[][]>();
      for (const spec of table.specs()) {
        const chemin = CiscoShellBase.keywordPathOf(spec);
        if (chemin.length === 0) continue;
        for (const portee of new Set(spec.modes.map(scopeForMode))) {
          const liste = index.get(portee) ?? [];
          liste.push(chemin);
          index.set(portee, liste);
        }
      }
      this.socleCheminsParPortee = index;
    }
    return this.socleCheminsParPortee.get(scope) ?? [];
  }

  private undoSansValeur(table: CommandTable, mode: string, chemin: string): boolean {
    if (!this.socleUndoSansValeur) {
      const vus = new Set<string>();
      for (const spec of table.specs()) {
        if (spec.undoRequiresArgument !== true) continue;
        const mots = CiscoShellBase.keywordPathOf(spec).join(' ');
        for (const m of spec.modes) vus.add(`${m} ${mots}`);
      }
      this.socleUndoSansValeur = vus;
    }
    return this.socleUndoSansValeur.has(`${mode} ${chemin}`);
  }

  private niveauDeclareParLeSocle(cmdPart: string): number | null {
    const table = this.socleTable();
    if (!table) return null;

    const mots = cmdPart.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (mots.length === 0) return null;

    const portee = scopeForMode(this.mode);
    let niveau: number | null = null;
    for (const spec of table.specs()) {
      const chemin = CiscoShellBase.keywordPathOf(spec);
      const absorbeLaSuite = spec.path.length > chemin.length;
      if (chemin.length < mots.length && !absorbeLaSuite) continue;
      const compares = Math.min(chemin.length, mots.length);
      if (!mots.slice(0, compares).every((mot, rang) => chemin[rang].startsWith(mot))) continue;
      if (compares < chemin.length && mots.length > compares) continue;
      if (!spec.modes.some(mode => scopeForMode(mode) === portee)) continue;
      const declare = table.requiredPrivilege(spec);
      niveau = niveau === null ? declare : Math.min(niveau, declare);
    }
    return niveau;
  }

  /**
   * Une configuration rendue, ramenee a ce que CETTE session peut
   * modifier.
   *
   * Au niveau 15 la sortie est rendue telle quelle : le cas courant ne
   * traverse aucune logique nouvelle, et le filtre ne peut donc pas
   * abimer ce que toutes les autres vues de la configuration attendent.
   */
  protected filtrerConfigurationParNiveau(texte: string): string {
    if (this.currentPrivilegeLevel >= 15) return texte;
    // Toute commande de configuration nait au niveau 15 sur IOS, quel
    // que soit son espace : c'est la delegation qui la descend.
    const lignes = filterConfigForLevel(texte.split('\n'), (scope, commande) =>
      this.autorisation().authorize({
        principal: this.mandataire(),
        scope,
        command: commande,
        defaultLevel: 15,
      }) === 'run');
    return this.retaillerEnTeteDeConfiguration(lignes).join('\n');
  }

  /**
   * L'en-tete decrit ce qui est RENDU, pas ce qui est cache.
   *
   * La taille est calculee avant le filtre, donc une session de niveau 5
   * lisait `Current configuration : 861 bytes` au-dessus d'un corps de 95
   * octets : l'en-tete decrivait un document qu'elle n'a pas sous les
   * yeux, et rendait mesurable — a l'octet pres — la quantite exacte de
   * configuration qu'on lui cache. C'est le contraire de ce que ce
   * filtre existe pour faire.
   */
  private retaillerEnTeteDeConfiguration(lignes: string[]): string[] {
    const rang = lignes.findIndex((l) => /^Current configuration : \d+ bytes$/.test(l));
    if (rang === -1) return lignes;
    const corps = lignes.slice(rang + 2).join('\n');
    const sortie = [...lignes];
    sortie[rang] = `Current configuration : ${new TextEncoder().encode(corps).length + 1} bytes`;
    return sortie;
  }

  /**
   * Le niveau auquel se trouve cette commande, ou `null` si ce mode ne
   * la connait dans aucun arbre.
   *
   * `device` est emprunte le temps de la lecture : cette methode est
   * appelee AVANT `execute`, donc avant que le shell ne tienne sa
   * reference — et une table de regles illisible rendrait le niveau par
   * defaut, c'est-a-dire la mauvaise liste d'autorisation.
   */
  niveauEffectifDe(cmdPart: string, device?: TDevice): number | null {
    const precedent = this.deviceRef;
    if (device !== undefined) this.deviceRef = device;
    try {
      const defaut = this.niveauParDefautDe(cmdPart);
      if (defaut === null) return null;
      return this.autorisation().levelOfCommand({
        principal: this.mandataire(),
        scope: scopeForMode(this.mode),
        command: cmdPart,
        defaultLevel: defaut,
      });
    } finally {
      this.deviceRef = precedent;
    }
  }

  /**
   * L'utilisateur au nom de qui cette session s'execute, ou `null` pour
   * la console anonyme. C'est ce qu'AAA soumet au serveur ; sans nom, il
   * n'y a rien a autoriser.
   */
  utilisateurDeSession(): string | null {
    return this.configSessionLabel === 'console' ? null : this.configSessionLabel;
  }

  /**
   * Adopter l'identite portee par l'instantane d'une session.
   *
   * `console` est la valeur SENTINELLE de « personne ne s'est
   * identifie » : la stocker telle quelle est ce qui permet a
   * `utilisateurDeSession` de repondre `null` sans distinguer un compte
   * nomme « console ».
   */
  adopterUtilisateurDeSession(user: string | null): void {
    this.configSessionLabel = user ?? 'console';
  }

  /**
   * La session voit-elle cette commande ?
   *
   * Le commentaire d'origine annoncait « une seule regle, deja ecrite »
   * et la methode en portait pourtant une SECONDE copie : elle
   * reconstruisait l'appel a `authorize` au lieu d'appeler le predicat
   * qui le fait. Les deux ont diverge des que l'un des deux a appris
   * quelque chose — la regle des noeuds intermediaires n'a d'abord porte
   * que sur celui que la CLI n'appelle pas.
   */
  protected laSessionVoit(cmdPart: string): boolean {
    return this.commandVisibleToNow(cmdPart, this.mode, {
      level: this.currentPrivilegeLevel,
      view: this.activeParserView,
    });
  }

  /**
   * La commande demandee exige-t-elle un niveau SUPERIEUR a celui de la
   * session ?
   *
   * La regle la plus longue gagne, comme dans l'arbre d'IOS :
   * `privilege exec level 7 show` et `privilege exec level 10 show
   * running-config` coexistent, et c'est la seconde qui decide pour
   * `show running-config`. Sans ce choix, l'ordre d'insertion dans la
   * table trancherait — donc le comportement dependrait de l'ordre de
   * frappe de l'operateur.
   */
  /**
   * Les regles exec atteignables par la session.
   *
   * Cette methode relisait la `Map` a la main, en reimplementant ce que
   * `grantedAtOrBelow` fait deja — la duplication meme que ce module
   * annonce avoir supprimee. Elle delegue.
   */
  private reglesExecAccordees(): Array<{ cible: string; niveau: number }> {
    return this.autorisation()
      .reglesAccordees('exec', this.currentPrivilegeLevel)
      .map((r) => ({ cible: r.commande, niveau: r.niveau }));
  }

  protected completionsAccordeesParNiveau(
    input: string, device?: TDevice,
  ): Array<{ keyword: string; description: string }> {
    if (!device) return [];
    if (this.mode !== 'user') return [];
    if (this.currentPrivilegeLevel <= 1 || this.currentPrivilegeLevel >= 15) return [];
    const precedent = this.deviceRef;
    this.deviceRef = device;
    try {
      const regles = this.reglesExecAccordees();
      if (regles.length === 0) return [];
      const prefixe = input.trim().toLowerCase();
      const partiel = input.endsWith(' ') ? '' : (prefixe.split(/\s+/).pop() ?? '');
      const base = input.endsWith(' ') ? prefixe : prefixe.slice(0, prefixe.length - partiel.length).trim();
      const out: Array<{ keyword: string; description: string }> = [];
      for (const { cible } of regles) {
        if (base.length > 0 && !cible.startsWith(base + ' ')) continue;
        // Le meme predicat que la tabulation. Les gardes ci-dessus sur
        // le mode et le niveau ecartaient deja le cas d'une vue, mais
        // sans jamais parler de vue : un garde qui protege pour une
        // raison qui n'est pas la sienne protege jusqu'au jour ou la
        // raison change.
        if (!this.laSessionVoit(cible)) continue;
        const reste = base.length > 0 ? cible.slice(base.length + 1) : cible;
        const mot = reste.split(/\s+/)[0];
        if (!mot || !mot.startsWith(partiel)) continue;
        const node = this.privilegedTrie.nodeAt(base.length > 0 ? `${base} ${mot}` : mot);
        out.push({ keyword: mot, description: node?.description ?? '' });
      }
      return out;
    } finally {
      this.deviceRef = precedent;
    }
  }

  /**
   * `privilege <mode> reset <commande>` — rend a la commande son niveau
   * d'origine. IOS documente le mot-cle avec `privilege exec reset
   * reload`, qui retire la ligne `privilege exec level N reload` de la
   * configuration ; sans ce retrait la regle survivrait au rechargement
   * de la topologie, la configuration rendue etant rejouee a l'import.
   */
  protected reinitialiserNiveauDeCommande(mode: string, commande: string): string {
    if (commande.trim().length === 0) return CISCO_ERRORS.INCOMPLETE;
    this.autorisation().resetCommandLevel(mode as AuthScope, commande);
    return '';
  }

  /**
   * Executer une commande contre l'arbre PRIVILEGIE depuis une session
   * en mode utilisateur. Ce n'est plus une decision d'autorisation —
   * elle est deja prise — mais un choix d'ARBRE : une commande descendue
   * au niveau 7 doit se comporter exactement comme au niveau 15, donc
   * passer par l'analyseur qui la porte vraiment.
   */
  private executeSurTriePrivilegie(cmdPart: string): string | null {
    const resultat = this.privilegedTrie.match(cmdPart);
    if (resultat.status !== 'ok' || !resultat.node?.action) return null;
    return resultat.node.action(resultat.args, cmdPart);
  }

  /**
   * `show running-config`/`show startup-config`/`show tech-support`/
   * `show archive` are privileged-only by design (`PRIVILEGED_ONLY_SHOW`)
   * — deliberately never copied into the user trie. At level 1 that's
   * fine (the user trie's own "not a real subcommand" handling already
   * covers it), but at an intermediate level the user trie's generic
   * `show <unrecognized>` fallback answers "% Incomplete command." (it
   * assumes any unmatched show argument is just not-yet-fully-typed),
   * which would leak the *existence* of the command. Real IOS shows the
   * identical "unknown command" response for a privilege-gated command as
   * for one that plain doesn't exist — this makes the simulator match.
   */
  private isPrivilegedOnlyShowCommand(cmdPart: string): boolean {
    const m = /^show\s+(\S+)/i.exec(cmdPart.trim());
    if (!m) return false;
    const sub = m[1].toLowerCase();
    for (const k of PRIVILEGED_ONLY_SHOW_CHILDREN) {
      if (k.startsWith(sub) || sub.startsWith(k)) return true;
    }
    return false;
  }

  /**
   * Une commande `show` executee hors session, pour le compte d'un
   * appelant qui n'a pas de shell a lui — la porte SSH non interactive.
   *
   * Le niveau etait FORCE a 15 : `ssh technicien@routeur "show
   * running-config"` rendait la configuration entiere a un compte
   * declare `privilege 7`. Les niveaux tenaient sur la console et
   * tombaient sur la porte par laquelle les administrateurs entrent
   * vraiment. Il est desormais un parametre, et 15 n'est que son defaut
   * — les appelants internes (diagnostic, serialisation) le gardent.
   */
  runShowCommandSync(device: TDevice, cmdPart: string, niveau = 15): string {
    const previousMode = this.mode;
    const previousLevel = this.currentPrivilegeLevel;
    const previousDevice = this.deviceRef;
    this.mode = niveau >= 15 ? 'privileged' : 'user';
    this.currentPrivilegeLevel = niveau;
    this.deviceRef = device;
    try {
      return this.executeOnTrie(cmdPart);
    } finally {
      this.mode = previousMode;
      this.currentPrivilegeLevel = previousLevel;
      this.deviceRef = previousDevice;
    }
  }

  /**
   * `undebug X` is `no debug X`, and IOS accepts every abbreviation down
   * to `u X`. Registering both spellings for each debug family would
   * guarantee the two drift apart the first time one gains an option, so
   * the synonym is resolved once, here, before the trie ever sees it.
   * `undebug all` keeps its own registration — it does more than clear
   * the flag registry.
   */
  private static undebugAsNoDebug(cmdPart: string): string | null {
    const m = /^\s*(u|un|und|unde|undeb|undebu|undebug)\s+(\S.*)$/i.exec(cmdPart);
    if (!m) return null;
    const rest = m[2].trim();
    if (/^all\b/i.test(rest)) return null;
    return `no debug ${rest}`;
  }

  /** Best-effort canonical interface name, for `debug condition interface`. */
  protected resolveInterfaceNameForDebug(raw: string): string | null {
    const dev = this.d() as unknown as { getPortNames?: () => string[] };
    const names = dev.getPortNames?.() ?? [];
    const flat = raw.replace(/\s+/g, '').toLowerCase();
    return names.find((n) => n.toLowerCase() === flat)
      ?? names.find((n) => n.toLowerCase().replace(/[a-z]/g, '') === flat.replace(/[a-z]/g, '')
        && n.toLowerCase().startsWith(flat.slice(0, 2)))
      ?? null;
  }

  /**
   * True for an exception a CALLER handles by name — a control-flow
   * signal, not a bug. Those must keep travelling: swallowing them here
   * would defeat the point of them being a named type (see
   * `CiscoSwitchShell`'s `UnsupportedOnThisSwitchError`, which is what
   * lets a generic switch refuse a command it cannot honestly answer).
   */
  protected isControlFlowError(_err: unknown): boolean { return false; }

  /** A handler threw something unforeseen: keep the trace for a developer. */
  private reportHandlerCrash(cmdPart: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[CLI] handler crashed on "${cmdPart}":`, detail);
  }

  private socleInstance?: CommandTable;
  /*
   * Les chemins du socle, indexes par PORTEE et par MODE.
   *
   * `socleCanonicalParts` et l'aide des negations parcouraient la table
   * entiere a chaque frappe et a chaque `?` ; la table ne change plus
   * une fois construite, donc l'index se calcule une fois avec elle.
   */
  private socleCheminsParPortee?: Map<string, string[][]>;
  private socleUndoSansValeur?: Set<string>;

  private readonly socleFields: Record<string, string | undefined> = {};

  protected clearSocleFields(fields: readonly string[]): void {
    for (const field of fields) delete this.socleFields[field];
  }

  /**
   * Ce que cette plateforme declare sur le socle.
   *
   * La base porte ce qu'un routeur ET un commutateur savent faire, chaque
   * shell ajoute le sien. Sans ce partage, une famille declaree dans
   * `CiscoShellBase` serait migree sur une plateforme et laissee dans le
   * trie sur l'autre, pour un code source unique.
   */

  private debugServiceRef(): {
    enable(c: string, scope?: string, detail?: boolean): string;
    disable(c: string): string;
    addCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string;
    removeCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string;
    removeConditionById(id: number): string;
    clearConditions(): void;
    enableAll?(): string;
    disableAll?(): string;
  } | undefined {
    return (this.d() as unknown as {
      getDebugService?: () => {
        enable(c: string, scope?: string, detail?: boolean): string;
        disable(c: string): string;
        addCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string;
        removeCondition(kind: 'interface' | 'vrf' | 'ip', value: string): string;
        removeConditionById(id: number): string;
        clearConditions(): void;
        enableAll?(): string;
        disableAll?(): string;
      };
    }).getDebugService?.();
  }

  protected dhcpViewServer(): DhcpViewServer | undefined {
    const device = this.d() as unknown as {
      _getDHCPServerInternal?: () => DhcpViewServer | undefined;
    };
    return device._getDHCPServerInternal?.();
  }

  versionText(): string { return ''; }

  runningConfigText(): string {
    const device = this.d() as unknown as { getRunningConfig?: () => string };
    return this.filtrerConfigurationParNiveau(device.getRunningConfig?.() ?? '');
  }

  runningConfigInterfaceText(_argument: string): string { return '% Invalid interface'; }

  startupConfigText(): string { return this.showStartupConfig(); }

  runningConfigAllText(): string {
    const device = this.d() as unknown as { getRunningConfig?: () => string };
    return device.getRunningConfig?.() ?? 'Building configuration...';
  }

  private debugEngines(): {
    ipsec?: { setDebug(kind: string, on: boolean): void };
    nat?: { setDebugEnabled(on: boolean): void; setDebugDetailed(on: boolean): void };
    dhcp?: { setDebugServerPacket(on: boolean): void; setDebugServerEvents(on: boolean): void };
  } {
    const device = this.d() as unknown as {
      _getIPSecEngineInternal?: () => { setDebug(kind: string, on: boolean): void } | undefined;
      _getNATEngine?: () => { setDebugEnabled(on: boolean): void; setDebugDetailed(on: boolean): void };
      _getDHCPServerInternal?: () => {
        setDebugServerPacket(on: boolean): void; setDebugServerEvents(on: boolean): void;
      } | undefined;
    } | undefined;
    return {
      ipsec: device?._getIPSecEngineInternal?.(),
      nat: device?._getNATEngine?.(),
      dhcp: device?._getDHCPServerInternal?.(),
    };
  }

  private natDebugSwitch(on: boolean, detail: boolean): void {
    const nat = this.debugEngines().nat;
    nat?.setDebugEnabled(on);
    nat?.setDebugDetailed(on && detail);
  }

  protected enableEveryDebug(): string {
    const { ipsec, nat, dhcp } = this.debugEngines();
    ipsec?.setDebug('isakmp', true);
    ipsec?.setDebug('ipsec', true);
    nat?.setDebugEnabled(true);
    dhcp?.setDebugServerPacket(true);
    dhcp?.setDebugServerEvents(true);
    return this.debugServiceRef()?.enableAll() ?? 'All possible debugging has been turned on';
  }

  protected disableEveryDebug(): string {
    const { ipsec, nat, dhcp } = this.debugEngines();
    ipsec?.setDebug('isakmp', false);
    ipsec?.setDebug('ipsec', false);
    ipsec?.setDebug('ikev2', false);
    nat?.setDebugEnabled(false);
    nat?.setDebugDetailed(false);
    dhcp?.setDebugServerPacket(false);
    dhcp?.setDebugServerEvents(false);
    return this.debugServiceRef()?.disableAll() ?? 'All possible debugging has been turned off';
  }

  private simpleDebugPair(
    word: string, category: string, description: string,
  ): DebugPair {
    return {
      path: ['debug', word], description, undoDescription: `Disable ${description}`,
      takesArguments: true,
      enable: () => this.debugServiceRef()?.enable(category) ?? '',
      disable: () => this.debugServiceRef()?.disable(category) ?? '',
    };
  }

  protected debugPairs(): DebugPair[] {
    const svc = () => this.debugServiceRef();
    const pairs: DebugPair[] = [
      {
        path: ['debug', 'arp'], description: 'Enable ARP debug',
        undoDescription: 'Disable ARP debug', takesArguments: false,
        enable: () => svc()?.enable('ip.arp') ?? 'ARP packet debugging is on',
        disable: () => svc()?.disable('ip.arp') ?? 'ARP packet debugging is off',
      },
      {
        path: ['debug', 'domain'], description: 'Debug DNS name resolution',
        undoDescription: 'Stop DNS debugging', takesArguments: false,
        enable: () => svc()?.enable('ip.domain') ?? 'Domain Name System debugging is on',
        disable: () => svc()?.disable('ip.domain') ?? '',
      },
      {
        path: ['debug', 'dhcp'], description: 'Debug DHCP',
        undoDescription: 'Stop DHCP debugging', takesArguments: false,
        enable: () => svc()?.enable('ip.dhcp.server') ?? '',
        disable: () => svc()?.disable('ip.dhcp.server') ?? '',
      },
      {
        path: ['debug', 'ip'], description: 'Enable IP debug',
        undoDescription: 'Disable IP debug', takesArguments: true,
        subKeywords: [
          { keyword: 'arp', description: 'Debug ARP packets' },
          { keyword: 'bgp', description: 'Debug BGP' },
          { keyword: 'dhcp', description: 'Debug DHCP' },
          { keyword: 'domain', description: 'Debug DNS name resolution' },
          { keyword: 'eigrp', description: 'Debug EIGRP' },
          { keyword: 'icmp', description: 'Debug ICMP packets' },
          { keyword: 'nat', description: 'Debug NAT' },
          { keyword: 'nhrp', description: 'Debug NHRP' },
          { keyword: 'packet', description: 'Debug all IP packets' },
          { keyword: 'pim', description: 'Debug PIM' },
          { keyword: 'rip', description: 'Debug RIP' },
          { keyword: 'routing', description: 'Debug routing table changes' },
          { keyword: 'ssh', description: 'Debug SSH' },
          { keyword: 'tcp', description: 'Debug TCP special events' },
          { keyword: 'udp', description: 'Debug UDP packets' },
        ],
        enable: (args) => this.enableIpDebug(args),
        disable: (args) => this.disableIpDebug(args),
      },
      {
        path: ['debug', 'all'], description: 'Enable all debugging',
        undoDescription: 'Disable all debugging', takesArguments: false,
        enable: () => this.enableEveryDebug(),
        disable: () => this.disableEveryDebug(),
      },
      {
        path: ['debug', 'standby'], description: 'Debug HSRP',
        undoDescription: 'Disable HSRP debug', takesArguments: true,
        enable: () => svc()?.enable('standby') ?? '',
        disable: () => svc()?.disable('standby') ?? '',
      },
      {
        path: ['debug', 'eigrp'], description: 'Debug EIGRP',
        undoDescription: 'Disable EIGRP debug', takesArguments: true,
        enable: (args) => {
          const sujet = (args[0] ?? '').toLowerCase();
          const annonce = EIGRP_DEBUG_SUBJECTS[sujet];
          if (sujet && !annonce) throw new CliInvalidInput({ token: args[0] });
          svc()?.enable('ip.eigrp');
          return annonce ?? 'EIGRP debugging is on';
        },
        disable: () => svc()?.disable('ip.eigrp') ?? '',
      },
      {
        path: ['debug', 'interface'], description: 'Debug interface state changes',
        undoDescription: 'Disable interface debug', takesArguments: true,
        enable: (args) => {
          const service = svc();
          const iface = args.join(' ').trim();
          if (!service) return 'Interface debugging is on';
          return service.enable('interface', iface || undefined);
        },
        disable: () => svc()?.disable('interface') ?? '',
      },
      {
        path: ['debug', 'lldp'], description: 'Debug LLDP',
        undoDescription: 'Disable LLDP debug', takesArguments: true,
        enable: () => svc()?.enable('lldp.packets') ?? 'LLDP packets debugging is on',
        disable: () => svc()?.disable('lldp.packets') ?? '',
      },
      {
        path: ['debug', 'cdp'], description: 'Debug CDP',
        undoDescription: 'Disable CDP debug', takesArguments: true,
        enable: () => svc()?.enable('cdp.packets') ?? 'CDP packets debugging is on',
        disable: () => svc()?.disable('cdp.packets') ?? '',
      },
      {
        path: ['debug', 'ipv6'], description: 'Debug IPv6',
        undoDescription: 'Disable IPv6 debug', takesArguments: true,
        subKeywords: [
          { keyword: 'icmp', description: 'ICMPv6 messages' },
          { keyword: 'nd', description: 'ICMPv6 Neighbor Discovery' },
          { keyword: 'packet', description: 'IPv6 packets' },
        ],
        enable: (args) => this.enableIpv6Debug(args),
        disable: (args) => {
          const category = CiscoShellBase.ipv6DebugCategory((args[0] ?? '').toLowerCase());
          if (!category) throw new CliInvalidInput({ token: args[0] });
          return svc()?.disable(category) ?? '';
        },
      },
      {
        path: ['debug', 'condition'], description: 'Restrict every debug to a condition',
        undoDescription: 'Remove a debug condition', takesArguments: true,
        enable: (args) => this.addDebugCondition(args),
        disable: (args) => this.removeDebugCondition(args),
      },
      this.simpleDebugPair('vrrp', 'vrrp', 'Debug VRRP'),
      this.simpleDebugPair('glbp', 'glbp', 'Debug GLBP'),
      this.simpleDebugPair('radius', 'radius', 'Debug RADIUS'),
      this.simpleDebugPair('tacacs', 'tacacs', 'Debug TACACS+'),
      {
        path: ['debug', 'ntp'], description: 'Debug NTP',
        undoDescription: 'Disable NTP debug', takesArguments: true,
        subKeywords: [
          { keyword: 'events', description: 'NTP events' },
          { keyword: 'packets', description: 'NTP packets' },
        ],
        enable: (args) => CiscoShellBase.ntpDebugSwitch(svc(), args, true),
        disable: (args) => CiscoShellBase.ntpDebugSwitch(svc(), args, false),
      },
      {
        path: ['debug', 'aaa'], description: 'Debug AAA',
        undoDescription: 'Disable AAA debug', takesArguments: true,
        subKeywords: [
          { keyword: 'accounting', description: 'AAA accounting' },
          { keyword: 'authentication', description: 'AAA authentication' },
          { keyword: 'authorization', description: 'AAA authorization' },
        ],
        enable: (args) => CiscoShellBase.aaaDebugSwitch(svc(), args, true),
        disable: (args) => CiscoShellBase.aaaDebugSwitch(svc(), args, false),
      },
    ];

    if (this.hasVxlanHardware()) {
      pairs.push({
        path: ['debug', 'vxlan'], description: 'Debug VXLAN',
        undoDescription: 'Disable VXLAN debug', takesArguments: true,
        enable: () => svc()?.enable('vxlan') ?? 'VXLAN debugging is on',
        disable: () => svc()?.disable('vxlan') ?? '',
      });
    }
    if (this.hasSwitchingHardware()) {
      pairs.push({
        path: ['debug', 'port-security'], description: 'Debug port security',
        undoDescription: 'Disable port-security debug', takesArguments: true,
        enable: () => svc()?.enable('port-security') ?? 'Port security debugging is on',
        disable: () => svc()?.disable('port-security') ?? '',
      });
    }
    return pairs;
  }

  private enableIpDebug(args: string[]): string {
    const sub = args.join(' ').toLowerCase();
    const svc = this.debugServiceRef();
    if (!svc) return 'IP debugging is on';
    if (sub === 'packet') return svc.enable('ip.packet');
    if (sub.startsWith('packet ')) {
      const detail = args.some((a) => /^detail$/i.test(a));
      const aclName = args.slice(1).find((a) => !/^detail$/i.test(a));
      if (!aclName) return svc.enable('ip.packet', undefined, detail);
      svc.enable('ip.packet', aclName, detail);
      return `IP packet debugging is on for access list ${aclName}${detail ? ' (detailed)' : ''}`;
    }
    if (sub === 'icmp') return svc.enable('ip.icmp');
    if (sub === 'domain') return svc.enable('ip.domain');
    if (sub === 'tcp' || sub.startsWith('tcp ')) {
      const reste = args.slice(1).filter(a => !/^transactions$/i.test(a));
      const acl = reste[0];
      svc.enable('ip.tcp', acl);
      return acl
        ? `TCP special event debugging is on for access list ${acl}`
        : 'TCP special event debugging is on';
    }
    if (sub === 'udp' || sub.startsWith('udp ')) {
      const acl = args.slice(1)[0];
      svc.enable('ip.udp', acl);
      return acl
        ? `UDP packet debugging is on for access list ${acl}`
        : 'UDP packet debugging is on';
    }
    if (sub === 'nat' || sub.startsWith('nat ')) {
      const detail = args.slice(1).some((a) => /^detailed?$/i.test(a));
      const acl = args.slice(1).find((a) => !/^detailed?$/i.test(a));
      this.natDebugSwitch(true, detail);
      svc.enable('ip.nat', acl, detail);
      return acl
        ? `IP NAT debugging is on for access list ${acl}${detail ? ' (detailed)' : ''}`
        : detail ? 'IP NAT detailed debugging is on' : 'IP NAT debugging is on';
    }
    if (sub === 'arp') return svc.enable('ip.arp');
    if (sub === 'routing') return svc.enable('ip.routing');
    if (sub.startsWith('dhcp server') || sub === 'dhcp') return svc.enable('ip.dhcp.server');
    if (sub === 'ssh') return svc.enable('ip.ssh');
    if (sub === 'rip') return svc.enable('ip.rip');
    if (sub === 'eigrp') return svc.enable('ip.eigrp');
    if (sub === 'bgp') return svc.enable('ip.bgp');
    if (sub === 'nhrp') return svc.enable('ip.nhrp');
    if (sub === 'pim') return svc.enable('ip.pim');
    throw new CliInvalidInput({ token: args[0] });
  }

  private disableIpDebug(args: string[]): string {
    const sub = args.join(' ').toLowerCase();
    const svc = this.debugServiceRef();
    if (!svc) return 'IP debugging is off';
    if (sub === 'packet' || sub.startsWith('packet ')) return svc.disable('ip.packet');
    if (sub === 'icmp') return svc.disable('ip.icmp');
    if (sub === 'domain') return svc.disable('ip.domain');
    if (sub === 'tcp' || sub.startsWith('tcp ')) return svc.disable('ip.tcp');
    if (sub === 'udp' || sub.startsWith('udp ')) return svc.disable('ip.udp');
    if (sub === 'nat' || sub.startsWith('nat ')) {
      this.natDebugSwitch(false, false);
      return svc.disable('ip.nat');
    }
    if (sub === 'arp') return svc.disable('ip.arp');
    if (sub === 'routing') return svc.disable('ip.routing');
    if (sub.startsWith('dhcp server') || sub === 'dhcp') return svc.disable('ip.dhcp.server');
    if (sub === 'ssh') return svc.disable('ip.ssh');
    if (sub === 'rip') return svc.disable('ip.rip');
    if (sub === 'eigrp') return svc.disable('ip.eigrp');
    if (sub === 'bgp') return svc.disable('ip.bgp');
    if (sub === 'nhrp') return svc.disable('ip.nhrp');
    if (sub === 'pim') return svc.disable('ip.pim');
    throw new CliInvalidInput({ token: args[0] });
  }

  private static ipv6DebugCategory(mot: string): 'ipv6.packet' | 'ipv6.nd' | 'ipv6.icmp' | null {
    if (mot === '' || mot.startsWith('packet')) return 'ipv6.packet';
    if ('nd'.startsWith(mot) || mot === 'nd') return 'ipv6.nd';
    if ('icmp'.startsWith(mot)) return 'ipv6.icmp';
    return null;
  }

  private enableIpv6Debug(args: string[]): string {
    const svc = this.debugServiceRef();
    const mots = args.map((a) => a.toLowerCase());
    const category = CiscoShellBase.ipv6DebugCategory(mots[0] ?? '');
    if (!category) throw new CliInvalidInput({ token: args[0] });
    if (!svc) return 'IPv6 packet debugging is on';
    const acl = category === 'ipv6.packet' ? args.slice(1).join(' ') : '';
    return acl ? svc.enable(category, acl) : svc.enable(category);
  }

  private static ntpDebugSwitch(
    svc: { enable(c: string): string; disable(c: string): string } | undefined,
    args: string[], on: boolean,
  ): string {
    if (!svc) return '';
    const sub = (args[0] ?? 'events').toLowerCase();
    const apply = (c: string) => (on ? svc.enable(c) : svc.disable(c));
    if ('events'.startsWith(sub)) return apply('ntp.events');
    if ('packets'.startsWith(sub)) return apply('ntp.packets');
    throw new CliInvalidInput({ token: args[0] });
  }

  private static aaaDebugSwitch(
    svc: { enable(c: string): string; disable(c: string): string } | undefined,
    args: string[], on: boolean,
  ): string {
    if (!svc) return '';
    const sub = (args[0] ?? '').toLowerCase();
    const apply = (c: string) => (on ? svc.enable(c) : svc.disable(c));
    if (sub && 'authentication'.startsWith(sub)) return apply('aaa.authentication');
    if (sub && 'authorization'.startsWith(sub)) return apply('aaa.authorization');
    if (sub && 'accounting'.startsWith(sub)) return apply('aaa.accounting');
    throw new CliInvalidInput({ token: args[0] });
  }

  private addDebugCondition(args: string[]): string {
    const svc = this.debugServiceRef();
    if (!svc) return '';
    const kind = (args[0] ?? '').toLowerCase();
    const value = args.slice(1).join(' ').trim();
    if (kind === '') return CISCO_ERRORS.INCOMPLETE;
    if (kind !== 'interface' && kind !== 'vrf' && kind !== 'ip') return CISCO_ERRORS.INVALID_INPUT;
    if (!value) return CISCO_ERRORS.INCOMPLETE;
    const resolved = kind === 'interface'
      ? (this.resolveInterfaceNameForDebug(value) ?? value)
      : value;
    return svc.addCondition(kind, resolved);
  }

  private removeDebugCondition(args: string[]): string {
    const svc = this.debugServiceRef();
    if (!svc) return '';
    const kind = (args[0] ?? '').toLowerCase();
    if (kind === 'all') { svc.clearConditions(); return 'All conditions have been removed'; }
    if (/^\d+$/.test(kind)) return svc.removeConditionById(parseInt(kind, 10));
    const value = args.slice(1).join(' ').trim();
    if (kind === '') return CISCO_ERRORS.INCOMPLETE;
    if (kind !== 'interface' && kind !== 'vrf' && kind !== 'ip') return CISCO_ERRORS.INVALID_INPUT;
    if (!value) return CISCO_ERRORS.INCOMPLETE;
    const resolved = kind === 'interface'
      ? (this.resolveInterfaceNameForDebug(value) ?? value)
      : value;
    return svc.removeCondition(kind, resolved);
  }

  private discoveryToggle(
    path: readonly string[], description: string, mode: string,
    on: () => void, off: () => void,
  ): CommandSpec {
    return {
      id: path.join('-'), path: [...path], description,
      modes: [mode], minPrivilege: 15,
      run: () => { on(); return ''; },
      undo: () => { off(); return ''; },
    };
  }

  private discoveryValue(
    path: readonly string[], description: string,
    low: number, high: number, apply: (value: number) => void,
  ): CommandSpec {
    return {
      id: path.join('-'),
      path: [...path, { name: 'value', type: 'INT' as const, range: [low, high] }],
      description, modes: ['config'], minPrivilege: 15,
      run: (_session, args) => { apply(parseInt(args.value ?? '', 10)); return ''; },
    };
  }

  protected discoverySpecs(): CommandSpec[] {
    const perPort = (apply: (port: string) => void) => () => {
      for (const port of this.selectedPortsForConfigIf()) apply(port);
    };

    return [
      this.discoveryToggle(['cdp', 'run'], 'Enable CDP globally', 'config',
        () => { this.configState.set('cdp', true); this.applyToCdpAgent(a => a.setEnabled(true)); },
        () => { this.configState.set('cdp', false); this.applyToCdpAgent(a => a.setEnabled(false)); }),
      this.discoveryToggle(['cdp', 'advertise-v2'], 'Advertise CDPv2 PDUs', 'config',
        () => this.applyToCdpAgent(a => (a as unknown as { setAdvertiseV2?: (v: boolean) => void }).setAdvertiseV2?.(true)),
        () => this.applyToCdpAgent(a => (a as unknown as { setAdvertiseV2?: (v: boolean) => void }).setAdvertiseV2?.(false))),
      this.discoveryToggle(['lldp', 'run'], 'Enable LLDP globally', 'config',
        () => { this.configState.set('lldp', true); this.applyToLldpAgent(a => a.setEnabled(true)); },
        () => { this.configState.set('lldp', false); this.applyToLldpAgent(a => a.setEnabled(false)); }),
      this.discoveryToggle(['cdp', 'enable'], 'Enable CDP on this interface', 'config-if',
        perPort(port => this.applyToCdpAgent(a => a.setPortEnabled(port, true))),
        perPort(port => this.applyToCdpAgent(a => a.setPortEnabled(port, false)))),
      this.discoveryToggle(['lldp', 'transmit'], 'Enable LLDP transmit on this interface', 'config-if',
        perPort(port => this.applyToLldpAgent(a => a.setPortTransmit(port, true))),
        perPort(port => this.applyToLldpAgent(a => a.setPortTransmit(port, false)))),
      this.discoveryToggle(['lldp', 'receive'], 'Enable LLDP receive on this interface', 'config-if',
        perPort(port => this.applyToLldpAgent(a => a.setPortReceive(port, true))),
        perPort(port => this.applyToLldpAgent(a => a.setPortReceive(port, false)))),

      this.discoveryValue(['cdp', 'timer'], 'Advertisement period (sec)',
        5, 254,
        value => this.applyToCdpAgent(a => a.setTimerSec(value))),
      this.discoveryValue(['cdp', 'holdtime'], 'Hold-time advertised to peers (sec)',
        10, 255,
        value => this.applyToCdpAgent(a => a.setHoldtimeSec(value))),
      this.discoveryValue(['lldp', 'timer'], 'Advertisement period (sec)',
        5, 32768,
        value => this.applyToLldpAgent(a => a.setTimerSec(value))),
      this.discoveryValue(['lldp', 'holdtime-multiplier'], 'TTL = timer x multiplier',
        2, 10,
        value => this.applyToLldpAgent(a => a.setHoldtimeMultiplier(value))),
      this.discoveryValue(['lldp', 'holdtime'], 'Holdtime in seconds',
        10, 3600,
        value => this.applyToLldpAgent(a => {
          const config = a.getConfig();
          a.setHoldtimeMultiplier(Math.max(2, Math.min(10, Math.round(value / config.timerSec))));
        })),
      this.discoveryValue(['lldp', 'reinit'], 'Re-init delay (sec)',
        1, 10,
        value => this.applyToLldpAgent(a => a.setReinitDelaySec(value))),
    ];
  }


  protected loggingEntries(): LoggingEntry[] {
    // Un filtre s'ecrit `drops X` ou `includes Y` : deux mots dont le
    // second est libre. Le socle n'a pas de type pour une paire, et
    // inventer un ENUM sur le premier laisserait le second sans place —
    // `REST` decrit ce qu'on sait : la suite est du texte.
    const LIGNE_FILTRE = { name: 'filtre', type: 'REST' as const };

    // Les phrases d'IOS viennent de la table qui les porte deja : les
    // retaper ici en ferait une seconde, et la premiere divergence
    // passerait inapercue. Le `<0-7>` en tete est un TYPE, pas une
    // valeur — c'est la plage qui le rend.
    const severites = severityValues().filter(value => !value.keyword.startsWith('<'));

    // L'argument de `logging buffered` est AMBIGU par conception et
    // resolu par sa VALEUR : `0-7` est une severite, `4096-2147483647`
    // une taille. La plage couvre les deux, les noms couvrent la severite
    // ecrite en toutes lettres.
    const tailleOuSeverite = (name: string) => ({
      name, type: 'INT' as const,
      range: [0, BUFFERED_SIZE_MAX] as const,
      // Les DEUX intervalles sont nommes, parce que la place accepte
      // deux choses differentes selon la valeur : une severite en bas,
      // une taille de tampon en haut. Une seule plage fusionnee ferait
      // croire que tout ce qui est entre les deux est admis.
      alternatives: [
        { keyword: '<0-7>', description: 'Logging severity level' },
        {
          keyword: `<${BUFFERED_SIZE_MIN}-${BUFFERED_SIZE_MAX}>`,
          description: 'Logging buffer size',
        },
      ],
      values: severites,
      optional: true,
    });

    return [
      { keyword: 'count', description: 'Count every log message and timestamp last occurrence' },
      { keyword: 'on', description: 'Enable logging to all supported destinations' },
      {
        keyword: 'server-arp',
        description: 'Enable sending ARP requests for syslog servers when first message is sent',
      },
      {
        keyword: 'userinfo',
        description: 'Enable logging of user info on privileged mode enabling',
      },
      {
        keyword: 'delimiter', description: 'Append delimiter to syslog messages',
        argument: {
          name: 'transport', type: 'ENUM',
          values: [{ keyword: 'tcp', description: 'Append delimiter to TCP syslog messages' }],
        },
      },
      {
        keyword: 'exception', description: 'Limit size of exception flush output',
        undoWithoutArgument: true,
        argument: {
          name: 'size', type: 'INT', range: [BUFFERED_SIZE_MIN, BUFFERED_SIZE_MAX],
        },
      },
      {
        keyword: 'facility', description: 'Facility parameter for syslog messages',
        undoWithoutArgument: true,
        argument: {
          name: 'facility', type: 'ENUM',
          values: FACILITY_NAMES.map(name => ({
            keyword: name, description: `${name} facility`,
          })),
        },
      },
      {
        keyword: 'message-counter', description: 'Configure log message counter',
        argument: {
          name: 'class', type: 'ENUM',
          values: [
            { keyword: 'debug', description: 'Count debug messages' },
            { keyword: 'log', description: 'Count log messages' },
            { keyword: 'syslog', description: 'Count syslog messages' },
          ],
        },
      },
      {
        keyword: 'origin-id', description: 'Add origin ID to syslog messages',
        undoWithoutArgument: true,
        argument: {
          name: 'mode', type: 'ENUM',
          values: [
            { keyword: 'hostname', description: 'Use hostname as ID' },
            { keyword: 'ip', description: 'Use IP address as ID' },
            { keyword: 'ipv6', description: 'Use IPv6 address as ID' },
            { keyword: 'string', description: 'Use a user-defined string as ID' },
          ],
        },
      },
      {
        keyword: 'snmp-trap', description: 'Set syslog level for sending snmp trap',
        undoWithoutArgument: true,
        argument: { name: 'severity', type: 'INT', range: [0, 7], values: severites },
      },
      {
        keyword: 'source-interface',
        description: 'Specify interface for source address in logging transactions',
        undoWithoutArgument: true,
        /*
         * `WORD` et non `IFACE` : c'est ce que la machine annoncait, la
         * declaration de `ciscoArgumentHelp` l'emportant sur celle-ci
         * jusqu'a l'elagage. Le type etroit refuserait en plus un nom
         * abrege que le gestionnaire resout.
         */
        argument: { name: 'interface', type: 'WORD',
          description: 'Interface used as the source address of syslog messages' },
      },
      {
        keyword: 'trap', description: 'Set syslog server logging level',
        undoWithoutArgument: true,
        argument: { name: 'severity', type: 'INT', range: [0, 7], values: severites },
      },
      {
        keyword: 'console', description: 'Set console logging parameters',
        argument: { name: 'level', type: 'INT', range: [0, 7], values: severites, optional: true },
        continuations: [{
          keyword: 'discriminator', description: 'Establish MD-Console association',
          argument: { name: 'nom', type: 'WORD' },
        }],
      },
      {
        keyword: 'monitor', description: 'Set terminal line (monitor) logging parameters',
        argument: { name: 'level', type: 'INT', range: [0, 7], values: severites, optional: true },
        continuations: [{
          keyword: 'discriminator', description: 'Establish MD-Monitor association',
          argument: { name: 'nom', type: 'WORD' },
        }],
      },
      {
        keyword: 'history', description: 'Configure syslog history table',
        argument: { name: 'level', type: 'INT', range: [0, 7], values: severites },
        continuationsReplaceArgument: true,
        undoWithoutArgument: true,
        continuations: [{
          keyword: 'size', description: 'Set history table size',
          argument: {
            name: 'entries', type: 'INT', range: [HISTORY_SIZE_MIN, HISTORY_SIZE_MAX],
          },
        }],
      },
      {
        keyword: 'persistent', description: 'Set persistent logging parameters',
        // `logging persistent url X size Y filesize Z` enchaine PLUSIEURS
        // paires sur une ligne : c'est une structure repetee qu'un chemin
        // fixe ne peut pas decrire. Le `REST` est donc fidele, et ses
        // FORMES nomment les six mots-cles pour que `?` les annonce
        // quand meme — l'acceptation reste permissive, l'aide non.
        argument: {
          name: 'options', type: 'REST', optional: true,
          alternatives: [
            { keyword: 'url', description: 'Location to store the persistent log' },
            { keyword: 'size', description: 'Total size of the persistent log' },
            { keyword: 'filesize', description: 'Size of an individual log file' },
            { keyword: 'immediate', description: 'Write each message as it is logged' },
            { keyword: 'batch', description: 'Write messages in batches of this size' },
            { keyword: 'threshold', description: 'Percentage of the log that triggers a notice' },
          ],
        },
      },
      {
        keyword: 'queue-limit', description: 'Set logger message queue size',
        undoWithoutArgument: true,
        argument: {
          name: 'taille', type: 'INT', range: [1, 2147483647],
          values: [
            { keyword: 'esm', description: 'Queue size for ESM filtered messages' },
            { keyword: 'trap', description: 'Queue size for messages sent to syslog servers' },
          ],
        },
        second: {
          name: 'valeur', type: 'INT', range: [1, 2147483647], optional: true,
          description: 'Number of messages the queue holds',
        },
      },
      {
        keyword: 'buffered', description: 'Set buffered logging parameters',
        argument: tailleOuSeverite('taille-ou-severite'),
        second: tailleOuSeverite('severite-ou-taille'),
        continuations: [{
          keyword: 'discriminator', description: 'Establish MD-Buffer association',
          argument: { name: 'nom', type: 'WORD' },
        }],
      },
      {
        keyword: 'discriminator', description: 'Create or modify a message discriminator',
        argument: { name: 'nom', type: 'WORD' },
        continuations: [
          { keyword: 'severity', description: 'Set severity filter', argument: LIGNE_FILTRE },
          { keyword: 'facility', description: 'Set facility filter', argument: LIGNE_FILTRE },
          { keyword: 'mnemonics', description: 'Set mnemonic filter', argument: LIGNE_FILTRE },
          { keyword: 'msg-body', description: 'Set message body filter', argument: LIGNE_FILTRE },
          {
            keyword: 'rate-limit', description: 'Set rate limit for this discriminator',
            argument: LIGNE_FILTRE,
          },
        ],
      },
      {
        keyword: 'reload', description: 'Set reload logging level',
        argument: { name: 'level', type: 'INT', range: [0, 7], values: severites, optional: true },
        continuations: [{
          keyword: 'message-limit', description: 'Maximum messages kept across a reload',
          argument: { name: 'limite', type: 'INT', range: [1, 4294967295] },
        }],
      },
      {
        keyword: 'rate-limit', description: 'Set messages per second limit',
        argument: {
          name: 'limit', type: 'INT', range: [RATE_LIMIT_MIN, RATE_LIMIT_MAX],
          values: [
            { keyword: 'all', description: 'Rate limit all messages' },
            { keyword: 'console', description: 'Rate limit console messages only' },
          ],
        },
        continuations: [{
          keyword: 'except',
          description: 'Messages of this severity or higher are not limited',
          argument: { name: 'severite', type: 'INT', range: [0, 7], values: severites },
        }],
      },
      {
        keyword: 'host', description: 'Set syslog server IP address and parameters',
        argument: { name: 'ip', type: 'IP_ADDR' },
        continuations: [
          {
            keyword: 'transport', description: 'Specify the transport protocol',
            argument: {
              name: 'protocole', type: 'ENUM',
              values: [
                { keyword: 'tcp', description: 'Send messages over TCP' },
                { keyword: 'udp', description: 'Send messages over UDP' },
              ],
            },
          },
          {
            keyword: 'discriminator', description: 'Establish MD-Host association',
            argument: { name: 'nom', type: 'WORD' },
          },
        ],
      },
    ];
  }

  protected loggingSpecs(): CommandSpec[] {
    return loggingFamily(this.loggingEntries(), () => ({
      applyLogging: (words, negate) => {
        const ctx = this.loggingCommandContext();
        ctx.beforeApply?.();
        const err = ctx.config().applyLogging(words, negate);
        if (err) {
          if (err.kind === 'incomplete') throw new CliIncomplete();
          throw new CliInvalidInput({ token: err.token });
        }
        ctx.afterApply?.();
        return '';
      },
    }));
  }


  protected ntpSpecs(): CommandSpec[] {
    const cle = {
      name: 'numero', type: 'INT' as const,
      range: [1, 4294967295] as const, description: 'Key number',
    };
    const serveur: SequenceEntry['tail'] = {
      name: 'options', type: 'REST', optional: true,
      alternatives: [
        { keyword: 'key', description: 'Configure peer authentication key' },
        { keyword: 'prefer', description: 'Prefer this peer when possible' },
        { keyword: 'source', description: 'Interface for source address' },
        { keyword: 'version', description: 'Configure NTP version' },
      ],
    };

    return sequenceFamily([
      { path: ['ntp', 'authenticate'], description: 'Authenticate time sources' },
      { path: ['ntp', 'logging'], description: 'Enable NTP message logging' },
      {
        path: ['ntp', 'update-calendar'],
        description: 'Periodically update calendar from NTP',
      },
      {
        path: ['ntp', 'server'], description: 'Configure NTP server',
        args: [{ name: 'adresse', type: 'IP_ADDR', description: 'IP address of peer' }],
        tail: serveur,
      },
      {
        path: ['ntp', 'peer'], description: 'Configure NTP peer',
        args: [{ name: 'adresse', type: 'IP_ADDR', description: 'IP address of peer' }],
        tail: serveur,
      },
      {
        path: ['ntp', 'master'], description: 'Act as NTP master clock',
        args: [{
          name: 'strate', type: 'INT', range: [1, 15],
          description: 'Stratum number', optional: true,
        }],
      },
      {
        path: ['ntp', 'source'], description: 'Configure interface for source address',
        args: [{
          name: 'interface', type: 'WORD',
          description: 'Interface to use for source address',
        }],
        undoArgs: [],
      },
      {
        path: ['ntp', 'trusted-key'],
        description: 'Key numbers for trusted time sources',
        args: [cle],
      },
      {
        path: ['ntp', 'authentication-key'],
        description: 'Authentication key for trusted time sources',
        args: [
          cle,
          {
            name: 'algorithme', type: 'ENUM', description: 'Authentication type',
            values: [{ keyword: 'md5', description: 'MD5 authentication' }],
          },
          { name: 'cle', type: 'WORD', description: 'Authentication key' },
        ],
        undoArgs: [cle],
      },
      {
        path: ['ntp', 'access-group'], description: 'Control NTP access',
        args: [
          {
            name: 'famille', type: 'ENUM',
            values: [
              { keyword: 'peer', description: 'Provide full access' },
              { keyword: 'query-only', description: 'Allow only control queries' },
              { keyword: 'serve', description: 'Provide server and query access' },
              { keyword: 'serve-only', description: 'Provide only server access' },
            ],
          },
          { name: 'liste', type: 'INT', range: [1, 199], description: 'Access list number' },
        ],
      },
      {
        path: ['ntp', 'allow'], description: 'Allow processing of packets',
        args: [
          {
            name: 'mode', type: 'ENUM',
            values: [{ keyword: 'mode', description: 'Allow processing of control mode packets' }],
          },
          {
            name: 'controle', type: 'ENUM',
            values: [{ keyword: 'control', description: 'Control mode packets' }],
          },
        ],
      },
    ], () => ({
      apply: (words, negate) =>
        negate ? this.retirerNtp(words) : this.appliquerNtp(words),
    }));
  }

  /**
   * `sntp` est la moitie legere de NTP, et elle partage son moteur.
   *
   * `sntp server` etait declare sur l'arbre PRIVILEGIE en plus de celui
   * de configuration, donc une commande de configuration etait acceptee
   * a l'invite d'EXEC, ou une vraie machine la refuse. Les modes sont
   * desormais declares, et il n'y en a qu'un.
   */
  protected sntpSpecs(): CommandSpec[] {
    const cible: ArgumentSpec = {
      name: 'cible', type: 'WORD',
      description: 'IP address or hostname of the SNTP server',
    };

    return sequenceFamily([
      {
        path: ['sntp', 'server'], description: 'SNTP server (alias for ntp server)',
        args: [cible],
        tail: {
          name: 'options', type: 'REST', optional: true,
          description: 'Preference of this server',
          alternatives: [
            { keyword: 'prefer', description: 'Prefer this peer when possible' },
          ],
        },
      },
      {
        path: ['sntp', 'unicast'], description: 'SNTP unicast client',
        args: [{
          name: 'client', type: 'ENUM', optional: true,
          description: 'Act as an SNTP unicast client',
          values: [{ keyword: 'client', description: 'Act as an SNTP unicast client' }],
        }],
      },
      {
        path: ['sntp', 'broadcast'], description: 'SNTP broadcast client',
        args: [{
          name: 'client', type: 'ENUM',
          description: 'Act as an SNTP broadcast client',
          values: [{ keyword: 'client', description: 'Act as an SNTP broadcast client' }],
        }],
      },
      { path: ['sntp', 'logging'], description: 'Enable SNTP message logging' },
    ], () => ({
      apply: (words, negate) =>
        negate ? this.retirerSntp(words) : this.appliquerSntp(words),
    }));
  }

  private appliquerSntp(args: string[]): string {
    const a = args.map(s => s.toLowerCase());
    const agent = getNtpAgent(this.d());
    if (a[0] === 'server') {
      if (!args[1]) return CISCO_ERRORS.INCOMPLETE;
      const target = this.resolveNtpTarget(args[1]);
      if (!target) {
        return `Translating "${args[1]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
      }
      agent?.addServer(target, a.includes('prefer'), undefined, 'sntp');
    } else if (a[0] === 'broadcast') {
      agent?.setSntpBroadcastClient(true);
    } else if (a[0] === 'logging') {
      agent?.setLogging(true, 'sntp');
    }
    return '';
  }

  private retirerSntp(args: string[]): string {
    const a = args.map(s => s.toLowerCase());
    const agent = getNtpAgent(this.d());
    if (a[0] === 'server' && a[1]) agent?.removeServer(a[1]);
    else if (a[0] === 'broadcast') agent?.setSntpBroadcastClient(false);
    else if (a[0] === 'logging') agent?.setLogging(false);
    return '';
  }


  protected snmpSpecs(): CommandSpec[] {
    const texte = (name: string, description: string) =>
      ({ name, type: 'LINE' as const, description });
    const nom = (name: string, description: string) =>
      ({ name, type: 'WORD' as const, description });
    const suite = (description: string, mots: ReadonlyArray<[string, string]>) => ({
      name: 'options', type: 'REST' as const, optional: true, description,
      alternatives: mots.map(([keyword, d]) => ({ keyword, description: d })),
    });

    const entries: SequenceEntry[] = [
      {
        path: ['snmp-server', 'community'],
        description: 'Set community string and access privs',
        args: [nom('communaute', 'SNMP community string')],
        tail: suite('Access privileges and access list', [
          ['ro', 'Read-only access'], ['rw', 'Read-write access'],
        ]),
      },
      {
        path: ['snmp-server', 'host'],
        description: 'Specify hosts to receive SNMP notifications',
        args: [{
          name: 'adresse', type: 'IP_ADDR',
          description: 'IP address of SNMP notification host',
        }],
        tail: suite('Notification type, version and community', [
          ['informs', 'Send Inform requests'], ['traps', 'Send Trap messages'],
          ['udp-port', 'UDP destination port'], ['version', 'SNMP version to use'],
        ]),
      },
      {
        path: ['snmp-server', 'group'], description: 'Define an SNMP group',
        args: [nom('groupe', 'SNMP group name')],
        tail: suite('Version and view association', [
          ['v1', 'SNMPv1 group'], ['v2c', 'SNMPv2c group'], ['v3', 'SNMPv3 group'],
        ]),
      },
      {
        path: ['snmp-server', 'user'], description: 'Define an SNMP user',
        args: [nom('utilisateur', 'SNMP user name')],
        tail: suite('Group, version and authentication', [
          ['v1', 'SNMPv1 user'], ['v2c', 'SNMPv2c user'], ['v3', 'SNMPv3 user'],
        ]),
      },
      {
        path: ['snmp-server', 'view'], description: 'Define an SNMPv2 MIB view',
        args: [nom('vue', 'SNMP view name'), nom('oid', 'MIB subtree to include or exclude')],
        tail: suite('Inclusion of the subtree', [
          ['excluded', 'Exclude the subtree'], ['included', 'Include the subtree'],
        ]),
      },
      {
        path: ['snmp-server', 'enable', 'traps'], description: 'Enable SNMP traps',
        tail: suite('Notification type', [
          ['config', 'Configuration change notifications'],
          ['snmp', 'Standard SNMP notifications'],
          ['syslog', 'Syslog notifications'],
        ]),
      },
      {
        path: ['snmp-server', 'contact'], description: 'Text for mib object sysContact',
        args: [texte('contact', 'Contact information')],
      },
      {
        path: ['snmp-server', 'location'], description: 'Text for mib object sysLocation',
        args: [texte('emplacement', 'Physical location of this node')],
      },
      {
        path: ['snmp-server', 'chassis-id'],
        description: 'String to uniquely identify this chassis',
        args: [texte('identifiant', 'Chassis identifier')],
      },
      {
        path: ['snmp-server', 'trap-source'],
        description: 'Assign an interface for the source address of all traps',
        args: [{
          name: 'interface', type: 'INTERFACE',
          description: 'Interface used as the source address',
        }],
      },
      {
        path: ['snmp-server', 'trap-timeout'],
        description: 'Set timeout for TRAP message retransmissions',
        args: [{
          name: 'secondes', type: 'INT', range: [1, 1000],
          description: 'Retransmission timeout in seconds',
        }],
      },
      {
        path: ['snmp-server', 'engineid', 'local'],
        description: 'Configure a local SNMP engine ID',
        args: [nom('identifiant', 'Engine ID octet string')],
      },
    ];

    // `SnmpService.configure()` ne prend pas de drapeau de negation et
    // rien n'enregistre `no snmp-server` aujourd'hui : declarer un `undo`
    // ferait REPOSER ce qu'on demande de retirer.
    return sequenceFamily(
      entries.map(entry => ({ ...entry, negatable: false })),
      () => ({
        apply: (words) => {
          const svc = getSnmpService(this.d());
          if (!svc) return '';
          svc.configure(words);
          this.syncSnmpAgent();
          return '';
        },
      }));
  }



  protected clockSpecs(): CommandSpec[] {
    return sequenceFamily([
      {
        path: ['clock', 'set'], description: 'Set the system clock',
        modes: ['privileged', 'config'],
        args: [{
          name: 'heure', type: 'WORD', literal: 'hh:mm:ss',
          description: 'Current time', pattern: /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
        }],
        tail: {
          name: 'date', type: 'REST', optional: true, description: 'Day, month and year',
        },
        negatable: false,
      },
      {
        path: ['clock', 'timezone'], description: 'Set timezone',
        args: [
          { name: 'zone', type: 'WORD', description: 'Name of time zone' },
          { name: 'heures', type: 'INT', range: [-23, 23], description: 'Hours offset from UTC' },
          {
            name: 'minutes', type: 'INT', range: [0, 59], optional: true,
            description: 'Minutes offset from UTC',
          },
        ],
      },
      {
        path: ['clock', 'summer-time'], description: 'Configure daylight saving time',
        args: [{ name: 'zone', type: 'WORD', description: 'Name of time zone in summer' }],
        tail: {
          name: 'regle', type: 'REST', optional: true, description: 'Recurrence rule',
          alternatives: [
            { keyword: 'date', description: 'Specific date the change occurs' },
            { keyword: 'recurring', description: 'Recurring summer time' },
          ],
        },
      },
    ], () => ({ apply: (words) => this.applyClock(words) }));
  }

  private applyClock(words: string[]): string {
    const [tete, ...reste] = words;
    if (tete === 'set') return this.applyClockSet(reste);

    const mgmt = getManagementService(this.d());
    if (!mgmt) return '';
    const config = mgmt.getClock();

    if (tete === 'timezone') {
      const heures = parseInt(reste[1] ?? '', 10);
      const minutes = parseInt(reste[2] ?? '0', 10);
      config.timezone = reste[0];
      config.offsetMin = (isNaN(heures) ? 0 : heures) * 60
        + (isNaN(minutes) ? 0 : minutes) * (heures < 0 ? -1 : 1);
      return '';
    }

    config.summerTimezone = reste[0];
    if (reste[1]?.toLowerCase() === 'recurring') {
      config.daylightStart = reste.slice(2, 6).join(' ');
      config.daylightEnd = reste.slice(6, 10).join(' ');
    }
    return '';
  }



  protected loginSpecs(): CommandSpec[] {
    return sequenceFamily([
      {
        path: ['login', 'block-for'], description: 'Set the login blocking period',
        args: [{
          name: 'secondes', type: 'INT', range: [1, 65535],
          description: 'Duration of the blocking period',
        }],
        tail: {
          name: 'options', type: 'REST', optional: true,
          description: 'Attempt threshold and observation window',
          alternatives: [
            { keyword: 'attempts', description: 'Number of failures that triggers the block' },
            { keyword: 'within', description: 'Window in which the failures are counted' },
          ],
        },
      },
      {
        path: ['login', 'delay'], description: 'Set delay between successive login attempts',
        args: [{
          name: 'secondes', type: 'INT', range: [1, 65535],
          description: 'Delay between successive login attempts',
        }],
      },
      {
        path: ['login', 'quiet-mode', 'access-class'],
        description: 'Access class applied during the quiet period',
        args: [{ name: 'liste', type: 'WORD', description: 'Access list name or number' }],
      },
      {
        path: ['login', 'on-failure', 'log'], description: 'Log every failed login',
      },
      {
        path: ['login', 'on-success', 'log'], description: 'Log every successful login',
      },
    ], () => ({ apply: (words) => this.applyLogin(words) }));
  }

  private applyLogin(words: string[]): string {
    const securite = getSecurityConfig(this.d() as object);
    const [tete, ...reste] = words;

    if (tete === 'delay') {
      securite.login.delay = parseInt(reste[0], 10);
      return '';
    }
    if (tete === 'quiet-mode') {
      securite.login.quietModeAcl = reste[1];
      return '';
    }
    if (tete === 'on-failure') { securite.login.onFailureLog = true; return ''; }
    if (tete === 'on-success') { securite.login.onSuccessLog = true; return ''; }

    const secondes = parseInt(reste[0], 10);
    let tentatives = 0;
    let fenetre = 0;
    for (let rang = 1; rang < reste.length; rang++) {
      if (reste[rang] === 'attempts' && reste[rang + 1]) tentatives = parseInt(reste[rang + 1], 10);
      if (reste[rang] === 'within' && reste[rang + 1]) fenetre = parseInt(reste[rang + 1], 10);
    }
    securite.login.blockFor = { seconds: secondes, attempts: tentatives, withinSeconds: fenetre };
    const routeur = this.d() as unknown as {
      _configureLoginBlock?: (s: number, a: number, w: number) => void;
    };
    routeur._configureLoginBlock?.(secondes, tentatives, fenetre);
    return '';
  }


  protected clearSpecs(): CommandSpec[] {
    // Les deux modes d'EXEC, parce que c'est l'AUTORISATION qui tranche :
    // `privilege exec level 7 clear counters` descend la commande a un
    // utilisateur qui reste en EXEC utilisateur, invite `>` comprise.
    const exec = ['user', 'privileged'];

    return sequenceFamily([
      {
        path: ['clear', 'arp-cache'], description: 'Clear the entire ARP cache',
        modes: exec, negatable: false,
      },
      {
        path: ['clear', 'history'], description: 'Clear the command history buffer',
        modes: exec, negatable: false, minPrivilege: 1,
      },
      {
        path: ['clear', 'host'], description: 'Delete entries from the host table',
        args: [{
          name: 'nom', type: 'WORD',
          description: 'Host entry to delete, or * for every learned entry',
        }],
        modes: exec, negatable: false, minPrivilege: 1,
      },
      {
        path: ['clear', 'aaa', 'local', 'user', 'lockout', 'username'],
        description: 'Unlock a locally-locked-out user',
        args: [{ name: 'nom', type: 'WORD', description: 'Username to unlock' }],
        modes: exec, negatable: false,
      },
      {
        path: ['clear', 'counters'], description: 'Clear interface counters',
        modes: exec, negatable: false,
        args: [{
          name: 'interface', type: 'INTERFACE', optional: true,
          description: 'Interface to clear',
        }],
      },
      {
        path: ['clear', 'logging'], description: 'Clear the syslog buffer',
        modes: exec, negatable: false,
      },
      {
        path: ['clear', 'ip', 'arp'], description: 'Clear the ARP cache',
        modes: exec, negatable: false,
        args: [{
          name: 'adresse', type: 'IP_ADDR', optional: true,
          description: 'Address to remove from the cache',
        }],
      },
      {
        path: ['clear', 'ip', 'route'], description: 'Delete route table entries',
        modes: exec, negatable: false,
        tail: { name: 'cible', type: 'REST', optional: true, description: 'Route to clear' },
      },
      {
        path: ['clear', 'ip', 'bgp'], description: 'Reset BGP sessions',
        modes: exec, negatable: false,
        tail: { name: 'cible', type: 'REST', optional: true, description: 'Neighbour to reset' },
      },
      {
        path: ['clear', 'ip', 'eigrp'], description: 'Clear EIGRP neighbours or counters',
        modes: exec, negatable: false,
        args: [{
          name: 'sujet', type: 'ENUM', optional: true, description: 'What to clear',
          values: [
            { keyword: 'neighbors', description: 'Drop the adjacencies' },
            { keyword: 'traffic', description: 'Reset the traffic counters' },
          ],
        }],
      },
    ], () => ({ apply: (words) => this.applyClear(words) }));
  }

  private applyClear(words: string[]): string {
    const [tete, ...reste] = words;

    if (tete === 'arp-cache') {
      (this.d() as unknown as { _clearARPCache?: () => void })._clearARPCache?.();
      return '';
    }

    if (tete === 'history') {
      this.cmdHistory = [];
      return '';
    }

    if (tete === 'host') {
      const table = this.dnsCommandContext().hosts();
      if (!table) return '';
      if (reste[0] === '*') table.clearLearned();
      else table.remove(reste[0]);
      return '';
    }

    if (tete === 'aaa') {
      const nom = reste[reste.length - 1];
      (this.d() as unknown as { getCredentialStore?: () => { unlock(n: string): void } })
        .getCredentialStore?.().unlock(nom);
      return '';
    }

    if (tete === 'counters') {
      const ports = this.d()._getPortsInternal();
      const cible = reste[0];
      let compte = 0;
      for (const [nom, port] of ports) {
        if (cible && nom.toLowerCase() !== cible.toLowerCase()) continue;
        (port as unknown as { resetCounters?: () => void }).resetCounters?.();
        compte++;
      }
      if (compte === 0) return '% No matching interface';
      return `Clear "show interface" counters on ${cible ? `interface ${cible}` : 'all interfaces'} [confirm]`;
    }

    if (tete === 'logging') {
      this.attachLoggingToDevice(this.d());
      (this.logging as unknown as { clearBuffer?: () => void }).clearBuffer?.();
      return '';
    }

    const dev = this.d() as unknown as {
      _clearArpEntry?: (ip?: string) => number;
      arpTable?: Map<string, unknown>;
      _clearDynamicRoutes?: () => void;
      getEIGRPEngine?: () => { clearNeighbors?: () => void; resetTraffic?: () => void };
    };

    if (reste[0] === 'arp') {
      if (reste[1]) {
        return (dev._clearArpEntry?.(reste[1]) ?? 0) === 0 ? '% No matching ARP entry' : '';
      }
      dev.arpTable?.clear();
      return '';
    }
    if (reste[0] === 'route') { dev._clearDynamicRoutes?.(); return ''; }
    if (reste[0] === 'eigrp') {
      const moteur = dev.getEIGRPEngine?.();
      if (!moteur) return '';
      if ((reste[1] ?? 'neighbors').toLowerCase() === 'traffic') moteur.resetTraffic?.();
      else moteur.clearNeighbors?.();
    }
    return '';
  }


  /**
   * Les vues des deux familles deja migrees, `ntp` et `snmp-server`.
   *
   * Une vue et la commande qu'elle montre lisent le MEME magasin : les
   * laisser dans deux moteurs differents ferait porter a chacun la
   * moitie d'une famille, et l'aide de l'une cesserait de decrire ce que
   * l'autre configure.
   */
  private showSntp(): string {
    const entete = 'SNTP server   Stratum   Version   Last Receive';
    const agent = getNtpAgent(this.d());
    const cfg = agent?.getConfig?.();
    const associations = [...(cfg?.associations?.values() ?? [])];
    if (associations.length === 0) return 'No SNTP servers configured';

    const maintenant = agent?.now?.() ?? Date.now();
    const ligne = (a: {
      serverIp: string; stratum: number; lastReplyMs: number; synced: boolean;
    }): string => [
      a.serverIp.padEnd(14),
      String(a.stratum).padEnd(10),
      String(NTP_VERSION).padEnd(10),
      (a.lastReplyMs > 0 ? hms(maintenant - a.lastReplyMs) : '-').padEnd(14),
      a.synced ? 'Synced' : '',
    ].join('').trimEnd();

    return [entete, ...associations.map(ligne)].join('\n');
  }

  private lineSpecs(): CommandSpec[] {
    const suites = new Map(LINE_KEYWORD_SUITES.map(([kw, liste]) => [kw, liste]));
    const negations = new Map(suites.get('no') ?? []);
    return specsFromTrieRegistrations(
      (collector) => this.registerLineCommands(collector as unknown as CommandTrie),
      {
        modes: ['config-line'], minPrivilege: 15,
        undoFrom: 'no',
        undoDescriptionFor: (path) => negations.get(path),
        argumentFor: (path) => LINE_ARGUMENTS[path],
        reachableWhenFor: (path) => () => this.lineKeywordAllowed(path),
        keywordsFor: (path) => path === 'transport'
          ? LINE_TRANSPORT_KEYWORDS
          : suites.get(path)?.map(([keyword, description]) => ({
          keyword, description,
          argument: LINE_KEYWORD_ARGUMENTS[`${path} ${keyword}`],
        })),
      },
    );
  }

  private registerLineTransportCommands(t: CommandTrie): void {
    t.registerGreedy('login-timeout', 'Set login timeout', (args) => {
      if (args.length === 0) throw new CliIncomplete();
      const secondes = Number.parseInt(args[0], 10);
      if (!/^\d+$/.test(args[0]) || secondes < 1 || secondes > 300) {
        throw new CliInvalidInput({ token: args[0] });
      }
      const range = this.selectedVtyRange;
      if (!range) return '';
      const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
      dev._getVtyLineConfig?.().upsert({
        first: range.first, last: range.last, loginTimeoutSeconds: secondes,
      });
      return '';
    });
    t.registerGreedy('exec-timeout', 'Set line exec timeout', (args) => {
      if (args.length === 0) return '% Incomplete command.';
      if (!/^\d+$/.test(args[0]) || (args[1] !== undefined && !/^\d+$/.test(args[1]))) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      const range = this.selectedVtyRange;
      if (!range) {
        if (this.selectedConsoleLine != null) {
          this.consoleLineExecTimeoutMin = parseInt(args[0], 10);
          this.consoleLineExecTimeoutSec = parseInt(args[1] ?? '0', 10);
        }
        return '';
      }
      const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
      dev._getVtyLineConfig?.().upsert({
        first: range.first, last: range.last,
        execTimeoutMinutes: parseInt(args[0], 10),
        execTimeoutSeconds: parseInt(args[1] ?? '0', 10),
      });
      return '';
    });
    // `access-class <acl> {in|out}` — VTY ACL gate (§21).
    t.registerGreedy('access-class', 'Apply ACL to VTY', (args) => {
      this.requireLineKind('access-class');
      const range = this.selectedVtyRange;
      if (!range) return '';
      if (!args[0] || !args[1]) return '% Incomplete command.';
      const dir = args[1].toLowerCase();
      if (dir !== 'in' && dir !== 'out') return CISCO_ERRORS.INVALID_INPUT;
      const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
      const field = dir === 'out' ? 'accessClassOut' : 'accessClassIn';
      dev._getVtyLineConfig?.().upsert({ first: range.first, last: range.last, [field]: args[0] });
      return '';
    });
    // `transport input {all|ssh|telnet|none}` — the only line directive
    // we *do* react to today, because the sshd dispatch needs to know
    // whether SSH is administratively allowed on the VTY. Anything we
    // don't recognise is accepted silently, matching real IOS.
    t.registerGreedy('transport', 'transport input/output', (args) => {
      const dev = this.d() as unknown as {
        _setVtyTransportInput?: (
          t: 'ssh' | 'telnet' | 'all' | 'none',
          range?: { first: number; last: number },
        ) => void;
      };
      const dir = args[0]?.toLowerCase();
      if (!dir) return CISCO_ERRORS.INCOMPLETE;
      // `preferred` existe sur IOS et ne s'applique qu'aux connexions
      // sortantes d'un serveur de terminaux : il est accepté et
      // n'entraîne rien ici, mais il est refusé plutôt que stocké
      // inerte, faute de quoi l'aide promettrait un réglage sans effet.
      if (dir !== 'input' && dir !== 'output') return CISCO_ERRORS.INVALID_INPUT;
      const proto = (args[1] ?? '').toLowerCase();
      if (!proto) return '% Incomplete command.';
      if (proto !== 'all' && proto !== 'ssh' && proto !== 'telnet' && proto !== 'none') {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      if (dir !== 'input') return '';
      if (this.selectedAuxLine != null) {
        this.auxLineTransportInput = proto;
        return '';
      }
      if (typeof dev._setVtyTransportInput === 'function') {
        dev._setVtyTransportInput(proto, this.selectedVtyRange ?? undefined);
      }
      return '';
    });
  }

  private registerLineCommands(t: CommandTrie): void {
    this.registerLineTransportCommands(t);
    for (const kw of ['login', 'password',
      'logging', 'privilege', 'no', 'speed', 'stopbits', 'databits', 'parity',
      'flowcontrol', 'session-timeout', 'history', 'length', 'width', 'authorization',
      'accounting', 'rotary', 'autocommand', 'motd-banner', 'exec',
      'absolute-timeout', 'escape-character']) {
      t.registerGreedy(kw, `line ${kw}`, (args, raw) => {
        this.requireLineKind(kw);
        const range = this.selectedVtyRange;
        if (!range) {
          if (this.selectedAuxLine != null) {
            if (kw === 'exec') { this.auxLineNoExec = false; return ''; }
            if (kw === 'no' && args[0]?.toLowerCase() === 'exec') { this.auxLineNoExec = true; return ''; }
            return '';
          }
          if (this.selectedConsoleLine == null) return '';
          if (kw === 'password') {
            if (!args[0]) return '% Incomplete command.';
            let pwArgs = [...args];
            this.consoleLinePasswordEncrypted = false;
            if (pwArgs[0] === '0') pwArgs = pwArgs.slice(1);
            else if (pwArgs[0] === '7') { this.consoleLinePasswordEncrypted = true; pwArgs = pwArgs.slice(1); }
            this.consoleLinePassword = pwArgs.join(' ');
            return '';
          }
          if (kw === 'login') {
            const sub = args[0]?.toLowerCase();
            if (sub === 'local') { this.consoleLineLogin = 'local'; this.consoleLineLoginAuthList = null; return ''; }
            if (sub === 'authentication') {
              if (!args[1]) return '% Incomplete command.';
              this.consoleLineLogin = 'aaa';
              this.consoleLineLoginAuthList = args[1];
              return '';
            }
            this.consoleLineLogin = 'password';
            this.consoleLineLoginAuthList = null;
            return '';
          }
          if (kw === 'logging' && args[0]?.toLowerCase() === 'synchronous') {
            this.consoleLineLoggingSynchronous = true;
            return '';
          }
          if (kw === 'privilege' && args[0]?.toLowerCase() === 'level' && args[1]) {
            const lvl = parseInt(args[1], 10);
            if (!Number.isFinite(lvl) || lvl < 0 || lvl > 15) {
              return CISCO_ERRORS.INVALID_INPUT;
            }
            this.consolePrivilegeLevel(lvl);
            return '';
          }
          if (kw === 'history') {
            if ((args[0] ?? '').toLowerCase() !== 'size') return CISCO_ERRORS.INVALID_INPUT;
            const n = parseInt(args[1] ?? '', 10);
            if (!Number.isFinite(n) || n < 0 || n > 256) return CISCO_ERRORS.INVALID_INPUT;
            this.consoleLineHistorySize = n;
            this.consoleLineHistoryEnabled = true;
            this.terminalHistorySize = n;
            this.terminalHistoryEnabled = n > 0;
            return '';
          }
          if (kw === 'no') {
            const sub = args[0]?.toLowerCase();
            if (sub === 'history') {
              this.consoleLineHistoryEnabled = false;
              this.consoleLineHistorySize = null;
              this.terminalHistorySize = 0;
              this.terminalHistoryEnabled = false;
              return '';
            }
            if (sub === 'login') {
              this.consoleLineLoginAuthList = null;
              if (args[1]?.toLowerCase() === 'local') {
                this.consoleLineLogin = null;
              } else {
                this.consoleLineLogin = 'none';
              }
              return '';
            }
            if (sub === 'password') { this.consoleLinePassword = null; return ''; }
            if (sub === 'privilege') { this.consolePrivilegeLevel(null); return ''; }
            if (sub === 'logging') { this.consoleLineLoggingSynchronous = false; return ''; }
          }
          return '';
        }
        if (kw === 'password' && !args[0]) return '% Incomplete command.';
        const dev = this.d() as unknown as {
          _getVtyLineConfig?: () => { upsert: (p: object) => { requiresPasswordButUnset?: () => boolean } };
        };
        const update: Record<string, unknown> = { first: range.first, last: range.last };
        if (kw === 'login') {
          // bare `login` → authenticate with the line password; `login local`
          // → local user DB; `login authentication …` → AAA.
          const sub = args[0]?.toLowerCase();
          update.login = sub === 'local' ? 'local' : sub === 'authentication' ? 'aaa' : 'password';
        } else if (kw === 'password') {
          // `password [0|7] <mot>`. Le chiffre de type n'est un type que
          // s'il est ecrit ; il etait retire INCONDITIONNELLEMENT
          // (`args.slice(1)`), donc `password mon mot` rangeait `mot` — le
          // premier mot du mot de passe disparaissait — et la forme
          // `password 7 <chiffre>` rangeait le chiffre comme s'il etait le
          // texte en clair, sans garder l'algorithme.
          if (args[0] === '0' && args.length > 1) {
            update.linePassword = args.slice(1).join(' ');
            update.linePasswordAlgo = 'plain';
          } else if (args[0] === '7' && args.length > 1) {
            update.linePassword = args.slice(1).join(' ');
            update.linePasswordAlgo = 'type-7';
          } else {
            update.linePassword = args.join(' ');
            update.linePasswordAlgo = 'plain';
          }
        } else if (kw === 'logging' && args[0]?.toLowerCase() === 'synchronous') {
          update.loggingSynchronous = true;
        } else if (kw === 'privilege' && args[0]?.toLowerCase() === 'level' && args[1]) {
          update.privilege = parseInt(args[1], 10);
        } else if (kw === 'session-timeout' && args[0]) {
          update.sessionTimeoutMinutes = parseInt(args[0], 10);
        } else if (kw === 'history' && args[0]?.toLowerCase() === 'size' && args[1]) {
          update.historySize = parseInt(args[1], 10);
          update.historyEnabled = true;
        } else if (kw === 'absolute-timeout' && args[0]) {
          // `absolute-timeout <minutes>` : la duree MAXIMALE d'une
          // session, activite comprise. `exec-timeout` ne borne que
          // l'inactivite, donc un operateur qui tape sans arret n'etait
          // jamais deconnecte — ce que cette commande existe pour
          // empecher. Elle etait refusee.
          const min = parseInt(args[0], 10);
          if (!Number.isFinite(min) || min < 0) return CISCO_ERRORS.INVALID_INPUT;
          update.absoluteTimeoutMinutes = min;
        } else if (kw === 'escape-character' && args[0]) {
          // `escape-character {break | <ascii> | default | none | soft}`.
          const v = args[0].toLowerCase();
          if (v === 'break' || v === 'default' || v === 'none' || v === 'soft') {
            update.escapeCharacter = v;
          } else {
            const code = parseInt(args[0], 10);
            if (!Number.isFinite(code) || code < 0 || code > 255) return CISCO_ERRORS.INVALID_INPUT;
            update.escapeCharacter = String(code);
          }
        } else if (kw === 'length' && args[0]) {
          update.terminalLength = parseInt(args[0], 10);
        } else if (kw === 'width' && args[0]) {
          update.terminalWidth = parseInt(args[0], 10);
        } else if (kw === 'autocommand') {
          update.autocommand = args.join(' ');
        } else if (kw === 'motd-banner') {
          update.motdBannerSuppressed = false;
        } else if (kw === 'exec' && args[0]?.toLowerCase() === 'banner') {
          update.execBannerSuppressed = false;
        } else if (kw === 'authorization' && args[0] && args[1]) {
          update.authorizationList = `${args[0]} ${args[1]}`;
        } else if (kw === 'accounting' && args[0] && args[1]) {
          update.accountingList = `${args[0]} ${args[1]}`;
        } else if (kw === 'speed' && args[0]) {
          update.speedBaud = parseInt(args[0], 10);
        } else if (kw === 'stopbits' && args[0]) {
          update.stopbits = parseInt(args[0], 10);
        } else if (kw === 'rotary' && args[0]) {
          update.rotaryGroup = parseInt(args[0], 10);
        } else if (kw === 'no' && args.length > 0) {
          const sub = args[0]?.toLowerCase();
          // `no password` clears the line secret (empty string → explicitly
          // unset, distinct from "never configured"); `no login` disables auth.
          if (sub === 'password') update.linePassword = '';
          else if (sub === 'login') update.login = 'none';
          // `no history` COUPE l'historique ; ce n'est pas
          // `history size 0`, qui en demande un de taille nulle.
          else if (sub === 'history' && args.length === 1) update.historyEnabled = false;
          else if (sub === 'absolute-timeout') update.absoluteTimeoutMinutes = 0;
          else if (sub === 'escape-character') update.escapeCharacter = 'default';
          else if (sub === 'motd-banner') update.motdBannerSuppressed = true;
          else if (sub === 'exec' && args[1]?.toLowerCase() === 'banner') update.execBannerSuppressed = true;
          else if (sub === 'autocommand') update.autocommand = '';
          update.removed = (raw ?? `no ${args.join(' ')}`).trim();
        }
        const line = dev._getVtyLineConfig?.().upsert(update as Parameters<NonNullable<ReturnType<NonNullable<typeof dev._getVtyLineConfig>>['upsert']>>[0]);
        // Bare `login` with no line password configured is inert on real IOS —
        // the line refuses incoming sessions until a password is set. Echo the
        // warning so operators (and the simulated incoming-VTY verdict) agree.
        if (kw === 'login' && update.login === 'password' && line?.requiresPasswordButUnset?.()) {
          return `% Login disabled on line vty ${range.first} ${range.last}, until 'password' is set`;
        }
        return '';
      });
    }
  }

  protected showSocleSpecs(): CommandSpec[] {
    const exec = ['user', 'privileged'];
    // Les deux modes d'EXEC parce que la DELEGATION doit rester
    // possible, mais le niveau reste celui de la commande : c'est
    // l'autorisation qui refuse a un utilisateur de niveau 1, et une
    // chaine de communaute SNMP n'est pas une lecture publique.
    const vue = (
      path: readonly string[], description: string,
      niveau: number, rendu: () => string,
    ): CommandSpec => ({
      id: path.join('-'), path: [...path], description,
      modes: exec, minPrivilege: niveau, run: () => rendu(),
    });

    const identite = buildIdentityShowCommands(() => this.d())
      .map(v => vue(v.path, v.description, v.niveau, () => v.render()));

    // Niveau 15 : `show logging` est une commande privilegiee sur IOS,
    // et c'est le niveau que le trie lui donnait. Les deux modes d'EXEC
    // restent declares pour que la DELEGATION puisse la descendre.
    const journal: CommandSpec[] = loggingShowViews(this.loggingCommandContext())
      .map(v => ({
        id: v.path.filter((s): s is string => typeof s === 'string').join('-'),
        path: [...v.path], description: v.description,
        modes: exec, minPrivilege: 15,
        run: (_session, args) => v.render(args),
      }));

    // Niveau 1 MESURE et non suppose : les douze repondaient deja sans
    // `enable`, le trie les posant sur l'arbre utilisateur autant que
    // sur le privilegie.
    const systeme: CommandSpec[] = [
      vue(['show', 'calendar'], 'Display hardware calendar', 1, () => showCalendar(this.cs())),
      vue(['show', 'aliases'], 'Display command aliases', 1, () => this.aliases.render()),
      vue(['show', 'buffers'], 'Display buffer pools', 1, () => showBuffers()),
      vue(['show', 'sockets'], 'Display open sockets', 1, () => showSockets()),
      vue(['show', 'stacks'], 'Display process stacks', 1, () => showStacks()),
      vue(['show', 'reload'], 'Display reload schedule', 1,
        () => showReload(this.getScheduledReloadMs())),
      vue(['show', 'sntp'], 'Display SNTP information', 1, () => this.showSntp()),
      vue(['show', 'terminal'], 'Display terminal configuration parameters', 1, () =>
        `${showTerminal(this.terminalLength, this.terminalWidth, this.terminalHistorySize)}\n`
        + `Monitor parameter: ${this.terminalMonitor ? 'enabled' : 'disabled'}`),
      vue(['show', 'file'], 'Show filesystem information', 1,
        () => showFileSystems(this.fs(), this.readStartupConfig()?.length ?? 0)),
      vue(['show', 'file', 'systems'], 'File system information', 1,
        () => showFileSystems(this.fs(), this.readStartupConfig()?.length ?? 0)),
      vue(['show', 'tcp'], 'Status of TCP connections', 1,
        () => showTcpBrief(this.pileTcp())),
      vue(['show', 'tcp', 'brief'], 'Brief display of TCP connection status', 1,
        () => showTcpBrief(this.pileTcp())),
    ];

    const listeNommee = (
      keyword: string, description: string, libelle: string,
      rendu: (wanted: string | undefined) => string,
    ): CommandSpec => ({
      id: `show-ip-${keyword}`,
      path: ['show', 'ip', keyword, {
        name: 'nom', type: 'WORD', optional: true, description: libelle,
      }],
      description, modes: exec, minPrivilege: 1,
      run: (_session, args) => rendu(args.nom === undefined || args.nom === ''
        ? undefined : String(args.nom)),
    });

    const filtres: CommandSpec[] = [
      listeNommee('community-list', 'Display BGP community lists',
        'Community list name or number', (wanted) => {
          const out: string[] = [];
          for (const [key, rules] of this.communityLists()) {
            const [kind, name] = key.split(' ');
            if (wanted && wanted !== name) continue;
            out.push(`Community ${kind} list ${name}`);
            for (const rule of rules) out.push(`    ${rule}`);
          }
          return out.join('\n');
        }),
      listeNommee('as-path-access-list', 'Display AS-path filters',
        'AS path access list number', (wanted) => {
          const store = this.asPathLists();
          const keys = wanted ? [wanted] : [...store.keys()];
          const out: string[] = [];
          for (const k of keys) {
            const rules = store.get(k);
            if (!rules) continue;
            out.push(`AS path access list ${k}`);
            for (const rule of rules) out.push(`    ${rule}`);
          }
          return out.join('\n');
        }),
    ];

    const administration: CommandSpec[] = [
      vue(['show', 'ip', 'ssh'], 'Display SSH server status', 15, () => {
        const sec = getSecurityConfig(this.d());
        return showIpSsh(sec.ssh,
          sec.cryptoKeys.length > 0 ? sec.cryptoKeys[0].modulus : null);
      }),
      vue(['show', 'ip', 'ssh', 'known-hosts'], 'Display learned SSH host keys', 15,
        () => this.sshKnownHosts().renderCisco()),
      {
        id: 'show-ssh', description: 'Display SSH sessions',
        path: ['show', 'ssh', {
          name: 'reste', type: 'REST', optional: true,
          description: 'Display SSH sessions', values: [],
        }],
        modes: exec, minPrivilege: 15,
        run: () => {
          const dev = this.d() as unknown as {
            getSshSessionRegistry?: () =>
            { list: () => readonly { lineIndex: number; user: string }[] } | null;
          };
          const ssh = getSecurityConfig(this.d() as object).ssh;
          return showSshSessions(dev.getSshSessionRegistry?.() ?? null, {
            encryptionAlgorithms: ssh.encryptionAlgorithms,
            macAlgorithms: ssh.macAlgorithms,
          });
        },
      },
      vue(['show', 'ip', 'http', 'server', 'status'], 'Display HTTP server status', 15,
        () => getHttpService(this.d())?.statusLines().join('\n') ?? ''),
      vue(['show', 'ip', 'http', 'server', 'all'],
        'Display all HTTP server information', 15,
        () => getHttpService(this.d())?.statusLines().join('\n') ?? ''),
    ];

    return [
      ...journal,
      ...systeme,
      ...identite,
      ...administration,
      ...filtres,
      ...this.lineSpecs(),
      vue(['show', 'ntp', 'status'], 'Display NTP status', 1,
        () => showNtpStatus(this.cs())),
      vue(['show', 'ntp', 'authentication-keys'], 'Display NTP authentication keys', 15,
        () => showNtpAuthenticationKeys(this.cs())),
      vue(['show', 'ntp', 'associations'], 'NTP associations', 1,
        () => showNtpAssociations(this.cs())),
      vue(['show', 'ntp', 'associations', 'detail'], 'Detailed NTP association state', 1,
        () => showNtpAssociationsDetail(this.cs())),
      vue(['show', 'snmp', 'community'], 'Display SNMP communities', 15,
        () => showSnmpCommunity(this.cs())),
      vue(['show', 'snmp', 'host'], 'Display SNMP hosts', 15, () => showSnmpHost(this.cs())),
      vue(['show', 'snmp', 'group'], 'Display SNMP groups', 15, () => showSnmpGroup(this.cs())),
      vue(['show', 'snmp', 'user'], 'Display SNMP users', 15, () => showSnmpUser(this.cs())),
      vue(['show', 'snmp', 'view'], 'Display SNMP views', 15, () => showSnmpView(this.cs())),
      vue(['show', 'snmp', 'engineID'], 'Display SNMP engine ID', 15,
        () => showSnmpEngineId(this.cs())),
      vue(['show', 'bootvar'], 'Display boot variables', 15,
        () => this.fs().renderBootvar()),
      vue(['show', 'clock'], 'Display the system clock', 1,
        () => showClock(this.cs())),
      vue(['show', 'users'], 'Display active lines', 1,
        () => showUsers(this.registreSessions())),
      // `show who` est le SYNONYME historique de `show users` sur IOS :
      // une seule declaration par nom, mais le MEME rendu, sinon les
      // deux finiraient par decrire deux etats de la meme machine.
      vue(['show', 'who'], 'Display active lines', 1,
        () => showUsers(this.registreSessions())),
      vue(['show', 'sessions'], 'Display open outgoing connections', 1,
        () => renderSessions(this.outgoingSessions)),
      vue(['show', 'inventory'], 'Display hardware inventory', 1,
        () => showInventory(this.d().getHostname(), this.getChassisProfile(),
          (this.deviceRef as unknown as { id?: string } | null)?.id)),
      vue(['show', 'processes'], 'Display active processes', 1,
        () => showProcessesCpu()),
      vue(['show', 'processes', 'cpu'], 'Display CPU utilisation', 1,
        () => showProcessesCpu()),
      vue(['show', 'license', 'feature'], 'Display technology package licenses', 15,
        () => licenseTable(
          this.getChassisProfile() === 'router-isr2911' ? 'c2900' : 'c2960').join('\n')),
      vue(['show', 'clock', 'detail'], 'Display clock with source', 1, () => {
        const ntp = getNtpAgent(this.cs());
        const source = (ntp?.isSynced() ?? false)
          ? `NTP (${ntp?.getConfig().refIdentifier})`
          : 'No time source';
        return [showClock(this.cs()), `Time source is ${source}`].join('\n');
      }),
      vue(['show', 'platform'], 'Display platform information', 15, () =>
        (this.getChassisProfile() === 'router-isr2911'
          ? `Cisco ISR 2911\n  PID: CISCO2911/K9\n  S/N: ${this.numeroDeSerie()}`
          : `Cisco Catalyst 2960\n  PID: WS-C2960-24TT-L\n  S/N: ${this.numeroDeSerie()}`)),
      vue(['show', 'license'], 'Display licenses', 15, () => {
        const head = 'Index Feature                  Period left    Period Used    License Type    License State    License Count    License Priority';
        const row = (rang: number, feature: string) =>
          `${rang}     ${feature.padEnd(25)}Lifetime       0              Permanent       Active, In Use   N/A              Medium`;
        if (this.getChassisProfile() !== 'router-isr2911') return `${head}\n${row(1, 'ipbasek9')}`;
        return [head, row(1, 'ipbasek9'), row(2, 'securityk9')].join('\n');
      }),
      vue(['show', 'license', 'udi'], 'Display Unique Device Identifier', 15, () => {
        const pid = this.getChassisProfile() === 'router-isr2911'
          ? 'CISCO2911/K9' : 'WS-C2960-24TT-L';
        return `Device#   PID                   SN\n*0        ${pid.padEnd(22)}${this.numeroDeSerie()}`;
      }),
      vue(['show', 'privilege'], 'Display current privilege level', 1,
        () => showPrivilege(this.currentPrivilegeLevel)),
      vue(['show', 'history'], 'Display command history', 1,
        () => this.cmdHistory.slice(-this.terminalHistorySize).join('\n')),
      {
        id: 'show-memory', description: 'Display memory statistics',
        // La forme glouton d'origine laissait passer `show memory
        // statistics`, que la suite d'EXEC utilisateur tape : une queue
        // libre la garde, et ses FORMES la nomment dans l'aide.
        path: ['show', 'memory', {
          name: 'vue', type: 'REST', optional: true, description: 'Memory view',
          alternatives: [{ keyword: 'statistics', description: 'Memory statistics' }],
        }],
        modes: exec, minPrivilege: 1,
        run: () => showMemoryStatistics(this.getChassisProfile()),
      },
      {
        id: 'clear-ntp-statistics', path: ['clear', 'ntp', 'statistics'],
        description: 'Clear NTP packet statistics',
        modes: exec, minPrivilege: 15,
        run: () => { getNtpAgent(this.d())?.clearCounters(); return ''; },
      },
      {
        id: 'show-processes-cpu-sorted', description: 'Display CPU utilisation sorted',
        path: ['show', 'processes', 'cpu', 'sorted', { name: 'critere', type: 'REST' as const, optional: true, description: 'Sort key' }],
        modes: exec, minPrivilege: 1, run: () => showProcessesCpu(),
      },
      {
        id: 'show-processes-cpu-history', description: 'Display CPU history',
        path: ['show', 'processes', 'cpu', 'history'],
        modes: exec, minPrivilege: 1, run: () => showProcessesCpu(),
      },
      {
        id: 'show-processes-memory', description: 'Display per-process memory',
        path: ['show', 'processes', 'memory', { name: 'vue', type: 'REST' as const, optional: true, description: 'Memory view' }],
        modes: exec, minPrivilege: 1, run: () => showProcessesMemory(),
      },
      {
        id: 'show-boot', description: 'Display boot variables',
        path: ['show', 'boot',
          { name: 'reste', type: 'REST', optional: true, description: 'Boot view' }],
        modes: exec, minPrivilege: 15, run: () => this.fs().renderBootvar(),
      },
      {
        id: 'show-flash', description: 'Display flash filesystem',
        path: ['show', 'flash:',
          { name: 'reste', type: 'REST', optional: true, description: 'Flash view' }],
        modes: exec, minPrivilege: 15, run: () => this.fs().renderShowFlash(),
      },
      {
        id: 'show-controllers', description: 'Display controller status',
        path: ['show', 'controllers',
          { name: 'interface', type: 'REST', optional: true, description: 'Interface to show' }],
        modes: exec, minPrivilege: 1,
        run: (_session, args) => showControllers(this.cs(), (args.interface ?? '').trim()),
      },
      {
        id: 'show-environment', description: 'Display environment',
        path: ['show', 'environment',
          { name: 'reste', type: 'REST', optional: true, description: 'Environment view' }],
        modes: exec, minPrivilege: 1, run: () => showEnvironment(),
      },
      {
        id: 'show-line', description: 'Display TTY lines',
        path: ['show', 'line',
          { name: 'ligne', type: 'REST', optional: true, description: 'Line to show' }],
        modes: exec, minPrivilege: 1,
        run: (_session, args) =>
          showLine(this.cs(), (args.ligne ?? '').trim().split(/\s+/).filter(Boolean)),
      },
      vue(['show', 'diag'], 'Display chassis diagnostics', 15, () => {
        const pid = this.getChassisProfile() === 'router-isr2911'
          ? 'CISCO2911/K9' : 'WS-C2960-24TT-L';
        const serie = this.numeroDeSerie();
        return [
          'Slot 0:',
          `        ${pid} Motherboard Port adapter, 3 ports`,
          '        Port adapter is analyzed',
          '        Port adapter insertion time unknown',
          '        Hardware Revision        : 1.0',
          `        Part Number              : ${pid}`,
          '        Board Revision           : 1.0',
          `        PCB Serial Number        : ${serie}`,
        ].join('\n');
      }),
    ];
  }

  protected socleSpecs(): readonly CommandSpec[] {
    return [
      ...debugFamily(this.debugPairs()),
      ...showConfigViewSpecs(() => this),
      ...showIpDhcpSpecs(() => this.dhcpViewServer()),
      ...this.discoverySpecs(),
      ...this.loggingSpecs(),
      ...this.ntpSpecs(),
      ...this.sntpSpecs(),
      ...this.snmpSpecs(),
      ...this.clockSpecs(),
      ...this.loginSpecs(),
      ...this.clearSpecs(),
      ...this.writeEraseSpecs(),
      ...this.serviceSpecs(),
      ...this.serviceFamilySpecs(),
      ...this.bannerSpecs(),
      ...this.archiveExecSpecs(),
      ...this.dhcpGlobalPartageeSpecs(),
      ...this.dhcpSnoopingSpecs(),
      ...this.showIpInterfaceSpecs(),
      ...this.showIpRouteSpecs(),
      ...this.showInterfacesSpecs(),
      ...this.ipRouteSpecs(),
      ...this.cefSpecs(),
      ...this.enableSpecs(),
      ...this.configureSpecs(),
      ...this.hardeningSpecs(),
      ...this.arpSpecs(),
      ...this.identityBootSpecs(),
      ...this.lineEntrySpecs(),
      ...this.showSocleSpecs(),
      ...this.archiveSubmodeSpecs(),
      ...this.identitySubmodeSpecs(),
      ...this.viewSubmodeSpecs(),
      ...this.httpServerSpecs(),
      ...this.dnsConfigSpecs(),
      ...this.fileSystemSpecs(),
      ...this.sessionSpecs(),
      ...this.sharedShowSpecs(),
    ];
  }

  /*
   * `registerCommonShowCommands` sert les DEUX arbres d'EXEC et les DEUX
   * plateformes : quinze commandes y sont enregistrees quatre fois. Le
   * `skip` nomme celles que ce lot prend, parce que le constructeur
   * DELEGUE aussi a des familles deja migrees — les collecter une
   * seconde fois leverait un doublon.
   */
  protected sharedShowSpecs(): readonly CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerCommonShowCommands(collector as unknown as CommandTrie),
      {
        modes: ['user', 'privileged'], minPrivilege: 1,
        modesFor: (path) => PRIVILEGED_EXEC_ONLY.has(path) ? ['privileged'] : undefined,
        skip: (path) => !SHOW_PARTAGEES.has(path),
        argumentFor: (path) => SHARED_SHOW_ARGUMENTS[path],
      },
    );
  }

  protected sessionSpecs(): readonly CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerOutgoingSessionCommands(collector as unknown as CommandTrie),
      {
        modes: ['user', 'privileged'], minPrivilege: 1,
        argumentFor: (path) => SESSION_ARGUMENTS[path],
      },
    );
  }

  protected fileSystemSpecs(): readonly CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerFileSystemCommands(collector as unknown as CommandTrie),
      {
        modes: ['user', 'privileged'], minPrivilege: 1,
        argumentFor: (path) => FILESYSTEM_ARGUMENTS[path],
      },
    );
  }

  protected identitySubmodeContext(): CiscoSecurityShellContext | null {
    return null;
  }

  protected httpServerSpecs(): readonly CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerHttpServerOn(collector as unknown as CommandTrie),
      {
        modes: ['config'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        argumentFor: (path) => HTTP_ARGUMENTS[path],
      },
    );
  }

  protected dnsConfigSpecs(): readonly CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => registerCiscoDnsCommands(
        collector as unknown as CommandTrie, this.dnsCommandContext()),
      {
        modes: ['config'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        argumentFor: (path) => DNS_ARGUMENTS[path],
        keywordsFor: (path) => /^ip domain[- ]lookup$/.test(path)
          ? DOMAIN_LOOKUP_KEYWORDS : undefined,
      },
    );
  }

  protected viewSubmodeSpecs(): readonly CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerViewSubmodeOn(collector as unknown as CommandTrie),
      {
        modes: ['config-view'], minPrivilege: 15,
        argumentFor: (path) => VIEW_SUBMODE_ARGUMENTS[path],
        keywordsFor: (path) => path === 'commands' ? VIEW_COMMANDS_KEYWORDS : undefined,
      },
    );
  }

  protected identitySubmodeSpecs(): readonly CommandSpec[] {
    const ctx = this.identitySubmodeContext();
    if (!ctx) return [];
    return [
      ...radiusServerSubmodeSpecs(ctx),
      ...tacacsServerSubmodeSpecs(ctx),
      ...aaaGroupSubmodeSpecs(ctx),
    ];
  }

  /**
   * `service <nom>` — la liste d'IOS, pas n'importe quel mot.
   *
   * Le gestionnaire etait glouton et rangeait `args.join(' ')` : donc
   * `service zorglub` etait accepte et RENDU dans la configuration, que
   * l'import d'une topologie rejoue ; et `service nagle machin` rangeait
   * un service dont le nom faisait deux mots. Les quatre services que
   * cette machine honore vraiment — `dhcp`, `password-encryption`,
   * `sequence-numbers`, `timestamps` — gardent leur propre declaration
   * ailleurs et ne figurent pas ici.
   */
  protected serviceSpecs(): CommandSpec[] {
    const drapeau = (nom: string, on: boolean): string => {
      const dev = this.d() as unknown as {
        _setServiceFlag?: (n: string, e: boolean) => void;
      };
      if (nom === 'finger') {
        getSecurityConfig(this.d()).ipFinger = on;
        return '';
      }
      dev._setServiceFlag?.(nom, on);
      return '';
    };

    return [{
      id: 'service',
      path: ['service', {
        name: 'nom', type: 'ENUM', description: 'Service to enable',
        values: SERVICES_IOS.map(([keyword, description]) => ({ keyword, description })),
      }],
      description: 'Modify use of network based services',
      undoDescription: 'Disable a network based service',
      modes: ['config'], minPrivilege: 15,
      run: (_session, args) => drapeau(args.nom, true),
      undo: (_session, args) => drapeau(args.nom, false),
    }];
  }

  /**
   * Les quatre `service` qui commandent un MOTEUR, declares une fois.
   *
   * `service dhcp` etait ecrit DEUX fois, mot pour mot — une dans
   * `buildConfigCommands` du routeur, une dans le corps du commutateur —
   * pour un seul et meme geste (`_getDHCPServerInternal().enable()`).
   * Les trois autres restent la ou leur moteur vit, et sont RAMENEES ici
   * par l'adaptateur, de sorte que la famille se lise en un lieu sans
   * deplacer les gestionnaires.
   */
  protected serviceFamilySpecs(): readonly CommandSpec[] {
    const identite = this.identitySubmodeContext();
    const dhcp = (on: boolean) => (): string => {
      const service = this.dhcpServiceSwitch();
      if (on) service?.enable(); else service?.disable();
      return '';
    };

    return [
      {
        id: 'service-dhcp',
        path: ['service', 'dhcp'],
        description: 'Enable DHCP service',
        undoDescription: 'Disable DHCP service',
        modes: ['config'], minPrivilege: 15,
        run: dhcp(true), undo: dhcp(false),
      },
      ...specsFromTrieRegistrations(
        (collector) => this.registerCommonConfigCommands(collector as unknown as CommandTrie),
        {
          modes: ['config'], minPrivilege: 15,
          undoFromNegatedPaths: true,
          skip: (path) => !SERVICES_A_MOTEUR.has(path.replace(/^no /, '')),
          argumentFor: (path) => SERVICE_PLACES[path.replace(/^no /, '')],
        },
      ),
      ...(identite === null ? [] : specsFromTrieRegistrations(
        (collector) =>
          buildIdentityConfigCommands(collector as unknown as CommandTrie, identite),
        {
          modes: ['config'], minPrivilege: 15,
          undoFromNegatedPaths: true,
          skip: (path) =>
            path.replace(/^no /, '') !== 'service password-encryption',
          argumentFor: () => null,
        },
      )),
    ];
  }

  protected dhcpServiceSwitch(): { enable(): void; disable(): void } | undefined {
    return (this.d() as unknown as {
      _getDHCPServerInternal?: () => { enable(): void; disable(): void } | undefined;
    })._getDHCPServerInternal?.();
  }

  /**
   * `banner <sorte> <delimiteur>texte<delimiteur>`.
   *
   * Le texte est garde TEL QUEL — c'est tout l'objet de la commande — et
   * c'est pourquoi la place est un `REST`, qui rend depuis peu la
   * tranche d'origine et non les jetons recolles : `#Deux  blancs#`
   * posait sinon une banniere a un seul blanc.
   *
   * `no banner motd` avait sa PROPRE declaration a cote de la forme
   * gloutonne qui la couvrait deja, avec le meme corps mot pour mot ; la
   * plus specifique gagnait, donc la branche `motd` de l'autre etait
   * morte. Il n'en reste qu'une.
   */
  protected bannerSpecs(): CommandSpec[] {
    const sortes = BANNER_SORTES.map(([keyword, description]) =>
      ({ keyword, description }));
    const poser = (sorte: string, reste: string): string => {
      const texte = reste.replace(/^\s+/, '');
      if (texte.length === 0) return CISCO_ERRORS.INCOMPLETE;
      const delim = texte.startsWith('^C') ? '^C' : texte[0];
      const corps = texte.slice(delim.length);
      const fin = corps.indexOf(delim);
      if (fin !== -1) {
        this.setBanner(sorte as BannerKind, corps.slice(0, fin));
        return '';
      }
      this.bannerCollector = {
        type: sorte as BannerKind, delimiter: delim,
        lines: corps.length > 0 ? [corps] : [],
      };
      return `Enter TEXT message.  End with the character '${delim}'.`;
    };
    const retirer = (sorte: string): string => {
      const dev = this.d() as unknown as {
        _setMotdBanner?: (b: string) => void;
        _setLoginBanner?: (b: string) => void;
        _setExecBanner?: (b: string) => void;
        _setIncomingBanner?: (b: string) => void;
        _setSshBanner?: (b: string) => void;
      };
      if (sorte === 'motd') { dev._setMotdBanner?.(''); dev._setSshBanner?.(''); }
      else if (sorte === 'login') dev._setLoginBanner?.('');
      else if (sorte === 'exec') dev._setExecBanner?.('');
      else if (sorte === 'incoming') dev._setIncomingBanner?.('');
      return '';
    };

    const sorte: ArgumentSpec = {
      name: 'sorte', type: 'ENUM', description: 'Type of banner', values: sortes,
    };

    /*
     * DEUX declarations, parce que les deux formes n'ont pas la meme
     * suite. La place du texte n'est pas facultative — `banner motd ?`
     * annoncait sinon `<cr>` pour une commande qu'IOS declare
     * incomplete, faute du delimiteur — mais `no banner motd` s'arrete
     * la : exiger le texte pour effacer aurait refuse la negation que
     * tout operateur tape. La seconde n'existe QUE niee, donc
     * `banner motd` seul reste incomplet.
     */
    return [
      {
        id: 'banner',
        path: ['banner', sorte, {
          name: 'texte', type: 'REST',
          description: 'Message text, delimited by any character',
          literal: 'LINE',
        }],
        description: 'Define a login banner',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => poser(args.sorte, args.texte ?? ''),
      },
      {
        id: 'banner-no',
        path: ['banner', sorte],
        description: 'Define a login banner',
        undoDescription: 'Remove a banner',
        modes: ['config'], minPrivilege: 15,
        existsOnlyNegated: true,
        run: () => CISCO_ERRORS.INCOMPLETE,
        undo: (_session, args) => retirer(args.sorte),
      },
    ];
  }

  /**
   * `show archive`, son journal, son diff, et `archive config`.
   *
   * Elles etaient deja declarees UNE fois pour les deux plateformes —
   * `registerArchiveExecCommands` est appele ici et nulle part
   * ailleurs — donc la migration ne referme aucun doublon ; elle donne
   * a la famille ses modes et ses places declarees.
   */
  private registerArchiveExecOn(trie: CommandTrie): void {
    registerArchiveExecCommands(
      trie,
      () => this.archiveService(),
      () => (this.d() as unknown as { getRunningConfig?: () => string }).getRunningConfig?.() ?? '',
      (url) => this.fs().read(url),
      () => this.readStartupConfig(),
      (texte) => {
        // Un REMPLACEMENT, pas une fusion : l'état rejouable est remis à
        // zéro avant que le fichier ne soit appliqué, sinon ce que la
        // configuration courante porte en trop y resterait — ce qui est
        // précisément la différence avec `copy`.
        const dev = this.d() as unknown as {
          _resetConfigurableStateForReload?: () => void;
          _applyConfigText?: (t: string) => void;
        };
        dev._resetConfigurableStateForReload?.();
        dev._applyConfigText?.(texte);
        (this.d() as unknown as { _noteConfigChange?: (u: string) => void })
          ._noteConfigChange?.(this.configSessionLabel);
      },
    );
  }

  /**
   * `configure terminal` s'ecrivait DEUX fois, et les deux avaient
   * diverge.
   *
   * Une declaration sur l'arbre privilegie — qui pose le mode et annonce
   * `Enter configuration commands…` — et une AUTRE sur celui de
   * configuration, decrite « Already in global config » et rendant la
   * chaine vide. IOS n'a qu'une commande : la retaper depuis
   * `(config)#` reannonce la meme ligne. Un seul corps, porte par les
   * deux modes, ne peut plus se contredire.
   */
  /**
   * `enable [<niveau>]` et `enable view [<vue>]`, une seule fois.
   *
   * Elles etaient ecrites DEUX fois et les deux avaient diverge. Sur
   * l'arbre utilisateur, un gestionnaire complet : le niveau, la porte
   * du secret, la journalisation de `logging userinfo`. Sur l'arbre
   * privilegie, `enable` rendait la chaine vide — un corps qui ne fait
   * RIEN — de sorte que `enable 7` tape depuis `#` laissait la session
   * au niveau 15, alors que c'est exactement ainsi qu'on DESCEND d'un
   * niveau. Et `enable view` y portait une AUTRE description que dans
   * l'aide de l'autre arbre, donc `enable ?` ne rendait pas le meme
   * texte selon l'endroit d'ou on le tapait.
   */
  /**
   * La frappe designe-t-elle `enable` — et laquelle des deux ?
   *
   * Le plan d'interaction reconnaissait `enable` en interrogeant le
   * TRIE, qui ne la porte plus : sans cette resolution la porte du
   * secret ne s'ouvrait plus du tout et la commande passait
   * directement, refusee sans avoir rien demande. La resolution passe
   * par la meme table que l'autorisation, donc les abreviations d'IOS
   * (`en`, `ena 7`) restent honorees sans comparaison de chaines.
   */
  private resoudreEnable(line: string): { vue: boolean; args: string[] } | null {
    const parts = this.socleCanonicalParts('exec', line);
    if (parts === null) return null;
    const cles = parts.keywords.split(/\s+/).filter(Boolean);
    if (cles[0] !== 'enable') return null;
    /*
     * Les arguments sont pris sur la ligne TAPEE et non sur la forme
     * canonique : celle-ci est mise en minuscules pour comparer des
     * mots-cles, et un nom de vue est une DONNEE — `enable view
     * NOC_VIEW` y devenait `noc_view`, une vue qui n'existe pas, donc
     * `% Access denied` meme avec le bon secret.
     */
    const tapes = line.trim().split(/\s+/).filter(Boolean);
    return { vue: cles[1] === 'view', args: tapes.slice(cles.length) };
  }

  /**
   * Ce que le pool selectionne devient : chaque coquille le range ou
   * elle le lit, et la declaration partagee n'a pas a le savoir.
   */
  protected selectDhcpPool(_nom: string | null): void { /* par coquille */ }

  /**
   * Les commandes DHCP globales qu'un routeur ET un Catalyst servent.
   *
   * Elles etaient ecrites DEUX fois, et les deux copies avaient
   * diverge. `ip dhcp pool` du commutateur appelait `dhcp.enable()` —
   * « IOS auto-enables the DHCP service when a pool is created » — donc
   * `no service dhcp` suivi de la creation d'un pool RALLUMAIT le
   * service que l'operateur venait d'eteindre, ce que le routeur ne
   * faisait pas ; le service est actif par defaut, l'appel n'apportait
   * rien et defaisait une decision explicite. Et `ip dhcp database`
   * ecrivait sur DEUX magasins : le commutateur dans l'agent du serveur
   * DHCP — celui que `show ip dhcp database` lit — le routeur sur une
   * propriete ad hoc que personne ne relisait.
   */
  protected dhcpGlobalPartageeSpecs(): readonly CommandSpec[] {
    const serveur = () => this.dhcpConfigServer();
    const nom: ArgumentSpec = {
      name: 'nom', type: 'WORD', description: 'Pool name',
    };

    return [
      {
        id: 'ip-dhcp-pool',
        path: ['ip', 'dhcp', 'pool', nom],
        description: 'Configure DHCP address pools',
        undoDescription: 'Remove a DHCP address pool',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => {
          const dhcp = serveur();
          if (!dhcp) return '';
          if (!dhcp.getPool(args.nom)) dhcp.createPool(args.nom);
          this.selectDhcpPool(args.nom);
          this.mode = 'config-dhcp';
          return '';
        },
        undo: (_session, args) => { serveur()?.deletePool(args.nom); return ''; },
      },
      {
        id: 'ip-dhcp-excluded-address',
        path: ['ip', 'dhcp', 'excluded-address',
          { name: 'basse', type: 'IP_ADDR', description: 'Low IP address' },
          { name: 'haute', type: 'IP_ADDR', optional: true,
            description: 'High IP address' },
        ],
        description: 'Prevent DHCP from assigning certain addresses',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => {
          const haute = args.haute ?? args.basse;
          if (!serveur()?.addExcludedRange(args.basse, haute)) {
            throw new CliInvalidInput({ token: haute });
          }
          return '';
        },
      },
      {
        id: 'ip-dhcp-database',
        path: ['ip', 'dhcp', 'database',
          { name: 'url', type: 'REST', description: 'Database agent URL', literal: 'LINE' },
        ],
        description: 'Configure DHCP database agents',
        undoDescription: 'Remove a DHCP database agent URL',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => { serveur()?.addDatabaseAgent(args.url); return ''; },
        undo: (_session, args) => { serveur()?.removeDatabaseAgent(args.url); return ''; },
      },
    ];
  }

  protected dhcpConfigServer(): DhcpConfigServer | undefined {
    return (this.d() as unknown as {
      _getDHCPServerInternal?: () => DhcpConfigServer | undefined;
    })._getDHCPServerInternal?.();
  }

  protected dhcpSnoopingConfig(): DHCPSnoopingConfig | undefined {
    return (this.d() as unknown as {
      _getDHCPSnoopingConfig?: () => DHCPSnoopingConfig | undefined;
    })._getDHCPSnoopingConfig?.();
  }

  private surPortsEspionnes(fn: (cfg: DHCPSnoopingConfig, port: string) => void): string {
    const cfg = this.dhcpSnoopingConfig();
    if (!cfg) return '';
    for (const port of this.selectedPortsForConfigIf()) fn(cfg, port);
    return '';
  }

  protected dhcpSnoopingSpecs(): readonly CommandSpec[] {
    const cfg = () => this.dhcpSnoopingConfig();
    const listeVlan: ArgumentSpec = {
      name: 'liste', type: 'WORD', description: 'DHCP snooping VLAN list',
    };
    const debit: ArgumentSpec = {
      name: 'pps', type: 'INT', range: [1, 2048],
      description: 'DHCP snooping rate limit (pps)',
    };

    return [
      {
        id: 'ip-dhcp-snooping',
        path: ['ip', 'dhcp', 'snooping'],
        description: 'Enable DHCP snooping',
        undoDescription: 'Disable DHCP snooping',
        modes: ['config'], minPrivilege: 15,
        run: () => { const c = cfg(); if (c) c.enabled = true; return ''; },
        undo: () => { const c = cfg(); if (c) c.enabled = false; return ''; },
      },
      {
        id: 'ip-dhcp-snooping-vlan',
        path: ['ip', 'dhcp', 'snooping', 'vlan', listeVlan],
        description: 'DHCP snooping VLAN list',
        undoDescription: 'Stop snooping those VLANs',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => {
          const vlans = parseVlanList(args.liste);
          if (!vlans) throw new CliInvalidInput({ token: args.liste });
          const c = cfg();
          if (c) for (const v of vlans) c.vlans.add(v);
          return '';
        },
        undo: (_session, args) => {
          const vlans = parseVlanList(args.liste);
          if (!vlans) throw new CliInvalidInput({ token: args.liste });
          const c = cfg();
          if (c) for (const v of vlans) c.vlans.delete(v);
          return '';
        },
      },
      {
        id: 'ip-dhcp-snooping-verify-mac',
        path: ['ip', 'dhcp', 'snooping', 'verify', 'mac-address'],
        description: 'Verify the source MAC against the client hardware address',
        undoDescription: 'Stop verifying the source MAC address',
        modes: ['config'], minPrivilege: 15,
        run: () => { const c = cfg(); if (c) c.verifyMac = true; return ''; },
        undo: () => { const c = cfg(); if (c) c.verifyMac = false; return ''; },
      },
      {
        id: 'ip-dhcp-snooping-information-option',
        path: ['ip', 'dhcp', 'snooping', 'information', 'option'],
        description: 'Insert option 82 into snooped packets',
        undoDescription: 'Stop inserting option 82',
        modes: ['config'], minPrivilege: 15,
        run: () => { const c = cfg(); if (c) c.informationOption = true; return ''; },
        undo: () => { const c = cfg(); if (c) c.informationOption = false; return ''; },
      },
      {
        id: 'ip-dhcp-snooping-trust',
        path: ['ip', 'dhcp', 'snooping', 'trust'],
        description: 'Trust this interface for DHCP snooping',
        undoDescription: 'Stop trusting this interface',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: () => this.surPortsEspionnes((c, port) => { c.trustedPorts.add(port); }),
        undo: () => this.surPortsEspionnes((c, port) => { c.trustedPorts.delete(port); }),
      },
      {
        id: 'ip-dhcp-snooping-limit-rate',
        path: ['ip', 'dhcp', 'snooping', 'limit', 'rate', debit],
        description: 'Bound the DHCP message rate on this interface',
        undoDescription: 'Remove the DHCP message rate bound',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: (_session, args) =>
          this.surPortsEspionnes((c, port) => { c.rateLimits.set(port, Number(args.pps)); }),
        undo: () => this.surPortsEspionnes((c, port) => { c.rateLimits.delete(port); }),
      },
      {
        id: 'show-ip-dhcp-snooping',
        path: ['show', 'ip', 'dhcp', 'snooping'],
        description: 'DHCP snooping configuration and trusted interfaces',
        modes: ['user', 'privileged'], minPrivilege: 1,
        run: () => this.renduShowDhcpSnooping(),
      },
      {
        id: 'show-ip-dhcp-snooping-binding',
        path: ['show', 'ip', 'dhcp', 'snooping', 'binding'],
        description: 'DHCP snooping binding table',
        modes: ['user', 'privileged'], minPrivilege: 1,
        run: () => this.renduShowDhcpSnoopingBinding(),
      },
    ];
  }

  private renduShowDhcpSnooping(): string {
    const cfg = this.dhcpSnoopingConfig() ?? createDefaultSnoopingConfig();
    const vlans = compactVlanList([...cfg.vlans].sort((a, b) => a - b));
    const lignes = [
      `Switch DHCP snooping is ${cfg.enabled ? 'enabled' : 'disabled'}`,
      'DHCP snooping is configured on following VLANs:',
      vlans.length > 0 ? vlans : 'none',
      'DHCP snooping is operational on following VLANs:',
      cfg.enabled && vlans.length > 0 ? vlans : 'none',
      `Insertion of option 82 is ${cfg.informationOption ? 'enabled' : 'disabled'}`,
      `Verification of hwaddr field is ${cfg.verifyMac ? 'enabled' : 'disabled'}`,
      'Verification of giaddr field is enabled',
      'DHCP snooping trust/rate is configured on the following Interfaces:',
      '',
    ];

    const interfaces = [...new Set([...cfg.trustedPorts, ...cfg.rateLimits.keys()])].sort();
    const table = renderTable(interfaces, SNOOPING_TRUST_COLUMNS(cfg), IOS_RULED_TABLE);
    return [...lignes, ...table].join('\n');
  }

  private renduShowDhcpSnoopingBinding(): string {
    const liaisons = (this.d() as unknown as {
      _getSnoopingBindings?: () => readonly DHCPSnoopingBinding[];
    })._getSnoopingBindings?.() ?? [];

    return [
      ...renderTable(liaisons, SNOOPING_BINDING_COLUMNS, IOS_RULED_TABLE),
      `Total number of bindings: ${liaisons.length}`,
    ].join('\n');
  }

  /**
   * `show ip interface [brief | <nom>]`, declaree une fois.
   *
   * Les deux plateformes avaient leur propre enregistrement, chacune
   * avec sa place LIBRE : la commande la plus tapee d'IOS n'annoncait
   * donc ni `brief` ni le nom d'une interface. Ce que chaque coquille
   * RESTE seule a savoir est le contenu — un routeur rend ses
   * interfaces, un Catalyst ses SVI — et c'est ce que le crochet porte ;
   * la GRAMMAIRE, elle, n'a plus qu'une declaration.
   */
  protected showIpInterfaceSpecs(): readonly CommandSpec[] {
    const exec = ['user', 'privileged'];
    return [
      {
        id: 'show-ip-interface',
        path: ['show', 'ip', 'interface', {
          name: 'cible', type: 'REST', optional: true, literal: 'LINE',
          description: 'Interface to describe',
          alternatives: [{ keyword: 'brief', description: 'Brief summary of IP status' }],
        }],
        description: 'IP interface status and configuration',
        modes: exec, minPrivilege: 1,
        run: (_session, args) => this.renduIpInterface(args.cible ?? ''),
      },
    ];
  }

  protected renduIpInterface(_cible: string): string { return ''; }

  /**
   * `show ip route [<protocole> | <prefixe> | summary | vrf <nom>]`,
   * declaree une fois.
   *
   * Les deux plateformes l'enregistraient chacune de son cote, et le
   * commutateur avait la version pauvre : sa propre legende — plus
   * courte, sans `L - local` —, aucune route locale en /32, aucun
   * regroupement par reseau majeur, la distance d'une statique
   * FLOTTANTE perdue, aucun filtre par protocole, et le prefixe ignore.
   * Ce que chaque coquille reste seule a savoir est le contenu de sa
   * table ; la grammaire n'a plus qu'une declaration.
   */
  protected showIpRouteSpecs(): readonly CommandSpec[] {
    return [
      {
        id: 'show-ip-route',
        path: ['show', 'ip', 'route', {
          name: 'cible', type: 'REST', optional: true, literal: 'LINE',
          description: 'Network to display information about',
          alternatives: [
            { keyword: 'connected', description: 'Connected routes' },
            { keyword: 'static', description: 'Static routes' },
            { keyword: 'summary', description: 'Summary of all routes' },
          ],
        }],
        description: 'IP routing table',
        modes: ['user', 'privileged'], minPrivilege: 1,
        run: (_session, args) => this.renduIpRoute(args.cible ?? ''),
      },
    ];
  }

  protected renduIpRoute(_cible: string): string { return ''; }

  /**
   * `show interfaces [<nom> | description | status | ...]`, declaree une
   * fois.
   *
   * Ce lot ne change AUCUN comportement : la sonde ecrite a l'aveugle
   * passe des deux cotes avant comme apres, sur ses vingt-huit cas — les
   * deux plateformes rendaient deja le meme texte, chacune depuis son
   * propre enregistrement glouton. Ce qui disparait est la SECONDE
   * declaration d'une meme grammaire.
   *
   * La place est le MEME objet dans les deux formes, et ce n'est pas un
   * detail : `CommandTable` regroupe les places par SIGNATURE, laquelle
   * compte les `alternatives`. Une place decoree pour la forme nue et
   * une place nue pour les suites font donc DEUX noeuds d'argument, le
   * curseur atterrit sur le premier, et les suites pendent au second
   * ou personne ne les lit — mesure faite, `show interfaces Gi0/0 ?` ne
   * rendait plus que `<cr>`.
   */
  protected showInterfacesSpecs(): readonly CommandSpec[] {
    const exec = ['user', 'privileged'];
    const suites = this.suitesDeclarees('show interfaces');
    const cible: ArgumentSpec = {
      name: 'cible', type: 'REST', optional: true, literal: 'LINE',
      description: 'Interface to describe',
    };

    return [
      {
        id: 'show-interfaces',
        path: ['show', 'interfaces', cible],
        description: 'Interface status and configuration',
        modes: exec, minPrivilege: 1,
        run: (_session, args) => this.renduInterfaces(args.cible ?? ''),
      },
      /*
       * Chaque suite est declaree DEUX fois, comme un vrai noeud de
       * chaque cote de la place : `show interfaces accounting` sans nom
       * rend la vue pour toutes les interfaces, `show interfaces Gi0/0
       * accounting` pour une seule, et les deux sont des formes d'IOS.
       *
       * Un vrai noeud, et non une simple `alternative` decorant la
       * place : la mesure a montre que le mot tombait alors DANS la
       * place, si bien que `show interfaces accounting ?` reproposait
       * `accounting`, `stats` et leurs freres — une aide qui invite a
       * ecrire `show interfaces accounting accounting`.
       */
      ...suites.flatMap(({ keyword, description }): CommandSpec[] => [
        {
          id: `show-interfaces-${keyword}`,
          path: ['show', 'interfaces', keyword],
          description,
          modes: exec, minPrivilege: 1,
          run: () => this.renduInterfaces(keyword),
        },
        {
          id: `show-interfaces-cible-${keyword}`,
          path: ['show', 'interfaces', cible, keyword],
          description,
          modes: exec, minPrivilege: 1,
          run: (_session, args) =>
            this.renduInterfaces(`${args.cible ?? ''} ${keyword}`.trim()),
        },
      ]),
    ];
  }

  protected renduInterfaces(_cible: string): string { return ''; }

  /**
   * `ip route` et sa negation, declarees une fois.
   *
   * La commande de configuration la plus tapee d'IOS avait DEUX
   * analyses, une par plateforme, et elles divergeaient : celle du
   * commutateur perdait la distance administrative — donc une route de
   * SECOURS revenait principale au rechargement d'une topologie — et sa
   * vue laissait paraitre les deux routes d'un meme prefixe la ou la
   * machine n'en installe qu'une.
   *
   * Ce que chaque plateforme garde en propre est ce qu'elle sait
   * HONORER : un routeur retient `permanent`, `track`, `tag` et la forme
   * par interface de sortie, un Catalyst n'a pas ces champs. La
   * grammaire n'a plus qu'une declaration, le magasin reste celui de
   * chacun — les unifier voudrait dire accepter sur le commutateur des
   * mots-cles que rien n'y evalue.
   */
  protected ipRouteSpecs(): readonly CommandSpec[] {
    const prefixe: ArgumentSpec = {
      name: 'prefixe', type: 'IP_ADDR', description: 'Destination prefix',
    };
    const masque: ArgumentSpec = {
      name: 'masque', type: 'SUBNET_MASK', description: 'Destination prefix mask',
    };
    const reste: ArgumentSpec = {
      name: 'reste', type: 'REST',
      description: 'Forwarding router\'s address, or egress interface',
    };
    const queue = (args: Record<string, string>, ...tete: string[]): string =>
      [...tete, args.prefixe ?? '', args.masque ?? '', args.reste ?? '']
        .filter((m) => m !== '').join(' ');
    return [
      {
        id: 'ip-route',
        path: ['ip', 'route', prefixe, masque, reste],
        description: 'Establish static routes',
        undoDescription: 'Remove static route',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => this.poserRouteStatique(queue(args)),
        undo: (_session, args) => this.retirerRouteStatique(queue(args)),
      },
      {
        id: 'ip-route-vrf',
        path: ['ip', 'route', 'vrf',
          { name: 'vrf', type: 'WORD', description: 'VPN Routing/Forwarding instance name' },
          prefixe, masque, reste],
        description: 'Establish static routes in a VRF',
        undoDescription: 'Remove static route from a VRF',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => this.poserRouteStatique(queue(args, 'vrf', args.vrf ?? '')),
        undo: (_session, args) => this.retirerRouteStatique(queue(args, 'vrf', args.vrf ?? '')),
      },
    ];
  }

  protected poserRouteStatique(_reste: string): string { return ''; }
  protected retirerRouteStatique(_reste: string): string { return ''; }


  /**
   * Les suites d'un chemin, LUES sur la table qui les declare deja.
   *
   * Une spec ecrite a la main doit annoncer les memes mots que le trie,
   * et les recopier ici en ferait une seconde declaration — celle qui
   * finit par diverger. `switchport` et `etherchannel` n'existent que
   * sur un Catalyst, `summary` et `accounting` que sur un routeur : la
   * liste est donc PAR PLATEFORME, chaque coquille nommant ses tables.
   */
  protected suitesDeclarees(chemin: string): Array<{ keyword: string; description: string }> {
    const suites = continuationsPourLeSocle(chemin, ...this.tablesDeContinuations());
    return (suites ?? []).map(({ keyword, description }) => ({ keyword, description }));
  }

  protected tablesDeContinuations(): readonly ContinuationTable[] { return [SOCLE]; }

  protected cefSpecs(): CommandSpec[] {
    const sec = () => getSecurityConfig(this.d());
    const glob = () => getGlobalConfig(this.d() as object);
    const enumere = (
      name: string, description: string, valeurs: ReadonlySet<string>,
      mots: Readonly<Record<string, string>>,
    ): ArgumentSpec => ({
      name, type: 'ENUM', description,
      values: [...valeurs].sort().map(keyword => ({
        keyword, description: mots[keyword] ?? description,
      })),
    });

    return [
      {
        id: 'ip-cef', path: ['ip', 'cef'],
        description: 'Enable Cisco Express Forwarding',
        undoDescription: 'Disable Cisco Express Forwarding',
        modes: ['config'], minPrivilege: 15,
        run: () => { sec().ipCef = true; return ''; },
        undo: () => { sec().ipCef = false; return ''; },
      },
      {
        id: 'ip-cef-distributed', path: ['ip', 'cef', 'distributed'],
        description: 'Enable distributed Cisco Express Forwarding',
        undoDescription: 'Disable distributed Cisco Express Forwarding',
        modes: ['config'], minPrivilege: 15,
        run: () => { sec().ipCefDistributed = true; return ''; },
        undo: () => { sec().ipCefDistributed = false; return ''; },
      },
      {
        id: 'ip-cef-load-sharing',
        path: ['ip', 'cef', 'load-sharing', 'algorithm',
          enumere('algorithme', 'Load-sharing algorithm',
            CEF_LOAD_SHARING_ALGORITHMS, {
              original: 'Original algorithm',
              tunnel: 'Algorithm for tunnel environments',
              universal: 'Universal algorithm',
              'include-ports': 'Algorithm including layer-4 ports',
            })],
        description: 'Configure the CEF load-sharing algorithm',
        undoDescription: 'Restore the default algorithm',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => {
          glob().cefLoadSharingAlgorithm = args.algorithme; return '';
        },
        undo: () => { glob().cefLoadSharingAlgorithm = null; return ''; },
      },
      {
        id: 'ip-cef-accounting',
        path: ['ip', 'cef', 'accounting',
          enumere('quoi', 'What to account for', CEF_ACCOUNTING_KINDS, {
            'per-prefix': 'Count packets and bytes per prefix',
            'non-recursive': 'Count only non-recursive prefixes',
            'load-balance-hash': 'Count per load-balance hash bucket',
            'prefix-length': 'Count per prefix length',
          })],
        description: 'Enable CEF accounting',
        undoDescription: 'Disable CEF accounting',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => { glob().cefAccounting.add(args.quoi); return ''; },
        undo: (_session, args) => { glob().cefAccounting.delete(args.quoi); return ''; },
      },
    ];
  }

  protected enableSpecs(): readonly CommandSpec[] {
    const monter = (niveau: string | undefined): string => {
      const lvl = niveau === undefined ? 15 : Number(niveau);
      if (this.enableGateFor(lvl) && !this.consumeEnableAuthorization(lvl)) {
        return '% Access denied';
      }
      this.currentPrivilegeLevel = lvl;
      this.mode = lvl === 15 ? 'privileged' : 'user';
      if (this.logging.userInfo) {
        this.attachLoggingToDevice(this.d());
        const console = this.configSessionLabel === 'console';
        this.logging.append('notifications', 'sys',
          `Privilege level set to ${lvl} by ${console ? 'unknown' : this.configSessionLabel}`
          + ` on ${console ? 'console' : 'vty'}`,
          true, 'PRIV_AUTH_PASS');
      }
      return '';
    };
    const exec = ['user', 'privileged'];

    return [
      {
        id: 'enable',
        path: ['enable', {
          name: 'niveau', type: 'INT', range: [0, 15], optional: true,
          description: 'Enable level',
        }],
        description: 'Turn on privileged commands',
        modes: exec, minPrivilege: 1,
        run: (_session, args) => monter(args.niveau),
      },
      {
        id: 'enable-view',
        path: ['enable', 'view', {
          name: 'vue', type: 'WORD', optional: true,
          description: 'View name',
        }],
        description: 'Enter a command-line interface view',
        modes: exec, minPrivilege: 1,
        run: (_session, args) =>
          this.entrerDansUneVue(args.vue === undefined ? [] : [args.vue]),
      },
    ];
  }

  protected configureSpecs(): readonly CommandSpec[] {
    return [{
      id: 'configure-terminal',
      path: ['configure', 'terminal'],
      description: 'Configure from the terminal',
      // Les trois modes, et non les deux qu'IOS documente : ce shell
      // laisse une session de niveau 1 a 14 en EXEC UTILISATEUR, et
      // `privilege exec level 7 configure terminal` descend justement
      // la commande jusque-la. C'est l'autorisation qui tranche, comme
      // pour `clear`, `write` et la famille de l'archivage.
      modes: ['user', 'privileged', 'config'], minPrivilege: 15,
      run: () => {
        this.mode = 'config';
        return 'Enter configuration commands, one per line.  End with CNTL/Z.';
      },
    }];
  }

  protected archiveExecSpecs(): readonly CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerArchiveExecOn(collector as unknown as CommandTrie),
      {
        modes: ['user', 'privileged'], minPrivilege: 15,
        skip: (path) => !ARCHIVE_EXEC.has(path),
        argumentFor: (path) => ARCHIVE_EXEC_PLACES[path],
      },
    );
  }

  protected arpSpecs(): CommandSpec[] {
    const provider = () => this.d();
    return [
      ...specsFromTrieRegistrations(
        (collector) =>
          registerArpShowCommands(collector as unknown as CommandTrie, provider),
        {
          modes: ['user', 'privileged'], minPrivilege: 1,
          restDescriptionFor: () => 'ARP entry address or interface',
          restLiteralFor: () => 'A.B.C.D',
        },
      ),
      ...specsFromTrieRegistrations(
        (collector) =>
          registerArpConfigCommands(collector as unknown as CommandTrie, provider),
        {
          modes: ['config'], minPrivilege: 15,
          undoFromNegatedPaths: true,
          argumentFor: () => ({
            name: 'reste', type: 'REST',
            description: 'IP address of the ARP entry', literal: 'A.B.C.D',
          }),
        },
      ),
    ];
  }

  protected lineEntrySpecs(): CommandSpec[] {
    const places = (max: number): ArgumentSpec[] => [
      { name: 'premiere', type: 'INT', range: [0, max], description: 'First Line number' },
      { name: 'derniere', type: 'INT', range: [0, max],
        description: 'Last Line number', optional: true },
    ];
    /*
     * `con` est l'abreviation de `console` et non une cinquieme sorte :
     * le socle la resout par prefixe, donc seule la forme canonique se
     * declare — la declarer deux fois rendrait `line ?` avec une ligne
     * de trop, que `?` d'IOS n'ecrit pas.
     */
    const parCanonique = new Map(
      Object.values(SORTES_DE_LIGNE).map(sorte => [sorte.canonique, sorte]));
    const sortes = [...parCanonique.values()]
      .sort((a, b) => a.canonique.localeCompare(b.canonique))
      .map(sorte => ({
        keyword: sorte.canonique, description: sorte.description,
        argument: places(sorte.max),
      }));

    return specsFromTrieRegistrations(
      (collector) => this.registerCommonConfigCommands(collector as unknown as CommandTrie),
      {
        modes: ['config', 'config-line'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        skip: (path) => path !== 'line' && path !== 'no line',
        keywordsFor: () => sortes,
      },
    );
  }

  protected identityBootSpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerCommonConfigCommands(collector as unknown as CommandTrie),
      {
        modes: ['config'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        skip: (path) => !IDENTITE_ET_AMORCAGE.has(path.replace(/^no /, '')),
        argumentFor: (path) => IDENTITE_PLACES[path],
        keywordsFor: (path) => continuationsPourLeSocle(path, SOCLE),
      },
    );
  }

  protected hardeningSpecs(): CommandSpec[] {
    const poser = (
      applique: (sec: ReturnType<typeof getSecurityConfig>, on: boolean) => void, on: boolean,
    ): string => {
      applique(getSecurityConfig(this.d()), on);
      return '';
    };

    return IOS_HARDENING.map(([mots, description, undoDescription, applique]) => ({
      id: `hardening-${mots.join('-')}`,
      path: [...mots],
      description,
      undoDescription,
      modes: ['config'],
      minPrivilege: 15,
      run: () => poser(applique, true),
      undo: () => poser(applique, false),
    }));
  }

  protected writeEraseSpecs(): CommandSpec[] {
    const sauver = (): string => this.onSave();
    const effacer = (): string => {
      this.onErase();
      return 'Erasing the nvram filesystem will remove all configuration files!'
        + ' Continue? [confirm]\n[OK]\nErase of nvram: complete';
    };
    const exec = (
      id: string, path: readonly string[], description: string, run: () => string,
    ): CommandSpec => ({
      id, path: [...path], description,
      // Les deux modes d'EXEC, pour la raison ecrite sur `clearSpecs` :
      // c'est l'AUTORISATION qui tranche, et `privilege exec level 10
      // write memory` descend la commande a une session qui reste en
      // EXEC utilisateur.
      modes: ['user', 'privileged'], minPrivilege: 15, run,
    });

    return [
      exec('write', ['write'], 'Write running configuration to memory', sauver),
      exec('write-memory', ['write', 'memory'], 'Write to NV memory', sauver),
      exec('write-erase', ['write', 'erase'], 'Erase NV memory', effacer),
      exec('write-terminal', ['write', 'terminal'], 'Write to terminal',
        () => this.executeOnTrie('show running-config')),
      exec('erase-startup-config', ['erase', 'startup-config'],
        'Erase contents of configuration memory', effacer),
      exec('erase-nvram', ['erase', 'nvram:'], 'Filesystem to be erased', effacer),
    ];
  }

  /**
   * Ce qu'un noeud INTERMEDIAIRE du socle merite comme intitule.
   *
   * Sans lui, `?` herite de la description du premier descendant :
   * `ipv6 ?` annoncait « Set OSPFv3 cost » pour le mot `ipv6`, c'est-a-dire
   * la description d'UNE des branches pour le nom de TOUTES.
   */
  protected archiveSubmodeSpecs(): readonly CommandSpec[] {
    const ar = () => this.archiveService();
    return [
      ...archiveSubmodeSpecs(ar, () => { this.mode = 'config-archive-log'; }),
      ...archiveLogSubmodeSpecs(ar),
    ];
  }

  protected socleLegends(): SocleLegend[] {
    return [
      [['show', 'ip', 'http'], 'HTTP information'],
      [['client-identifier'], 'Manual binding client identifier'],
      [['lease'], 'Set DHCP lease duration'],
      [['option'], 'Set a raw DHCP option'],
      [['show', 'ip', 'http', 'server'], 'HTTP server information'],
    ];
  }

  private pileTcp(): TcpBriefSource | null {
    const dev = this.d() as unknown as { getTcpStack?: () => TcpBriefSource };
    return dev.getTcpStack?.() ?? null;
  }

  protected socleTable(): CommandTable | null {
    if (!this.socleInstance) {
      this.socleCheminsParPortee = undefined;
      this.socleUndoSansValeur = undefined;
      this.socleInstance = new CommandTable();
      for (const spec of this.socleSpecs()) this.socleInstance.declare(spec);
      for (const [path, legend, modes] of this.socleLegends()) {
        this.socleInstance.describePath(path, legend, modes);
      }
    }
    return this.socleInstance;
  }

  /**
   * Un chemin migre emmene sa NEGATION avec lui.
   *
   * Le trie enregistre `no debug arp` comme un chemin a part entiere ; le
   * socle le porte comme la moitie `undo` d'une seule declaration. Ne
   * nommer que la forme positive laisserait la negation dans le trie,
   * donc deux moteurs pour la meme frappe — exactement ce que le
   * garde-fou de migration existe pour empecher.
   */
  protected migratedPaths(): readonly string[] {
    const table = this.socleTable();
    if (!table) return [];

    const paths: string[] = [];
    for (const spec of table.specs()) {
      const text = spec.path
        .filter((step): step is string => typeof step === 'string').join(' ');
      paths.push(text);
      if (spec.undo) paths.push(`no ${text}`);
    }
    return paths;
  }

  protected pruneMigratedFromTries(): void {
    const table = this.socleTable();
    if (!table) return;

    for (const [champ, valeur] of Object.entries(this as unknown as Record<string, unknown>)) {
      if (valeur instanceof CommandTrie) {
        this.pruneUnTrie(table, valeur, modesDuTrie(champ));
        continue;
      }
      /*
       * Un arbre n'est pas toujours un CHAMP : les huit sous-modes de
       * type d'IP SLA vivent dans une table indexee par leur propre mode,
       * donc cette boucle ne les voyait pas et quatre-vingt-deux chemins
       * migres restaient dans le trie — un doublon qu'aucun garde-fou ne
       * signalait, l'elagage etant justement ce qui le detecte. La cle de
       * la table EST le mode, ce qui la rend plus sure que la derivation
       * par le nom du champ.
       */
      if (valeur === null || typeof valeur !== 'object') continue;
      for (const [cle, enfant] of Object.entries(valeur as Record<string, unknown>)) {
        if (enfant instanceof CommandTrie) this.pruneUnTrie(table, enfant, [cle]);
      }
    }
  }

  private pruneUnTrie(
    table: CommandTable, trie: CommandTrie, modes: readonly string[],
  ): void {
    const paths: string[] = [];
    for (const spec of table.specs()) {
      if (!modes.some(mode => spec.modes.includes(mode))) continue;
      const texte = CiscoShellBase.keywordPathOf(spec).join(' ');
      paths.push(texte);
      if (spec.undo) paths.push(`no ${texte}`);
    }
    if (paths.length > 0) trie.prunePaths(paths);
    /*
     * Elaguer retire l'action d'un noeud EXISTANT. Une famille migree a
     * la main, dont l'enregistrement a ete supprime, n'en laisse aucun :
     * le chemin disparait du trie et son abreviation cesse d'etre
     * ambigue. Le port rend les mots que le socle declare a cet
     * endroit, pour que le trie les compte comme rivaux sans les
     * proposer.
     */
    trie.setRivalKeywordsPort((chemin, prefixe) => this.motsDuSocleSous(chemin, prefixe));
    trie.setSocleOwnsKeywordPort((chemin, mot) => this.socleTientCeMot(chemin, mot));
  }

  /**
   * Les mots-cles que le socle declare sous un chemin donne.
   *
   * Lus sur les SPECS et non sur l'arbre : une spec porte son chemin
   * canonique, donc la reponse ne depend d'aucun noeud et ne peut pas
   * fabriquer de candidat de completion.
   */
  private motsDuSocleSous(chemin: readonly string[], prefixe: string): string[] {
    const table = this.socleTable();
    if (!table) return [];
    /*
     * Un rival que la SESSION ne voit pas n'en est pas un. Sans ce
     * filtre, `sh run` repondait « ambigu » a un compte dont le niveau
     * n'atteint pas `show running-config` — la commande restait
     * refusee, mais avec un message qui affirme l'existence de ce que
     * la vue cache, la ou IOS repond que le mot n'existe pas.
     */
    /*
     * Le garde de reentrance n'est pas une precaution : construire la
     * session interroge l'autorisation, qui repasse par la resolution
     * de commande, qui rappelle ce port — la pile explosait. Quand on
     * est deja dedans, on ne compte aucun rival : on retombe sur le
     * comportement d'avant plutot que de boucler.
     */
    if (this.dansLeCalculDesRivaux) return [];
    /*
     * Sans equipement, pas de session, donc pas de visibilite a
     * consulter : le planificateur d'interaction appelle `match` HORS
     * d'`execute` pour canoniser une ligne, et y lever ferait perdre a
     * `copy run start` son dialogue. On ne compte alors aucun RIVAL —
     * en inventer un hors session ferait refuser `rel`, qui n'abrege
     * qu'une commande dans le mode ou on la tape.
     */
    if (this.deviceRef === null) return [];
    this.dansLeCalculDesRivaux = true;
    try {
      return this.motsVisiblesDuSocle(table, chemin, prefixe);
    } finally {
      this.dansLeCalculDesRivaux = false;
    }
  }

  private dansLeCalculDesRivaux = false;

  /**
   * Le socle declare-t-il EXACTEMENT ce mot sous ce chemin ?
   *
   * Lu sur la TABLE et non sur une session : la reponse ne depend
   * d'aucun privilege, et elle doit valoir hors d'`execute`, la ou
   * `cliHelp` interroge. Elle ne sert qu'a faire taire le trie quand le
   * socle possede le mot — `ip route` parti au socle, `route` ne
   * rencontrait plus ici que `route-cache`, donc `ip route ?` proposait
   * `flow`, la suite d'une AUTRE commande.
   */
  private socleTientCeMot(chemin: readonly string[], mot: string): boolean {
    const table = this.socleTable();
    if (!table) return false;
    return this.motsDuSocleFiltres(table, chemin, mot, null).includes(mot);
  }

  private motsVisiblesDuSocle(
    table: CommandTable, chemin: readonly string[], prefixe: string,
  ): string[] {
    return this.motsDuSocleFiltres(table, chemin, prefixe, this.socleSession(table));
  }

  private motsDuSocleFiltres(
    table: CommandTable, chemin: readonly string[], prefixe: string,
    session: CliSession | null,
  ): string[] {
    /*
     * `no` n'est pas un mot du socle mais un MODIFICATEUR : une commande
     * negociable s'y declare `ip route` avec son `undo`, jamais
     * `no ip route`. Interroger le socle avec `no` en tete ne trouvait
     * donc aucun rival, et `no ip rout` COUPAIT le routage — la moitie
     * la plus couteuse du defaut, puisque c'est celle qui applique.
     */
    const nie = chemin.length > 0 && chemin[0].toLowerCase() === 'no';
    const amont = (nie ? chemin.slice(1) : chemin).map(mot => mot.toLowerCase());
    const mots = new Set<string>();
    for (const spec of table.specs()) {
      if (nie && spec.undo === undefined) continue;
      if (session !== null && !table.isReachable(spec, session)) continue;
      const canonique = CiscoShellBase.keywordPathOf(spec).map(mot => mot.toLowerCase());
      if (canonique.length <= amont.length) continue;
      if (!amont.every((mot, rang) => canonique[rang] === mot)) continue;
      const suivant = canonique[amont.length];
      if (suivant.startsWith(prefixe)) mots.add(suivant);
    }
    return [...mots];
  }

  private prefixIsUnambiguous(cmdPart: string, spec: { path: readonly unknown[] }): boolean {
    const typed = cmdPart.trim().toLowerCase().split(/\s+/);
    const canonical = spec.path
      .filter((step): step is string => typeof step === 'string')
      .map(word => word.toLowerCase());
    // Une spec qui finit par un argument GLOUTON absorbe tout ce qui
    // suit ses mots-cles : une commande plus longue du trie est alors une
    // rivale, pas une continuation. `debug ip` avalerait `debug ip ospf`
    // et `clear logging` avalerait `clear logging persistent`.
    const glouton = spec.path.some(
      step => typeof step === 'object' && step !== null
        && (step as { type?: string }).type === 'REST');
    // Il n'absorbe que ce qui a ete TAPE au-dela de ses mots-cles :
    // `clear logging` seul reste au socle, `clear logging persistent`
    // revient au trie qui le declare pour lui-meme.
    const absorbe = glouton && typed.length > canonical.length;

    for (const path of this.getActiveTrie().enumerateCommandPaths()) {
      const words = path.toLowerCase().split(' ');
      if (CiscoShellBase.sameKeywords(words, canonical)) continue;
      if (CiscoShellBase.motAmbiguAUnRang(typed, words, canonical)) return false;
      if (CiscoShellBase.prefixMatches(typed, words, canonical, absorbe)) return false;
    }
    return true;
  }

  /**
   * Le mot tape abrege-t-il a la fois la commande du socle et une AUTRE
   * du trie ?
   *
   * La question se pose a CHAQUE rang, pas au premier seulement. Elle
   * n'y etait posee que la, et la limite se voyait des qu'une famille
   * migrait : `ip route` parti au socle, `ip routing` reste au trie,
   * `ip rout` abrege les deux — le socle ne voyait plus son rival et
   * POSAIT la route, la ou une vraie machine refuse. Le pont inverse
   * (`setRivalKeywordsPort`) tient deja le sens trie → socle a tous les
   * rangs ; celui-ci est son symetrique.
   *
   * Les rangs precedents doivent CONCORDER : sans cela `show ip igmp`
   * serait tenu pour un rival de `show mac address-table`, deux chemins
   * qui ne se rencontrent jamais. Et un mot tape EN ENTIER n'est jamais
   * ambigu, meme s'il prefixe l'autre — c'est la regle qui laisse
   * passer `ip route` quand `ip routing` existe.
   */
  private static motAmbiguAUnRang(
    typed: readonly string[], words: readonly string[], canonical: readonly string[],
  ): boolean {
    const jusqua = Math.min(typed.length, words.length, canonical.length);
    for (let rang = 0; rang < jusqua; rang += 1) {
      if (rang > 0 && words[rang - 1] !== canonical[rang - 1]) return false;
      const tape = typed[rang];
      if (tape === canonical[rang]) continue;
      if (!canonical[rang].startsWith(tape)) return false;
      return words[rang] !== canonical[rang] && words[rang].startsWith(tape);
    }
    return false;
  }

  /**
   * Ce qui precede le mot en cours de frappe.
   *
   * `show crypto ipsec s` a pour amont `show crypto ipsec` ; le meme
   * texte suivi d'un blanc est deja son propre amont. La tabulation rend
   * des LIGNES completes, la completion du socle des MOTS-CLES : sans
   * cette moitie, un mot-cle du socle arriverait seul dans une liste de
   * lignes et se ferait juger comme s'il etait une commande racine.
   */
  /**
   * Ce qui precede le mot en cours, ECRIT EN ENTIER.
   *
   * La tabulation rend des LIGNES, et une ligne qui garde l'abreviation
   * tapee n'est pas une commande : `sho runn` proposait
   * `sho running-config` a cote de `show running-config`, donc DEUX
   * candidats pour une seule commande — et un terminal qui a deux
   * candidats liste au lieu de completer. C'est ainsi que la tabulation
   * paraissait ne rien faire des qu'un mot anterieur etait abrege.
   *
   * Le trie rend deja ses lignes canoniques ; c'est le pont vers le
   * socle qui recollait le mot tape. Il recolle desormais le mot du
   * registre, et retombe sur la frappe quand aucun des deux moteurs ne
   * sait la resoudre — mieux vaut un candidat imparfait que pas de
   * candidat.
   */
  private amontCanonique(input: string): string {
    const brut = CiscoShellBase.completionStem(input);
    if (brut === '') return brut;

    const negation = CiscoShellBase.motDeNegation(brut);
    if (negation !== null) {
      const reste = this.amontCanonique(`${brut.slice(negation.length)} `);
      return `${negation.trim()} ${reste}`.trim();
    }

    const table = this.socleTable();
    const parLeSocle = table
      ? this.cheminCanonique(table, `${brut} `, this.socleSession(table)) : null;
    if (parLeSocle !== null && parLeSocle.length > 0) return parLeSocle.join(' ');

    const parLeTrie = this.getActiveTrie().match(brut);
    if (parLeTrie.matchedKeywords.length > 0) return parLeTrie.matchedKeywords.join(' ');
    return brut;
  }

  private static completionStem(input: string): string {
    const trimmed = input.trim();
    if (input.endsWith(' ') || trimmed === '') return trimmed;
    return trimmed.slice(0, trimmed.lastIndexOf(' ') + 1).trim();
  }

  private static sameKeywords(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((word, i) => word === right[i]);
  }

  /**
   * Un chemin du trie CONCURRENCE-t-il vraiment la commande du socle ?
   *
   * Deux cas ne sont pas des ambiguites, et les compter comme telles
   * rendait la commande du socle inatteignable.
   *
   * Une commande PLUS LONGUE sous le meme prefixe est une continuation,
   * pas une rivale : `show crypto ipsec sa interface` ne rend pas
   * `show crypto ipsec sa` ambigu, il la prolonge. Le defaut ne s'est vu
   * qu'une fois l'elagage repare — le descendant etait supprime avec son
   * parent, donc il n'y avait rien pour concurrencer.
   *
   * Et une correspondance EXACTE l'emporte sur un prefixe, comme partout
   * ailleurs dans cette CLI : `sa` tape en toutes lettres designe `sa`,
   * meme si `security-association` commence par ces deux lettres.
   */
  private static prefixMatches(
    typed: readonly string[], words: readonly string[], canonical: readonly string[],
    absorbe: boolean,
  ): boolean {
    if (typed.length === 0) return false;
    if (CiscoShellBase.trieSpellsWhatSocleAbbreviates(typed, words, canonical)) return true;
    // Un chemin du trie PLUS COURT que la frappe reste un concurrent
    // quand il est plus precis que les mots-cles du socle : `debug ip
    // ospf` est enregistre pour lui-meme et absorbe sa propre suite, donc
    // `debug ip ospf adj` lui revient et non au `debug ip` du socle.
    if (words.length < typed.length) {
      return absorbe && words.length > canonical.length
        && CiscoShellBase.extendsPath(typed, words);
    }
    if (!absorbe && CiscoShellBase.extendsPath(words, canonical)) return false;

    for (let index = 0; index < typed.length; index++) {
      if (!words[index].startsWith(typed[index])) return false;
      if (typed[index] === canonical[index] && words[index] !== typed[index]) return false;
    }
    return true;
  }

  private static trieSpellsWhatSocleAbbreviates(
    typed: readonly string[], words: readonly string[], canonical: readonly string[],
  ): boolean {
    const commun = Math.min(typed.length, words.length, canonical.length);

    for (let index = 0; index < commun; index++) {
      if (!words[index].startsWith(typed[index])) return false;
      if (words[index] === typed[index] && canonical[index] !== typed[index]) return true;
      if (canonical[index] !== typed[index]) return false;
    }
    return false;
  }

  private static extendsPath(words: readonly string[], canonical: readonly string[]): boolean {
    if (words.length < canonical.length) return false;
    return canonical.every((word, index) => words[index] === word);
  }

  /**
   * La colonne du n-ieme mot de la ligne, pour y poser le caret.
   *
   * Compte les blancs REELS plutot que de supposer un separateur unique :
   * `clock set   99:99:99` est une ligne qu'un operateur tape, et un
   * caret pose au mauvais endroit vaut moins qu'aucun caret.
   */
  private static offsetOfWord(line: string, index: number): number {
    const brut = line.replace(/^\s*(no\s+)?/i, '');
    const decalage = line.length - brut.length;
    let position = 0;

    for (let rang = 0; rang < index; rang++) {
      while (position < brut.length && /\s/.test(brut[position])) position++;
      while (position < brut.length && !/\s/.test(brut[position])) position++;
    }
    while (position < brut.length && /\s/.test(brut[position])) position++;
    return decalage + position;
  }

  /**
   * Le trie a-t-il un chemin AUSSI PRECIS que ce que le socle a lu ?
   *
   * `minMots` est le nombre de mots que le socle a reconnus avant de
   * buter. Un chemin plus court est un fourre-tout — le noeud glouton
   * `clock` attrape `clock set …` faute de mieux — et le laisser gagner
   * ferait perdre le diagnostic PRECIS que le socle sait rendre.
   */
  /**
   * `ip` n'est pas une abreviation d'`ipv6` — le trie l'ecrit en entier.
   *
   * Chaque moteur ne connait que la MOITIE du vocabulaire d'un noeud :
   * le socle porte `ipv6`, le trie porte `ip`, et aucun des deux ne peut
   * juger seul qu'un mot est ambigu. Le socle, ne voyant qu'`ipv6`,
   * resolvait `ip ospf cost 50` en `ipv6 ospf cost 50` — une commande
   * qui existe, sur l'autre famille d'adresses. Le pont est le seul
   * endroit qui voit les deux vocabulaires, donc le seul qui puisse
   * arbitrer : un mot que le trie ecrit en toutes lettres n'est
   * l'abreviation de rien.
   *
   * Le mot EN COURS DE FRAPPE en est exclu : `ip?` demande ce qui
   * commence par `ip`, et `ipv6` en fait partie.
   */
  private socleAbregeCeQueLeTrieEcrit(input: string): boolean {
    const table = this.socleTable();
    if (!table) return false;

    const mots = input.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const parcourus = input.endsWith(' ') ? mots : mots.slice(0, -1);

    let node = table.rootNode();
    for (let index = 0; index < parcourus.length; index++) {
      const enfants = [...node.children.values()];
      const exact = enfants.find(c => c.keyword?.toLowerCase() === parcourus[index]);
      if (exact) { node = exact; continue; }

      const prefixes = enfants.filter(
        c => c.keyword?.toLowerCase().startsWith(parcourus[index]));
      if (prefixes.length !== 1) return false;
      if (this.trieEcritEnEntier(parcourus.slice(0, index + 1))) return true;
      node = prefixes[0];
    }
    return false;
  }

  private trieEcritEnEntier(mots: readonly string[]): boolean {
    const cible = mots.join(' ');

    return this.getActiveTrie().enumerateCommandPaths()
      .some(path => {
        const bas = path.toLowerCase();
        return bas === cible || bas.startsWith(`${cible} `);
      });
  }

  private trieConnait(cmdPart: string, minMots: number): boolean {
    const typed = cmdPart.trim().toLowerCase().replace(/^no\s+/i, '').split(/\s+/);

    for (const path of this.getActiveTrie().enumerateExecutablePaths()) {
      const words = path.toLowerCase().split(' ');
      if (words.length > typed.length || words.length < minMots) continue;
      // C'est l'operateur qui abrege, jamais le registre : un mot du trie
      // doit COMMENCER par ce qui a ete tape. La comparaison inverse
      // faisait de `ip ospf cost` — un vrai chemin du trie — la reponse
      // a `ipv6 ospf cost`, parce qu'`ipv6` commence par `ip`.
      if (words.every((word, index) => word.startsWith(typed[index] ?? ''))) return true;
    }
    return false;
  }

  private trieResoutExactement(cmdPart: string): boolean {
    const resultat = this.getActiveTrie().match(cmdPart);
    if (resultat.status !== 'ok') return false;
    const tapes = cmdPart.trim().toLowerCase().split(/\s+/);
    return resultat.matchedKeywords.every(
      (mot, rang) => mot.toLowerCase() === (tapes[rang] ?? ''));
  }

  private trieProlonge(cmdPart: string): boolean {
    const typed = cmdPart.trim().toLowerCase().replace(/^no\s+/i, '').split(/\s+/);

    for (const path of this.getActiveTrie().enumerateExecutablePaths()) {
      const words = path.toLowerCase().split(' ');
      if (words.length <= typed.length) continue;
      if (typed.every((word, index) => words[index].startsWith(word))) return true;
    }
    return false;
  }

  private static keywordCount(spec: { path: readonly unknown[] }): number {
    return spec.path.filter(step => typeof step === 'string').length;
  }

  private socleLiveValues(): LiveValuesPort | null {
    const device = this.deviceRef;
    if (!device) return null;

    const resolver = new EquipmentParamResolver(
      device as unknown as CompletableDevice, this.sessionParamRanges());
    return {
      candidatesFor: (contexte) => resolver.candidatesFor({
        path: contexte.path,
        paramType: contexte.paramType as ParamType | null,
        partial: contexte.partial,
      }),
    };
  }

  private socleSession(table: CommandTable): CliSession {
    table.attachAuthorization({
      authorizes: (commandText, defaultLevel) => this.autorisation().authorize({
        principal: this.mandataire(),
        scope: scopeForMode(this.mode),
        command: commandText,
        defaultLevel,
      }) !== 'absent',
    });

    table.attachLiveValues(this.socleLiveValues());

    const session = newSession(this.d().getHostname?.() ?? 'Router', this, {
      initialMode: this.mode,
      privilegeLevel: this.currentPrivilegeLevel,
    });
    Object.assign(session.fields, this.socleFields);
    return session;
  }

  /**
   * Ce que le socle DECLARE, l'aide et la tabulation doivent le voir.
   *
   * Le pont n'allait que dans un sens : l'execution consultait le socle,
   * `?` et la tabulation lisaient les arbres seuls. Une famille migree
   * etait donc elaguee du trie sans que rien la remette dans l'aide, et
   * la machine se contredisait — `tunnel source Loopback0` s'executait
   * pendant que `tunnel ?` repondait `% Invalid input detected`, le
   * message d'une commande qui n'existe pas.
   */
  protected socleSuggestions(
    input: string, trigger: CompletionTrigger, device?: TDevice,
  ): Array<{ keyword: string; description: string }> {
    const table = this.socleTable();
    if (!table) return [];

    // `default` n'existe qu'en configuration — l'honorer en EXEC ferait
    // repondre `default ?` sur une machine qui refuse `default`. `no`,
    // lui, se tape aussi en EXEC : `no debug track` en est une.
    const negation = CiscoShellBase.motDeNegation(input);
    const horsPortee = negation !== null
      && negation.trim().toLowerCase() === 'default' && !this.isConfigMode();
    if (horsPortee) return [];
    const ligne = negation === null ? input : input.slice(negation.length);
    // La tabulation ne DEPLIE pas une branche entiere : `no ` suivi d'un
    // blanc ne complete rien, comme `ip ` ou `interface `. C'est `?` qui
    // liste.
    if (negation !== null && trigger === 'TAB' && ligne.trim() === '') return [];
    if (this.socleAbregeCeQueLeTrieEcrit(ligne)) return [];

    const precedent = this.deviceRef;
    if (device) this.deviceRef = device;
    try {
      // `?` ANNONCE le type attendu (`<5-254>`, `A.B.C.D`) et `<cr>` ;
      // la tabulation ne les complete pas, n'ayant rien a deviner. Les
      // filtrer des deux cotes rendait le socle muet la ou il est le
      // mieux renseigne — il connait le type, le trie ne l'avait pas.
      const brutes = socleComplete(table, ligne, this.socleSession(table), trigger).suggestions
        .filter(s => trigger === 'QUESTION_MARK' || !s.isArgument || s.completable === true)
        .map(s => ({
          keyword: s.value, description: s.description, isArgument: s.isArgument,
        }));

      const rendues = negation === null
        ? this.avecNegationAuPremierRang(table, ligne, brutes)
        : this.suggestionsNegatives(table, ligne, brutes);
      return rendues.map(({ keyword, description }) => ({ keyword, description }));
    } finally {
      this.deviceRef = precedent;
    }
  }

  private static motDeNegation(input: string): string | null {
    const match = /^\s*(no|default)\s+/i.exec(input);
    return match ? match[0] : null;
  }

  /**
   * Ce que `no ?` doit rendre : les commandes qui savent se DEFAIRE.
   *
   * Le pont ne traversait que dans le sens positif : `logging ?` lisait
   * le socle, `no logging ?` ne lisait que le trie. Une famille migree
   * perdait donc l'aide de sa negation d'un seul coup — `no ntp ?`,
   * `no clock ?`, `no tunnel ?` et `no ipv6 nd ?` repondaient toutes
   * `% Invalid input detected`, le message d'une commande qui n'existe
   * pas, pour des negations qui s'executent tres bien.
   *
   * Une commande sans `undo` n'y figure pas : l'annoncer promettrait une
   * negation que l'execution refuse.
   */
  /**
   * `no` est propose des qu'une commande du mode sait se defaire.
   *
   * Le mot venait du trie, ou il etait un mot-cle comme un autre ; une
   * famille entierement migree le perdait donc de son premier rang,
   * alors que `no <commande>` s'execute. Il ne peut pas rejoindre les
   * commandes universelles : celles-la n'ont pas de suite, et `no ?`
   * doit lister ce qui se defait.
   */
  private avecNegationAuPremierRang(
    table: CommandTable, ligne: string,
    brutes: Array<{ keyword: string; description: string; isArgument: boolean }>,
  ): Array<{ keyword: string; description: string; isArgument: boolean }> {
    /*
     * `?` liste au rang vide, la tabulation part d'une frappe partielle :
     * limiter l'offre au rang vide faisait annoncer `no` par l'aide sans
     * que Tab sache l'ecrire. Le garde-fou de parite l'a attrape sur
     * `config-vlan`, ou tout ce qui se defait vient du socle.
     */
    const frappe = ligne.trim().toLowerCase();
    if (/\s/.test(frappe) || !'no'.startsWith(frappe)) return brutes;
    if (!this.isConfigMode()) return brutes;
    if (brutes.some(s => s.keyword.toLowerCase() === 'no')) return brutes;
    if (!CiscoShellBase.negationSous(table, [], this.mode)) return brutes;
    return [...brutes, {
      keyword: 'no', description: 'Negate a command or set its defaults',
      isArgument: false,
    }];
  }

  private suggestionsNegatives(
    table: CommandTable, ligne: string,
    brutes: Array<{ keyword: string; description: string; isArgument: boolean }>,
  ): Array<{ keyword: string; description: string; isArgument: boolean }> {
    const amont = this.cheminCanonique(table, ligne, this.socleSession(table));
    if (amont === null
      || !CiscoShellBase.negationSous(table, amont, this.mode)) return [];

    /*
     * `<cr>` repond de la NEGATION, pas de la forme positive.
     *
     * `bfd` seul s'execute, `no bfd` seul non — seule `no bfd echo` se
     * defait — donc l'aide de la ligne niee ne doit pas reprendre le
     * `<cr>` que la commande positive merite.
     */
    const negationSansValeur = amont.length > 0
      && this.undoSansValeur(table, this.mode, amont.join(' '));

    return brutes.flatMap(suggestion => {
      if (negationSansValeur && suggestion.keyword === '<cr>') return [];
      // Une VALEUR d'argument n'a pas de chemin a elle : c'est la
      // commande qui la porte qui sait se defaire, et elle vient d'etre
      // jugee. `no service ?` doit rendre les vingt-quatre services.
      if (suggestion.isArgument || !/^[A-Za-z]/.test(suggestion.keyword)) return [suggestion];

      const chemin = [...amont, suggestion.keyword.toLowerCase()];
      const spec = CiscoShellBase.negationSous(table, chemin, this.mode);
      if (!spec) return [];

      const nomme = CiscoShellBase.keywordPathOf(spec).length === chemin.length;
      return [{
        keyword: suggestion.keyword,
        description: nomme && spec.undoDescription
          ? spec.undoDescription : suggestion.description,
        isArgument: false,
      }];
    });
  }

  private static keywordPathOf(spec: CommandSpec): string[] {
    return spec.path
      .filter((step): step is string => typeof step === 'string')
      .map(word => word.toLowerCase());
  }

  private static negationSous(
    table: CommandTable, chemin: readonly string[], mode?: string,
  ): CommandSpec | null {
    let dessous: CommandSpec | null = null;

    for (const spec of table.specs()) {
      if (!spec.undo) continue;
      // Une commande d'un AUTRE mode ne se defait pas ici : sans ce
      // filtre, `no ?` proposait dans un sous-mode les negations de tous
      // les autres.
      if (mode !== undefined && !spec.modes.includes(mode)) continue;
      const mots = CiscoShellBase.keywordPathOf(spec);
      if (mots.length < chemin.length) continue;
      if (!chemin.every((mot, rang) => mots[rang] === mot)) continue;
      if (mots.length === chemin.length) return spec;
      dessous ??= spec;
    }
    return dessous;
  }

  /**
   * Les mots-cles franchis, ecrits en entier, les arguments retires.
   *
   * `logging host 10.0.0.1 ` a pour chemin `logging host` : l'adresse
   * occupe une place mais n'en nomme aucune, et la comparer a un chemin
   * de mots-cles ne designerait rien.
   */
  private static enfantUnique(node: TreeNode, mot: string): TreeNode | undefined {
    const enfants = [...node.children.values()];
    const exact = enfants.find(child => child.keyword?.toLowerCase() === mot);
    if (exact) return exact;

    const prefixes = enfants.filter(child => child.keyword?.toLowerCase().startsWith(mot));
    return prefixes.length === 1 ? prefixes[0] : undefined;
  }

  /**
   * Le chemin canonique d'une commande MIGREE, dans le mode ou on la tape.
   *
   * Sans le mode, `wr` designe `write` ET `write-memory` — la seconde
   * vivant dans le sous-mode `archive`, ou l'operateur n'est pas — donc
   * l'abreviation devenait ambigue et `wr er` perdait son dialogue
   * `[confirm]`. Le mode est ce qui les departage, comme partout
   * ailleurs dans le socle.
   */
  private cheminCanoniqueDuSocle(ligne: string, mode?: string): string[] | null {
    const table = this.socleTable();
    if (!table) return null;

    // La session est fabriquee POUR le mode demande, et non prise a
    // l'equipement : un plan est demande hors de `execute`, donc la
    // reference d'appareil n'est pas posee, et un routeur neuf est
    // encore au niveau 1 alors qu'on interroge le mode privilegie.
    const session = mode === undefined ? null : newSession('Router', this, {
      initialMode: mode,
      privilegeLevel: mode === 'user' ? 1 : 15,
    });
    const chemin = this.cheminCanonique(table, ligne, session);
    return chemin !== null && chemin.length > 0 ? chemin : null;
  }

  private cheminCanonique(
    table: CommandTable, ligne: string, session: CliSession | null,
  ): string[] | null {
    const tapes = ligne.trim().split(/\s+/).filter(Boolean);
    const parcourus = ligne.endsWith(' ') ? tapes : tapes.slice(0, -1);

    let node = table.rootNode();
    const canonique: string[] = [];
    for (const tape of parcourus) {
      const mot = tape.toLowerCase();
      const enfant = session
        ? uniqueChild(node, mot, table, session)
        : CiscoShellBase.enfantUnique(node, mot);
      if (enfant?.keyword) {
        node = enfant;
        canonique.push(enfant.keyword.toLowerCase());
        continue;
      }
      const argument = session
        ? table.argumentAt(node, session)
        : node.argumentChildren[0];
      if (argument?.argument && argumentAccepts(argument.argument, mot)) {
        node = argument;
        canonique.push(tape);
        continue;
      }
      return null;
    }
    return canonique;
  }

  private tryMigratedCommand(cmdPart: string): string | null {
    const table = this.socleTable();
    if (!table) return null;

    const session = this.socleSession(table);
    const parsed = parseCommand(table, cmdPart, session);
    // Le socle SAIT qu'il manque un argument : se taire laisserait le
    // trie repondre `% Invalid input` pour une commande qui existe et
    // qu'il possede. Il ne le dit que si aucun chemin du trie ne
    // prolonge la frappe — sinon c'est le trie qui a la suite.
    if (parsed.status === 'incomplete') {
      const mots = cmdPart.trim().replace(/^no\s+/i, '').split(/\s+/).length;
      const auTrie = (this.trieProlonge(cmdPart) || this.trieConnait(cmdPart, mots))
        && this.getActiveTrie().match(cmdPart).status !== 'invalid';
      return auTrie ? null : CISCO_ERRORS.INCOMPLETE;
    }
    // Un refus du socle MONTRE ou l'on s'est trompe. Se taire ici
    // laissait le trie rendre un message nu, sans le caret d'IOS : le
    // diagnostic disait qu'on s'etait trompe sans dire ou. Meme garde
    // que pour l'incompletude — le trie garde la main s'il a la suite.
    // `position > 0` : le socle n'a le droit de refuser que s'il a
    // RECONNU au moins un mot-cle. Une erreur des le premier mot veut
    // dire que la commande entiere lui est etrangere — et IOS en fait
    // alors un nom d'hote a joindre, ce qui ne lui appartient pas.
    if (parsed.status === 'invalid' && parsed.position > 0
      && parsed.refusePar !== undefined
      && !this.trieProlonge(cmdPart)
      && !this.trieConnait(cmdPart, parsed.position)) {
      if (parsed.refusePar === 'niveau') return CISCO_ERRORS.INVALID_INPUT;
      return renderCliDiagnostic('invalid', {
        line: cmdPart,
        tokenOffset: CiscoShellBase.offsetOfWord(cmdPart, parsed.position),
      });
    }
    if (parsed.status === 'ambiguous' && !this.trieResoutExactement(cmdPart)) {
      return renderCliDiagnostic('ambiguous', { line: cmdPart });
    }
    if (parsed.status !== 'ok') return null;
    if (!parsed.spec.modes.includes(this.mode)
      && this.getActiveTrie().match(cmdPart).status === 'ok') {
      return null;
    }
    const bare = cmdPart.trim().replace(/^no\s+/i, '');
    if (!this.prefixIsUnambiguous(bare, parsed.spec)) return null;

    const handler = parsed.negated && parsed.spec.undo ? parsed.spec.undo : parsed.spec.run;
    // Un gestionnaire migre leve les MEMES diagnostics qu'avant : ils
    // doivent donc etre rendus par le meme traducteur. Sans cela une
    // commande refusee remontait son exception a travers le repartiteur
    // au lieu de rendre le message d'IOS.
    const modeAvant = this.mode;
    try {
      const output: unknown = handler(session, parsed.args);
      if (typeof output !== 'string') return null;
      if (!parsed.negated && parsed.spec.enters !== undefined) {
        applyTransition(parsed.spec, parsed.args, session);
        this.adoptSocleSession(session);
      }
      const confine = this.confinerSousVue(modeAvant, parsed, cmdPart);
      return confine ?? output;
    } catch (err) {
      if (err instanceof CliInvalidInput) {
        if (err.motAbsent()) return renderCliDiagnostic('incomplete', { line: cmdPart });
        return renderCliDiagnostic('invalid', {
          line: cmdPart,
          tokenOffset: offsetForInvalidInput(cmdPart, CiscoShellBase.keywordCount(parsed.spec), err),
        });
      }
      if (err instanceof CliIncomplete) return renderCliDiagnostic('incomplete', { line: cmdPart });
      throw err;
    }
  }

  /**
   * Une commande venue de l'arbre GLOBAL ne deplace pas une session
   * confinee dans une vue d'analyseur.
   *
   * La regle vivait dans `tryGlobalConfigNavigation`, qui ne lit que le
   * trie : `interface Gi0/0` tapee sous `parser view NOC` y changeait de
   * mode, si bien que le `exit` suivant quittait l'interface et non la
   * vue, et la definition restait a moitie faite. Migrer `interface` au
   * socle rouvrait le trou, parce que le socle admet une commande de
   * `config` depuis un sous-mode par HERITAGE. La regle appartient a la
   * CLI et non a l'un des deux moteurs : elle est donc posee ici aussi,
   * sur la meme condition — le mode a change, et la commande ne declare
   * pas la vue.
   */
  private confinerSousVue(
    modeAvant: string,
    parsed: { spec: { modes: readonly string[]; path: readonly unknown[] } },
    cmdPart: string,
  ): string | null {
    if (modeAvant !== 'config-view' || this.mode === modeAvant) return null;
    if (parsed.spec.modes.includes('config-view')) return null;

    this.mode = modeAvant;
    this.fsm.mode = modeAvant;
    return renderCliDiagnostic('invalid', {
      line: cmdPart,
      tokenOffset: argumentOffset(cmdPart, CiscoShellBase.keywordCount(parsed.spec), 0),
    });
  }

  private adoptSocleSession(session: CliSession): void {
    if (session.mode !== this.mode) {
      this.mode = session.mode;
      this.fsm.mode = session.mode;
    }
    Object.assign(this.socleFields, session.fields);
  }

  protected executeOnTrie(cmdPart: string): string {
    // `undebug X` EST `no debug X`, donc la reecriture precede les deux
    // moteurs. Placee apres le socle, elle laissait `undebug` chercher
    // dans un trie dont la famille venait d'etre elaguee.
    const asNoDebug = CiscoShellBase.undebugAsNoDebug(cmdPart);
    if (asNoDebug !== null) cmdPart = asNoDebug;

    const migrated = this.tryMigratedCommand(cmdPart);
    if (migrated !== null) return migrated;
    // UNE seule question, posee a UN seul endroit : cette session
    // voit-elle cette commande ? Cinq predicats y repondaient a la
    // suite, chacun relisant la table des regles a sa facon ; leur ordre
    // d'appel etait la vraie specification, et deux modes entiers
    // (configuration, vues en configuration) n'etaient consultes par
    // aucun. `CliAuthorization` porte la regle, et l'aide comme la
    // completion posent desormais la meme.
    // Une commande que ce mode ne connait dans AUCUN arbre n'est pas
    // jugee par le niveau : elle est inconnue, et IOS la traite alors
    // comme un nom d'hote a joindre. La confondre avec un refus ferait
    // repondre le caret la ou une vraie machine tente une resolution.
    const defaut = this.niveauParDefautDe(cmdPart);
    if (defaut !== null && this.autorisation().authorize({
      principal: this.mandataire(),
      scope: scopeForMode(this.mode),
      command: cmdPart,
      defaultLevel: defaut,
    }) === 'absent') {
      return CISCO_ERRORS.INVALID_INPUT;
    }

    // Une commande DESCENDUE jusqu'a une session en mode utilisateur vit
    // dans l'arbre privilegie : c'est le seul qui porte son analyse et
    // son comportement complets. L'autorisation a deja tranche ; il ne
    // reste ici qu'un choix d'arbre.
    if (this.mode === 'user' && defaut !== null && this.autorisation().estAccordee({
      principal: this.mandataire(),
      scope: 'exec',
      command: cmdPart,
      defaultLevel: defaut,
    })) {
      const accordee = this.executeSurTriePrivilegie(cmdPart);
      if (accordee !== null) return accordee;
    }

    const trie = this.getActiveTrie();
    const result = trie.match(cmdPart);

    const keywordCount = result.matchedKeywords.length;

    switch (result.status) {
      case 'ok': {
        if (!result.node?.action) return '';
        let output: string;
        try {
          output = result.node.action(result.args, cmdPart);
        } catch (err) {
          if (this.isControlFlowError(err)) throw err;
          if (err instanceof CliInvalidInput) {
            if (err.motAbsent()) return renderCliDiagnostic('incomplete', { line: cmdPart });
            return renderCliDiagnostic('invalid', {
              line: cmdPart,
              tokenOffset: offsetForInvalidInput(cmdPart, keywordCount, err),
            });
          }
          if (err instanceof CliIncomplete) {
            return renderCliDiagnostic('incomplete', { line: cmdPart });
          }
          // Anything else is a bug in a handler, and it must not reach the
          // terminal: an exception surfacing as `% Error: ReferenceError…`
          // also aborts the command mid-way, so the shell stays in whatever
          // mode the handler was leaving — the next pasted lines are then
          // interpreted in the wrong mode and the whole paste derails. IOS
          // answers an unusable command with the caret; do that, and leave
          // the trace where a developer looks for it.
          this.reportHandlerCrash(cmdPart, err);
          // `argumentOffset`, pas `offsetForInvalidInput` : ce dernier
          // veut un CliInvalidInput pour lire son `token`/`argIndex`, et
          // il n'y en a pas ici — l'appeler sans lui faisait planter le
          // filet lui-même, ce qui remplaçait une exception par une autre.
          return renderCliDiagnostic('invalid', {
            line: cmdPart,
            tokenOffset: argumentOffset(cmdPart, keywordCount, 0),
          });
        }
        return this.attachCaretIfBare(output, cmdPart, keywordCount);
      }
      case 'ambiguous':
        return renderCliDiagnostic('ambiguous', { line: cmdPart });
      case 'incomplete':
        return renderCliDiagnostic('incomplete', { line: cmdPart });
      case 'invalid': {
        const nav = result.refusePar === 'argument'
          ? null : this.tryGlobalConfigNavigation(cmdPart);
        if (nav !== null) return nav;
        const unknownExec = this.unknownExecCommand(cmdPart, result.errorPos);
        return unknownExec ?? (result.error || CISCO_ERRORS.INVALID_INPUT);
      }
      default: {
        const nav = this.tryGlobalConfigNavigation(cmdPart);
        return nav !== null ? nav : CISCO_ERRORS.INVALID_INPUT;
      }
    }
  }

  private attachCaretIfBare(output: string, line: string, keywordCount: number): string {
    if (output !== INVALID_INPUT_MESSAGE) return output;
    return renderCliDiagnostic('invalid', {
      line,
      tokenOffset: argumentOffset(line, keywordCount),
    });
  }

  private unknownExecCommand(line: string, errorPos: number | undefined): string | null {
    if (this.mode !== 'user' && this.mode !== 'privileged') return null;
    const spans = tokenSpans(line);
    const first = spans[0];
    if (!first || errorPos !== first.offset) return null;
    if (this.privilegedTrie.getCompletions(first.text).length > 0) return null;
    // Un premier mot que le SOCLE connait n'est pas un nom d'hote : sans
    // cette question, `erase zorglub` partait en resolution de nom le
    // jour ou `erase` a quitte le trie.
    if (this.niveauDeclareParLeSocle(first.text) !== null) return null;
    return renderCliDiagnostic('unknown-exec', { line, token: first.text });
  }

  // ─── FSM Transitions ───────────────────────────────────────────

  protected configSessionLabel = 'console';

  protected announceConfigExit(wasConfig: boolean): void {
    if (!wasConfig || this.isConfigMode()) return;
    const device = this.configExitLogTarget as {
      _loggingConfig?: LoggingConfig;
      getLoggingConfig?: () => LoggingConfig | undefined;
    } | null;
    const target = device?._loggingConfig ?? device?.getLoggingConfig?.() ?? this.logging;
    target.append('notifications', 'sys',
      `Configured from console by ${this.configSessionLabel}${this.suffixeLigneConfig()}`,
      true, 'CONFIG_I');
    (this.configExitLogTarget as { _noteConfigChange?: (u: string) => void } | null)
      ?._noteConfigChange?.(this.configSessionLabel);
  }

  /**
   * ` on vty0 (10.0.0.5)` — le suffixe qu'IOS ajoute quand la
   * configuration ne vient PAS de la console, et le seul moyen pour un
   * auditeur de savoir d'ou elle vient. Il etait omis parce que le
   * numero de ligne vivait hors de portee ; le registre porte desormais
   * la ligne ET le transport, donc la question a une reponse.
   *
   * Une session console n'en recoit aucun : `by console` dit deja tout,
   * et ajouter ` on con0` decrirait une machine qui n'ecrit pas cela.
   */
  protected suffixeLigneConfig(): string {
    if (this.configSessionLabel === 'console') return '';
    const reg = ((this.configExitLogTarget ?? this.deviceRef) as unknown as {
      getSshSessionRegistry?: () => {
        list(): ReadonlyArray<{
          user: string; lineKind: string; lineIndex: number; fromIp: string;
        }>;
      };
    })?.getSshSessionRegistry?.();
    const s = reg?.list().find(x => x.user === this.configSessionLabel && x.lineKind === 'vty');
    if (!s) return '';
    return ` on vty${s.lineIndex}${s.fromIp ? ` (${s.fromIp})` : ''}`;
  }

  protected configExitLogTarget: unknown = null;

  /**
   * Le registre des sessions, quand la plateforme en a un. Un
   * commutateur n'en a pas — il n'a pas de pile TCP — et rend donc la
   * console seule, ce qui est la verite et non un repli.
   */
  protected dnsCommandContext(): DnsCommandContext {
    return {
      config: () => (this.deviceRef as unknown as {
        _getDnsConfig?: () => CiscoDnsConfig;
      } | null)?._getDnsConfig?.() ?? null,
      hosts: () => (this.deviceRef as unknown as {
        _getHostsTable?: () => RouterHostsTable;
      } | null)?._getHostsTable?.() ?? null,
      afterApply: () => { this.syncDnsService(); },
    };
  }

  protected syncDnsService(): void {
    (this.deviceRef as unknown as { _syncDnsService?: () => void } | null)?._syncDnsService?.();
  }

  protected sshKnownHosts(): { renderCisco: () => string } {
    return (this.d() as unknown as {
      _getSshKnownHosts?: () => { renderCisco: () => string };
    })._getSshKnownHosts?.() ?? { renderCisco: () => '' };
  }

  protected registreSessions(): { formatShowUsers: () => string } | null {
    return (this.d() as unknown as {
      getSshSessionRegistry?: () => { formatShowUsers: () => string } | null;
    }).getSshSessionRegistry?.() ?? null;
  }

  /**
   * `archive log config` — retient la commande de configuration qui
   * vient d'être tapée, et l'annonce en syslog
   * (`docs/PRD-Pistes-Audit-Cisco.md` §3).
   *
   * C'est la seule trace de « qui a tapé quoi » qui n'exige AUCUN
   * serveur : elle vit sur la machine, et c'est ce qui la rend utilisable
   * dans un laboratoire comme dans un réseau dont le TACACS+ est tombé.
   * Le sous-mode était accepté, ses réglages rangés — et rien n'était
   * jamais retenu ni annoncé.
   *
   * On journalise sur le mode d'AVANT la commande, ce qui est ce que
   * fait IOS : `configure terminal` n'est pas une commande de
   * configuration (on n'y est pas encore), tandis qu'`interface Gi0/0`
   * en est une bien qu'elle change de mode.
   */
  private journaliserCommandeDeConfig(modeAvant: string, commande: string, sortie: string): void {
    if (!modeAvant.startsWith('config')) return;
    // Une commande refusée n'a rien changé : la retenir ferait lire au
    // journal d'audit une modification qui n'a pas eu lieu.
    if (/^%|Invalid input|Incomplete command/m.test(sortie)) return;
    const service = this.archiveService();
    if (!service) return;
    const record = service.logCommand(
      this.configSessionLabel, this.configSessionLabel === 'console' ? 'console' : 'vty0',
      commande, Date.now());
    if (!record) return;
    if (service.getConfigLogger().notifySyslogContent === undefined) return;
    const device = this.configExitLogTarget as {
      _loggingConfig?: LoggingConfig;
      getLoggingConfig?: () => LoggingConfig | undefined;
    } | null;
    const cible = device?._loggingConfig ?? device?.getLoggingConfig?.() ?? this.logging;
    cible.append('notifications', 'parser',
      `User:${record.user} logged command:${record.command}`, true, 'CFGLOG_LOGGEDCMD');
  }

  /**
   * `aaa accounting commands <niveau>` — envoie la commande au collecteur
   * (`docs/PRD-Pistes-Audit-Cisco.md` §5).
   *
   * L'émission est délibérément « au fil de l'eau » et non attendue : un
   * opérateur ne doit pas voir sa CLI se figer parce qu'un serveur
   * TACACS+ est lent, et c'est ce que fait `start-stop` sur une vraie
   * machine — `wait-start`, qui bloque, n'est pas modélisé ici.
   *
   * Une commande refusée n'est pas comptabilisée, pour la même raison
   * qu'elle n'entre pas au journal : elle n'a rien changé.
   */
  private comptabiliserCommande(commande: string, sortie: string): void {
    if (/^%|Invalid input|Incomplete command/m.test(sortie)) return;
    const texte = commande.trim();
    if (texte.length === 0) return;
    const dev = this.d() as unknown as { getAaaAuthenticator?: () => AaaAuthenticator };
    const authenticator = dev.getAaaAuthenticator?.();
    if (!authenticator) return;
    const niveau = this.mode === 'user' ? 1 : 15;
    void authenticator.accountCommand(this.configSessionLabel, texte, niveau)
      .catch(() => undefined);
  }

  /**
   * `exit` — et la confusion la plus repandue de tout IOS.
   *
   * Depuis un mode de CONFIGURATION, `exit` remonte d'un cran. Depuis un
   * mode EXEC — utilisateur comme privilegie — il TERMINE LA SESSION,
   * exactement comme `logout`. Ce n'est pas `exit` qui fait redescendre
   * de `#` a `>`, c'est `disable`, et lui seul.
   *
   * Le mode utilisateur fermait bien, le mode privilegie ne faisait
   * RIEN : la commande rendait la main sans un mot et laissait la
   * session au niveau 15. Un operateur qui tape `exit` en croyant avoir
   * quitte les droits d'administration les gardait — et le terminal, ne
   * recevant aucune annonce, gardait l'onglet ouvert.
   */
  /**
   * La session est finie : la SUIVANTE recommence au niveau de la ligne,
   * pas la ou celle-ci s'est arretee.
   *
   * Les TROIS champs comptent, et le niveau est le moins evident :
   * `show privilege` et `modeDeRetour` lisent `currentPrivilegeLevel` et
   * non `mode`, donc ne poser que le mode laissait la session a 15 et le
   * mode y revenait tout seul — `exit` rendait alors les droits
   * d'administration a la premiere frappe suivante. C'est le meme couple
   * que `disable` remet a zero.
   */
  /**
   * L'historique appartient a la SESSION EXEC : IOS documente `show
   * history` comme rendant les commandes de la session courante. Le
   * tampon vivait sur le shell, or la console n'a qu'un shell pour toute
   * la vie de la machine — donc l'operateur suivant relisait les
   * commandes du precedent, y compris ce qu'il avait tape avant de se
   * faire refuser un mot de passe.
   */
  /**
   * Ouvrir une session EXEC au nom d'un compte, a SON niveau.
   *
   * Elle ne vivait que sur `CiscoIOSShell`, donc sur le routeur seul :
   * `Switch.loginAs` authentifiait correctement, lisait le bon niveau
   * dans le magasin, appelait `beginExecSession?.()` — et l'appel
   * optionnel ne trouvait rien. Un responsable declare au niveau 15
   * ouvrait donc au niveau 1 sur un commutateur, ce qui rendait TOUTE la
   * delegation par compte decorative sur cette plateforme. Le niveau 15
   * est deja en EXEC privilegie sur un vrai IOS ; en dessous on ouvre en
   * EXEC utilisateur, et le niveau voyage avec le mode — poser l'un sans
   * l'autre faisait se contredire `show privilege` et l'invite de la
   * meme session.
   */
  beginExecSession(level: number, user?: string, view?: string | null): void {
    this.currentPrivilegeLevel = level;
    this.mode = (level >= 15 || view) ? 'privileged' : 'user';
    this.fsm.mode = this.mode;
    // `username X view NOC` attache un ROLE au compte : la session doit
    // s'ouvrir DANS cette vue. Le champ etait range sur le compte, rendu
    // dans la configuration, et lu par personne a la connexion — le lien
    // entre un compte et son role n'existait donc qu'a l'ecrit.
    this.activeParserView = view ?? null;
    if (user) this.configSessionLabel = user;
    this.cmdHistory = [];
    this.terminalHistorySize = this.tailleHistoriqueDeLigne();
    this.terminalHistoryEnabled = this.terminalHistorySize > 0;
  }

  protected fermerSessionExec(): string {
    this.terminalMonitor = false;
    this.currentPrivilegeLevel = 1;
    // La vue est un ROLE porte par la session, pas par la machine :
    // la laisser en place enfermait l'operateur suivant dans le role du
    // precedent, sans qu'il puisse meme demander lequel.
    this.activeParserView = null;
    this.mode = 'user';
    this.fsm.mode = 'user';
    this.clearSocleFields(Object.keys(this.socleFields));
    this.cmdHistory = [];
    // `terminal history size` ne vaut que pour la session : la suivante
    // repart du reglage de la LIGNE, sans quoi un `terminal` tape une
    // fois gouvernait la machine pour toujours.
    this.terminalHistorySize = this.tailleHistoriqueDeLigne();
    this.terminalHistoryEnabled = this.terminalHistorySize > 0;
    return 'Connection closed.';
  }

  protected cmdExit(): string {
    if (this.mode === 'user' || this.mode === 'privileged') return this.fermerSessionExec();
    const wasConfig = this.isConfigMode();
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.exit();
    this.mode = this.modeDeRetour(newMode);
    this.clearFields(fieldsToCllear);
    this.clearSocleFields(fieldsToCllear);
    this.announceConfigExit(wasConfig);
    return '';
  }

  protected cmdEnd(): string {
    const wasConfig = this.isConfigMode();
    this.fsm.mode = this.mode;
    const { newMode, fieldsToCllear } = this.fsm.end();
    this.mode = this.modeDeRetour(newMode);
    this.clearFields(fieldsToCllear);
    this.clearSocleFields(fieldsToCllear);
    this.announceConfigExit(wasConfig);
    return '';
  }

  /**
   * Le mode ou l'on RETOMBE en quittant la configuration.
   *
   * La machine a etats remonte toujours vers `privileged`, parce qu'elle
   * ne connait que la hierarchie des modes et pas le niveau de la
   * session. C'etait une ESCALADE DE PRIVILEGE : une session montee a
   * `enable 10` a le droit d'entrer en configuration (si l'operateur le
   * lui a donne), et son `end` la deposait en mode privilegie complet —
   * `reload` et `write memory`, reserves au niveau 15, passaient alors,
   * pendant que `show privilege` continuait d'annoncer 10. Le mode et le
   * niveau se contredisaient sur la meme session au meme instant, et
   * c'est le mode qui decidait.
   *
   * Un niveau intermediaire reste en mode `user` — c'est deja la regle
   * qu'`enable N` applique. L'invite, elle, affiche `#` des le niveau 2
   * (`Device> enable 7` puis `Device# show privilege` dans le guide de
   * securite d'IOS 15MT) : c'est un RENDU, pas le mode de dispatch, et
   * `buildDevicePrompt` est le seul endroit qui en decide.
   */
  protected modeDeRetour(modeCalcule: CLIMode): CLIMode {
    if (modeCalcule !== 'privileged') return modeCalcule;
    return this.currentPrivilegeLevel >= 15 ? 'privileged' : 'user';
  }

  protected isConfigMode(): boolean {
    return this.mode !== 'user' && this.mode !== 'privileged';
  }

  protected isAclSubMode(): boolean {
    return this.mode === 'config-std-nacl'
      || this.mode === 'config-ext-nacl'
      || this.mode === 'config-ipv6-nacl';
  }

  private static readonly IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;

  private static readonly MONTH_MAP: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };

  /**
   * `clock set 10:30:00 3 June 2026` — rend l'instant en millisecondes,
   * ou le message de refus d'IOS.
   *
   * Le seuil était `args.length < 5` alors que la forme normale d'IOS en
   * compte QUATRE (`hh:mm:ss <jour> <Mois> <année>`) : mesuré, la
   * commande était acceptée et ne posait rien, et ne marchait qu'avec un
   * cinquième mot parasite. Un `clock set` qui rend la main sans rien
   * changer est pire qu'un refus.
   *
   * IOS accepte aussi les deux ordres (`<jour> <Mois> <année>` et
   * `<Mois> <jour> <année>`) et abrège les mois sur trois lettres ; les
   * deux sont acceptés ici pour la raison qui les fait accepter sur un
   * vrai routeur — c'est ce que les gens tapent.
   */
  protected parseClockSetArgs(args: string[]): number | string {
    if (args.length < 4) return '% Incomplete command.';
    const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(args[0]);
    if (!hm) return CISCO_ERRORS.INVALID_INPUT;
    const [h, mn, sec] = [+hm[1], +hm[2], hm[3] ? +hm[3] : 0];
    if (h > 23 || mn > 59 || sec > 59) return CISCO_ERRORS.INVALID_INPUT;

    const moisDe = (mot: string): number => {
      const bas = (mot ?? '').toLowerCase();
      if (!bas) return 0;
      const nom = Object.keys(CiscoShellBase.MONTH_MAP).find((m) => m.startsWith(bas));
      return nom ? CiscoShellBase.MONTH_MAP[nom] : 0;
    };

    let jour = parseInt(args[1], 10);
    let mois = moisDe(args[2]);
    const annee = parseInt(args[3], 10);
    if (isNaN(jour) || !mois) {
      // L'autre ordre : `clock set 10:30:00 June 3 2026`.
      mois = moisDe(args[1]);
      jour = parseInt(args[2], 10);
    }
    if (!mois || isNaN(jour) || isNaN(annee)) return CISCO_ERRORS.INVALID_INPUT;
    if (jour < 1 || jour > 31 || annee < 1993 || annee > 2035) {
      return CISCO_ERRORS.INVALID_INPUT;
    }
    return Date.UTC(annee, mois - 1, jour, h, mn, sec);
  }

  /** Le seul point qui pose l'horloge, partagé par les deux modes. */
  protected applyClockSet(args: string[]): string {
    const q = this.parseClockSetArgs(args);
    if (typeof q === 'string') return q;
    const dev = this.d() as unknown as { _setSystemClock?: (ms: number) => void };
    dev._setSystemClock?.(q);
    return '';
  }

  /**
   * Ce que fait une commande `ntp …`, une fois son mot-cle retrouve.
   *
   * Le corps est partage par toutes les sous-commandes declarees dans
   * l'arbre : un analyseur par mot-cle finirait par diverger sur ce que
   * `ntp server` et `ntp peer` ont en commun.
   */
  private appliquerNtp(args: string[]): string {
      const a = args.map(s => s.toLowerCase());
      if (!a[0]) return CISCO_ERRORS.INCOMPLETE;
      if ((a[0] === 'server' || a[0] === 'peer') && !a[1]) return CISCO_ERRORS.INCOMPLETE;
      const agent = getNtpAgent(this.d());
      if (!agent) return '';
      if (a[0] === 'server' && a[1]) {
        const target = a[1];
        const resolved = this.resolveNtpTarget(target);
        if (!resolved) {
          return `Translating "${args[1]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
        }
        agent.addServer(resolved, a.includes('prefer'), this.parseNtpKeyId(a));
      } else if (a[0] === 'peer' && a[1]) {
        const resolved = this.resolveNtpTarget(a[1]);
        if (!resolved) {
          return `Translating "${args[1]}"...domain server (255.255.255.255)\n% Bad IP address or host name`;
        }
        agent.addPeer(resolved, a.includes('prefer'), this.parseNtpKeyId(a));
      } else if (a[0] === 'master') {
        agent.setServerMode(true);
        if (a[1] && /^\d+$/.test(a[1])) agent.setLocalStratum(parseInt(a[1], 10));
      } else if (a[0] === 'source' && a[1]) {
        // `args` et non `a` : un nom d'interface et un mot de passe sont
        // des DONNEES, pas des mots-cles. La ligne du dessus met toute la
        // commande en minuscules pour comparer, et ce qui en sortait
        // etait rangé tel quel -- `Loopback0` devenait `loopback0`, et
        // `ClefNTP2024Secret` devenait `clefntp2024secret`, donc une
        // AUTRE clé. Une configuration relue ne refaisait pas la machine.
        agent.setSourceInterface(args[1]);
      } else if (a[0] === 'authenticate') {
        agent.setAuthenticate(true);
      } else if (a[0] === 'authentication-key' && a[1] && a[2] === 'md5' && args[3]) {
        agent.addAuthKey(parseInt(a[1], 10), 'md5', args[3]);
      } else if (a[0] === 'trusted-key' && a[1]) {
        agent.addTrustedKey(parseInt(a[1], 10));
      } else if (a[0] === 'access-group' && a[1] && a[2]) {
        // IOS ne connait QUE ces quatre familles. Le tutoriel ecrit
        // `ntp access-group nomodify 10`, qui est la syntaxe de `ntpd`
        // et de `chrony` : l'accepter apprendrait une commande que la
        // vraie machine refuse (lot N6).
        if (!estGenreAcces(a[1])) return CISCO_ERRORS.INVALID_INPUT;
        agent.setAccessGroup(a[1], a[2]);
      } else if (a[0] === 'logging') {
        agent.setLogging(true, 'ntp');
      } else if (a[0] === 'update-calendar') {
        agent.setUpdateCalendar(true);
      } else if (a[0] === 'allow' && a[1] === 'mode' && a[2] === 'control') {
        agent.setAllowModeControl(true);
      }
      return '';
  }

  /** Ce qu'une forme `no ntp …` retire. */
  private retirerNtp(args: string[]): string {
      const a = args.map(s => s.toLowerCase());
      const agent = getNtpAgent(this.d());
      if (!agent) return '';
      if ((a[0] === 'server' || a[0] === 'peer') && a[1]) agent.removeServer(a[1]);
      else if (a[0] === 'master') { agent.setServerMode(false); agent.setLocalStratum(16); }
      else if (a[0] === 'authenticate') agent.setAuthenticate(false);
      else if (a[0] === 'authentication-key' && a[1]) agent.removeAuthKey(parseInt(a[1], 10));
      else if (a[0] === 'trusted-key' && a[1]) agent.removeTrustedKey(parseInt(a[1], 10));
      else if (a[0] === 'access-group' && a[1]) agent.removeAccessGroup(a[1]);
      else if (a[0] === 'source') agent.setSourceInterface('');
      else if (a[0] === 'logging') agent.setLogging(false);
      else if (a[0] === 'update-calendar') agent.setUpdateCalendar(false);
      // Le durcissement du §9 : fermer le mode 6, celui de `monlist`.
      else if (a[0] === 'allow' && a[1] === 'mode' && a[2] === 'control') {
        agent.setAllowModeControl(false);
      }
      return '';
  }

  protected resolveNtpTarget(target: string): string | null {
    if (CiscoShellBase.IPV4_RE.test(target)) return target;
    const dev = this.d() as unknown as { _getHostsTable?: () => { resolve?: (n: string) => string | null } };
    const fromHosts = dev._getHostsTable?.().resolve?.(target);
    if (fromHosts && CiscoShellBase.IPV4_RE.test(fromHosts)) return fromHosts;
    return null;
  }

  protected parseNtpKeyId(args: string[]): number | undefined {
    const idx = args.indexOf('key');
    if (idx < 0 || !args[idx + 1] || !/^\d+$/.test(args[idx + 1])) return undefined;
    return parseInt(args[idx + 1], 10);
  }

  // ─── Help / Tab-Complete ────────────────────────────────────────

  /**
   * `exit`, `end`, `help`, `do` et `default` ne sont enregistrés dans
   * AUCUN arbre : ils sont traités par le shell, avant l'arbre, parce
   * qu'ils existent dans tous les modes. C'est précisément pour cela
   * qu'aucun `?` ne les listait — l'aide ne lit que l'arbre.
   *
   * Cette liste est le point unique : le répartiteur l'applique, l'aide
   * la rend, et un mot-clé ne peut donc plus être exécutable sans être
   * proposé (ni l'inverse).
   */
  /**
   * Tous les arbres que ce shell porte, nommes comme la table des
   * continuations les nomme (`configIfTrie` -> `configIf`).
   *
   * Releve sur l'objet plutot qu'ecrit a la main : le routeur en porte
   * cinquante-deux et le commutateur seize, et en nommer cinq — ce que
   * faisait le premier jet — privait quarante-sept modes de leurs
   * suites, sans que rien ne le dise.
   */
  protected tousLesArbres(): Record<string, CommandTrie | undefined> {
    const out: Record<string, CommandTrie | undefined> = {};
    for (const cle of Object.keys(this) as Array<keyof this>) {
      const valeur = this[cle];
      if (valeur instanceof CommandTrie) out[String(cle).replace(/Trie$/, '')] = valeur;
    }
    return out;
  }

  protected universalCommands(): Array<{ keyword: string; description: string }> {
    // `end` n'existe QUE dans les modes de configuration : il n'y a rien
    // à terminer depuis un EXEC, et IOS ne le propose pas là.
    const out = [
      { keyword: 'exit', description: 'Exit from the EXEC' },
      { keyword: 'help', description: 'Description of the interactive help system' },
    ];
    if (this.isConfigMode()) {
      out.push({ keyword: 'end', description: 'Exit from configure mode' });
      out.push({ keyword: 'default', description: 'Set a command to its defaults' });
      out.push({ keyword: 'do', description: 'To run exec commands in config mode' });
      out[0].description = this.mode === 'config'
        ? 'Exit from configure mode' : 'Exit from this submode';
    }
    return out.sort((a, b) => a.keyword.localeCompare(b.keyword));
  }

  /**
   * `| redirect`, `| append` et `| tee` ÉCRIVENT. Ils étaient acceptés
   * et ne créaient aucun fichier : la sortie partait au terminal comme
   * si le modificateur n'avait pas été tapé, et `dir flash:` ne montrait
   * rien de nouveau. Une commande qui promet d'écrire doit écrire.
   *
   * L'écriture est faite ICI et pas dans `applyPipeFilter`, parce que
   * seul le shell tient le système de fichiers de l'équipement — le
   * même objet que `dir` et `more` lisent, pas une copie.
   */
  private runPipeWriter(cmdPart: string, filter: PipeFilter, device: TDevice): string {
    const cible = filter.pattern.trim();
    if (!cible) return CISCO_ERRORS.INCOMPLETE;
    const nom = cible.replace(/^[a-z]+:\/?/i, '');
    if (!nom) return `%Error opening ${cible} (No such file or directory)`;

    this.deviceRef = device;
    const fs = this.fs();
    const sortie = this.executeOnTrie(cmdPart);
    this.deviceRef = null;

    const ancien = filter.type === 'append' ? (fs.get(nom)?.content ?? '') : '';
    const contenu = ancien ? `${ancien}\n${sortie}` : sortie;
    if (contenu.length - ancien.length > fs.freeBytes()) {
      return `%Error opening ${cible} (No space left on device)`;
    }
    fs.write(nom, contenu);
    return filter.type === 'tee' ? `${sortie}\n${PIPE_WRITE_BANNER}` : PIPE_WRITE_BANNER;
  }

  /**
   * L'aide des commandes que le RÉPARTITEUR traite avant l'arbre.
   *
   * `exit`, `end`, `help`, `do` et `default` sont interceptées dans
   * `executeCommand` et n'ont donc aucun nœud — or l'aide ne lit que
   * l'arbre. Elles étaient offertes par la liste du mode et leur aide
   * propre répondait `% Invalid input` : cinq commandes annoncées et
   * indocumentables, dont `do`, dont l'aide est la seule façon de
   * découvrir qu'on peut lancer une commande EXEC sans quitter la
   * configuration.
   *
   * Ce que chacune rend est LU sur ce qu'elle fait, pas choisi : `do X`
   * s'exécute sur l'arbre privilégié, donc son aide est celle de cet
   * arbre ; `default X` s'exécute comme `no X`, donc son aide est celle
   * de `no`. Rendre autre chose serait décrire une commande différente
   * de celle qui s'exécutera.
   *
   * Rend `null` quand la ligne ne relève pas de cette famille, pour que
   * l'arbre reprenne la main sans rien savoir de tout ceci.
   */
  private aideDesCommandesUniverselles(input: string, device?: TDevice): string | null {
    const ligne = input.trim();
    const mots = ligne.split(/\s+/).filter((m) => m !== '');
    // Un mot SEUL non suivi d'un blanc est en cours de frappe : `do?`
    // demande « quelles commandes commencent par do », ce que l'arbre
    // sait faire. C'est à partir du blanc, ou d'un second mot, que la
    // question devient « que prend `do` ».
    if (mots.length < 2 && !input.endsWith(' ')) return null;
    const premier = mots[0]?.toLowerCase() ?? '';
    const reste = ligne.slice(premier.length).trim();
    const universelles = new Set(this.universalCommands().map((u) => u.keyword));
    if (!universelles.has(premier)) return null;

    const suffixe = input.endsWith(' ') ? ' ' : '';
    if (premier === 'do') {
      const savedMode = this.mode;
      this.mode = 'privileged';
      try { return this.getHelp(`${reste}${suffixe}`, device); }
      finally { this.mode = savedMode; }
    }
    if (premier === 'default') return this.getHelp(`no ${reste}${suffixe}`, device);
    // `exit`, `end` et `help` ne prennent aucun argument : IOS rend
    // `<cr>` et rien d'autre. Un mot derrière n'est plus cette commande.
    return reste === '' ? '  <cr>' : CISCO_ERRORS.UNRECOGNIZED_HELP;
  }

  protected sessionParamRanges(): SessionParamRanges | null { return null; }

  getHelp(input: string, device?: TDevice): string {
    // `show running-config | ?` n'était le nœud d'aucun arbre : le `|`
    // est retiré de la ligne avant l'analyse, donc l'aide répondait au
    // caret là où IOS liste ses modificateurs. Le cas est traité ici et
    // pas dans le répartiteur, pour que le terminal et `cliHelp` — les
    // deux portes de l'aide — ne puissent pas répondre différemment.
    const barre = input.lastIndexOf('|');
    if (barre >= 0) {
      const partiel = input.slice(barre + 1).trim().toLowerCase();
      const offerts = PIPE_MODIFIERS.filter((m) => m.keyword.startsWith(partiel));
      if (offerts.length === 0) return CISCO_ERRORS.UNRECOGNIZED_HELP;
      const large = Math.max(...offerts.map((m) => m.keyword.length));
      return offerts.map((m) => `  ${m.keyword.padEnd(large + 2)}${m.description}`).join('\n');
    }
    const aideUniverselle = this.aideDesCommandesUniverselles(input, device);
    if (aideUniverselle !== null) return aideUniverselle;
    const trie = this.getActiveTrie();
    trie.setDynamicResolver(device ? new EquipmentParamResolver(device, this.sessionParamRanges()) : null);
    try {
      const filtreNiveau = (ligne: string): boolean => {
        if (!device) return true;
        const precedent = this.deviceRef;
        this.deviceRef = device;
        try { return this.laSessionVoit(ligne); }
        finally { this.deviceRef = precedent; }
      };
      // La ligne a JUGER remplace le mot partiel en cours de frappe par
      // le mot-cle propose ; la concatener a l'entree brute donnait
      // `show ver version` pour `show ver?`, une ligne qu'aucun arbre ne
      // connait — donc non jugee, donc proposee, alors que son execution
      // etait refusee.
      const brut = input.trim();
      const surMotPartiel = brut.length > 0 && !input.endsWith(' ');
      const base = surMotPartiel ? brut.slice(0, brut.lastIndexOf(' ') + 1).trim() : brut;
      // Le socle passe EN PREMIER parce que sa description est DECLAREE
      // sur la commande, la ou celle du trie peut n'etre qu'un repli
      // generique laisse par un noeud d'aide : apres migration de
      // `ntp server`, le trie gardait un noeud decrivant ses arguments,
      // dont l'intitule etait le mot « Server » tire de la table des
      // descriptions par defaut — l'aide perdait « Configure NTP server ».
      const completions = this.socleSuggestions(input, 'QUESTION_MARK', device);
      for (const c of trie.getCompletions(input)
        .filter((c) => filtreNiveau(`${base} ${c.keyword}`.trim()))) {
        if (!completions.some((x) => x.keyword.toLowerCase() === c.keyword.toLowerCase())) {
          completions.push(c);
        }
      }
      for (const c of this.completionsAccordeesParNiveau(input, device)) {
        if (!completions.some((x) => x.keyword.toLowerCase() === c.keyword.toLowerCase())) {
          completions.push(c);
        }
      }
      ordonnerCommeIos(completions);
      // Seul le PREMIER rang d'un mode porte les commandes universelles :
      // elles ne sont pas des continuations de `show` ou de `ip`. Le mot
      // partiel compte comme premier rang — `do?` demande quelles
      // commandes commencent par `do`, et `do` est l'une d'elles.
      if (base === '') {
        const partiel = surMotPartiel ? brut.toLowerCase() : '';
        const deja = new Set(completions.map((c) => c.keyword.toLowerCase()));
        for (const u of this.universalCommands()) {
          if (!deja.has(u.keyword) && u.keyword.startsWith(partiel)) completions.push(u);
        }
        ordonnerCommeIos(completions);
      }
      if (completions.length === 0) {
        return CISCO_ERRORS.UNRECOGNIZED_HELP;
      }
      const maxKw = Math.max(...completions.map(c => c.keyword.length));
      return completions
        .map(c => (c.description
          ? `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`
          // Une description vide ne se rembourre pas : `<cr>` laissait
          // sinon la largeur de la colonne en blancs de fin de ligne.
          : `  ${c.keyword}`))
        .join('\n');
    } finally {
      trie.setDynamicResolver(null);
    }
  }

  /**
   * La tabulation ne complete pas ce que l'execution refuserait.
   *
   * `tabCandidates` filtrait deja, `tabComplete` non : la LISTE des
   * candidats respectait le niveau, et la completion d'un candidat
   * UNIQUE le contournait. Deux portes sur la meme question, une seule
   * gardee.
   *
   * `device` est optionnel parce que la CLI appelle parfois cette
   * methode sans equipement sous la main ; sans lui on ne peut rien
   * juger, et on rend alors la completion telle quelle plutot que de
   * refuser ce qu'on n'a pas su lire.
   */
  /**
   * Completer, c'est repondre a la MEME question que lister.
   *
   * Cette porte ne lisait que le trie, quand la liste des candidats lit
   * les deux moteurs : une commande MIGREE etait donc listee et jamais
   * completee — `show clo` avait un seul candidat, `show clock`, et Tab
   * ne faisait rien. Et sur deux candidats elle rendait le PREMIER, donc
   * `show cl` s'ecrivait `show class-map` alors que l'operateur n'avait
   * pas choisi : sur une vraie machine, Tab ecrit ce que les candidats
   * ont en COMMUN et s'arrete la.
   *
   * Elle derive desormais de `tabCandidates`, si bien que les deux ne
   * peuvent plus se contredire.
   */
  tabComplete(input: string, device?: TDevice): string | null {
    if (!device) return this.getActiveTrie().tabComplete(input);

    const candidats = this.tabCandidates(input, device);
    if (candidats.length === 0) return null;
    if (candidats.length === 1) return `${candidats[0]} `;

    const commun = CiscoShellBase.prefixeCommun(candidats);
    return commun.length > input.trimStart().length ? commun : null;
  }

  /**
   * Le plus long prefixe que tous les candidats partagent, coupe au
   * dernier mot ENTIER : completer au milieu d'un mot ecrirait une
   * commande qui n'existe pas.
   */
  private static prefixeCommun(lignes: readonly string[]): string {
    let commun = lignes[0];
    for (const ligne of lignes.slice(1)) {
      let taille = 0;
      while (taille < commun.length && taille < ligne.length
        && commun[taille].toLowerCase() === ligne[taille].toLowerCase()) taille++;
      commun = commun.slice(0, taille);
    }
    return commun;
  }

  tabCandidates(input: string, device: TDevice): string[] {
    const viaDo = this.doTabCandidates(input, device);
    if (viaDo !== null) return viaDo;
    const trie = this.getActiveTrie();
    trie.setDynamicResolver(new EquipmentParamResolver(device, this.sessionParamRanges()));
    try {
      const precedent = this.deviceRef;
      this.deviceRef = device;
      try {
        const base = this.withUniversalCandidates(input, trie.tabCandidates(input))
          .filter((c) => this.laSessionVoit(c));
        if (input.endsWith(' ')) return base.sort();
        const amont = this.amontCanonique(input);
        for (const { keyword } of this.socleSuggestions(input, 'TAB', device)) {
          const ligne = `${amont} ${keyword}`.trim();
          if (!base.includes(ligne)) base.push(ligne);
        }
        const prefixe = input.trim().toLowerCase();
        // Une commande DESCENDUE depuis l'arbre privilegie n'est pas
        // dans l'arbre utilisateur : la marche du trie ne peut pas la
        // trouver, d'ou cet ajout. Mais il passe par la MEME porte que
        // le reste — sans quoi une vue CLI, qui remplace l'arbre visible
        // au lieu de s'y ajouter, voyait la tabulation lui rendre une
        // commande qu'elle exclut et que l'execution refuse ensuite.
        for (const { cible } of this.reglesExecAccordees()) {
          if (!cible.startsWith(prefixe) || base.includes(cible)) continue;
          if (!this.laSessionVoit(cible)) continue;
          base.push(cible);
        }
        // Retri APRES les ajouts : les commandes universelles et celles
        // descendues par un niveau de privilege arrivent en queue, et
        // une liste triee a moitie ne se lit pas mieux qu'une liste non
        // triee.
        return base.sort();
      } finally {
        this.deviceRef = precedent;
      }
    } finally {
      trie.setDynamicResolver(null);
    }
  }

  /**
   * `do <commande>` se complète dans l'arbre EXEC, comme il s'y exécute.
   *
   * Le répartiteur bascule `this.mode` sur `privileged` le temps de la
   * sous-commande ; la complétion fait exactement la même bascule et
   * réutilise sa propre méthode, plutôt que d'aller lire le trie
   * privilégié à la main — ainsi les commandes universelles et le
   * résolveur dynamique s'appliquent après `do` comme avant, sans second
   * chemin à tenir à jour.
   *
   * Rend `null` quand la ligne ne commence pas par `do` : l'appelant
   * poursuit normalement. Rend `[]` pour `do ` seul, une espace finale ne
   * proposant jamais rien sur un vrai IOS.
   */
  private doTabCandidates(input: string, device: TDevice): string[] | null {
    if (!this.isConfigMode()) return null;
    const m = /^\s*do\s+(.*)$/i.exec(input);
    if (!m) return null;
    const reste = m[1];
    if (reste.trim().length === 0) return [];
    const modeSauve = this.mode;
    this.mode = 'privileged';
    try {
      return this.tabCandidates(reste, device).map((c) => `do ${c}`);
    } finally {
      this.mode = modeSauve;
    }
  }

  /**
   * Les commandes universelles complétées comme les autres.
   *
   * `exit`, `help`, et en configuration `end`, `do` et `default` vivent
   * dans {@link universalCommands} et non dans le trie — c'est ce qui
   * leur permet d'exister dans TOUS les modes sans être réenregistrées
   * quinze fois. L'aide les rendait donc, et la complétion les ignorait :
   * `ex` ne donnait rien là où `?` annonçait `exit`, dans chaque mode des
   * deux plateformes. Elles sont ajoutées ICI, à partir de la MÊME
   * méthode que l'aide, pour que les deux ne puissent pas diverger — une
   * seconde liste aurait recréé exactement l'écart qu'on ferme.
   *
   * Elles ne valent que pour le PREMIER mot de la ligne : `exit` n'est
   * pas une continuation de `show`, et `show ex` ne doit rien proposer.
   */
  private withUniversalCandidates(input: string, candidates: string[]): string[] {
    if (/\s/.test(input.trim()) || input.endsWith(' ')) return candidates;
    const partiel = input.trim().toLowerCase();
    if (partiel.length === 0) return candidates;
    const deja = new Set(candidates.map((c) => c.toLowerCase()));
    const out = [...candidates];
    for (const u of this.universalCommands()) {
      if (u.keyword.startsWith(partiel) && !deja.has(u.keyword)) out.push(u.keyword);
    }
    return out;
  }

  // ─── Prompt ─────────────────────────────────────────────────────

  getMode(): string { return this.mode; }

  protected buildDevicePrompt(device: TDevice): string {
    const mode = this.mode === 'user' && this.currentPrivilegeLevel >= 2 ? 'privileged' : this.mode;
    return buildPrompt(mode, device._getHostnameInternal(), this.getPromptMap());
  }

  // ─── Shared Command Registration ───────────────────────────────

  private registerOutgoingSessionCommands(trie: CommandTrie): void {
    trie.register('where', 'List open outgoing connections', () => renderSessions(this.outgoingSessions));
    trie.registerGreedy('disconnect', 'Close an outgoing connection', (args) => {
      if (!args[0]) {
        const last = this.outgoingSessions.list().slice(-1)[0];
        if (!last) return '% No connections open';
        this.outgoingSessions.close(last.conn);
        return '';
      }
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n) || !this.outgoingSessions.get(n)) return '% No information for this connection';
      const cible = this.outgoingSessions.get(n)!;
      this.outgoingSessions.close(n);
      return `Closing connection to ${cible.host} [confirm]`;
    });
    trie.registerGreedy('resume', 'Resume an outgoing connection', (args) => {
      const list = this.outgoingSessions.list();
      const n = args[0] ? parseInt(args[0], 10) : (list.slice(-1)[0]?.conn ?? NaN);
      const s = this.outgoingSessions.get(n);
      if (!s) return '% No connection open';
      this.outgoingSessions.touch(n);
      return `[Resuming connection ${n} to ${s.host} ... ]`;
    });
    trie.registerGreedy('ssh', 'Open an SSH connection to a remote host',
      (args) => this.runOutboundSshClient(args));
    trie.registerGreedy('telnet', 'Open a Telnet session',
      (args) => this.runOutboundTelnet(args));
  }

  /** IOS show/util commands common to every Cisco device + mode (DRY). */
  private registerCommonShowCommands(target: CommandTrie, scope: ExecScope = 'privileged'): void {
    const trie = scopedTrie(target, scope);
    // `show who` est le SYNONYME historique de `show users` sur IOS, et
    // la sequence de collecte de preuves d'un auditeur les enchaine.
    // Elle repondait `% Invalid input`. Le rendu est le meme parce que
    // c'est la meme question : deux textes pour une question feraient
    // douter de la machine.
    this.registerOutgoingSessionCommands(target);
    trie.registerGreedy('show interfaces counters errors', 'Display interface error counters', () => {
      const rows = ['Port           Align-Err   FCS-Err  Xmit-Err   Rcv-Err UnderSize OutDiscards'];
      for (const name of this.d().getPortNames()) {
        const c = this.d().getPort(name)?.getCounters();
        const inErr = c?.errorsIn ?? 0;
        const outErr = c?.errorsOut ?? 0;
        rows.push(
          `${name.padEnd(15)}` +
          `${String(0).padStart(9)}${String(inErr).padStart(10)}` +
          `${String(outErr).padStart(10)}${String(inErr).padStart(10)}` +
          `${String(0).padStart(10)}${String(0).padStart(12)}`,
        );
      }
      return rows.join('\n');
    });
    this.registerFileSystemCommands(target);
    // La table des PAQUETS TECHNOLOGIQUES — celle que la machine imprime
    // au demarrage — n'avait aucune commande pour la relire : elle
    // defilait une fois et disparaissait. C'est une AUTRE table que
    // celle de `show license`, qui liste les licences par
    // fonctionnalite ; les confondre ferait croire qu'un routeur sans
    // `uc` n'a pas de ligne `uc`. Meme source que le demarrage.
    // `getMacTable` — minuscule — n'est défini sur AUCUN appareil : celui
    // que `Switch` porte s'appelle `getMACTable()`. Le lecteur rendait
    // donc `undefined`, et cette vue répondait « No entries » quoi que le
    // commutateur ait appris — y compris après un DORA et un ping
    // réussis, avec deux entrées bien présentes dans sa table. Exactement
    // le défaut de `_getRunningConfigText` décrit trois lignes plus bas,
    // dans ce même fichier.
    //
    // Pire : cette inscription MASQUAIT celle de `CiscoSwitchShell`, qui
    // est complète (filtres `dynamic`/`static`/`vlan`/`interface`, tri,
    // colonnes). Un commutateur avait donc une vue juste que personne
    // n'atteignait. Elle n'est désormais posée que si l'appareil n'en
    // fournit pas de meilleure.
    if (this.hasSwitchingHardware() && !this.providesOwnMacAddressTableView()) {
      trie.registerGreedy('show mac address-table', 'Display MAC address table', () =>
        ['Mac Address Table', '--------------------------------', 'No entries'].join('\n'));
    }
    // `_getRunningConfigText` n'est défini sur AUCUN appareil : il n'est
    // que lu, ici et à deux autres endroits. Mesuré avant correction,
    // `show running-config all` rendait donc « Building configuration... »
    // et rien d'autre, pendant que `show running-config` rendait ses 17
    // lignes sur la même machine. La méthode réellement portée par
    // `Router` comme par `Switch` est `getRunningConfig()`.
    // Un compteur qu'on ne peut pas remettre a zero ne sert qu'a moitie :
    // un diagnostic commence par effacer, provoquer, relire.
    trie.registerGreedy('terminal', 'Set terminal parameters', (args) =>
      this.handleTerminalCommand(args), [
      { keyword: 'length',  description: 'Set number of lines on a screen' },
      { keyword: 'width',   description: 'Set width of the display terminal' },
      { keyword: 'monitor', description: 'Copy debug output to the current terminal line' },
      { keyword: 'history', description: 'Enable and control the command history function' },
      { keyword: 'no',      description: 'Negate a command or set its defaults' },
    ]);

    // NOTE: `copy` is a privileged-EXEC command — it is registered once, with
    // full file-system semantics, in registerPrivilegedExtras (the rich
    // handler). Registering a simple stub here too (this method runs for both
    // the user and privileged tries) used to shadow it AND leak `copy` into
    // user EXEC; that has been removed.

    // Generic device-info show family — missing on BOTH the Cisco
    // router and switch, so it lives here in the shared base (DRY).
    // Un greedy sur `show ntp` AVALAIT toute sa queue : `show ntp
    // associations detail`, `show ntp authentication-keys`, `show ntp
    // config` et meme `show ntp packets` -- qui n'existe pas -- rendaient
    // tous le tableau des associations. Chaque sous-commande est
    // desormais un chemin reel, et ce que la plateforme n'a pas est
    // refuse comme IOS refuse (meme defaut que `display vrrp`, lot V15).
    // Refusee au lot N1 faute de compteurs : ils existent (lot N8).
    trie.registerGreedy('show ntp packets', 'NTP packet statistics', (a) => {
      if (a.length === 0) return showNtpPackets(this.cs());
      if (a[0].toLowerCase() !== 'mode') return CISCO_ERRORS.INVALID_INPUT;
      if (!a[1]) return CISCO_ERRORS.INCOMPLETE;
      return showNtpPackets(this.cs(), a[1]);
    }, [{ keyword: 'mode', description: 'Display packets by NTP mode' }]);
    // Pas de greedy de repli : sans lui, l'arbre lui-meme refuse
    // `show ntp packets` avec le curseur d'IOS, ce qu'un repli maison
    // ne saurait pas placer aussi bien.
    trie.registerGreedy('show cdp', 'Display CDP information', (a) =>
      showCdp(this.cs(), a.join(' '), this.configState.isEnabled('cdp')), [
      { keyword: 'neighbors', description: 'CDP neighbor entries' },
      { keyword: 'entry',     description: 'Information for specific neighbor entry' },
      { keyword: 'interface', description: 'CDP interface status and configuration' },
      { keyword: 'traffic',   description: 'CDP statistics' },
    ]);
    trie.registerGreedy('show lldp', 'Display LLDP information', (a) =>
      showLldp(this.cs(), a.join(' '), this.configState.isEnabled('lldp')), [
      { keyword: 'neighbors', description: 'LLDP neighbor entries' },
      { keyword: 'interface', description: 'LLDP interface status and configuration' },
    ]);
    trie.registerGreedy('show snmp', 'Display SNMP status', () => showSnmp(this.cs(), this.getChassisProfile()));
    /**
     * `show parser view [all]`.
     *
     * Sans argument : la vue COURANTE de cette session. Avec `all` : les
     * vues declarees sur l'equipement. Deux questions differentes, deux
     * reponses -- c'est le defaut qu'on vient de refermer sur `show aaa`.
     */
    trie.registerGreedy('show parser view', 'Display CLI view information', (args) => {
      const sec = getSecurityConfig(this.d());
      if (args.length === 0) {
        return `Current view is '${this.activeParserView ?? 'root'}'`;
      }
      if (args[0].toLowerCase() !== 'all') throw new CliInvalidInput({ token: args[0] });
      if (sec.parserViews.size === 0) return 'No views are configured';
      // L'etoile est la SEULE information que cette vue apporte de plus
      // que la configuration : laquelle des vues declarees est une
      // supervue. Sans elle et sans sa legende, la commande recopie une
      // liste de noms.
      const lignes = ['Views/SuperViews Present in System:'];
      for (const v of sec.parserViews.values()) {
        lignes.push(v.superview ? `${v.name} *` : v.name);
      }
      lignes.push('-------(*) represent superview-------');
      return lignes.join('\n');
    });
    // Le nœud intermédiaire porte sa description, APRÈS l'enregistrement
    // qui le crée : `describeNode` sort en silence sur un nœud absent.
    trie.describeNode('show parser', 'Display parser information');

    /*
     * `show ip http server status` et `... all` LISENT le service, elles
     * ne récitent pas un texte : le port, la méthode d'authentification
     * et les limites affichées sont ceux que la machine applique. Sur
     * IOS, `all` est la réunion des vues de la famille ; ici les deux
     * autres (`connection`, `session-module`) n'ont pas de matière —
     * aucune connexion n'est retenue, aucun module n'est déclaré — donc
     * `all` rend l'état et le dit, plutôt que d'inventer deux tableaux.
     */
    trie.registerGreedy('show hosts', 'Display host cache', () => showHosts(this.d() as unknown as Parameters<typeof showHosts>[0]));
    registerCiscoDnsExecCommands(target, this.dnsCommandContext());
    trie.registerGreedy('show ip dns statistics', 'Display DNS server statistics', () =>
      showIpDnsStatistics(this.d() as unknown as Parameters<typeof showIpDnsStatistics>[0]));
    trie.registerGreedy('show ip vrf', 'Display VRFs', (args) => {
      const sub = args[0]?.toLowerCase();
      if (sub === 'detail') return showVrfDetail(this.d(), args[1]);
      if (sub === 'interfaces') return showVrfInterfaces(this.d());
      return showVrf(this.d());
    }, [
      { keyword: 'detail', description: 'Detailed VRF information' },
      { keyword: 'interfaces', description: 'Interfaces bound to a VRF' },
    ]);
    trie.registerGreedy('show vrf', 'Display VRFs', (args) => {
      const sub = args[0]?.toLowerCase();
      if (sub === 'detail') return showVrfDetail(this.d(), args[1]);
      if (sub === 'interfaces') return showVrfInterfaces(this.d());
      return showVrf(this.d());
    }, [
      { keyword: 'detail', description: 'Detailed VRF information' },
      { keyword: 'interfaces', description: 'Interfaces bound to a VRF' },
    ]);
    trie.registerGreedy('show adjacency', 'Display CEF adjacency table', () =>
      showAdjacency(this.d() as unknown as Parameters<typeof showAdjacency>[0]));
    if (this.hasSwitchingHardware()) {
      trie.registerGreedy('show redundancy', 'Display redundancy state', () =>
        showRedundancy());
    }
    trie.registerGreedy('show aaa', 'Display AAA state', (a) => {
      const dev = this.d() as unknown as Router;
      return showAaa(getSecurityConfig(dev), a.join(' '));
    });
  }

  /** Map a CLI alias mode keyword to the repository's AliasMode. */
  private aliasMode(token: string): AliasMode {
    switch (token) {
      case 'configure': return 'configure';
      case 'interface': return 'interface';
      case 'router': return 'router';
      default: return 'exec';
    }
  }

  /**
   * Handle `terminal length <n>` / `terminal width <n>` / `terminal no length`
   * (Cisco IOS exec preference, per-session).
   *
   * Recognised forms:
   *   terminal length <0-512>   — set pager rows (0 = pager off)
   *   terminal no length        — restore default (24)
   *   terminal width <0-512>    — set column hint
   *   terminal no width         — restore default (80)
   *   terminal history size <n> — display-history ring length (no-op stored)
   *   terminal monitor          — accept silently (logging redirect to vty)
   *   terminal no monitor       — accept silently
   *
   * Returns CISCO_ERRORS.INVALID_INPUT on unknown sub-commands so an
   * operator typo doesn't look like a silent success.
   */
  protected handleTerminalCommand(args: string[]): string {
    if (args.length === 0) {
      return CISCO_ERRORS.INCOMPLETE;
    }
    const head = args[0].toLowerCase();
    const rest = args.slice(1);

    if (head === 'length') {
      if (rest.length === 0) return CISCO_ERRORS.INCOMPLETE;
      const n = parseInt(rest[0], 10);
      if (!Number.isFinite(n) || n < 0 || n > 512) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      this.terminalLength = n;
      return '';
    }
    if (head === 'width') {
      if (rest.length === 0) return CISCO_ERRORS.INCOMPLETE;
      const n = parseInt(rest[0], 10);
      if (!Number.isFinite(n) || n < 40 || n > 512) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      this.terminalWidth = n;
      return '';
    }
    if (head === 'no') {
      const sub = (rest[0] ?? '').toLowerCase();
      // `terminal no` seul ne nie rien : il manque le mot a nier, et
      // l'aide venait d'en proposer quatre.
      if (sub === '') return CISCO_ERRORS.INCOMPLETE;
      if (sub === 'length') { this.terminalLength = 24; return ''; }
      if (sub === 'width')  { this.terminalWidth  = 80; return ''; }
      // `terminal no history` DESACTIVE l'historique de cette session :
      // le drapeau seul laissait le tampon en place, donc `show history`
      // continuait de rendre ce qui y etait deja.
      if (sub === 'history') {
        this.terminalHistoryEnabled = false;
        this.terminalHistorySize = 0;
        this.cmdHistory = [];
        return '';
      }
      if (sub === 'monitor' || (sub.length >= 3 && 'monitor'.startsWith(sub))) { this.terminalMonitor = false; this.terminalMonitorExplicit = true; return ''; }
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (head === 'monitor' || (head.length >= 3 && 'monitor'.startsWith(head))) { this.terminalMonitor = true; this.terminalMonitorExplicit = true; return ''; }
    if (head === 'exec') return '';
    if (head === 'history') {
      if ((rest[0] ?? '').toLowerCase() === 'size') {
        const n = parseInt(rest[1] ?? '', 10);
        if (!Number.isFinite(n) || n < 0 || n > 256) return CISCO_ERRORS.INVALID_INPUT;
        this.terminalHistorySize = n;
        this.terminalHistoryEnabled = true;
        return '';
      }
      if (rest.length === 0) {
        this.terminalHistoryEnabled = true;
        if (this.terminalHistorySize === 0) this.terminalHistorySize = this.tailleHistoriqueDeLigne();
        return '';
      }
      return '';
    }
    return CISCO_ERRORS.INVALID_INPUT;
  }

  /**
   * `[no] service timestamps [debug|log] [uptime | datetime [msec]
   * [localtime] [show-timezone] [year]]`.
   *
   * The bare form is legal on IOS and means `service timestamps debug
   * uptime` — refusing it (the state this replaced) rejected a command a
   * real router accepts. Bare `no service timestamps` turns BOTH channels
   * off, since with no channel named there is nothing to restrict it to.
   */
  private applyServiceTimestamps(args: string[], negate: boolean): string {
    const mots = args.map(s => s.toLowerCase());
    this.attachLoggingToDevice(this.d());
    const canaux: Array<'debug' | 'log'> = mots[0] === 'debug' || mots[0] === 'log'
      ? [mots[0] as 'debug' | 'log']
      : ['debug', 'log'];
    const nomme = canaux.length === 1;
    const reste = mots.slice(nomme ? 1 : 0);

    if (negate) {
      if (reste.length > 0 && !this.horodatageOptionsValides(reste)) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      for (const c of canaux) this.logging.setTimestampSpec(c, disabledTimestampSpec());
      return '';
    }

    if (!nomme && reste.length > 0) return CISCO_ERRORS.INVALID_INPUT;
    const spec = this.parseHorodatage(reste);
    if (!spec) return CISCO_ERRORS.INVALID_INPUT;
    for (const c of canaux) this.logging.setTimestampSpec(c, { ...spec });
    return '';
  }

  private horodatageOptionsValides(mots: string[]): boolean {
    return this.parseHorodatage(mots) !== null;
  }

  /**
   * `uptime` takes no modifier of its own on IOS beyond `msec`; the rest
   * only mean something for a real date, so accepting them after `uptime`
   * would store a flag nothing can read.
   */
  private parseHorodatage(mots: string[]): TimestampSpec | null {
    const spec = bareTimestampSpec();
    if (mots.length === 0) return spec;
    if (mots[0] !== 'uptime' && mots[0] !== 'datetime') return null;
    spec.format = mots[0];
    for (const m of mots.slice(1)) {
      if (m === 'msec') { spec.msec = true; continue; }
      if (spec.format !== 'datetime') return null;
      if (m === 'localtime') { spec.localtime = true; continue; }
      if (m === 'show-timezone') { spec.showTimezone = true; continue; }
      if (m === 'year') { spec.year = true; continue; }
      return null;
    }
    return spec;
  }

  /** Public read accessor — used by CLITerminalSession to size the pager. */
  getTerminalLength(): number { return this.terminalLength; }
  /** Public read accessor — symmetric with getTerminalLength. */
  getTerminalWidth(): number { return this.terminalWidth; }

  private registerCommonUserCommands(): void {
    this.registerCommonShowCommands(this.userTrie, 'user');
    // ARP show commands (shared between router and switch)
  }

  private registerCommonPrivilegedCommands(): void {
    this.registerTestAaaCommand();
    this.privilegedTrie.register('disable', 'Return to user EXEC mode', () => {
      this.mode = 'user';
      this.currentPrivilegeLevel = 1;
      return '';
    });

    const saveRunningToStartup = () =>
      `Destination filename [startup-config]?\n${this.onSave()}`;
    // Sauvegarder DATE la NVRAM : c'est la seconde des deux lignes d'en-tête.
    this.privilegedTrie.describeNode('copy', 'Copy a file');

    this.privilegedTrie.register('setup', 'Run the initial configuration dialog', () => '');

    // `archive config` / `show archive` — enregistrées ici, donc pour le
    // routeur ET le switch, parce qu'un Catalyst connaît cette famille
    // tout autant qu'un routeur et qu'elle était refusée en bloc sur le
    // switch. Un équipement sans service d'archivage rend le message de
    // table vide plutôt que de planter.
    this.registerArchiveExecOn(this.privilegedTrie);


    // Single greedy `copy` handler so any source/destination pair is consumed
    // as arguments (an exact `copy running-config startup-config` registration
    // would create an intermediate node that hides other destinations from the
    // greedy match). IOS keyword abbreviations (`copy run start`) are expanded.
    const norm = (a: string): string => {
      const t = a.toLowerCase();
      if (t && 'running-config'.startsWith(t)) return 'running-config';
      if (t && 'startup-config'.startsWith(t)) return 'startup-config';
      return t;
    };
    this.privilegedTrie.registerSuggestions('copy', [
      { keyword: 'running-config', description: 'Current running configuration' },
      { keyword: 'startup-config', description: 'Saved startup configuration' },
      { keyword: 'tftp:',          description: 'Trivial File Transfer Protocol' },
      { keyword: 'flash:',         description: 'Local flash filesystem' },
      { keyword: 'scp:',           description: 'Secure Copy' },
    ]);
    this.privilegedTrie.registerSuggestions('copy running-config', [
      { keyword: 'startup-config', description: 'Save to NVRAM startup-config' },
      { keyword: 'tftp:',          description: 'Upload to TFTP server' },
      { keyword: 'scp:',           description: 'Upload over SCP' },
      { keyword: 'flash:',         description: 'Save to flash filesystem' },
    ]);
    this.privilegedTrie.registerSuggestions('debug', [
      { keyword: 'all',      description: 'Enable all debugging' },
      { keyword: 'ip',       description: 'Debug IP subsystem' },
      { keyword: 'ipv6',     description: 'Debug IPv6 subsystem' },
      { keyword: 'crypto',   description: 'Debug crypto subsystem' },
      { keyword: 'dhcp',     description: 'Debug DHCP' },
      { keyword: 'domain',   description: 'Debug DNS name resolution' },
    ]);
    this.privilegedTrie.registerSuggestions('debug ip', [
      { keyword: 'icmp',     description: 'Debug ICMP packets' },
      { keyword: 'packet',   description: 'Debug all IP packets' },
      { keyword: 'ospf',     description: 'Debug OSPF' },
      { keyword: 'routing',  description: 'Debug routing table changes' },
      { keyword: 'nat',      description: 'Debug NAT' },
      { keyword: 'dhcp',     description: 'Debug DHCP' },
    ]);
    this.privilegedTrie.registerSuggestions('write', [
      { keyword: 'memory',   description: 'Write to NVRAM' },
      { keyword: 'terminal', description: 'Write to terminal (display running-config)' },
      { keyword: 'erase',    description: 'Erase NVRAM' },
    ]);
    // `mac` n'est PAS dans cette liste : une table d'adresses MAC est un
    // organe de commutateur, et le commutateur enregistre `clear mac
    // address-table` pour de vrai — donc son `clear ?` offre `mac` comme
    // un enfant reel. L'annoncer ici le proposait aussi sur un routeur,
    // qui refusait ensuite au caret.
    this.privilegedTrie.registerSuggestions('clear', [
      { keyword: 'arp-cache', description: 'Clear ARP cache' },
      { keyword: 'counters',  description: 'Clear interface counters' },
      { keyword: 'ip',        description: 'Clear an IP subsystem' },
      { keyword: 'logging',   description: 'Clear logging buffer' },
    ]);
    const showIpRouteHints = [
      { keyword: 'static',    description: 'Static routes' },
      { keyword: 'connected', description: 'Directly connected networks' },
      { keyword: 'ospf',      description: 'OSPF-learned routes' },
      { keyword: 'rip',       description: 'RIP-learned routes' },
      { keyword: 'eigrp',     description: 'EIGRP-learned routes' },
      { keyword: 'bgp',       description: 'BGP-learned routes' },
    ];
    this.privilegedTrie.registerSuggestions('show ip route', showIpRouteHints);
    this.userTrie.registerSuggestions('show ip route', showIpRouteHints);
    /**
     * `copy SOURCE DESTINATION`.
     *
     * Ce qu'elle faisait avant : `copy running-config flash:X` répondait
     * `Writing flash:X ... [OK]` en écrivant dans une Map À PART de
     * l'appareil, si bien que `dir flash:` de la même machine, au même
     * instant, ne montrait rien. Une sauvegarde qui annonce avoir
     * réussi et n'a rien écrit est le pire des défauts de ce chapitre :
     * on ne le découvre qu'au moment de restaurer. Tout passe désormais
     * par le VRAI `flash:` — celui que `dir`, `more`, `delete` et
     * `verify` lisent.
     *
     * IOS compte les octets et le temps ; le temps est nul ici (la copie
     * est locale et synchrone), donc seule la taille est rapportée — un
     * débit inventé serait une mesure fausse.
     */
    this.privilegedTrie.registerGreedy('copy', 'Copy a file', (args) => {
      if (!args[0]) return '% Incomplete command.';
      if (!args[1]) return '% Incomplete command.';
      const srcBrut = args[0];
      const dstBrut = args[1];
      const src = norm(srcBrut);
      const dst = norm(dstBrut);
      const dev = this.d() as unknown as {
        _restoreStartupConfig?: () => boolean;
        _applyConfigText?: (text: string) => void;
        getRunningConfig?: () => string;
      };

      const estConfigCourante = (x: string) =>
        x === 'running-config' || x === 'system:running-config';
      const estConfigDemarrage = (x: string) =>
        x === 'startup-config' || x === 'nvram:startup-config' || x === 'nvram:';
      const estReseau = (x: string) =>
        /^(tftp|ftp|scp|sftp|http|https|rcp):/.test(x);
      const estTftp = (x: string) => /^tftp:/.test(x);

      /**
       * La table des ports UDP de CETTE machine. Le routeur et le
       * commutateur la portent tous les deux ; une plateforme qui ne
       * l'a pas n'a pas de client TFTP, et le dit.
       */
      const pointUdp = (): TftpEndpoint | null =>
        (this.d() as unknown as { getUdpEndpoint?: () => TftpEndpoint })
          .getUdpEndpoint?.() ?? null;

      /** Le contenu de la source, ou un message d'erreur d'IOS. */
      const lire = (): { texte: string } | { erreur: string } => {
        if (estConfigCourante(src)) return { texte: dev.getRunningConfig?.() ?? '' };
        if (estConfigDemarrage(src)) {
          const t = this.readStartupConfig();
          return t === null
            ? { erreur: '%% Non-volatile configuration memory is not present' }
            : { texte: t };
        }
        if (estReseau(src)) {
          return { erreur: this.copieReseauIndisponible(srcBrut) };
        }
        const contenu = this.fs().read(srcBrut);
        return contenu === null
          ? { erreur: `%Error opening ${srcBrut} (No such file or directory)` }
          : { texte: contenu };
      };

      if (estConfigCourante(src) && estConfigDemarrage(dst)) return saveRunningToStartup();

      // ── Le fil : `copy tftp: <cible>` ──
      if (estTftp(src)) {
        const url = parseTftpUrl(srcBrut);
        const point = pointUdp();
        if (!url) return TFTP_NO_HOST;
        if (!point) return this.copieReseauIndisponible(srcBrut);
        const appareil = this.d();
        this._pendingAsync = tftpGet(point, url).then((res) =>
          'erreur' in res ? res.erreur : res.trace + this.deposerCopie(appareil, dstBrut, dst, res.texte));
        return '';
      }

      const source = lire();
      if ('erreur' in source) return source.erreur;

      // ── Le fil : `copy <source> tftp:` ──
      if (estTftp(dst)) {
        const url = parseTftpUrl(dstBrut);
        const point = pointUdp();
        if (!url) return TFTP_NO_HOST;
        if (!point) return this.copieReseauIndisponible(dstBrut);
        this._pendingAsync = tftpPut(point, url, source.texte);
        return '';
      }

      if (estConfigCourante(dst) && estConfigDemarrage(src)
        && typeof dev._restoreStartupConfig === 'function') {
        // MERGE, et pas remplacement : c'est le point que le tutoriel
        // insiste à distinguer de `configure replace`.
        if (!dev._restoreStartupConfig()) {
          return '%% Non-volatile configuration memory is not present';
        }
        return `Destination filename [running-config]?\n`
          + `${source.texte.length} bytes copied`;
      }

      if (estReseau(dst)) return this.copieReseauIndisponible(dstBrut);

      return this.deposerCopie(this.d(), dstBrut, dst, source.texte, srcBrut);
    });
    this.privilegedTrie.registerGreedy('reload', 'Reload the device', (args) => {
      if (args[0]?.toLowerCase() === 'cancel') {
        if (this.reloadTimer !== null) { this.schedulerFor(this.d()).clear(this.reloadTimer); this.reloadTimer = null; }
        this.scheduledReloadAtMs = null;
        return 'Reload cancelled.';
      }
      if (args[0]?.toLowerCase() === 'in') {
        if (!args[1]) return '% Incomplete command.';
        if (!/^\d+$/.test(args[1])) return CISCO_ERRORS.INVALID_INPUT;
        const min = parseInt(args[1], 10);
        this.armReloadTimer(min * 60_000);
        return `Reload scheduled in ${min} minute${min === 1 ? '' : 's'}`;
      }
      if (args[0]?.toLowerCase() === 'at') {
        if (!args[1]) return '% Incomplete command.';
        return `Reload scheduled for ${args[1]}`;
      }
      return this.performImmediateReload();
    });
    registerLoggingClearCommands(this.privilegedTrie, this.loggingCommandContext());
    // `send` doit EXISTER dans le trie meme si tout son interet est dans
    // le plan interactif : sans noeud, le mot part en resolution DNS et
    // la machine cherche un hote nomme « send ».
    this.privilegedTrie.registerGreedy('send', 'Send a message to other tty lines', (args) => {
      const cible = this.cibleDeSend(args);
      if (cible === null) return CISCO_ERRORS.INVALID_INPUT;
      if (cible === 'incomplet') return CISCO_ERRORS.INCOMPLETE;
      // Appel non interactif (script, pipe) : aucun corps a saisir, donc
      // rien a livrer. On ne feint pas un envoi.
      return '';
    });
    this.privilegedTrie.addCompletionKeywords('send', [
      { keyword: '*', description: 'All tty lines' },
      { keyword: 'aux', description: 'Auxiliary line' },
      { keyword: 'console', description: 'Primary terminal line' },
      { keyword: 'tty', description: 'Terminal controller' },
      { keyword: 'vty', description: 'Virtual terminal' },
    ]);
    registerLineExecCommands(this.privilegedTrie, () => getSessionRegistry(this.d()));

    this.registerCommonShowCommands(this.privilegedTrie);

    // `clock set` est une commande d'EXEC privilégié sur IOS, et n'était
    // enregistrée qu'en mode configuration — donc refusée là où on la
    // tape. Elle est posée ici, à côté des autres commandes réservées au
    // privilégié, et surtout PAS dans `registerCommonShowCommands`, qui
    // est appelée une fois par arbre (utilisateur puis privilégié) : y
    // toucher au `privilegedTrie` l'enregistrerait deux fois, ce que
    // `command-trie-hygiene.test.ts` signale à juste titre.

    // ARP commands (shared between router and switch)
  }

  /**
   * Outbound Telnet driven by the real topology: resolve the target,
   * pick a source interface, and verify L2/L3 reachability. A session is
   * recorded only when a Telnet listener (network CLI device with telnet
   * transport) actually accepts the connection.
   *
   * Unlike `runOutboundSshClient`, this never pushes a nested interactive
   * session — success just prints the banner (see the Telnet note in
   * CLAUDE.md's Terminal emulation section).
   */
  private runOutboundTelnet(args: string[]): string {
    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length === 0) return '% Incomplete command.';
    const display = positional[0];
    const port = positional[1] ? parseInt(positional[1], 10) : 23;
    const router = this.d() as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    let host = display;
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;

    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return `Trying ${display} ...\n% Destination unreachable; no source interface for outbound Telnet`;

    const stack = (this.d() as unknown as { getTcpStack?: () => { hasEgressTo(ip: string): boolean } })
      .getTcpStack?.();
    if (stack && IPAddress.tryParse(host) && !stack.hasEgressTo(host)) {
      return `Trying ${display} ...\n% Destination unreachable; gateway or host down`;
    }

    const remote = findHostByAddress(host, undefined, this.d() as never);
    if (!remote || remote.poweredOff || remote.interfaceDown) {
      return `Trying ${display} ...\n% Connection timed out; remote host not responding`;
    }
    if (!isPathReachable(sourceIp, remote.ip, this.d() as never)) {
      return `Trying ${display} ...\n% Destination unreachable; gateway or host down`;
    }
    if (!this.remoteAcceptsTelnet(remote.device, port)) {
      return `Trying ${display} ...\n% Connection refused by remote host`;
    }
    this.outgoingSessions.open({ host: display, address: remote.ip, protocol: 'telnet', user: '' });
    return `Trying ${display} ... Open\n`;
  }

  private remoteAcceptsTelnet(device: unknown, port: number): boolean {
    if (port !== 23) return false;
    const d = device as { getDeviceType?: () => string; constructor: { name: string } };
    const cls = d.constructor?.name ?? '';
    const type = (d.getDeviceType?.() ?? '').toLowerCase();
    const isNetworkCli =
      /Router|Switch/.test(cls) || /router|switch/.test(type);
    if (!isNetworkCli) return false;
    const transport = (device as { _getVtyTransportInput?: () => string })._getVtyTransportInput?.();
    if (transport === undefined) return true;
    return transport === 'telnet' || transport === 'all';
  }

  /**
   * Parse `ssh [-l user] [-p port] <host> [command ...]` (the IOS form)
   * and dispatch through the shared runSshClient. Source IP is the
   * router's first configured interface — runSshClient probes for it
   * automatically when sourceIp resolves to a known device.
   */
  private runOutboundSshClient(args: string[]): string {
    let user = 'admin';
    let port: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' && args[i + 1]) { user = args[++i]; continue; }
      if (a === '-p' && args[i + 1]) { port = args[++i]; continue; }
      if (a === '-v') continue;
      if (a.startsWith('-')) continue;
      rest.push(a);
    }
    if (rest.length === 0) return '% Incomplete command.';
    let host = rest[0];
    const cmd = rest.slice(1).join(' ');
    const router = this.d() as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostnameInternal: () => string;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    // Resolve through the static `ip host` table before any DNS fallback.
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;
    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return '% No usable interface IP for outbound SSH';
    const sshStack = (this.d() as unknown as { getTcpStack?: () => { hasEgressTo(ip: string): boolean } })
      .getTcpStack?.();
    if (sshStack && IPAddress.tryParse(host) && !sshStack.hasEgressTo(host)) {
      return IOS_SSH.unreachable(host, Number(port ?? 22));
    }
    const clientArgs: string[] = [];
    if (port) clientArgs.push('-p', port);
    clientArgs.push('-o', 'StrictHostKeyChecking=accept-new');
    // Cisco IOS' built-in ssh client always allocates a line-mode PTY on
    // the VTY — opposite of OpenSSH's exec-mode default.
    clientArgs.push('-t');
    clientArgs.push(`${user}@${host}`);
    if (cmd) clientArgs.push(cmd);
    const result = runSshClient({
      args: clientArgs,
      sourceHostname: router._getHostnameInternal(),
      sourceIp,
      sourceUser: user,
      localVfs: {
        readFile: () => null,
        writeFile: () => undefined,
      },
    });
    // TOFU: record the remote host key in this router's local
    // known-hosts table so `show ip ssh known-hosts` reflects it.
    if (result.exitCode === 0) {
      const dev = this.d() as unknown as {
        _getSshKnownHosts?: () => { add: (e: { host: string; keyType: string; publicKey: string }) => void };
      };
      const remoteHk = this.lookupRemoteSshHostKey(host);
      if (remoteHk) {
        dev._getSshKnownHosts?.().add({ host, ...remoteHk });
      }
      if (!cmd) {
        this.outgoingSessions.open({ host: rest[0], address: host, protocol: 'ssh', user });
      }
    }
    return result.output;
  }

  /** Read the remote machine's host key via the topology registry. */
  private lookupRemoteSshHostKey(host: string): { keyType: string; publicKey: string } | null {
    const found = findHostByAddress(host, undefined, this.d() as never) as { device?: { getSshHostKey?: () => { type: string; publicKey: string } } } | null;
    const hk = found?.device?.getSshHostKey?.();
    return hk ? { keyType: hk.type, publicKey: hk.publicKey } : null;
  }

  private registerCommonConfigCommands(trie: CommandTrie = this.configTrie): void {
    // La séquence de démarrage. `config-register 0x2142` est la moitié
    // de la récupération de mot de passe la plus enseignée du cours ;
    // le registre est réellement stocké et son bit 0x40 réellement lu.
    trie.registerGreedy('boot system', 'Specify system image to load', (args) => {
      const image = (args[0] ?? '').replace(/^flash:\/?/i, '');
      if (!image) return '% Incomplete command.';
      this.fs().addBootSystem(image);
      return '';
    });
    trie.registerGreedy('no boot system', 'Remove a system image from the boot list', (args) => {
      const image = (args[0] ?? '').replace(/^flash:\/?/i, '');
      this.fs().removeBootSystem(image || undefined);
      return '';
    });
    if (!this.hasConfigRegister()) {
      // Les deux seuls reglages d'amorcage d'un Catalyst, et les deux
      // seuls champs de son `show boot` qu'un operateur peut changer.
      trie.register('boot enable-break', 'Enable the Break key during boot',
        () => { this.fs().setEnableBreak(true); return ''; });
      trie.register('no boot enable-break', 'Disable the Break key during boot',
        () => { this.fs().setEnableBreak(false); return ''; });
      trie.register('boot manual', 'Boot into the boot loader instead of the image',
        () => { this.fs().setManualBoot(true); return ''; });
      trie.register('no boot manual', 'Boot the image automatically',
        () => { this.fs().setManualBoot(false); return ''; });
    }
    if (this.hasConfigRegister()) {
      trie.registerGreedy('config-register', 'Set configuration register', (args) => {
        const val = args[0] ?? '';
        if (!this.fs().setConfigRegister(val)) {
          return '% Invalid config register value';
        }
        return '';
      });
    }

    trie.registerGreedy('hostname', 'Set system hostname', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      this.d()._setHostnameInternal(args[0]);
      return '';
    });

    trie.register('no hostname', 'Reset hostname', () => {
      const dev = this.d();
      dev._setHostnameInternal(dev.defaultHostname());
      return '';
    });

    // `alias <mode> <name> <command…>` — real, working aliases.
    trie.registerGreedy('alias', 'Create a command alias', (args) => {
      if (args.length < 3) return '% Incomplete command.';
      const [modeTok, name, ...rest] = args;
      if (name.length > 31) return '% Alias name exceeds 31 characters.';
      this.aliases.set(this.aliasMode(modeTok), name, rest.join(' '));
      return '';
    });
    trie.registerGreedy('no alias', 'Remove a command alias', (args) => {
      if (args.length < 2) return '% Incomplete command.';
      this.aliases.remove(this.aliasMode(args[0]), args[1]);
      return '';
    });

    this.registerHttpServerOn(trie);
    // `ip routing` / `ipv6 unicast-routing` enable forms are owned by
    // the router (CiscoOspfCommands, device-specific); only record the
    // negation here so it's recognised on both vendors without
    // shadowing that specific handler.
    trie.registerGreedy('no ip routing', 'Disable IP routing', () => {
      this.configState.set('ip routing', false);
      return '';
    });
    registerCiscoDnsCommands(trie, this.dnsCommandContext());
    trie.registerGreedy('vrf', 'VRF configuration', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `vrf ${args.join(' ')}`);
      return '';
    });
    // `vrf definition NAME` est la forme moderne de `ip vrf NAME` : elle
    // entre dans le MÊME sous-mode et crée la MÊME instance, sans quoi
    // deux orthographes d'une seule commande donnaient deux résultats
    // — l'une entrait en config-vrf, l'autre notait une ligne et rendait
    // la main en configuration globale.
    trie.registerGreedy('vrf definition', 'Configure a VRF', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const name = args[0];
      const dev = this.d() as unknown as {
        _vrfs?: Map<string, { name: string; rd?: string; rts: { import: string[]; export: string[] }; interfaces: Set<string> }>;
      };
      const vrfs = dev._vrfs ??= new Map();
      if (!vrfs.has(name)) vrfs.set(name, { name, rts: { import: [], export: [] }, interfaces: new Set() });
      (this as unknown as { setSelectedVRF?: (n: string) => void }).setSelectedVRF?.(name);
      this.mode = 'config-vrf';
      return '';
    });
    trie.registerGreedy('ip community-list', 'Define BGP community list', (args, raw) => {
      if (args.length < 3) return CISCO_ERRORS.INCOMPLETE;
      const kind = args[0].toLowerCase();
      const named = kind === 'standard' || kind === 'expanded';
      const name = named ? args[1] : args[0];
      const rule = (named ? args.slice(2) : args.slice(1)).join(' ');
      const store = this.communityLists();
      const key = `${named ? kind : 'standard'} ${name}`;
      const list = store.get(key) ?? [];
      list.push(rule);
      store.set(key, list);
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `ip community-list ${args.join(' ')}`);
      return '';
    });
    trie.registerGreedy('ip as-path access-list', 'Define BGP AS-path filter', (args, raw) => {
      if (args.length < 3) return CISCO_ERRORS.INCOMPLETE;
      const store = this.asPathLists();
      const list = store.get(args[0]) ?? [];
      list.push(args.slice(1).join(' '));
      store.set(args[0], list);
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `ip as-path access-list ${args.join(' ')}`);
      return '';
    });
    trie.registerGreedy('priority-list', 'Legacy PQ list', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `priority-list ${args.join(' ')}`);
      return '';
    });
    trie.registerGreedy('queue-list', 'Legacy CQ list', (args, raw) => {
      const r = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      r._recordUnhandledConfigLine?.(raw ?? `queue-list ${args.join(' ')}`);
      return '';
    });
    /**
     * `privilege <mode> [all] {level <n> | reset} <commande>`.
     *
     * Les deux diagnostics d'IOS ne sont pas interchangeables : `%
     * Incomplete command.` dit « continue de taper », `% Invalid input`
     * dit « ce mot-la est faux » et POSE LE CURSEUR dessous. Cette
     * analyse rendait le premier pour un mot-cle mal ecrit — une ligne
     * a qui il ne manque rien — et posait le curseur ailleurs que sur
     * le mot fautif quand elle rendait le second.
     *
     * Et la COMMANDE elle-meme est verifiee, comme `commands <mode>
     * include` la verifie deja : une regle nee sur une faute de frappe
     * parait dans la configuration, se recharge a l'import, et
     * n'autorise jamais rien.
     */
    trie.registerGreedy('privilege', 'Configure command privilege levels', (args, raw) => {
      const regle = this.analyserRegleDePrivilege(args);
      if (regle.niveau === null) {
        return this.reinitialiserNiveauDeCommande(regle.scope, regle.commande);
      }
      // La regle N'EST PAS enregistree comme « ligne non traitee » : elle
      // est rendue depuis la table qui decide (`privilegeConfigLines`).
      // Deux magasins pour un fait, c'est ce qui laissait une regle
      // paraitre dans la configuration sans avoir le moindre effet.
      void raw;
      this.autorisation()
        .setCommandLevel(regle.scope, regle.commande, regle.niveau, regle.tous);
      return '';
    });
    /**
     * `parser view <nom>` — declarer une vue CLI (le RBAC d'IOS).
     *
     * Deux conditions d'IOS, et ce ne sont pas des formalites : il faut
     * `aaa new-model` (une vue est un mecanisme d'autorisation, il vit
     * dans AAA) et il faut etre dans la vue RACINE (sans quoi une vue
     * restreinte pourrait s'octroyer des commandes, ce qui viderait le
     * mecanisme de son sens).
     */
    trie.registerGreedy('parser view', 'Define a CLI view', (args) => {
      if (args.length === 0) throw new CliIncomplete();
      const sec = getSecurityConfig(this.d());
      if (!sec.aaaNewModel) {
        return '%Parser view commands are not available. AAA must be enabled first';
      }
      if (this.activeParserView !== null) {
        return '%Currently in view mode. Please exit to root view first';
      }
      /**
       * La vue RACINE est la condition d'IOS, et Cisco la definit par le
       * niveau : un utilisateur de la vue racine a les privileges du
       * niveau 15, et c'est ce qui le distingue des autres — lui seul
       * peut declarer une vue et en changer le contenu.
       *
       * Sans ce controle, il suffisait de se DELEGUER `parser view`
       * (`privilege configure level 5 parser view`) pour que le
       * mecanisme d'autorisation se reconfigure depuis l'interieur de
       * ce qu'il restreint : la session s'ecrivait un role sur mesure.
       */
      if (this.currentPrivilegeLevel < 15) {
        return '%Root view is required to configure a view';
      }
      const nom = args[0];
      // `parser view <nom> superview` : le mot-cle etait accepte et JETE,
      // donc la vue naissait ordinaire ET VIDE — un compte qui la portait
      // ne voyait rien du tout, ce qui est pire qu'un refus.
      const superview = (args[1] ?? '').toLowerCase() === 'superview';
      if (args[1] !== undefined && !superview) throw new CliInvalidInput({ token: args[1] });
      const existante = sec.parserViews.get(nom);
      // Cisco documente un maximum de 15 vues et superviews, vue racine
      // non comprise. Re-entrer dans une vue EXISTANTE n'est pas une
      // creation et ne compte donc pas. Le libelle exact du refus d'IOS
      // n'a pas pu etre verifie : celui-ci dit la limite plutot que
      // d'imiter une phrase dont on n'est pas sur.
      if (!existante && sec.parserViews.size >= MAX_PARSER_VIEWS) {
        return `%Error: maximum number of views (${MAX_PARSER_VIEWS}) already configured`;
      }
      if (!existante) {
        sec.parserViews.set(nom, {
          name: nom, modes: new Map(),
          superview: superview || undefined, members: superview ? [] : undefined,
        });
      } else if (superview && !existante.superview) {
        return '%View is already defined as a normal view';
      }
      this.selectedParserView = nom;
      this.mode = 'config-view';
      return '';
    }, [{ keyword: 'superview', description: 'Define this view as a superview' }]);
    trie.registerGreedy('no parser view', 'Remove a CLI view', (args) => {
      if (args.length === 0) throw new CliIncomplete();
      getSecurityConfig(this.d()).parserViews.delete(args[0]);
      return '';
    });
    // Après les deux enregistrements, qui créent les nœuds : sans cela
    // `?` proposerait `parser` et `no parser` nus.
    trie.describeNode('parser', 'Configure parser');
    trie.describeNode('no parser', 'Negate a parser command');

    trie.registerGreedy('no privilege', 'Remove privilege command rule', (args) => {
      const regle = this.analyserRegleDePrivilege(args);
      this.autorisation().resetCommandLevel(regle.scope, regle.commande);
      return '';
    });

    registerLoggingConfigCommands(trie, this.loggingCommandContext());
    registerSequenceNumbersCommand(trie, this.loggingCommandContext());
    trie.registerGreedy('service timestamps', 'Timestamp log/debug messages', (args) =>
      this.applyServiceTimestamps(args, false));
    trie.registerGreedy('no service timestamps', 'Stop timestamping messages', (args) =>
      this.applyServiceTimestamps(args, true));
    // Chaque sous-commande de `ntp` est un VRAI noeud de l'arbre.
    //
    // Un unique noeud glouton n'a pas de sous-arbre : son aide ne
    // pouvait donc rien descendre, et `?` reproduisait la meme liste a
    // toutes les profondeurs — `ntp access-group access-group ?`
    // proposait encore la liste complete, et la commande etait acceptee.
    // Pire, la liste elle-meme etait EXTRAITE du code source du
    // gestionnaire (`autoContinuations`), d'ou trois mots qui ne sont
    // pas des sous-commandes de `ntp` : `md5` (argument
    // d'`authentication-key`), `prefer` (argument de `server`) et
    // `mode` — qui portait « Set trunking mode of the interface », la
    // description de `switchport mode`, une fuite d'une commande vers
    // une autre.
    //
    // Declarer les vrais enfants les exclut de l'extraction, donne a
    // chacun sa propre aide, et fait refuser ce qui n'existe pas.
    trie.register('ntp', 'Configure NTP', () => CISCO_ERRORS.INCOMPLETE);


    // Même chemin exact que la forme d'EXEC privilégié : deux analyseurs
    // pour une seule commande finiraient par se contredire sur la même
    // date.
    // `calendar-valid` est declare pour LUI-MEME, non plus comme le seul
    // mot qu'un noeud glouton accepte. Le noeud glouton extrayait ses
    // suites du code de son propre gestionnaire, et proposait donc un
    // `timezone` sans description depuis que la sous-commande de ce nom
    // est passee au socle.
    trie.register('clock calendar-valid',
      'Hardware calendar is a valid time source', (_args, raw) => {
        const dev = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
        dev._recordUnhandledConfigLine?.(raw ?? 'clock calendar-valid');
        return '';
      });
    trie.register('clock', 'Configure time-of-day clock', () => {
      throw new CliIncomplete();
    });

    trie.registerGreedy('enable secret', 'Set enable secret', (args) => {
      const dev = this.d() as unknown as { _setEnableSecretForLevel?: (level: number, s: string, algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7') => void };
      let algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' = 'md5';
      let secret = '';
      let level = 15;
      // Cleartext forms (0, level N, or bare) are what `security passwords
      // min-length` validates — a pasted hash (5/7/8/9) is exempt, same as
      // `username ... secret` (CiscoSecurityCommands.ts).
      let plaintextEntered: string | undefined;
      // La grammaire d'IOS est `enable secret [level N] [{0|5|7|8|9}]
      // <chaine>`, et les deux parties sont INDEPENDANTES. Elles etaient
      // traitees comme exclusives : apres `level N`, le chiffre
      // d'algorithme etait avale DANS le secret. La forme rendue par la
      // machine — `enable secret level 12 5 $1$…` — n'etait donc pas
      // relisible par elle-meme, et le coffre du palier disparaissait a
      // l'import d'une topologie, sans rien dire.
      let reste = args;
      if (reste[0]?.toLowerCase() === 'level' && /^\d+$/.test(reste[1] ?? '')) {
        level = parseInt(reste[1], 10);
        reste = reste.slice(2);
      }
      const chiffres: Record<string, 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7'> = {
        '0': 'plain', '5': 'md5', '7': 'type-7', '8': 'sha256', '9': 'scrypt',
      };
      const nomme = chiffres[reste[0] ?? ''];
      // `enable secret 5` sans rien apres : le chiffre EST le type, donc
      // il ne reste aucun secret — IOS repond incomplet plutot que de
      // ranger « 5 » comme mot de passe en clair.
      if (nomme !== undefined && reste.length === 1) return '% Incomplete command.';
      if (nomme !== undefined && reste.length > 1) {
        algo = nomme;
        secret = reste.slice(1).join(' ');
        // Seul le clair est soumis a `security passwords min-length` : un
        // condense colle est exempt, comme pour `username … secret`.
        if (nomme === 'plain') plaintextEntered = secret;
      } else {
        secret = reste.join(' ');
        plaintextEntered = secret;
      }
      if (secret === '') return '% Incomplete command.';
      const minLength = getSecurityConfig(this.d()).passwords.minLength;
      if (plaintextEntered !== undefined && minLength && plaintextEntered.length < minLength) {
        return `Password too short - must be at least ${minLength} characters. Password configuration failed`;
      }
      dev._setEnableSecretForLevel?.(level, secret, algo);
      return '';
    });
    // `enable algorithm-type {md5|scrypt|sha256} secret [level N] <pwd>` —
    // explicit-algorithm form of `enable secret` (IOS 15.3+), always takes
    // a cleartext password and hashes it with the named algorithm.
    trie.registerGreedy('enable algorithm-type', 'Set enable secret with an explicit hash algorithm', (args) => {
      const dev = this.d() as unknown as { _setEnableSecretForLevel?: (level: number, s: string, algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7') => void };
      const algoName = args[0]?.toLowerCase();
      const algoMap: Record<string, 'md5' | 'scrypt' | 'sha256'> = { md5: 'md5', scrypt: 'scrypt', sha256: 'sha256' };
      const algo = algoMap[algoName ?? ''];
      // Un mot ABSENT n'est pas un mot faux : `enable algorithm-type`
      // seul reclame l'algorithme, il ne le nie pas.
      if (algoName === undefined) return CISCO_ERRORS.INCOMPLETE;
      if (!algo) return CISCO_ERRORS.INVALID_INPUT;
      if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
      if (args[1].toLowerCase() !== 'secret') return CISCO_ERRORS.INVALID_INPUT;
      let level = 15;
      let rest = args.slice(2);
      if (rest[0]?.toLowerCase() === 'level' && /^\d+$/.test(rest[1] ?? '')) {
        level = parseInt(rest[1], 10);
        rest = rest.slice(2);
      }
      const secret = rest.join(' ');
      if (secret === '') return CISCO_ERRORS.INCOMPLETE;
      const minLength = getSecurityConfig(this.d()).passwords.minLength;
      if (minLength && secret.length < minLength) {
        return `Password too short - must be at least ${minLength} characters. Password configuration failed`;
      }
      dev._setEnableSecretForLevel?.(level, secret, algo);
      return '';
    });
    trie.registerGreedy('enable password', 'Set enable password', (args) => {
      const dev = this.d() as unknown as {
        _setEnablePasswordForLevel?: (level: number, p: string, algo: 'plain' | 'type-7') => void;
        getServiceFlags?: () => ReadonlyMap<string, boolean>;
      };
      let algo: 'plain' | 'type-7' = 'plain';
      let password = '';
      let level = 15;
      let plaintextEntered: string | undefined;
      if (args[0] === '0') { algo = 'plain'; password = args.slice(1).join(' '); plaintextEntered = password; }
      else if (args[0] === '7') { algo = 'type-7'; password = args.slice(1).join(' '); }
      else if (args[0] === 'level' && /^\d+$/.test(args[1] ?? '')) {
        level = parseInt(args[1], 10);
        password = args.slice(2).join(' '); plaintextEntered = password;
      } else { password = args.join(' '); plaintextEntered = password; }
      if (password === '') return '% Incomplete command.';
      const minLength = getSecurityConfig(this.d()).passwords.minLength;
      if (plaintextEntered !== undefined && minLength && plaintextEntered.length < minLength) {
        return `Password too short - must be at least ${minLength} characters. Password configuration failed`;
      }
      if (algo === 'plain' && dev.getServiceFlags?.().get('password-encryption') === true) {
        const salt = parseInt(_md5Hex(`cisco-type7:${password}`).slice(0, 1), 16);
        dev._setEnablePasswordForLevel?.(level, _encryptType7(password, salt), 'type-7');
      } else {
        dev._setEnablePasswordForLevel?.(level, password, algo);
      }
      return '';
    });
    trie.register('no enable secret', 'Remove enable secret', () => {
      const dev = this.d() as unknown as { _setEnableSecret?: (s: string, algo: 'plain') => void };
      dev._setEnableSecret?.('', 'plain');
      return '';
    });
    trie.register('no enable password', 'Remove enable password', () => {
      const dev = this.d() as unknown as { _setEnablePassword?: (p: string, algo: 'plain') => void };
      dev._setEnablePassword?.('', 'plain');
      return '';
    });
    // `username <name> [privilege N] [secret|password] <pwd>` — captures
    // the local-user database so the sshd dispatch can validate inbound
    // logins. Anything we don't parse is still accepted silently.
    trie.registerGreedy('crypto', 'Encryption module', (args, raw) => {
      const dev = this.d() as unknown as { _recordUnhandledConfigLine?: (l: string) => void };
      dev._recordUnhandledConfigLine?.(raw ?? `crypto ${args.join(' ')}`);
      return '';
    });
    // `service timestamps` has its own registration above and the trie
    // routes to the more specific one, so the second parser this handler
    // used to carry never ran — it could only ever contradict the first.
    trie.registerGreedy('no username', 'Remove a local user', (args) => {
      const dev = this.d() as unknown as { _removeLocalUser?: (n: string) => void };
      if (args[0] && typeof dev._removeLocalUser === 'function') dev._removeLocalUser(args[0]);
      return '';
    });
    // `ip ssh …` : le handler qui vivait ici ecrivait un SECOND magasin
    // (celui du gestionnaire) que rien ne lisait pour ces champs, et il
    // etait de toute facon ombre sur le routeur par l'enregistrement plus
    // specifique de `CiscoSecurityCommands`. Deux magasins pour un fait,
    // avec des defauts qui se contredisaient : il n'en reste qu'un.
    // Le commutateur garde son propre `ip ssh version`.

    // `line {console|vty|aux} …` → shared config-line sub-mode.
    // We remember the selected VTY range so subsequent directives
    // (exec-timeout, access-class, transport input, …) land in the
    // right VtyLineConfig block.
    trie.registerGreedy('line', 'Enter line configuration', (args) => {
      const tete = analyserTeteLigne(args);
      if ('erreur' in tete) return tete.erreur;

      this.mode = 'config-line';
      this.selectedVtyRange = null;
      this.selectedConsoleLine = null;
      this.selectedAuxLine = null;
      if (tete.sorte === 'vty' || tete.sorte === 'tty') {
        this.selectedVtyRange = { first: tete.premiere, last: tete.derniere };
        const dev = this.d() as unknown as { _getVtyLineConfig?: () => { upsert: (p: object) => void } };
        dev._getVtyLineConfig?.().upsert({ first: tete.premiere, last: tete.derniere });
      } else if (tete.sorte === 'console') {
        this.selectedConsoleLine = tete.premiere;
      } else {
        this.selectedAuxLine = tete.premiere;
      }
      return '';
    });
    /**
     * `no line <type> <first> [<last>]` remet ces lignes a leur
     * configuration d'usine.
     *
     * `no ?` offrait `line` — « Remove line configuration » — et rien ne
     * portait ce chemin : la commande etait annoncee et refusee au
     * caret. Ce qu'elle fait est LU sur ce que `line` ecrit : le bloc
     * VTY est le seul etat que la configuration de ligne persiste, donc
     * le retirer EST le retour aux defauts, et la running-config cesse
     * de le rendre. La console et l'AUX n'ont pas de bloc a supprimer :
     * IOS refuse d'ailleurs `no line console 0`, une ligne qu'on ne peut
     * pas retirer d'un chassis.
     */
    trie.registerGreedy('no line', 'Remove line configuration', (args) => {
      const tete = analyserTeteLigne(args);
      if ('erreur' in tete) return tete.erreur;
      if (tete.sorte === 'console' || tete.sorte === 'aux') {
        return `% Can't delete ${tete.sorte === 'aux' ? 'AUX' : 'console'} line`;
      }
      const dev = this.d() as unknown as {
        _getVtyLineConfig?: () => { remove: (a: number, b: number) => boolean };
      };
      dev._getVtyLineConfig?.().remove(tete.premiere, tete.derniere);
      if (this.selectedVtyRange?.first === tete.premiere
        && this.selectedVtyRange?.last === tete.derniere) {
        this.selectedVtyRange = null;
      }
      return '';
    });
    // Une ligne se DESIGNE : `line` seul, comme `no line` seul, repond
    // « Incomplete », donc ni l'un ni l'autre n'annonce `<cr>`.
    trie.requireArgs('line', 1);
    trie.requireArgs('no line', 1);

    // Les vingt mots-clés ci-dessus partagent UN handler, et
    // `autoContinuations` lit le corps d'un handler pour deviner ses
    // suites : chacun des vingt se voyait donc proposer l'union des
    // mots de tous les autres — `login ?` offrait `password`, `size`,
    // `synchronous`… La déclaration explicite prime sur l'extraction,
    // et chaque suite ci-dessous est celle que ce handler DISPATCHE
    // vraiment, pas celle qu'IOS documente : annoncer une forme que la
    // machine refuse ensuite serait le défaut inverse.

    // `exec-timeout <minutes> [seconds]` — persisted on the VTY block
    // so show running-config can echo it back exactly.
    this.registerViewSubmodeOn(
      isCollector(trie) ? new CommandTrie() : this.configViewTrie);

    /**
     * La commande existe-t-elle dans l'arbre de ce mode ?
     *
     * On interroge l'arbre du MODE nomme, et non l'arbre privilegie pour
     * tout : `commands configure include hostname` porte sur une commande
     * de configuration, qui n'est dans aucun arbre exec.
     */
    // `login-timeout <secondes>` : le delai laisse pour s'identifier,
    // distinct de `exec-timeout` qui compte l'inactivite APRES la
    // connexion. La commande d'IOS etait refusee.

    // ARP config commands (shared between router and switch)
  }

  /**
   * `test aaa group <nom> <user> <mot de passe> {legacy | new-code}`
   * (`docs/PRD-Serveur-HTTP-Cisco.md` §5).
   *
   * Elle existait dans `CiscoTerminalSession` — donc dans le terminal
   * graphique et nulle part ailleurs : la même machine y répondait par un
   * onglet et l'ignorait par le shell, en SSH comme dans un script. Le
   * motif invoqué là-bas (« un gestionnaire du trie doit rendre une
   * chaîne synchrone ») ne tient pas : `_pendingAsync` est précisément
   * l'écoutille que `ping` emprunte, et c'est celle-ci.
   */

  protected registerViewSubmodeOn(trie: CommandTrie): void {
    trie.registerGreedy('secret', 'Set the view password', (args) => {
      if (args.length === 0) throw new CliIncomplete();
      const vue = this.vueEnCours();
      if (!vue) return '';
      // Meme forme que `username … secret` : un chiffre en tete decrit un
      // condense deja calcule, sinon on hache.
      const chiffre = args[0];
      const map: Record<string, 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7'> = {
        '0': 'plain', '5': 'md5', '7': 'type-7', '8': 'sha256', '9': 'scrypt',
      };
      if (map[chiffre] !== undefined && args.length > 1) {
        vue.secretAlgo = map[chiffre];
        vue.secret = args.slice(1).join(' ');
      } else {
        vue.secretAlgo = 'md5';
        vue.secret = args.join(' ');
      }
      return '';
    });
    /**
     * `view <nom>` sous une superview : ajouter une vue MEMBRE. La
     * commande etait refusee, donc une superview restait vide quoi qu'on
     * y mette. Une superview ne porte pas de commandes a elle et une vue
     * ordinaire n'a pas de membres : melanger les deux produirait un
     * objet qu'IOS ne connait pas.
     */
    trie.registerGreedy('view', 'Add a member view to this superview', (args) => {
      if (args.length < 1) throw new CliIncomplete();
      const vue = this.vueEnCours();
      if (!vue) return '';
      if (!vue.superview) return '%View is not a superview';
      const nom = args[0];
      const sec = getSecurityConfig(this.d());
      const membre = sec.parserViews.get(nom);
      if (!membre) return `%Error: View ${nom} is not present in the system`;
      if (membre.superview) return '%A superview cannot be a member of another superview';
      (vue.members ??= []);
      if (!vue.members.includes(nom)) vue.members.push(nom);
      return '';
    });

    trie.registerGreedy('commands', 'Configure the commands of a view', (args) => {
      // `commands <mode> {include | include-exclusive | exclude} [all] <cmd>`
      if (args.length < 3) throw new CliIncomplete();
      const vue = this.vueEnCours();
      if (!vue) return '';
      const mode = args[0].toLowerCase();
      if (!AUTH_SCOPES.includes(mode as AuthScope)) throw new CliInvalidInput({ token: args[0] });
      const sens = args[1].toLowerCase();
      if (sens !== 'include' && sens !== 'include-exclusive' && sens !== 'exclude') {
        throw new CliInvalidInput({ token: args[1] });
      }
      // `all` etend l'entree a ce qui COMPLETE la commande, comme le
      // mot-cle homonyme des regles de niveau. La documentation Cisco
      // l'emploie elle-meme : `commands exec include all show`.
      const tous = args[2].toLowerCase() === 'all';
      const reste = args.slice(tous ? 3 : 2);
      if (reste.length === 0) throw new CliIncomplete();
      const commande = this.autorisation()
        .formeDeVue(mode as AuthScope, reste.join(' '));
      // Une commande qui n'existe pas n'accorderait rien : l'accepter
      // ferait d'une faute de frappe une vue silencieusement vide, ce
      // qui est le defaut que ce mecanisme est cense refermer.
      if (!this.commandeConnueDansMode(mode as AuthScope, commande)) return '%Command not found';

      const jeu = parserViewMode(vue, mode);
      if (sens === 'exclude') {
        if (!jeu.exclude.some((c) => c.command === commande)) {
          jeu.exclude.push({ command: commande, all: tous, exclusive: false });
        }
        return '';
      }
      // `include-exclusive` RESERVE la commande : aucune autre vue ne
      // peut la revendiquer. Le mot-cle etait traite comme `include`,
      // donc il produisait autre chose que ce qu'il promet, en silence.
      const reservee = this.autorisation().views
        .reservedBy(mode as AuthScope, commande, vue.name);
      if (reservee !== null) {
        return `%Command is set as include-exclusive in view ${reservee}`;
      }
      const exclusive = sens === 'include-exclusive';
      const deja = jeu.include.find((c) => c.command === commande);
      if (deja) {
        jeu.include[jeu.include.indexOf(deja)] = { command: commande, all: tous, exclusive };
      } else {
        jeu.include.push({ command: commande, all: tous, exclusive });
      }
      return '';
    });
  }

  private registerTestAaaCommand(): void {
    this.privilegedTrie.registerGreedy('test aaa group',
      'Test AAA server-group authentication', (args) => {
        const [groupName, username, password, mode] = args;
        if (!groupName || !username || password === undefined) throw new CliIncomplete();
        // `legacy` et `new-code` désignent deux versions du code d'appel
        // interne d'IOS, pas deux protocoles : le dialogue sur le fil est
        // le même, donc les deux mots sont acceptés.
        if (mode === undefined) throw new CliIncomplete();
        if (mode !== 'legacy' && mode !== 'new-code') throw new CliInvalidInput({ token: mode });

        const dev = this.d() as unknown as { getAaaAuthenticator?: () => AaaAuthenticator };
        const authenticator = dev.getAaaAuthenticator?.();
        if (!authenticator) throw new CliInvalidInput({ token: 'aaa' });

        this._pendingAsync = runTestAaaGroup(authenticator, groupName, username, password)
          .then((lines) => lines.join('\n'));
        return '';
      });
    // Le nœud intermédiaire porte sa description, sans quoi `?` le
    // proposerait nu — ce que le garde-fou
    // `cisco-help-every-keyword-described` attrape.
    this.privilegedTrie.describeNode('test', 'Test subsystems, memory, and interfaces');
    this.privilegedTrie.describeNode('test aaa', 'Test AAA subsystem');
  }

  /**
   * La famille `ip http` (`docs/PRD-Serveur-HTTP-Cisco.md` §2). Les deux
   * drapeaux étaient rangés dans une table dont le rendu est mort, et
   * les cinq commandes qui les accompagnent étaient refusées — donc un
   * serveur qu'on ne pouvait ni déplacer de port, ni authentifier, ni
   * restreindre, et dont l'état ne survivait pas à un enregistrement.
   *
   * Une valeur hors bornes est REFUSÉE plutôt que rognée : la ranger
   * silencieusement ferait mentir la configuration relue.
   */
  protected registerHttpServerOn(trie: CommandTrie): void {
    const svc = () => getHttpService(this.d());
    const sync = () => {
      const dev = this.d() as unknown as { _refreshHttpListeners?: () => void };
      dev._refreshHttpListeners?.();
    };

    trie.register('ip http server', 'Enable HTTP server', () => {
      svc()?.setEnabled(true); sync(); return '';
    });
    trie.register('no ip http server', 'Disable HTTP server', () => {
      svc()?.setEnabled(false); sync(); return '';
    });
    trie.register('ip http secure-server', 'Enable HTTPS server', () => {
      svc()?.setSecureEnabled(true, this.d().getHostname()); sync(); return '';
    });
    trie.register('no ip http secure-server', 'Disable HTTPS server', () => {
      svc()?.setSecureEnabled(false); sync(); return '';
    });

    trie.registerGreedy('ip http port', 'HTTP server port', (args) => {
      const port = Number(args[0]);
      if (args.length === 0) throw new CliIncomplete();
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new CliInvalidInput({ token: args[0] });
      }
      svc()?.setPort(port); sync(); return '';
    });
    trie.registerGreedy('no ip http port', 'Restore default HTTP port', () => {
      svc()?.setPort(80); sync(); return '';
    });
    trie.registerGreedy('ip http secure-port', 'HTTPS server port', (args) => {
      const port = Number(args[0]);
      if (args.length === 0) throw new CliIncomplete();
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new CliInvalidInput({ token: args[0] });
      }
      svc()?.setSecurePort(port); sync(); return '';
    });

    trie.registerGreedy('ip http authentication',
      'Set HTTP server authentication method', (args) => {
        if (args.length === 0) throw new CliIncomplete();
        const method = args[0].toLowerCase();
        if (!HTTP_AUTH_METHODS.includes(method as HttpAuthMethod)) {
          throw new CliInvalidInput({ token: args[0] });
        }
        svc()?.setAuthMethod(method as HttpAuthMethod, args[1]);
        return '';
      });
    trie.registerGreedy('no ip http authentication',
      'Restore default authentication', () => { svc()?.resetAuthMethod(); return ''; });

    trie.registerGreedy('ip http max-connections',
      'Set maximum concurrent connections', (args) => {
        if (args.length === 0) throw new CliIncomplete();
        const n = Number(args[0]);
        if (!Number.isInteger(n)
          || n < HTTP_MAX_CONNECTIONS_MIN || n > HTTP_MAX_CONNECTIONS_MAX) {
          throw new CliInvalidInput({ token: args[0] });
        }
        svc()?.setMaxConnections(n);
        return '';
      });
    trie.registerGreedy('no ip http max-connections',
      'Restore default connection limit', () => { svc()?.setMaxConnections(5); return ''; });

    trie.registerGreedy('ip http access-class',
      'Restrict HTTP server access by ACL', (args) => {
        if (args.length === 0) throw new CliIncomplete();
        // `ipv4 <nom>` est la forme longue d'IOS ; le premier mot seul est
        // la forme numérotée historique.
        const acl = args[0].toLowerCase() === 'ipv4' ? args[1] : args[0];
        if (!acl) throw new CliIncomplete();
        svc()?.setAccessClass(acl);
        return '';
      });
    trie.registerGreedy('no ip http access-class',
      'Remove HTTP access restriction', () => { svc()?.setAccessClass(null); return ''; });

    trie.registerGreedy('ip http timeout-policy',
      'Set HTTP server timeout policy', (args) => {
        if (args.length === 0) throw new CliIncomplete();
        // Les trois mots-clés sont obligatoires sur IOS et dans cet
        // ordre : la commande décrit une politique entière, pas trois
        // réglages indépendants.
        const wanted = ['idle', 'life', 'requests'];
        const values: number[] = [];
        for (let i = 0; i < 3; i++) {
          if (args[i * 2] === undefined || args[i * 2 + 1] === undefined) {
            throw new CliIncomplete();
          }
          if (args[i * 2].toLowerCase() !== wanted[i]) {
            throw new CliInvalidInput({ token: args[i * 2] });
          }
          const v = Number(args[i * 2 + 1]);
          if (!Number.isInteger(v) || v < 1) throw new CliInvalidInput({ token: args[i * 2 + 1] });
          values.push(v);
        }
        svc()?.setTimeoutPolicy({ idleSec: values[0], lifeSec: values[1], requests: values[2] });
        return '';
      });
    trie.registerGreedy('no ip http timeout-policy',
      'Restore default timeout policy', () => { svc()?.resetTimeoutPolicy(); return ''; });
  }
}

/**
 * Une empreinte stable dérivée du nom et de la taille. Ce n'est pas un
 * vrai MD5 de l'image — le simulateur n'en stocke aucune — mais une
 * valeur **reproductible** : `verify` deux fois de suite rend la même
 * chose, et deux fichiers différents en rendent deux différentes, ce
 * qui est tout ce qu'un exercice de vérification demande.
 */
function pseudoMd5(name: string, size: number): string {
  let h1 = 0x811c9dc5, h2 = size >>> 0;
  for (let i = 0; i < name.length; i++) {
    h1 = Math.imul(h1 ^ name.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + name.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const part = (n: number) => n.toString(16).padStart(8, '0');
  return part(h1) + part(h2) + part((h1 ^ h2) >>> 0) + part((h1 + h2) >>> 0);
}
