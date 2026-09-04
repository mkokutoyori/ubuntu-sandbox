/**
 * CiscoSwitchShell - Cisco IOS CLI Engine for Switches
 *
 * Extends CiscoShellBase<Switch> to inherit shared execute loop, FSM,
 * help/tab-complete, and common commands (enable, configure, ARP, hostname).
 *
 * Switch-specific additions:
 *   - VLANs, switchport modes, trunk/access configuration
 *   - MAC address table, spanning tree
 *   - DHCP snooping
 *   - Interface ranges
 *
 * Modes (FSM States):
 *   user, privileged, config, config-if, config-vlan
 */

import { CiscoShellBase } from './CiscoShellBase';
import {
  DEFAULT_LOAD_BALANCE, LOAD_BALANCE_METHODS, selectBundleMemberForFlow,
  type LoadBalanceMethod,
} from '@/network/lacp/loadBalance';
import { privilegeConfigLines } from './cli/CliAuthorization';
import { getPrivilegeRules } from '../router/security/CiscoPrivilegeStore';
import { CommandTrie, formatInvalidInput } from './CommandTrie';
import { isValidIPv4 } from '../../core/ip';
import type { CommandSpec } from '@/cli/CommandTable';
import type { FhrpPlacement } from './cisco/fhrpInterfaceSpecs';
import { parseTrackDefinition, TRACK_INVALID_ID } from './cisco/trackSyntax';
import { vrfRunningConfigLines, type VrfHost } from './cisco/ciscoVrfStore';
import type { IpAddressHost } from './cisco/ipAddressInterfaceSpecs';
import type { LoadMtuHost } from './cisco/interfaceLoadMtuSpecs';
import {
  switchPortPhysicalSpecs, type PhysicalPortHost,
} from './cisco/switchPortPhysicalSpecs';
import { stpInterfaceSpecs, type StpInterfaceHost } from './cisco/stpInterfaceSpecs';
import { dhcpClientFamily, type DhcpClientLeaseView } from '@/cli/commands/dhcp/dhcpClientFamily';

const SVI_SANS_SECONDAIRE =
  '% Secondary addresses are not supported on this platform.';
import type { SocleLegend } from './CiscoShellBase';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { SpecCollector, AdapterKeyword } from '@/cli/commands/trieAdapter';
import { collectRegistrations, specsFromTrieRegistrations, isCollector }
  from '@/cli/commands/trieAdapter';
import {
  renderInterfaceCounters, type CounterRow,
} from './cisco/ciscoCounterTables';
import type { ISwitchShell } from './ISwitchShell';
import type { Switch, SwitchportConfig } from '../Switch';
import { parseVlanId, VLAN_MIN, VLAN_MAX, type VlanSet } from '../switch/VlanSet';
import {
  STORM_CONTROL_TYPES, parseStormControl, stormControlPercent,
} from './cisco/stormControlSyntax';
import { igmpSnoopingRunningConfigLines } from '../../igmp-snooping/snoopingRunningConfig';
import type { SnoopingConfig } from '../../igmp-snooping/types';
import type { CiscoSwitch } from '../CiscoSwitch';
import type { PromptMap } from './PromptBuilder';
import { CISCO_SWITCH_PROMPTS } from './PromptBuilder';
import { CLIStateMachine, CISCO_SWITCH_MODES } from './CLIStateMachine';
import { MACAddress, IPAddress, SubnetMask } from '../../core/types';
import { decouperPlages, completerBorne, etendreEntre } from './cli/interfaceRange';
import { renderSecretField, renderPasswordField, renderCiscoUsernameLines } from './cisco/ciscoPasswordRender';
import { parsePingArgs, formatCiscoPing } from './cisco/ciscoPing';
import {
  showInterface, consoleAndAuxLineConfigLines, enableLevelSecretConfigLines,
  ipIntBriefRowsFromPorts, renderIpIntBrief, ipInterfaceBlockFor,
  interfaceAclLines, type InterfaceAclRefs, ipInterfaceControlLines,
  helperAddressLines,
  renderInterfacesDescription, hostsTableLines, serviceFlagLines,
} from './cisco/CiscoShowCommands';
import { orderCiscoConfigBlocks } from './cisco/ciscoConfigSerializer';
import { describeCiscoArguments } from './cisco/ciscoArgumentHelp';
import { buildActorState } from '@/network/lacp/types';
import { etherChannelLimitFamily } from '@/cli/commands/aggregation/etherChannelLimits';
import {
  parseCiscoAce, renderCiscoAce, formatCiscoAclEntry,
  showAccessListsFrom, isValidIosAclNumber,
  runningConfigACLFrom, runningConfigInterfaceACLFrom, IOS_REMARK_MAX,
} from './cisco/CiscoAclCommands';
import { IOS_ACL_NUMBERING } from '../router/ACLEngine';
import { CISCO_ERRORS, resolveCiscoInterfaceName } from './cli-utils';
import { estTypeSansNumero, typesInterfaceEnMotsCles } from './cisco/CiscoConfigCommands';
import { getNtpAgent, getSnmpService } from '../../equipment/RouterServiceCapabilities';
import { fhrpRunningConfigLines } from '../../fhrp/runningConfig';
import { fhrpViewOf } from './cisco/CiscoShowCommands';
import { hsrpMaxGroup } from '../../hsrp/types';
import {
  buildIdentityConfigCommands, buildIdentitySubmodeCommands, getSecurityConfig,
  type CiscoSecurityShellContext,
} from './cisco/CiscoSecurityCommands';
import { showSwitchVersion, showIpTraffic } from './cisco/CiscoCommonShow';
import { buildArchiveSubmodeOn, buildArchiveLogSubmodeOn } from './cisco/CiscoArchiveCommands';
import type { LoggingCommandContext } from './cisco/CiscoLoggingCommands';
import { buildConfigDhcpCommands, dhcpPoolSpecs } from './cisco/CiscoDhcpCommands';
import { compactVlanList, parseVlanList } from './cli/vlanList';

/** La distance administrative d'une route statique sur IOS. */
const IOS_STATIC_DISTANCE = 1;
import { renderIpRouteTable, staticRouteTail } from './cisco/CiscoShowCommands';
import type { RouteTableHost } from './cisco/CiscoShowCommands';
import {
  ROUTE_FILTER_CODES, bestRoutesPerPrefix, filterRouteTableByCode, renderRouteEntryDetail,
} from './cisco/CiscoOspfCommands';
import {
  dhcpRunningConfigLines, dhcpSnoopingInterfaceLines, dhcpSnoopingRunningConfigLines,
} from '../../dhcp/dhcpRunningConfig';
import type { CiscoShellContext } from './cisco/CiscoConfigCommands';
import type { Router } from '../Router';
import { vrrpVirtualMac } from '../../vrrp/types';
import { hsrpVirtualMac, effectivePriority as hsrpEffectivePriority } from '../../hsrp/types';
import { effectiveWeighting as glbpEffectiveWeighting } from '../../glbp/types';
import { effectivePriority as vrrpEffectivePriority } from '../../vrrp/types';
import type { VrrpGroupRuntime } from '../../vrrp/types';
import type { HsrpGroupRuntime } from '../../hsrp/types';
import type { GlbpGroupRuntime } from '../../glbp/types';
import { iosSviName } from '../inspection/InterfaceStatusView';
import { UDLD_DEFAULT_HELLO_SEC, UDLD_MESSAGE_TIME_RANGE } from '../../udld/types';
import {
  parseFhrpShowArgs, fhrpShowMatches, fhrpInterfaceResolver,
  HSRP_SHOW_GRAMMAR, VRRP_SHOW_GRAMMAR, GLBP_SHOW_GRAMMAR,
} from './cisco/fhrpShowFilter';
import type { FhrpShowGrammar, FhrpShowSelection } from './cisco/fhrpShowFilter';
import { TrackObjectRegistry } from '../switch/TrackObjectRegistry';
import { CliInvalidInput, CliIncomplete } from './cli/CliDiagnostic';
import { describeCiscoSwitchArguments } from './cisco/ciscoArgumentHelp';
import { renderTableText, FIXED_TABLE } from './cli/TextTable';
import {
  INTERFACE_STATUS_COLUMNS, INTERFACE_STATUS_STYLE, type InterfaceStatusRow,
  SPANNING_TREE_COLUMNS, SPANNING_TREE_STYLE, type SpanningTreePortRow,
} from './cisco/ciscoTableLayouts';
import { SOCLE, COMMUTATEUR_SEUL, appliquerContinuations } from './cisco/ciscoContinuations';
import type { ContinuationTable } from './cisco/ciscoContinuations';
import { mstConfigDigest, vlansMappedToInstanceZero } from '@/network/stp/MstConfigId';

/** CLI Mode (FSM State) */
export type CLIMode =
  | 'user' | 'privileged' | 'config' | 'config-if' | 'config-vlan'
  | 'config-mst' | 'config-line' | 'config-acl' | 'config-dhcp'
  | 'config-access-map' | 'config-archive' | 'config-archive-log'
  | 'config-time-range';

/**
 * Raised when a command needs a protocol this switch does not run.
 *
 * This shell also drives `GenericSwitch`, an unmanaged switch, which has
 * none of the Cisco protocol agents (`CiscoSwitch` is the only device
 * that creates them). Every command that read one crashed with
 * `getXxxAgent is not a function` — twelve of them, `vlan <id>` among
 * them, and one throw left the CLI stuck in a mode it could not leave.
 *
 * A dedicated error type, caught in exactly one place (`execute`), is
 * what lets the `require*` accessors below sit inline in forty handlers
 * without each one growing its own guard — and being a named type rather
 * than a blanket `catch`, it cannot swallow a real bug.
 */
class UnsupportedOnThisSwitchError extends Error {}

/** @see CiscoShellBase.isControlFlowError */
function isUnsupportedOnThisSwitch(e: unknown): boolean {
  return e instanceof UnsupportedOnThisSwitchError;
}

/**
 * Un entier dans ses bornes, ou le caret d'IOS a l'endroit du mot.
 *
 * `revision 70000` et `instance 5000 vlan 10` etaient acceptes puis
 * silencieusement ignores par un `isNaN` qui ne regardait que la forme :
 * la region MST prenait alors une revision que le voisin ne verra
 * jamais, et deux commutateurs cessaient d'etre dans la meme region sans
 * qu'un seul message le dise.
 */
function entierBorne(jeton: string, min: number, max: number): number {
  if (!/^\d+$/.test(jeton)) throw new CliInvalidInput({ token: jeton });
  const valeur = Number(jeton);
  if (valeur < min || valeur > max) throw new CliInvalidInput({ token: jeton });
  return valeur;
}

const STP_MODES: ReadonlyArray<string> = ['pvst', 'rapid-pvst', 'mst'];

const PRIORITE_PAR_PAS_DE_4096 = '% Bridge Priority must be in increments of 4096.';

/**
 * Les minuteries du pont, avec les bornes d'IEEE 802.1D qu'IOS applique.
 */
const STP_MINUTERIES: Readonly<Record<string, readonly [number, number]>> = {
  'hello-time': [1, 10],
  'forward-time': [4, 30],
  'max-age': [6, 40],
};

/**
 * Ce que `spanning-tree …` accepte en configuration GLOBALE.
 *
 * Le gestionnaire etait un aiguillage qui n'examinait rien : tout ce
 * qu'il ne reconnaissait pas traversait et rendait la chaine vide, donc
 * `spanning-tree mode zorglub`, `spanning-tree cost 100` — un reglage
 * d'INTERFACE — et `spanning-tree portfast` seul etaient acceptes en
 * silence. Les valeurs ne l'etaient pas davantage : une priorite de pont
 * se pose par PAS de 4096 et IOS refuse tout le reste en le disant
 * (`% Bridge Priority must be in increments of 4096.`), ce que ce
 * simulateur arrondissait sans mot dire — donc `priority 4097` posait
 * 4096 et l'apprenant ne rencontrait jamais la regle.
 *
 * La lecture est faite UNE fois, avant l'aiguillage, pour que la forme
 * acceptee et la forme executee ne puissent pas differer.
 */
function refusReglageStpGlobal(args: readonly string[]): string | null {
  const mot = (i: number): string => (args[i] ?? '').toLowerCase();
  const tete = mot(0);
  if (tete === '') return CISCO_ERRORS.INCOMPLETE;

  const entier = (jeton: string): number | null =>
    /^\d+$/.test(jeton) ? Number(jeton) : null;

  const refusPriorite = (jeton: string): string | null => {
    const valeur = entier(jeton);
    if (valeur === null || valeur > 61440) throw new CliInvalidInput({ token: jeton });
    return valeur % 4096 === 0 ? null : PRIORITE_PAR_PAS_DE_4096;
  };

  if (tete === 'mode') {
    if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
    if (!STP_MODES.includes(mot(1))) throw new CliInvalidInput({ token: args[1] });
    return null;
  }

  if (tete === 'priority') {
    if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
    return refusPriorite(args[1]);
  }

  if (tete === 'vlan') {
    if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
    const liste = analyserListeVlan([args[1]]);
    if ('erreur' in liste) return liste.erreur;
    if (args[2] === undefined) return null;

    const reglage = mot(2);
    if (reglage === 'priority') {
      if (args[3] === undefined) return CISCO_ERRORS.INCOMPLETE;
      return refusPriorite(args[3]);
    }
    if (reglage === 'root') {
      if (args[3] === undefined) return CISCO_ERRORS.INCOMPLETE;
      if (mot(3) !== 'primary' && mot(3) !== 'secondary') {
        throw new CliInvalidInput({ token: args[3] });
      }
      return null;
    }
    const bornes = STP_MINUTERIES[reglage];
    if (bornes === undefined) throw new CliInvalidInput({ token: args[2] });
    if (args[3] === undefined) return CISCO_ERRORS.INCOMPLETE;
    const valeur = entier(args[3]);
    if (valeur === null || valeur < bornes[0] || valeur > bornes[1]) {
      throw new CliInvalidInput({ token: args[3] });
    }
    return null;
  }

  if (tete === 'portfast') {
    /*
     * `spanning-tree portfast` SEUL est une commande d'interface : en
     * configuration globale il lui faut le mot qui dit sur quoi elle
     * porte, et IOS repond « Incomplete » plutot que le caret puisque le
     * mot-cle existe bien.
     */
    if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
    const sous = mot(1);
    if (sous === 'default' || sous === 'edge') return null;
    if (sous === 'bpduguard' || sous === 'bpdufilter') {
      if (args[2] === undefined) return CISCO_ERRORS.INCOMPLETE;
      if (mot(2) !== 'default') throw new CliInvalidInput({ token: args[2] });
      return null;
    }
    throw new CliInvalidInput({ token: args[1] });
  }

  if (tete === 'loopguard') {
    if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
    if (mot(1) !== 'default') throw new CliInvalidInput({ token: args[1] });
    return null;
  }

  if (tete === 'pathcost') {
    if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
    if (mot(1) !== 'method') throw new CliInvalidInput({ token: args[1] });
    if (args[2] === undefined) return CISCO_ERRORS.INCOMPLETE;
    if (mot(2) !== 'long' && mot(2) !== 'short') {
      throw new CliInvalidInput({ token: args[2] });
    }
    return null;
  }

  if (tete === 'extend') {
    if (args[1] === undefined) return CISCO_ERRORS.INCOMPLETE;
    if (mot(1) !== 'system-id') throw new CliInvalidInput({ token: args[1] });
    return null;
  }

  if (tete === 'uplinkfast' || tete === 'backbonefast') return null;

  throw new CliInvalidInput({ token: args[0] });
}

/*
 * Les suites de `spanning-tree` sur un PORT, DECLAREES.
 *
 * Faute de declaration, l'aide les derivait du texte du gestionnaire et
 * n'en trouvait qu'une partie : `spanning-tree ?` offrait `cost` et
 * `port-priority` mais pas `portfast`, le mot le plus tape de la
 * famille, parce qu'il n'apparait dans le corps que sous la forme
 * `isPortFast`. N'y figure que ce que ce commutateur honore vraiment ;
 * `link-type` et `mst`, qui n'ont rien derriere, n'y sont pas.
 */
const STP_INTERFACE_CONTINUATIONS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'bpdufilter', description: 'Don\'t send or receive BPDUs on this interface' },
  { keyword: 'bpduguard', description: 'Don\'t accept BPDUs on this interface' },
  { keyword: 'cost', description: 'Change an interface\'s spanning tree path cost' },
  { keyword: 'guard', description: 'Change an interface\'s spanning tree guard mode' },
  { keyword: 'port-priority', description: 'Change an interface\'s spanning tree port priority' },
  { keyword: 'portfast', description: 'Enable an interface to move directly to forwarding on link up' },
  { keyword: 'vlan', description: 'VLAN Switch Spanning Tree' },
];

/*
 * Ce que `spanning-tree ?` annonce en configuration GLOBALE, et rien de
 * plus : `bpdufilter`, `bpduguard` et les trois minuteries y figuraient
 * alors que l'analyseur les refuse a cette place — elles vivent sous
 * `portfast` pour les deux premieres et sous `vlan <n>` pour les trois
 * autres, comme sur un vrai Catalyst. L'aide promettait donc cinq mots
 * que la machine ne connait pas la.
 */
const STP_GLOBAL_CONTINUATIONS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'backbonefast', description: 'Enable BackboneFast' },
  { keyword: 'extend', description: 'Spanning tree 802.1t extensions' },
  { keyword: 'loopguard', description: 'Default loop guard on all ports' },
  { keyword: 'mode', description: 'Spanning tree operating mode' },
  { keyword: 'mst', description: 'Multiple spanning tree configuration' },
  { keyword: 'pathcost', description: 'Spanning tree pathcost options' },
  { keyword: 'portfast', description: 'Default portfast on access ports' },
  { keyword: 'priority', description: 'Bridge priority of the spanning tree' },
  { keyword: 'uplinkfast', description: 'Enable UplinkFast' },
  { keyword: 'vlan', description: 'Per-VLAN spanning tree configuration' },
];

const STP_GLOBAL_SECOND_LEVEL: ReadonlyArray<
  readonly [string, string, ReadonlyArray<{ keyword: string; description: string }>]
> = [
  ['extend', 'Spanning tree 802.1t extensions', [
    { keyword: 'system-id', description: 'Enable extended system ID' },
  ]],
  ['loopguard', 'Default loop guard on all ports', [
    { keyword: 'default', description: 'Enable loop guard by default on all ports' },
  ]],
  ['pathcost', 'Spanning tree pathcost options', [
    { keyword: 'method', description: 'Method to calculate the default path cost' },
  ]],
  ['portfast', 'Default portfast on access ports', [
    { keyword: 'bpdufilter', description: 'Default BPDU filtering on portfast ports' },
    { keyword: 'bpduguard', description: 'Default BPDU guard on portfast ports' },
    { keyword: 'default', description: 'Enable portfast by default on access ports' },
    { keyword: 'edge', description: 'Portfast edge options' },
  ]],
];

const MAC_TABLE_FILTERS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'address', description: 'A specific MAC address' },
  { keyword: 'count', description: 'MAC address count' },
  { keyword: 'dynamic', description: 'Dynamic MAC entries' },
  { keyword: 'interface', description: 'Entries for a given interface' },
  { keyword: 'multicast', description: 'Multicast MAC entries' },
  { keyword: 'static', description: 'Static MAC entries' },
  { keyword: 'vlan', description: 'Entries for a given VLAN' },
];

const CLEAR_MAC_TABLE_FILTERS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'dynamic', description: 'Dynamically learnt' },
  { keyword: 'interface', description: 'Interface configuration' },
  { keyword: 'vlan', description: 'VLAN configuration' },
];

const STP_VLAN_NUMBER: ArgumentSpec = {
  name: 'vlan', type: 'INT', optional: true, range: [1, 4094],
  description: 'VLAN number',
};

const STP_VLAN_VIEWS: ReadonlyArray<{ keyword: string; description: string }> = [
  { keyword: 'bridge', description: 'Bridge information' },
  { keyword: 'detail', description: 'Detailed output' },
  { keyword: 'root', description: 'Root bridge' },
];

const EXEC: readonly string[] = ['user', 'privileged'];

/** IOS's own abbreviations in the `State` column of `show lacp internal`. */
const IOS_LACP_STATE: Readonly<Record<string, string>> = {
  bundled: 'bndl',
  standby: 'hot-sby',
  standalone: 'indep',
  expired: 'susp',
  sync: 'susp',
  collecting: 'susp',
  distributing: 'susp',
};

function iosLacpState(state: string): string {
  return IOS_LACP_STATE[state] ?? state;
}

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase()}`;
}

const LACP_MODES: Readonly<Record<string, readonly string[]>> = {
  'lacp rate': ['config-if'],
  'lacp port-priority': ['config-if'],
  'show lacp': EXEC,
  'show pagp': EXEC,
};

const UDLD_MODES: Readonly<Record<string, readonly string[]>> = {
  'udld port': ['config-if'],
  'show udld': EXEC,
};

const MONITOR_MODES: Readonly<Record<string, readonly string[]>> = {
  'show monitor': EXEC,
  'show monitor session': EXEC,
};

/*
 * Les deux priorites LACP declarent leur plage pour l'ANNONCER : le
 * gestionnaire la refuse deja dans les mots d'IOS (« % Invalid value;
 * valid range is 1 to 65535 »), et laisser la regle generique parler
 * la premiere remplacerait ce message par un caret muet.
 */
const AGREGATION_PLACES: Readonly<Record<string, ArgumentSpec>> = {
  'lacp system-priority': {
    name: 'priorite', type: 'INT', range: [1, 65535], rangeIsAdvisory: true,
    description: 'LACP system priority',
  },
  'lacp port-priority': {
    name: 'priorite', type: 'INT', range: [1, 65535], rangeIsAdvisory: true,
    description: 'LACP port priority',
  },
  'lacp rate': {
    name: 'rate', type: 'ENUM', description: 'LACPDU transmission rate',
    values: [
      { keyword: 'fast', description: 'Send LACPDUs every second' },
      { keyword: 'normal', description: 'Send LACPDUs every 30 seconds' },
    ],
  },
  /*
   * Les sept methodes etaient acceptees et annoncees NULLE PART : `?`
   * ne rendait que `<cr>`, si bien qu'une valeur qu'on peut taper
   * n'etait trouvable que dans la documentation — ce que `?` existe
   * justement pour eviter. Le gestionnaire les refusait deja hors de
   * cette liste ; il ne lui manquait que sa declaration.
   */
  'port-channel load-balance': {
    name: 'methode', type: 'ENUM', description: 'Load-balancing method',
    values: [
      { keyword: 'dst-ip', description: 'Destination IP address' },
      { keyword: 'dst-mac', description: 'Destination MAC address' },
      { keyword: 'src-dst-ip', description: 'Source and destination IP address' },
      { keyword: 'src-dst-mac', description: 'Source and destination MAC address' },
      { keyword: 'src-dst-port', description: 'Source and destination TCP/UDP port' },
      { keyword: 'src-ip', description: 'Source IP address' },
      { keyword: 'src-mac', description: 'Source MAC address' },
    ],
  },
};

const DAI_CHEMINS: ReadonlySet<string> = new Set([
  'ip arp inspection vlan', 'ip arp inspection validate', 'ip arp inspection filter',
  'errdisable recovery cause arp-inspection', 'errdisable recovery cause bpduguard',
  'errdisable recovery interval',
  'ip arp inspection trust', 'ip arp inspection limit rate',
  'clear ip arp inspection statistics',
]);

const DAI_MODES: Readonly<Record<string, readonly string[]>> = {
  'ip arp inspection trust': ['config-if'],
  'ip arp inspection limit rate': ['config-if'],
  'clear ip arp inspection statistics': ['user', 'privileged'],
};

const DAI_PLACES: Readonly<Record<string, ArgumentSpec>> = {
  'ip arp inspection vlan': {
    name: 'vlans', type: 'REST', description: 'VLAN range', literal: 'WORD',
  },
  'errdisable recovery interval': {
    name: 'secondes', type: 'INT', range: [30, 86400],
    description: 'Timer interval in seconds',
  },
  'ip arp inspection limit rate': {
    name: 'rate', type: 'INT', range: [0, 2048], description: 'Packets per second',
  },
};

const VTP_PLACES: Readonly<Record<string, ArgumentSpec>> = {
  'vtp domain': { name: 'nom', type: 'WORD', description: 'The ascii name for the VTP administrative domain' },
  'vtp password': { name: 'secret', type: 'WORD', description: 'The ascii password for the VTP administrative domain' },
  'vtp mode': {
    name: 'mode', type: 'ENUM', description: 'VTP device mode',
    values: [
      { keyword: 'client', description: 'Set the device to client mode' },
      { keyword: 'off', description: 'Set the device to off mode' },
      { keyword: 'server', description: 'Set the device to server mode' },
      { keyword: 'transparent', description: 'Set the device to transparent mode' },
    ],
  },
  'vtp version': {
    name: 'version', type: 'INT', range: [1, 3], description: 'Set the administrative domain VTP version number',
  },
};

const DOT1X_MODES: Readonly<Record<string, readonly string[]>> = {
  'dot1x system-auth-control': ['config'],
  'show dot1x': ['user', 'privileged'],
};

const DOT1X_PLACES: Readonly<Record<string, ArgumentSpec>> = {
  'dot1x pae': {
    name: 'role', type: 'ENUM', description: '802.1X PAE role',
    values: [
      { keyword: 'authenticator', description: 'Set the port as an IEEE 802.1X authenticator' },
      { keyword: 'supplicant', description: 'Set the port as an IEEE 802.1X supplicant' },
    ],
  },
  'dot1x port-control': {
    name: 'mode', type: 'ENUM', description: '802.1X port control mode',
    values: [
      { keyword: 'auto', description: 'Authorise the port through 802.1X' },
      { keyword: 'force-authorized', description: 'Force the port authorised' },
      { keyword: 'force-unauthorized', description: 'Force the port unauthorised' },
    ],
  },
};

const CONFIG_IF_AUTRES: ReadonlySet<string> = new Set([
  'shutdown', 'no shutdown', 'description', 'no description',
  'duplex', 'speed', 'channel-group', 'no channel-group',
  'mls qos trust cos', 'mls qos trust dscp', 'no mls qos trust', 'mls qos cos',
  'ip dhcp snooping trust', 'ip dhcp snooping limit rate',
  'l2protocol-tunnel', 'private-vlan mapping',
]);

/**
 * Les places de `mac address-table`, declarees plutot que subies.
 *
 * La queue est libre parce que chaque forme a sa propre grammaire — un
 * VLAN et une interface pour une entree statique, l'un OU l'autre pour
 * l'apprentissage — et que les gestionnaires les lisent deja ; ce que
 * la declaration apporte, c'est de NOMMER ce qui peut suivre, la ou une
 * place anonyme laissait l'operateur deviner.
 */
/**
 * Ce que la famille `spanning-tree` globale emmene au socle, et ce
 * qu'elle y laisse.
 *
 * Deux chemins BORNES partent — `mode`, qui n'accepte que trois valeurs,
 * et `mst configuration`, qui n'en prend aucune. La tete GLOUTONNE
 * reste au trie, et c'est mesure plutot que prudent : ses formes n'ont
 * pas la meme grammaire (`vlan <liste> priority <n>`,
 * `portfast bpduguard default`, `pathcost method long`), et la declarer
 * en une place libre faisait refuser `spanning-tree vlan 10` — une
 * frappe que la machine acceptait — parce que la continuation `vlan`
 * devient alors un noeud sans commande. Le manquement est inscrit au
 * `TODO.md`.
 */
const STP_MODE_PLACE: ArgumentSpec = {
  name: 'mode', type: 'ENUM', description: 'Spanning tree operating mode',
  values: [
    { keyword: 'mst', description: 'Multiple spanning tree mode' },
    { keyword: 'pvst', description: 'Per-VLAN spanning tree mode' },
    { keyword: 'rapid-pvst', description: 'Per-VLAN rapid spanning tree mode' },
  ],
};

const MAC_TABLE_PLACES: Readonly<Record<string, readonly ArgumentSpec[]>> = {
  'mac address-table aging-time': [{
    name: 'secondes', type: 'INT', range: [0, 1000000], rangeIsAdvisory: true,
    description: 'Aging time in seconds, 0 to disable aging',
  }],
  'mac address-table static': [{
    name: 'reste', type: 'REST', literal: 'H.H.H',
    description: 'MAC address, then its VLAN and interface',
    alternatives: [
      { keyword: 'vlan', description: 'VLAN of the entry' },
      { keyword: 'interface', description: 'Interface of the entry' },
    ],
  }],
  'mac address-table learning': [{
    name: 'reste', type: 'REST', optional: true, literal: 'LINE',
    description: 'Where learning applies',
    alternatives: [
      { keyword: 'vlan', description: 'Learning on a VLAN' },
      { keyword: 'interface', description: 'Learning on an interface' },
    ],
  }],
};

const VLAN_PLACE = (name: string, description: string): ArgumentSpec =>
  ({ name, type: 'VLAN_ID', description });

const VOICE_VLAN_MODES = [
  { keyword: 'dot1p', description: 'Tag traffic with 802.1p priority' },
  { keyword: 'none', description: 'Do not tell the telephone which VLAN to use' },
  { keyword: 'untagged', description: 'Untagged voice traffic' },
] as const;

type VoiceVlanMode = typeof VOICE_VLAN_MODES[number]['keyword'];

function voiceVlanMode(word: string): VoiceVlanMode | null {
  const trouve = VOICE_VLAN_MODES.find((m) => m.keyword === word.toLowerCase());
  return trouve ? trouve.keyword : null;
}

const SWITCHPORT_PLACES: Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[]>> = {
  'switchport access vlan': VLAN_PLACE('vlan', 'VLAN of the access port'),
  'switchport trunk native vlan': VLAN_PLACE('vlan', 'Native VLAN of the trunk'),
  'switchport voice vlan': {
    name: 'vlan', type: 'WORD', description: 'Voice VLAN of the port',
    alternatives: [
      { keyword: `<${VLAN_MIN}-${VLAN_MAX}>`, description: 'Voice VLAN of the port' },
      ...VOICE_VLAN_MODES,
    ],
  },
  'channel-group': {
    name: 'groupe', type: 'INT', range: [1, 64], description: 'Channel group number',
  },
  'switchport trunk encapsulation': {
    name: 'encapsulation', type: 'ENUM', description: 'Trunking encapsulation',
    values: [
      { keyword: 'dot1q', description: 'Interface uses only 802.1q trunking encapsulation' },
      { keyword: 'isl', description: 'Interface uses only ISL trunking encapsulation' },
      { keyword: 'negotiate', description: 'Device negotiates the trunking encapsulation' },
    ],
  },
};

const VLAN_LIST_KEYWORDS: readonly AdapterKeyword[] = [
  { keyword: 'add', description: 'Add VLANs to the current list' },
  { keyword: 'all', description: 'All VLANs' },
  { keyword: 'except', description: 'All VLANs except the following' },
  { keyword: 'none', description: 'No VLANs' },
  { keyword: 'remove', description: 'Remove VLANs from the current list' },
];

const SWITCHPORT_KEYWORDS: Readonly<Record<string, readonly AdapterKeyword[]>> = {
  'channel-group': [{
    keyword: 'mode', description: 'Etherchannel mode of this interface',
    afterArguments: true,
    argument: {
      name: 'mode', type: 'ENUM', description: 'Etherchannel mode',
      values: [
        { keyword: 'active', description: 'Enable LACP unconditionally' },
        { keyword: 'auto', description: 'Enable PAgP only if a PAgP device is detected' },
        { keyword: 'desirable', description: 'Enable PAgP unconditionally' },
        { keyword: 'on', description: 'Enable Etherchannel only' },
        { keyword: 'passive', description: 'Enable LACP only if a LACP device is detected' },
      ],
    },
  }],
  'switchport trunk allowed vlan': VLAN_LIST_KEYWORDS,
  'switchport trunk pruning vlan': VLAN_LIST_KEYWORDS,
};

type ListeVlan = { ids: number[] } | { erreur: string };

/**
 * La liste de VLAN d'une commande, lue UNE fois pour `vlan` et `no vlan`.
 *
 * Les deux avaient leur lecture, et elles ne bornaient pas la meme
 * chose : la creation refusait `4095` et les VLAN reserves, la
 * suppression n'ecartait que ce qui n'est pas un nombre — donc
 * `no vlan 4095` repondait « VLAN 4095 not found », ce qui decrit un
 * VLAN absent la ou l'identifiant lui-meme n'existe pas, et
 * `no vlan 10,20` n'en supprimait qu'un, le premier, en silence.
 */
function analyserListeVlan(args: readonly string[]): ListeVlan {
  if (args.length < 1) return { erreur: CISCO_ERRORS.INCOMPLETE };

  const ids: number[] = [];
  for (const part of args.join('').split(',')) {
    const plage = part.match(/^(\d+)-(\d+)$/);
    if (plage) {
      const [debut, fin] = [Number(plage[1]), Number(plage[2])];
      if (fin < debut) return { erreur: '% Invalid VLAN ID' };
      for (let i = debut; i <= fin; i++) ids.push(i);
      continue;
    }
    if (!/^\d+$/.test(part)) return { erreur: '% Invalid VLAN ID' };
    ids.push(Number(part));
  }
  if (ids.length === 0 || ids.some(i => i < 1 || i > 4094)) {
    return { erreur: '% Invalid VLAN ID' };
  }
  if (ids.some(i => i >= 1002 && i <= 1005)) {
    return { erreur: '% VLANs 1002-1005 are reserved for legacy FDDI/Token Ring use' };
  }
  return { ids };
}

const CATALYST_INTERFACE_TYPES: readonly { keyword: string; description: string }[] = [
  { keyword: 'FastEthernet', description: 'FastEthernet IEEE 802.3' },
  { keyword: 'GigabitEthernet', description: 'GigabitEthernet IEEE 802.3z' },
  { keyword: 'TenGigabitEthernet', description: 'TenGigabitEthernet IEEE 802.3ae' },
  { keyword: 'Loopback', description: 'Loopback interface' },
  { keyword: 'Port-channel', description: 'Ethernet Channel of interfaces' },
  { keyword: 'Vlan', description: 'Catalyst VLANs' },
  { keyword: 'range', description: 'interface range command' },
];

const PORT_SECURITY_PLACES: Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[]>> = {
  'switchport port-security maximum': {
    name: 'maximum', type: 'INT', range: [1, 3072],
    description: 'Maximum addresses',
  },
  'switchport port-security violation': {
    name: 'violation', type: 'ENUM', description: 'Security violation mode',
    values: [
      { keyword: 'protect', description: 'Security violation protect mode' },
      { keyword: 'restrict', description: 'Security violation restrict mode' },
      { keyword: 'shutdown', description: 'Security violation shutdown mode' },
    ],
  },
  'switchport port-security mac-address': {
    name: 'adresse', type: 'MAC_ADDR', description: '48 bit mac address',
    alternatives: [
      { keyword: 'H.H.H', description: '48 bit mac address' },
      { keyword: 'sticky', description: 'Configure dynamic secure addresses as sticky' },
    ],
  },
  'switchport port-security aging time': {
    name: 'minutes', type: 'INT', range: [0, 1440],
    description: 'Aging time in minutes',
  },
  'switchport port-security aging type': {
    name: 'type', type: 'ENUM', description: 'Aging type',
    values: [
      { keyword: 'absolute', description: 'Absolute aging (default)' },
      { keyword: 'inactivity', description: 'Aging based on inactivity time period' },
    ],
  },
};

const PORT_SECURITY_KEYWORDS: Readonly<Record<string, readonly AdapterKeyword[]>> = {
  'switchport port-security mac-address': [
    {
      keyword: 'sticky', description: 'Configure dynamic secure addresses as sticky',
      argument: {
        name: 'adresse', type: 'MAC_ADDR', optional: true,
        description: '48 bit mac address',
      },
    },
  ],
  'no switchport port-security mac-address': [
    {
      keyword: 'sticky', description: 'Configure dynamic secure addresses as sticky',
      argument: {
        name: 'adresse', type: 'MAC_ADDR', optional: true,
        description: '48 bit mac address',
      },
    },
  ],
};

function stpVlanSpecs(action: (args: string[]) => string): CommandSpec[] {
  const words = ['show', 'spanning-tree', 'vlan'];
  const exec = ['user', 'privileged'];
  const lire = (args: Record<string, string>): string =>
    String(args[STP_VLAN_NUMBER.name] ?? '').trim();

  const specs: CommandSpec[] = [{
    id: words.join('-'),
    path: [...words, STP_VLAN_NUMBER],
    description: 'STP for a VLAN',
    modes: exec, minPrivilege: 1,
    run: ((_session: unknown, args: Record<string, string>) => {
      const vlan = lire(args);
      return action(vlan.length === 0 ? [] : [vlan]);
    }) as CommandSpec['run'],
  }];

  for (const vue of STP_VLAN_VIEWS) {
    specs.push({
      id: [...words, vue.keyword].join('-'),
      path: [...words, STP_VLAN_NUMBER, vue.keyword],
      description: vue.description,
      modes: exec, minPrivilege: 1,
      run: ((_session: unknown, args: Record<string, string>) =>
        action([lire(args), vue.keyword])) as CommandSpec['run'],
    });
  }
  return specs;
}

const privilegeSelonModes = (
  modesParChemin: Readonly<Record<string, readonly string[]>>,
) => (path: string): number | undefined => {
  const nu = path.replace(/^no /, '');
  if (!nu.startsWith('show ')) return undefined;
  return modesParChemin[nu]?.includes('user') ? 1 : undefined;
};

interface SwitchTries {
  config: CommandTrie;
  configIf: CommandTrie;
  privileged: CommandTrie;
  user: CommandTrie;
}

const NO_SPANNING_TREE_KEYWORDS = new Set([
  'backbonefast', 'bpdufilter', 'bpduguard', 'default', 'loopguard',
  'mode', 'pathcost', 'portfast', 'uplinkfast', 'vlan',
]);

const PORT_SECURITY_CLEAR_KINDS: ReadonlyArray<readonly [string, string]> = [
  ['all', 'Clear all secure MAC addresses'],
  ['configured', 'Clear configured secure MAC addresses'],
  ['dynamic', 'Clear dynamically learned secure MAC addresses'],
  ['sticky', 'Clear sticky secure MAC addresses'],
];

export class CiscoSwitchShell extends CiscoShellBase<CiscoSwitch> implements ISwitchShell {
  override versionText(): string {
    return showSwitchVersion(this.d());
  }

  override runningConfigText(): string {
    return this.filtrerConfigurationParNiveau(this.buildRunningConfig(this.d()));
  }

  override runningConfigInterfaceText(argument: string): string {
    if (argument.trim().length === 0) return '% Incomplete command.';
    const name = this.resolveInterfaceName(argument)
      ?? this.virtualInterfaceName(argument) ?? argument;
    return this.blocConfigInterface(name);
  }

  /** Ce shell rend la table avec ses filtres — la base ne doit pas la masquer. */
  protected providesOwnMacAddressTableView(): boolean {
    return true;
  }

  /** A `require*` refusal is a signal for `execute` below, not a crash. */
  protected override isControlFlowError(err: unknown): boolean {
    return isUnsupportedOnThisSwitch(err);
  }

  // ─── Switch-specific state ───────────────────────────────────────
  private selectedInterface: string | null = null;
  private selectedInterfaceRange: string[] = [];
  private selectedVlan: number | null = null;
  private hsrpVersionByIface = new Map<string, 1 | 2>();
  private trackObjects = new TrackObjectRegistry();

  // ─── FSM (switch-specific mode hierarchy) ────────────────────────
  protected readonly fsm = new CLIStateMachine<CLIMode>('user', CISCO_SWITCH_MODES, 'user', 'privileged');

  // ─── Additional tries (beyond base's user/privileged/config/configIf) ─
  private configVlanTrie = new CommandTrie();
  private configMstTrie = new CommandTrie();
  private configArchiveTrie = new CommandTrie();
  private configArchiveLogTrie = new CommandTrie();
  private configDhcpTrie = new CommandTrie();
  private selectedDhcpPool: string | null = null;

  protected override selectDhcpPool(nom: string | null): void {
    this.selectedDhcpPool = nom;
  }

  // STP state (switch-only, L2)
  private stpMode = 'pvst';
  private ifStp = new Map<string, string[]>();
  private ifExtra = new Map<string, string[]>();
  private configAclTrie = new CommandTrie();
  private selectedAcl: string | null = null;
  private selectedAclType: 'standard' | 'extended' = 'extended';
  private selectedArpAcl: string | null = null;
  private configAccessMapTrie = new CommandTrie();
  private configTimeRangeTrie = new CommandTrie();
  private selectedAccessMap: { name: string; seq: number } | null = null;

  constructor() {
    super();
    this.initializeCommands();
    describeCiscoSwitchArguments({
      config: this.configTrie,
      configIf: this.configIfTrie,
      configLine: this.configLineTrie,
      configVlan: this.configVlanTrie,
    });
  }

  // ─── Protocol agents this switch may not have ────────────────────
  //
  // An unmanaged switch runs none of these, so the honest answer to
  // `show vtp status` or `switchport mode dynamic auto` on one is IOS's
  // own answer for a command the platform does not have — not a table
  // describing a protocol nobody is speaking, and not a crash.

  private optionalAgent<T>(getter: string): T | null {
    const dev = this.d() as unknown as Record<string, (() => T) | undefined>;
    return dev[getter]?.call(dev) ?? null;
  }
  private requireAgent<T>(getter: string): T {
    const agent = this.optionalAgent<T>(getter);
    if (!agent) throw new UnsupportedOnThisSwitchError(getter);
    return agent;
  }

  private optionalVtp(): import('../../vtp/VtpAgent').VtpAgent | null {
    return this.optionalAgent('getVtpAgent');
  }
  private optionalDtp(): import('../../dtp/DtpAgent').DtpAgent | null {
    return this.optionalAgent('getDtpAgent');
  }
  private requireVtp(): import('../../vtp/VtpAgent').VtpAgent {
    return this.requireAgent('getVtpAgent');
  }
  private requireDtp(): import('../../dtp/DtpAgent').DtpAgent {
    return this.requireAgent('getDtpAgent');
  }
  private requireStp(): import('../../stp/StpAgent').StpAgent {
    return this.requireAgent('getStpAgent');
  }
  private requireLacp(): import('../../lacp/LacpAgent').LacpAgent {
    return this.requireAgent('getLacpAgent');
  }
  private requireUdld(): import('../../udld/UdldAgent').UdldAgent {
    return this.requireAgent('getUdldAgent');
  }
  private requireIgmpSnooping(): import('../../igmp-snooping/IgmpSnoopingAgent').IgmpSnoopingAgent {
    return this.requireAgent('getIgmpSnoopingAgent');
  }
  private requirePimSnooping(): import('../../pim-snooping/PimSnoopingAgent').PimSnoopingAgent {
    return this.requireAgent('getPimSnoopingAgent');
  }

  // ─── ISwitchShell ────────────────────────────────────────────────

  execute(sw: CiscoSwitch, input: string): string {
    const dbg = (sw as unknown as { getDebugService?: () => { subscribe(l: (line: string) => void): () => void; isStpEnabled(): boolean } }).getDebugService?.();
    this.attachDebugSource(dbg);
    if (input.trim() === '' && !this.isCollectingBanner()) return this.drainDebugConsole();
    const before = dbg?.isStpEnabled() ? new Map(sw._getSTPStates()) : null;
    let out: string;
    try {
      out = this.diffuserSurPlage(sw, input) ?? (this.executeOnDevice(sw, input) as string);
    } catch (e) {
      // The one place a `require*` refusal becomes an answer. IOS's own
      // wording for a command the platform does not have — an unmanaged
      // switch has no VTP, no DTP, no EtherChannel to configure.
      if (!(e instanceof UnsupportedOnThisSwitchError)) throw e;
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (before) {
      const events = this.stpDebugEvents(sw, before);
      if (events) out = out ? `${out}\n${events}` : events;
    }
    return out;
  }

  private stpDebugEvents(sw: CiscoSwitch, before: Map<string, import('../../devices/Switch').STPPortState>): string {
    const stamp = new Date().toISOString().slice(11, 19);
    const lines: string[] = [];
    for (const [port, state] of sw._getSTPStates()) {
      if (before.get(port) === state) continue;
      const cfg = sw.getSwitchportConfig(port);
      const vlan = cfg && cfg.mode !== 'trunk' ? cfg.accessVlan : 1;
      lines.push(`*${stamp}: STP: VLAN${String(vlan).padStart(4, '0')} ${this.abbreviateInterface(port)} -> ${state}`);
    }
    return lines.join('\n');
  }

  getPrompt(sw: CiscoSwitch): string {
    return this.buildDevicePrompt(sw);
  }

  override getMode(): CLIMode { return this.mode as CLIMode; }

  resetCliMode(): void {
    this.mode = 'user';
    this.selectedInterface = null;
    this.selectedInterfaceRange = [];
    this.selectedVlan = null;
    this.selectedAcl = null;
    this.selectedArpAcl = null;
    this.selectedDhcpPool = null;
    this.selectedAccessMap = null;
  }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  getSelectedInterfaceRange(): string[] { return [...this.selectedInterfaceRange]; }

  // ─── Per-vty state snapshot / swap (mirrors CiscoIOSShell — the switch
  // shell is likewise a single instance shared by every open terminal) ──

  snapshotVtyState(): import('./vty/CliShellSession').VtySnapshot {
    return {
      mode: this.mode,
      selectedInterface: this.selectedInterface,
      selectedInterfaceRange: [...this.selectedInterfaceRange],
      selectedVlan: this.selectedVlan,
      selectedArpAcl: this.selectedArpAcl,
      selectedAccessMap: this.selectedAccessMap,
      selectedMqcName: null,
      selectedPortGroup: null,
      selectedRoutingProto: null,
      selectedTrack: null,
      selectedIpSla: null,
      selectedRouteMap: null,
      selectedDHCPPool: this.selectedDhcpPool,
      selectedACL: this.selectedAcl,
      selectedACLType: this.selectedAclType,
      selectedISAKMPPriority: null,
      selectedTransformSet: null,
      selectedCryptoMap: null,
      selectedCryptoMapSeq: null,
      selectedCryptoMapIsDynamic: false,
      selectedIPSecProfile: null,
      selectedIKEv2Proposal: null,
      selectedIKEv2Policy: null,
      selectedIKEv2Keyring: null,
      selectedIKEv2KeyringPeer: null,
      selectedIKEv2Profile: null,
      terminalLength: this.terminalLength,
      terminalWidth: this.terminalWidth,
      terminalMonitor: this.terminalMonitor,
      terminalMonitorExplicit: this.terminalMonitorExplicit,
      terminalDebugging: this.terminalMonitor,
      privilegeLevel: this.currentPrivilegeLevel,
      activeParserView: this.activeParserView,
      sessionUser: this.utilisateurDeSession(),
      historySize: this.terminalHistorySize,
      cmdHistory: [...this.cmdHistory],
    };
  }

  applyVtyState(s: import('./vty/CliShellSession').VtySnapshot): void {
    this.mode = s.mode as CLIMode;
    this.currentPrivilegeLevel = s.privilegeLevel;
    this.activeParserView = s.activeParserView ?? null;
    this.adopterUtilisateurDeSession(s.sessionUser ?? null);
    this.selectedInterface = s.selectedInterface;
    this.selectedInterfaceRange = [...s.selectedInterfaceRange];
    this.selectedVlan = s.selectedVlan;
    this.selectedArpAcl = s.selectedArpAcl;
    this.selectedAccessMap = s.selectedAccessMap as typeof this.selectedAccessMap;
    this.selectedDhcpPool = s.selectedDHCPPool;
    this.selectedAcl = s.selectedACL;
    this.selectedAclType = s.selectedACLType ?? 'extended';
    this.terminalLength = s.terminalLength;
    this.terminalWidth = s.terminalWidth;
    this.terminalMonitor = s.terminalMonitor;
    this.terminalMonitorExplicit = s.terminalMonitorExplicit ?? false;
    this.cmdHistory = [...s.cmdHistory];
  }

  // ─── Abstract Method Implementations ─────────────────────────────

  protected getPromptMap(): PromptMap { return CISCO_SWITCH_PROMPTS; }

  /**
   * `write memory` sur un Catalyst ecrit `Building configuration...`
   * avant `[OK]`, exactement comme sur un routeur — la meme commande
   * rendait deux textes selon la plateforme, alors qu'IOS n'en a qu'un.
   */
  protected onSave(): string {
    const out = this.d().writeMemory();
    this.archiveAfterSave();
    return out === '[OK]' ? 'Building configuration...\n[OK]' : out;
  }

  private readonly configRadiusServerTrie = new CommandTrie();
  private readonly configTacacsServerTrie = new CommandTrie();
  private readonly configAaaGroupTrie = new CommandTrie();
  private selectedRadiusServer: string | null = null;
  private selectedTacacsServer: string | null = null;
  private selectedAaaGroup: string | null = null;

  protected getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user':        return this.userTrie;
      case 'privileged':  return this.privilegedTrie;
      case 'config':      return this.configTrie;
      case 'config-if':   return this.configIfTrie;
      case 'config-vlan': return this.configVlanTrie;
      case 'config-mst':  return this.configMstTrie;
      case 'config-archive':     return this.configArchiveTrie;
      case 'config-archive-log': return this.configArchiveLogTrie;
      case 'config-line': return this.configLineTrie;
      // Un Catalyst connait les CLI Views tout autant qu'un routeur. Sans
      // ce cas, `parser view NOC` creait la vue et `secret`/`commands`
      // tombaient sur l'arbre UTILISATEUR : on obtenait une vue qui
      // existe, ne peut rien contenir, et dans laquelle on peut entrer.
      case 'config-view': return this.configViewTrie;
      case 'config-acl':  return this.configAclTrie;
      case 'config-dhcp': return this.configDhcpTrie;
      case 'config-access-map': return this.configAccessMapTrie;
      case 'config-time-range': return this.configTimeRangeTrie;
      case 'config-radius-server': return this.configRadiusServerTrie;
      case 'config-tacacs-server': return this.configTacacsServerTrie;
      case 'config-aaa-group':     return this.configAaaGroupTrie;
      default:            return this.userTrie;
    }
  }

  protected clearFields(fields: string[]): void {
    for (const f of fields) {
      if (f === 'selectedInterface') this.selectedInterface = null;
      if (f === 'selectedInterfaceRange') this.selectedInterfaceRange = [];
      if (f === 'selectedVlan') this.selectedVlan = null;
      if (f === 'selectedAcl') { this.selectedAcl = null; this.selectedArpAcl = null; }
      if (f === 'selectedDhcpPool') this.selectedDhcpPool = null;
      if (f === 'selectedAccessMap') this.selectedAccessMap = null;
      if (f === 'selectedRadiusServer') this.selectedRadiusServer = null;
      if (f === 'selectedTacacsServer') this.selectedTacacsServer = null;
      if (f === 'selectedAaaGroup') this.selectedAaaGroup = null;
    }
  }

  // ─── Switch-Specific Command Registration ─────────────────────────

  protected registerDeviceCommands(): void {
    // ── User mode ──
    this.registerUserCommands();

    // ── Privileged mode ──
    this.registerPrivilegedCommands();

    // ── Config mode ──
    this.registerConfigCommands();

    // ── Config-if mode ──
    this.registerConfigIfCommands(this.configIfTrie);

    // ── Config-vlan mode ──
    this.configVlanTrie.registerGreedy('name', 'Set VLAN name', (args) => {
      if (!this.selectedVlan || args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const ok = this.d().renameVLAN(this.selectedVlan, args[0]);
      if (ok) this.optionalVtp()?.onLocalVlanChange();
      return ok ? '' : '% VLAN not found';
    });

    this.configVlanTrie.registerGreedy('private-vlan', 'Configure private VLAN role/association', (args) => {
      if (!this.selectedVlan || args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const sub = args[0].toLowerCase();
      if (sub === 'primary' || sub === 'isolated' || sub === 'community') {
        const res = this.d().setPrivateVlanRole(this.selectedVlan, sub);
        return res.ok ? '' : `% ${res.error}`;
      }
      if (sub === 'association') {
        if (!args[1]) return CISCO_ERRORS.INCOMPLETE;
        const idSet = this.parseVlanList(args[1]);
        if (!idSet) return '% Invalid VLAN list';
        const res = this.d().associatePrivateVlan(this.selectedVlan, [...idSet]);
        return res.ok ? '' : `% ${res.error}`;
      }
      return CISCO_ERRORS.INCOMPLETE;
    });

    // ── Spanning Tree (L2, switch-only) ──
    this.registerStpCommands();

    // ── ACL + DAI (switch-only; router has its own ACL impl) ──
    // Le moteur est le SEUL magasin. Il y en avait deux : un echo du texte
    // tape, affiche par `show access-lists`, et les entrees du moteur, qui
    // seules filtrent. Ils divergeaient -- la vue montrait `eq 443` que le
    // moteur n'avait jamais enregistre.
    this.configTrie.registerGreedy('access-list', 'Numbered ACL entry', (args) => {
      const id = parseInt(args[0] ?? '', 10);
      if (isNaN(id) || !isValidIosAclNumber(id)) return CISCO_ERRORS.INVALID_INPUT;
      const action = args[1]?.toLowerCase();
      if (action === 'remark') {
        const texte = args.slice(2).join(' ');
        if (texte.length === 0) return CISCO_ERRORS.INCOMPLETE;
        this.d().getVaclEngine().addAccessListEntry(id, 'permit', {
          srcIP: new IPAddress('0.0.0.0'),
          srcWildcard: new SubnetMask('255.255.255.255'),
          remark: texte.slice(0, IOS_REMARK_MAX),
        });
        return '';
      }
      if (action !== 'permit' && action !== 'deny') return CISCO_ERRORS.INCOMPLETE;
      const type = IOS_ACL_NUMBERING(id);
      const parsed = parseCiscoAce(args.slice(2), type);
      if ('error' in parsed) return parsed.error;
      this.d().getVaclEngine().addAccessListEntry(id, action, parsed.opts);
      return '';
    });

    this.configTrie.registerGreedy('vlan access-map', 'Configure a VLAN access map', (args) => {
      if (!args[0]) return CISCO_ERRORS.INCOMPLETE;
      const seq = args[1] !== undefined ? parseInt(args[1], 10) : 10;
      if (isNaN(seq)) return '% Invalid sequence number';
      this.selectedAccessMap = { name: args[0], seq };
      this.d().setVlanAccessMapRule(args[0], seq);
      this.mode = 'config-access-map';
      return '';
    });
    this.configTrie.registerGreedy('no vlan access-map', 'Remove a VLAN access map', (args) => {
      if (!args[0]) return CISCO_ERRORS.INCOMPLETE;
      this.d().removeVlanAccessMap(args[0]);
      return '';
    });
    this.configTrie.registerGreedy('vlan filter', 'Apply a VLAN access map to VLANs', (args) => {
      const li = args.findIndex(a => a.toLowerCase() === 'vlan-list');
      if (li < 0 || !args[0] || !args[li + 1]) return CISCO_ERRORS.INCOMPLETE;
      const vlans = this.parseVlanList(args.slice(li + 1).join(','));
      if (!vlans) return '% Invalid VLAN list';
      const res = this.d().applyVlanFilter(args[0], [...vlans]);
      return res.ok ? '' : `% ${res.error}`;
    });
    this.configTrie.registerGreedy('no vlan filter', 'Remove a VLAN access map binding', (args) => {
      if (!args[0]) return CISCO_ERRORS.INCOMPLETE;
      const li = args.findIndex(a => a.toLowerCase() === 'vlan-list');
      const vlans = li >= 0 && args[li + 1] ? this.parseVlanList(args.slice(li + 1).join(',')) : null;
      this.d().removeVlanFilter(args[0], vlans ? [...vlans] : undefined);
      return '';
    });

    this.configAccessMapTrie.registerGreedy('match ip address', 'Match an IP ACL', (args) => {
      if (!this.selectedAccessMap || !args[0]) return CISCO_ERRORS.INCOMPLETE;
      const rule = this.d().setVlanAccessMapRule(this.selectedAccessMap.name, this.selectedAccessMap.seq);
      rule.matchIpAcl = args[0];
      return '';
    });
    this.configAccessMapTrie.registerGreedy('action', 'Set the access-map action', (args) => {
      if (!this.selectedAccessMap) return CISCO_ERRORS.INCOMPLETE;
      const a = args[0]?.toLowerCase();
      if (a !== 'forward' && a !== 'drop') return '% Invalid action';
      const rule = this.d().setVlanAccessMapRule(this.selectedAccessMap.name, this.selectedAccessMap.seq);
      rule.action = a;
      return '';
    });
    this.configTrie.registerGreedy('track', 'Tracked object registry', (args) => {
      const lu = parseTrackDefinition(args);
      if (lu.idInvalide) return TRACK_INVALID_ID;
      if (lu.incomplet) return CISCO_ERRORS.INCOMPLETE;
      if (lu.refus !== undefined || !lu.definition) return CISCO_ERRORS.INVALID_INPUT;
      const def = lu.definition;
      if (def.type !== 'interface-line' && def.type !== 'interface-routing') {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      const iface = this.resolveInterfaceName(def.iface ?? '') ?? def.iface ?? '';
      this.trackObjects.set(
        def.id, iface,
        def.type === 'interface-routing' ? 'ip-routing' : 'line-protocol');
      return '';
    });
    this.configTrie.registerGreedy('no track', 'Remove a tracked object', (args) => {
      const id = parseInt(args[0] ?? '', 10);
      if (Number.isFinite(id)) this.trackObjects.delete(id);
      return '';
    });
    this.configTrie.registerGreedy('ip access-list', 'Named ACL', (args) => {
      const kind = args[0]?.toLowerCase();
      if (kind === 'resequence') {
        const [, name, debut, pas] = args;
        if (!name || debut === undefined || pas === undefined) return CISCO_ERRORS.INCOMPLETE;
        const start = parseInt(debut, 10);
        const step = parseInt(pas, 10);
        if (isNaN(start) || isNaN(step)) return CISCO_ERRORS.INVALID_INPUT;
        return this.d().getVaclEngine().resequenceNamedACL(name, start, step)
          ? '' : `% Access-list ${name} not found`;
      }
      if (kind !== 'standard' && kind !== 'extended') return CISCO_ERRORS.INVALID_INPUT;
      // Le nom etait facultatif par accident (`args[1] ?? args[0]`), de
      // sorte que `ip access-list standard` creait une liste NOMMEE
      // « standard ».
      const name = args[1];
      if (!name) return CISCO_ERRORS.INCOMPLETE;
      this.selectedAclType = kind;
      this.selectedAcl = name;
      this.d().getVaclEngine().ensureNamedAccessList(name, kind);
      this.mode = 'config-acl';
      return '';
    });

    // Les deux formes en `no` n'existaient PAS : une liste posée sur un
    // Catalyst ne pouvait plus être retirée. Le défaut ne se voyait pas
    // tant que la configuration ne rendait aucune liste — elle en rend
    // désormais, et c'est elle qui est rejouée à l'import.
    this.configTrie.registerGreedy('no access-list', 'Remove a numbered ACL', (args) => {
      const id = parseInt(args[0] ?? '', 10);
      if (isNaN(id) || !isValidIosAclNumber(id)) return CISCO_ERRORS.INVALID_INPUT;
      this.d().getVaclEngine().removeAccessList(id);
      return '';
    });
    this.configTrie.registerGreedy('no ip access-list', 'Remove a named ACL', (args) => {
      const kind = args[0]?.toLowerCase();
      if (kind !== 'standard' && kind !== 'extended') return CISCO_ERRORS.INVALID_INPUT;
      if (!args[1]) return CISCO_ERRORS.INCOMPLETE;
      this.d().getVaclEngine().removeNamedAccessList(args[1]);
      return '';
    });
    this.registerDaiCommands({
      config: this.configTrie, configIf: this.configIfTrie,
      privileged: this.privilegedTrie, user: this.userTrie,
    });
    this.registerPortSecurityCommands();
    this.registerVtpCommands(this.configTrie);
    this.registerUdldCommands({
      config: this.configTrie, configIf: this.configIfTrie,
      privileged: this.privilegedTrie, user: this.userTrie,
    });
    this.registerIgmpSnoopingCommands();
    this.registerPimSnoopingCommands();
    this.registerMonitorSessionCommands({
      config: this.configTrie, configIf: this.configIfTrie,
      privileged: this.privilegedTrie, user: this.userTrie,
    });
    for (const kw of ['permit', 'deny', 'remark', 'no', 'evaluate']) {
      this.configAclTrie.registerGreedy(kw, `ACL ${kw}`, (args) => {
        if (this.selectedArpAcl) return this.handleArpAclLine(kw, args);
        if (!this.selectedAcl) return '';
        return this.handleNamedAclLine(kw, args);
      });
    }
    // `10 permit ip any any` — une entree numerotee. Elle etait poussee
    // dans le magasin de texte et n'atteignait NI le moteur NI, en fait,
    // la vue : elle disparaissait entierement, en silence.
    //
    // `CiscoShellBase` reecrit deja un chiffre initial en `sequence <…>`
    // dans une sous-vue d'ACL ; il fallait que le mode du commutateur en
    // soit une (voir `isAclSubMode` plus bas) et que `sequence` existe.
    this.configAclTrie.registerGreedy('sequence', 'Sequence number', (args) => {
      if (!this.selectedAcl) return '';
      const seq = parseInt(args[0] ?? '', 10);
      if (isNaN(seq)) return '% Invalid sequence number.';
      const kw = args[1]?.toLowerCase();
      if (kw !== 'permit' && kw !== 'deny') return CISCO_ERRORS.INVALID_INPUT;
      return this.handleNamedAclLine(kw, args.slice(2), seq);
    });
    this.registerL3Commands();
    for (const t of [this.userTrie, this.privilegedTrie]) {
      const vueAcl = (args: string[]): string =>
        showAccessListsFrom(this.d().getVaclEngine().getAccessListsInternal(), args[0]);
      t.registerGreedy('show access-lists', 'Display ACLs', vueAcl);
      t.registerGreedy('show ip access-lists', 'Display IP access lists', vueAcl);
      t.registerGreedy('show port-security', 'Display port security', (args) => {
        if (args[0]?.toLowerCase() === 'interface' && args[1]) {
          return this.showPortSecurityInterface(this.d(), args.slice(1).join(' '));
        }
        if (args[0]?.toLowerCase() === 'address') {
          return this.showPortSecurityAddress(this.d());
        }
        return this.showPortSecurityOverview(this.d());
      });
    }

    this.registerShowCompletionKeywords();
  }

  private registerDaiCommands(trie: SwitchTries): void {
    const parseList = (spec: string): number[] => {
      const out: number[] = [];
      for (const part of spec.split(',')) {
        const m = part.match(/^(\d+)-(\d+)$/);
        if (m) { for (let i = +m[1]; i <= +m[2]; i++) out.push(i); }
        else { const n = parseInt(part, 10); if (!isNaN(n)) out.push(n); }
      }
      return out;
    };

    // ── Global ── ip arp inspection vlan <list>
    trie.config.registerGreedy('ip arp inspection vlan', 'Enable DAI on VLAN(s)', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const cfg = this.d()._getArpInspectionConfig();
      for (const v of parseList(args.join(','))) cfg.vlans.add(v);
      return '';
    });
    trie.config.registerGreedy('no ip arp inspection vlan', 'Disable DAI on VLAN(s)', (args) => {
      const cfg = this.d()._getArpInspectionConfig();
      for (const v of parseList(args.join(','))) cfg.vlans.delete(v);
      return '';
    });
    trie.config.registerGreedy('ip arp inspection validate', 'Extra DAI checks', (args) => {
      const cfg = this.d()._getArpInspectionConfig();
      for (const tok of args) {
        const k = tok.toLowerCase();
        if (k === 'src-mac') cfg.validate.srcMac = true;
        else if (k === 'dst-mac') cfg.validate.dstMac = true;
        else if (k === 'ip') cfg.validate.ip = true;
      }
      return '';
    });
    trie.config.registerGreedy('no ip arp inspection validate', 'Clear DAI checks', (args) => {
      const cfg = this.d()._getArpInspectionConfig();
      if (args.length === 0) {
        cfg.validate.srcMac = false; cfg.validate.dstMac = false; cfg.validate.ip = false;
      } else for (const tok of args) {
        const k = tok.toLowerCase();
        if (k === 'src-mac') cfg.validate.srcMac = false;
        else if (k === 'dst-mac') cfg.validate.dstMac = false;
        else if (k === 'ip') cfg.validate.ip = false;
      }
      return '';
    });
    trie.config.registerGreedy('ip arp inspection filter', 'Apply ARP ACL to VLAN(s)', (args) => {
      // ip arp inspection filter <acl> vlan <list> [static]
      const aclName = args[0]; const vlanIdx = args.indexOf('vlan');
      if (!aclName || vlanIdx < 1) return CISCO_ERRORS.INCOMPLETE;
      const list = args[vlanIdx + 1];
      if (!list) return CISCO_ERRORS.INCOMPLETE;
      const isStatic = args[vlanIdx + 2]?.toLowerCase() === 'static';
      const cfg = this.d()._getArpInspectionConfig();
      for (const v of parseList(list)) cfg.vlanAclFilters.set(v, { aclName, staticMode: isStatic });
      return '';
    });
    trie.config.registerGreedy('errdisable recovery cause arp-inspection',
      'Auto-recover DAI err-disabled ports', () => {
        const cfg = this.d()._getArpInspectionConfig();
        if (cfg.errDisableRecoverySec <= 0) this.d()._setArpRecoverySec(30);
        return '';
      });
    trie.config.registerGreedy('errdisable recovery cause bpduguard',
      'Auto-recover BPDU Guard err-disabled ports', () => {
        const sw = this.d();
        if (sw._getBpduGuardRecoverySec?.() === 0) sw._setBpduGuardRecoverySec?.(30);
        return '';
      });
    trie.config.registerGreedy('errdisable recovery interval',
      'Auto-recovery interval (sec)', (args) => {
        const n = parseInt(args[0] ?? '', 10);
        if (isNaN(n) || n <= 0) return '';
        // IOS keeps one interval for every cause, not one per cause.
        this.d()._setArpRecoverySec(n);
        const sw = this.d();
        if ((sw._getBpduGuardRecoverySec?.() ?? 0) > 0) sw._setBpduGuardRecoverySec?.(n);
        return '';
      });

    // ── arp access-list ──
    trie.config.registerGreedy('arp access-list', 'Define an ARP ACL', (args) => {
      const name = args[0]; if (!name) return CISCO_ERRORS.INCOMPLETE;
      const map = this.d()._getArpAccessLists();
      if (!map.has(name)) map.set(name, { name, entries: [] });
      this.selectedArpAcl = name;
      this.selectedAcl = null;
      this.mode = 'config-acl';
      return '';
    });

    // ── Interface ── trust + limit rate
    trie.configIf.register('ip arp inspection trust', 'Trust port for DAI', () => {
      const cfg = this.d()._getArpInspectionConfig();
      return this.applyToSelectedInterfaces(p => { cfg.trustedPorts.add(p); return ''; });
    });
    trie.configIf.register('no ip arp inspection trust', 'Untrust port for DAI', () => {
      const cfg = this.d()._getArpInspectionConfig();
      return this.applyToSelectedInterfaces(p => { cfg.trustedPorts.delete(p); return ''; });
    });
    trie.configIf.registerGreedy('ip arp inspection limit rate', 'Per-port pps cap', (args) => {
      const r = parseInt(args[0] ?? '', 10);
      if (isNaN(r) || r < 0) return '% Invalid rate value';
      const cfg = this.d()._getArpInspectionConfig();
      return this.applyToSelectedInterfaces(p => { cfg.rateLimits.set(p, r); return ''; });
    });

    // ── Show ──

    // ── clear / recovery ──
    trie.privileged.register('clear ip arp inspection statistics',
      'Reset DAI counters', () => { this.d()._resetArpInspectionStats(); return ''; });
    trie.privileged.registerGreedy('clear spanning-tree detected-protocols',
      'Restart protocol migration', () => '');
    trie.privileged.registerGreedy('clear spanning-tree counters',
      'Clear spanning-tree counters', () => '');
    // Quatre noeuds INTERMEDIAIRES nes de l'enregistrement de chemins
    // plus profonds, donc sans description propre : `?` les offrait nus.
    // Ils n'etaient visibles que depuis l'EXEC d'un Catalyst, que le
    // garde-fou des descriptions ne parcourait pas ; `do ?` les expose
    // desormais depuis la configuration, ou il passe.
    trie.privileged.describeNode('clear spanning-tree', 'Spanning trees');
    trie.privileged.describeNode('show errdisable', 'Error-disable configuration');
    trie.privileged.describeNode('show queuing', 'Show queueing configuration');
  }

  private handleArpAclLine(kw: string, args: string[]): string {
    if (!this.selectedArpAcl) return '';
    const map = this.d()._getArpAccessLists();
    const acl = map.get(this.selectedArpAcl);
    if (!acl) return '';
    if (kw === 'no') {
      const raw = args.join(' ');
      const idx = acl.entries.findIndex(e => e.raw === raw);
      if (idx >= 0) acl.entries.splice(idx, 1);
      return '';
    }
    if (kw !== 'permit' && kw !== 'deny') return '';
    // Syntax: permit ip {host <ip>|any} mac {host <mac>|any}
    let i = 0;
    let senderIp: string | null = null;
    let senderMac: string | null = null;
    if (args[i]?.toLowerCase() === 'ip') {
      i++;
      if (args[i]?.toLowerCase() === 'host') { senderIp = args[i + 1] ?? null; i += 2; }
      else if (args[i]?.toLowerCase() === 'any') { i++; }
    }
    if (args[i]?.toLowerCase() === 'mac') {
      i++;
      if (args[i]?.toLowerCase() === 'host') { senderMac = (args[i + 1] ?? '').toLowerCase() || null; i += 2; }
      else if (args[i]?.toLowerCase() === 'any') { i++; }
    }
    acl.entries.push({
      action: kw, senderIp, senderMac,
      raw: `${kw} ${args.join(' ')}`.trim(),
    });
    return '';
  }

  private registerPortSecurityCommands(): void {
    this.registerPortSecurityOn(this.configIfTrie);
    this.registerSviAddressingCommands();
  }

  private registerPortSecurityOn(trie: CommandTrie): void {
    const parseMac = (s: string): MACAddress | null => {
      try { return new MACAddress(s); } catch { return null; }
    };

    // ── enable / disable ──
    trie.register('switchport port-security', 'Enable port-security', () =>
      this.applyToSelectedInterfaces(p => {
        const port = this.d().getPort(p); if (port) port.getPortSecurity().enable();
        return '';
      }));
    trie.register('no switchport port-security', 'Disable port-security', () =>
      this.applyToSelectedInterfaces(p => {
        const port = this.d().getPort(p); if (port) port.getPortSecurity().disable();
        return '';
      }));

    // ── maximum ──
    trie.registerGreedy('switchport port-security maximum',
      'Max secure MAC addresses', (args) => {
        const n = parseInt(args[0] ?? '', 10);
        if (isNaN(n) || n < 1) return '% Invalid maximum value';
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setMaxMACAddresses(n);
          return '';
        });
      });

    // ── violation mode ──
    trie.registerGreedy('switchport port-security violation',
      'Violation mode', (args) => {
        const m = (args[0] ?? '').toLowerCase();
        if (m !== 'shutdown' && m !== 'restrict' && m !== 'protect') return '% Invalid mode';
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p);
          if (port) port.getPortSecurity().setViolationMode(m as 'shutdown' | 'restrict' | 'protect');
          return '';
        });
      });

    // ── mac-address (static + sticky toggle + sticky <mac>) ──
    trie.registerGreedy('switchport port-security mac-address',
      'Configure secure MAC', (args) => {
        if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
        if (args[0].toLowerCase() === 'sticky') {
          if (args.length === 1) {
            return this.applyToSelectedInterfaces(p => {
              const port = this.d().getPort(p); if (port) port.getPortSecurity().enableSticky();
              return '';
            });
          }
          const mac = parseMac(args[1]); if (!mac) return `% Invalid MAC "${args[1]}"`;
          return this.applyToSelectedInterfaces(p => {
            const port = this.d().getPort(p); if (port) port.getPortSecurity().addStickyMAC(mac);
            return '';
          });
        }
        const mac = parseMac(args[0]); if (!mac) return `% Invalid MAC "${args[0]}"`;
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().addStaticMAC(mac);
          return '';
        });
      });
    trie.registerGreedy('no switchport port-security mac-address',
      'Remove secure MAC', (args) => {
        if (args.length === 0) return CISCO_ERRORS.INCOMPLETE;
        if (args[0].toLowerCase() === 'sticky' && args.length === 1) {
          return this.applyToSelectedInterfaces(p => {
            const port = this.d().getPort(p); if (port) port.getPortSecurity().disableSticky();
            return '';
          });
        }
        const target = args[args.length - 1];
        const mac = parseMac(target); if (!mac) return `% Invalid MAC "${target}"`;
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().removeMAC(mac);
          return '';
        });
      });

    // ── aging ──
    trie.registerGreedy('switchport port-security aging time',
      'Aging window (minutes)', (args) => {
        const n = parseInt(args[0] ?? '', 10);
        if (isNaN(n) || n < 0) return '% Invalid aging time';
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setAgingTimeMin(n);
          return '';
        });
      });
    trie.registerGreedy('switchport port-security aging type',
      'Aging strategy', (args) => {
        const t = (args[0] ?? '').toLowerCase();
        if (t !== 'absolute' && t !== 'inactivity') return '% Invalid aging type';
        return this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setAgingType(t as 'absolute' | 'inactivity');
          return '';
        });
      });
    trie.register('switchport port-security aging static',
      'Apply aging to static entries', () =>
        this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setAgingStatic(true);
          return '';
        }));
    trie.register('no switchport port-security aging static',
      'Exempt static entries from aging', () =>
        this.applyToSelectedInterfaces(p => {
          const port = this.d().getPort(p); if (port) port.getPortSecurity().setAgingStatic(false);
          return '';
        }));

  }

  private registerSviAddressingCommands(): void {
    // ── SVI (management Vlan interface) L3 addressing ──
    // L2-only switch: physical ports cannot hold an IP. A management SVI
    // (interface Vlan N) may, mirroring a real Layer-2 switch.

    // La PACL — `ip access-group` sur un port du commutateur — était
    // REFUSÉE, alors que le plan de données la lit depuis toujours
    // (`Switch.portAclPermits` interroge `getVaclEngine()` à chaque
    // trame) : le moteur, la liaison et le filtrage existaient, il
    // manquait la commande qui les relie.


    // ── errdisable recovery ──
    this.configTrie.register('errdisable recovery cause psecure-violation',
      'Auto-recover ports err-disabled by port-security', () => {
        if (this.d()._getPsecRecoverySec() <= 0) this.d()._setPsecRecoverySec(30);
        return '';
      });

    // ── clear ──
    for (const [genre, description] of PORT_SECURITY_CLEAR_KINDS) {
      this.privilegedTrie.registerGreedy(`clear port-security ${genre}`, description,
        (args) => this.clearPortSecurity(genre, args));
    }
    this.privilegedTrie.describeNode('clear port-security', 'Clear secure MAC entries');
    // `describeNode` sort en silence sur un noeud absent : l'appel doit
    // SUIVRE l'enregistrement qui cree le noeud intermediaire.
    this.privilegedTrie.registerGreedy('clear errdisable interface',
      'Recover an err-disabled port', (args) => {
        const portName = this.resolveInterfaceName(args.join(' ')) ?? args.join(' ');
        const cleared = this.d()._clearArpInspectionErrDisable(portName)
          || this.d()._clearPsecErrDisable(portName)
          || (this.d()._clearBpduGuardErrDisable?.(portName) ?? false);
        return cleared ? '' : '';
      });
    this.privilegedTrie.describeNode('clear errdisable', 'Error-disable state');
  }

  private clearPortSecurity(genre: string, args: readonly string[]): string {
    let portFilter: string | null = null;
    if (args.length > 0) {
      if (args[0].toLowerCase() !== 'interface') {
        throw new CliInvalidInput({ token: args[0] });
      }
      if (args.length === 1) throw new CliIncomplete();
      portFilter = this.resolveInterfaceName(args.slice(1).join(' '));
      if (portFilter === null) throw new CliInvalidInput({ token: args[1] });
    }
    for (const [name, p] of this.d()._getPortsInternal()) {
      if (portFilter && name !== portFilter) continue;
      const sec = p.getPortSecurity();
      if (genre === 'all') sec.clearAll();
      else if (genre === 'dynamic') sec.clearDynamic();
      else if (genre === 'sticky') sec.clearSticky();
      else if (genre === 'configured') { sec.clearSticky(); sec.clearDynamic(); }
    }
    return '';
  }

  // ─── Port-Security Display ────────────────────────────────────────

  private renderPortSecurityLines(port: import('../../hardware/Port').Port): string[] {
    const sec = port.getPortSecurity();
    if (!sec.isEnabled()) return [];
    const out: string[] = ['switchport port-security'];
    if (sec.getMaxMACAddresses() !== 1) {
      out.push(`switchport port-security maximum ${sec.getMaxMACAddresses()}`);
    }
    if (sec.getViolationMode() !== 'shutdown') {
      out.push(`switchport port-security violation ${sec.getViolationMode()}`);
    }
    if (sec.isStickyEnabled()) {
      out.push('switchport port-security mac-address sticky');
    }
    for (const e of sec.getEntries()) {
      if (e.type === 'sticky') {
        out.push(`switchport port-security mac-address sticky ${this.formatMacCisco(e.mac)}`);
      } else if (e.type === 'static') {
        out.push(`switchport port-security mac-address ${this.formatMacCisco(e.mac)}`);
      }
    }
    if (sec.getAgingTimeMin() > 0) {
      out.push(`switchport port-security aging time ${sec.getAgingTimeMin()}`);
    }
    if (sec.getAgingType() !== 'absolute') {
      out.push(`switchport port-security aging type ${sec.getAgingType()}`);
    }
    if (sec.getAgingStatic()) out.push('switchport port-security aging static');
    return out;
  }

  private dtpAdminLabel(m: import('../../dtp/types').DtpAdminMode): string {
    switch (m) {
      case 'access': return 'ACCESS';
      case 'trunk': return 'TRUNK';
      case 'dynamic-auto': return 'DYN-AUTO';
      case 'dynamic-desirable': return 'DYN-DESIRABLE';
      case 'nonegotiate': return 'TRUNK';
    }
  }

  private formatMacCisco(mac: MACAddress): string {
    return mac.toCiscoString();
  }

  private showPortSecurityOverview(sw: CiscoSwitch): string {
    const lines = [
      'Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action',
      '             (Count)        (Count)      (Count)',
      '------------------------------------------------------------------------------',
    ];
    for (const [name, port] of sw._getPortsInternal()) {
      const sec = port.getPortSecurity();
      if (!sec.isEnabled()) continue;
      lines.push(
        `${this.abbreviateInterface(name).padEnd(12)} ` +
        `${String(sec.getMaxMACAddresses()).padEnd(14)} ` +
        `${String(sec.getEntries().length).padEnd(12)} ` +
        `${String(sec.getViolationCount()).padEnd(18)} ` +
        sec.getViolationMode(),
      );
    }
    return lines.join('\n');
  }

  private showPortSecurityInterface(sw: CiscoSwitch, ifaceArg: string): string {
    const name = this.resolveInterfaceName(ifaceArg) ?? ifaceArg;
    const port = sw.getPort(name);
    if (!port) return `% Invalid interface "${ifaceArg}"`;
    const sec = port.getPortSecurity();
    const errd = sw._getPsecErrDisabledPorts().has(name);
    const status = !sec.isEnabled() ? 'Disabled' :
                   errd ? 'Secure-shutdown' :
                   port.getIsUp() ? 'Secure-up' : 'Secure-down';
    return [
      `Port Security              : ${sec.isEnabled() ? 'Enabled' : 'Disabled'}`,
      `Port Status                : ${status}`,
      `Violation Mode             : ${sec.getViolationMode().charAt(0).toUpperCase() + sec.getViolationMode().slice(1)}`,
      `Aging Time                 : ${sec.getAgingTimeMin()} mins`,
      `Aging Type                 : ${sec.getAgingType().charAt(0).toUpperCase() + sec.getAgingType().slice(1)}`,
      `SecureStatic Address Aging : ${sec.getAgingStatic() ? 'Enabled' : 'Disabled'}`,
      `Maximum MAC Addresses      : ${sec.getMaxMACAddresses()}`,
      `Total MAC Addresses        : ${sec.getEntries().length}`,
      `Configured MAC Addresses   : ${sec.getEntries().filter(e => e.type === 'static').length}`,
      `Sticky MAC Addresses       : ${sec.getEntries().filter(e => e.type === 'sticky').length}`,
      `Last Source Address:Vlan   : ${sec.getEntries().length > 0
          ? `${this.formatMacCisco(sec.getEntries()[sec.getEntries().length - 1].mac)}:${sec.getEntries()[sec.getEntries().length - 1].vlan}`
          : '0000.0000.0000:0'}`,
      `Security Violation Count   : ${sec.getViolationCount()}`,
    ].join('\n');
  }

  private showPortSecurityAddress(sw: CiscoSwitch): string {
    const lines = [
      '          Secure Mac Address Table',
      '------------------------------------------------------------------------',
      'Vlan    Mac Address       Type                          Ports   Remaining Age',
      '----    -----------       ----                          -----   -------------',
    ];
    let n = 0;
    for (const [name, port] of sw._getPortsInternal()) {
      const sec = port.getPortSecurity();
      if (!sec.isEnabled()) continue;
      for (const e of sec.getEntries()) {
        const typeStr = e.type === 'static' ? 'SecureConfigured'
          : e.type === 'sticky' ? 'SecureSticky' : 'SecureDynamic';
        lines.push(
          `${String(e.vlan).padEnd(8)}${this.formatMacCisco(e.mac).padEnd(18)}` +
          `${typeStr.padEnd(30)}${this.abbreviateInterface(name).padEnd(8)}` +
          `${sec.getAgingTimeMin() > 0 ? `${sec.getAgingTimeMin()}m` : '-'}`,
        );
        n++;
      }
    }
    lines.push('');
    lines.push(`Total Addresses: ${n}`);
    return lines.join('\n');
  }

  private registerVtpCommands(trie: CommandTrie): void {
    trie.registerGreedy('vtp domain', 'Set VTP domain', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      this.requireVtp().setDomain(args[0]);
      return '';
    });
    trie.registerGreedy('vtp mode', 'Set VTP mode', (args) => {
      const m = (args[0] ?? '').toLowerCase();
      if (m !== 'server' && m !== 'client' && m !== 'transparent' && m !== 'off') {
        return '% Invalid VTP mode';
      }
      this.requireVtp().setMode(m);
      return '';
    });
    trie.registerGreedy('vtp password', 'Set VTP password', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      this.requireVtp().setPassword(args[0]);
      return '';
    });
    trie.registerGreedy('vtp version', 'Set VTP version', (args) => {
      const v = parseInt(args[0] ?? '', 10);
      if (v !== 1 && v !== 2 && v !== 3) return '% Invalid VTP version';
      this.requireVtp().setVersion(v as 1 | 2 | 3);
      return '';
    });
    trie.register('vtp pruning', 'Enable VTP pruning', () => {
      this.requireVtp().setPruning(true);
      return '';
    });
    trie.register('no vtp pruning', 'Disable VTP pruning', () => {
      this.requireVtp().setPruning(false);
      return '';
    });

  }

  private registerUdldCommands(trie: SwitchTries): void {
    trie.config.registerGreedy('udld', 'UDLD global configuration', (args) => {
      const agent = this.requireUdld();
      const mot = (args[0] ?? '').toLowerCase();
      if (mot === '') throw new CliIncomplete();
      if (mot === 'enable' || mot === 'aggressive') {
        if (args[1] !== undefined) throw new CliInvalidInput({ token: args[1] });
        agent.setGlobalMode(mot === 'enable' ? 'normal' : 'aggressive');
        return '';
      }
      if (mot === 'message') {
        agent.setHelloInterval(this.lireUdldMessageTime(args.slice(1)));
        return '';
      }
      throw new CliInvalidInput({ token: args[0] });
    }, [
      { keyword: 'enable', description: 'Enable UDLD in normal mode on fibre ports' },
      { keyword: 'aggressive', description: 'Enable UDLD in aggressive mode on fibre ports' },
      { keyword: 'message', description: 'Set the message interval' },
    ]);
    trie.config.registerGreedy('no udld', 'Disable UDLD globally', (args) => {
      const agent = this.requireUdld();
      if ((args[0] ?? '').toLowerCase() === 'message') {
        if ((args[1] ?? '').toLowerCase() !== 'time') {
          throw new CliInvalidInput({ token: args[1] });
        }
        if (args[2] !== undefined) throw new CliInvalidInput({ token: args[2] });
        agent.setHelloInterval(UDLD_DEFAULT_HELLO_SEC);
        return '';
      }
      if (args[0] !== undefined && !['enable', 'aggressive'].includes(args[0].toLowerCase())) {
        throw new CliInvalidInput({ token: args[0] });
      }
      agent.setGlobalMode('disabled');
      return '';
    });
    trie.configIf.registerGreedy('udld port', 'UDLD per-port configuration', (args) => {
      const m = (args[0] ?? '').toLowerCase();
      if (m !== '' && m !== 'aggressive') throw new CliInvalidInput({ token: args[0] });

      const mode = m === 'aggressive' ? 'aggressive' : 'normal';
      for (const p of this.selectedPortsForConfigIf()) {
        this.requireUdld().setPortMode(p, mode);
      }
      return '';
    });
    trie.configIf.register('no udld port', 'Disable UDLD on this port', () => {
      const ports = this.selectedPortsForConfigIf();
      for (const p of ports) this.requireUdld().setPortMode(p, 'disabled');
      return '';
    });
    for (const t of [trie.user, trie.privileged]) {
      t.registerGreedy('show udld', 'Display UDLD state', (args) => {
        const agent = this.requireUdld();
        const target = args[0];
        if (args[1] !== undefined) throw new CliInvalidInput({ token: args[1] });
        let ports = agent.listPorts();
        if (target !== undefined) {
          const nom = this.resolvePortName(target);
          if (nom === null) throw new CliInvalidInput({ token: target });
          ports = ports.filter((p) => p.port === nom);
        }
        if (ports.length === 0) return '';
        const lines: string[] = [];
        for (const rt of ports) {
          lines.push(`Interface ${rt.port}`);
          lines.push(`---`);
          lines.push(`Port enable administrative configuration setting: ${rt.mode === 'disabled' ? 'Disabled' : 'Enabled'}`);
          lines.push(`Port enable operational state: ${rt.mode === 'disabled' ? 'Disabled' : 'Enabled / in ' + rt.mode + ' mode'}`);
          lines.push(`Current bidirectional state: ${rt.state === 'bidirectional' ? 'Bidirectional' : rt.state}`);
          lines.push(`Current operational state: ${rt.state}`);
          const neighbors = agent.getNeighborsFor(rt.port);
          lines.push(`Message interval: ${agent.getConfig().helloIntervalSec}`);
          lines.push(`Time out interval: ${agent.getConfig().messageTimeoutSec}`);
          for (const n of neighbors) {
            lines.push(`Entry 1`);
            lines.push(`Expiration time: ${agent.getConfig().messageTimeoutSec}`);
            lines.push(`Device ID: ${n.remoteDeviceId}`);
            lines.push(`Current neighbor state: ${rt.state}`);
            lines.push(`Device name: ${n.remoteHostname}`);
            lines.push(`Port ID: ${n.remotePortId}`);
            lines.push(`Neighbor echo 1 device: ${n.echo[0]?.deviceId ?? 'none'}`);
            lines.push(`Neighbor echo 1 port: ${n.echo[0]?.portId ?? 'none'}`);
            lines.push(`Message interval: ${n.helloIntervalSec}`);
          }
        }
        return lines.join('\n');
      });
    }
  }

  private lireUdldMessageTime(args: readonly string[]): number {
    if (args[0] === undefined) throw new CliIncomplete();
    if (args[0].toLowerCase() !== 'time') throw new CliInvalidInput({ token: args[0] });
    if (args[1] === undefined) throw new CliIncomplete();
    if (args[2] !== undefined) throw new CliInvalidInput({ token: args[2] });
    return entierBorne(args[1], ...UDLD_MESSAGE_TIME_RANGE);
  }

  /** `ip igmp snooping vlan <n> mrouter interface <port>`. */
  private applyStaticMrouter(vlan: number, rest: string[], on: boolean): string {
    const idx = rest.findIndex(s => s.toLowerCase() === 'interface');
    const spec = idx >= 0 ? rest.slice(idx + 1).join(' ') : rest.join(' ');
    if (!spec) return CISCO_ERRORS.INCOMPLETE;
    const port = this.resolvePortName(spec);
    if (!port) return `% Invalid interface ${spec}`;
    this.requireIgmpSnooping().setStaticRouterPort(vlan, port, on);
    return '';
  }

  /**
   * `ip igmp snooping [vlan <n>] querier [address <ip> | query-interval <s>]`.
   * A bare `querier` toggles the role; the sub-keywords only ever set
   * parameters, so `no ... querier address` clears the address rather than
   * disabling the querier — same as IOS.
   */
  private applySnoopingQuerier(vlan: number | null, rest: string[], on: boolean): string {
    const agent = this.requireIgmpSnooping();
    const kw = rest[0];
    if (kw === 'address') {
      if (on && !rest[1]) return CISCO_ERRORS.INCOMPLETE;
      if (on && !/^\d{1,3}(\.\d{1,3}){3}$/.test(rest[1])) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      agent.setQuerierAddress(on ? rest[1] : null);
      return '';
    }
    if (kw === 'query-interval') {
      const secs = parseInt(rest[1] ?? '', 10);
      if (on && (Number.isNaN(secs) || secs < 1 || secs > 18000)) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      agent.setQuerierInterval(on ? secs : 60);
      return '';
    }
    if (kw !== undefined) return CISCO_ERRORS.INVALID_INPUT;
    agent.setQuerierEnabled(vlan, on);
    return '';
  }

  /** `[no] ip pim snooping [vlan <n>]` — global or per-VLAN. */
  private applyPimSnooping(args: string[], on: boolean): string {
    const agent = this.requirePimSnooping();
    const a = args.map(s => s.toLowerCase());
    if (a.length === 0) { agent.setEnabled(on); return ''; }
    if (a[0] !== 'vlan') throw new CliInvalidInput({ token: args[0] });
    if (a[1] === undefined) throw new CliIncomplete();

    const vlan = parseVlanId(a[1]);
    if (vlan === null) throw new CliInvalidInput({ token: args[1] });
    if (a[2] !== undefined) throw new CliInvalidInput({ token: args[2] });

    agent.setVlanEnabled(vlan, on);
    return '';
  }

  private showPimSnooping(args: string[]): string {
    const agent = this.requirePimSnooping();
    const cfg = agent.getConfig();
    if (args.includes('neighbor')) {
      const rows = ['Vlan      Neighbor            Port', '----      --------            ----'];
      for (const v of agent.listVlans()) {
        for (const n of v.neighbors.values()) {
          rows.push(`${String(v.vlan).padEnd(10)}${n.neighborIp.padEnd(20)}${n.port}`);
        }
      }
      return rows.join('\n');
    }
    if (args.includes('group')) {
      const rows = ['Vlan      Group               Port List', '----      -----               ---------'];
      for (const { vlan, group } of agent.listGroups()) {
        rows.push(`${String(vlan).padEnd(10)}${group.groupAddress.padEnd(20)}${[...group.members.keys()].join(', ')}`);
      }
      return rows.join('\n');
    }
    const lines: string[] = [];
    lines.push('Global runtime status: ' + (cfg.enabled ? 'enabled' : 'disabled'));
    lines.push('');
    for (const v of agent.listVlans()) {
      lines.push(`Vlan ${v.vlan}`);
      lines.push(`--------`);
      lines.push(` PIM snooping                : ${cfg.enabled && v.enabled ? 'Enabled' : 'Disabled'}`);
      lines.push(` PIMv2 Hello messages        : ${v.neighbors.size} neighbor(s)`);
      lines.push(` Number of user enabled ports: ${v.routerPorts.size}`);
      lines.push(` Number of groups            : ${v.groups.size}`);
    }
    return lines.join('\n');
  }

  private registerPimSnoopingCommands(): void {
    this.configTrie.registerGreedy('ip pim snooping', 'PIM snooping config',
      (args) => this.applyPimSnooping(args, true));
    this.configTrie.registerGreedy('no ip pim snooping', 'Disable PIM snooping',
      (args) => this.applyPimSnooping(args, false));
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.registerGreedy('show ip pim snooping', 'Display PIM snooping state',
        (args) => this.showPimSnooping(args.map(s => s.toLowerCase())));
    }
  }

  private applyIgmpSnooping(args: string[], on: boolean): string {
    const agent = this.requireIgmpSnooping();
    const a = args.map(s => s.toLowerCase());
    if (a.length === 0) { agent.setEnabled(on); return ''; }
    if (a[0] === 'querier') return this.applySnoopingQuerier(null, a.slice(1), on);
    if (a[0] !== 'vlan') throw new CliInvalidInput({ token: args[0] });
    if (a[1] === undefined) throw new CliIncomplete();

    const vlan = parseVlanId(a[1]);
    if (vlan === null) throw new CliInvalidInput({ token: args[1] });
    if (a[2] === 'immediate-leave') { agent.setImmediateLeave(vlan, on); return ''; }
    if (a[2] === 'mrouter') return this.applyStaticMrouter(vlan, args.slice(3), on);
    if (a[2] === 'querier') return this.applySnoopingQuerier(vlan, a.slice(3), on);
    if (a[2] !== undefined) throw new CliInvalidInput({ token: args[2] });

    agent.setVlanEnabled(vlan, on);
    return '';
  }

  private registerIgmpSnoopingCommands(): void {
    this.configTrie.registerGreedy('ip igmp snooping', 'IGMP snooping config',
      (args) => this.applyIgmpSnooping(args, true));
    this.configTrie.registerGreedy('no ip igmp snooping', 'Disable IGMP snooping',
      (args) => this.applyIgmpSnooping(args, false));
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.registerGreedy('show ip igmp snooping groups',
        'IGMP snooping multicast group information', (args) =>
        this.showIgmpSnoopingGroups(args));
      t.registerGreedy('show ip igmp snooping mrouter',
        'IGMP snooping multicast router ports', () => this.showIgmpSnoopingMrouter());
      t.registerGreedy('show ip igmp snooping querier',
        'IGMP snooping querier status', () => this.showIgmpSnoopingQuerier());
      t.registerGreedy('show ip igmp snooping vlan',
        'IGMP snooping information for a VLAN', (args) =>
        this.showIgmpSnoopingGlobal(args));
      t.register('show ip igmp snooping', 'Display IGMP snooping state', () =>
        this.showIgmpSnoopingGlobal([]));
    }
  }

  /** L'en-tete que les trois vues globales partagent. */
  private igmpSnoopingHeader(): string[] {
    const cfg = this.requireIgmpSnooping().getConfig();
    return [
      'Global IGMP Snooping configuration:',
      '-----------------------------------------',
      `IGMP snooping              : ${cfg.enabled ? 'Enabled' : 'Disabled'}`,
      'IGMPv3 snooping            : Disabled',
      'Report suppression         : Enabled',
      'TCN solicit query          : Disabled',
      'Robustness variable        : 2',
      'Last member query count    : 2',
      'Last member query interval : 1000',
    ];
  }

  private showIgmpSnoopingGroups(args: readonly string[]): string {
    const agent = this.requireIgmpSnooping();
    const vi = args.indexOf('vlan');
    const filtre = vi >= 0 ? parseVlanId(args[vi + 1]) ?? undefined : undefined;
    const rows = ['Vlan      Group               Type    Version  Port List'];
    for (const { vlan, group } of agent.listGroups(filtre)) {
      const ports = Array.from(group.members.keys()).join(', ');
      rows.push(
        `${String(vlan).padEnd(10)}${group.groupAddress.padEnd(20)}igmp    v2       ${ports}`);
    }
    return rows.join('\n');
  }

  private showIgmpSnoopingMrouter(): string {
    const agent = this.requireIgmpSnooping();
    const rows = ['Vlan    ports', '----    -----'];
    for (const v of agent.listVlans()) {
      const ports = Array.from(v.routerPorts)
        .map(p => `${p}(${v.staticRouterPorts.has(p) ? 'static' : 'dynamic'})`)
        .join(', ');
      rows.push(`${String(v.vlan).padEnd(8)}${ports}`);
    }
    return rows.join('\n');
  }

  private showIgmpSnoopingQuerier(): string {
    const agent = this.requireIgmpSnooping();
    const cfg = agent.getConfig();
    const lines = this.igmpSnoopingHeader();
    for (const v of agent.listVlans()) {
      const src = agent.querierSourceIp(v.vlan);
      const admin = cfg.querierEnabled || v.querierEnabled;
      lines.push(``);
      lines.push(`Vlan ${v.vlan}: IGMP snooping querier status`);
      lines.push(`--------------------------------------------`);
      lines.push(`Admin state                    : ${admin ? 'Enabled' : 'Disabled'}`);
      lines.push(`Admin version                  : 2`);
      lines.push(`Operational state              : ${agent.isQuerierOperational(v.vlan) ? 'Enabled' : 'Disabled'}`);
      lines.push(`Querier address                : ${src ?? '0.0.0.0'}`);
      lines.push(`Query interval                 : ${cfg.querierIntervalSec}`);
      lines.push(`Max response time              : ${Math.round(cfg.querierMaxRespTimeDs / 10)}`);
    }
    return lines.join('\n');
  }

  private showIgmpSnoopingGlobal(args: readonly string[]): string {
    const agent = this.requireIgmpSnooping();
    if (args.length > 0 && parseVlanId(args[0]) === null) {
      throw new CliInvalidInput({ token: args[0] });
    }
    const lines = this.igmpSnoopingHeader();
    lines.push(``);
    lines.push(`Vlan ${[...agent.listVlans()].map(v => v.vlan).join(',') || '<none>'}:`);
    return lines.join('\n');
  }

  /**
   * La configuration d'un port oublie le reglage que `no` vient de defaire.
   *
   * `ifStp` est un JOURNAL de ce qui a ete tape, et c'est lui que rend
   * `show running-config` : la negation touchait l'agent et laissait la
   * ligne positive dans le journal, si bien que `spanning-tree portfast`
   * puis `no spanning-tree portfast` rendait une configuration ou le
   * portfast est encore pose — et un import de topologie le reposait
   * vraiment.
   */
  private oublierLigneStp(port: string, tete: string, knob: string): void {
    const lignes = this.ifStp.get(port);
    if (!lignes) return;
    const cible = tete === 'vlan' ? knob : tete;
    const restantes = lignes.filter(ligne => {
      const mots = ligne.split(/\s+/).slice(1).map(m => m.toLowerCase());
      const sienne = mots[0] === 'vlan' ? mots[2] : mots[0];
      return sienne !== cible;
    });
    if (restantes.length === 0) this.ifStp.delete(port);
    else this.ifStp.set(port, restantes);
  }

  private registerStpCommands(): void {
    this.registerStpGlobal(this.configTrie);
    this.registerStpGlobalRest(this.configTrie);
    this.registerStpInterface();
  }

  private registerStpGlobal(trie: CommandTrie): void {
    /*
     * `mode` est un NOEUD, pas un mot avale par le glouton : sans lui,
     * `spanning-tree mode ?` rendait la liste du parent — `backbonefast`,
     * `bpdufilter`, … — c'est-a-dire tout sauf les trois modes, sur la
     * commande dont c'est la seule question.
     */

    // Global: every other `spanning-tree …` is accepted (priority/
    // root/extend/portfast/loopguard/…). Track the mode for `show`.
    trie.registerGreedy('spanning-tree', 'Spanning Tree configuration', (args) =>
      this.appliquerStpGlobal(args), STP_GLOBAL_CONTINUATIONS);
    /*
     * Un aiguillage pris ferme ses autres branches : declarees comme des
     * SUITES du glouton, `extend`, `loopguard`, `pathcost` et `portfast`
     * n'etaient pas des noeuds, si bien que `spanning-tree extend ?`
     * reproposait la liste du PARENT — une aide invitant a ecrire
     * `spanning-tree extend loopguard`, que l'analyseur refuse. Ce sont
     * de vrais noeuds, qui lisent le MEME corps.
     */
    for (const [mot, description, suites] of STP_GLOBAL_SECOND_LEVEL) {
      trie.registerGreedy(`spanning-tree ${mot}`, description,
        (args) => this.appliquerStpGlobal([mot, ...args]), suites);
    }
    /*
     * `priority` prend un NOMBRE, pas un mot-cle : sans son propre
     * noeud, `spanning-tree priority ?` reproposait les freres du
     * parent, exactement comme les quatre ci-dessus.
     */
    trie.registerGreedy('spanning-tree priority',
      'Bridge priority of the spanning tree',
      (args) => this.appliquerStpGlobal(['priority', ...args]));
    trie.describeArgs('spanning-tree priority', [{
      name: 'priorite', type: 'INT', range: [0, 61440],
      description: 'Bridge priority in increments of 4096',
    }]);
  }

  private appliquerStpGlobal(args: readonly string[]): string {
    {
      const refus = refusReglageStpGlobal(args);
      if (refus !== null) return refus;
      if (args[0]?.toLowerCase() === 'mode' && args[1]) {
        this.stpMode = args[1];
        const m = args[1].toLowerCase();
        this.requireStp().setMode(
          m === 'mst' ? 'mstp' : m === 'rapid-pvst' ? 'rstp' : 'stp');
      }
      /*
       * `spanning-tree vlan <liste>` SEUL est le contraire de son `no` :
       * il remet l'arbre du VLAN. Sans lui, couper un VLAN etait
       * irreversible et la ligne restait dans la configuration.
       */
      if (args[0]?.toLowerCase() === 'vlan' && args[1] && !args[2]) {
        const vlans = parseVlanList(args[1]);
        if (vlans === null) throw new CliInvalidInput({ token: args[1] });
        for (const v of vlans) this.requireStp().setVlanStpEnabled(v, true);
      }
      if (args[0]?.toLowerCase() === 'vlan' && args[2]) {
        const vlan = parseInt(args[1] ?? '', 10);
        const knob = args[2].toLowerCase();
        const n = parseInt(args[3] ?? '', 10);
        const agent = this.requireStp();
        if (isNaN(vlan)) return CISCO_ERRORS.INVALID_INPUT;
        if (knob === 'priority' && !isNaN(n)) agent.setVlanPriority(vlan, n);
        else if (knob === 'hello-time' && !isNaN(n)) agent.setVlanHelloSec(vlan, n);
        else if (knob === 'max-age' && !isNaN(n)) agent.setVlanMaxAgeSec(vlan, n);
        else if (knob === 'forward-time' && !isNaN(n)) agent.setVlanForwardDelaySec(vlan, n);
        else if (knob === 'root') {
          const kind = args[3]?.toLowerCase();
          if (kind === 'primary') agent.setVlanPriority(vlan, 24576);
          else if (kind === 'secondary') agent.setVlanPriority(vlan, 28672);
        }
      }
      if (args[0]?.toLowerCase() === 'priority') {
        const n = parseInt(args[1] ?? '', 10);
        if (!isNaN(n)) this.requireStp().setBridgePriority(n);
      }
      if (args[0]?.toLowerCase() === 'portfast') {
        const sub = args[1]?.toLowerCase();
        const agent = this.requireStp();
        if (sub === 'default') agent.setPortfastDefault(true);
        else if (sub === 'bpduguard' && args[2]?.toLowerCase() === 'default') agent.setBpduGuardGlobal(true);
        else if (sub === 'bpdufilter' && args[2]?.toLowerCase() === 'default') agent.setBpduFilterGlobal(true);
      }
      if (args[0]?.toLowerCase() === 'loopguard' && args[1]?.toLowerCase() === 'default') {
        this.requireStp().setLoopGuardGlobal(true);
      }
      if (args[0]?.toLowerCase() === 'uplinkfast') this.requireStp().setUplinkFast(true);
      if (args[0]?.toLowerCase() === 'backbonefast') this.requireStp().setBackboneFast(true);
      if (args[0]?.toLowerCase() === 'pathcost' && args[1]?.toLowerCase() === 'method') {
        const m = args[2]?.toLowerCase();
        if (m !== 'long' && m !== 'short') return CISCO_ERRORS.INVALID_INPUT;
        this.requireStp().setPathcostMethod(m);
      }
      return '';
    }
  }

  private registerStpGlobalRest(trie: CommandTrie): void {
    trie.registerGreedy('spanning-tree mst', 'MST instance configuration', (args) => {
      if (args[1]?.toLowerCase() === 'priority') {
        const inst = parseInt(args[0] ?? '', 10);
        const prio = parseInt(args[2] ?? '', 10);
        if (isNaN(inst) || isNaN(prio)) return CISCO_ERRORS.INVALID_INPUT;
        this.requireStp().setMstInstancePriority(inst, prio);
      }
      return '';
    });
    trie.registerGreedy('no spanning-tree', 'Disable spanning-tree', (args) => {
      const agent = this.requireStp();
      const a0 = args[0]?.toLowerCase();
      if (a0 === undefined) throw new CliIncomplete();
      if (!NO_SPANNING_TREE_KEYWORDS.has(a0)) throw new CliInvalidInput({ token: args[0] });
      if (a0 === 'vlan') {
        if (args[1] === undefined) throw new CliIncomplete();
        const vlans = parseVlanList(args.slice(1).join(','));
        if (vlans === null) throw new CliInvalidInput({ token: args[1] });
        for (const v of vlans) agent.setVlanStpEnabled(v, false);
      } else if (a0 === 'portfast') {
        const sub = args[1]?.toLowerCase();
        if (sub === 'default') agent.setPortfastDefault(false);
        else if (sub === 'bpduguard') agent.setBpduGuardGlobal(false);
        else if (sub === 'bpdufilter') agent.setBpduFilterGlobal(false);
      } else if (a0 === 'loopguard') agent.setLoopGuardGlobal(false);
      else if (a0 === 'uplinkfast') agent.setUplinkFast(false);
      else if (a0 === 'backbonefast') agent.setBackboneFast(false);
      else if (a0 === 'pathcost') agent.setPathcostMethod('short');
      // `no spanning-tree mode` REVIENT au defaut du Catalyst, PVST+ ;
      // la negation etait acceptee et ne defaisait rien, donc un mode
      // pose restait pose et la configuration rendue le gardait.
      else if (a0 === 'mode') { this.stpMode = 'pvst'; agent.setMode('stp'); }
      return '';
    });

    // Interface: spanning-tree portfast/bpduguard/cost/… (tracked).
  }

  private stpGlobalSpecs(): CommandSpec[] {
    const poser = (mode: string): string => {
      this.stpMode = mode;
      const m = mode.toLowerCase();
      this.requireStp().setMode(
        m === 'mst' ? 'mstp' : m === 'rapid-pvst' ? 'rstp' : 'stp');
      return '';
    };

    return [
      {
        id: 'spanning-tree-mode',
        path: ['spanning-tree', 'mode', STP_MODE_PLACE],
        description: 'Spanning tree operating mode',
        undoDescription: 'Return to the default spanning tree mode',
        modes: ['config'], minPrivilege: 15,
        run: (_session, args) => poser(args.mode),
        undo: () => poser('pvst'),
      },
      {
        id: 'spanning-tree-mode-no',
        path: ['spanning-tree', 'mode'],
        description: 'Spanning tree operating mode',
        undoDescription: 'Return to the default spanning tree mode',
        modes: ['config'], minPrivilege: 15,
        existsOnlyNegated: true,
        run: () => CISCO_ERRORS.INCOMPLETE,
        undo: () => poser('pvst'),
      },
      {
        id: 'spanning-tree-mst-configuration',
        path: ['spanning-tree', 'mst', 'configuration'],
        description: 'Enter MST configuration sub-mode',
        modes: ['config'], minPrivilege: 15,
        run: () => { this.mode = 'config-mst'; return ''; },
      },
    ];
  }

  private registerStpInterface(): void {

    // `archive` — la même famille que sur le routeur, construite par le
    // même module (`CiscoArchiveCommands`) plutôt que recopiée : deux
    // plateformes qui archivent différemment seraient un défaut, pas une
    // fonctionnalité.
    this.configTrie.register('archive', 'Enter archive configuration', () => {
      this.mode = 'config-archive';
      return '';
    });
    const archiveOf = () => this.archiveService();
    buildArchiveSubmodeOn(this.configArchiveTrie, archiveOf, () => {
      this.mode = 'config-archive-log';
    });
    buildArchiveLogSubmodeOn(this.configArchiveLogTrie, archiveOf);

    // config-mst sub-mode
    this.configMstTrie.registerGreedy('name', 'Set MST region name', (a) => {
      this.stpAgentOf(this.d())?.setMstName(a.join(' '));
      this.requireVtp().onLocalMstChange();
      return '';
    });
    this.configMstTrie.registerGreedy('revision', 'Set MST revision', (a) => {
      if (a[0] === undefined) return CISCO_ERRORS.INCOMPLETE;
      const n = entierBorne(a[0], 0, 65535);
      this.stpAgentOf(this.d())?.setMstRevision(n);
      this.requireVtp().onLocalMstChange();
      return '';
    });
    this.configMstTrie.registerGreedy('instance', 'Map VLANs to an MST instance', (a) => {
      if (a[0] === undefined) return CISCO_ERRORS.INCOMPLETE;
      const id = entierBorne(a[0], 0, 4094);
      const reste = a.slice(1);
      if (reste[0]?.toLowerCase() === 'vlan') reste.shift();
      if (reste.length > 0) {
        const liste = analyserListeVlan([reste.join('')]);
        if ('erreur' in liste) return liste.erreur;
      }
      this.stpAgentOf(this.d())?.mapMstInstance(id, reste.join(' '));
      this.requireVtp().onLocalMstChange();
      return '';
    });
    this.configMstTrie.register('show current', 'Show current MST config', () =>
      this.showMstConfig());
    this.configMstTrie.register('show pending', 'Show pending MST config', () =>
      this.showMstConfig());
    // The base redirects `show …` in config modes to the privileged
    // trie, so `show current` must also resolve there.
    this.privilegedTrie.register('show current', 'Show current MST config', () =>
      this.showMstConfig());
    this.privilegedTrie.register('show pending', 'Show pending MST config', () =>
      this.showMstConfig());
    this.configMstTrie.registerGreedy('no', 'Negate MST option', (args) => {
      const head = args[0]?.toLowerCase();
      const ag = this.stpAgentOf(this.d());
      if (head === 'name') ag?.setMstName('');
      else if (head === 'revision') ag?.setMstRevision(0);
      else if (head === 'instance' && args[1]) {
        const inst = parseInt(args[1], 10);
        if (!isNaN(inst)) ag?.unmapMstInstance(inst);
      }
      this.requireVtp().onLocalMstChange();
      return '';
    });
    this.configMstTrie.registerGreedy('abort', 'Abort MST changes', () => {
      this.mode = 'config'; return '';
    });

    // show spanning-tree summary | mst configuration | interface <if>
    this.registerSwitchDebugCommands();
  }

  private dhcpPoolContext(): CiscoShellContext {
    return {
      r: () => this.d() as unknown as Router,
      setMode: (m: string) => { this.mode = m as CLIMode; },
      getSelectedDHCPPool: () => this.selectedDhcpPool,
      setSelectedDHCPPool: (p: string | null) => { this.selectedDhcpPool = p; },
    } as unknown as CiscoShellContext;
  }

  private stpShowSpecs(): CommandSpec[] {
    const register = (collector: SpecCollector) =>
      this.registerStpShowCommands(collector as unknown as CommandTrie);

    const specs = specsFromTrieRegistrations(register, {
      modes: ['user', 'privileged'],
      minPrivilege: 1,
      skip: (path) => path === 'show spanning-tree vlan',
      restDescriptionFor: (path) => ({
        'show spanning-tree interface': 'Interface name',
        'show spanning-tree mst': 'Instance number, or configuration',
      })[path],
      restLiteralFor: (path) => ({
        'show spanning-tree interface': 'WORD',
        'show spanning-tree mst': '<0-4094>',
      })[path],
    });

    const vlan = collectRegistrations(register)
      .find((entry) => entry.path === 'show spanning-tree vlan');
    return vlan ? [...specs, ...stpVlanSpecs(vlan.action)] : specs;
  }

  private vlanVtpShowSpecs(): CommandSpec[] {
    const exec = ['user', 'privileged'];
    return [
      ...specsFromTrieRegistrations(
        (collector) => this.registerVlanShowCommands(collector as unknown as CommandTrie),
        {
          modes: exec, minPrivilege: 1,
          restDescriptionFor: (path) => ({
            'show vlan id': 'VLAN number',
            'show vlan name': 'VLAN name',
          })[path],
          restLiteralFor: (path) => path === 'show vlan id' ? '<1-4094>' : 'WORD',
        },
      ),
      ...specsFromTrieRegistrations(
        (collector) => this.registerVtpShowCommands(collector as unknown as CommandTrie),
        { modes: exec, minPrivilege: 1 },
      ),
      {
        id: 'vtp-primary',
        path: ['vtp', 'primary', {
          name: 'force', type: 'ENUM', optional: true,
          description: 'Force the takeover without confirmation',
          values: [{ keyword: 'force', description: 'Do not ask for confirmation' }],
        }],
        description: 'Force this switch to become the VTP Primary Server',
        modes: ['privileged'], minPrivilege: 15,
        run: (_session, args) =>
          this.requireVtp().becomePrimary(String(args.force ?? '') === 'force').message,
      },
    ];
  }

  private l2TableSpecs(): CommandSpec[] {
    const exec = ['user', 'privileged'];
    return [
      ...specsFromTrieRegistrations(
        (collector) => this.registerDaiShowCommands(collector as unknown as CommandTrie),
        {
          modes: exec, minPrivilege: 1,
          restDescriptionFor: (path) => ({
            'show ip arp inspection vlan': 'VLAN number, or a range',
            'show ip device tracking': 'Interface name, or an address',
          })[path],
          restLiteralFor: (path) => ({
            'show ip arp inspection vlan': '<1-4094>',
            'show ip device tracking': 'WORD',
          })[path],
          keywordsFor: (path) => path === 'show dtp'
            ? [{ keyword: 'interface', description: 'Interface configuration' }]
            : undefined,
        },
      ),
      ...specsFromTrieRegistrations(
        (collector) => this.registerMacTableCommands(collector as unknown as CommandTrie),
        {
          modes: exec, minPrivilege: 1,
          skip: (path) => path.startsWith('clear '),
          keywordsFor: (path) => path === 'show mac address-table'
            ? MAC_TABLE_FILTERS : undefined,
        },
      ),
      ...specsFromTrieRegistrations(
        (collector) => this.registerMacTableCommands(collector as unknown as CommandTrie),
        {
          modes: ['privileged'], minPrivilege: 15,
          skip: (path) => !path.startsWith('clear '),
          keywordsFor: (path) => path === 'clear mac address-table'
            ? CLEAR_MAC_TABLE_FILTERS : undefined,
        },
      ),
    ];
  }

  protected override identitySubmodeContext(): CiscoSecurityShellContext {
    return {
      r: () => this.d() as unknown as Router,
      setMode: (m: string) => { this.mode = m as CLIMode; },
      setRadiusServer: (n: string | null) => { this.selectedRadiusServer = n; },
      getRadiusServer: () => this.selectedRadiusServer,
      setTacacsServer: (n: string | null) => { this.selectedTacacsServer = n; },
      getTacacsServer: () => this.selectedTacacsServer,
      setAaaGroup: (n: string | null) => { this.selectedAaaGroup = n; },
      getAaaGroup: () => this.selectedAaaGroup,
    } as unknown as CiscoSecurityShellContext;
  }

  protected override placementFhrp(
    protocole: 'HSRP' | 'VRRP' | 'GLBP',
  ): FhrpPlacement {
    const vlan = this.sviVlanId(this.selectedInterface ?? '');
    return vlan === null
      ? { refus: `% ${protocole} is valid on SVI (Vlan) interfaces only.` }
      : { iface: `Vlanif${vlan}` };
  }

  selectedInterfaceName(): string | null { return this.selectedInterface ?? null; }

  dhcpClientEnable(iface: string, line: string): void {
    this.d().getDhcpClientAgent().enable(iface, line);
  }

  dhcpClientDisable(iface: string): boolean {
    return this.d().getDhcpClientAgent().disable(iface);
  }

  dhcpClientRelease(iface: string): boolean {
    return this.d().getDhcpClientAgent().release(iface);
  }

  dhcpClientRenew(iface: string): boolean {
    return this.d().getDhcpClientAgent().renew(iface);
  }

  dhcpClientLeases(): DhcpClientLeaseView[] {
    return this.d().getDhcpClientAgent().leases().map((l) => ({
      iface: l.iface,
      ipAddress: l.ipAddress,
      subnetMask: l.subnetMask,
      serverIdentifier: l.serverIdentifier,
      leaseDuration: l.leaseDuration,
      renewalTime: l.renewalTime,
      rebindingTime: l.rebindingTime,
    }));
  }

  dhcpClientResolveInterface(name: string): string | null {
    return this.resolveInterfaceName(name);
  }

  private dot1xPaeSpecs(): CommandSpec[] {
    const role: ArgumentSpec = {
      name: 'role', type: 'ENUM', description: '802.1X PAE role',
      values: [
        { keyword: 'authenticator', description: 'Set the port as authenticator' },
        { keyword: 'both', description: 'Set the port as both supplicant and authenticator' },
        { keyword: 'supplicant', description: 'Set the port as supplicant' },
      ],
    };
    const agent = () => this.d().getDot1xAgent();
    return [{
      id: 'config-if-dot1x-pae',
      path: ['dot1x', 'pae', role],
      description: 'Set the PAE role of this interface',
      undoDescription: 'Remove the PAE role from this interface',
      modes: ['config-if'], minPrivilege: 15,
      run: (_session, args) => {
        if (args.role !== 'authenticator') {
          return '% Only the authenticator role is supported '
            + '(no supplicant implementation).';
        }
        return this.applyToSelectedInterfaces((portName) => {
          agent().setPortMode(portName, 'disabled');
          return '';
        });
      },
      undo: () => this.applyToSelectedInterfaces((portName) => {
        agent().removePort(portName);
        return '';
      }),
    }];
  }

  private stpInterfaceHost(): StpInterfaceHost {
    return {
      targetInterfaces: () => this.selectedInterface
        ? [this.selectedInterface] : this.selectedInterfaceRange,
      stpAgent: () => this.requireStp(),
      recordStpLine: (iface, ligne) => {
        const l = this.ifStp.get(iface) ?? [];
        l.push(ligne);
        this.ifStp.set(iface, l);
      },
      forgetStpLine: (iface, tete, knob) => this.oublierLigneStp(iface, tete, knob),
    };
  }

  private portPhysiqueHost(): PhysicalPortHost {
    return {
      refusePortPhysique: () =>
        this.selectedInterface !== null
          && this.sviVlanId(this.selectedInterface) !== null
          ? CISCO_ERRORS.INVALID_INPUT : null,
      recordInterfaceLine: (ligne) => this.enregistrerLigneInterface(ligne),
      removeInterfaceLine: (prefixe) => {
        const ifs = this.selectedInterface
          ? [this.selectedInterface] : this.selectedInterfaceRange;
        for (const i of ifs) {
          const l = this.ifExtra.get(i);
          if (l) this.ifExtra.set(i, l.filter((x) => !x.startsWith(prefixe)));
        }
      },
    };
  }

  protected override loadMtuHost(): LoadMtuHost {
    return {
      ...super.loadMtuHost(),
      refuseOnSelected: (commande) =>
        commande === 'load-interval' && this.selectedInterface !== null
          && this.sviVlanId(this.selectedInterface) !== null
          ? CISCO_ERRORS.INVALID_INPUT : null,
      onInterfaceLine: (ligne) => this.enregistrerLigneInterface(ligne),
    };
  }

  private enregistrerLigneInterface(ligne: string): void {
    const ifs = this.selectedInterface
      ? [this.selectedInterface] : this.selectedInterfaceRange;
    const verbe = ligne.split(' ').slice(0, 3).join(' ');
    for (const i of ifs) {
      const l = (this.ifExtra.get(i) ?? []).filter(
        (existante) => existante.split(' ').slice(0, 3).join(' ') !== verbe);
      l.push(ligne);
      this.ifExtra.set(i, l);
    }
  }

  protected override ipAddressHost(): IpAddressHost {
    const vlan = (): number | null => this.sviVlanId(this.selectedInterface ?? '');
    const surSvi = (appliquer: (n: number) => string): string => {
      const n = vlan();
      return n === null
        ? '% IP addresses may not be configured on L2 links.'
        : appliquer(n);
    };
    return {
      setPrimaryAddress: (adresse, masque) => surSvi((n) => {
        this.d().getDhcpClientAgent().disable(`Vlan${n}`);
        this.d().configureSviIp(n, new IPAddress(adresse), new SubnetMask(masque));
        return '';
      }),
      setSecondaryAddress: () => surSvi(() => SVI_SANS_SECONDAIRE),
      clearAddress: () => surSvi((n) => {
        this.d().getDhcpClientAgent().disable(`Vlan${n}`);
        this.d().clearSviIp(n);
        return '';
      }),
      clearSecondaryAddress: () => surSvi(() => SVI_SANS_SECONDAIRE),
      setNegotiatedAddress: () => surSvi(() => CISCO_ERRORS.INVALID_INPUT),
    };
  }

  protected override resolveTrackedForFhrp(raw: string): string {
    return this.trackObjects.resolve(raw) ?? this.resolveInterfaceName(raw) ?? raw;
  }

  protected override socleSpecs(): readonly CommandSpec[] {
    return [
      ...super.socleSpecs(),
      ...switchPortPhysicalSpecs(() => this.portPhysiqueHost()),
      ...stpInterfaceSpecs(() => this.stpInterfaceHost()),
      ...this.dot1xPaeSpecs(),
      ...dhcpClientFamily(),
      ...this.stpShowSpecs(),
      ...dhcpPoolSpecs(this.dhcpPoolContext()),
      ...this.vlanVtpShowSpecs(),
      ...this.l2TableSpecs(),
      ...this.portSecuritySpecs(),
      ...this.switchportL2Specs(),
      ...this.dot1xSpecs(),
      ...this.vtpConfigSpecs(),
      ...this.daiSpecs(),
      ...this.aggregationSpecs(),
      ...etherChannelLimitFamily(),
      ...this.interfaceEntrySpecs(),
      ...this.vlanEntrySpecs(),
      ...this.macTableSpecs(),
      ...this.stpGlobalSpecs(),
    ];
  }

  /*
   * `interface <nom>` s'ecrivait DEUX fois sur ce commutateur comme sur
   * le routeur, et les deux avaient diverge de la meme facon : la copie
   * du sous-mode n'appelait pas `ensureSvi`, donc `interface Vlan10`
   * tapee depuis une autre interface selectionnait un SVI que personne
   * n'avait cree, et ne bornait pas le numero, donc `interface Vlan5000`
   * y etait acceptee alors que la meme frappe est refusee un mode plus
   * haut.
   */
  private registerInterfaceEntry(trie: CommandTrie): void {
    trie.registerGreedy('interface', 'Select an interface to configure', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;

      if (args[0].toLowerCase() === 'range') {
        return this.handleInterfaceRange(args.slice(1));
      }

      const virt = this.virtualInterfaceName(args.join(' '));
      if (virt) {
        const vlan = this.sviVlanId(virt);
        if (vlan !== null) {
          if (vlan < 1 || vlan > 4094) return CISCO_ERRORS.INVALID_INPUT;
          this.d().ensureSvi(vlan);
        }
        this.selectedInterface = virt;
        this.selectedInterfaceRange = [virt];
        this.mode = 'config-if';
        return '';
      }

      const portName = this.resolveInterfaceName(args[0]);
      if (!portName || !this.d().getPort(portName)) {
        // Un TYPE sans numero est un nom INCOMPLET, pas un nom invalide.
        // L'aide vient de proposer `FastEthernet` : lui repondre que ce
        // nom n'existe pas la dementirait, alors qu'il manque seulement
        // le numero. Le routeur repond deja ainsi.
        if (args.length === 1 && estTypeSansNumero(args[0])) return CISCO_ERRORS.INCOMPLETE;
        return `% Invalid interface name "${args[0]}"`;
      }
      this.selectedInterface = portName;
      this.selectedInterfaceRange = [portName];
      this.mode = 'config-if';
      return '';
    });
    trie.addCompletionKeywords('interface',
      CATALYST_INTERFACE_TYPES.map(t => ({ ...t, leadingOnly: true })));
  }

  private interfaceEntrySpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerInterfaceEntry(collector as unknown as CommandTrie),
      {
        modes: ['config', 'config-if', 'config-subif'], minPrivilege: 15,
        argumentFor: () => ({
          name: 'interface', type: 'REST', description: 'Interface to configure',
          literal: 'IFACE', alternatives: CATALYST_INTERFACE_TYPES,
        }),
        keywordsFor: () => typesInterfaceEnMotsCles(CATALYST_INTERFACE_TYPES),
      });
  }

  private aggregationSpecs(): CommandSpec[] {
    const partager = (
      enregistrer: (t: SwitchTries) => void,
    ) => (collector: SpecCollector) => {
      const un = collector as unknown as CommandTrie;
      enregistrer({ config: un, configIf: un, privileged: un, user: new CommandTrie() });
    };

    const famille = (
      enregistrer: (t: SwitchTries) => void,
      modesParChemin: Readonly<Record<string, readonly string[]>>,
    ): CommandSpec[] => specsFromTrieRegistrations(partager(enregistrer), {
      modes: ['config'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      modesFor: (path) => modesParChemin[path.replace(/^no /, '')],
      minPrivilegeFor: privilegeSelonModes(modesParChemin),
      argumentFor: (path) => AGREGATION_PLACES[path],
    });

    return [
      ...famille((t) => this.registerLacp(t), LACP_MODES),
      ...famille((t) => this.registerUdldCommands(t), UDLD_MODES),
      ...famille((t) => this.registerMonitorSessionCommands(t), MONITOR_MODES),
    ];
  }

  private daiSpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => {
        const partage = collector as unknown as CommandTrie;
        this.registerDaiCommands({
          config: partage, configIf: partage, privileged: partage,
          user: new CommandTrie(),
        });
      },
      {
        modes: ['config'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        skip: (path) => !DAI_CHEMINS.has(path.replace(/^no /, '')),
        modesFor: (path) => DAI_MODES[path.replace(/^no /, '')],
        minPrivilegeFor: privilegeSelonModes(DAI_MODES),
        argumentFor: (path) => DAI_PLACES[path],
      },
    );
  }

  private vtpConfigSpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerVtpCommands(collector as unknown as CommandTrie),
      {
        modes: ['config'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        argumentFor: (path) => VTP_PLACES[path],
      },
    );
  }

  private dot1xSpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => {
        const partage = collector as unknown as CommandTrie;
        this.registerDot1x({ config: partage, configIf: partage, privileged: partage });
      },
      {
        modes: ['config-if'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        modesFor: (path) => DOT1X_MODES[path.replace(/^no /, '')],
        minPrivilegeFor: privilegeSelonModes(DOT1X_MODES),
        argumentFor: (path) => DOT1X_PLACES[path],
      },
    );
  }

  private switchportL2Specs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerConfigIfCommands(collector as unknown as CommandTrie),
      {
        modes: ['config-if'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        skip: (path) => !/^(no )?switchport /.test(path) && !CONFIG_IF_AUTRES.has(path),
        argumentFor: (path) => SWITCHPORT_PLACES[path] ?? undefined,
        restDescriptionFor: (path) => path === 'description'
          ? 'Up to 240 characters describing this interface' : undefined,
        keywordsFor: (path) => SWITCHPORT_KEYWORDS[path],
      },
    );
  }

  private portSecuritySpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerPortSecurityOn(collector as unknown as CommandTrie),
      {
        modes: ['config-if'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        skip: (path) => path.startsWith('ip '),
        argumentFor: (path) => PORT_SECURITY_PLACES[path] ?? null,
        keywordsFor: (path) => PORT_SECURITY_KEYWORDS[path],
      },
    );
  }

  protected override socleLegends(): SocleLegend[] {
    return [
      ...super.socleLegends(),
      [['show', 'spanning-tree', 'pathcost'], 'Path cost method'],
    ];
  }

  private registerMacTableCommands(t: CommandTrie): void {
    t.registerGreedy('show mac address-table', 'Display MAC address table', (args) => {
      const a = args.map(x => x.toLowerCase());
      if (a[0] === 'count') return this.showMACAddressTableCount(this.d());
      if (a[0] === 'aging-time') return this.showMACAddressTableAgingTime(this.d());
      if (a[0] === 'notification') return this.showMacAddressTableNotification();
      const filter: { vlan?: number; port?: string; address?: string; type?: 'static' | 'dynamic' } = {};
      let i = 0;
      if (a[i] === 'dynamic' || a[i] === 'static') { filter.type = a[i] as 'static' | 'dynamic'; i++; }
      else if (a[i] === 'multicast') i++;
      if (a[i] === 'vlan' && a[i + 1] && /^\d+$/.test(a[i + 1])) filter.vlan = parseInt(a[i + 1], 10);
      else if (a[i] === 'interface' && args[i + 1]) {
        const pn = this.resolveInterfaceName(args.slice(i + 1).join(' '));
        if (!pn) return `% Invalid interface`;
        filter.port = pn;
      }
      else if (a[i] === 'address' && args[i + 1]) filter.address = args[i + 1];
      return this.showMACAddressTable(this.d(), Object.keys(filter).length ? filter : undefined);
    });

    t.registerGreedy('clear mac address-table', 'Clear MAC address table entries', (args) => {
      const a = args.map(x => x.toLowerCase());
      let i = 0;
      if (a[i] === 'dynamic') i++;
      const filter: { vlan?: number; port?: string } = {};
      if (a[i] === 'vlan' && a[i + 1] && /^\d+$/.test(a[i + 1])) {
        filter.vlan = parseInt(a[i + 1], 10);
      } else if (a[i] === 'interface' && args[i + 1]) {
        const pn = this.resolveInterfaceName(args[i + 1]);
        if (!pn) return `% Invalid interface name "${args[i + 1]}"`;
        filter.port = pn;
      }
      this.d().clearDynamicMACEntries(Object.keys(filter).length ? filter : undefined);
      return '';
    });

  }

  private registerDaiShowCommands(t: CommandTrie): void {
    t.registerGreedy('show dtp', 'Display DTP information', (args) => {
      const dtp = this.requireDtp();
      const ports = this.d().getPortNames();
      if (args[0]?.toLowerCase() === 'interface' && args[1]) {
        const name = this.resolveInterfaceName(args.slice(1).join(' ')) ?? args.slice(1).join(' ');
        if (!this.d().getPort(name)) return `% Invalid interface "${args.slice(1).join(' ')}"`;
        const s = dtp.getPortState(name);
        return [
          `DTP information for ${name}:`,
          `  TOS/TAS/TNS:                            ${s.operationalMode === 'trunk' ? 'TRUNK' : 'ACCESS'}/${this.dtpAdminLabel(s.adminMode)}/NONE`,
          `  TOT/TAT/TNT:                            ${s.trunkEncapsulation.toUpperCase()}/NEGOTIATE/NONE`,
          `  Neighbor address 1:                     ${s.peerMac ?? '000000000000'}`,
          `  Neighbor address 2:                     000000000000`,
          `  Hello timer expiration (sec/state):     0/RUNNING`,
          `  Access timer expiration (sec/state):    never/STOPPED`,
          `  Negotiation timer expiration (sec/st):  never/STOPPED`,
          `  Multidrop timer expiration (sec/state): never/STOPPED`,
          `  FSM state:                              S6:TRUNK`,
        ].join('\n');
      }
      const lines = ['Global DTP information', `  Sending DTP Hello packets every ${dtp.getConfig().helloSec} seconds`, '  Dynamic Trunk timeout is 300 seconds', ''];
      lines.push('Interface       Mode             Status         Negotiation');
      lines.push('--------------- ---------------- -------------- -----------');
      for (const p of ports) {
        const s = dtp.getPortState(p);
        const negotiation = s.adminMode === 'access' || s.adminMode === 'nonegotiate' ? 'off' : 'on';
        lines.push(
          `${this.abbreviateInterface(p).padEnd(16)}${this.dtpAdminLabel(s.adminMode).padEnd(17)}` +
          `${s.operationalMode.padEnd(15)}${negotiation}`,
        );
      }
      return lines.join('\n');
    });

    t.register('show ip arp inspection', 'Display DAI status', () => this.showArpInspection(this.d()));
    t.registerGreedy('show ip arp inspection vlan', 'Display DAI per VLAN', (args) =>
      this.showArpInspectionVlan(this.d(), args.join(',')));
    t.register('show ip arp inspection statistics', 'Display DAI counters', () =>
      this.showArpInspectionStats(this.d()));
    t.register('show ip arp inspection log', 'Display DAI log buffer', () =>
      this.showArpInspectionLog(this.d()));
    t.register('show ip arp inspection interfaces', 'Display DAI per interface', () =>
      this.showArpInspectionIfs(this.d()));
    t.register('show arp access-list', 'Display ARP ACLs', () => this.showArpAcls(this.d()));
    t.register('show errdisable recovery', 'Display errdisable recovery state', () => this.showErrdisableRecovery());
    t.registerGreedy('show ip device tracking', 'Display IP device tracking table', (args) =>
      this.showIpDeviceTracking(this.d(), args));
  }

  private registerVlanShowCommands(t: CommandTrie): void {
    t.register('show vlan summary', 'Display VLAN count summary', () => {
      const ids = [...this.d().getVLANs().keys()];
      const extended = ids.filter((id) => id >= 1006).length;
      const normal = ids.length - extended;
      return [
        `Number of existing VLANs          : ${ids.length}`,
        `Number of existing VTP VLANs      : ${normal}`,
        `Number of existing extended VLANs : ${extended}`,
      ].join('\n');
    });

    t.register('show vlan brief', 'Display VLAN summary', () => {
      return this.showVlanBrief(this.d());
    });

    t.register('show vlan', 'Display VLAN information', () => {
      return this.showVlanFull(this.d());
    });

    t.registerGreedy('show vlan id', 'Display a VLAN by id', (args) => {
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return '% Invalid VLAN id';
      return this.showVlanBrief(this.d(), { id });
    });

    t.registerGreedy('show vlan name', 'Display a VLAN by name', (args) => {
      if (!args[0]) return CISCO_ERRORS.INCOMPLETE;
      return this.showVlanBrief(this.d(), { name: args[0] });
    });

    t.registerGreedy('show vlan access-map', 'Display VLAN access maps',
      (args) => this.showVlanAccessMap(args[0]));
    t.registerGreedy('show vlan filter', 'Display VLAN filters',
      (args) => this.showVlanFilter(args[0]));
  }

  private registerVtpShowCommands(t: CommandTrie): void {
    t.register('show vtp password', 'Display the VTP password', () => {
      const cfg = this.requireVtp().getConfig();
      return cfg.password
        ? `VTP Password: ${cfg.password}`
        : 'The VTP password is not configured.';
    });
    t.register('show vtp status', 'Display VTP status', () => {
      const cfg = this.requireVtp().getConfig();
      const numVlans = this.d().getVLANs().size;
      const deviceId = this.formatMacCisco(new MACAddress(cfg.updaterMac));
      const updaterIp = cfg.lastUpdaterIdentity;
      const modifiedAt = cfg.lastUpdateTimestamp ? this.formatVtpTimestamp(cfg.lastUpdateTimestamp) : '0-0-00 00:00:00';
      return [
        `VTP Version capable             : 1 to 2`,
        `VTP version running             : ${cfg.version}`,
        `VTP Domain Name                 : ${cfg.domain || '<empty>'}`,
        `VTP Pruning Mode                : ${cfg.pruning ? 'Enabled' : 'Disabled'}`,
        `VTP Traps Generation            : Disabled`,
        `Device ID                       : ${deviceId}`,
        `Configuration last modified by ${updaterIp} at ${modifiedAt}`,
        `Local updater ID is ${updaterIp} on interface Vl1 (lowest numbered VLAN interface found)`,
        ``,
        `Feature VLAN:`,
        `--------------`,
        `VTP Operating Mode              : ${cfg.mode.charAt(0).toUpperCase() + cfg.mode.slice(1)}${cfg.version === 3 && cfg.primaryServer ? ', Primary Server' : ''}`,
        `Maximum VLANs supported locally : ${cfg.version === 3 ? 4094 : 1005}`,
        `Number of existing VLANs        : ${numVlans}`,
        `Configuration Revision          : ${cfg.revision}`,
      ].join('\n');
    });
    t.register('show vtp counters', 'Display VTP counters', () => {
      return 'VTP statistics:\nSummary advertisements received    : 0\nSubset advertisements received     : 0\nRequest advertisements received    : 0\nSummary advertisements transmitted : 0\nSubset advertisements transmitted  : 0\nRequest advertisements transmitted : 0\nNumber of config revision errors   : 0\nNumber of config digest errors     : 0';
    });
    t.register('show vtp devices', 'Display VTP devices in the domain', () => {
      const cdp = (this.d() as unknown as { getCdpAgent?: () => import('../../cdp/CdpAgent').CdpAgent }).getCdpAgent?.();
      const switches = (cdp?.getNeighbors() ?? []).filter(n => n.remoteType.startsWith('switch'));
      if (switches.length === 0) {
        return 'Retrieving device ID with revision > 0 from the ring...\nNo device found.';
      }
      const lines = [
        'Retrieving information from the VTP domain...',
        '',
        'Device ID          Platform           Local Interface',
        '----------------   ----------------   ----------------',
      ];
      for (const n of switches) {
        lines.push(`${n.remoteHost.padEnd(19)}${n.remotePlatform.padEnd(19)}${this.abbreviateInterface(n.localPort)}`);
      }
      return lines.join('\n');
    });
  }

  private registerStpShowCommands(t: CommandTrie): void {
    t.register('show spanning-tree summary', 'STP summary', () => {
      const sw = this.d();
      const agent = (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
      const stpStates = sw._getSTPStates();
      const ports = sw._getPortsInternal();
      const rootVlans = [...sw.getVLANs().keys()]
        .sort((a, b) => a - b)
        .filter(v => agent?.isRootForVlan(v) ?? false)
        .map(v => `VLAN${String(v).padStart(4, '0')}`);
      const rootForVlan = rootVlans.length ? rootVlans.join(', ') : 'none';
      let blocking = 0, listening = 0, learning = 0, forwarding = 0;
      for (const [name, state] of stpStates) {
        const port = ports.get(name);
        if (!port || !port.getIsUp() || !port.isConnected()) continue;
        if (state === 'blocking') blocking++;
        else if (state === 'listening') listening++;
        else if (state === 'learning') learning++;
        else if (state === 'forwarding') forwarding++;
      }
      const total = blocking + listening + learning + forwarding;
      const g = agent?.getGlobalStp();
      const onOff = (b: boolean | undefined) => (b ? 'is enabled' : 'is disabled');
      return [
        `Switch is in ${this.stpMode} mode`,
        `Root bridge for: ${rootForVlan}`,
        `Extended system ID           is enabled`,
        `Portfast Default             ${onOff(g?.portfastDefault)}`,
        `PortFast BPDU Guard Default  ${onOff(g?.bpduGuardGlobal)}`,
        `Portfast BPDU Filter Default ${onOff(g?.bpduFilterGlobal)}`,
        `Loopguard Default            ${onOff(g?.loopGuardGlobal)}`,
        `UplinkFast                   ${onOff(g?.uplinkFast)}`,
        `BackboneFast                 ${onOff(g?.backboneFast)}`,
        `Configured Pathcost method used is ${agent?.getPathcostMethod() ?? 'short'}`,
        ``,
        `Name                   Blocking Listening Learning Forwarding STP Active`,
        `---------------------- -------- --------- -------- ---------- ----------`,
        `VLAN0001               ${String(blocking).padStart(8)} ${String(listening).padStart(9)} ${String(learning).padStart(8)} ${String(forwarding).padStart(10)} ${String(total).padStart(10)}`,
      ].join('\n');
    });
    t.register('show spanning-tree mst configuration', 'MST region config', () =>
      this.showMstConfig());
    t.register('show spanning-tree mst configuration digest', 'MST region digest', () =>
      this.showMstConfig(true));
    t.registerGreedy('show spanning-tree interface', 'STP for an interface', (a) => {
      const name = this.resolvePortName(a.join(' ')) ?? a.join(' ');
      const lines = this.ifStp.get(name) ?? [];
      return `${name}\n` + (lines.length ? lines.join('\n') : '  (default STP settings)');
    });
    t.register('show spanning-tree', 'Display spanning tree state', () => this.showSpanningTree(this.d()));
    t.register('show spanning-tree detail', 'Detailed STP state', () => this.showStpDetail(this.d()));
    t.register('show spanning-tree root', 'STP root bridge info', () => this.showStpRoot(this.d()));
    t.register('show spanning-tree bridge', 'STP local bridge info', () => this.showStpBridge(this.d()));
    t.register('show spanning-tree blockedports', 'STP blocked ports', () => this.showStpBlockedPorts(this.d()));
    t.registerGreedy('show spanning-tree vlan', 'STP for a VLAN', (a) => {
      const id = parseInt(a[0], 10);
      if (isNaN(id)) return this.showSpanningTree(this.d());
      if (a[1]?.toLowerCase() === 'detail') return this.showStpDetail(this.d(), id);
      if (a[1]?.toLowerCase() === 'bridge') return this.showStpBridge(this.d(), id);
      if (a[1]?.toLowerCase() === 'root') return this.showStpRoot(this.d(), id);
      return this.showSpanningTree(this.d(), id);
    });
    t.register('show spanning-tree summary totals', 'STP summary totals', () =>
      `Switch is in ${this.stpMode} mode\n` +
      `Root bridge for: ${this.stpAgentOf(this.d())?.isRoot() ? 'VLAN0001' : 'none'}\n` +
      `                     Blocking Listening Learning Forwarding STP Active\n` +
      `-------------------- -------- --------- -------- ---------- ----------\n` +
      `1 vlan               ${this.stpSummaryCounts(this.d())}`);
    t.register('show spanning-tree inconsistentports', 'STP inconsistent ports', () => {
      const agent = this.stpAgentOf(this.d());
      const bad: string[] = [];
      for (const [portName] of this.d()._getSTPStates()) {
        if (agent?.isRootInconsistent(portName)) bad.push(this.abbreviateInterface(portName));
      }
      return [
        'Name                 Interface                Inconsistency',
        '-------------------- ------------------------ ------------------',
        ...bad.map((p) => `VLAN0001             ${p.padEnd(24)} Root Inconsistent`),
        '',
        `Number of inconsistent ports (segments) in the system : ${bad.length}`,
      ].join('\n');
    });
    t.register('show spanning-tree active', 'STP state on active interfaces', () =>
      this.showSpanningTree(this.d()));
    t.register('show spanning-tree pathcost method', 'STP default path-cost method', () =>
      `Spanning tree default pathcost method used is ${this.stpAgentOf(this.d())?.getPathcostMethod() ?? 'short'}`);
    t.registerGreedy('show spanning-tree mst', 'MST instance state', (a) => {
      if (a[0]?.toLowerCase() === 'configuration') return this.showMstConfig();
      if (!a[0]) return this.showMstInstances();
      const id = parseInt(a[0], 10);
      if (isNaN(id)) return CISCO_ERRORS.INVALID_INPUT;
      return this.showMstInstances(id);
    });
  }

  private registerSwitchDebugCommands(): void {
    const p = this.privilegedTrie;
    const svc = () => this.switchDebug();
    const guard = (raw: string): boolean => /[A-Z]/.test((raw.trim().split(/\s+/)[0]) ?? '');

    p.register('show debugging', 'Display active debugging', () =>
      this.mode === 'user' ? CISCO_ERRORS.INVALID_INPUT : (svc()?.format() ?? 'No debug flags are enabled'));

    p.register('debug all', 'Enable all debugging', () => svc()?.enableAll() ?? '');
    p.registerGreedy('debug spanning-tree', 'Enable STP debugging', (a) => {
      const what = a.join(' ') || 'all';
      return svc()?.enableScope('spanning-tree ' + what) ?? '';
    });
    p.registerGreedy('debug mac address-table', 'Enable MAC table debugging', () => svc()?.enableScope('mac') ?? '');
    p.registerGreedy('debug mac-address-table', 'Enable MAC table debugging', () => svc()?.enableScope('mac') ?? '');
    p.registerGreedy('debug link-state', 'Enable link-state debugging', () => svc()?.enableScope('link') ?? '');
    p.registerGreedy('debug', 'Enable debugging', (a, raw) => {
      if (guard(raw ?? '')) return CISCO_ERRORS.INVALID_INPUT;
      const arg = a.join(' ');
      const service = svc();
      if (!service || !service.recognizes(arg)) return CISCO_ERRORS.INVALID_INPUT;
      return service.enableScope(arg);
    });

    p.register('no debug all', 'Disable all debugging', () => svc()?.disableAll() ?? 'All possible debugging has been turned off');
    p.register('undebug all', 'Disable all debugging', () => svc()?.disableAll() ?? 'All possible debugging has been turned off');
    p.registerGreedy('no debug spanning-tree', 'Disable STP debugging', (a) => {
      const what = a.join(' ') || 'all';
      return svc()?.disableScope('spanning-tree ' + what) ?? '';
    });
    p.registerGreedy('no debug mac address-table', 'Disable MAC table debugging', () => svc()?.disableScope('mac') ?? '');
    p.registerGreedy('no debug link-state', 'Disable link-state debugging', () => svc()?.disableScope('link') ?? '');
    const undebugScope = (arg: string): string => {
      const service = svc();
      if (!service) return '';
      if (arg.trim() === '' || arg.trim() === 'all') return service.disableAll();
      if (!service.recognizes(arg)) return CISCO_ERRORS.INVALID_INPUT;
      return service.disableScope(arg);
    };
    p.registerGreedy('undebug', 'Disable debugging', (a) => undebugScope(a.join(' ')));
  }

  private switchDebug(): import('../router/diag/RouterDebugService').RouterDebugService | undefined {
    return (this.d() as unknown as { getDebugService?: () => import('../router/diag/RouterDebugService').RouterDebugService }).getDebugService?.();
  }

  private showMstConfig(withDigest = false): string {
    const region = this.stpAgentOf(this.d())?.getMstRegion();
    const instances = region?.instances ?? new Map<number, string>();
    const ml: string[] = [
      'Name      [' + (region?.name ?? '') + ']',
      'Revision  ' + (region?.revision ?? 0) + '     Instances configured ' +
        (instances.size + 1),
    ];
    if (withDigest) {
      ml.push(`Digest              0x${mstConfigDigest(instances)}`);
      return ml.join('\n');
    }
    ml.push(
      '-------------------------------------------------------------',
      'Instance  Vlans mapped',
      '--------  -------------------------------------------------',
      `0         ${vlansMappedToInstanceZero(instances)}`,
    );
    for (const [id, v] of instances) ml.push(`${String(id).padEnd(10)}${v}`);
    return ml.join('\n');
  }

  private showMstInstances(filter?: number): string {
    const sw = this.d();
    const agent = this.stpAgentOf(sw);
    if (!agent) return '';
    const region = agent.getMstRegion();
    const mac = this.formatMacCisco(new MACAddress(agent.ownBridgeId().mac));
    const ports = sw._getPortsInternal();
    const ids = [0, ...[...region.instances.keys()].sort((a, b) => a - b)];
    const blocks: string[] = [];
    for (const id of ids) {
      if (filter !== undefined && id !== filter) continue;
      const mapped = id === 0
        ? (region.instances.size ? 'all VLANs not explicitly mapped' : '1-4094')
        : (region.instances.get(id) ?? '');
      const prio = agent.getMstInstancePriority(id);
      const block = [
        `##### MST${id}    vlans mapped:   ${mapped}`,
        `Bridge        address ${mac}  priority  ${prio + id} (${prio} sysid ${id})`,
        '',
        'Interface        Role  Sts  Cost      Prio.Nbr  Type',
        '---------------- ----  ---  --------  --------  ----',
      ];
      let idx = 0;
      for (const name of sw.getPortNames()) {
        idx += 1;
        const port = ports.get(name);
        if (!port || !port.getIsUp() || !port.isConnected()) continue;
        // CIST (0) spans every region port regardless of VLAN mapping;
        // a named MSTI only lists ports actually carrying one of its VLANs.
        if (id !== 0 && !agent.portCarriesVlan(name, id)) continue;
        const role = agent.getPortRoleForInstance(id, name);
        const roleLabel = role === 'root' ? 'Root' : role === 'alternate' ? 'Altn'
          : role === 'backup' ? 'Back' : 'Desg';
        const sts = agent.getForwardStateForInstance(id, name) === 'forwarding' ? 'FWD' : 'BLK';
        const cost = agent.getPortCostForInstance(id, name);
        const linkType = agent.getPortLinkType(name) === 'shared' ? 'Shr' : 'P2p';
        block.push(`${this.abbreviateInterface(name).padEnd(17)}${roleLabel.padEnd(6)}${sts.padEnd(5)}${String(cost).padEnd(10)}${`128.${idx}`.padEnd(10)}${linkType}`);
      }
      blocks.push(block.join('\n'));
    }
    if (filter !== undefined && blocks.length === 0) {
      return `% MST instance ${filter} is not configured`;
    }
    return blocks.join('\n\n');
  }

  private resolvePortName(input: string): string | null {
    return resolveCiscoInterfaceName(this.d().getPortNames(), input);
  }

  /**
   * `<mac> vlan <n> interface <if>` — rend le triplet, ou le message de
   * refus d'IOS. Le VLAN doit exister et le port aussi : poser une
   * entrée statique vers un port absent créerait un trou noir muet.
   */
  private parseStaticMacArgs(args: string[]):
  { mac: string; vlan: number; port: string } | string {
    const mac = args[0] ?? '';
    if (!/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(mac)) {
      return '% Invalid MAC address (expected H.H.H)';
    }
    const iVlan = args.indexOf('vlan');
    const iIf = args.findIndex((a) => a === 'interface');
    if (iVlan < 0 || !args[iVlan + 1]) return CISCO_ERRORS.INCOMPLETE;
    const vlan = parseInt(args[iVlan + 1], 10);
    if (Number.isNaN(vlan) || vlan < 1 || vlan > 4094) return '% Invalid VLAN id';
    if (!this.d().getVLANs().has(vlan)) return `% VLAN ${vlan} does not exist`;
    if (iIf < 0 || !args[iIf + 1]) return CISCO_ERRORS.INCOMPLETE;
    const port = this.resolvePortName(args.slice(iIf + 1).join(' '));
    if (!port) return `% Invalid interface ${args.slice(iIf + 1).join(' ')}`;
    return { mac: mac.toLowerCase(), vlan, port };
  }

  // ─── User Commands ────────────────────────────────────────────────

  private registerUserCommands(): void {

    this.userTrie.registerGreedy('ping', 'Send echo messages', (args) => this.handlePing(args));
  }

  /**
   * Drive a management-plane ping from an SVI. Uses the shared async pipeline
   * (`_pendingAsync`) and the shared IOS renderer, exactly like the router.
   */
  private resolvePingSourceInterface(args: string[]): string[] | string {
    const idx = args.findIndex(a => a.toLowerCase() === 'source');
    if (idx === -1 || !args[idx + 1]) return args;
    const vlanMatch = args[idx + 1].match(/^vl(?:an)?$/i)
      ? args[idx + 2]
      : args[idx + 1].match(/^vl(?:an)?(\d+)$/i)?.[1];
    if (vlanMatch === undefined || !/^\d+$/.test(vlanMatch)) return args;
    const vlan = parseInt(vlanMatch, 10);
    const svi = this.d().getSvi(vlan);
    if (!svi || !svi.ip) {
      return `% Source interface Vlan${vlan} has no IP address assigned`;
    }
    const consumed = args[idx + 1].match(/^vl(?:an)?$/i) ? 3 : 2;
    return [...args.slice(0, idx), 'source', svi.ip.toString(), ...args.slice(idx + consumed)];
  }

  private handlePing(args: string[]): string {
    const resolved = this.resolvePingSourceInterface(args);
    if (typeof resolved === 'string') return resolved;
    const parsed = parsePingArgs(resolved);
    if (parsed.error) return parsed.error;
    const target = new IPAddress(parsed.target);
    this._pendingAsync = this.d()
      .executePingSequence(target, parsed.count, parsed.timeoutMs, parsed.sourceIP ?? undefined)
      .then(results => formatCiscoPing(parsed.target, parsed.count, parsed.timeoutMs, results, parsed.sizeBytes));
    return '';
  }

  // ─── Privileged Commands ──────────────────────────────────────────

  private registerPrivilegedCommands(): void {
    this.privilegedTrie.registerGreedy('ping', 'Send echo messages', (args) => this.handlePing(args));

    // `show storm-control` — la configuration était acceptée et
    // rangée (elle revient dans `show running-config interface`), mais
    // aucune vue ne la lisait. Les seuils affichés sont donc les vrais.
    //
    // Ce qui est honnête de dire : la colonne « Current » reste à 0.00%
    // parce qu'il n'existe pas de compteur de débit par port et par type
    // de trafic dans le plan de données. Inventer un pourcentage courant
    // serait la seule façon de mentir ici ; le seuil, lui, est exact.
    this.privilegedTrie.registerGreedy('show storm-control', 'Display storm-control settings', (args) => {
      const filtre = (args[0] ?? '').toLowerCase();
      const types = ['broadcast', 'multicast', 'unicast'];
      const voulu = types.includes(filtre) ? [filtre] : types;
      const lignes = ['Interface  Filter State   Upper        Lower        Current'];
      let trouve = false;
      for (const nom of this.d().getPortNames()) {
        const conf = (this.ifExtra.get(nom) ?? []).filter((l) => l.startsWith('storm-control'));
        for (const type of voulu) {
          const seuil = conf.find((l) => l.startsWith(`storm-control ${type} level`));
          if (!seuil) continue;
          trouve = true;
          // `storm-control <type> level <haut> [<bas>]` — le seuil haut
          // est le 4ᵉ mot, le bas est optionnel et vaut le haut sinon,
          // exactement comme sur IOS. Les pourcentages sortent à deux
          // décimales, la forme du vrai binaire.
          const { setting } = parseStormControl(seuil.split(/\s+/).slice(1));
          if (!setting || setting.kind !== 'level') continue;

          const unite = setting.unit === 'percent'
            ? stormControlPercent : (v: number) => String(v);
          lignes.push(`${this.abbreviateInterface(nom).padEnd(11)}${'Forwarding'.padEnd(15)}`
            + `${unite(setting.upper).padEnd(13)}${unite(setting.lower).padEnd(13)}0.00%`);
        }
      }
      if (!trouve) return lignes[0];
      return lignes.join('\n');
    });

    this.privilegedTrie.registerGreedy('show interfaces trunk', 'Display trunk ports', () => {
      return this.showTrunkTable(this.d().getPortNames());
    });

    this.privilegedTrie.registerGreedy('show etherchannel', 'Display EtherChannel',
      (args) => this.showEtherchannel(args));
    this.registerEtherchannelShowRest();
  }

  private showEtherchannel(args: string[]): string {
    {
      const lacp = this.requireLacp();
      const groups = lacp.getAllGroups();
      if (args[0]?.toLowerCase() === 'summary' || args.length === 0) {
        const lines = [
          'Flags:  D - down        P - bundled in port-channel',
          '        I - stand-alone s - suspended',
          '        H - Hot-standby (LACP only)',
          '        s - suspended',
          `Number of channel-groups in use: ${groups.length}`,
          'Group  Port-channel  Protocol    Ports',
          '------+-------------+-----------+-----------------------------------------',
        ];
        for (const g of groups) {
          const protocol = g.members.every(m => m.mode === 'on') ? '-' : 'LACP';
          const portList = g.members.map(m => {
            const flag = m.bundled ? 'P'
              : m.state === 'standby' ? 'H'
              : m.state === 'standalone' ? 'I' : 's';
            return `${this.abbreviateInterface(m.portName)}(${flag})`;
          }).join(' ');
          lines.push(`${String(g.id).padEnd(7)}${g.name.padEnd(14)}${protocol.padEnd(12)}${portList}`);
        }
        return lines.join('\n');
      }
      if (args[0]?.toLowerCase() === 'detail') {
        const out: string[] = [];
        for (const g of groups) {
          out.push(`Group: ${g.id}`);
          out.push(`Port-channels in the group: 1`);
          out.push(`Port-channel: ${g.name}`);
          out.push(`Number of ports = ${g.members.length}`);
          for (const m of g.members) {
            const port = this.d().getPort(m.portName);
            out.push(`  Port: ${m.portName}`);
            out.push(`    Status: ${m.bundled ? 'bundled' : m.state}`);
            const limites = lacp.getGroupLimits(g.id);
            if (m.state === 'standby') {
              out.push(`    Hot-standby (max-bundle ${limites.maxLinks})`);
            }
            out.push(`    Mode: ${m.mode}`);
            out.push(`    Partner: ${m.partner?.systemId ?? 'none'}`);
            out.push(`    Link: ${port?.getIsUp() ? 'up' : 'down'}`);
          }
        }
        return out.length > 0 ? out.join('\n') : 'No EtherChannel groups configured';
      }
      if (args[0]?.toLowerCase() === 'load-balance') {
        return 'EtherChannel Load-Balancing Configuration:\n'
          + `        ${lacp.getLoadBalance()}`;
      }
      if (args[0]?.toLowerCase() === 'port-channel'
        || args[1]?.toLowerCase() === 'port-channel') {
        const vise = /^\d+$/.test(args[0] ?? '') ? Number(args[0]) : null;
        const out: string[] = ['Port-channels in the group:', '----------------------'];
        for (const g of groups) {
          if (vise !== null && g.id !== vise) continue;
          const actifs = g.members.filter(m => m.bundled);
          out.push('');
          out.push(`Port-channel: ${g.name}    (Primary Aggregator)`);
          out.push('');
          out.push(`Age of the Port-channel   = 0d:00h:00m:00s`);
          out.push(`Logical slot/port   = 16/${g.id}   Number of ports = ${actifs.length}`);
          out.push(`Port state          = Port-channel Ag-Inuse`);
          out.push(`Protocol            =   ${actifs.length > 0 && g.members.some(m => m.mode !== 'on') ? 'LACP' : '-'}`);
          out.push(`Port security       = Disabled`);
        }
        return out.length > 2 ? out.join('\n') : 'No EtherChannel groups configured';
      }
      return 'EtherChannel: no detail';
    }
  }

  private registerEtherchannelShowRest(): void {
    // `show interfaces counters [<if>]` — registered on the `counters`
    // node itself (already created, actionless, by the shared `show
    // interfaces counters errors` registration above) so it gets an
    // action too. Without this, `show interfaces` counters` and `...
    // counters <if>` fell into that actionless intermediate node and
    // dead-ended on "% Incomplete command." — the trie's own child-first
    // lookahead (CommandTrie.ts) still routes `... counters errors`
    // through to its own leaf action underneath, unaffected.
    this.privilegedTrie.registerGreedy('show interfaces counters', 'Display interface counters', (args) => {
      if (args.length === 0) return this.showInterfacesCounters(null);
      const name = this.resolveInterfaceName(args.join(' '));
      if (!name || !this.d().getPort(name)) {
        return formatInvalidInput(16);
      }
      return this.showInterfacesCounters(name);
    });


    this.privilegedTrie.registerGreedy('show queuing interface', 'Display the 802.1p trust state of an interface', (args) => {
      const target = args.join(' ');
      const name = this.resolveInterfaceName(target) ?? target;
      if (!name || !this.d().getPort(name)) {
        return formatInvalidInput(23);
      }
      return this.showQueuingInterface(name);
    });

    this.privilegedTrie.register('write', 'Save running-config to startup-config', () => {
      return this.d().writeMemory();
    });

  }

  /**
   * Declare the sub-keywords that greedy `show` handlers parse internally
   * so Tab/`?` can complete them (e.g. `show interfaces status`). Purely
   * additive — execution is unchanged. Called at the end of the
   * constructor, after every command family is registered.
   */
  private registerShowCompletionKeywords(): void {
    for (const t of [this.privilegedTrie, this.userTrie]) {
      t.addCompletionKeywords('show access-lists', [
        { keyword: 'interface', description: 'ACLs applied to an interface' },
        { keyword: 'address', description: 'Filter by address' },
      ]);
      t.addCompletionKeywords('show port-security', [
        { keyword: 'interface', description: 'Port security for an interface' },
        { keyword: 'address', description: 'Secure MAC addresses' },
      ]);
    }
    const t = this.privilegedTrie;
    t.addCompletionKeywords('show interfaces', [
      { keyword: 'status', description: 'Interface line status' },
      { keyword: 'switchport', description: 'Switchport (L2) configuration' },
      { keyword: 'counters', description: 'Interface traffic counters' },
      { keyword: 'description', description: 'Interface descriptions' },
      { keyword: 'trunk', description: 'Trunk ports' },
    ]);
    t.addCompletionKeywords('show mac address-table', [
      { keyword: 'dynamic', description: 'Dynamic MAC entries' },
      { keyword: 'static', description: 'Static MAC entries' },
      { keyword: 'multicast', description: 'Multicast MAC entries' },
      { keyword: 'vlan', description: 'Entries for a given VLAN' },
      { keyword: 'interface', description: 'Entries for a given interface' },
      { keyword: 'address', description: 'A specific MAC address' },
      { keyword: 'count', description: 'MAC address count' },
    ]);
    t.addCompletionKeywords('show etherchannel', [
      { keyword: 'summary', description: 'One-line summary per channel-group' },
      { keyword: 'detail', description: 'Detailed EtherChannel state' },
      { keyword: 'port-channel', description: 'Port-channel information' },
    ]);
    t.addCompletionKeywords('show monitor session', [
      { keyword: 'all', description: 'All SPAN sessions' },
    ]);
  }

  private registerVlanEntry(trie: CommandTrie): void {
    trie.registerGreedy('vlan', 'VLAN configuration', (args) => {
      const lus = analyserListeVlan(args);
      if ('erreur' in lus) return lus.erreur;
      const ids = lus.ids;
      if (ids.some(i => i > 1005) && this.optionalVtp()?.allowsExtendedRangeVlans() === false) {
        return '% Extended-range VLANs require VTP version 3 or transparent mode';
      }
      let created = false;
      for (const id of ids) if (!this.d().getVLAN(id)) { this.d().createVLAN(id); created = true; }
      if (created) this.optionalVtp()?.onLocalVlanChange();
      if (ids.length === 1) {
        this.selectedVlan = ids[0];
        this.mode = 'config-vlan';
      }
      return '';
    });

    trie.registerGreedy('no vlan', 'Delete a VLAN', (args) => {
      const lus = analyserListeVlan(args);
      if ('erreur' in lus) return lus.erreur;
      if (lus.ids.includes(1)) return '% Default VLAN 1 may not be deleted.';

      const absents: number[] = [];
      let supprime = false;
      for (const id of lus.ids) {
        if (this.d().deleteVLAN(id)) supprime = true;
        else absents.push(id);
      }
      if (supprime) this.optionalVtp()?.onLocalVlanChange();
      return absents.length === 0 ? '' : `% VLAN ${absents[0]} not found.`;
    });
    trie.requireArgs('vlan', 1);
    trie.requireArgs('no vlan', 1);
  }

  private vlanEntrySpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerVlanEntry(collector as unknown as CommandTrie),
      {
        modes: ['config', 'config-vlan'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        argumentFor: () => ({
          name: 'ids', type: 'REST', range: [1, 4094], rangeIsAdvisory: true,
          description: 'ISL VLAN IDs 1-4094',
        }),
      });
  }

  // ─── Config Commands ──────────────────────────────────────────────

  protected override renduIpInterface(cible: string): string {
    const args = cible.trim().split(/\s+/).filter(Boolean);
    if (args[0]?.toLowerCase() === 'brief') return this.showIpInterfaceBrief();
    if (args.length === 0) return this.showIpInterfaceAll();
    return this.showIpInterfaceVerbose(args.join(' '));
  }

  private registerMacTableConfig(trie: CommandTrie): void {
    trie.registerGreedy('mac address-table aging-time', 'Set MAC address aging time', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const seconds = parseInt(args[0], 10);
      if (isNaN(seconds) || seconds < 0) return '% Invalid aging time';
      this.d().setMACAgingTime(seconds);
      return '';
    });

    // `mac address-table static <mac> vlan <n> interface <if>` — le sujet
    // déclaré d'une suite de debug de 346 étapes, et refusé jusqu'ici.
    // Le moteur, lui, était complet : `Switch.addStaticMAC` existe, le
    // type `static` est dans le modèle, et l'apprentissage respecte déjà
    // une entrée statique (elle n'est ni vieillie ni écrasée). Seule la
    // commande manquait (audit 11, §4.2).
    trie.registerGreedy('mac address-table learning', 'Enable MAC learning', (args) => {
      const r = this.parseMacLearningArgs(args);
      if (typeof r === 'string') return r;
      if (r.vlan !== undefined) this.d().setVlanMacLearning(r.vlan, true);
      if (r.iface !== undefined) this.d().setPortMacLearning(r.iface, true);
      return '';
    });
    trie.registerGreedy('no mac address-table learning', 'Disable MAC learning', (args) => {
      const r = this.parseMacLearningArgs(args);
      if (typeof r === 'string') return r;
      if (r.vlan !== undefined) this.d().setVlanMacLearning(r.vlan, false);
      if (r.iface !== undefined) this.d().setPortMacLearning(r.iface, false);
      return '';
    });

    trie.registerGreedy('mac address-table static', 'Add a static MAC entry', (args) => {
      const r = this.parseStaticMacArgs(args);
      if (typeof r === 'string') return r;
      this.d().addStaticMAC(r.mac, r.vlan, r.port);
      return '';
    });
    trie.registerGreedy('no mac address-table static', 'Remove a static MAC entry', (args) => {
      const r = this.parseStaticMacArgs(args);
      if (typeof r === 'string') return r;
      this.d().removeStaticMAC(r.mac, r.vlan);
      return '';
    });
  }

  private macTableSpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) =>
        this.registerMacTableConfig(collector as unknown as CommandTrie),
      {
        modes: ['config'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        argumentFor: (path) => MAC_TABLE_PLACES[path.replace(/^no /, '')],
      });
  }

  private registerConfigCommands(): void {
    // hostname is handled by base class (registerCommonConfigCommands)

    this.registerVlanEntry(this.configTrie);

    this.registerInterfaceEntry(this.configTrie);

    this.registerMacTableConfig(this.configTrie);

    // `notification change` demande un piège SNMP à chaque mouvement
    // d'adresse. Le simulateur n'a pas de générateur de piège sur ce
    // chemin ; accepter la commande sans rien envoyer serait une
    // promesse non tenue, alors elle reste refusée.

    this.configTrie.register('no shutdown', 'Enable interface', () => '');

    // ── Management plane: SSH host keys, domain, default-gateway ──
    // `crypto key generate rsa`, `crypto key zeroize rsa` et
    // `ip ssh version` vivaient ICI, en dur : la premiere ignorait
    // `modulus`/`label`/`usage-keys` et annoncait 512 bits quoi qu'on
    // demande, la deuxieme rendait une phrase sans rien supprimer, et la
    // troisieme ne rangeait rien — `show ip ssh` annoncait donc 1.99
    // apres un `ip ssh version 2` accepte sur la meme machine. Les vraies
    // sont enregistrees avec la famille identite, sur le meme magasin que
    // le routeur.
    this.configTrie.registerGreedy('ip default-gateway', 'Set the management default gateway', (args) => {
      if (!args[0] || !IPAddress.isValid(args[0])) return CISCO_ERRORS.INVALID_INPUT;
      this.d()._setDefaultGateway(args[0]);
      return '';
    });
    this.configTrie.register('no ip default-gateway', 'Remove the management default gateway', () => {
      this.d()._setDefaultGateway('');
      return '';
    });

  }

  private registerMonitorSessionCommands(trie: SwitchTries): void {
    trie.config.registerGreedy('monitor session', 'Configure SPAN session', (args) =>
      this.handleMonitorSession(args, false));
    trie.config.registerGreedy('no monitor session', 'Delete a SPAN session', (args) =>
      this.handleMonitorSession(args, true));

    for (const t of [trie.user, trie.privileged]) {
      t.register('show monitor', 'Display SPAN sessions', () => this.showMonitor(null));
      t.registerGreedy('show monitor session', 'Display SPAN session(s)', (args) => {
        if (args.length === 0 || args[0].toLowerCase() === 'all') return this.showMonitor(null);
        const id = parseInt(args[0], 10);
        if (Number.isNaN(id)) return '% Invalid session id.';
        return this.showMonitor(id);
      });
    }
  }

  private handleMonitorSession(args: string[], negate: boolean): string {
    if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
    const id = parseInt(args[0], 10);
    if (Number.isNaN(id) || id < 1 || id > 66) return '% Invalid session id.';
    const dev = this.d();

    if (negate && args.length === 1) {
      return dev.removeMirrorSession(id) ? '' : `% Session ${id} does not exist.`;
    }

    const verb = (args[1] ?? '').toLowerCase();
    if (verb === 'source') {
      const ifaceArg = args[2] === 'interface' ? args[3] : null;
      if (!ifaceArg) return CISCO_ERRORS.INCOMPLETE;
      const portName = this.resolveInterfaceName(ifaceArg);
      if (!portName || !dev.getPort(portName)) return `% Invalid interface name "${ifaceArg}"`;
      if (dev.getPortMirror().isDestination(portName)) {
        return `% Cannot add source — ${portName} is already a SPAN destination.`;
      }
      const dirTok = (args[4] ?? 'both').toLowerCase();
      if (dirTok !== 'rx' && dirTok !== 'tx' && dirTok !== 'both') {
        return '% Invalid direction (rx | tx | both).';
      }
      if (negate) return dev.removeMirrorSource(id, portName) ? '' : `% Source ${portName} not configured.`;
      dev.configureMirrorSource(id, portName, dirTok);
      return '';
    }

    if (verb === 'destination') {
      const ifaceArg = args[2] === 'interface' ? args[3] : null;
      if (!ifaceArg) return CISCO_ERRORS.INCOMPLETE;
      const portName = this.resolveInterfaceName(ifaceArg);
      if (!portName || !dev.getPort(portName)) return `% Invalid interface name "${ifaceArg}"`;
      const session = dev.getMirrorSession(id);
      if (session && [...session.sources.keys()].includes(portName)) {
        return `% Cannot set destination — ${portName} is already a source for session ${id}.`;
      }
      if (negate) return dev.removeMirrorDestination(id) ? '' : `% Destination not configured.`;
      dev.configureMirrorDestination(id, portName);
      return '';
    }

    return CISCO_ERRORS.INVALID_INPUT;
  }

  private showMonitor(only: number | null): string {
    const sessions = this.d().listMirrorSessions();
    if (sessions.length === 0) return '';
    if (only === null) {
      return sessions.map((s) => this.d().getPortMirror().formatOne(s.id)).join('\n\n');
    }
    if (!sessions.find((s) => s.id === only)) return `% Session ${only} does not exist.`;
    return this.d().getPortMirror().formatOne(only);
  }

  // ─── Config-if Commands ───────────────────────────────────────────

  private registerConfigIfCommands(trie: CommandTrie): void {
    trie.register('switchport protected',
      'Isolate this port from other protected ports', () =>
        this.applyToSelectedInterfaces(portName => {
          this.d().setPortProtected(portName, true);
          return '';
        }));
    trie.register('no switchport protected',
      'Stop isolating this port', () =>
        this.applyToSelectedInterfaces(portName => {
          this.d().setPortProtected(portName, false);
          return '';
        }));

    trie.register('switchport mode access', 'Set interface to access mode', () => {
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportMode(portName, 'access') ? '' : '% Error'
      );
    });

    trie.register('switchport mode trunk', 'Set interface to trunk mode', () => {
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportMode(portName, 'trunk') ? '' : '% Error'
      );
    });

    trie.register('switchport mode dot1q-tunnel', '802.1ad QinQ tunnel port (S-VLAN access port)', () => {
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportMode(portName, 'dot1q-tunnel') ? '' : '% Error'
      );
    });

    trie.register('switchport mode private-vlan host', 'Set interface as a private VLAN host port', () => {
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportMode(portName, 'access') ? '' : '% Error'
      );
    });

    trie.register('switchport mode private-vlan promiscuous', 'Set interface as a private VLAN promiscuous port', () => {
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportMode(portName, 'access') ? '' : '% Error'
      );
    });

    trie.registerGreedy('switchport mode private-vlan trunk', 'Set interface as a private VLAN trunk port', (args) => {
      const kind = args[0]?.toLowerCase();
      if (kind !== undefined && kind !== 'promiscuous' && kind !== 'host') {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportMode(portName, 'trunk') ? '' : '% Error'
      );
    });

    trie.registerGreedy('switchport private-vlan mapping trunk',
      'Map a promiscuous trunk to primary/secondary private VLANs', (args) => {
        if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
        const primary = parseInt(args[0], 10);
        if (isNaN(primary)) return '% Invalid VLAN ID';
        const secondarySet = this.parseVlanList(args[1]);
        if (!secondarySet) return '% Invalid VLAN list';
        const secondaries = [...secondarySet];
        return this.applyToSelectedInterfaces(portName => {
          const res = this.d().configurePvlanPromiscuousTrunk(portName, primary, secondaries);
          return res.ok ? '' : `% ${res.error}`;
        });
      });

    trie.registerGreedy('switchport private-vlan association trunk',
      'Associate an isolated trunk with its primary/secondary private VLAN', (args) => {
        if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
        const primary = parseInt(args[0], 10);
        const secondary = parseInt(args[1], 10);
        if (isNaN(primary) || isNaN(secondary)) return '% Invalid VLAN ID';
        return this.applyToSelectedInterfaces(portName => {
          const res = this.d().configurePvlanIsolatedTrunk(portName, primary, secondary);
          return res.ok ? '' : `% ${res.error}`;
        });
      });

    trie.registerGreedy('switchport private-vlan host-association',
      'Associate a host port with its primary/secondary private VLAN', (args) => {
        if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
        const primary = parseInt(args[0], 10);
        const secondary = parseInt(args[1], 10);
        if (isNaN(primary) || isNaN(secondary)) return '% Invalid VLAN ID';
        return this.applyToSelectedInterfaces(portName => {
          const res = this.d().configurePvlanHostPort(portName, primary, secondary);
          return res.ok ? '' : `% ${res.error}`;
        });
      });

    trie.registerGreedy('switchport private-vlan mapping',
      'Map a promiscuous port to primary/secondary private VLANs', (args) => {
        if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
        const primary = parseInt(args[0], 10);
        if (isNaN(primary)) return '% Invalid VLAN ID';
        const secondarySet = this.parseVlanList(args[1]);
        if (!secondarySet) return '% Invalid VLAN list';
        const secondaries = [...secondarySet];
        return this.applyToSelectedInterfaces(portName => {
          const res = this.d().configurePvlanPromiscuousPort(portName, primary, secondaries);
          return res.ok ? '' : `% ${res.error}`;
        });
      });

    trie.registerGreedy('private-vlan mapping',
      'Map secondary VLANs to this primary VLAN SVI', (args) => {
        const vlan = this.sviVlanId(this.selectedInterface ?? '');
        if (vlan === null) return CISCO_ERRORS.NOT_APPLICABLE_INTERFACE;
        if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
        const secondarySet = this.parseVlanList(args[0]);
        if (!secondarySet) return '% Invalid VLAN list';
        this.d().setPrivateVlanSviMapping(vlan, [...secondarySet]);
        return '';
      });

    trie.register('switchport mode dynamic auto', 'Negotiate trunk via DTP (passive)', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.requireDtp().setAdminMode(portName, 'dynamic-auto');
        return '';
      });
    });

    trie.register('switchport mode dynamic desirable', 'Negotiate trunk via DTP (active)', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.requireDtp().setAdminMode(portName, 'dynamic-desirable');
        return '';
      });
    });

    trie.register('switchport nonegotiate', 'Force trunk without DTP', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.requireDtp().setAdminMode(portName, 'nonegotiate');
        return '';
      });
    });

    trie.register('no switchport nonegotiate', 'Re-enable DTP negotiation', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.requireDtp().setAdminMode(portName, 'dynamic-auto');
        return '';
      });
    });

    trie.registerGreedy('switchport access vlan', 'Assign interface to access VLAN', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId) || vlanId < 1 || vlanId > 4094) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName =>
        this.d().setSwitchportAccessVlan(portName, vlanId) ? '' : '% Error'
      );
    });

    trie.registerGreedy('l2protocol-tunnel', 'Tunnel a client L2 control protocol across the S-VLAN instead of terminating it locally', (args) => {
      if (args[0] === undefined) throw new CliIncomplete();
      const proto = args[0].toLowerCase();
      if (proto !== 'cdp' && proto !== 'stp' && proto !== 'vtp' && proto !== 'lldp') {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      return this.applyToSelectedInterfaces(portName => {
        if (!this.d().getSwitchportConfig(portName)) return '% Error';
        this.d().enableL2ProtocolTunnel(portName, proto);
        return '';
      });
    });

    trie.registerGreedy('switchport vlan mapping', 'Selective QinQ: map a client VLAN to a service (S-VLAN)', (args) => {
      if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
      const cvlan = parseInt(args[0], 10);
      const svlan = parseInt(args[1], 10);
      if (isNaN(cvlan) || isNaN(svlan)) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName => {
        const cfg = this.d().getSwitchportConfig(portName);
        if (!cfg) return '% Error';
        if (!cfg.vlanMapping) cfg.vlanMapping = new Map();
        cfg.vlanMapping.set(cvlan, svlan);
        return '';
      });
    });

    trie.registerGreedy('switchport trunk native vlan', 'Set trunk native VLAN', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId)) return '% Invalid VLAN ID';
      return this.applyToSelectedInterfaces(portName =>
        this.d().setTrunkNativeVlan(portName, vlanId) ? '' : '% Error'
      );
    });

    trie.registerGreedy('switchport trunk allowed vlan', 'Set trunk allowed VLANs', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const sub = args[0].toLowerCase();

      if (sub === 'all') {
        return this.applyToSelectedInterfaces(portName =>
          this.d().setTrunkAllowedVlansAll(portName) ? '' : '% Error'
        );
      }
      if (sub === 'none') {
        return this.applyToSelectedInterfaces(portName =>
          this.d().setTrunkAllowedVlansNone(portName) ? '' : '% Error'
        );
      }
      if (sub === 'add') {
        if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
        const vlans = this.parseVlanList(args[1]);
        if (!vlans) return '% Invalid VLAN list';
        return this.applyToSelectedInterfaces(portName =>
          this.d().addTrunkAllowedVlans(portName, vlans) ? '' : '% Error'
        );
      }
      if (sub === 'remove') {
        if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
        const vlans = this.parseVlanList(args[1]);
        if (!vlans) return '% Invalid VLAN list';
        return this.applyToSelectedInterfaces(portName =>
          this.d().removeTrunkAllowedVlans(portName, vlans) ? '' : '% Error'
        );
      }
      if (sub === 'except') {
        if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
        const vlans = this.parseVlanList(args[1]);
        if (!vlans) return '% Invalid VLAN list';
        return this.applyToSelectedInterfaces(portName =>
          this.d().setTrunkAllowedVlansExcept(portName, vlans) ? '' : '% Error'
        );
      }

      // Default: replace the full list
      const vlans = this.parseVlanList(args[0]);
      if (!vlans) return '% Invalid VLAN list';
      return this.applyToSelectedInterfaces(portName =>
        this.d().setTrunkAllowedVlans(portName, vlans) ? '' : '% Error'
      );
    });

    // ── switchport extras / EtherChannel (recorded for show run) ──
    const recordIf = (line: string) => {
      const ifs = this.selectedInterface
        ? [this.selectedInterface] : this.selectedInterfaceRange;
      const verb = line.split(' ').slice(0, 3).join(' ');
      for (const i of ifs) {
        const l = (this.ifExtra.get(i) ?? []).filter(
          (existing) => existing.split(' ').slice(0, 3).join(' ') !== verb);
        l.push(line);
        this.ifExtra.set(i, l);
      }
      return '';
    };
    trie.registerGreedy('switchport trunk encapsulation', 'Trunk encapsulation', (args) => {
      if (this.selectedInterface && this.sviVlanId(this.selectedInterface) !== null) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      const t = (args[0] ?? '').toLowerCase();
      if (t !== 'dot1q' && t !== 'negotiate') {
        return `% ${args[0]} encapsulation is not supported on this platform`;
      }
      return recordIf(`switchport trunk encapsulation ${args.join(' ')}`.trim());
    });
    // `speed` and `duplex` drive the real port, as the router's own
    // handlers already did. Stored as raw text here, they left three
    // views contradicting the configuration on the same machine, and
    // STP cost, CDP's reported duplex and cable negotiation — all of
    // which read the port — never saw the operator's choice.
    const targetPorts = (): Array<import('../../hardware/Port').Port> => {
      const names = this.selectedInterface
        ? [this.selectedInterface] : this.selectedInterfaceRange;
      return names
        .map((n) => this.d().getPort(n))
        .filter((p): p is import('../../hardware/Port').Port => !!p);
    };
    // An SVI is a virtual L3 interface and rejects these, as real IOS
    // does. The refusal is signalled rather than worded: the diagnostic
    // renderer is the single place that puts it into English.
    const rejectOnSvi = (): void => {
      if (this.selectedInterface && this.sviVlanId(this.selectedInterface) !== null) {
        throw new CliInvalidInput();
      }
    };
    trie.registerGreedy('duplex', 'Set interface duplex', (args) => {
      rejectOnSvi();
      if (args[0] === undefined) throw new CliIncomplete();
      const a = args[0].toLowerCase();
      if (a !== 'full' && a !== 'half' && a !== 'auto') {
        throw new CliInvalidInput({ argIndex: 0, token: args[0] });
      }
      for (const port of targetPorts()) {
        if (a === 'auto') { port.setNegotiationAuto(true); continue; }
        port.setDuplex(a === 'half' ? 'half' : 'full');
        port.setNegotiationAuto(false);
      }
      return recordIf(`duplex ${a}`);
    });
    trie.registerGreedy('speed', 'Set interface speed', (args) => {
      rejectOnSvi();
      if (args[0] === undefined) throw new CliIncomplete();
      const a = args[0].toLowerCase();
      if (a === 'auto') {
        for (const port of targetPorts()) port.setNegotiationAuto(true);
        return recordIf('speed auto');
      }
      if (!/^\d+$/.test(a)) throw new CliInvalidInput({ argIndex: 0, token: args[0] });
      const n = parseInt(a, 10);
      for (const port of targetPorts()) {
        try { port.setSpeed(n); } catch { throw new CliInvalidInput({ argIndex: 0, token: args[0] }); }
        port.setNegotiationAuto(false);
      }
      return recordIf(`speed ${n}`);
    });
    for (const sub of [
      'switchport voice', 'storm-control', 'srr-queue',
    ]) {
      trie.registerGreedy(sub, `Interface ${sub}`, (args) => {
        // These are physical-port-only; an SVI is a virtual L3 interface and
        // rejects them just like real IOS does.
        if (this.selectedInterface && this.sviVlanId(this.selectedInterface) !== null) {
          return CISCO_ERRORS.INVALID_INPUT;
        }
        if (sub === 'switchport voice') {
          if (args[0] === undefined) throw new CliIncomplete();
          throw new CliInvalidInput({ token: args[0] });
        }
        if (sub === 'storm-control') {
          const parsed = parseStormControl(args);
          if (parsed.incomplete) throw new CliIncomplete();
          if (!parsed.setting) throw new CliInvalidInput({ token: args[parsed.at] });
        }
        return recordIf(`${sub} ${args.join(' ')}`.trim());
      });
    }
    trie.registerGreedy('no storm-control', 'Remove a storm-control setting', (args) => {
      const quoi = (args[0] ?? '').toLowerCase();
      if (quoi === 'action') return removeIf('storm-control action');
      if (!STORM_CONTROL_TYPES.includes(quoi)) throw new CliInvalidInput({ token: args[0] });

      return removeIf(`storm-control ${quoi} level`);
    });

    const removeIf = (prefix: string) => {
      const ifs = this.selectedInterface
        ? [this.selectedInterface] : this.selectedInterfaceRange;
      for (const i of ifs) {
        const l = this.ifExtra.get(i);
        if (l) this.ifExtra.set(i, l.filter(x => !x.startsWith(prefix)));
      }
      return '';
    };
    trie.registerGreedy('switchport voice vlan', 'Set the voice VLAN', (args) => {
      if (args[0] === undefined) throw new CliIncomplete();
      if (args[1] !== undefined) throw new CliInvalidInput({ token: args[1] });
      const mode = voiceVlanMode(args[0]);
      const vlan = mode === null
        ? entierBorne(args[0], VLAN_MIN, VLAN_MAX) : undefined;
      const ifs = this.selectedInterface ? [this.selectedInterface] : this.selectedInterfaceRange;
      for (const i of ifs) {
        const cfg = this.d().getSwitchportConfig(i);
        if (!cfg) continue;
        cfg.voiceVlan = vlan;
        cfg.voiceVlanMode = mode ?? undefined;
      }
      return '';
    });
    trie.register('no switchport voice vlan', 'Remove voice VLAN', () => {
      const ifs = this.selectedInterface ? [this.selectedInterface] : this.selectedInterfaceRange;
      for (const i of ifs) {
        const cfg = this.d().getSwitchportConfig(i);
        if (!cfg) continue;
        cfg.voiceVlan = undefined;
        cfg.voiceVlanMode = undefined;
      }
      return removeIf('switchport voice');
    });

    // ── 802.1p (PCP) trust boundary — mls qos ──────────────────────
    trie.register('mls qos trust cos', 'Trust the CoS carried in the incoming 802.1Q tag', () =>
      this.applyToSelectedInterfaces(p => {
        const cfg = this.d().getSwitchportConfig(p);
        if (cfg) cfg.trustMode = 'cos';
        return '';
      }));
    trie.register('mls qos trust dscp', 'Trust the DSCP field, derive CoS from it', () =>
      this.applyToSelectedInterfaces(p => {
        const cfg = this.d().getSwitchportConfig(p);
        if (cfg) cfg.trustMode = 'dscp';
        return '';
      }));
    trie.register('no mls qos trust', 'Reset the port to untrusted', () =>
      this.applyToSelectedInterfaces(p => {
        const cfg = this.d().getSwitchportConfig(p);
        if (cfg) cfg.trustMode = 'untrusted';
        return '';
      }));
    trie.registerGreedy('mls qos cos', 'Default CoS applied to untrusted ingress traffic', (args) => {
      if (args[0] === undefined) throw new CliIncomplete();
      const n = parseInt(args[0], 10);
      if (isNaN(n) || n < 0 || n > 7) return CISCO_ERRORS.INVALID_INPUT;
      return this.applyToSelectedInterfaces(p => {
        const cfg = this.d().getSwitchportConfig(p);
        if (cfg) cfg.defaultCos = n;
        return '';
      });
    });
    trie.registerGreedy('switchport priority extend cos', 'Remark the phone\'s downstream PC traffic to a fixed CoS', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 0 || n > 7) return CISCO_ERRORS.INVALID_INPUT;
      return this.applyToSelectedInterfaces(p => {
        const cfg = this.d().getSwitchportConfig(p);
        if (cfg) cfg.priorityExtend = { mode: 'cos', value: n };
        return '';
      });
    });
    trie.register('switchport priority extend trust', 'Trust the CoS already set by the downstream PC', () =>
      this.applyToSelectedInterfaces(p => {
        const cfg = this.d().getSwitchportConfig(p);
        if (cfg) cfg.priorityExtend = { mode: 'trust' };
        return '';
      }));

    trie.registerGreedy('switchport trunk pruning vlan', 'Set pruning-eligible VLANs', (args) => {
      if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      const sub = args[0].toLowerCase();
      if (sub === 'none') return recordIf('switchport trunk pruning vlan none');
      if (sub === 'add' || sub === 'remove' || sub === 'except') {
        if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
        if (!this.parseVlanList(args[1])) return '% Invalid VLAN list';
        return recordIf(`switchport trunk pruning vlan ${sub} ${args[1]}`);
      }
      if (!this.parseVlanList(args[0])) return '% Invalid VLAN list';
      return recordIf(`switchport trunk pruning vlan ${args[0]}`);
    });
    trie.register('no switchport trunk pruning vlan', 'Reset pruning-eligible VLANs', () =>
      removeIf('switchport trunk pruning'));

    trie.registerGreedy('channel-group', 'EtherChannel membership', (args) => {
      if (args.length < 3) return CISCO_ERRORS.INCOMPLETE;
      const id = parseInt(args[0], 10);
      if (isNaN(id) || id < 1 || id > 64) return '% Invalid channel-group id';
      if (args[1].toLowerCase() !== 'mode') return CISCO_ERRORS.INCOMPLETE;
      const m = args[2].toLowerCase();
      let mode: 'active' | 'passive' | 'on';
      // `desirable` and `auto` are PAgP modes. They used to be folded
      // into LACP active/passive, so asking for PAgP silently put LACP
      // frames on the wire — a lie the operator had no way to see.
      if (m === 'desirable' || m === 'auto') {
        return `% ${m} is a PAgP mode and PAgP is not implemented; use active, passive or on.`;
      }
      if (m === 'active') mode = 'active';
      else if (m === 'passive') mode = 'passive';
      else if (m === 'on') mode = 'on';
      else return '% Invalid channel-group mode';
      return this.applyToSelectedInterfaces(portName => {
        this.requireLacp().addPortToGroup(portName, id, mode);
        this.d().inheritAggregateSwitchport(`Port-channel${id}`, portName);
        return '';
      });
    });
    trie.registerGreedy('no channel-group', 'Remove EtherChannel membership', () => {
      return this.applyToSelectedInterfaces(portName => {
        this.requireLacp().removePort(portName);
        return '';
      });
    });

    const paquet: SwitchTries = isCollector(trie)
      ? { config: trie, configIf: trie, privileged: trie, user: new CommandTrie() }
      : {
        config: this.configTrie, configIf: this.configIfTrie,
        privileged: this.privilegedTrie, user: this.userTrie,
      };
    this.registerDot1x(paquet);
    this.registerLacp(paquet);

    trie.register('shutdown', 'Disable interface', () => {
      return this.applyToSelectedInterfaces(portName => this.setIfAdminState(portName, false));
    });

    trie.register('no shutdown', 'Enable interface', () => {
      return this.applyToSelectedInterfaces(portName => this.setIfAdminState(portName, true));
    });

    trie.registerGreedy('description', 'Interface description', (args) => {
      if (!this.selectedInterface || args.length < 1) return CISCO_ERRORS.INCOMPLETE;
      return this.applyToSelectedInterfaces(portName => {
        this.d().setInterfaceDescription(portName, args.join(' '));
        return '';
      });
    });

    trie.register('no description', 'Remove interface description', () => {
      if (!this.selectedInterface) return '';
      return this.applyToSelectedInterfaces(portName => {
        this.d().setInterfaceDescription(portName, '');
        return '';
      });
    });

  }

  // ─── Running Config Builder ───────────────────────────────────────

  private blocConfigInterface(name: string): string {
    const complet = this.buildRunningConfig(this.d()).split('\n');
    const debut = complet.findIndex((l) => l.trim() === `interface ${name}`);
    const corps: string[] = [`interface ${name}`];
    if (debut >= 0) {
      for (let i = debut + 1; i < complet.length; i++) {
        const l = complet[i];
        if (!/^\s/.test(l) || l.trim() === '!') break;
        corps.push(l);
      }
    }
    corps.push('end');
    const octets = new TextEncoder().encode(corps.join('\n')).length;
    return [
      'Building configuration...', '', `Current configuration : ${octets} bytes`, '!',
      ...corps,
    ].join('\n');
  }

  private static readonly DEFAULT_PORT_MTU = 1500;
  private static readonly DEFAULT_LACP_PORT_PRIORITY = 32768;

  private parseMacLearningArgs(
    args: readonly string[],
  ): { vlan?: number; iface?: string } | string {
    const mots = args.filter(a => a.length > 0);
    if (mots.length === 0) return CISCO_ERRORS.INCOMPLETE;
    const out: { vlan?: number; iface?: string } = {};
    let i = 0;
    while (i < mots.length) {
      const mot = mots[i].toLowerCase();
      if (mot === 'vlan') {
        const id = parseInt(mots[i + 1] ?? '', 10);
        if (isNaN(id) || id < 1 || id > 4094) return CISCO_ERRORS.INVALID_INPUT;
        out.vlan = id;
        i += 2;
        continue;
      }
      if (mot === 'interface') {
        const nom = this.resolveInterfaceName(mots.slice(i + 1).join(' '));
        if (!nom || !this.d().getPort(nom)) return CISCO_ERRORS.INVALID_INPUT;
        out.iface = nom;
        i = mots.length;
        continue;
      }
      return CISCO_ERRORS.INVALID_INPUT;
    }
    if (out.vlan === undefined && out.iface === undefined) return CISCO_ERRORS.INCOMPLETE;
    return out;
  }

  private renderSwitchGlobalLines(sw: CiscoSwitch): string[] {
    const out: string[] = [];

    if (sw.getMACAgingTime() !== CiscoSwitchShell.DEFAULT_MAC_AGING_SEC) {
      out.push(`mac address-table aging-time ${sw.getMACAgingTime()}`);
    }
    for (const e of sw.getMACTable()) {
      if (e.type !== 'static') continue;
      out.push(`mac address-table static ${e.mac} vlan ${e.vlan} interface ${e.port}`);
    }
    for (const [vlan] of sw.getMacLearningDisabledVlans()) {
      out.push(`no mac address-table learning vlan ${vlan}`);
    }
    for (const [port] of sw.getMacLearningDisabledPorts()) {
      out.push(`no mac address-table learning interface ${port}`);
    }

    out.push(...dhcpSnoopingRunningConfigLines(sw._getDHCPSnoopingConfig()));

    const lacp = sw.getLacpAgent?.()?.getConfig?.();
    if (lacp) {
      if (lacp.systemPriority !== CiscoSwitchShell.DEFAULT_LACP_SYSTEM_PRIORITY) {
        out.push(`lacp system-priority ${lacp.systemPriority}`);
      }

    }

    const udld = sw.getUdldAgent?.()?.getConfig?.();
    if (udld && udld.globalMode !== 'disabled') {
      out.push(udld.globalMode === 'aggressive' ? 'udld aggressive' : 'udld enable');
    }
    if (udld && udld.helloIntervalSec !== UDLD_DEFAULT_HELLO_SEC) {
      out.push(`udld message time ${udld.helloIntervalSec}`);
    }
    if (sw.getDot1xAgent?.()?.getConfig?.()?.enabled) out.push('dot1x system-auth-control');

    out.push(...sw.getPortMirror().asRunningConfigLines());
    out.push(...runningConfigACLFrom(sw.getVaclEngine().getAccessListsInternal()));
    out.push(...sw.vlanAccessMapRunningConfigLines());

    return out;
  }

  private static readonly DEFAULT_MAC_AGING_SEC = 300;
  private static readonly DEFAULT_LACP_SYSTEM_PRIORITY = 32768;

  private renderPortLayer2Lines(
    sw: CiscoSwitch, portName: string, port: import('../../hardware/Port').Port,
  ): string[] {
    const out: string[] = [];
    const mtu = port.getMTU();
    if (mtu !== CiscoSwitchShell.DEFAULT_PORT_MTU) out.push(`mtu ${mtu}`);

    const l2pt = sw.getSwitchportConfig(portName)?.l2ptProtocols;
    for (const proto of ['cdp', 'stp', 'vtp', 'lldp'] as const) {
      if (l2pt?.has(proto)) out.push(`l2protocol-tunnel ${proto}`);
    }

    const lacpPort = sw.getLacpAgent?.()?.getPortInfo?.(portName);
    if (lacpPort && lacpPort.portPriority !== CiscoSwitchShell.DEFAULT_LACP_PORT_PRIORITY) {
      out.push(`lacp port-priority ${lacpPort.portPriority}`);
    }
    if (lacpPort?.fastRate === true) out.push('lacp rate fast');

    const udld = sw.getUdldAgent?.();
    const udldMode = udld?.getPortRuntime?.(portName)?.mode;
    const udldGlobal = udld?.getConfig?.().globalMode ?? 'disabled';
    if (udldMode && udldMode !== udldGlobal) {
      out.push(udldMode === 'disabled' ? 'no udld port'
        : `udld port${udldMode === 'aggressive' ? ' aggressive' : ''}`);
    }

    const dot1x = sw.getDot1xAgent?.()?.getPortRuntime?.(portName);
    if (dot1x) {
      out.push('dot1x pae authenticator');
      if (dot1x.mode !== 'disabled') out.push(`dot1x port-control ${dot1x.mode}`);
    }

    out.push(...dhcpSnoopingInterfaceLines(sw._getDHCPSnoopingConfig(), portName)
      .map(l => l.trimStart()));

    return out;
  }

  buildRunningConfig(sw: CiscoSwitch): string {
    const chiffre = sw.getServiceFlags?.().get('password-encryption') === true;
    const lines = [
      'Building configuration...',
      '',
      'Current configuration:',
      '!',
      `hostname ${sw.getHostname()}`,
      '!',
    ];

    for (const kind of ['motd', 'login', 'exec', 'incoming'] as const) {
      const text = (sw as unknown as { getBanner?: (k: string) => string }).getBanner?.(kind);
      if (text) {
        lines.push(`banner ${kind} ^C\n${text}\n^C`);
        lines.push('!');
      }
    }

    const enableSecret = sw.getEnableSecret();
    if (enableSecret) lines.push(`enable secret ${renderSecretField(enableSecret.value, enableSecret.algo, 'enable')}`);
    const enablePassword = sw.getEnablePassword();
    if (enablePassword) lines.push(`enable password ${renderPasswordField(enablePassword.value, enablePassword.algo, false, false, 'enable')}`);
    // AAA / TACACS+ / RADIUS / `login block-for` / vues d'analyseur.
    // Le magasin est attache a l'appareil par un symbole, donc le
    // Catalyst le portait deja des qu'il a su ces commandes — seul le
    // rendu du routeur le lisait, si bien qu'une configuration TACACS+
    // posee sur un commutateur etait acceptee, honoree par les vues, et
    // perdue au rechargement de la topologie.
    const secLines = (sw as unknown as {
      [s: symbol]: { asRunningConfigLines?: () => string[] } | undefined;
    })[Symbol.for('CiscoSecurityConfig')]?.asRunningConfigLines?.() ?? [];
    if (secLines.length > 0) { lines.push(...secLines); lines.push('!'); }

    // `enable secret level N` — le MEME rendu que le routeur. Le magasin
    // vit sur `Equipment`, donc le Catalyst le portait deja ; seul le
    // rendu du routeur le lisait, si bien qu'un niveau intermediaire
    // configure ici disparaissait au rechargement de la topologie.
    const niveaux = enableLevelSecretConfigLines(sw, chiffre);
    if (niveaux.length > 0) lines.push(...niveaux);
    if (enableSecret || enablePassword || niveaux.length > 0) lines.push('!');

    const dnsLignes = [...sw._getDnsConfig().runningConfigLines(), ...hostsTableLines(sw)];
    if (dnsLignes.length > 0) { lines.push(...dnsLignes); lines.push('!'); }
    else if (sw.getDomainName()) { lines.push(`ip domain-name ${sw.getDomainName()}`); lines.push('!'); }
    if (sw.getDefaultGateway()) { lines.push(`ip default-gateway ${sw.getDefaultGateway()}`); lines.push('!'); }

    const snoopingConfig = (sw as unknown as {
      getIgmpSnoopingAgent?: () => { getConfig(): SnoopingConfig };
    }).getIgmpSnoopingAgent?.().getConfig();
    const snooping = snoopingConfig ? igmpSnoopingRunningConfigLines(snoopingConfig) : [];
    if (snooping.length > 0) { lines.push(...snooping); lines.push('!'); }

    // Les vues AVANT les comptes, pour la meme raison que sur le
    // routeur : `username X view NOC` refuse une vue inconnue, donc une
    // configuration qui nommerait la vue apres le compte ne serait pas
    // rejouable — et c'est ce que l'import d'une topologie en fait.
    const viewLines = (sw as unknown as {
      [k: symbol]: { parserViewLines?: () => string[] } | undefined;
    })[Symbol.for('CiscoSecurityConfig')]?.parserViewLines?.() ?? [];
    if (viewLines.length > 0) {
      lines.push('!');
      lines.push(...viewLines);
    }

    // Local AAA users (`username NAME privilege N secret …`).
    const users = sw._listLocalUsers();
    if (users.length > 0) {
      for (const u of users) lines.push(...renderCiscoUsernameLines(u, false));
      lines.push('!');
    }

    const lignesAlias = this._getAliasRunningConfigLines();
    if (lignesAlias.length > 0) {
      lines.push(...lignesAlias);
      lines.push('!');
    }

    // `line console 0` et `line aux 0` — le MEME rendu que le routeur.
    // Ils n'etaient ecrits que la, donc un Catalyst acceptait
    // `password`/`login` sur sa console et ne les rendait nulle part.
    lines.push(...consoleAndAuxLineConfigLines(sw, chiffre));

    // Le MEME rendu que le routeur, et non un second : celui-ci ecrivait
    // toujours le stratum la ou IOS l'omet a sa valeur par defaut, et ne
    // connaissait ni `update-calendar`, ni `authentication-key`, ni
    // `access-group` — donc un Catalyst acceptait sa cle NTP, l'honorait,
    // et ne la rendait nulle part.
    const lignesNtp = getNtpAgent(sw)?.asRunningConfigLines() ?? [];
    if (lignesNtp.length > 0) { lines.push(...lignesNtp); lines.push('!'); }

    const lignesSnmp = getSnmpService(sw)?.asRunningConfigLines() ?? [];
    if (lignesSnmp.length > 0) { lines.push(...lignesSnmp); lines.push('!'); }

    const lignesVrf = vrfRunningConfigLines((sw as unknown as VrfHost)._vrfs);
    if (lignesVrf.length > 0) { lines.push(...lignesVrf); lines.push('!'); }

    // VTY line configuration (transport input, login, password, …).
    const vtyLines = sw._getVtyLineConfig().renderAllCisco(chiffre);
    if (vtyLines.length > 0) { lines.push(...vtyLines); lines.push('!'); }

    if (sw.isIpRoutingEnabled()) { lines.push('ip routing'); lines.push('!'); }

    const drapeaux = serviceFlagLines(sw);
    if (drapeaux.length > 0) { lines.push(...drapeaux); lines.push('!'); }

    const dhcpLines = dhcpRunningConfigLines(sw._getDHCPServerInternal());
    if (dhcpLines.length > 0) { lines.push(...dhcpLines); lines.push('!'); }

    for (const [id, vlan] of sw.getVLANs()) {
      if (id === 1) continue;
      lines.push(`vlan ${id}`);
      lines.push(` name ${vlan.name}`);
      lines.push('!');
    }

    // ── ARP ACLs ──
    for (const [, acl] of sw._getArpAccessLists()) {
      lines.push(`arp access-list ${acl.name}`);
      for (const e of acl.entries) lines.push(` ${e.raw}`);
      lines.push('!');
    }

    // ── DAI globals ──
    const dai = sw._getArpInspectionConfig();
    if (dai.vlans.size > 0) {
      const sorted = Array.from(dai.vlans).sort((a, b) => a - b);
      lines.push(`ip arp inspection vlan ${this.compactVlanList(sorted)}`);
    }
    if (dai.validate.srcMac || dai.validate.dstMac || dai.validate.ip) {
      const toks: string[] = [];
      if (dai.validate.srcMac) toks.push('src-mac');
      if (dai.validate.dstMac) toks.push('dst-mac');
      if (dai.validate.ip) toks.push('ip');
      lines.push(`ip arp inspection validate ${toks.join(' ')}`);
    }
    for (const [vlan, f] of dai.vlanAclFilters) {
      lines.push(`ip arp inspection filter ${f.aclName} vlan ${vlan}${f.staticMode ? ' static' : ''}`);
    }
    if (dai.errDisableRecoverySec > 0) {
      lines.push('errdisable recovery cause arp-inspection');
      lines.push(`errdisable recovery interval ${dai.errDisableRecoverySec}`);
    }
    if (sw._getPsecRecoverySec() > 0) {
      lines.push('errdisable recovery cause psecure-violation');
    }
    if ((sw._getBpduGuardRecoverySec?.() ?? 0) > 0) {
      lines.push('errdisable recovery cause bpduguard');
    }

    const cdpAgent = (sw as unknown as { getCdpAgent?: () => import('../../cdp/CdpAgent').CdpAgent }).getCdpAgent?.();
    if (cdpAgent) for (const l of cdpAgent.runningConfigGlobalLines()) lines.push(l);
    const lldpAgent = (sw as unknown as { getLldpAgent?: () => import('../../lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
    if (lldpAgent) for (const l of lldpAgent.runningConfigGlobalLines()) lines.push(l);
    const stpAgent = (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
    if (stpAgent) for (const l of stpAgent.runningConfigGlobalLines()) lines.push(l);
    const vtpAgent = (sw as unknown as { getVtpAgent?: () => import('../../vtp/VtpAgent').VtpAgent }).getVtpAgent?.();
    if (vtpAgent) for (const l of vtpAgent.runningConfigGlobalLines()) lines.push(l);
    // DTP and LACP are resolved the same way, and for the same reason: this
    // shell also drives `GenericSwitch`, which runs neither protocol and
    // therefore has no agent to ask. Reading them unconditionally threw
    // `sw.getDtpAgent is not a function` here — inside the very function a
    // topology SAVE goes through — so exporting any topology holding a
    // generic switch failed outright, for every device in it, not just
    // that one. An unmanaged port has no negotiated mode and no channel
    // group, which is exactly what "no agent, no lines" renders.
    const dtpAgent = (sw as unknown as { getDtpAgent?: () => import('../../dtp/DtpAgent').DtpAgent }).getDtpAgent?.();
    const lacpAgent = (sw as unknown as { getLacpAgent?: () => import('../../lacp/LacpAgent').LacpAgent }).getLacpAgent?.();
    for (const l of this.renderSwitchGlobalLines(sw)) lines.push(l);
    if (dai.vlans.size > 0 || dai.vlanAclFilters.size > 0) lines.push('!');

    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();
    const descs = sw._getInterfaceDescriptions();
    const agregats = (sw as unknown as { getLacpAgent?: () => {
      getAllGroups(): Array<{ id: number; name: string }>;
      getGroupLimits(id: number): { minLinks: number; maxLinks: number };
    } }).getLacpAgent?.();
    for (const g of agregats?.getAllGroups() ?? []) {
      const l = agregats!.getGroupLimits(g.id);
      if (l.minLinks === 0 && l.maxLinks === 0) continue;
      lines.push(`interface ${g.name}`);
      if (l.minLinks > 0) lines.push(` port-channel min-links ${l.minLinks}`);
      if (l.maxLinks > 0) lines.push(` lacp max-bundle ${l.maxLinks}`);
      lines.push('!');
    }
    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      if (!cfg) continue;

      lines.push(`interface ${portName}`);
      const desc = descs.get(portName);
      if (desc) lines.push(` description ${desc}`);
      const dtpAdmin = dtpAgent?.getAdminMode(portName);
      if (cfg.mode === 'dot1q-tunnel') {
        lines.push(' switchport mode dot1q-tunnel');
      } else if (dtpAdmin === 'dynamic-auto') {
        lines.push(' switchport mode dynamic auto');
      } else if (dtpAdmin === 'dynamic-desirable') {
        lines.push(' switchport mode dynamic desirable');
      } else if (dtpAdmin === 'nonegotiate') {
        lines.push(' switchport nonegotiate');
      } else if (dtpAdmin === 'trunk') {
        lines.push(' switchport mode trunk');
      } else if (cfg.explicitMode) {
        lines.push(' switchport mode access');
      }
      if (cfg.mode === 'trunk') {
        if (cfg.trunkNativeVlan !== 1) {
          lines.push(` switchport trunk native vlan ${cfg.trunkNativeVlan}`);
        }
        if (cfg.trunkAllowedVlans.size < 4094) {
          if (cfg.trunkAllowedVlans.size === 0) {
            lines.push(` switchport trunk allowed vlan none`);
          } else {
            const sorted = Array.from(cfg.trunkAllowedVlans).sort((a, b) => a - b);
            lines.push(` switchport trunk allowed vlan ${this.compactVlanList(sorted)}`);
          }
        }
      } else if (cfg.accessVlan !== 1) {
        lines.push(` switchport access vlan ${cfg.accessVlan}`);
      }
      const voix = cfg.voiceVlan ?? cfg.voiceVlanMode;
      if (voix !== undefined) lines.push(` switchport voice vlan ${voix}`);
      if (sw.isPortProtected(portName)) lines.push(' switchport protected');
      lines.push(...runningConfigInterfaceACLFrom(
        sw.getVaclEngine().getInterfaceACLBindingsInternal(), portName));
      for (const l of this.qosRunningConfigLines(cfg)) lines.push(l);
      for (const l of this.ifExtra.get(portName) ?? []) lines.push(` ${l}`);
      for (const l of this.ifStp.get(portName) ?? []) lines.push(` ${l}`);
      if (dai.trustedPorts.has(portName)) {
        lines.push(' ip arp inspection trust');
      }
      const daiRate = dai.rateLimits.get(portName);
      if (daiRate && daiRate > 0) {
        lines.push(` ip arp inspection limit rate ${daiRate}`);
      }
      for (const l of this.renderPortSecurityLines(port)) lines.push(` ${l}`);
      if (cdpAgent) for (const l of cdpAgent.runningConfigInterfaceLines(portName)) lines.push(` ${l}`);
      if (lldpAgent) for (const l of lldpAgent.runningConfigInterfaceLines(portName)) lines.push(` ${l}`);
      if (lacpAgent) for (const l of lacpAgent.runningConfigInterfaceLines(portName)) lines.push(` ${l}`);
      for (const l of this.renderPortLayer2Lines(sw, portName, port)) lines.push(` ${l}`);
      if (!port.getIsUp()) {
        lines.push(` shutdown`);
      }
      lines.push('!');
    }

    const lacpRendu = (sw as unknown as { getLacpAgent?: () => {
      getAllGroups(): Array<{ id: number; name: string }>; getLoadBalance(): string;
    } }).getLacpAgent?.();
    if (lacpRendu) {
      const lb = lacpRendu.getLoadBalance();
      if (lb && lb !== DEFAULT_LOAD_BALANCE) lines.push(`port-channel load-balance ${lb}`);
      for (const g of lacpRendu.getAllGroups()) {
        lines.push(`interface ${g.name}`);
        for (const l of this.ifExtra.get(g.name) ?? []) lines.push(` ${l}`);
        lines.push('!');
      }
    }

    // SVI (interface Vlan N) blocks — IP address, helper-address, admin
    // state. Rendered after the physical interfaces so the running-config
    // mirrors how real IOS prints it.
    for (const o of this.trackObjects.list()) {
      const kind = o.kind === 'ip-routing' ? 'ip routing' : 'line-protocol';
      lines.push(`track ${o.id} interface ${o.target} ${kind}`);
    }
    if (this.trackObjects.list().length > 0) lines.push('!');

    for (const svi of sw.getSvis()) {
      lines.push(`interface Vlan${svi.vlan}`);
      if (svi.dhcpClient) {
        lines.push(' ip address dhcp');
      } else if (svi.ip && svi.mask) {
        lines.push(` ip address ${svi.ip} ${svi.mask}`);
      } else {
        lines.push(' no ip address');
      }
      for (const helper of svi.helperAddresses) {
        lines.push(` ip helper-address ${helper}`);
      }
      lines.push(...runningConfigInterfaceACLFrom(
        sw.getVaclEngine().getInterfaceACLBindingsInternal(), `Vlan${svi.vlan}`));
      lines.push(...getSecurityConfig(sw).asInterfaceRunningConfigLines(`Vlan${svi.vlan}`));
      for (const l of this.renderSviFhrpLines(sw, svi.vlan)) lines.push(l);
      if (!svi.adminUp) lines.push(' shutdown');
      lines.push('!');
    }

    /*
     * Les routes statiques passent par la QUEUE partagee avec le
     * routeur : ecrite ici a la main, elle perdait la DISTANCE, si bien
     * qu'une route de secours revenait principale au rechargement d'une
     * topologie. La distance par defaut d'IOS ne s'ecrit pas, seul
     * l'ecart en est une.
     */
    for (const r of sw.getL3RoutingTable()) {
      if (r.proto !== 'static' || !r.nextHop) continue;
      lines.push(`ip route ${r.network} ${r.mask} ${staticRouteTail({
        nextHop: r.nextHop, iface: r.iface,
        preference: r.preference === IOS_STATIC_DISTANCE ? undefined : r.preference,
      })}`);
    }

    for (const l of this.logging.asRunningConfigLines()) lines.push(l);

    // Sans ce bloc, un `archive` configuré sur le switch serait perdu à
    // l'import d'une topologie — la running-config est ce qui REFAIT la
    // configuration, pas seulement ce qui la décrit.
    const archive = (sw as unknown as {
      getArchiveService?: () => import('../router/archive/ArchiveService').ArchiveService;
    }).getArchiveService?.();
    if (archive) {
      const al = archive.asRunningConfigLines();
      if (al.length > 0) { lines.push('!'); lines.push(...al); }
    }

    // Le serveur web, rendu par le MEME magasin que sur le routeur. Un
    // Catalyst connait `ip http server`, et jusqu'ici la commande etait
    // acceptee puis perdue a l'enregistrement.
    const httpLines = sw.getHttpService().runningConfigLines();
    if (httpLines.length > 0) lines.push(...httpLines);

    const reglesPriv = privilegeConfigLines(
      getPrivilegeRules(sw),
    );
    if (reglesPriv.length > 0) lines.push(...reglesPriv);

    const unhandled = (sw as unknown as { getUnhandledConfigLines?: () => readonly string[] }).getUnhandledConfigLines?.() ?? [];
    if (unhandled.length > 0) {
      lines.push('!');
      lines.push(...unhandled);
    }

    // Le routeur ordonne ses blocs et compte ses octets ; le switch ne
    // faisait ni l'un ni l'autre, si bien que `service timestamps`
    // sortait APRES les interfaces — un ordre qu'IOS ne produit sur
    // aucune plateforme — et que l'en-tete annoncait une configuration
    // sans taille. C'est la MEME regle qui sert les deux, pas une
    // seconde : deux ordres possibles pour une meme configuration
    // seraient exactement le defaut qu'on referme ailleurs.
    const header = lines.slice(0, 4);
    const ordered = orderCiscoConfigBlocks(lines.slice(4));
    const assembled = [...header, ...ordered, 'end'];
    const body = assembled.slice(4).join('\n');
    assembled[2] = `Current configuration : ${new TextEncoder().encode(body).length + 1} bytes`;
    return assembled.join('\n');
  }

  private renderSviFhrpLines(sw: CiscoSwitch, vlan: number): string[] {
    return fhrpRunningConfigLines(fhrpViewOf(sw, `Vlanif${vlan}`));
  }

  // ─── Show Command Implementations ────────────────────────────────

  private showMACAddressTable(
    sw: CiscoSwitch,
    filter?: { vlan?: number; port?: string; address?: string; type?: 'static' | 'dynamic' },
  ): string {
    let entries = sw.getMACTable();
    if (filter?.type) entries = entries.filter(e => e.type === filter.type);
    if (filter?.vlan !== undefined) entries = entries.filter(e => e.vlan === filter.vlan);
    if (filter?.port) entries = entries.filter(e => e.port.toLowerCase().includes(filter.port!.toLowerCase()));
    if (filter?.address) {
      const a = filter.address.toLowerCase();
      entries = entries.filter(e => e.mac.toLowerCase() === a);
    }

    const head = ['Mac Address Table', '-------------------------------------------'];
    if (entries.length === 0) return [...head, 'No entries.'].join('\n');

    const lines = [
      ...head,
      '',
      'Vlan    Mac Address       Type        Ports',
      '----    -----------       --------    -----',
    ];
    const sorted = [...entries].sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
    for (const e of sorted) {
      const vlan = String(e.vlan).padEnd(8);
      const mac = e.mac.padEnd(18);
      const type = e.type === 'static' ? 'STATIC  ' : 'DYNAMIC ';
      lines.push(`${vlan}${mac}${type}    ${e.port}`);
    }
    lines.push('');
    lines.push(`Total Mac Addresses for this criterion: ${entries.length}`);
    return lines.join('\n');
  }

  private showVlanFull(sw: CiscoSwitch): string {
    const vlans = [...sw.getVLANs().keys()].sort((a, b) => a - b);
    const detail = [
      '',
      'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2',
      '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------',
    ];
    for (const v of vlans) {
      const said = String(100000 + v);
      detail.push(`${String(v).padEnd(5)}enet  ${said.padEnd(11)}1500  -      -      -        -    -        0      0`);
    }
    detail.push(
      '',
      'Remote SPAN VLANs',
      '------------------------------------------------------------------------------',
      '',
      '',
      'Primary Secondary Type              Ports',
      '------- --------- ----------------- ------------------------------------------',
    );
    return `${this.showVlanBrief(sw)}\n${detail.join('\n')}`;
  }

  private showMACAddressTableCount(sw: CiscoSwitch): string {
    const entries = sw.getMACTable();
    const vlanIds = [...sw.getVLANs().keys()].sort((a, b) => a - b);
    const lines = [
      'Mac Address Table',
      '-------------------------------------------',
      'Vlan    Mac Address Count',
      '------  -----------------',
    ];
    for (const v of vlanIds) {
      const n = entries.filter(e => e.vlan === v).length;
      lines.push(`${String(v).padEnd(6)}        ${n}`);
    }
    lines.push('', `Total Mac Addresses for this criterion: ${entries.length}`);
    return lines.join('\n');
  }

  private showMACAddressTableAgingTime(sw: CiscoSwitch): string {
    const aging = sw.getMACAgingTime();
    const vlanIds = [...sw.getVLANs().keys()].sort((a, b) => a - b);
    const lines = [
      'Mac Address Table',
      '-------------------------------------------',
      'Vlan    Aging Time',
      '----    ----------',
    ];
    for (const v of vlanIds) {
      lines.push(`${String(v).padEnd(8)}${aging}`);
    }
    return lines.join('\n');
  }

  private showMacAddressTableNotification(): string {
    return [
      'MAC address table notification is disabled',
      'Interval between Notification Traps : 1 secs',
      'Number of MAC Addresses Added       : 0',
      'Number of MAC Addresses Removed     : 0',
      'Number of Notifications sent to NMS : 0',
    ].join('\n');
  }

  private showVlanBrief(sw: CiscoSwitch, filter?: { id?: number; name?: string }): string {
    const vlans = sw.getVLANs();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
    ];

    let shown = 0;
    for (const [id, vlan] of vlans) {
      if (filter?.id !== undefined && id !== filter.id) continue;
      if (filter?.name !== undefined && vlan.name.toLowerCase() !== filter.name.toLowerCase()) continue;
      shown++;
      const name = vlan.name.padEnd(33);
      const status = 'active';

      const portsInVlan: string[] = [];
      for (const [portName, cfg] of configs) {
        if (cfg.mode === 'access' && cfg.accessVlan === id) {
          portsInVlan.push(this.abbreviateInterface(portName));
        }
      }

      const portsStr = portsInVlan.join(', ');
      lines.push(`${String(id).padEnd(5)}${name}${status.padEnd(10)}${portsStr}`);
    }

    if (filter && shown === 0) {
      return filter.id !== undefined
        ? `VLAN id ${filter.id} not found in current VLAN database`
        : `ERROR: VLAN ${filter.name} not found in current VLAN database`;
    }
    return lines.join('\n');
  }

  private showAllInterfacesDetail(): string {
    const sw = this.d();
    return sw.getPortNames().map((n) => showInterface(sw, n, true)).join('\n');
  }

  private showTrunkTable(portNames: string[]): string {
    const sw = this.d();
    // A switch that does not run DTP never negotiates, so its operational
    // mode IS the configured one — which is what makes `show interfaces
    // trunk` a real answer on an unmanaged switch rather than a refusal.
    const dtp = this.optionalDtp();
    const existing = [...sw.getVLANs().keys()].sort((a, b) => a - b);
    const trunks: Array<{ port: string; native: number; allowed: VlanSet }> = [];
    for (const p of portNames) {
      const c = sw.getSwitchportConfig(p);
      const isTrunk = dtp ? dtp.getOperationalMode(p) === 'trunk' : c?.mode === 'trunk';
      if (c && isTrunk) {
        trunks.push({ port: this.abbreviateInterface(p), native: c.trunkNativeVlan, allowed: c.trunkAllowedVlans });
      }
    }
    if (trunks.length === 0) return '';
    const lines = ['Port        Mode             Encapsulation  Status        Native vlan'];
    for (const t of trunks) {
      lines.push(`${t.port.padEnd(12)}${'on'.padEnd(17)}${'802.1q'.padEnd(15)}${'trunking'.padEnd(14)}${t.native}`);
    }
    const allowedStr = (a: VlanSet) =>
      a.size >= 4094 ? '1-4094' : this.compactVlanList([...a].sort((x, y) => x - y));
    const activeStr = (a: VlanSet) =>
      this.compactVlanList(existing.filter((v) => a.has(v))) || 'none';
    lines.push('', 'Port        Vlans allowed on trunk');
    for (const t of trunks) lines.push(`${t.port.padEnd(12)}${allowedStr(t.allowed)}`);
    lines.push('', 'Port        Vlans allowed and active in management domain');
    for (const t of trunks) lines.push(`${t.port.padEnd(12)}${activeStr(t.allowed)}`);
    lines.push('', 'Port        Vlans in spanning tree forwarding state and not pruned');
    for (const t of trunks) lines.push(`${t.port.padEnd(12)}${activeStr(t.allowed)}`);
    return lines.join('\n');
  }

  private showSwitchportDetail(name: string): string {
    const c = this.d().getSwitchportConfig(name);
    // Same reasoning as `showTrunkTable`: with no DTP there is nothing to
    // negotiate, so both modes come from the port's own configuration and
    // negotiation reads Off — which is the truth about an unmanaged port,
    // and keeps `show interfaces switchport` answering on one.
    const dtp = this.optionalDtp();
    const configured = c?.mode === 'trunk' ? 'trunk' : 'access';
    const admin = dtp ? dtp.getAdminMode(name) : configured;
    const oper = dtp ? dtp.getOperationalMode(name) : configured;
    const adminLabel =
      admin === 'trunk' || admin === 'nonegotiate' ? 'trunk'
      : admin === 'dynamic-auto' ? 'dynamic auto'
      : admin === 'dynamic-desirable' ? 'dynamic desirable'
      : 'static access';
    const operLabel = oper === 'trunk' ? 'trunk' : 'static access';
    // No DTP agent means nothing negotiates, whatever the mode says.
    const negotiation = !dtp || admin === 'access' || admin === 'nonegotiate' ? 'Off' : 'On';
    const nativeVlan = c?.trunkNativeVlan ?? 1;
    const lines = [
      `Name: ${this.abbreviateInterface(name)}`,
      `Switchport: Enabled`,
      `Administrative Mode: ${adminLabel}`,
      `Operational Mode: ${operLabel}`,
      `Administrative Trunking Encapsulation: dot1q`,
      `Negotiation of Trunking: ${negotiation}`,
      `Access Mode VLAN: ${c?.accessVlan ?? 1} (${this.d().getVLANs().get(c?.accessVlan ?? 1)?.name ?? 'default'})`,
      `Trunking Native Mode VLAN: ${nativeVlan}${nativeVlan === 1 ? ' (default)' : ''}`,
    ];
    if (oper === 'trunk') {
      const allowed = !c || c.trunkAllowedVlans.size >= 4094
        ? 'ALL' : this.compactVlanList(Array.from(c.trunkAllowedVlans).sort((a, b) => a - b));
      lines.push(`Trunking VLANs Enabled: ${allowed}`);
    }
    const voix = c?.voiceVlan ?? c?.voiceVlanMode;
    if (voix !== undefined) lines.push(`Voice VLAN: ${voix}`);
    lines.push(`Protected: ${this.d().isPortProtected(name)}`);
    return lines.join('\n');
  }

  private showQueuingInterface(name: string): string {
    const c = this.d().getSwitchportConfig(name);
    const trust = c?.trustMode ?? 'untrusted';
    const trustLabel = trust === 'cos' ? 'trust cos' : trust === 'dscp' ? 'trust dscp' : 'not trusted';
    const lines = [
      `Interface ${this.abbreviateInterface(name)} queueing strategy:  Class-based`,
      `  Trust state: ${trustLabel}`,
      `  Default COS is ${c?.defaultCos ?? 0}`,
    ];
    if (c?.priorityExtend?.mode === 'cos') {
      lines.push(`  Priority-extend: remark to COS ${c.priorityExtend.value}`);
    } else if (c?.priorityExtend?.mode === 'trust') {
      lines.push('  Priority-extend: trust');
    }
    return lines.join('\n');
  }

  private showInterfacesCounters(name: string | null): string {
    const sw = this.d();
    const rows: CounterRow[] = [];
    for (const [pn, port] of sw._getPortsInternal()) {
      if (name && pn !== name) continue;
      const c = port.getCounters();
      rows.push({
        port: this.abbreviateInterface(pn),
        inOctets: c.bytesIn,
        inUcast: c.framesIn - c.broadcastIn - c.multicastIn,
        inMcast: c.multicastIn,
        inBcast: c.broadcastIn,
        outOctets: c.bytesOut,
        outUcast: c.framesOut - c.broadcastOut - c.multicastOut,
        outMcast: c.multicastOut,
        outBcast: c.broadcastOut,
      });
    }
    if (name && rows.length === 0) return CISCO_ERRORS.INVALID_INPUT;
    return renderInterfaceCounters(rows);
  }

  private showInterfacesDescriptionTable(): string {
    const sw = this.d();
    return renderInterfacesDescription(
      sw._getPortsInternal(),
      (n) => sw.getInterfaceDescription(n) || '',
      (n) => this.abbreviateInterface(n),
    );
  }

  private showInterfacesStatus(sw: CiscoSwitch, only?: string): string {
    const configs = sw._getSwitchportConfigs();
    const entries = only
      ? ([[only, sw.getPort(only)]] as Array<[string, ReturnType<CiscoSwitch['getPort']>]>)
      : [...sw._getPortsInternal().entries()];

    // La mise en page mesurée sur de vraies machines : `Duplex` et
    // `Speed` à DROITE, ce que le tableau dessiné à la main ici mettait
    // à gauche, et sa dernière colonne un caractère trop loin.
    const rows: InterfaceStatusRow[] = [];
    for (const [portName, port] of entries) {
      if (!port) continue;
      const cfg = configs.get(portName);
      const connected = port.getIsUp() && port.hasCarrier();
      rows.push({
        port: this.abbreviateInterface(portName),
        name: (sw.getInterfaceDescription(portName) || '').slice(0, 17),
        status: port.getIsUp() ? (connected ? 'connected' : 'notconnect') : 'disabled',
        vlan: cfg?.mode === 'trunk' ? 'trunk' : String(cfg?.accessVlan || 1),
        // Read the port rather than guess from its name. The `a-`
        // prefix is IOS's way of saying the value was AUTO-NEGOTIATED,
        // so it is wrong the moment an operator forces speed or duplex —
        // and the hardcoded `a-full`/`a-100` denied the configuration
        // outright on a port set to `duplex half` / `speed 10`.
        duplex: port.isAutoNegotiation()
          ? (connected ? `a-${port.getNegotiatedDuplex()}` : 'auto')
          : port.getNegotiatedDuplex(),
        speed: port.isAutoNegotiation()
          ? (connected ? `a-${port.getNegotiatedSpeed()}` : 'auto')
          : String(port.getNegotiatedSpeed()),
        type: portName.startsWith('Gi') ? '1000BASE-T' : '10/100BaseTX',
      });
    }
    return renderTableText(rows, INTERFACE_STATUS_COLUMNS, INTERFACE_STATUS_STYLE);
  }

  private showSpanningTree(sw: CiscoSwitch, vlanId = 1): string {
    if (vlanId !== 1 && !sw.getVLANs().has(vlanId)) {
      return `Spanning tree instance(s) for vlan ${vlanId} do not exist.`;
    }
    const stpStates = sw._getSTPStates();
    const agent = (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
    const mode = agent?.getMode() ?? 'pvst';
    const mstp = mode === 'mstp';
    const protocole = mstp ? 'mstp' : mode === 'rstp' ? 'rstp' : 'ieee';
    const root = agent?.getRootBridgeForVlan(vlanId);
    const cost = agent?.getRootPathCostForVlan(vlanId) ?? 0;
    const rootPort = agent?.getRootPortForVlan(vlanId);
    const isRoot = agent?.isRootForVlan(vlanId) ?? true;
    const rootMacFmt = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const sysIdExt = mstp ? 0 : vlanId;
    const own = agent?.ownBridgeId(vlanId).priority ?? 32768 + sysIdExt;
    const rootPrio = isRoot ? own : (root?.priority ?? 32768 + sysIdExt);
    const hello = agent?.getVlanHelloSec(vlanId) ?? 2;
    const maxAge = agent?.maxAgeSec(vlanId) ?? 20;
    const forward = agent?.forwardDelaySec(vlanId) ?? 15;
    const minuteurs =
      `             Hello Time   ${hello} sec  Max Age ${maxAge} sec  Forward Delay ${forward} sec`;

    const portIndex = new Map<string, number>();
    let idx = 0;
    for (const name of sw.getPortNames()) { idx += 1; portIndex.set(name, idx); }

    const lines = [
      mstp ? 'MST0' : `VLAN${String(vlanId).padStart(4, '0')}`,
      `  Spanning tree enabled protocol ${protocole}`,
      `  Root ID    Priority    ${rootPrio}`,
      `             Address     ${rootMacFmt}`,
    ];
    if (rootPort) {
      lines.push(`             Cost        ${cost}`);
      lines.push(`             Port        ${portIndex.get(rootPort) ?? 1} (${rootPort})`);
    } else {
      lines.push(`             Cost        ${cost}`);
      lines.push('             This bridge is the root');
    }
    lines.push(minuteurs);
    lines.push('');
    lines.push(`  Bridge ID  Priority    ${own}  (priority ${own - sysIdExt} sys-id-ext ${sysIdExt})`);
    lines.push(`             Address     ${this.formatMacCisco(new MACAddress(agent?.ownBridgeId(vlanId).mac ?? '00:00:00:00:00:00'))}`);
    lines.push(minuteurs);
    lines.push('             Aging Time  300 sec');
    lines.push('');

    const ports = sw._getPortsInternal();
    const rows: SpanningTreePortRow[] = [];
    for (const [portName] of stpStates) {
      const port = ports.get(portName);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (!sw.getStpPortVlans(portName).includes(vlanId)) continue;
      const state = agent?.getForwardStateForVlan(vlanId, portName) ?? sw.getStpVlanState(portName, vlanId);
      const stpRole = agent?.getPortRoleForVlan(vlanId, portName) ?? 'designated';
      const role =
        stpRole === 'root' ? 'Root'
        : stpRole === 'alternate' ? 'Altn'
        : stpRole === 'backup' ? 'Back'
        : stpRole === 'disabled' ? 'Disa'
        : 'Desg';
      const sts = state === 'forwarding' ? 'FWD'
        : state === 'blocking' ? 'BLK'
        : state === 'listening' ? 'LIS'
        : state === 'learning' ? 'LRN'
        : 'DIS';
      const linkType = agent?.getPortLinkType(portName) === 'shared' ? 'Shr' : 'P2p';
      const edge = agent?.isPortFastOperational(portName) ? ' Edge' : '';
      rows.push({
        iface: this.abbreviateInterface(portName),
        role, state: sts,
        cost: String(agent?.getPortCost(portName) ?? 19),
        prioNbr: `128.${portIndex.get(portName) ?? 1}`,
        type: `${linkType}${edge}`,
      });
    }
    lines.push(renderTableText(rows, SPANNING_TREE_COLUMNS, SPANNING_TREE_STYLE));
    return lines.join('\n');
  }

  private stpAgentOf(sw: CiscoSwitch) {
    return (sw as unknown as { getStpAgent?: () => import('../../stp/StpAgent').StpAgent }).getStpAgent?.();
  }

  private stpSummaryCounts(sw: CiscoSwitch): string {
    let blk = 0, lis = 0, lrn = 0, fwd = 0;
    const ports = sw._getPortsInternal();
    for (const [name, state] of sw._getSTPStates()) {
      const port = ports.get(name);
      if (!port || !port.getIsUp() || !port.isConnected()) continue;
      if (state === 'blocking') blk++;
      else if (state === 'listening') lis++;
      else if (state === 'learning') lrn++;
      else if (state === 'forwarding') fwd++;
    }
    const active = blk + lis + lrn + fwd;
    return `${String(blk).padEnd(9)}${String(lis).padEnd(10)}${String(lrn).padEnd(9)}${String(fwd).padEnd(11)}${active}`;
  }

  private showStpRoot(sw: CiscoSwitch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const root = agent?.getRootBridgeForVlan(vlanId);
    const cost = agent?.getRootPathCostForVlan(vlanId) ?? 0;
    const rootPort = agent?.getRootPortForVlan(vlanId);
    const isRoot = agent?.isRootForVlan(vlanId) ?? true;
    const mac = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const prio = isRoot
      ? (agent?.ownBridgeId(vlanId).priority ?? 32768 + vlanId)
      : (root?.priority ?? 32768 + vlanId);
    const hello = agent?.getVlanHelloSec(vlanId) ?? 2;
    const maxAge = agent?.getVlanMaxAgeSec(vlanId) ?? 20;
    const fwd = agent?.getVlanForwardDelaySec(vlanId) ?? 15;
    const vlan = `VLAN${String(vlanId).padStart(4, '0')}`;
    return [
      '                                        Root    Hello Max Fwd',
      'Vlan             Root ID              Cost    Port    Time  Age Dly',
      '---------------- -------------------- ------- ------- ----- --- ---',
      `${vlan.padEnd(17)}${prio} ${mac}  ${String(cost).padEnd(8)}${(rootPort ? this.abbreviateInterface(rootPort) : '').padEnd(8)}${String(hello).padEnd(6)}${String(maxAge).padEnd(4)}${fwd}`,
    ].join('\n');
  }

  private showStpBridge(sw: CiscoSwitch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const own = agent?.ownBridgeId();
    const mac = own ? this.formatMacCisco(new MACAddress(own.mac)) : '0000.0000.0000';
    const prio = agent?.ownBridgeId(vlanId).priority ?? 32768 + vlanId;
    const hello = agent?.getVlanHelloSec(vlanId) ?? 2;
    const maxAge = agent?.getVlanMaxAgeSec(vlanId) ?? 20;
    const fwd = agent?.getVlanForwardDelaySec(vlanId) ?? 15;
    const vlan = `VLAN${String(vlanId).padStart(4, '0')}`;
    return [
      '                                                   Hello  Max  Fwd',
      'Vlan             Bridge ID                          Time  Age  Dly  Protocol',
      '---------------- ---------------------------------- -----  ---  ---  --------',
      `${vlan.padEnd(17)}${prio} (${prio - vlanId}, ${vlanId})  ${mac}  ${String(hello).padEnd(6)}${String(maxAge).padEnd(5)}${String(fwd).padEnd(5)}ieee`,
    ].join('\n');
  }

  private showStpBlockedPorts(sw: CiscoSwitch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const blocked: string[] = [];
    for (const [portName] of sw._getSTPStates()) {
      if (!sw.getStpPortVlans(portName).includes(vlanId)) continue;
      const role = agent?.getPortRoleForVlan(vlanId, portName);
      const state = agent?.getForwardStateForVlan(vlanId, portName) ?? sw.getStpVlanState(portName, vlanId);
      if (state === 'blocking' || role === 'alternate' || role === 'backup') {
        blocked.push(this.abbreviateInterface(portName));
      }
    }
    const vlan = `VLAN${String(vlanId).padStart(4, '0')}`;
    return [
      'Name                 Blocked Interfaces List',
      '-------------------- ------------------------------------',
      `${vlan.padEnd(21)}${blocked.join(', ')}`,
      '',
      `Number of blocked ports (segments) in the system : ${blocked.length}`,
    ].join('\n');
  }

  private showStpDetail(sw: CiscoSwitch, vlanId = 1): string {
    const agent = this.stpAgentOf(sw);
    const isRoot = agent?.isRootForVlan(vlanId) ?? true;
    const root = agent?.getRootBridgeForVlan(vlanId);
    const own = agent?.ownBridgeId(vlanId);
    const cost = agent?.getRootPathCostForVlan(vlanId) ?? 0;
    const rootPort = agent?.getRootPortForVlan(vlanId);
    const rootMac = root ? this.formatMacCisco(new MACAddress(root.mac)) : '0000.0000.0000';
    const ownMac = own ? this.formatMacCisco(new MACAddress(own.mac)) : '0000.0000.0000';
    const out: string[] = [
      ` VLAN${String(vlanId).padStart(4, '0')} is executing the ${this.stpMode} compatible Spanning Tree protocol`,
      `  Bridge Identifier has priority ${agent?.getVlanPriority(vlanId) ?? 32768}, sysid ${vlanId}, address ${ownMac}`,
      isRoot
        ? '  We are the root of the spanning tree'
        : `  Current root has priority ${root ? root.priority : 32768}, address ${rootMac}`,
      `  Root port is ${rootPort ? this.abbreviateInterface(rootPort) : 'N/A'}, cost of root path is ${cost}`,
      '  Hello Time 2 sec  Max Age 20 sec  Forward Delay 15 sec',
      '',
    ];
    for (const [portName] of sw._getSTPStates()) {
      if (!sw.getStpPortVlans(portName).includes(vlanId)) continue;
      const role = agent?.getPortRoleForVlan(vlanId, portName) ?? 'designated';
      const state = agent?.getForwardStateForVlan(vlanId, portName) ?? sw.getStpVlanState(portName, vlanId);
      const roleState = state === 'disabled' || role === 'disabled' ? 'disabled' : `${role} ${state}`;
      const portNum = agent?.portNumberFor(portName) ?? 0;
      const info = agent?.getPortInfoForVlan(vlanId, portName) ?? null;
      const desigRoot = info ? this.formatMacCisco(new MACAddress(info.designatedRoot.mac)) : ownMac;
      const desigBridge = info ? this.formatMacCisco(new MACAddress(info.designatedBridge.mac)) : ownMac;
      const desigRootPriority = info?.designatedRoot.priority ?? 32768;
      const desigBridgePriority = info?.designatedBridge.priority ?? 32768;
      const desigCost = info?.designatedCost ?? 0;
      const desigPortNum = info ? (info.designatedPort & 0xff) : portNum;
      const port = sw._getPortsInternal().get(portName);
      const linkType = port?.getNegotiatedDuplex() === 'full' ? 'point-to-point' : 'shared';
      out.push(
        ` Port ${portNum} (${portName}) of VLAN${String(vlanId).padStart(4, '0')} is ${roleState}`,
        `   Port path cost 19, Port priority 128, Port Identifier 128.${portNum}.`,
        `   Designated root has priority ${desigRootPriority}, address ${desigRoot}`,
        `   Designated bridge has priority ${desigBridgePriority}, address ${desigBridge}`,
        `   Designated port id is 128.${desigPortNum}, designated path cost ${desigCost}`,
        `   Timers: message age 0, forward delay 0, hold 0`,
        `   Number of transitions to forwarding state: ${agent?.getForwardingTransitionCount(portName) ?? 0}`,
        `   Link type is ${linkType} by default`,
        `   BPDU: sent ${agent?.getBpduSentCount(portName) ?? 0}, received ${agent?.getBpduReceivedCount(portName) ?? 0}`,
      );
    }
    return out.join('\n');
  }

  // ─── DHCP Snooping Display ───────────────────────────────────────

  private showIpDeviceTracking(sw: CiscoSwitch, args: string[]): string {
    const sub = (args[0] ?? 'all').toLowerCase();
    const dottedMac = (m: string) => {
      const hex = m.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      return hex.length === 12 ? `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}` : m;
    };
    let rows = sw._getSnoopingBindings();
    if (sub === 'interface' && args[1]) {
      const pn = this.resolveInterfaceName(args.slice(1).join(' '));
      if (!pn) return '% Invalid interface';
      rows = rows.filter((b) => b.port === pn);
    } else if (sub === 'ip' && args[1]) {
      rows = rows.filter((b) => b.ipAddress === args[1]);
    }
    const lines = [
      'Global IP Device Tracking for clients = Enabled',
      'Global IP Device Tracking Probe Count = 3',
      'Global IP Device Tracking Probe Interval = 30',
      'Global IP Device Tracking Probe Delay Interval = 0',
      '',
      '  IP Address       MAC Address       Vlan  Interface                STATE',
      `  ${'-'.repeat(70)}`,
    ];
    for (const b of rows) {
      lines.push(`  ${b.ipAddress.padEnd(17)}${dottedMac(b.macAddress).padEnd(18)}${String(b.vlan).padEnd(6)}${b.port.padEnd(25)}ACTIVE`);
    }
    lines.push(`  ${'-'.repeat(70)}`);
    lines.push(`  Total number interfaces enabled: ${new Set(rows.map((b) => b.port)).size}`);
    lines.push(`  Total number of entries: ${rows.length}`);
    return lines.join('\n');
  }

  protected loggingCommandContext(): LoggingCommandContext {
    const base = super.loggingCommandContext();
    return {
      ...base,
      beforeApply: () => {
        base.beforeApply?.();
        this.attachLoggingToBus(this.d().getBus(), this.d().id, this.d());
      },
      showSuffix: () => this.d()._getSnoopingLog().join('\n'),
    };
  }

  // ─── DAI Display ──────────────────────────────────────────────────

  private showArpInspection(sw: CiscoSwitch): string {
    const cfg = sw._getArpInspectionConfig();
    const lines: string[] = [];
    const vlans = Array.from(cfg.vlans).sort((a, b) => a - b);
    lines.push('Source Mac Validation      : ' + (cfg.validate.srcMac ? 'Enabled' : 'Disabled'));
    lines.push('Destination Mac Validation : ' + (cfg.validate.dstMac ? 'Enabled' : 'Disabled'));
    lines.push('IP Address Validation      : ' + (cfg.validate.ip ? 'Enabled' : 'Disabled'));
    lines.push('');
    lines.push(' Vlan     Configuration    Operation   ACL Match          Static ACL');
    lines.push(' ----     -------------    ---------   ---------          ----------');
    if (vlans.length === 0) {
      lines.push(' (no VLANs enabled for ARP inspection)');
    } else for (const v of vlans) {
      const filt = cfg.vlanAclFilters.get(v);
      const acl = filt ? filt.aclName : '';
      const stat = filt && filt.staticMode ? 'Yes' : 'No';
      lines.push(` ${String(v).padEnd(8)} Enabled          Active      ${acl.padEnd(18)} ${stat}`);
    }
    return lines.join('\n');
  }

  private showArpInspectionVlan(sw: CiscoSwitch, spec: string): string {
    const wanted = new Set<number>();
    for (const part of spec.split(',')) {
      const m = part.match(/^(\d+)-(\d+)$/);
      if (m) for (let i = +m[1]; i <= +m[2]; i++) wanted.add(i);
      else { const n = parseInt(part, 10); if (!isNaN(n)) wanted.add(n); }
    }
    const cfg = sw._getArpInspectionConfig();
    const lines: string[] = [' Vlan     Configuration    Operation   ACL Match          Static ACL',
                            ' ----     -------------    ---------   ---------          ----------'];
    for (const v of [...wanted].sort((a, b) => a - b)) {
      const enabled = cfg.vlans.has(v);
      const filt = cfg.vlanAclFilters.get(v);
      const acl = filt ? filt.aclName : '';
      const stat = filt && filt.staticMode ? 'Yes' : 'No';
      lines.push(` ${String(v).padEnd(8)} ${(enabled ? 'Enabled' : 'Disabled').padEnd(16)} ` +
                 `${(enabled ? 'Active' : 'Inactive').padEnd(11)} ${acl.padEnd(18)} ${stat}`);
    }
    return lines.join('\n');
  }

  private showArpInspectionStats(sw: CiscoSwitch): string {
    const stats = sw._getArpInspectionStats();
    const lines = [
      ' Vlan  Forwarded     Dropped       DHCP-Drops    ACL-Drops',
      ' ----  ---------     -------       ----------    ---------',
    ];
    const ports = sw._getPortsInternal();
    let fwd = 0, drop = 0, bind = 0, acl = 0;
    for (const [port] of ports) {
      const s = stats.get(port);
      if (!s) continue;
      fwd += s.forwarded; drop += s.dropped;
      bind += s.droppedBindingMismatch; acl += s.droppedAclDeny;
    }
    lines.push(` ${'(all)'.padEnd(5)} ${String(fwd).padEnd(13)} ${String(drop).padEnd(13)} ` +
               `${String(bind).padEnd(13)} ${acl}`);
    lines.push('');
    lines.push(' Interface          Packets Received  Permitted  Dropped');
    lines.push(' ----------------   ----------------  ---------  -------');
    for (const [port] of ports) {
      const s = stats.get(port);
      if (!s || s.received === 0) continue;
      lines.push(` ${this.abbreviateInterface(port).padEnd(18)} ` +
                 `${String(s.received).padEnd(17)} ${String(s.forwarded).padEnd(10)} ${s.dropped}`);
    }
    return lines.join('\n');
  }

  private static readonly DAI_LOG_REASON_LABEL: Record<string, string> = {
    'binding-mismatch': 'DHCP Deny',
    'acl-deny': 'ACL Deny',
    'src-mac-mismatch': 'DHCP Deny',
    'dst-mac-mismatch': 'DHCP Deny',
    'invalid-ip': 'DHCP Deny',
    'rate-limit': 'Rate Limit',
    'port-err-disabled': 'Err-disabled',
  };

  private showArpInspectionLog(sw: CiscoSwitch): string {
    const entries = sw._getArpInspectionLog();
    const lines = [
      'Total Log Buffer Size : 32',
      'Syslog rate : 5 entries per 200 seconds.',
      '',
      'Interface        Vlan    Sender MAC          Sender IP        Num Pkts   Reason         Time',
      '------------------------------------------------------------------------------------------------',
    ];
    for (const e of entries) {
      const reason = CiscoSwitchShell.DAI_LOG_REASON_LABEL[e.reason] ?? e.reason;
      const time = new Date(e.lastSeenMs).toISOString().slice(11, 19);
      lines.push(
        `${this.abbreviateInterface(e.port).padEnd(17)}${String(e.vlan).padEnd(8)}` +
        `${e.senderMac.padEnd(20)}${e.senderIp.padEnd(17)}${String(e.numPkts).padEnd(11)}` +
        `${reason.padEnd(15)}${time} UTC`,
      );
    }
    return lines.join('\n');
  }

  private showArpInspectionIfs(sw: CiscoSwitch): string {
    const cfg = sw._getArpInspectionConfig();
    const errd = sw._getArpErrDisabledPorts();
    const lines = [
      ' Interface          Trust State     Rate (pps)    Burst Interval     ErrDisable',
      ' ----------------   -------------   ----------    --------------     ----------',
    ];
    for (const port of sw.getPortNames()) {
      const trust = cfg.trustedPorts.has(port) ? 'Trusted' : 'Untrusted';
      const rate = cfg.rateLimits.get(port);
      const rateStr = rate && rate > 0 ? String(rate) : 'None';
      const burst = String(cfg.rateBurstSec);
      const err = errd.has(port) ? 'Yes' : 'No';
      lines.push(` ${this.abbreviateInterface(port).padEnd(18)} ${trust.padEnd(15)} ` +
                 `${rateStr.padEnd(13)} ${burst.padEnd(18)} ${err}`);
    }
    return lines.join('\n');
  }

  private showArpAcls(sw: CiscoSwitch): string {
    const map = sw._getArpAccessLists();
    if (map.size === 0) return '';
    const lines: string[] = [];
    for (const [name, acl] of map) {
      lines.push(`ARP access list ${name}`);
      for (const e of acl.entries) lines.push(`    ${e.raw}`);
    }
    return lines.join('\n');
  }

  private showErrdisableRecovery(): string {
    const dai = this.d()._getArpInspectionConfig();
    const arpRec = dai.errDisableRecoverySec > 0;
    const psecRec = this.d()._getPsecRecoverySec() > 0;
    const interval = arpRec ? dai.errDisableRecoverySec
      : psecRec ? this.d()._getPsecRecoverySec() : 300;
    const causes: [string, boolean][] = [
      ['arp-inspection', arpRec],
      ['psecure-violation', psecRec],
      ['bpduguard', false],
      ['loopback', false],
      ['link-flap', false],
    ];
    const lines = [
      'ErrDisable Reason            Timer Status',
      '-----------------            --------------',
    ];
    for (const [cause, on] of causes) {
      lines.push(`${cause.padEnd(29)}${on ? 'Enabled' : 'Disabled'}`);
    }
    lines.push('');
    lines.push(`Timer interval: ${interval} seconds`);
    return lines.join('\n');
  }

  // ─── Interface Resolution ─────────────────────────────────────────

  /**
   * Virtual (non-physical) L2 interfaces this switch accepts:
   * Port-channel only. `Vlan<n>` is an L3 SVI and stays rejected on an
   * L2-only switch (returns null → "% Invalid interface name").
   */
  private virtualInterfaceName(input: string): string | null {
    const compact = input.replace(/\s+/g, '');
    const po = compact.match(/^(?:po|port-?channel)(\d+)$/i);
    if (po) return `Port-channel${po[1]}`;
    // SVI: `interface Vlan N` (the switch's L3 management interface).
    const vl = compact.match(/^(?:vl|vlan)(\d+)$/i);
    if (vl) return `Vlan${vl[1]}`;
    return null;
  }

  /** Extract the VLAN id from an SVI interface name ("Vlan10" → 10). */
  private sviVlanId(iface: string): number | null {
    const m = /^vlan(\d+)$/i.exec(iface);
    return m ? parseInt(m[1], 10) : null;
  }

  private liaisonsAcl(iface: string): InterfaceAclRefs {
    const engine = this.d().getVaclEngine();
    return {
      inbound: engine.getInterfaceACL(iface, 'in'),
      outbound: engine.getInterfaceACL(iface, 'out'),
    };
  }

  /**
   * `ip access-group <liste> in|out` sur le port sélectionné.
   *
   * Une liste inconnue est REFUSÉE dans les mots d'IOS plutôt que liée :
   * une PACL qui ne désigne rien ne filtre rien, et l'accepter donnerait
   * un port qu'on croit protégé.
   *
   * Sur une SVI la même commande pose une RACL — c'est ainsi qu'un
   * Catalyst filtre entre VLAN — et le magasin est le même, indexé par
   * nom d'interface. Elle y était refusée alors que `show ip interface
   * Vlan<n>` lisait déjà ce magasin : la vue savait rendre une liaison
   * qu'aucune commande ne pouvait poser.
   */
  private appliquerPacl(args: string[], retirer: boolean): string {
    const iface = this.selectedInterface;
    if (!iface) return CISCO_ERRORS.INCOMPLETE;
    if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
    const sens = args[1].toLowerCase();
    if (sens !== 'in' && sens !== 'out') return CISCO_ERRORS.INVALID_INPUT;
    const direction: 'in' | 'out' = sens;
    if (retirer) {
      this.d().getVaclEngine().removeInterfaceACL(iface, direction);
      return '';
    }
    const ref: number | string = /^\d+$/.test(args[0]) ? parseInt(args[0], 10) : args[0];
    const engine = this.d().getVaclEngine();
    if (!engine.findRef(ref)) return `% Access list ${args[0]} not found`;
    engine.setInterfaceACL(iface, direction, ref);
    return '';
  }

  /**
   * `show vlan access-map` — la forme du Catalyst 3560/3750, plateforme
   * que ce shell modélise : le numéro de séquence sur la ligne d'en-tête,
   * puis les clauses et l'action. `ip  address:` porte deux blancs, la
   * colonne laissée à `mac`.
   */
  private showVlanAccessMap(nom?: string): string {
    const noms = this.d().getVlanAccessMapNames()
      .filter(n => !nom || n === nom);
    if (noms.length === 0) return '';
    const lines: string[] = [];
    for (const carte of noms) {
      for (const regle of this.d().getVlanAccessMap(carte) ?? []) {
        lines.push(`Vlan access-map "${carte}"  ${regle.sequence}`);
        lines.push('  Match clauses:');
        if (regle.matchIpAcl) lines.push(`    ip  address: ${regle.matchIpAcl}`);
        lines.push('  Action:');
        lines.push(`    ${regle.action}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * `show vlan filter` — quels VLAN chaque carte filtre.
   *
   * « Configuré » et « actif » sont deux faits distincts et mesurés
   * séparément : un VLAN peut être nommé par la liaison sans exister sur
   * ce commutateur, et la carte n'y filtre alors rien.
   */
  private showVlanFilter(nom?: string): string {
    const liaisons = this.d().getVlanFilterBindings();
    const lines: string[] = [];
    for (const [carte, vlans] of liaisons) {
      if (nom && carte !== nom) continue;
      const actifs = vlans.filter(v => this.d().getVLANs().has(v));
      lines.push(`VLAN Map ${carte}:`);
      lines.push(`   Configured on VLANs: ${this.compactVlanList(vlans)}`);
      lines.push(`   Active on VLANs: ${this.compactVlanList(actifs)}`);
    }
    return lines.join('\n');
  }

  /**
   * Wire the IOS Layer-3 surface: `ip routing`, `ip route`, the
   * `ip dhcp pool` sub-mode (reusing the shared DHCP pool builder),
   * `ip dhcp excluded-address`, and the matching show / clear views.
   * Every command targets the Switch's own DHCPServer / SVI routing
   * table — the same machinery that lights up inter-VLAN routing.
   */
  private registerL3Commands(): void {
    const cfg = this.configTrie;

    cfg.register('ip routing', 'Enable Layer-3 routing', () => { this.d().setIpRoutingEnabled(true); return ''; });
    cfg.register('no ip routing', 'Disable Layer-3 routing', () => { this.d().setIpRoutingEnabled(false); return ''; });

    // ip route <net> <mask> <next-hop>


    // Pool sub-mode trie: reuse the shared Cisco builder. Only the
    // handful of accessors the pool commands actually call need to be
    // populated; the rest of CiscoShellContext is irrelevant on a
    // switch (no IPSec / routing-proto state here).
    buildConfigDhcpCommands(this.configDhcpTrie, this.dhcpPoolContext());

    // ── AAA / TACACS+ / RADIUS / protection force brute ──
    // Un Catalyst 2960 connait toute cette famille ; elle vivait dans le
    // module de securite du ROUTEUR, qui enregistre aussi des commandes
    // qu'un commutateur n'a pas (`zone security`, `class-map type
    // inspect`). Extraite, elle sert les deux sans leur donner le reste.
    const identityCtx = this.identitySubmodeContext();
    buildIdentityConfigCommands(this.configTrie, identityCtx);
    buildIdentitySubmodeCommands(
      this.configRadiusServerTrie, this.configTacacsServerTrie,
      this.configAaaGroupTrie, identityCtx,
    );

    // IOS ne nomme pas ses arguments, il les TYPE. Cette table etait
    // posee sur le seul shell du routeur, si bien qu'un Catalyst
    // repondait `WORD  Set a banner` la ou IOS liste `motd`, `login`,
    // `exec`, `incoming` — la commande marchait et ne se laissait pas
    // decouvrir. Les tries qu'un commutateur n'a pas (processus de
    // routage, route-map, time-range, track) recoivent des arbres
    // jetables : decrire un argument sur un arbre que rien ne consulte
    // ne coute rien et evite d'avoir DEUX tables a tenir.
    const inutilise = () => new CommandTrie();
    // Les suites d'un noeud glouton sont DECLAREES, plus derivees du
    // texte source de son gestionnaire. Les arbres sont releves sur
    // l'objet lui-meme : les nommer a la main en aurait oublie, et un
    // arbre oublie est un mode entier prive de ses suites.
    appliquerContinuations(this.tousLesArbres(), SOCLE, COMMUTATEUR_SEUL);
    describeCiscoArguments({
      config: this.configTrie,
      configIf: this.configIfTrie,
      configLine: this.configLineTrie,
      configDhcp: this.configDhcpTrie,
      privileged: this.privilegedTrie,
      configStdNacl: this.configAclTrie,
      configExtNacl: this.configAclTrie,
      configRouter: inutilise(),
      configRouterOspf: inutilise(),
      configRouteMap: inutilise(),
      configTrack: inutilise(),
      configRouterOnly: inutilise(),
    });

    // ── Show commands ──────────────────────────────────────────────
    for (const t of [this.userTrie, this.privilegedTrie]) {
      t.register('show ip traffic', 'IP traffic statistics', () =>
        showIpTraffic(this.d()._getPortsInternal().values(), this.d()._getArpStats()));
      t.registerGreedy('show adjacency', 'Display CEF adjacency table', (args) =>
        this.showAdjacency(args));
      const dhcp = () => this.d()._getDHCPServerInternal();
      t.register('show ip dhcp statistics', 'Display DHCP server statistics', () =>
        dhcp().formatStatsShow());
      t.register('show ip dhcp lease', 'Display DHCP client leases', () =>
        this.showIpDhcpLease());
      t.register('show ip dhcp database', 'Display DHCP database agents', () =>
        dhcp().formatDatabaseShow());
      t.register('show ip dhcp snooping statistics', 'Display DHCP snooping statistics', () =>
        this.showIpDhcpSnoopingStatistics());
      t.registerGreedy('show track', 'Display tracked objects', (args) => {
        const objs = this.trackObjects.list();
        if (objs.length === 0) return '';
        const filterId = parseInt(args[0] ?? '', 10);
        const filtered = Number.isFinite(filterId) ? objs.filter((o) => o.id === filterId) : objs;
        const lines: string[] = [];
        for (const o of filtered) {
          const state = this.trackObjects.stateOf(this.d(), o.id);
          const kindStr = o.kind === 'ip-routing' ? 'ip routing' : 'line-protocol';
          lines.push(`Track ${o.id}`);
          lines.push(`  Interface ${o.target} ${kindStr}`);
          lines.push(`  ${kindStr} is ${state}`);
        }
        return lines.join('\n');
      });
      t.registerGreedy('show vrrp', 'Display VRRP groups on SVIs', (args) => {
        const groups = this.d().getVrrpAgent().listGroups();
        const sel = this.fhrpSelection(args, VRRP_SHOW_GRAMMAR, groups);
        const kept = groups.filter((g) => fhrpShowMatches(iosSviName(g.iface), g.vrid, sel));
        return sel.brief ? this.showVrrpBrief(kept) : this.showVrrp(kept);
      });
      t.registerGreedy('show standby', 'Display HSRP groups on SVIs', (args) => {
        const groups = this.d().getHsrpAgent().listGroups();
        const sel = this.fhrpSelection(args, HSRP_SHOW_GRAMMAR, groups);
        const kept = groups.filter((g) => fhrpShowMatches(iosSviName(g.iface), g.group, sel));
        return sel.brief ? this.showStandbyBrief(kept) : this.showStandby(kept);
      });
      t.registerGreedy('show glbp', 'Display GLBP groups on SVIs', (args) => {
        const groups = this.d().getGlbpAgent().listGroups();
        const sel = this.fhrpSelection(args, GLBP_SHOW_GRAMMAR, groups);
        const kept = groups.filter((g) => fhrpShowMatches(iosSviName(g.iface), g.group, sel));
        return sel.brief ? this.showGlbpBrief(kept) : this.showGlbp(kept);
      });
    }
  }

  private fhrpSelection(
    args: readonly string[], grammar: FhrpShowGrammar,
    groups: ReadonlyArray<{ iface: string }>,
  ): FhrpShowSelection {
    const verdict = parseFhrpShowArgs(args, grammar,
      fhrpInterfaceResolver(groups.map((g) => iosSviName(g.iface))));
    if ('at' in verdict) throw new CliInvalidInput({ token: verdict.at });
    return verdict;
  }

  private showVrrp(groups: readonly VrrpGroupRuntime[]): string {
    if (groups.length === 0) return '';
    const lines: string[] = [];
    for (const g of groups) {
      const iface = iosSviName(g.iface);
      const stateStr = g.state === 'master' ? 'Master' : g.state === 'backup' ? 'Backup' : 'Init';
      const effPrio = vrrpEffectivePriority(g);
      lines.push(`${iface} - Group ${g.vrid}`);
      lines.push(`  State is ${stateStr}`);
      lines.push(`  Virtual IP address is ${g.vip ?? 'unassigned'}`);
      lines.push(`  Virtual MAC address is ${vrrpVirtualMac(g.vrid)}`);
      if (effPrio === g.priority) {
        lines.push(`  Priority is ${g.priority}`);
      } else {
        lines.push(`  Priority is ${effPrio} (configured ${g.priority})`);
      }
      lines.push(`  Preemption is ${g.preempt ? 'enabled' : 'disabled'}`);
      if (g.tracks.length > 0) {
        lines.push(`  Tracking ${g.tracks.length} object(s):`);
        for (const t of g.tracks) {
          const tName = iosSviName(t.target);
          lines.push(`    ${tName} ${t.down ? 'Down' : 'Up'} decrement ${t.decrement}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n').replace(/\n$/, '');
  }

  private showGlbp(groups: readonly GlbpGroupRuntime[]): string {
    if (groups.length === 0) return '';
    const lines: string[] = [];
    for (const g of groups) {
      const iface = iosSviName(g.iface);
      const stateStr =
        g.avgState === 'active' ? 'Active'
        : g.avgState === 'standby' ? 'Standby'
        : g.avgState === 'init' ? 'Init'
        : 'Disabled';
      const effWeight = glbpEffectiveWeighting(g);
      lines.push(`${iface} - Group ${g.group}`);
      lines.push(`  State is ${stateStr}`);
      lines.push(`  Virtual IP address is ${g.vip ?? 'unassigned'}`);
      lines.push(`  Priority ${g.priority}`);
      if (effWeight === g.weighting) {
        lines.push(`  Weighting ${g.weighting}`);
      } else {
        lines.push(`  Weighting ${effWeight} (configured ${g.weighting})`);
      }
      lines.push(`  Load-balancing ${g.loadBalancing}`);
      lines.push(`  Preemption ${g.preempt ? 'enabled' : 'disabled'}`);
      if (g.tracks.length > 0) {
        lines.push(`  Tracking ${g.tracks.length} object(s):`);
        for (const t of g.tracks) {
          const tName = iosSviName(t.target);
          lines.push(`    ${tName} ${t.down ? 'Down' : 'Up'} decrement ${t.decrement}`);
        }
      }
      const fwds = [...g.forwarders.values()];
      if (fwds.length > 0) {
        lines.push(`  ${fwds.length} forwarder(s):`);
        for (const f of fwds) {
          lines.push(`    Forwarder ${f.forwarderNumber} vmac ${f.vmac} state ${f.state}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n').replace(/\n$/, '');
  }

  private showStandby(groups: readonly HsrpGroupRuntime[]): string {
    if (groups.length === 0) return '';
    const lines: string[] = [];
    for (const g of groups) {
      const iface = iosSviName(g.iface);
      const stateStr =
        g.state === 'active' ? 'Active'
        : g.state === 'standby' ? 'Standby'
        : g.state === 'listen' ? 'Listen'
        : g.state === 'speak' ? 'Speak'
        : g.state === 'learn' ? 'Learn'
        : 'Init';
      const effPrio = hsrpEffectivePriority(g);
      lines.push(`${iface} - Group ${g.group}`);
      lines.push(`  State is ${stateStr}`);
      lines.push(`  Virtual IP address is ${g.vip ?? 'unassigned'}`);
      lines.push(`  Virtual MAC address is ${hsrpVirtualMac(g.group, g.version)} (v${g.version} default)`);
      if (effPrio === g.priority) {
        lines.push(`  Priority ${g.priority}`);
      } else {
        lines.push(`  Priority ${effPrio} (configured ${g.priority})`);
      }
      lines.push(`  Preemption ${g.preempt ? 'enabled' : 'disabled'}`);
      if (g.tracks.length > 0) {
        lines.push(`  Tracking ${g.tracks.length} object(s):`);
        for (const t of g.tracks) {
          const tName = iosSviName(t.target);
          lines.push(`    ${tName} ${t.down ? 'Down' : 'Up'} decrement ${t.decrement}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n').replace(/\n$/, '');
  }

  private showVrrpBrief(groups: readonly VrrpGroupRuntime[]): string {
    const header = 'Interface          Grp Pri Time    Own Pre State    Master addr     Group addr';
    const rows = groups.map((g) => {
      const iface = iosSviName(g.iface);
      const state = g.state === 'master' ? 'Master' : g.state === 'backup' ? 'Backup' : 'Init';
      return `${iface.padEnd(19)}${String(g.vrid).padEnd(4)}${String(vrrpEffectivePriority(g)).padEnd(4)}` +
        `${String(3 * g.advertiseSec * 1000).padEnd(8)}${'N'.padEnd(4)}${(g.preempt ? 'Y' : 'N').padEnd(4)}` +
        `${state.padEnd(9)}${(g.masterIp ?? 'unknown').padEnd(16)}${g.vip ?? 'unassigned'}`;
    });
    return [header, ...rows].join('\n');
  }

  private showStandbyBrief(groups: readonly HsrpGroupRuntime[]): string {
    const header = '                     P indicates configured to preempt.\n' +
      '                     |\nInterface   Grp  Pri P State    Active          Standby         Virtual IP';
    const rows = groups.map((g) => {
      const iface = iosSviName(g.iface);
      const state =
        g.state === 'active' ? 'Active'
        : g.state === 'standby' ? 'Standby'
        : g.state === 'speak' ? 'Speak'
        : g.state === 'listen' ? 'Listen'
        : g.state === 'learn' ? 'Learn'
        : 'Init';
      return `${iface.padEnd(12)}${String(g.group).padEnd(5)}${String(hsrpEffectivePriority(g)).padEnd(4)}` +
        `${(g.preempt ? 'P' : ' ').padEnd(2)}${state.padEnd(9)}` +
        `${(g.activeRouterIp ?? 'unknown').padEnd(16)}${(g.standbyRouterIp ?? 'unknown').padEnd(16)}${g.vip ?? 'unassigned'}`;
    });
    return [header, ...rows].join('\n');
  }

  private showGlbpBrief(groups: readonly GlbpGroupRuntime[]): string {
    const header = 'Interface   Grp  Fwd Pri State    Address         Active router   Standby router';
    const rows: string[] = [];
    for (const g of groups) {
      const iface = iosSviName(g.iface);
      const avgState =
        g.avgState === 'active' ? 'Active'
        : g.avgState === 'standby' ? 'Standby'
        : g.avgState === 'init' ? 'Init'
        : 'Disabled';
      rows.push(`${iface.padEnd(12)}${String(g.group).padEnd(5)}${'-'.padEnd(4)}` +
        `${String(g.priority).padEnd(4)}${avgState.padEnd(9)}` +
        `${(g.vip ?? 'unassigned').padEnd(16)}${(g.avgIp ?? 'local').padEnd(16)}unknown`);
      for (const f of g.forwarders.values()) {
        rows.push(`${iface.padEnd(12)}${String(g.group).padEnd(5)}${String(f.forwarderNumber).padEnd(4)}` +
          `${String(f.priority).padEnd(4)}${f.state.padEnd(9)}${f.vmac.padEnd(16)}${(f.ownerIp ?? 'local').padEnd(16)}unknown`);
      }
    }
    return [header, ...rows].join('\n');
  }

  /**
   * IOS `show ip interface Vlan<N>` — the verbose per-SVI L3 view used
   * for sanity checks: IP/mask, MTU, MAC, broadcast, line/protocol
   * state, and the configured `ip helper-address` list. Falls back to a
   * "% Invalid interface" for non-SVI names since L2 ports carry no IP.
   */
  private showIpInterfaceAll(): string {
    const ports = this.d()._getPortsInternal();
    const blocs: string[] = [];
    for (const [nom, port] of ports) {
      blocs.push(ipInterfaceBlockFor(nom, port, ports, '', true, {}, this.liaisonsAcl(nom)));
    }
    for (const svi of this.d().getSvis()) blocs.push(this.sviInterfaceBlock(svi.vlan));
    return blocs.length ? blocs.join('\n') : 'No interfaces present.';
  }

  private showIpInterfaceVerbose(iface: string): string {
    const vlanIfMatch = iface.match(/^(?:vl|vlan)\s*(\d+)$/i);
    if (!vlanIfMatch) {
      const ports = this.d()._getPortsInternal();
      const nom = this.resolveInterfaceName(iface);
      const port = nom ? ports.get(nom) : undefined;
      if (!port || !nom) return CISCO_ERRORS.INVALID_INPUT;
      return ipInterfaceBlockFor(nom, port, ports, '', true, {}, this.liaisonsAcl(nom));
    }
    return this.sviInterfaceBlock(parseInt(vlanIfMatch[1], 10));
  }

  private sviInterfaceBlock(vlan: number): string {
    const svi = this.d().getSvi(vlan);
    if (!svi) return '% Invalid interface';

    const adminUp = svi.adminUp;
    const lineUp = adminUp && this.d().isSviLineUp(svi);
    const stateLine = `Vlan${vlan} is ${adminUp ? (lineUp ? 'up' : 'down') : 'administratively down'}, ` +
      `line protocol is ${lineUp ? 'up' : 'down'}`;
    const lines = [stateLine];
    if (svi.ip && svi.mask) {
      lines.push(`  Internet address is ${svi.ip}/${svi.mask.toCIDR()}`);
      /*
       * L'adresse de DIFFUSION que rend `show ip interface` est celle
       * qui est CONFIGUREE, `255.255.255.255` tant que personne n'a tape
       * `ip broadcast-address` — c'est ce que rend le routeur, et ce que
       * montrent les captures. Le commutateur la DEDUISAIT du
       * sous-reseau par un decoupage de chaine (`.0` remplace par
       * `.255`), donc il repondait autre chose que le routeur a la meme
       * question, et faux des qu'un masque n'est pas un /24 :
       * `10.0.0.1/16` y devenait `10.0.0.255` au lieu de `10.0.255.255`.
       */
      lines.push('  Broadcast address is 255.255.255.255');
    } else {
      lines.push('  Internet protocol processing disabled');
    }
    lines.push('  MTU is 1500 bytes');
    lines.push(`  Hardware is EtherSVI, address is ${this.d().getBridgeMac().toCiscoString()}`);
    lines.push(...helperAddressLines(svi.helperAddresses));
    const f = getSecurityConfig(this.d()).ifaceFlags(`Vlan${vlan}`);
    lines.push(...ipInterfaceControlLines({
      proxyArp: !f.noProxyArp,
      noRedirects: f.noRedirects,
      noUnreachables: f.noUnreachables,
      maskReply: f.maskReply,
    }, this.liaisonsAcl(`Vlan${vlan}`)));
    return lines.join('\n');
  }

  private formatVtpTimestamp(epochMs: number): string {
    const d = new Date(epochMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${d.getDate()}-${pad(d.getFullYear() % 100)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  private showSviInterface(vlan: number): string {
    const svi = this.d().getSvi(vlan);
    if (!svi) return '% Invalid interface';
    const adminUp = svi.adminUp;
    const lineUp = adminUp && this.d().isSviLineUp(svi);
    const mac = this.d().getBridgeMac().toCiscoString();
    const lines = [
      `Vlan${vlan} is ${adminUp ? (lineUp ? 'up' : 'down') : 'administratively down'}, ` +
        `line protocol is ${lineUp ? 'up' : 'down'}`,
      `  Hardware is EtherSVI, address is ${mac} (bia ${mac})`,
    ];
    if (svi.ip && svi.mask) {
      lines.push(`  Internet address is ${svi.ip}/${svi.mask.toCIDR()}`);
    }
    lines.push('  MTU 1500 bytes, BW 1000000 Kbit/sec, DLY 10 usec,');
    lines.push('     reliability 255/255, txload 1/255, rxload 1/255');
    lines.push('  Encapsulation ARPA, loopback not set');
    lines.push('  ARP type: ARPA, ARP Timeout 04:00:00');
    return lines.join('\n');
  }

  private showAdjacency(args: string[]): string {
    const sub = args[0]?.toLowerCase();
    const entries = Array.from(this.d()._getArpTableInternal().entries())
      .filter(([, e]) => e.type !== 'failed');

    if (sub === 'summary') {
      const byIface = new Map<string, number>();
      for (const [, e] of entries) byIface.set(e.iface, (byIface.get(e.iface) ?? 0) + 1);
      const lines = ['IP Adj Summary:', `  Total number of adjacencies: ${entries.length}`];
      for (const [iface, count] of byIface) lines.push(`  ${iface}: ${count}`);
      return lines.join('\n');
    }

    if (sub === 'detail') {
      if (entries.length === 0) return '';
      const lines: string[] = [];
      for (const [ip, e] of entries) {
        lines.push(`IP  ${e.iface}  ${ip}(${Math.floor((Date.now() - e.timestamp) / 60000)})`);
        lines.push(`  ${e.mac.toCiscoString()}`);
        lines.push('  ARPA');
        lines.push('  Epoch: 0');
      }
      return lines.join('\n');
    }

    if (entries.length === 0) return '';
    const lines = ['Protocol  Interface        Address              Age(min)  Hardware Addr    Encap  Out'];
    for (const [ip, e] of entries) {
      const age = String(Math.floor((Date.now() - e.timestamp) / 60000));
      lines.push(
        `IP        ${e.iface.padEnd(17)}${ip.padEnd(21)}${age.padEnd(10)}${e.mac.toCiscoString().padEnd(17)}ARPA   ${e.iface}`,
      );
    }
    return lines.join('\n');
  }

  /**
   * La table du Catalyst, dans la forme que le rendu partage attend.
   *
   * Le nom d'une interface de couche 3 differe par constructeur — VRP
   * ecrit `Vlanif10`, IOS `Vlan10` — et le modele de routage vit sur la
   * base commune des commutateurs ; la traduction se fait donc ici, ou
   * la plateforme est connue.
   */
  /**
   * La distance d'une statique tapee en IOS.
   *
   * Le magasin de routes est PARTAGE avec le commutateur Huawei, dont le
   * defaut est la preference 60 de VRP ; la laisser s'appliquer a une
   * commande d'IOS faisait annoncer `[60/0]` la ou une vraie machine
   * ecrit `[1/0]`, c'est-a-dire le defaut d'un constructeur dans la vue
   * de l'autre. Chaque plateforme nomme donc le sien.
   */
  private static distanceStatiqueIos(mot: string | undefined): number | null {
    if (mot === undefined) return IOS_STATIC_DISTANCE;
    const valeur = Number(mot);
    if (!Number.isInteger(valeur) || valeur < 1 || valeur > 255) return null;
    return valeur;
  }

  private tableRoutageCisco(): Array<Record<string, unknown>> {
    return this.d().getL3RoutingTable().map((r) => ({
      network: r.network,
      mask: r.mask,
      type: r.proto,
      nextHop: r.nextHop,
      iface: iosSviName(r.iface),
      ad: r.preference,
      metric: 0,
    }));
  }

  private hoteTableRoutage(): RouteTableHost {
    const sw = this.d();
    return {
      *localAddresses() {
        for (const svi of sw.getSvis()) {
          if (!svi.adminUp || !svi.ip) continue;
          yield [`Vlan${svi.vlan}`, svi.ip] as const;
        }
      },
    };
  }

  protected override tablesDeContinuations(): readonly ContinuationTable[] {
    return [SOCLE, COMMUTATEUR_SEUL];
  }

  protected override poserRelaisDhcp(iface: string, cible: string): string {
    const vlan = this.sviVlanId(iface);
    if (vlan === null) return CISCO_ERRORS.NOT_APPLICABLE_INTERFACE;
    this.d().addSviHelperAddress(vlan, cible);
    return '';
  }

  protected override retirerRelaisDhcp(iface: string, cible: string): string {
    const vlan = this.sviVlanId(iface);
    if (vlan === null) return CISCO_ERRORS.NOT_APPLICABLE_INTERFACE;
    this.d().removeSviHelperAddress(vlan, cible);
    return '';
  }

  protected override moteurDeListes() { return this.d().getVaclEngine(); }

  protected override poserRouteStatique(reste: string): string {
    const args = reste.trim().split(/\s+/).filter(Boolean);
    if (args.length < 3) return CISCO_ERRORS.INCOMPLETE;
    let net: IPAddress, mask: SubnetMask, gw: IPAddress;
    try { net = new IPAddress(args[0]); } catch { return `% Invalid network ${args[0]}`; }
    try { mask = new SubnetMask(args[1]); } catch { return `% Invalid mask ${args[1]}`; }
    try { gw = new IPAddress(args[2]); } catch { return `% Invalid next-hop ${args[2]}`; }
    const ad = CiscoSwitchShell.distanceStatiqueIos(args[3]);
    if (ad === null) return CISCO_ERRORS.INVALID_INPUT;
    this.d().addStaticRoute(net, mask, gw, ad);
    return '';
  }

  protected override retirerRouteStatique(reste: string): string {
    const args = reste.trim().split(/\s+/).filter(Boolean);
    if (args.length < 2) return CISCO_ERRORS.INCOMPLETE;
    let net: IPAddress, mask: SubnetMask, gw: IPAddress | undefined;
    try { net = new IPAddress(args[0]); } catch { return `% Invalid network ${args[0]}`; }
    try { mask = new SubnetMask(args[1]); } catch { return `% Invalid mask ${args[1]}`; }
    if (args[2]) {
      try { gw = new IPAddress(args[2]); } catch { return `% Invalid next-hop ${args[2]}`; }
    }
    this.d().removeStaticRoute(net, mask, gw);
    return '';
  }

  protected override renduInterfaces(cible: string): string {
    const args = cible.trim().split(/\s+/).filter(Boolean);
      if (args.length === 0) return this.showAllInterfacesDetail();
      const last = args[args.length - 1].toLowerCase();
      /*
       * `show interfaces etherchannel` est la MEME question que
       * `show etherchannel`, posee par l'autre porte d'IOS : elle etait
       * annoncee par `?` et refusee, le mot tombant dans la place du nom
       * d'interface. Elle DELEGUE plutot que de recopier le rendu.
       */
      if (last === 'etherchannel' && args.length === 1) return this.showEtherchannel([]);
      if (last === 'switchport') {
        const target = args.slice(0, -1).join(' ');
        if (!target) {
          return this.d().getPortNames().map((n) => this.showSwitchportDetail(n)).join('\n\n');
        }
        const name = this.resolveInterfaceName(target) ?? target;
        return this.showSwitchportDetail(name);
      }
      if (last === 'counters') {
        const target = args.slice(0, -1).join(' ');
        if (target) {
          const name = this.resolveInterfaceName(target);
          if (!name || !this.d().getPort(name)) {
            return formatInvalidInput(16);
          }
          return this.showInterfacesCounters(name);
        }
        return this.showInterfacesCounters(null);
      }
      if (last === 'description') return this.showInterfacesDescriptionTable();
      if (last === 'trunk' && args.length > 1) {
        const name = this.resolveInterfaceName(args.slice(0, -1).join(' '));
        if (!name || !this.d().getPort(name)) {
          return formatInvalidInput(16);
        }
        return this.showTrunkTable([name]);
      }
      if ('status'.startsWith(last) && last.length >= 3) {
        if (args.length === 1) return this.showInterfacesStatus(this.d());
        const name = this.resolveInterfaceName(args.slice(0, -1).join(' '));
        if (!name || !this.d().getPort(name)) {
          return formatInvalidInput(16);
        }
        return this.showInterfacesStatus(this.d(), name);
      }
      const vlanMatch = args.join(' ').match(/^vl(?:an)?\s*(\d+)$/i);
      if (vlanMatch) return this.showSviInterface(parseInt(vlanMatch[1], 10));
      // `show interfaces <if> etherchannel` — the per-port view of what
      // `show etherchannel` gives for the whole group.
      if (args.length > 1 && args[args.length - 1].toLowerCase() === 'etherchannel') {
        const target = this.resolveInterfaceName(args.slice(0, -1).join(' '));
        if (!target || !this.d().getPort(target)) {
          return formatInvalidInput(16);
        }
        return this.showInterfaceEtherchannel(target);
      }
      const po = this.portChannelIdOf(args.join(' '));
      if (po !== null) return this.showPortChannelInterface(po);
      const name = this.resolveInterfaceName(args.join(' '));
      if (name && this.d().getPort(name)) return showInterface(this.d(), name, true);
      return formatInvalidInput(16);
  }

  protected override renduIpRoute(cible: string): string {
    const args = cible.trim().split(/\s+/).filter(Boolean);
    if (args[0]?.toLowerCase() === 'summary') return this.showIpRouteSummary();

    /*
     * La MEILLEURE route par prefixe, comme le routeur : sans ce choix,
     * une route de secours et sa principale paraissaient toutes les
     * deux, la table annoncant deux chemins la ou la machine n'en
     * installe qu'un.
     */
    const table = renderIpRouteTable(
      this.hoteTableRoutage(), bestRoutesPerPrefix(this.tableRoutageCisco()) as never);
    if (args.length === 0) return table;

    const codes = ROUTE_FILTER_CODES[args[0].toLowerCase()];
    if (codes) return filterRouteTableByCode(table, codes);
    return renderRouteEntryDetail(this.tableRoutageCisco(), args[0]);
  }

  private showIpRouteSummary(): string {
    const rows = this.d().getL3RoutingTable();
    const order: Array<'connected' | 'static'> = ['connected', 'static'];
    const counts: Record<string, { networks: number; subnets: number; replicates: number; overhead: number; memory: number }> = {};
    for (const k of order) counts[k] = { networks: 0, subnets: 0, replicates: 0, overhead: 0, memory: 0 };
    for (const r of rows) {
      const t = r.proto === 'static' ? 'static' : 'connected';
      counts[t].networks++;
      counts[t].subnets++;
      counts[t].overhead += 152;
      counts[t].memory += 360;
    }
    const lines = [
      'IP routing table name is Default-IP-Routing-Table(0)',
      'IP routing table maximum-paths is 16',
      'Route Source    Networks    Subnets     Replicates  Overhead    Memory (bytes)',
    ];
    let totN = 0, totS = 0, totR = 0, totO = 0, totM = 0;
    for (const k of order) {
      const c = counts[k];
      lines.push(`${k.padEnd(16)}${String(c.networks).padEnd(12)}${String(c.subnets).padEnd(12)}${String(c.replicates).padEnd(12)}${String(c.overhead).padEnd(12)}${c.memory}`);
      totN += c.networks; totS += c.subnets; totR += c.replicates; totO += c.overhead; totM += c.memory;
    }
    lines.push(`${'Total'.padEnd(16)}${String(totN).padEnd(12)}${String(totS).padEnd(12)}${String(totR).padEnd(12)}${String(totO).padEnd(12)}${totM}`);
    return lines.join('\n');
  }

  /** IOS `show ip dhcp binding` table — leases currently held by the server. */
  private showIpDhcpBinding(): string {
    const dhcp = this.d()._getDHCPServerInternal();
    const bindings = Array.from(dhcp.getBindings().values());
    const lines: string[] = [
      'Bindings from all pools not associated with VRF:',
      'IP address          Client-ID/              Lease expiration        Type',
      '                    Hardware address/',
      '                    User name',
    ];
    for (const b of bindings) {
      const expire = b.leaseExpiration
        ? new Date(b.leaseExpiration).toUTCString().slice(5, 25)
        : 'Infinite';
      lines.push(`${b.ipAddress.padEnd(20)}01${b.clientId.replace(/:/g, '').toLowerCase().padEnd(22)}${expire.padEnd(24)}Automatic`);
    }
    return lines.join('\n');
  }

  private ipInSubnet(ip: string, network: string, mask: string): boolean {
    try {
      const ipN = new IPAddress(ip);
      const netN = new IPAddress(network);
      const m = new SubnetMask(mask);
      return ipN.isInSameSubnet(netN, m);
    } catch { return false; }
  }

  private showIpDhcpLease(): string {
    const bindings = Array.from(this.d()._getDHCPServerInternal().getBindings().values());
    if (bindings.length === 0) return 'There are no leases.';
    const lines = ['IP address       Expires              Hardware address'];
    for (const b of bindings) {
      const expire = b.leaseExpiration
        ? new Date(b.leaseExpiration).toUTCString().slice(5, 25)
        : 'Infinite';
      lines.push(`${b.ipAddress.padEnd(17)}${expire.padEnd(21)}${b.clientId}`);
    }
    return lines.join('\n');
  }

  private showIpDhcpSnoopingStatistics(): string {
    const s = this.d().getDhcpSnoopingStats();
    const row = (label: string, n: number) => `  ${label.padEnd(52)}${n}`;
    return [
      'Packets Processed by DHCP Snooping = ' + (s.forwarded + s.dropped),
      'Packets Dropped Because',
      row('IDB not known', 0),
      row('Queue full', 0),
      row('Interface is in errdisabled', 0),
      row('Rate limit exceeded', s.droppedRateLimit),
      row('Received on untrusted ports', s.droppedUntrusted),
      row('Nonzero giaddr', 0),
      row('Source mac not equal to chaddr', s.droppedVerifyMac),
      row('Binding mismatch', 0),
      row('Insertion of opt82 fail', 0),
      row('Packet denied by platform', 0),
    ].join('\n');
  }

  /** `show ip interface brief` — the switch carries IPs only on SVIs. */
  private showIpInterfaceBrief(): string {
    const rows = ipIntBriefRowsFromPorts(this.d()._getPortsInternal());
    for (const svi of this.d().getSvis()) {
      rows.push({
        name: `Vlan${svi.vlan}`,
        ip: svi.ip ? svi.ip.toString() : 'unassigned',
        method: svi.ip ? 'manual' : 'unset',
        status: svi.adminUp ? 'up' : 'administratively down',
        protocol: svi.adminUp && this.d().isSviLineUp(svi) ? 'up' : 'down',
      });
    }
    return renderIpIntBrief(rows, 23);
  }

  /**
   * The LACP knobs and views, same story as 802.1X: `LacpAgent` runs a
   * genuine 802.3ad receive machine, and `setSystemPriority` /
   * `setFastRate` — which really move the advertising cadence, the
   * current_while timeout and the aggregation tie-break — were called
   * from nowhere at all. `show etherchannel` was the only window onto
   * any of it.
   *
   * `port-channel load-balance` is refused rather than stored: a bundle
   * here groups members for STP and nothing distributes data frames
   * across them, so the method would have nothing to decide.
   */
  private registerLacp(trie: SwitchTries): void {
    const agent = () => this.requireLacp();

    trie.config.registerGreedy('lacp system-priority', 'LACP system priority', (args) => {
      const v = parseInt(args[0] ?? '', 10);
      if (isNaN(v) || v < 1 || v > 65535) return '% Invalid value, valid range is 1 to 65535.';
      agent().setSystemPriority(v);
      return '';
    });

    trie.config.registerGreedy('port-channel load-balance', 'EtherChannel load-balancing', (args) => {
      const methode = (args[0] ?? '').toLowerCase();
      if (!methode) return CISCO_ERRORS.INCOMPLETE;
      if (!LOAD_BALANCE_METHODS.has(methode)) return CISCO_ERRORS.INVALID_INPUT;
      agent().setLoadBalance(methode as LoadBalanceMethod);
      return '';
    });

    trie.configIf.registerGreedy('lacp rate', 'LACPDU rate', (args) => {
      const rate = (args[0] ?? '').toLowerCase();
      if (rate !== 'fast' && rate !== 'normal') return CISCO_ERRORS.INVALID_INPUT;
      return this.applyToSelectedInterfaces(portName => {
        agent().setPortFastRate(portName, rate === 'fast' ? true : null);
        return '';
      });
    });

    trie.configIf.registerGreedy('lacp port-priority', 'LACP port priority', (args) => {
      const v = parseInt(args[0] ?? '', 10);
      if (isNaN(v) || v < 1 || v > 65535) return '% Invalid value, valid range is 1 to 65535.';
      return this.applyToSelectedInterfaces(portName => {
        agent().setPortPriority(portName, v);
        return '';
      });
    });

    trie.privileged.registerGreedy('show lacp', 'Display LACP state', (args) => this.showLacp(args));
    trie.privileged.registerGreedy('test etherchannel load-balance',
      'Simulate the load-balance decision for a flow', (args) => {
        const mots = args.map(a => a.toLowerCase());
        const iPort = mots.indexOf('port-channel');
        const groupId = iPort >= 0 ? Number(args[iPort + 1]) : NaN;
        if (!Number.isFinite(groupId)) return CISCO_ERRORS.INCOMPLETE;
        const groupe = this.requireLacp().getAllGroups().find(g => g.id === groupId);
        if (!groupe) return `% Channel group ${groupId} does not exist`;
        const membres = groupe.members.filter(m => m.bundled).map(m => m.portName);
        if (membres.length === 0) return '% No ports are bundled in this port-channel';
        const iCle = mots.findIndex(m => m === 'ip' || m === 'mac');
        if (iCle < 0) return CISCO_ERRORS.INCOMPLETE;
        const cle = args.slice(iCle + 1).filter(Boolean).join('|');
        if (!cle) return CISCO_ERRORS.INCOMPLETE;
        const elu = selectBundleMemberForFlow(membres, cle);
        return elu ? `Would use ${this.abbreviateInterface(elu)}` : CISCO_ERRORS.INVALID_INPUT;
      });

    trie.privileged.registerGreedy('show pagp', 'Display PAgP state', () =>
      '% PAgP is not implemented: this switch aggregates with LACP only.');
  }

  private portChannelIdOf(input: string): number | null {
    const m = input.trim().replace(/\s+/g, '')
      .match(/^(?:po|por|port|port-|port-c|port-ch|port-cha|port-chan|port-chann|port-channe|port-channel)(\d+)$/i);
    return m ? Number(m[1]) : null;
  }

  private showPortChannelInterface(groupId: number): string {
    const agent = this.requireLacp();
    const group = agent.getAllGroups().find(g => g.id === groupId);
    if (!group) return formatInvalidInput(16);
    const bundled = group.members.filter(m => m.bundled);
    const ports = bundled.map(m => this.d().getPort(m.portName)).filter(Boolean);
    const premier = this.d().getPort(group.members[0]?.portName ?? '');
    const up = bundled.length > 0;
    const mac = (ports[0] ?? premier)?.getMAC().toCiscoString() ?? '0000.0000.0000';
    const bw = ports.length > 0
      ? ports.reduce((t, p) => t + (p!.getEffectiveBandwidthKbps()), 0)
      : (premier?.getEffectiveBandwidthKbps() ?? 100000);
    const dly = (ports[0] ?? premier)?.getDelayUs() ?? 100;
    const mtu = (ports[0] ?? premier)?.getMTU() ?? 1500;
    const lignes = [
      `${group.name} is ${up ? 'up' : 'down'}, line protocol is ${up ? 'up (connected)' : 'down (notconnect)'}`,
      `  Hardware is EtherChannel, address is ${mac} (bia ${mac})`,
      `  MTU ${mtu} bytes, BW ${bw} Kbit/sec, DLY ${dly} usec,`,
      '     reliability 255/255, txload 1/255, rxload 1/255',
      '  Encapsulation ARPA, loopback not set',
      '  Keepalive set (10 sec)',
      '  Auto-duplex, Auto-speed, media type is unknown',
      '  input flow-control is off, output flow-control is unsupported',
      '  ARP type: ARPA, ARP Timeout 04:00:00',
      '  Last input never, output never, output hang never',
      '  Last clearing of "show interface" counters never',
      '  Input queue: 0/2000/0/0 (size/max/drops/flushes); Total output drops: 0',
      '  Queueing strategy: fifo',
      '  Output queue: 0/40 (size/max)',
      '  5 minute input rate 0 bits/sec, 0 packets/sec',
      '  5 minute output rate 0 bits/sec, 0 packets/sec',
    ];
    const cin = ports.reduce((t, p) => t + p!.getCounters().framesIn, 0);
    const bin = ports.reduce((t, p) => t + p!.getCounters().bytesIn, 0);
    const cout = ports.reduce((t, p) => t + p!.getCounters().framesOut, 0);
    const bout = ports.reduce((t, p) => t + p!.getCounters().bytesOut, 0);
    lignes.push(
      `     ${cin} packets input, ${bin} bytes, 0 no buffer`,
      '     Received 0 broadcasts (0 multicasts)',
      '     0 runts, 0 giants, 0 throttles',
      '     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored',
      '     0 input packets with dribble condition detected',
      `     ${cout} packets output, ${bout} bytes, 0 underruns`,
      '     0 output errors, 0 collisions, 0 interface resets',
      '     0 unknown protocol drops',
      '     0 babbles, 0 late collision, 0 deferred',
      '     0 lost carrier, 0 no carrier',
      '     0 output buffer failures, 0 output buffers swapped out',
    );
    return lignes.join('\n');
  }

  private showInterfaceEtherchannel(portName: string): string {
    const agent = this.requireLacp();
    const info = agent.getPortInfo(portName);
    if (!info) return `Port ${portName} is not part of an EtherChannel`;
    const group = agent.getAllGroups().find(g => g.id === info.groupId);
    const partner = info.partner;
    return [
      `Port state    = ${info.bundled ? 'Up Mstr In-Bndl' : 'Down Not-in-Bndl'}`,
      `Channel group = ${info.groupId}          Mode = ${info.mode}`,
      `Port-channel  = ${group?.name ?? `Port-channel${info.groupId}`}`,
      `Port index    = ${this.d().getPortNames().indexOf(portName)}`,
      `Load          = 0x00`,
      '',
      'Local information:',
      '                            LACP port    Admin     Oper    Port',
      'Port      Flags   State     Priority     Key       Key     Number',
      `${this.abbreviateInterface(portName).padEnd(10)}`
      + `${(agent.rateOf(info) ? 'F' : 'S') + (info.mode === 'active' ? 'A' : 'P')}      `
      + `${info.state.padEnd(10)}${String(info.portPriority).padEnd(13)}`
      + `${String(info.groupId).padEnd(10)}${String(info.groupId).padEnd(8)}`
      + `${this.d().getPortNames().indexOf(portName) + 1}`,
      '',
      'Partner information:',
      partner
        ? `          System ${partner.systemPriority},${partner.systemId}  Key ${partner.key}  Port ${partner.portNumber}`
        : '          No partner learned on this port',
    ].join('\n');
  }

  private showLacp(args: string[]): string {
    if (args.length === 0) throw new CliIncomplete();
    const agent = this.requireLacp();
    const cfg = agent.getConfig();
    const restreint = /^\d+$/.test(args[0] ?? '') ? Number(args[0]) : null;
    const reste = restreint === null ? args : args.slice(1);
    const what = (reste[0] ?? '').toLowerCase();
    const sysId = `${cfg.systemPriority}, ${cfg.systemId}`;

    if (what === 'sys-id') return sysId;

    const groupes = agent.getAllGroups()
      .filter(g => restreint === null || g.id === restreint);
    if (restreint !== null && groupes.length === 0) {
      return `% Channel group ${restreint} does not exist`;
    }
    const members = groupes.flatMap(g => g.members);
    if (what === 'neighbor') {
      if (members.length === 0) return 'Flags:  S - Device is requesting Slow LACPDUs';
      const lines = [
        'Flags:  S - Device is requesting Slow LACPDUs  F - Device is requesting Fast LACPDUs',
        '        A - Device is in Active mode           P - Device is in Passive mode',
        '',
        'Port      Partner System ID          Age  Flags  Port Pri.  Oper Key  Port Number',
      ];
      for (const m of members) {
        const p = m.partner;
        lines.push(
          `${this.abbreviateInterface(m.portName).padEnd(10)}`
          + `${(p ? `${p.systemPriority},${p.systemId}` : 'none').padEnd(27)}`
          + `${(p ? `${Math.round((Date.now() - m.lastRxMs) / 1000)}s` : '-').padEnd(5)}`
          + `${(agent.rateOf(m) ? 'F' : 'S') + (m.mode === 'active' ? 'A' : 'P')}     `
          + `${String(p?.portPriority ?? 0).padEnd(11)}`
          + `${String(p?.key ?? 0).padEnd(10)}`
          + `${p?.portNumber ?? 0}`,
        );
      }
      return lines.join('\n');
    }

    if (what === 'internal') {
      const lines = [
        'Flags:  S - Device is requesting Slow LACPDUs  F - Device is requesting Fast LACPDUs',
        '        A - Device is in Active mode           P - Device is in Passive mode',
      ];
      for (const g of groupes) {
        lines.push('');
        lines.push(`Channel group ${g.id}`);
        lines.push('                            LACP port     Admin     Oper    '
          + 'Port        Port');
        lines.push('Port      Flags   State     Priority      Key       Key     '
          + 'Number      State');
        for (const m of g.members) {
          const numero = this.d().getPortNames().indexOf(m.portName) + 1;
          lines.push(
            `${this.abbreviateInterface(m.portName).padEnd(10)}`
            + `${((agent.rateOf(m) ? 'F' : 'S') + (m.mode === 'active' ? 'A' : 'P')).padEnd(8)}`
            + `${iosLacpState(m.state).padEnd(10)}`
            + `${String(m.portPriority).padEnd(14)}`
            + `${hex(m.groupId).padEnd(10)}${hex(m.groupId).padEnd(8)}`
            + `${hex(numero).padEnd(12)}`
            + `${hex(buildActorState(m.mode, m, agent.rateOf(m)))}`,
          );
        }
      }
      return lines.join('\n');
    }

    if (what === 'counters') {
      const lines = [
        '             LACPDUs         Marker      Marker Response    LACPDUs',
        'Port       Sent   Recv     Sent   Recv     Sent   Recv      Pkts Err',
        '---------------------------------------------------------------------',
      ];
      for (const m of members) {
        const s = agent.getStatistics(m.portName);
        const k = agent.getMarkerStatistics(m.portName);
        lines.push(
          `${this.abbreviateInterface(m.portName).padEnd(11)}`
          + `${String(s.sent).padEnd(7)}${String(s.received).padEnd(9)}`
          + `${String(k.sent).padEnd(7)}${String(k.received).padEnd(9)}`
          + `${String(k.responseSent).padEnd(7)}${String(k.responseReceived).padEnd(10)}0`,
        );
      }
      return lines.join('\n');
    }

    return CISCO_ERRORS.INVALID_INPUT;
  }

  /**
   * 802.1X on the Cisco side. `Dot1xAgent` is real — genuine EAP rounds,
   * a RADIUS backend, and a port whose forwarding is actually gated on
   * authorisation — and the Huawei shell has driven it all along. The
   * Cisco switch built one and offered no way to reach it, so every
   * `dot1x` line in a Catalyst lab came back `% Invalid input`.
   *
   * What the agent does not model is refused rather than accepted in
   * silence: it authorises a port for one supplicant, so `host-mode`
   * has nothing to vary, and it has no periodic re-authentication timer
   * (its `reauthCount` counts EAP request retries, not re-auth cycles).
   */
  private registerDot1x(trie: {
    config: CommandTrie; configIf: CommandTrie; privileged: CommandTrie;
  }): void {
    const agent = () => this.d().getDot1xAgent();

    trie.config.register('dot1x system-auth-control', 'Enable 802.1X globally', () => {
      agent().setSystemAuthControl(true);
      return '';
    });
    trie.config.register('no dot1x system-auth-control', 'Disable 802.1X globally', () => {
      agent().setSystemAuthControl(false);
      return '';
    });

    // The PAE role registers the port with the authenticator; on its own
    // it does not control anything — `port-control` decides that.

    const MODES: Record<string, import('@/network/dot1x/types').Dot1xPortMode> = {
      auto: 'auto',
      'force-authorized': 'force-authorized',
      'force-unauthorized': 'force-unauthorized',
    };
    trie.configIf.registerGreedy('dot1x port-control', '802.1X port control mode', (args) => {
      const mode = MODES[(args[0] ?? '').toLowerCase()];
      if (!mode) return CISCO_ERRORS.INVALID_INPUT;
      return this.applyToSelectedInterfaces(portName => {
        agent().setPortMode(portName, mode);
        return '';
      });
    });

    trie.configIf.registerGreedy('dot1x timeout', '802.1X timers', (args) => {
      const which = (args[0] ?? '').toLowerCase();
      const value = parseInt(args[1] ?? '', 10);
      if (which !== 'quiet-period') {
        return `% Only quiet-period is supported; this switch has no ${which || 'such'} timer.`;
      }
      if (isNaN(value) || value < 1 || value > 65535) return '% Invalid value, valid range is 1 to 65535.';
      return this.applyToSelectedInterfaces(portName => {
        agent().setHoldTime(value * 1000, portName);
        return '';
      });
    });

    trie.configIf.registerGreedy('dot1x host-mode', '802.1X host mode', () =>
      '% Host modes are not supported: a port authorises a single supplicant.');
    trie.configIf.register('dot1x reauthentication', 'Periodic re-authentication', () =>
      '% Periodic re-authentication is not supported on this switch.');

    trie.privileged.registerGreedy('show dot1x', 'Display 802.1X state', (args) =>
      this.showDot1x(args));
  }

  private showDot1x(args: string[]): string {
    const agent = this.d().getDot1xAgent();
    const cfg = agent.getConfig();
    const head = [
      `Sysauthcontrol              ${cfg.enabled ? 'Enabled' : 'Disabled'}`,
      `Dot1x Protocol Version      2`,
    ];
    const first = (args[0] ?? '').toLowerCase();
    if (args.length === 0 || first === 'all') {
      const ports = agent.listPorts();
      if (ports.length === 0) return head.join('\n');
      const out = [...head];
      for (const rt of ports) out.push('', ...this.dot1xPortBlock(rt));
      return out.join('\n');
    }
    if (first === 'interface') {
      const name = this.resolveInterfaceName(args.slice(1).join(' '));
      const rt = name ? agent.getPortRuntime(name) : undefined;
      if (!rt) return '% Dot1x is not enabled on the specified interface';
      return this.dot1xPortBlock(rt).join('\n');
    }
    return CISCO_ERRORS.INVALID_INPUT;
  }

  private dot1xPortBlock(rt: import('@/network/dot1x/types').Dot1xPortRuntime): string[] {
    return [
      `Dot1x Info for ${rt.port}`,
      '-----------------------------------',
      `PAE                       = AUTHENTICATOR`,
      `PortControl               = ${rt.mode.toUpperCase()}`,
      `ControlDirection          = Both`,
      `HostMode                  = SINGLE_HOST`,
      `QuietPeriod               = ${Math.round(rt.holdMs / 1000)}`,
      `MaxReq                    = ${rt.maxReauthReq}`,
      `Status                    = ${rt.state.toUpperCase()}`,
      `Authorized                = ${this.d().getDot1xAgent().isPortAuthorized(rt.port) ? 'YES' : 'NO'}`,
      `Supplicant                = ${rt.lastSupplicantMac ?? 'none'}`,
      `Identity                  = ${rt.identity ?? 'none'}`,
    ];
  }

  /** `[no] shutdown` for either a physical port or a management SVI. */
  private setIfAdminState(iface: string, up: boolean): string {
    const vlan = this.sviVlanId(iface);
    if (vlan !== null) { this.d().setSviAdminUp(vlan, up); return ''; }
    const port = this.d().getPort(iface);
    if (port) { port.setAdminShutdown(!up); return ''; }
    return '% Error';
  }

  protected override resolveInterfaceName(input: string): string | null {
    const lower = input.trim().replace(/\s+/g, '').toLowerCase();

    for (const name of this.d().getPortNames()) {
      if (name.toLowerCase() === lower) return name;
    }

    const prefixMap: Record<string, string> = {
      'fa': 'FastEthernet',
      'fas': 'FastEthernet',
      'fast': 'FastEthernet',
      'faste': 'FastEthernet',
      'fastet': 'FastEthernet',
      'fasteth': 'FastEthernet',
      'fastetherr': 'FastEthernet',
      'fastethernet': 'FastEthernet',
      'gi': 'GigabitEthernet',
      'gig': 'GigabitEthernet',
      'giga': 'GigabitEthernet',
      'gigab': 'GigabitEthernet',
      'gigabi': 'GigabitEthernet',
      'gigabit': 'GigabitEthernet',
      'gigabite': 'GigabitEthernet',
      'gigabitet': 'GigabitEthernet',
      'gigabiteth': 'GigabitEthernet',
      'gigabitethernet': 'GigabitEthernet',
      'eth': 'eth',
    };

    const match = lower.match(/^([a-z]+)([\d/.-]+)$/);
    if (!match) return null;

    const [, prefix, numbers] = match;
    const fullPrefix = prefixMap[prefix];
    if (!fullPrefix) return null;

    const resolved = `${fullPrefix}${numbers}`;

    for (const name of this.d().getPortNames()) {
      if (name === resolved) return name;
    }

    return null;
  }

  private handleInterfaceRange(args: string[]): string {
    if (args.length < 1) return CISCO_ERRORS.INCOMPLETE;

    const segments = decouperPlages(args.join(' '), '-');
    if (!segments) return '% Invalid interface range.';

    const noms = this.d().getPortNames();
    const interfaces: string[] = [];
    for (const segment of segments) {
      const premier = this.resolveInterfaceName(segment.premier);
      if (!premier) return '% Invalid interface range.';
      const dernier = segment.dernier === null
        ? null
        : this.resolveInterfaceName(completerBorne(segment.premier, segment.dernier));
      if (segment.dernier !== null && !dernier) return '% Invalid interface range.';
      const etendue = etendreEntre(noms, premier, dernier);
      if (!etendue) return '% No valid interfaces in range.';
      for (const nom of etendue) if (!interfaces.includes(nom)) interfaces.push(nom);
    }

    if (interfaces.length === 0) return '% No valid interfaces in range.';
    this.selectedInterface = interfaces[0];
    this.selectedInterfaceRange = interfaces;
    this.mode = 'config-if';
    return '';
  }

  private static readonly HORS_PLAGE = new Set(['exit', 'end', 'interface', 'do']);

  private diffuserSurPlage(sw: CiscoSwitch, input: string): string | null {
    if (this.mode !== 'config-if') return null;
    const membres = [...this.selectedInterfaceRange];
    if (membres.length < 2) return null;
    const trimmed = input.trim();
    if (!trimmed || trimmed.endsWith('?')) return null;
    const tete = trimmed.replace(/^no\s+/i, '').split(/\s+/)[0].toLowerCase();
    if (CiscoSwitchShell.HORS_PLAGE.has(tete)) return null;

    const modeAvant = this.mode;
    const sorties: string[] = [];
    try {
      for (const membre of membres) {
        this.selectedInterface = membre;
        this.selectedInterfaceRange = [membre];
        this.mode = modeAvant;
        const sortie = this.executeOnDevice(sw, input) as string;
        if (sortie && sortie.trim()) sorties.push(sortie);
      }
    } finally {
      this.selectedInterface = membres[0];
      this.selectedInterfaceRange = membres;
      this.mode = modeAvant;
    }
    return [...new Set(sorties)].join('\n');
  }

  selectedPortChannelIds(): number[] {
    return this.selectedInterfaceRange
      .map(n => /^Port-channel(\d+)$/i.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => Number(m[1]));
  }

  setPortChannelMinLinks(groupId: number, value: number): void {
    this.requireLacp().setGroupLimits(groupId, { minLinks: value });
  }

  setPortChannelMaxBundle(groupId: number, value: number): void {
    this.requireLacp().setGroupLimits(groupId, { maxLinks: value });
  }

  private membresDuPortChannel(nom: string): string[] {
    const m = /^Port-channel(\d+)$/i.exec(nom);
    if (!m) return [];
    const lacp = (this.d() as unknown as { getLacpAgent?: () => {
      getGroupMembers(id: number): Array<{ portName: string }>;
    } }).getLacpAgent?.();
    return lacp?.getGroupMembers(Number(m[1])).map(p => p.portName) ?? [];
  }

  private applyToSelectedInterfaces(fn: (portName: string) => string): string {
    const results: string[] = [];
    for (const portName of this.selectedInterfaceRange) {
      if (/^Port-channel\d+$/i.test(portName)) {
        // Sur IOS la configuration de niveau 2 vit sur le Port-channel
        // et les membres la PRENNENT ; un faisceau encore vide se
        // configure donc, et le membre qui arrive herite.
        this.d().ensureAggregateSwitchportConfig(portName);
        const r = fn(portName);
        if (r) results.push(r);
        for (const membre of this.membresDuPortChannel(portName)) {
          this.d().inheritAggregateSwitchport(portName, membre);
        }
        continue;
      }
      const result = fn(portName);
      if (result) results.push(result);
    }
    return results.join('\n');
  }

  // ─── Utility ──────────────────────────────────────────────────────

  /** Compact a sorted VLAN list into ranges, e.g. [1,2,3,5] → "1-3,5" */
  private compactVlanList(sorted: number[]): string {
    return compactVlanList(sorted);
  }

  private qosRunningConfigLines(cfg: SwitchportConfig): string[] {
    const lines: string[] = [];
    if (cfg.trustMode === 'cos') lines.push(' mls qos trust cos');
    else if (cfg.trustMode === 'dscp') lines.push(' mls qos trust dscp');
    if (cfg.defaultCos !== undefined) lines.push(` mls qos cos ${cfg.defaultCos}`);
    if (cfg.priorityExtend?.mode === 'cos') lines.push(` switchport priority extend cos ${cfg.priorityExtend.value}`);
    else if (cfg.priorityExtend?.mode === 'trust') lines.push(' switchport priority extend trust');
    return lines;
  }

  private parseVlanList(input: string): Set<number> | null {
    return parseVlanList(input);
  }

  /**
   * Une ligne de la vue d'ACL nommee, ecrite dans le MOTEUR.
   *
   * Les cinq mots-cles poussaient une ligne de TEXTE dans un magasin
   * parallele, et seuls `permit`/`deny` atteignaient le moteur -- par un
   * analyseur qui ne lisait que protocole, source et destination. `no`
   * n'atteignait rien du tout : la regle disparaissait de la vue et
   * continuait de filtrer.
   */
  /**
   * Le commutateur nomme sa sous-vue d'ACL `config-acl` la ou le routeur
   * a `config-{std,ext}-nacl`. Le socle ne reconnaissait donc pas la
   * sienne, et la forme numerotee nue d'IOS -- `10 permit ip any any`,
   * celle qu'on tape -- y etait refusee alors qu'elle marchait sur le
   * routeur. La regle appartient au shell, pas au socle : elle est
   * surchargee ici plutot qu'ajoutee a `CiscoShellBase`.
   */
  protected override isAclSubMode(): boolean {
    return super.isAclSubMode() || this.mode === 'config-acl';
  }

  private handleNamedAclLine(kw: string, args: string[], sequence?: number): string {
    const name = this.selectedAcl;
    if (!name) return '';
    const engine = this.d().getVaclEngine();
    const type = this.selectedAclType;
    const anyOpts = () => ({
      srcIP: new IPAddress('0.0.0.0'), srcWildcard: new SubnetMask('255.255.255.255'),
      ...(type === 'extended'
        ? {
          protocol: 'ip',
          dstIP: new IPAddress('0.0.0.0'), dstWildcard: new SubnetMask('255.255.255.255'),
        }
        : {}),
    });

    if (kw === 'remark') {
      engine.addNamedAccessListEntry(name, type, 'permit',
        { ...anyOpts(), remark: args.join(' ') });
      return '';
    }
    if (kw === 'evaluate') {
      if (!args[0]) return CISCO_ERRORS.INCOMPLETE;
      engine.addNamedAccessListEntry(name, type, 'permit',
        { ...anyOpts(), evaluate: args[0] });
      return '';
    }
    if (kw === 'no') {
      const seq = parseInt(args[0] ?? '', 10);
      if (!isNaN(seq) && args.length === 1) {
        return engine.removeEntryBySequence(name, seq) ? '' : '% Sequence number not found';
      }
      const action = args[0]?.toLowerCase();
      if (action !== 'permit' && action !== 'deny') return CISCO_ERRORS.INCOMPLETE;
      const parsed = parseCiscoAce(args.slice(1), type);
      if ('error' in parsed) return parsed.error;
      const cible = renderCiscoAce(action, type, parsed.opts);
      const acl = engine.findByName(name);
      const idx = acl
        ? acl.entries.findIndex((e) => formatCiscoAclEntry(type, e) === cible)
        : -1;
      if (idx === -1) return '% Access list entry does not exist.';
      acl!.entries.splice(idx, 1);
      return '';
    }

    const parsed = parseCiscoAce(args, type, sequence);
    if ('error' in parsed) return parsed.error;
    const ok = engine.addNamedAccessListEntry(
      name, type, kw as 'permit' | 'deny', parsed.opts);
    return ok ? '' : '% Duplicate sequence number.';
  }

  private abbreviateInterface(name: string): string {
    return name
      .replace('FastEthernet', 'Fa')
      .replace('GigabitEthernet', 'Gi');
  }
}
