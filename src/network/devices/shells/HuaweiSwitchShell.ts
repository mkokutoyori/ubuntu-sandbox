/**
 * HuaweiSwitchShell - Huawei VRP CLI Engine for Switches (CommandTrie-based)
 *
 * Modes (FSM States):
 *   - user: User view (<hostname>)
 *   - system: System view ([hostname])
 *   - interface: Interface view ([hostname-GigabitEthernet0/0/X])
 *   - vlan: VLAN view ([hostname-vlanX])
 *
 * Uses CommandTrie for:
 *   - Abbreviation matching (dis → display, sys → system-view)
 *   - Tab completion (unique prefix → complete, ambiguous → null)
 *   - ? help (prefix listing vs subcommand listing)
 */

import { CommandTrie } from './CommandTrie';
import {
  parseSuppressionRule, parseVrpCarRule, parseMqcCarRule, SUPPRESSION_KINDS,
} from '../../qos/CarPolicer';
import { NetworkOsAccount } from '../router/aaa/NetworkOsAccount';
import {
  withVrpCommonHelp, withVrpCommonCandidates,
  type VrpViewKind,
} from './huawei/vrpCommonCommands';
import { EquipmentParamResolver } from './EquipmentParamResolver';
import { huaweiInteractionPlanFor } from './huawei/HuaweiInteractionPlans';
import type { CommandInteractionPlan } from '@/shell/interaction/CommandInteraction';
import type { ISwitchShell } from './ISwitchShell';
import type { Switch } from '../Switch';
import { MACAddress, IPAddress, SubnetMask, type PortViolationMode } from '../../core/types';
import { parsePipeFilter, applyPipeFilter, resolveHuaweiNav, HUAWEI_ERRORS, refuseUnknownUndo, normaliserErreurVrp, tropDeParametres, huaweiTypeInterface, refuseMotInattenduVrp, rendreErreurVrp } from './cli-utils';
import { getCredentialStore } from '@/network/equipment/RouterServiceCapabilities';
import {
  displayClock, displayCpuUsage, displayMemoryUsage, displayUsers,
  displayDevice, displayHistoryCommand, displayAlarm, displayElabel,
  displayLicense, displayLogbuffer, displayTrapbuffer,
  displayPatchInformation, displayDiagnosticInformation,
} from './huawei/HuaweiCommonDisplay';
import { registerHuaweiCommonMgmt } from './huawei/HuaweiCommonConfig';
import type { HuaweiDebugService } from '../router/diag/HuaweiDebugService';
import { analyserAcl } from './huawei/HuaweiAclGrammar';
import { type HuaweiSwitchDevice, commeRouteur, moteurNat, ajouterLigneVlan, lignesDuVlan } from './huawei/huaweiSwitchDevice';
import { VrpSocle } from '@/cli/vendors/vrp/vrpSocle';
import { VRP_SWITCH_MODES } from '@/cli/vendors/vrp/vrpModes';
import { vrpMtuFamily } from '@/cli/vendors/vrp/vrpInterfaceParamsFamily';
import { vrpClockFamily, VRP_TIMEZONE_DEFAUT } from '@/cli/vendors/vrp/vrpClockFamily';
import { mqcMatchLine, mqcRemarkLines } from '../Switch';
import { DSCP_KEYWORD_TO_VALUE } from '../router/ACLEngine';
import { resolveHuaweiInterfaceName, huaweiDisplayInterfaceName } from './cli-utils';
import { iosInterfaceStatus } from '../inspection/InterfaceStatusView';
import {
  type LigneIpBrief, type LigneInterface, protocoleVrp, rendreIpInterfaceBrief,
  rendreInterfaceBrief, rendreInterfaceDescription, huaweiMacAddress,
  type LigneArp, rendreArpSwitch, rendreMacAddress,
} from './huawei/huaweiTableLayouts';
import { analyserStp, STP_SYSTEME, STP_INTERFACE, borneTimerStp, declarerAideStp,
} from './huawei/HuaweiStpGrammar';
import { vrpStpGlobalLines, vrpStpRegionLines } from './huawei/HuaweiStpRender';
import { analyserPlagePorts, etendrePlage, portGroupRunningConfigLines, renduDisplayPortGroup } from './huawei/HuaweiPortGroup';
import { completerBorne } from './cli/interfaceRange';
import { analyserMacAddress, analyserApprentissageMac, ligneApprentissageMac, macRunningConfigLines, normaliserMacVrp, VRP_MAC_AGING_DEFAUT } from './huawei/HuaweiMacCommands';
import {
  registerHuaweiNATInterfaceCommands,
  registerHuaweiNATSystemCommands,
  registerHuaweiNATDisplayCommands,
  runningConfigNATHuawei,
} from './huawei/HuaweiNATCommands';
import type { HuaweiShellContext } from './huawei/HuaweiConfigCommands';
import {
  analyserTeteRouteStatiqueVrp, lireQueueRouteStatiqueVrp, QUEUE_PARAMETRE_INVALIDE,
} from './huawei/HuaweiConfigCommands';
import { VRP_STATIC_PREFERENCE } from '../SwitchSvi';
import {
  registerHuaweiCommonSecurity, registerHuaweiCommonSecurityDisplay,
} from './huawei/HuaweiCommonSecurity';
import { lignesConfigSnmpVrp } from './huawei/huaweiSnmpCommands';
import { buildDhcpPoolCommands } from './huawei/HuaweiDhcpCommands';
import { formatHuaweiAcl, formatHuaweiAclConfig } from './huawei/HuaweiAclFormat';
import { analyserRegleVrp } from './huawei/HuaweiAclRule';
import {
  AUCUN_GROUPE, analyserVrrp, appliquerVrrp, groupesDeLInterface, lignesConfigVrrp,
  rendreDisplayVrrp, rendreDisplayVrrpBrief, rendreDisplayVrrpStatistics,
} from './huawei/huaweiVrrpViews';
import { runningConfigAclLines } from './huawei/HuaweiAclCommands';
import {
  describeHuaweiInterfaceArg, wordArg,
  STP_SYSTEM_KEYWORDS, STP_INTERFACE_KEYWORDS,
} from './huawei/huaweiInterfaceHelp';
import { describeHuaweiArguments } from './huawei/huaweiArgumentHelp';
import { buildActorState, lacpStateBits } from '@/network/lacp/types';
import { LOAD_BALANCE_METHODS } from '@/network/lacp/loadBalance';

const VUES_SWITCH = [
  'user', 'system', 'interface', 'vlan', 'mst-region', 'port-group',
  'aaa', 'user-interface', 'acl', 'dhcp-pool',
  'traffic-classifier', 'traffic-behavior', 'traffic-policy',
] as const;

type VRPSwitchMode = typeof VUES_SWITCH[number];

/**
 * Le NUMERO d'une saisie `<type><n>` ou `<type> <n>`, quand le type
 * designe bien `attendu` — par son nom entier ou par n'importe quel
 * prefixe non ambigu, comme VRP l'admet.
 */
function numeroDInterface(saisie: string, attendu: string): number | null {
  const m = saisie.replace(/\s+/g, '').match(/^([a-z-]+)(\d+)$/i);
  if (!m || huaweiTypeInterface(m[1]) !== attendu) return null;
  return parseInt(m[2], 10);
}

/**
 * RSTP et MSTP n'ont que trois etats — Discarding, Learning, Forwarding —
 * les Listening et Blocking de 802.1D y ayant ete fondus dans Discarding.
 * Tout etat que le moteur nomme autrement se rend donc DISCARDING, l'etat
 * qui ne fait pas passer de trafic.
 */
function mstpStateName(state: string): string {
  if (state === 'forwarding') return 'FORWARDING';
  if (state === 'learning') return 'LEARNING';
  return 'DISCARDING';
}

/**
 * `vty0-4` redevient `user-interface vty 0 4`. L'etiquette est ce que la
 * vue affiche ; la configuration doit rendre la commande qui la rouvre.
 */
function macLimitSettingKey(args: readonly string[]): string {
  const vlanAt = args.findIndex(word => word.toLowerCase() === 'vlan');
  const vlan = vlanAt === -1 ? null : args[vlanAt + 1];
  return vlan ? `mac-limit maximum vlan ${vlan}` : 'mac-limit maximum';
}

function vrpUserInterfaceHeader(label: string): string | null {
  const m = /^([a-z-]+)(\d+)(?:-(\d+))?$/.exec(label);
  if (!m) return null;
  return `user-interface ${m[1]} ${m[2]}${m[3] ? ` ${m[3]}` : ''}`;
}

/**
 * VRP compte les DESTINATIONS — les prefixes distincts — a part des
 * routes. Les deux nombres etaient le meme tant qu'un prefixe ne pouvait
 * porter qu'une route ; ils divergent des qu'on ecrit une route de
 * secours, et c'est justement ce que ce compteur existe pour montrer.
 */
function destinationsDistinctes(
  rows: ReadonlyArray<{ network: { toString(): string }; mask: { toCIDR(): number } }>,
): number {
  return new Set(rows.map(r => `${r.network}/${r.mask.toCIDR()}`)).size;
}

const VRP_HASH_ARITHMETIC: Readonly<Record<string, string>> = {
  'src-dst-ip': 'According to SIP-XOR-DIP',
  'src-dst-mac': 'According to SA-XOR-DA',
  'src-ip': 'According to SIP',
  'dst-ip': 'According to DIP',
  'src-mac': 'According to SA',
  'dst-mac': 'According to DA',
};

function hashArithmeticVrp(mode: string): string {
  return VRP_HASH_ARITHMETIC[mode] ?? VRP_HASH_ARITHMETIC['src-dst-ip'];
}

function vrpMacFormat(mac: string): string {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function vrpBandwidth(mbps: number): string {
  return mbps >= 1000 && mbps % 1000 === 0 ? `${mbps / 1000}G` : `${mbps}M`;
}

function portTypeVrp(nom: string): string {
  if (/^GigabitEthernet/i.test(nom)) return '1GE';
  if (/^TenGigabitEthernet|^XGigabitEthernet/i.test(nom)) return '10GE';
  if (/^FastEthernet|^Ethernet/i.test(nom)) return '100M';
  return 'GE';
}

export class HuaweiSwitchShell implements ISwitchShell {
  private mode: VRPSwitchMode = 'user';
  private selectedInterface: string | null = null;
  private selectedVlan: number | null = null;

  /** Command-owned interactive flows (IoC) — see HuaweiInteractionPlans. */
  interactionPlanFor(commandLine: string): CommandInteractionPlan | null {
    return huaweiInteractionPlanFor(commandLine);
  }

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private systemTrie = new CommandTrie();
  private interfaceTrie = new CommandTrie();
  private vlanTrie = new CommandTrie();
  private mstRegionTrie = new CommandTrie();
  private portGroupTrie = new CommandTrie();
  private aaaTrie = new CommandTrie();
  private userIfTrie = new CommandTrie();
  private aclTrie = new CommandTrie();
  private mqcClassifierTrie = new CommandTrie();
  private mqcBehaviorTrie = new CommandTrie();
  private mqcPolicyTrie = new CommandTrie();
  private selectedMqcName: string | null = null;
  private dhcpPoolTrie = new CommandTrie();
  private selectedPool: string | null = null;
  private uiLabel = '';
  private selectedUiRange: { first: number; last: number } | null = null;
  private selectedAcl: string | null = null;
  /**
   * Le type de la vue ACL ouverte. C'est un etat de VUE, au meme titre
   * que `selectedVlan` : l'invite se rend hors execution de commande, ou
   * le shell n'a pas de reference vers l'equipement et ne peut donc pas
   * interroger le moteur. Les REGLES, elles, ne vivent que dans le moteur.
   */
  private selectedAclType: 'basic' | 'adv' = 'basic';
  private localUsers = new Map<string, import('./huawei/HuaweiCommonSecurity').LocalUser>();

  private swRef: HuaweiSwitchDevice | null = null;

  /** Le magasin unique de l'etat `debugging` de ce switch. */
  private debugService(): HuaweiDebugService | null {
    return this.swRef?.getHuaweiDebugService?.() ?? null;
  }

  private applyToStpAgent(fn: (a: import('@/network/stp/StpAgent').StpAgent) => void): void {
    const ag = this.stpAgent();
    if (ag) fn(ag);
  }

  private stpAgent(): import('@/network/stp/StpAgent').StpAgent | undefined {
    return this.swRef?.getStpAgent?.();
  }

  private applyToLldpAgent(fn: (a: import('@/network/lldp/LldpAgent').LldpAgent) => void): void {
    const ag = this.swRef?.getLldpAgent?.();
    if (ag) fn(ag);
  }

  private applyToDot1xAgent(fn: (a: import('@/network/dot1x/Dot1xAgent').Dot1xAgent) => void): void {
    const ag = this.swRef?.getDot1xAgent?.();
    if (ag) fn(ag);
  }

  private applyToLacpAgent(fn: (a: import('@/network/lacp/LacpAgent').LacpAgent) => void): void {
    const ag = this.swRef?.getLacpAgent?.();
    if (ag) fn(ag);
  }

  private appliquerCadenceTrunk(id: number): void {
    const trunk = this.ethTrunks.get(id);
    if (!trunk) return;
    const rapide = trunk.fastTimeout ?? null;
    this.applyToLacpAgent(a => {
      for (const membre of trunk.members) a.setPortFastRate(membre, rapide);
    });
  }
  private history: string[] = [];

  getCmdHistory(): readonly string[] { return [...this.history]; }

  /** Per-interface STP config lines (rendered verbatim in `display this`). */
  private ifStp = new Map<string, string[]>();

  /** Per-interface physical/security config lines (rendered in `display this`). */
  private ifCfg = new Map<string, { key: string; line: string }[]>();

  private recordIfCfg(line: string, key?: string): string {
    if (!this.selectedInterface) return 'Error: Incomplete command.';
    const settingKey = key ?? line;
    const kept = (this.ifCfg.get(this.selectedInterface) ?? [])
      .filter(entry => entry.key !== settingKey
        && entry.line !== line && !entry.line.startsWith(`${settingKey} `)
        && entry.line !== settingKey);
    kept.push({ key: settingKey, line });
    this.ifCfg.set(this.selectedInterface, kept);
    return '';
  }

  private removeIfCfg(settingKey: string): string {
    if (!this.selectedInterface) return 'Error: Incomplete command.';
    const kept = (this.ifCfg.get(this.selectedInterface) ?? [])
      .filter(entry => entry.key !== settingKey
        && entry.line !== settingKey
        && !entry.line.startsWith(`${settingKey} `));
    this.ifCfg.set(this.selectedInterface, kept);
    return '';
  }

  /** Per-VLAN description (vlan-view `description …`). */
  private vlanDesc = new Map<number, string>();

  private portGroupMembers: string[] = [];
  private portGroupName: string | null = null;

  /** Eth-Trunk (link-aggregation) groups, keyed by trunk id. */
  private ethTrunks = new Map<number, {
    mode: string; loadBalance: string; members: string[]; cfg: string[];
    fastTimeout?: boolean;
  }>();
  private readonly trunksInitialises = new Set<number>();

  constructor() {
    this.buildUserCommands();
    this.buildSystemCommands();
    this.buildInterfaceCommands();
    this.buildVlanCommands();
    this.buildMstRegionCommands();
    this.buildPortGroupCommands();
    this.buildAaaCommands();
    this.buildUserInterfaceCommands();
    this.buildAclCommands();
    this.buildDhcpCommands();
    this.wireHuaweiNAT();
    this.buildPortMirroringCommands();
    // Apres TOUS les enregistrements, et sur le commutateur AUSSI : ce
    // module ne creait aucun noeud, il decrit les arguments et l'arite
    // de noeuds existants, donc un chemin que le commutateur n'a pas
    // est un no-op silencieux. Ne l'appeler que depuis le routeur
    // laissait les deux machines se contredire sur les memes commandes.
    describeHuaweiArguments({
      system: this.systemTrie,
      iface: this.interfaceTrie,
      ospf: new CommandTrie(),
      vty: this.userIfTrie,
      user: this.userTrie,
    });
  }

  private natContext(): HuaweiShellContext {
    return {
      r: () => commeRouteur(this.swRef),
      setMode: () => { /* switch NAT does not enter dedicated submodes */ },
      getSelectedInterface: () => this.selectedInterface,
      setSelectedInterface: (i) => { this.selectedInterface = i; },
      getSelectedPool: () => null,
      setSelectedPool: () => { /* unused on switch */ },
    };
  }

  /** Context handed to the shared Huawei DHCP pool builder. */
  private dhcpContext(): HuaweiShellContext {
    return {
      r: () => commeRouteur(this.swRef),
      setMode: (m) => { this.entrerVue(m); },
      getSelectedInterface: () => this.selectedInterface,
      setSelectedInterface: (i) => { this.selectedInterface = i; },
      getSelectedPool: () => this.selectedPool,
      setSelectedPool: (n) => { this.selectedPool = n; },
    };
  }

  /** Vlanif interfaces with `dhcp select global` recorded — for display this. */
  private readonly dhcpSelectGlobalIfaces: Set<string> = new Set();
  /** Vlanif interfaces in DHCP relay mode (`dhcp select relay`). */
  private readonly dhcpSelectRelayIfaces: Set<string> = new Set();

  private buildDhcpCommands(): void {
    // `ip pool <name>` enters the DHCP pool view.
    this.systemTrie.describeArgs('ip pool', [wordArg('DHCP address pool name', 'pool-name')]);
    this.systemTrie.registerGreedy('ip pool', 'Enter DHCP pool view', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      const dhcp = this.swRef._getDHCPServerInternal();
      if (!dhcp.getPool(args[0])) dhcp.createPool(args[0]);
      this.selectedPool = args[0];
      this.mode = 'dhcp-pool';
      return '';
    });
    this.systemTrie.registerGreedy('undo ip pool', 'Delete a DHCP pool', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      this.swRef._getDHCPServerInternal().deletePool(args[0]);
      return '';
    });
    this.systemTrie.registerGreedy('dhcp server forbidden-ip',
      'Exclude IP range from DHCP allocation', (args) => {
        if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
        this.swRef._getDHCPServerInternal().addExcludedRange(args[0], args[1] || args[0]);
        return '';
      });

    // Inside Vlanif view: `dhcp select global` marks the SVI as a
    // recipient interface for the global DHCP pool. Recorded for
    // `display this`; the server itself is interface-agnostic.
    this.interfaceTrie.register('dhcp select global',
      'Use the global DHCP pool on this interface', () => {
        if (!this.selectedInterface) return 'Error: Incomplete command.';
        this.dhcpSelectGlobalIfaces.add(this.selectedInterface);
        return '';
      });
    this.interfaceTrie.register('undo dhcp select global',
      'Stop serving DHCP from the global pool on this interface', () => {
        if (!this.selectedInterface) return '';
        this.dhcpSelectGlobalIfaces.delete(this.selectedInterface);
        return '';
      });

    // DHCP relay (Vlanif-only). Real VRP needs both `dhcp select relay`
    // (mark the SVI as relay mode) and `dhcp relay server-ip X` (the
    // upstream target). Either alone configures nothing useful.
    this.interfaceTrie.register('dhcp select relay',
      'Set this SVI to DHCP relay mode', () => {
        if (!this.selectedInterface) return 'Error: Incomplete command.';
        this.dhcpSelectRelayIfaces.add(this.selectedInterface);
        return '';
      });
    this.interfaceTrie.register('undo dhcp select relay',
      'Stop DHCP relay on this SVI', () => {
        if (!this.selectedInterface) return '';
        this.dhcpSelectRelayIfaces.delete(this.selectedInterface);
        return '';
      });
    this.interfaceTrie.registerGreedy('dhcp relay server-ip',
      'Add a DHCP relay target on this SVI', (args) => {
        const m = (this.selectedInterface ?? '').match(/^Vlanif(\d+)$/);
        if (!m || args.length < 1) return 'Error: Incomplete command.';
        try {
          new IPAddress(args[0]);
        } catch {
          return `Error: Invalid IP address ${args[0]}.`;
        }
        if (!this.swRef) return '';
        this.swRef.addSviHelperAddress(parseInt(m[1], 10), args[0]);
        return '';
      });
    this.interfaceTrie.registerGreedy('undo dhcp relay server-ip',
      'Remove a DHCP relay target', (args) => {
        const m = (this.selectedInterface ?? '').match(/^Vlanif(\d+)$/);
        if (!m || args.length < 1 || !this.swRef) return '';
        this.swRef.removeSviHelperAddress(parseInt(m[1], 10), args[0]);
        return '';
      });

    // VRRP on SVI — Huawei VRP grammar. In Vlanif view:
    //   vrrp vrid <n> virtual-ip <ip>
    //   vrrp vrid <n> priority <p>
    //   vrrp vrid <n> preempt-mode timer delay <sec>   (recorded)
    // A group without a virtual-ip is registered but stays silent —
    // matching real VRP that reports it as "invalid" in `display vrrp`.
    // Lot V15 : la grammaire est celle du routeur, et reciproquement —
    // c'est le meme analyseur. Ce qui restait ici de particulier etait
    // le silence sur `description`, `authentication-mode` et le delai de
    // `preempt-mode`, acceptes et perdus.
    this.interfaceTrie.registerGreedy('vrrp vrid', 'VRRP group config', (args, raw) => {
      const m = (this.selectedInterface ?? '').match(/^Vlanif(\d+)$/);
      if (!m || !this.swRef) return "Error: VRRP is valid on Vlanif interfaces only.";
      const ligne = raw ?? `vrrp vrid ${args.join(' ')}`;
      const a = analyserVrrp(['vrid', ...args]);
      if (a.statut === 'refus') return rendreErreurVrp(a.err, ligne);
      appliquerVrrp(this.swRef.getVrrpAgent(), this.selectedInterface!, a.vrid, a.action,
        (nom) => this.resolveInterfaceName(nom) ?? nom);
      return '';
    });
    this.interfaceTrie.registerGreedy('undo vrrp vrid', 'Remove a VRRP group', (args) => {
      const m = (this.selectedInterface ?? '').match(/^Vlanif(\d+)$/);
      if (!m || !this.swRef) return '';
      const a = analyserVrrp(['vrid', ...args]);
      if (a.statut === 'refus') return '';
      const agent = this.swRef.getVrrpAgent();
      if (a.action.quoi === 'groupe') agent.removeGroup(this.selectedInterface!, a.vrid);
      else if (a.action.quoi === 'preempt-mode') agent.setPreempt(this.selectedInterface!, a.vrid, false);
      else if (a.action.quoi === 'track') {
        agent.removeTrack(this.selectedInterface!, a.vrid,
          this.resolveInterfaceName(a.action.cible) ?? a.action.cible);
      }
      return '';
    });

    // Pool view trie — reuse the shared Huawei pool command set so the
    // L3 switch supports the exact same `network/gateway-list/dns-list
    // /lease/excluded-ip-address/domain-name/option …` vocabulary as
    // the router (DRY).
    buildDhcpPoolCommands(this.dhcpPoolTrie, this.dhcpContext());

    this.dhcpPoolTrie.register('display this', 'Display active pool configuration', () => {
      if (!this.swRef || !this.selectedPool) return '';
      const pool = this.swRef._getDHCPServerInternal().getPool(this.selectedPool);
      if (!pool) return '';
      const lines: string[] = [`ip pool ${pool.name}`];
      if (pool.network && pool.mask) lines.push(` network ${pool.network} mask ${pool.mask}`);
      if (pool.defaultRouter) lines.push(` gateway-list ${pool.defaultRouter}`);
      if (pool.dnsServers.length > 0) lines.push(` dns-list ${pool.dnsServers.join(' ')}`);
      if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
      const days = Math.floor(pool.leaseDuration / 86400);
      if (days > 0 && pool.leaseDuration === days * 86400) lines.push(` lease day ${days}`);
      lines.push('#');
      return lines.join('\n');
    });
  }

  private wireHuaweiNAT(): void {
    const ctx = this.natContext();
    const getRouter = () => commeRouteur(this.swRef);
    registerHuaweiNATSystemCommands(this.systemTrie, ctx);
    registerHuaweiNATInterfaceCommands(this.interfaceTrie, ctx);
    registerHuaweiNATDisplayCommands(this.userTrie, getRouter);
    registerHuaweiNATDisplayCommands(this.systemTrie, getRouter);
    registerHuaweiNATDisplayCommands(this.interfaceTrie, getRouter);
  }

  getMode(): VRPSwitchMode { return this.mode; }

  resetCliMode(): void {
    this.mode = 'user';
    this.selectedInterface = null;
    this.selectedVlan = null;
    this.selectedAcl = null;
    this.selectedPool = null;
    this.selectedMqcName = null;
    this.portGroupMembers = [];
  }

  // ─── Per-vty state snapshot / swap (mirrors HuaweiVRPShell — the switch
  // shell is likewise a single instance shared by every open terminal) ──

  snapshotVtyState(): import('./vty/CliShellSession').VtySnapshot {
    return {
      mode: this.mode,
      selectedInterface: this.selectedInterface,
      selectedInterfaceRange: [],
      selectedVlan: this.selectedVlan,
      // VRP n'a pas les CLI Views d'IOS, et son shell ne porte pas
      // d'identite de session : les deux champs du contrat sont donc
      // renseignes pour ce qu'ils sont ici — absents — plutot que
      // laisses indefinis.
      activeParserView: null,
      sessionUser: null,
      selectedArpAcl: null,
      selectedAccessMap: null,
      selectedMqcName: this.selectedMqcName,
      selectedPortGroup: this.portGroupMembers,
      selectedRoutingProto: null,
      selectedTrack: null,
      selectedIpSla: null,
      selectedRouteMap: null,
      selectedDHCPPool: this.selectedPool,
      selectedACL: this.selectedAcl,
      selectedACLType: null,
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
      terminalLength: 24,
      terminalWidth: 80,
      terminalMonitor: false,
      terminalDebugging: false,
      privilegeLevel: this.mode === 'user' ? 1 : 15,
      historySize: 10,
      cmdHistory: [...this.history],
    };
  }

  applyVtyState(s: import('./vty/CliShellSession').VtySnapshot): void {
    // Une session restauree porte la vue sous forme de chaine : la
    // meme garde que pour les aides partagees, sinon une session
    // corrompue rendrait le shell muet au lieu de le ramener en vue
    // utilisateur.
    this.mode = 'user';
    this.entrerVue(s.mode);
    this.selectedInterface = s.selectedInterface;
    this.selectedVlan = s.selectedVlan;
    this.selectedMqcName = s.selectedMqcName;
    this.portGroupMembers = Array.isArray(s.selectedPortGroup) ? [...s.selectedPortGroup] : [];
    this.selectedPool = s.selectedDHCPPool;
    this.selectedAcl = s.selectedACL;
    this.history = [...s.cmdHistory];
  }

  private socleInstance: VrpSocle | null = null;

  private socle(): VrpSocle {
    if (!this.socleInstance) {
      this.socleInstance = new VrpSocle(
        () => this.swRef?.getHostname() ?? 'Switch', this,
        () => [...vrpMtuFamily(), ...vrpClockFamily()], VRP_SWITCH_MODES);
    }
    return this.socleInstance;
  }

  vrpSelectedInterface(): string | null { return this.selectedInterface ?? null; }

  vrpSetInterfaceMtu(iface: string, mtu: number): string {
    const port = this.swRef?.getPort(iface);
    if (!port) return 'Error: No interface selected';
    try { port.setMTU(mtu); } catch (e) { return `Error: ${(e as Error).message}`; }
    return '';
  }

  vrpSetInterfaceBandwidth(iface: string, kbps: number): string {
    this.swRef?.getPort(iface)?.setBandwidthKbps(kbps);
    return '';
  }

  vrpSetTimezone(nom: string, minutes: number): string {
    const clock = this.swRef?.getManagementService?.().getClock();
    if (clock) { clock.timezone = nom; clock.offsetMin = minutes; }
    return '';
  }

  vrpClearTimezone(): string {
    const clock = this.swRef?.getManagementService?.().getClock();
    if (clock) { clock.timezone = VRP_TIMEZONE_DEFAUT; clock.offsetMin = 0; }
    return '';
  }

  getPrompt(sw: Switch): string {
    const host = sw.getHostname();
    switch (this.mode) {
      case 'user':      return `<${host}>`;
      case 'system':    return `[${host}]`;
      case 'interface': return `[${host}-${this.selectedInterface}]`;
      case 'vlan':      return `[${host}-vlan${this.selectedVlan}]`;
      case 'mst-region': return `[${host}-mst-region]`;
      case 'port-group':
        return this.portGroupName === null
          ? `[${host}-port-group]`
          : `[${host}-port-group-${this.portGroupName}]`;
      case 'aaa':       return `[${host}-aaa]`;
      case 'user-interface': return `[${host}-ui-${this.uiLabel}]`;
      case 'acl':
        return `[${host}-acl-${this.aclTypeCourant()}-${this.selectedAcl ?? ''}]`;
      case 'dhcp-pool': return `[${host}-ip-pool-${this.selectedPool ?? ''}]`;
      case 'traffic-classifier': return `[${host}-classifier-${this.selectedMqcName ?? ''}]`;
      case 'traffic-behavior':   return `[${host}-behavior-${this.selectedMqcName ?? ''}]`;
      case 'traffic-policy':     return `[${host}-trafficpolicy-${this.selectedMqcName ?? ''}]`;
      default:          return `<${host}>`;
    }
  }

  // ─── Main Execute ─────────────────────────────────────────────────

  execute(sw: Switch, input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return '';
    // VRP comment/separator lines: `#` is a silent no-op in every view
    // (config-file section separator) — pasting a config must not error.
    if (trimmed.startsWith('#')) return '';
    if (!trimmed.endsWith('?')) this.history.push(trimmed);

    // Handle ? for help
    if (trimmed.endsWith('?')) {
      this.swRef = sw;
      const helpInput = trimmed.slice(0, -1);
      const result = this.getHelp(helpInput);
      this.swRef = null;
      return result;
    }

    // Split off an output pipe filter (| include/exclude/begin …) — shared
    // with the router shell + Cisco shells via cli-utils (DRY).
    const { cmd, filter } = parsePipeFilter(trimmed);
    const lower = cmd.toLowerCase();

    // Global navigation (all modes). Accepts unambiguous VRP
    // abbreviations: q/qu/qui→quit, ret/retu…→return.
    const nav = resolveHuaweiNav(lower);
    if (nav === 'return') {
      this.mode = 'user';
      this.selectedInterface = null;
      this.selectedVlan = null;
      this.portGroupMembers = [];
      this.portGroupName = null;
      return '';
    }
    if (nav === 'quit') return this.cmdQuit();

    // Bind switch reference for command closures
    this.swRef = sw;

    const refus = this.socle().refusalBeforeTrie(cmd, this.mode);
    if (refus !== null) {
      this.swRef = null;
      return refus;
    }
    const migre = this.socle().run(cmd, this.mode);
    if (migre !== null) {
      this.swRef = null;
      return filter && !migre.startsWith('Error:') ? applyPipeFilter(migre, filter) : migre;
    }

    // Get the trie for current mode
    const trie = this.getActiveTrie();
    const result = trie.match(cmd);

    if (this.mode === 'port-group' && result.status !== 'ok') {
      this.swRef = null;
      const relaye = this.executerSurMembres(sw, cmd);
      return filter && !relaye.startsWith('Error:')
        ? applyPipeFilter(relaye, filter) : relaye;
    }

    let output: string;
    switch (result.status) {
      case 'ok': {
        const trop = tropDeParametres(result, cmd);
        output = trop ?? (result.node?.action
          ? normaliserErreurVrp(result.node.action(result.args, cmd), cmd, result.matchedKeywords.length)
          : '');
        break;
      }

      case 'ambiguous':
        // Not `result.error` — CommandTrie's own `.error` is pre-formatted
        // with Cisco's "%" wording (shared trie code); VRP has its own
        // "Error: ... found at '^' position." convention with a caret line.
        output = HUAWEI_ERRORS.AMBIGUOUS(cmd, result.errorPos);
        break;

      case 'incomplete':
        output = HUAWEI_ERRORS.INCOMPLETE(cmd, result.errorPos);
        break;

      case 'invalid':
        output = this.socle().diagnostic(cmd, this.mode)
          ?? HUAWEI_ERRORS.UNRECOGNIZED(cmd, result.errorPos);
        break;

      default:
        output = HUAWEI_ERRORS.UNRECOGNIZED(cmd);
    }

    this.swRef = null;
    // Apply the pipe filter only to successful output (errors pass through).
    return filter && !output.startsWith('Error:')
      ? applyPipeFilter(output, filter)
      : output;
  }

  // ─── Help / Completion ────────────────────────────────────────────

  getHelp(input: string, sw?: Switch): string {
    const trie = this.getActiveTrie();
    trie.setDynamicResolver(sw ? new EquipmentParamResolver(sw) : null);
    try {
      const duTrie = trie.getCompletions(input);
      const duSocle = this.socle().suggestions(input, this.mode, 'QUESTION_MARK')
        .filter(s => !duTrie.some(c => c.keyword === s.keyword));
      const completions = withVrpCommonHelp(this.vrpView(), input, [...duTrie, ...duSocle]);
      if (completions.length === 0) return 'Error: Unrecognized command';
      const maxKw = Math.max(...completions.map(c => c.keyword.length));
      return completions
        // Une description vide ne se rembourre pas : `<cr>` laissait
        // sinon la largeur de la colonne en blancs de fin de ligne.
        .map(c => (c.description
          ? `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`
          : `  ${c.keyword}`))
        .join('\n');
    } finally {
      trie.setDynamicResolver(null);
    }
  }

  tabComplete(input: string): string | null {
    const trie = this.getActiveTrie();
    return trie.tabComplete(input);
  }

  tabCandidates(input: string, sw: Switch): string[] {
    const trie = this.getActiveTrie();
    trie.setDynamicResolver(new EquipmentParamResolver(sw));
    try {
      return withVrpCommonCandidates(this.vrpView(), input, trie.tabCandidates(input));
    } finally {
      trie.setDynamicResolver(null);
    }
  }

  /**
   * La vue utilisateur n'a rien à remonter : `return` n'y est pas
   * proposé, comme sur un vrai VRP.
   */
  private vrpView(): VrpViewKind {
    return this.mode === 'user' ? 'user' : 'other';
  }

  // ─── FSM Transitions ─────────────────────────────────────────────

  private cmdQuit(): string {
    switch (this.mode) {
      case 'interface':
        this.mode = 'system';
        this.selectedInterface = null;
        return '';
      case 'vlan':
        this.mode = 'system';
        this.selectedVlan = null;
        return '';
      case 'mst-region':
        this.mode = 'system';
        return '';
      case 'port-group':
        this.mode = 'system';
        this.portGroupMembers = [];
        this.portGroupName = null;
        return '';
      case 'aaa':
      case 'user-interface':
        this.mode = 'system';
        return '';
      case 'acl':
        this.mode = 'system';
        this.selectedAcl = null;
        return '';
      case 'dhcp-pool':
        this.mode = 'system';
        this.selectedPool = null;
        return '';
      case 'traffic-classifier':
      case 'traffic-behavior':
      case 'traffic-policy':
        this.mode = 'system';
        this.selectedMqcName = null;
        return '';
      case 'system':
        this.mode = 'user';
        return '';
      case 'user':
        return '';
      default:
        return '';
    }
  }

  /**
   * Les aides partagees sont ecrites pour le routeur et connaissent des
   * vues que le switch n'a pas. `this.mode = m as VRPSwitchMode`
   * ANNULAIT l'union : une vue inconnue passait, `getActiveTrie()`
   * retombait sur `default` et le shell devenait muet sans un mot.
   * Une vue que cette plateforme n'a pas ne change donc plus la vue
   * courante.
   */
  private entrerVue(m: unknown): void {
    if (typeof m === 'string' && (VUES_SWITCH as readonly string[]).includes(m)) {
      this.mode = m as VRPSwitchMode;
    }
  }

  private getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user':      return this.userTrie;
      case 'system':    return this.systemTrie;
      case 'interface': return this.interfaceTrie;
      case 'vlan':      return this.vlanTrie;
      case 'mst-region': return this.mstRegionTrie;
      case 'port-group': return this.portGroupTrie;
      case 'aaa':       return this.aaaTrie;
      case 'user-interface': return this.userIfTrie;
      case 'acl':       return this.aclTrie;
      case 'dhcp-pool': return this.dhcpPoolTrie;
      case 'traffic-classifier': return this.mqcClassifierTrie;
      case 'traffic-behavior':   return this.mqcBehaviorTrie;
      case 'traffic-policy':     return this.mqcPolicyTrie;
      default:          return this.userTrie;
    }
  }

  // ─── Command Tree: User View (<hostname>) ─────────────────────────

  private buildUserCommands(): void {
    // system-view → enter system view
    this.userTrie.register('system-view', 'Enter system view', () => {
      this.mode = 'system';
      return 'Enter system view, return user view with return command.';
    });

    // display + common management commands
    this.registerDisplayCommands(this.userTrie);
    this.registerCommonMgmt(this.userTrie);
  }

  // ─── Command Tree: System View ([hostname]) ───────────────────────

  private buildSystemCommands(): void {
    // `system-view` from system view is an idempotent no-op (robustness:
    // re-issuing it must not error mid-sequence).
    this.systemTrie.register('system-view', 'Already in system view', () => '');

    // display + common management commands (available in system view too)
    this.registerDisplayCommands(this.systemTrie);
    this.registerCommonMgmt(this.systemTrie);
    this.registerStpSystemCommands(this.systemTrie);

    this.systemTrie.register('lldp enable', 'Enable LLDP globally', () => {
      this.applyToLldpAgent(a => a.setEnabled(true));
      return '';
    });
    this.systemTrie.register('undo lldp enable', 'Disable LLDP globally', () => {
      this.applyToLldpAgent(a => a.setEnabled(false));
      return '';
    });
    this.systemTrie.register('dot1x enable', 'Enable 802.1X globally', () => {
      this.applyToDot1xAgent(a => a.setSystemAuthControl(true));
      return '';
    });
    this.systemTrie.register('undo dot1x enable', 'Disable 802.1X globally', () => {
      this.applyToDot1xAgent(a => a.setSystemAuthControl(false));
      return '';
    });
    this.systemTrie.registerGreedy('lldp message-transmission interval', 'Hello period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 5 || n > 32768) return 'Error: Wrong parameter found.';
      this.applyToLldpAgent(a => a.setTimerSec(n));
      return '';
    });
    this.systemTrie.registerGreedy('lldp message-transmission hold-multiplier', 'Hold multiplier', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 2 || n > 10) return 'Error: Wrong parameter found.';
      this.applyToLldpAgent(a => a.setHoldtimeMultiplier(n));
      return '';
    });

    // sysname <name>
    this.systemTrie.registerGreedy('sysname', 'Set system hostname', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      this.swRef._setHostnameInternal(args[0]);
      return '';
    });
    this.systemTrie.allowArgs('sysname', 1);

    // vlan <id> or vlan batch <id> <id> ...
    this.systemTrie.describeArgs('vlan', [{
      name: 'vlan-id', type: 'INT', description: 'VLAN ID', range: [1, 4094],
    }]);
    this.systemTrie.addCompletionKeywords('vlan', [
      { keyword: 'batch', description: 'Create several VLANs at once' },
    ]);
    this.systemTrie.registerGreedy('vlan', 'VLAN configuration', (args, ligne) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';

      // `vlan batch` prend une liste, `vlan <id>` prend UN identifiant :
      // le second mot etait jete, `vlan 10 zzz` entrait en vue VLAN
      // sans un mot.
      if (args[0].toLowerCase() !== 'batch' && args.length > 1) {
        return refuseMotInattenduVrp(ligne ?? `vlan ${args.join(' ')}`, args[1]);
      }

      // vlan batch <id> <id> ...
      if (args[0].toLowerCase() === 'batch') {
        for (let i = 1; i < args.length; i++) {
          const id = parseInt(args[i], 10);
          if (!isNaN(id) && id >= 1 && id <= 4094) {
            this.swRef.createVLAN(id);
          }
        }
        return 'Info: This operation may take a few seconds. Please wait for a moment...done.';
      }

      // vlan <id> → enter VLAN config mode
      const id = parseInt(args[0], 10);
      if (isNaN(id) || id < 1 || id > 4094) return 'Error: Wrong parameter found.';
      if (!this.swRef.getVLAN(id)) this.swRef.createVLAN(id);
      this.selectedVlan = id;
      this.mode = 'vlan';
      return '';
    });

    // voice-vlan mac-address <mac> mask <mask> [description <text>]
    this.systemTrie.registerGreedy('voice-vlan mac-address', 'Add a recognized voice VLAN OUI entry', (args) => {
      if (!this.swRef || args.length < 3 || args[1].toLowerCase() !== 'mask') {
        return 'Error: Incomplete command.';
      }
      const macHex = args[0].replace(/[^0-9a-fA-F]/g, '').toLowerCase().padStart(12, '0').slice(0, 12);
      const maskHex = args[2].replace(/[^0-9a-fA-F]/g, '').toLowerCase().padStart(12, '0').slice(0, 12);
      const description = args[3]?.toLowerCase() === 'description' ? args.slice(4).join(' ') : undefined;
      this.swRef?.addVoiceVlanOui?.(macHex, maskHex, description);
      return '';
    });
    // Le gestionnaire exige `<mac> mask <mask>` : l'aide annoncait
    // pourtant `WORD` et un `<cr>` que la commande refuse ensuite.
    this.systemTrie.describeArgs('voice-vlan mac-address', [
      { name: 'oui', type: 'MAC_ADDR', description: 'OUI address, in H-H-H format' },
    ]);
    this.systemTrie.addCompletionKeywords('voice-vlan mac-address', [
      { keyword: 'mask', description: 'Mask of the OUI address' },
    ]);
    this.systemTrie.requireArgs('voice-vlan mac-address', 3);

    // undo <subcommand>
    this.systemTrie.registerGreedy('undo', 'Undo configuration', (args, raw) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      return refuseUnknownUndo(this.systemTrie, args, raw) ?? this.cmdUndo(args);
    });

    this.systemTrie.registerGreedy('port-group', 'Enter port-group view', (args, ligne) => {
      const sw = this.swRef;
      const brut = ligne ?? `port-group ${args.join(' ')}`;
      if (!sw || args.length === 0) return HUAWEI_ERRORS.INCOMPLETE(brut);
      if (args[0].toLowerCase() === 'group-member') {
        const membres = this.resoudrePlage(args.slice(1), brut);
        if (typeof membres === 'string') return membres;
        this.portGroupMembers = membres;
        this.portGroupName = null;
        this.mode = 'port-group';
        return '';
      }
      if (args.length > 1) return refuseMotInattenduVrp(brut, args[1]);
      const nom = args[0];
      if (sw.getPortGroupMembers?.(nom) === null && sw.createPortGroup?.(nom) === false) {
        return `Error: The number of port-groups reaches the upper limit.`;
      }
      this.portGroupName = nom;
      this.portGroupMembers = sw.getPortGroupMembers?.(nom) ?? [];
      this.mode = 'port-group';
      return '';
    });
    this.systemTrie.addCompletionKeywords('port-group', [
      { keyword: 'group-member', description: 'Temporary port group built from a member range' },
    ]);
    this.systemTrie.registerGreedy('undo port-group', 'Delete a permanent port group', (args, ligne) => {
      const sw = this.swRef;
      const brut = ligne ?? `undo port-group ${args.join(' ')}`;
      if (!sw || args.length === 0) return HUAWEI_ERRORS.INCOMPLETE(brut);
      return sw.deletePortGroup?.(args[0])
        ? '' : `Error: The port-group ${args[0]} does not exist.`;
    });

    // aaa → AAA view
    this.systemTrie.register('aaa', 'Enter AAA view', () => {
      this.mode = 'aaa';
      return '';
    });

    // acl {<number> | name <name> [number] | number <number>} → ACL view
    this.systemTrie.registerGreedy('acl', 'Configure an ACL', (args, ligne) => {
      // Meme grammaire que le routeur : sans elle, `acl 42` ouvrait une
      // vue pour un numero qui n'existe pas et `acl abc` une vue nommee
      // `NaN`, sur la meme branche que le routeur qui les refusait.
      const a = analyserAcl(args);
      if (a.statut === 'refus') return rendreErreurVrp(a.err, ligne ?? `acl ${args.join(' ')}`);
      const key = a.cmd.kind === 'nom' ? a.cmd.nom : String(a.cmd.numero);
      // La liste nait dans le MOTEUR, seul magasin. Elle naissait dans une
      // table de texte tenue a cote, d'ou toutes les divergences.
      const engine = this.swRef?.getVaclEngine();
      if (engine) {
        if (a.cmd.kind === 'nom') {
          engine.ensureNamedAccessList(a.cmd.nom, a.cmd.type === 'advanced' ? 'extended' : 'standard');
        } else {
          engine.ensureAccessList(a.cmd.numero);
        }
      }
      this.selectedAcl = key;
      this.selectedAclType = a.cmd.type === 'advanced' ? 'adv' : 'basic';
      this.mode = 'acl';
      return '';
    });
    // `name` naissait en chemin avec son propre mot pour description
    // (« name  Name »), qui est vrai et n'apprend rien ; `basic` et
    // `advanced` étaient extraits du texte du handler sans description
    // du tout. Les curater règle les deux.
    this.systemTrie.addCompletionKeywords('acl', [
      { keyword: 'advanced', description: 'Advanced ACL (3000-3999)' },
      { keyword: 'basic', description: 'Basic ACL (2000-2999)' },
      { keyword: 'name', description: 'Named ACL' },
      { keyword: 'number', description: 'ACL number' },
    ]);

    this.systemTrie.registerGreedy('traffic classifier', 'Configure a traffic classifier', (args) => {
      if (!args[0] || !this.swRef) return 'Error: Incomplete command.';
      this.swRef.mqcEnsureClassifier(args[0]);
      this.selectedMqcName = args[0];
      this.mode = 'traffic-classifier';
      return '';
    });
    this.systemTrie.registerGreedy('traffic behavior', 'Configure a traffic behavior', (args) => {
      if (!args[0] || !this.swRef) return 'Error: Incomplete command.';
      this.swRef.mqcEnsureBehavior(args[0]);
      this.selectedMqcName = args[0];
      this.mode = 'traffic-behavior';
      return '';
    });
    this.systemTrie.registerGreedy('traffic policy', 'Configure a traffic policy', (args) => {
      if (!args[0] || !this.swRef) return 'Error: Incomplete command.';
      this.swRef.mqcEnsurePolicy(args[0]);
      this.selectedMqcName = args[0];
      this.mode = 'traffic-policy';
      return '';
    });

    this.mqcClassifierTrie.registerGreedy('if-match acl', 'Match an ACL', (args) => {
      if (!args[0] || !this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      const res = this.swRef.mqcClassifierAddMatch(this.selectedMqcName, { kind: 'acl', ref: args[0] });
      return res.ok ? '' : `Error: ${res.error}.`;
    });
    this.mqcClassifierTrie.registerGreedy('if-match vlan-id', 'Match a VLAN identifier', (args) => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      const vlan = parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(vlan) || vlan < 1 || vlan > 4094) return 'Error: Wrong parameter found.';
      const res = this.swRef.mqcClassifierAddMatch(this.selectedMqcName, { kind: 'vlan-id', vlan });
      return res.ok ? '' : `Error: ${res.error}.`;
    });
    this.mqcClassifierTrie.register('if-match any', 'Match every packet', () => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      const res = this.swRef.mqcClassifierAddMatch(this.selectedMqcName, { kind: 'any' });
      return res.ok ? '' : `Error: ${res.error}.`;
    });
    this.mqcBehaviorTrie.register('permit', 'Permit matched traffic', () => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      const res = this.swRef.mqcBehaviorSetAction(this.selectedMqcName, 'permit');
      return res.ok ? '' : `Error: ${res.error}.`;
    });
    this.mqcBehaviorTrie.register('deny', 'Deny matched traffic', () => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      const res = this.swRef.mqcBehaviorSetAction(this.selectedMqcName, 'deny');
      return res.ok ? '' : `Error: ${res.error}.`;
    });
    this.mqcBehaviorTrie.registerGreedy('car', 'Rate-limit matched traffic', (args, brut) => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      const raw = brut ?? `car ${args.join(' ')}`.trim();
      const rule = parseMqcCarRule(args, raw, 'input');
      if (!rule) return "Error: Wrong parameter found at '^' position.";
      const res = this.swRef.mqcBehaviorSetCar(this.selectedMqcName, rule);
      return res.ok ? '' : `Error: ${res.error}.`;
    });
    this.mqcBehaviorTrie.register('statistic enable', 'Count matched traffic', () => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      const res = this.swRef.mqcBehaviorSetStatistic(this.selectedMqcName, true);
      return res.ok ? '' : `Error: ${res.error}.`;
    });
    this.mqcBehaviorTrie.register('undo statistic enable', 'Stop counting', () => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      this.swRef.mqcBehaviorSetStatistic(this.selectedMqcName, false);
      return '';
    });
    this.mqcBehaviorTrie.registerGreedy('remark', 'Rewrite a priority field', (args) => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      const champ = (args[0] ?? '').toLowerCase();
      const valeur = (args[1] ?? '').toLowerCase();
      if (champ === 'dscp') {
        const dscp = /^\d+$/.test(valeur)
          ? Number.parseInt(valeur, 10) : DSCP_KEYWORD_TO_VALUE[valeur];
        if (dscp === undefined || !Number.isFinite(dscp) || dscp < 0 || dscp > 63) {
          return "Error: Wrong parameter found at '^' position.";
        }
        const res = this.swRef.mqcBehaviorSetRemark(this.selectedMqcName, { dscp });
        return res.ok ? '' : `Error: ${res.error}.`;
      }
      if (champ === '8021p') {
        const dot1p = Number.parseInt(valeur, 10);
        if (!Number.isFinite(dot1p) || dot1p < 0 || dot1p > 7) {
          return "Error: Wrong parameter found at '^' position.";
        }
        const res = this.swRef.mqcBehaviorSetRemark(this.selectedMqcName, { dot1p });
        return res.ok ? '' : `Error: ${res.error}.`;
      }
      return "Error: Unrecognized command found at '^' position.";
    });
    this.mqcBehaviorTrie.registerGreedy('undo remark', 'Remove the rewrite', () => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      this.swRef.mqcBehaviorClearRemark(this.selectedMqcName);
      return '';
    });
    this.mqcBehaviorTrie.registerGreedy('undo car', 'Remove the rate limit', () => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      this.swRef.mqcBehaviorClearCar(this.selectedMqcName);
      return '';
    });
    this.mqcPolicyTrie.registerGreedy('classifier', 'Bind a classifier to a behavior', (args) => {
      if (!this.selectedMqcName || !this.swRef) return 'Error: Incomplete command.';
      if (!args[0] || args[1]?.toLowerCase() !== 'behavior' || !args[2]) return 'Error: Incomplete command.';
      const res = this.swRef.mqcPolicyBind(this.selectedMqcName, args[0], args[2]);
      return res.ok ? '' : `Error: ${res.error}.`;
    });

    // user-interface {console <n> | vty <first> [last] | maxvty …} → UI view
    this.systemTrie.describeArgs('user-interface', [{
      name: 'type', type: 'ENUM', description: 'User-interface type',
      validator: () => true,
      values: [
        { keyword: 'console', description: 'Primary terminal line' },
        { keyword: 'maxvty', description: 'Maximum number of VTY lines' },
        { keyword: 'vty', description: 'Virtual terminal line' },
      ],
    }, {
      name: 'first-ui-number', type: 'INT',
      description: 'First user-interface number', optional: true, range: [0, 20],
    }, {
      name: 'last-ui-number', type: 'INT',
      description: 'Last user-interface number', optional: true, range: [0, 20],
    }]);
    this.systemTrie.registerGreedy('user-interface', 'Enter user-interface view', (args) => {
      if (args.length === 0) return 'Error: Incomplete command.';
      if (args[0].toLowerCase() === 'maxvty') return ''; // global setting, no view
      const type = args[0].toLowerCase();
      const first = args[1] ?? '0';
      const last = args[2];
      this.uiLabel = `${type}${first}${last ? `-${last}` : ''}`;
      const premier = Number(first);
      this.selectedUiRange = type === 'vty' && Number.isFinite(premier)
        ? { first: premier, last: Number(last ?? first) }
        : null;
      this.mode = 'user-interface';
      return '';
    });

    // Shared management commands (SSH/Telnet/SNMP/NTP/syslog/…) — DRY
    registerHuaweiCommonSecurity(this.systemTrie,
      () => commeRouteur(this.swRef),
      () => this.swRef?.getNtpAgent(),
      () => this.swRef?.getSnmpService());

    this.systemTrie.register('dhcp enable', 'Enable DHCP', () => {
      this.swRef.getSecurityService().setDhcpEnabled(true);
      // Bring the L3 switch's DHCP engine up too so it actually answers
      // discovers — the security-service flag alone never reaches it.
      this.swRef._getDHCPServerInternal().enable();
      return '';
    });
    this.systemTrie.register('undo dhcp enable', 'Disable DHCP', () => {
      this.swRef.getSecurityService().setDhcpEnabled(false);
      this.swRef._getDHCPServerInternal().disable();
      return '';
    });
    this.systemTrie.register('dhcp snooping enable', 'Enable DHCP snooping globally', () => {
      this.swRef.getSecurityService().configureDhcpSnooping(['snooping', 'enable']);
      this.swRef._getDHCPSnoopingConfig().enabled = true;
      return '';
    });
    this.systemTrie.registerGreedy('dhcp snooping enable vlan', 'Enable DHCP snooping on VLANs', (args) => {
      this.swRef.getSecurityService().configureDhcpSnooping(['snooping', 'enable', 'vlan', ...args]);
      const cfg = this.swRef._getDHCPSnoopingConfig();
      for (const a of args) {
        const n = parseInt(a, 10);
        if (!isNaN(n)) cfg.vlans.add(n);
      }
      return '';
    });
    this.systemTrie.register('dhcp snooping check dhcp-chaddr enable', 'Enable DHCP snooping CHADDR verification', () => {
      this.swRef._getDHCPSnoopingConfig().verifyMac = true;
      return '';
    });
    // `dhcp snooping trusted interface <if>` en vue système : VRP
    // l'accepte à côté du `dhcp snooping trusted` de la vue interface, et
    // il était refusé (« Unrecognized command »). Conséquence mesurée :
    // `SwitchSecurityService.dhcpSnoopingTrust` n'était atteignable par
    // AUCUN chemin — un magasin que rien ne pouvait remplir.
    //
    // Les deux orthographes écrivent maintenant dans le magasin qui
    // APPLIQUE (`_getDHCPSnoopingConfig().trustedPorts`, consulté par le
    // plan de données), et pas seulement dans celui qui décrit : une
    // interface déclarée de confiance depuis la vue système doit vraiment
    // laisser passer les réponses DHCP, sinon la commande serait acceptée
    // sans rien faire.
    for (const verbe of ['dhcp snooping trusted interface', 'dhcp snooping trust interface']) {
      this.systemTrie.registerGreedy(verbe, 'Mark an interface as DHCP snooping trusted', (args) => {
        if (!this.swRef || args.length === 0) return 'Error: Incomplete command.';
        const nom = this.resolveInterfaceName(args.join(' '));
        if (!nom) return `Error: Wrong parameter found at '^' position.`;
        this.swRef._getDHCPSnoopingConfig().trustedPorts.add(nom);
        this.swRef.getSecurityService().configureDhcpSnooping(['snooping', 'trust', 'interface', nom]);
        return '';
      });
      this.systemTrie.registerGreedy(`undo ${verbe}`, 'Clear the trusted mark', (args) => {
        if (!this.swRef || args.length === 0) return 'Error: Incomplete command.';
        const nom = this.resolveInterfaceName(args.join(' '));
        if (!nom) return `Error: Wrong parameter found at '^' position.`;
        this.swRef._getDHCPSnoopingConfig().trustedPorts.delete(nom);
        return '';
      });
    }

    this.systemTrie.registerGreedy('dhcp', 'DHCP snooping configuration', (args) => {
      this.swRef.getSecurityService().configureDhcpSnooping(args);
      return '';
    });
    this.systemTrie.registerGreedy('arp anti-attack', 'ARP anti-attack configuration', (args) => {
      this.swRef.getSecurityService().configureArpAntiAttack(args);
      return '';
    });
    this.systemTrie.registerGreedy('ip source', 'IP source guard configuration', (args) => {
      this.swRef.getSecurityService().configureIpSource(args);
      return '';
    });

    // interface <name>  (incl. virtual Eth-Trunk; L3 types stay rejected)
    describeHuaweiInterfaceArg(this.systemTrie);
    this.systemTrie.addCompletionKeywords('interface', [
      { keyword: 'range', description: 'Configure a range of interfaces' },
    ]);
    this.systemTrie.registerGreedy('interface', 'Enter interface view', (args, ligne) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      // Eth-Trunk <id>  /  Eth-TrunkN  → link-aggregation virtual interface
      const joined = args.join(' ');
      const et = joined.match(/^eth-?trunk\s*(\d+)$/i);
      if (et) {
        const id = parseInt(et[1], 10);
        if (!this.ethTrunks.has(id)) {
          this.ethTrunks.set(id, { mode: 'manual', loadBalance: '', members: [], cfg: [] });
        }
        this.selectedInterface = `Eth-Trunk${id}`;
        this.mode = 'interface';
        return '';
      }
      if (args[0].toLowerCase() === 'range') {
        const membres = this.resoudrePlage(args.slice(1), ligne ?? `interface ${args.join(' ')}`);
        if (typeof membres === 'string') return membres;
        this.portGroupMembers = membres;
        this.portGroupName = null;
        this.mode = 'port-group';
        return '';
      }
      const vlanIfMatch = numeroDInterface(args.join(' '), 'Vlanif');
      if (vlanIfMatch !== null) {
        const vlan = vlanIfMatch;
        if (vlan < 1 || vlan > 4094) return `Error: Wrong parameter found at '^' position.`;
        this.swRef.ensureSvi(vlan);
        this.swRef.setSviAdminUp(vlan, true);
        this.selectedInterface = `Vlanif${vlan}`;
        this.mode = 'interface';
        return '';
      }

      const loopMatch = numeroDInterface(args.join(' '), 'LoopBack');
      if (loopMatch !== null) {
        this.selectedInterface = `LoopBack${loopMatch}`;
        // Matérialise l'interface : sans ça, entrer dans la vue ne
        // créait rien et l'interface restait invisible partout.
        this.swRef.ensureLoopback(this.selectedInterface);
        this.mode = 'interface';
        return '';
      }

      const portName = this.resolveInterfaceName(joined);
      if (!portName) return `Error: Wrong parameter found at '^' position.`;
      this.selectedInterface = portName;
      this.mode = 'interface';
      return '';
    });

    this.systemTrie.registerGreedy('mac-address', 'MAC address configuration', (args, ligne) => {
      const sw = this.swRef;
      if (!sw) return HUAWEI_ERRORS.INCOMPLETE(ligne ?? 'mac-address');
      const a = analyserMacAddress(args);
      const brut = ligne ?? `mac-address ${args.join(' ')}`;
      switch (a.statut) {
        case 'aging-time':
          sw.setMACAgingTime(a.secondes);
          return '';
        case 'blackhole':
          sw.addBlackholeMAC(a.mac, a.vlan);
          return '';
        case 'static': {
          const port = this.resolveInterfaceName(a.iface);
          if (!port || !sw.getPort(port)) return refuseMotInattenduVrp(brut, a.iface);
          if (!sw.getVLANs().has(a.vlan)) return `Error: The VLAN ${a.vlan} does not exist.`;
          sw.addStaticMAC(a.mac, a.vlan, port);
          return '';
        }
        default:
          return a.token === null
            ? HUAWEI_ERRORS.INCOMPLETE(brut)
            : refuseMotInattenduVrp(brut, a.token);
      }
    });
    // Les trois sont des ALTERNATIVES a la premiere place, pas des
    // suites : `mac-address blackhole aging-time` n'existe pas, et
    // l'aide le proposait des que l'un des trois etait sur la ligne.
    // Un parametre ENUM dit exactement cela — une place, trois valeurs —
    // la ou une liste de suggestions les rendait a tous les rangs.
    this.systemTrie.describeArgs('mac-address', [
      { name: 'kind', type: 'ENUM', description: 'MAC address entry type',
        validator: () => true,
        values: [
          { keyword: 'aging-time', description: 'Aging time of dynamic MAC address entries' },
          { keyword: 'blackhole', description: 'Blackhole MAC address entry' },
          { keyword: 'static', description: 'Static MAC address entry' },
        ] },
    ]);
    // Aucune des trois formes ne se valide sur son seul selecteur : le
    // mot compte pour un argument, donc l'arite est satisfaite alors
    // qu'il manque la duree ou l'adresse. C'est ce que `executableWhen`
    // existe pour dire, et l'aide annoncait sinon un `<cr>` que la
    // commande refuse.
    this.systemTrie.requireArgs('mac-address', 2);
    this.systemTrie.executableWhen('mac-address',
      (args) => !(args.length === 1 && /^(aging-time|blackhole|static)$/i.test(args[0])));
    this.systemTrie.describeArgs('mac-address aging-time', [
      { name: 'seconds', type: 'INT', description: 'Aging time in seconds',
        range: [0, 1000000] },
    ]);

    this.systemTrie.register('ip routing-enable', 'Enable IP routing', () => {
      this.swRef?.setIpRoutingEnabled(true);
      return '';
    });
    this.systemTrie.registerGreedy('ip route-static', 'Add a static route', (args, ligne) => {
      const sw = this.swRef;
      if (!sw) return 'Error: Incomplete command.';
      try {
        const tete = analyserTeteRouteStatiqueVrp(commeRouteur(sw), args, true);
        if (typeof tete === 'string') return tete;
        if (!tete.nextHop) return 'Error: Incomplete command.';
        const queue = lireQueueRouteStatiqueVrp(args, tete.cursor);
        if (typeof queue === 'string') {
          return queue === QUEUE_PARAMETRE_INVALIDE
            ? 'Error: Wrong parameter.'
            : refuseMotInattenduVrp(ligne ?? `ip route-static ${args.join(' ')}`, queue);
        }
        sw.addStaticRoute(tete.network, tete.mask, tete.nextHop, queue.preference);
        return '';
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    });

    this.systemTrie.registerGreedy('undo ip route-static', 'Remove a static route', (args) => {
      const sw = this.swRef;
      if (!sw) return 'Error: Incomplete command.';
      if (args.length === 0) return 'Error: Incomplete command.';
      if (args[0].toLowerCase() === 'all') {
        if (args.length > 1) {
          return refuseMotInattenduVrp(`undo ip route-static ${args.join(' ')}`, args[1]);
        }
        for (const r of [...sw.getStaticRoutes()]) {
          sw.removeStaticRoute(r.network, r.mask, r.nextHop);
        }
        return '';
      }
      try {
        const tete = analyserTeteRouteStatiqueVrp(commeRouteur(sw), args, false);
        if (typeof tete === 'string') return tete;
        const { network, mask, nextHop } = tete;
        const vise = sw.getStaticRoutes().find((r) =>
          r.network.equals(network) && r.mask.toCIDR() === mask.toCIDR()
          && (nextHop === null || r.nextHop.equals(nextHop)));
        if (!vise) return 'Error: Route not found.';
        sw.removeStaticRoute(vise.network, vise.mask, vise.nextHop);
        return '';
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    });
  }

  // ─── Command Tree: Interface View ([hostname-GigabitEthernet0/0/X]) ──

  private buildInterfaceCommands(): void {
    // display commands
    this.registerDisplayCommands(this.interfaceTrie);
    this.registerStpInterfaceCommands(this.interfaceTrie);

    this.interfaceTrie.register('lldp enable', 'Enable LLDP on this interface', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const port = this.selectedInterface;
      this.applyToLldpAgent(a => { a.setPortTransmit(port, true); a.setPortReceive(port, true); });
      return '';
    });
    this.interfaceTrie.register('undo lldp enable', 'Disable LLDP on this interface', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const port = this.selectedInterface;
      this.applyToLldpAgent(a => { a.setPortTransmit(port, false); a.setPortReceive(port, false); });
      return '';
    });
    this.interfaceTrie.registerGreedy('lldp admin-status', 'LLDP admin status', (args) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const port = this.selectedInterface;
      const m = (args[0] ?? '').toLowerCase();
      this.applyToLldpAgent(a => {
        if (m === 'tx') { a.setPortTransmit(port, true); a.setPortReceive(port, false); }
        else if (m === 'rx') { a.setPortTransmit(port, false); a.setPortReceive(port, true); }
        else if (m === 'txrx') { a.setPortTransmit(port, true); a.setPortReceive(port, true); }
        else if (m === 'disable') { a.setPortTransmit(port, false); a.setPortReceive(port, false); }
      });
      return '';
    });
    this.registerInterfacePhysicalCommands(this.interfaceTrie);

    // shutdown
    this.interfaceTrie.register('shutdown', 'Shut down interface', () => {
      if (!this.swRef || !this.selectedInterface) return '';
      const vlanIfMatch = this.selectedInterface.match(/^Vlanif(\d+)$/);
      if (vlanIfMatch) { this.swRef.setSviAdminUp(parseInt(vlanIfMatch[1], 10), false); return ''; }
      const port = this.swRef.getPort(this.selectedInterface);
      if (port) port.setAdminShutdown(true);
      return '';
    });

    // Generic `undo <…>` fallback (specific undo forms below still win).
    this.interfaceTrie.registerGreedy('undo', 'Undo configuration', (args, raw) =>
      refuseUnknownUndo(this.interfaceTrie, args, raw) ?? this.cmdUndo(args));
    this.vlanTrie.registerGreedy('undo', 'Undo configuration', (args, raw) =>
      refuseUnknownUndo(this.vlanTrie, args, raw) ?? this.cmdUndo(args));

    // undo shutdown
    this.interfaceTrie.register('undo shutdown', 'Bring up interface', () => {
      if (!this.swRef || !this.selectedInterface) return '';
      const vlanIfMatch = this.selectedInterface.match(/^Vlanif(\d+)$/);
      if (vlanIfMatch) { this.swRef.setSviAdminUp(parseInt(vlanIfMatch[1], 10), true); return ''; }
      const port = this.swRef.getPort(this.selectedInterface);
      if (port) port.setAdminShutdown(false);
      return '';
    });

    this.interfaceTrie.registerGreedy('description', 'Set interface description', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      this.swRef.setInterfaceDescription(this.selectedInterface, args.join(' '));
      return '';
    });

    // VRP autorise une adresse sur une LoopBack comme sur un Vlanif —
    // c'est même le procédé normal pour fixer un identifiant de routeur,
    // une adresse qui ne tombe pas avec un port. Le refus précédent
    // (« only valid on Vlanif ») faisait échouer en cascade tout ce qui
    // suivait dans la section (audit 11, §5).
    this.interfaceTrie.registerGreedy('ip address', 'Configure an IP address', (args) => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      const vlanIfMatch = this.selectedInterface.match(/^Vlanif(\d+)$/);
      const loopMatch = this.selectedInterface.match(/^LoopBack(\d+)$/);
      if (!vlanIfMatch && !loopMatch) {
        return `Error: 'ip address' is only valid on Vlanif and LoopBack interfaces.`;
      }
      if (args[0]?.toLowerCase() === 'dhcp-alloc') {
        if (!vlanIfMatch) {
          return `Error: 'ip address dhcp-alloc' is only valid on Vlanif interfaces.`;
        }
        if (args.length > 1) return refuseMotInattenduVrp(`ip address ${args.join(' ')}`, args[1]);
        this.swRef.getDhcpClientAgent().enable(`Vlanif${vlanIfMatch[1]}`, 'ip address dhcp-alloc');
        return '';
      }
      if (args.length < 2) return 'Error: Incomplete command.';
      if (vlanIfMatch) this.swRef.getDhcpClientAgent().disable(`Vlanif${vlanIfMatch[1]}`);
      let ip: IPAddress, mask: SubnetMask;
      try { ip = new IPAddress(args[0]); } catch { return `Error: Invalid IP address ${args[0]}.`; }
      try {
        if (/^\d+$/.test(args[1])) mask = SubnetMask.fromCIDR(parseInt(args[1], 10));
        else mask = new SubnetMask(args[1]);
      } catch { return `Error: Invalid mask ${args[1]}.`; }
      if (loopMatch) {
        this.swRef.ensureLoopback(this.selectedInterface);
        this.swRef.configureLoopbackIp(this.selectedInterface, ip, mask);
        return '';
      }
      const vlan = parseInt(vlanIfMatch![1], 10);
      this.swRef.ensureSvi(vlan);
      this.swRef.configureSviIp(vlan, ip, mask);
      this.swRef.setSviAdminUp(vlan, true);
      return '';
    });

    this.interfaceTrie.register('undo ip address', 'Remove an IP address', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      if (/^LoopBack\d+$/.test(this.selectedInterface)) {
        this.swRef.clearLoopbackIp(this.selectedInterface);
        return '';
      }
      const vlanIfMatch = this.selectedInterface.match(/^Vlanif(\d+)$/);
      if (!vlanIfMatch) return '';
      this.swRef.clearSviIp(parseInt(vlanIfMatch[1], 10));
      return '';
    });

    // port link-type access
    this.interfaceTrie.register('port link-type access', 'Set port to access mode', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      this.swRef.setSwitchportMode(this.selectedInterface, 'access');
      return '';
    });

    // port link-type trunk
    this.interfaceTrie.register('port link-type trunk', 'Set port to trunk mode', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      const wasTrunk = this.swRef.getSwitchportConfig(this.selectedInterface)?.mode === 'trunk';
      this.swRef.setSwitchportMode(this.selectedInterface, 'trunk');
      // Unlike Cisco (trunk default: all VLANs), VRP's default trunk
      // allowed-VLAN list is VLAN 1 only — `port trunk allow-pass vlan`
      // then adds to it. Only reset on an actual access→trunk transition,
      // never on a no-op re-run that would wipe an already-configured list.
      if (!wasTrunk) this.swRef.setTrunkAllowedVlans(this.selectedInterface, new Set([1]));
      return '';
    });

    this.interfaceTrie.register('port link-type hybrid', 'Set port to hybrid mode', () => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Wrong parameter.';
      this.swRef.setHybridMode(this.selectedInterface);
      return '';
    });

    this.interfaceTrie.registerGreedy('port hybrid', 'Configure hybrid port VLANs', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      const sub = args[0]?.toLowerCase();
      if (sub === 'pvid' && args[1]?.toLowerCase() === 'vlan') {
        const id = parseInt(args[2] ?? '', 10);
        if (isNaN(id)) return 'Error: Wrong parameter found.';
        this.swRef.setHybridPvid(this.selectedInterface, id);
        return '';
      }
      if (sub === 'tagged' || sub === 'untagged') {
        if (args[1]?.toLowerCase() !== 'vlan') return 'Error: Wrong parameter found.';
        const ids = this.parseVrpVlanTokens(args.slice(2));
        if (!ids.length) return 'Error: Wrong parameter found.';
        if (sub === 'tagged') this.swRef.addHybridTaggedVlans(this.selectedInterface, ids);
        else this.swRef.addHybridUntaggedVlans(this.selectedInterface, ids);
        return '';
      }
      return '';
    });

    this.interfaceTrie.registerGreedy('port vlan-mapping', 'Interface port vlan-mapping configuration', (args) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      this.recordIfCfg(`port vlan-mapping ${args.join(' ')}`.trim());
      return '';
    });
    // Selective QinQ: `port vlan-mapping vlan <cvlan> map-vlan <svlan>` shadows
    // the decorative catch-all above (CommandTrie prefers the more specific
    // registration) so it can additionally reach the real translation table.
    this.interfaceTrie.registerGreedy('port vlan-mapping vlan', 'Map a client VLAN to a service (S-VLAN)', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      this.recordIfCfg(`port vlan-mapping vlan ${args.join(' ')}`.trim());
      const cvlan = parseInt(args[0] ?? '', 10);
      const svlan = parseInt(args[2] ?? '', 10);
      if (isNaN(cvlan) || args[1]?.toLowerCase() !== 'map-vlan' || isNaN(svlan)) {
        return 'Error: Wrong parameter found at \'^\' position.';
      }
      const cfg = this.swRef.getSwitchportConfig(this.selectedInterface);
      if (cfg) {
        if (!cfg.vlanMapping) cfg.vlanMapping = new Map();
        cfg.vlanMapping.set(cvlan, svlan);
      }
      return '';
    });
    this.interfaceTrie.registerGreedy('bpdu-tunnel', 'Tunnel a client L2 control protocol across the S-VLAN instead of terminating it locally', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      this.recordIfCfg(`bpdu-tunnel ${args.join(' ')}`.trim());
      const proto = (args[0] ?? '').toLowerCase();
      if ((proto !== 'stp' && proto !== 'lldp') || args[1]?.toLowerCase() !== 'enable') {
        return 'Error: Wrong parameter found at \'^\' position.';
      }
      this.swRef.enableL2ProtocolTunnel(this.selectedInterface, proto);
      return '';
    });
    this.registerPortSecurity();
    this.registerDot1x();

    // Interface-view L2 security: DHCP snooping / IP source guard /
    // ARP anti-attack — recorded for `display this` (L2-only: no L3).
    for (const sub of ['dhcp snooping', 'ip source', 'arp anti-attack']) {
      this.interfaceTrie.registerGreedy(sub, `Interface ${sub}`, (args) => {
        if (!this.selectedInterface) return 'Error: Incomplete command.';
        this.recordIfCfg(`${sub} ${args.join(' ')}`.trim());
        return '';
      });
    }
    // The three commands below shadow the generic `dhcp snooping ...`
    // catch-all above (CommandTrie prefers the more specific children) so
    // they can additionally reach the switch's real enforcement config —
    // trust/rate-limit/verify-mac only take effect from there.
    this.interfaceTrie.register('dhcp snooping trusted', 'Mark interface as DHCP snooping trusted', () => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      this.recordIfCfg('dhcp snooping trusted');
      this.swRef._getDHCPSnoopingConfig().trustedPorts.add(this.selectedInterface);
      return '';
    });
    this.interfaceTrie.register('dhcp snooping check dhcp-rate enable', 'Enable DHCP snooping rate check', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      this.recordIfCfg('dhcp snooping check dhcp-rate enable');
      return '';
    });
    this.interfaceTrie.registerGreedy('dhcp snooping check dhcp-rate', 'Set DHCP snooping rate limit (pps)', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      const rate = parseInt(args[0] ?? '', 10);
      if (isNaN(rate) || rate < 1) return 'Error: Wrong parameter found at \'^\' position.';
      this.recordIfCfg(`dhcp snooping check dhcp-rate ${rate}`);
      this.swRef._getDHCPSnoopingConfig().rateLimits.set(this.selectedInterface, rate);
      return '';
    });
    this.interfaceTrie.registerGreedy('qinq', 'Interface qinq configuration', (args) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      this.recordIfCfg(`qinq ${args.join(' ')}`.trim());
      return '';
    });
    this.interfaceTrie.register('qinq enable', '802.1ad QinQ tunnel port (S-VLAN access port)', () => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      this.recordIfCfg('qinq enable');
      this.swRef.setSwitchportMode(this.selectedInterface, 'dot1q-tunnel');
      return '';
    });
    this.interfaceTrie.registerGreedy('voice-vlan', 'Interface voice-vlan configuration', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      this.recordIfCfg(`voice-vlan ${args.join(' ')}`.trim());
      const cfg = this.swRef.getSwitchportConfig(this.selectedInterface);
      if (!cfg) return '';
      if (args[0]?.toLowerCase() === 'mode') {
        cfg.voiceVlanAutoOui = args[1]?.toLowerCase() === 'auto';
        return '';
      }
      const id = parseInt(args[0] ?? '', 10);
      if (!isNaN(id) && args[1]?.toLowerCase() === 'enable') {
        cfg.voiceVlan = id;
      }
      return '';
    });
    // ── 802.1p (PCP) trust boundary — qos trust ────────────────────
    this.interfaceTrie.registerGreedy('qos trust', 'Trust boundary for 802.1p/DSCP classification', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      const kw = (args[0] ?? '').toLowerCase();
      const cfg = this.swRef.getSwitchportConfig(this.selectedInterface);
      if (kw === 'dot1p') { if (cfg) cfg.trustMode = 'cos'; return ''; }
      if (kw === 'dscp') { if (cfg) cfg.trustMode = 'dscp'; return ''; }
      return "Error: Unrecognized parameter found at '^' position.";
    });
    this.interfaceTrie.registerGreedy('port priority', 'Default 802.1p priority applied to untrusted ingress traffic', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 0 || n > 7) return "Error: Wrong parameter found at '^' position.";
      const cfg = this.swRef.getSwitchportConfig(this.selectedInterface);
      if (cfg) cfg.defaultCos = n;
      return '';
    });
    this.interfaceTrie.registerGreedy('trust upstream', 'Trust the CoS already marked by a downstream cascaded device (e.g. an IP phone)', () => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      const cfg = this.swRef.getSwitchportConfig(this.selectedInterface);
      if (cfg) cfg.priorityExtend = { mode: 'trust' };
      return '';
    });

    this.interfaceTrie.registerGreedy('port-isolate', 'Configure port isolation', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      this.recordIfCfg(`port-isolate ${args.join(' ')}`.trim());
      if (args[0]?.toLowerCase() === 'enable') {
        const groupIdx = args.findIndex(a => a.toLowerCase() === 'group');
        const group = groupIdx >= 0 ? parseInt(args[groupIdx + 1] ?? '', 10) : 1;
        this.swRef.setPortIsolateGroup(this.selectedInterface, isNaN(group) ? 1 : group);
      } else if (args[0]?.toLowerCase() === 'disable') {
        this.swRef.clearPortIsolateGroup(this.selectedInterface);
      }
      return '';
    });

    // ── Eth-Trunk (LACP) interface-view commands ──
    const trunkId = (): number | null => {
      const m = (this.selectedInterface ?? '').match(/^Eth-Trunk(\d+)$/);
      return m ? parseInt(m[1], 10) : null;
    };
    // `mode <manual|lacp-static|lacp-dynamic>` (Eth-Trunk only)
    this.interfaceTrie.registerGreedy('mode', 'Set Eth-Trunk working mode', (args) => {
      const id = trunkId();
      if (id === null) return `Error: Unrecognized command "mode ${args.join(' ')}"`;
      const t = this.ethTrunks.get(id)!;
      t.mode = args.join(' ');
      t.cfg.push(`mode ${args.join(' ')}`);
      return '';
    });
    for (const kw of ['max', 'least']) {
      this.interfaceTrie.registerGreedy(kw, `Eth-Trunk ${kw} active-linknumber`, (args) => {
        const id = trunkId();
        if (id === null) return `Error: Unrecognized command "${kw} ${args.join(' ')}"`;
        if ((args[0] ?? '').toLowerCase() !== 'active-linknumber') {
          return refuseMotInattenduVrp(`${kw} ${args.join(' ')}`, args[0] ?? kw);
        }
        const n = parseInt(args[1] ?? '', 10);
        if (isNaN(n) || n < 1 || n > 8) {
          return 'Error: The value of the parameter is out of the range.';
        }
        this.ethTrunks.get(id)!.cfg.push(`${kw} active-linknumber ${n}`);
        this.applyToLacpAgent(a => a.setGroupLimits(id,
          kw === 'least' ? { minLinks: n } : { maxLinks: n }));
        return '';
      });
    }

    this.interfaceTrie.registerGreedy('lacp', 'Eth-Trunk LACP parameters', (args) => {
      const id = trunkId();
      if (id === null) return `Error: Unrecognized command "lacp ${args.join(' ')}"`;
      const sous = (args[0] ?? '').toLowerCase();
      if (sous === 'timeout') {
        const cadence = (args[1] ?? '').toLowerCase();
        if (cadence !== 'fast' && cadence !== 'slow') {
          return refuseMotInattenduVrp(`lacp ${args.join(' ')}`, args[1] ?? 'timeout');
        }
        const trunk = this.ethTrunks.get(id)!;
        trunk.cfg.push(`lacp timeout ${cadence}`);
        trunk.fastTimeout = cadence === 'fast';
        this.appliquerCadenceTrunk(id);
        return '';
      }
      if (sous === 'preempt') {
        const quoi = (args[1] ?? '').toLowerCase();
        if (quoi === 'enable' || quoi === 'disable') {
          this.ethTrunks.get(id)!.cfg.push(`lacp preempt ${quoi}`);
          this.applyToLacpAgent(a => a.setGroupLimits(id, { preempt: quoi === 'enable' }));
          return '';
        }
        if (quoi === 'delay') {
          const n = parseInt(args[2] ?? '', 10);
          if (isNaN(n) || n < 0 || n > 180) {
            return 'Error: The value of the parameter is out of the range.';
          }
          this.ethTrunks.get(id)!.cfg.push(`lacp preempt delay ${n}`);
          this.applyToLacpAgent(a => a.setGroupLimits(id, { preemptDelay: n }));
          return '';
        }
        return refuseMotInattenduVrp(`lacp ${args.join(' ')}`, args[1] ?? 'preempt');
      }
      return refuseMotInattenduVrp(`lacp ${args.join(' ')}`, args[0] ?? 'lacp');
    });

    this.interfaceTrie.registerGreedy('load-balance', 'Eth-Trunk load balancing', (args) => {
      const id = trunkId();
      if (id === null) return `Error: Unrecognized command "load-balance ${args.join(' ')}"`;
      const methode = (args[0] ?? '').toLowerCase();
      if (!LOAD_BALANCE_METHODS.has(methode)) {
        return refuseMotInattenduVrp(`load-balance ${args.join(' ')}`, args[0] ?? 'load-balance');
      }
      const t = this.ethTrunks.get(id)!;
      t.loadBalance = methode;
      t.cfg.push(`load-balance ${methode}`);
      this.applyToLacpAgent(a => a.setLoadBalance(methode));
      return '';
    });
    // `trunkport <if> [to <if>]` — add member ports from the trunk view
    this.interfaceTrie.registerGreedy('trunkport', 'Add member port to Eth-Trunk', (args) => {
      const id = trunkId();
      if (id === null || args.length < 1) return 'Error: Incomplete command.';
      const member = this.resolveInterfaceName(args[0]) || args[0];
      this.ethTrunks.get(id)!.members.push(member);
      return '';
    });
    // `eth-trunk <id>` — join the trunk from a physical interface view
    this.interfaceTrie.registerGreedy('eth-trunk', 'Add interface to an Eth-Trunk', (args) => {
      if (!this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return 'Error: Wrong parameter found at \'^\' position.';
      if (!this.ethTrunks.has(id)) {
        this.ethTrunks.set(id, { mode: 'manual', loadBalance: '', members: [], cfg: [] });
      }
      const t = this.ethTrunks.get(id)!;
      if (!t.members.includes(this.selectedInterface)) t.members.push(this.selectedInterface);
      this.recordIfCfg(`eth-trunk ${id}`);
      this.applyToLacpAgent(a => {
        const lacpMode = t.mode === 'lacp-dynamic' ? 'active'
          : t.mode === 'lacp-static' ? 'active' : 'on';
        a.ensureGroup(id, `Eth-Trunk${id}`, t.loadBalance);
        if (!this.trunksInitialises.has(id)) {
          this.trunksInitialises.add(id);
          a.setGroupLimits(id, { preempt: false, preemptDelay: 30 });
        }
        a.addPortToGroup(this.selectedInterface!, id, lacpMode);
      });
      this.appliquerCadenceTrunk(id);
      return '';
    });

    // port default vlan <id>
    this.interfaceTrie.registerGreedy('port default vlan', 'Set default VLAN for access port', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId)) return 'Error: Wrong parameter.';
      this.swRef.setSwitchportAccessVlan(this.selectedInterface, vlanId);
      return '';
    });
    this.interfaceTrie.allowArgs('port default vlan', 1);

    // port trunk allow-pass vlan <id> [<id>...] | all | none
    this.interfaceTrie.registerGreedy('port trunk allow-pass vlan', 'Set trunk allowed VLANs', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      if (args[0].toLowerCase() === 'all') {
        this.swRef.setTrunkAllowedVlansAll(this.selectedInterface);
        return '';
      }
      if (args[0].toLowerCase() === 'none') {
        this.swRef.setTrunkAllowedVlansNone(this.selectedInterface);
        return '';
      }
      const vlans = new Set<number>();
      for (const arg of args) {
        // Support range notation e.g. "10 to 20" or "10 20"
        const id = parseInt(arg, 10);
        if (!isNaN(id)) vlans.add(id);
      }
      // Huawei additive semantics: add to existing allowed list
      this.swRef.addTrunkAllowedVlans(this.selectedInterface, vlans);
      return '';
    });

    // undo port trunk allow-pass vlan <id> [<id>...] | all
    this.interfaceTrie.registerGreedy('undo port trunk allow-pass vlan', 'Remove trunk allowed VLANs', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      if (args[0].toLowerCase() === 'all') {
        this.swRef.setTrunkAllowedVlansNone(this.selectedInterface);
        return '';
      }
      const vlans = new Set<number>();
      for (const arg of args) {
        const id = parseInt(arg, 10);
        if (!isNaN(id)) vlans.add(id);
      }
      this.swRef.removeTrunkAllowedVlans(this.selectedInterface, vlans);
      return '';
    });

    // undo port default vlan — reset to VLAN 1
    this.interfaceTrie.register('undo port default vlan', 'Reset access VLAN to default', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      this.swRef.setSwitchportAccessVlan(this.selectedInterface, 1);
      return '';
    });

    // undo port trunk pvid vlan — reset PVID to 1
    this.interfaceTrie.register('undo port trunk pvid vlan', 'Reset trunk PVID to default', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Wrong parameter.';
      this.swRef.setTrunkNativeVlan(this.selectedInterface, 1);
      return '';
    });

    // port trunk pvid vlan <id>
    this.interfaceTrie.registerGreedy('port trunk pvid vlan', 'Set trunk PVID', (args) => {
      if (!this.swRef || !this.selectedInterface || args.length < 1) return 'Error: Incomplete command.';
      const vlanId = parseInt(args[0], 10);
      if (isNaN(vlanId)) return 'Error: Wrong parameter.';
      this.swRef.setTrunkNativeVlan(this.selectedInterface, vlanId);
      return '';
    });
  }

  // ─── Command Tree: VLAN View ([hostname-vlanX]) ───────────────────

  private buildVlanCommands(): void {
    // name <vlan-name>
    this.vlanTrie.registerGreedy('name', 'Set VLAN name', (args) => {
      if (!this.swRef || this.selectedVlan === null || args.length < 1) return 'Error: Incomplete command.';
      this.swRef.renameVLAN(this.selectedVlan, args[0]);
      return '';
    });
    // Un nom de VLAN VRP est un seul mot.
    this.vlanTrie.allowArgs('name', 1);

    // description <text> — stored per-VLAN.
    this.vlanTrie.registerGreedy('description', 'Set VLAN description', (args) => {
      if (this.selectedVlan === null || args.length < 1) return 'Error: Incomplete command.';
      this.vlanDesc.set(this.selectedVlan, args.join(' '));
      return '';
    });

    this.vlanTrie.registerGreedy('mac-address', 'VLAN MAC address configuration', (args, ligne) => {
      const vlan = this.selectedVlan;
      if (vlan === null || !this.swRef) return HUAWEI_ERRORS.INCOMPLETE(ligne ?? 'mac-address');
      const a = analyserApprentissageMac(args);
      const brut = ligne ?? `mac-address ${args.join(' ')}`;
      if (a.statut === 'refus') {
        return a.token === null
          ? HUAWEI_ERRORS.INCOMPLETE(brut)
          : refuseMotInattenduVrp(brut, a.token);
      }
      this.swRef.setVlanMacLearning(vlan, false, a.action);
      return '';
    });
    this.vlanTrie.addCompletionKeywords('mac-address', [
      { keyword: 'learning', description: 'MAC address learning' },
    ]);
    this.vlanTrie.registerGreedy('undo mac-address', 'Re-enable VLAN MAC learning', (args, ligne) => {
      const vlan = this.selectedVlan;
      if (vlan === null || !this.swRef) return HUAWEI_ERRORS.INCOMPLETE(ligne ?? 'undo mac-address');
      const a = analyserApprentissageMac(args);
      const brut = ligne ?? `undo mac-address ${args.join(' ')}`;
      if (a.statut === 'refus') {
        return a.token === null
          ? HUAWEI_ERRORS.INCOMPLETE(brut)
          : refuseMotInattenduVrp(brut, a.token);
      }
      this.swRef.setVlanMacLearning(vlan, true);
      return '';
    });

    this.vlanTrie.registerGreedy('igmp-snooping', 'VLAN IGMP snooping configuration', (args, raw) => {
      if (this.selectedVlan === null) return '';
      const v = this.swRef.getVLAN(this.selectedVlan);
      if (!v) return '';
      ajouterLigneVlan(v, 'igmp-snooping', raw ?? `igmp-snooping ${args.join(' ')}`.trim());
      const agent = this.swRef?.getIgmpSnoopingAgent?.();
      if (!agent) return '';
      if (args[0] === 'enable') agent.setVlanEnabled(this.selectedVlan, true);
      else if (args[0] === 'fast-leave') agent.setImmediateLeave(this.selectedVlan, true);
      else if (args[0] === 'static-router-port') {
        return this.applyStaticRouterPort(this.selectedVlan, args.slice(1), true);
      }
      return '';
    });
    this.vlanTrie.registerGreedy('undo igmp-snooping', 'Disable VLAN IGMP snooping', (args, raw) => {
      if (this.selectedVlan === null) return '';
      const v = this.swRef.getVLAN(this.selectedVlan);
      if (!v) return '';
      ajouterLigneVlan(v, 'igmp-snooping', raw ?? `undo igmp-snooping ${args.join(' ')}`.trim());
      const agent = this.swRef?.getIgmpSnoopingAgent?.();
      if (!agent) return '';
      if (args.length === 0 || args[0] === 'enable') agent.setVlanEnabled(this.selectedVlan, false);
      else if (args[0] === 'fast-leave') agent.setImmediateLeave(this.selectedVlan, false);
      else if (args[0] === 'static-router-port') {
        return this.applyStaticRouterPort(this.selectedVlan, args.slice(1), false);
      }
      return '';
    });

    this.vlanTrie.registerGreedy('pim-snooping', 'VLAN PIM snooping configuration', (args) => {
      if (this.selectedVlan === null) return '';
      const agent = this.pimSnoopingAgentOrNull();
      if (!agent) return '';
      if ((args[0] ?? '').toLowerCase() !== 'enable') {
        return 'Error: Unrecognized command found at \'^\' position.';
      }
      agent.setEnabled(true);
      agent.setVlanEnabled(this.selectedVlan, true);
      return '';
    });
    this.vlanTrie.registerGreedy('undo pim-snooping', 'Disable VLAN PIM snooping', (args) => {
      if (this.selectedVlan === null) return '';
      const agent = this.pimSnoopingAgentOrNull();
      if (!agent) return '';
      if (args.length !== 0 && (args[0] ?? '').toLowerCase() !== 'enable') {
        return 'Error: Unrecognized command found at \'^\' position.';
      }
      agent.setVlanEnabled(this.selectedVlan, false);
      return '';
    });

    this.vlanTrie.registerGreedy('traffic-policy', 'Apply a traffic policy to this VLAN', (args) => {
      if (this.selectedVlan === null || !this.swRef || !args[0]) return 'Error: Incomplete command.';
      if (args[1]?.toLowerCase() !== 'inbound') return 'Error: Wrong parameter found.';
      const res = this.swRef.applyVlanTrafficPolicy(this.selectedVlan, args[0]);
      return res.ok ? '' : `Error: ${res.error}.`;
    });
    this.vlanTrie.registerGreedy('undo traffic-policy', 'Remove the VLAN traffic policy', () => {
      if (this.selectedVlan === null || !this.swRef) return 'Error: Incomplete command.';
      this.swRef.removeVlanTrafficPolicy(this.selectedVlan);
      return '';
    });

    this.vlanTrie.register('aggregate-vlan', 'Mark this VLAN as a super-VLAN', () => {
      if (this.selectedVlan === null || !this.swRef) return 'Error: Incomplete command.';
      const res = this.swRef.setSuperVlan(this.selectedVlan);
      return res.ok ? '' : `Error: ${res.error}`;
    });

    this.vlanTrie.registerGreedy('access-vlan', 'Associate sub-VLANs to this super-VLAN', (args) => {
      if (this.selectedVlan === null || !this.swRef || args.length < 1) return 'Error: Incomplete command.';
      const ids: number[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i].toLowerCase() === 'to' && ids.length > 0 && i + 1 < args.length) {
          const start = ids[ids.length - 1];
          const end = parseInt(args[i + 1], 10);
          if (!isNaN(end)) { for (let v = start + 1; v <= end; v++) ids.push(v); i++; }
          continue;
        }
        const n = parseInt(args[i], 10);
        if (!isNaN(n)) ids.push(n);
      }
      if (!ids.length) return 'Error: Wrong parameter found.';
      const res = this.swRef.setSubVlanList(this.selectedVlan, ids);
      return res.ok ? '' : `Error: ${res.error}`;
    });

    for (const kw of ['mux-vlan',
      'vlan-type', 'mac-vlan', 'ip', 'arp']) {
      this.vlanTrie.registerGreedy(kw, `VLAN ${kw} configuration`, (args, raw) => {
        if (this.selectedVlan === null) return '';
        const v = this.swRef.getVLAN(this.selectedVlan);
        if (!v) return '';
        ajouterLigneVlan(v, kw, raw ?? `${kw} ${args.join(' ')}`.trim());
        return '';
      });
    }
  }

  /** `port-group` bulk-config sub-view ([host-port-group]). */
  private buildPortGroupCommands(): void {
    const t = this.portGroupTrie;
    t.registerGreedy('group-member', 'Add member interfaces to this port group', (args, ligne) => {
      const sw = this.swRef;
      const brut = ligne ?? `group-member ${args.join(' ')}`;
      if (!sw) return HUAWEI_ERRORS.INCOMPLETE(brut);
      if (this.portGroupName === null) {
        return `Error: The temporary port-group does not support this command.`;
      }
      const membres = this.resoudrePlage(args, brut);
      if (typeof membres === 'string') return membres;
      const r = sw.addPortGroupMembers?.(this.portGroupName, membres);
      if (r === 'plein') return 'Error: The number of member interfaces reaches the upper limit.';
      this.portGroupMembers = sw.getPortGroupMembers?.(this.portGroupName) ?? [];
      return '';
    });
    t.registerGreedy('undo group-member', 'Remove member interfaces', (args, ligne) => {
      const sw = this.swRef;
      const brut = ligne ?? `undo group-member ${args.join(' ')}`;
      if (!sw) return HUAWEI_ERRORS.INCOMPLETE(brut);
      if (this.portGroupName === null) {
        return `Error: The temporary port-group does not support this command.`;
      }
      const membres = this.resoudrePlage(args, brut);
      if (typeof membres === 'string') return membres;
      sw.removePortGroupMembers?.(this.portGroupName, membres);
      this.portGroupMembers = sw.getPortGroupMembers?.(this.portGroupName) ?? [];
      return '';
    });
    t.register('display this', 'Display port-group configuration', () => {
      const lignes = this.portGroupName === null
        ? [`port-group group-member ${this.portGroupMembers.join(' ')}`]
        : [`port-group ${this.portGroupName}`,
           ...this.portGroupMembers.map(m => ` group-member ${m}`)];
      lignes.push('#');
      return lignes.join('\n');
    });
  }

  private resoudrePlage(args: readonly string[], ligne?: string): string[] | string {
    const brut = ligne ?? args.join(' ');
    const a = analyserPlagePorts(args);
    if (a.statut === 'refus') {
      return a.token === null
        ? HUAWEI_ERRORS.INCOMPLETE(brut)
        : refuseMotInattenduVrp(brut, a.token);
    }
    const noms = this.swRef?.getPortNames() ?? [];
    const membres: string[] = [];
    for (const segment of a.segments) {
      const premier = this.resolveInterfaceName(segment.premier);
      if (!premier || !this.swRef?.getPort(premier)) {
        return refuseMotInattenduVrp(brut, segment.premier);
      }
      const dernier = segment.dernier === null
        ? null
        : this.resolveInterfaceName(completerBorne(segment.premier, segment.dernier));
      if (segment.dernier !== null && (!dernier || !this.swRef?.getPort(dernier))) {
        return refuseMotInattenduVrp(brut, segment.dernier);
      }
      const etendue = etendrePlage(noms, premier, dernier);
      if (!etendue) return refuseMotInattenduVrp(brut, segment.dernier ?? segment.premier);
      for (const nom of etendue) if (!membres.includes(nom)) membres.push(nom);
    }
    return membres;
  }

  private executerSurMembres(sw: Switch, input: string): string {
    const membres = [...this.portGroupMembers];
    if (membres.length === 0) return '';
    const modeAvant = this.mode;
    const interfaceAvant = this.selectedInterface;
    const sorties: string[] = [];
    try {
      for (const membre of membres) {
        this.mode = 'interface';
        this.selectedInterface = membre;
        const sortie = this.execute(sw, input);
        if (sortie.trim()) sorties.push(sortie);
      }
    } finally {
      this.mode = modeAvant;
      this.selectedInterface = interfaceAvant;
    }
    return [...new Set(sorties)].join('\n');
  }

  private magasinComptes(): {
    get(n: string): unknown;
    upsert(a: NetworkOsAccount): unknown;
    remove(n: string): void;
  } | null {
    return getCredentialStore(this.swRef) ?? null;
  }

  /**
   * Poser ou completer le compte dans le magasin partage. Le secret est
   * garde tel qu'il a ete saisi, sinon `local-user` declarerait un
   * compte que personne ne peut authentifier — ce qui etait exactement
   * l'etat precedent.
   */
  private declarerCompteLocal(nom: string, kv: { secret?: string; privilege?: number }): void {
    const store = this.magasinComptes();
    if (!store) return;
    let compte = (store.get(nom) as NetworkOsAccount | undefined)
      ?? NetworkOsAccount.create({ name: nom });
    if (kv.secret !== undefined) compte = compte.withSecret(kv.secret, 'plain');
    if (kv.privilege !== undefined) compte = compte.withPrivilege(kv.privilege);
    store.upsert(compte);
  }

  /** AAA sub-view ([host-aaa]) — local-user / scheme / domain. */
  private buildAaaCommands(): void {
    const t = this.aaaTrie;
    // `local-user` DECLARE un compte, il ne remplit pas un tableau
    // d'affichage. Il rangeait dans une carte locale au shell en
    // remplacant le mot de passe par `******` : le compte n'existait pour
    // personne, donc rien ne pouvait l'authentifier et `display users`
    // ne pouvait jamais le nommer. Il alimente desormais le MEME magasin
    // que le routeur, tout en gardant sa carte pour le rendu de la
    // configuration (VRP y ecrit le condense, pas le secret).
    t.registerGreedy('local-user', 'Configure a local user', (args) => {
      if (args.length < 2) return 'Error: Incomplete command.';
      const name = args[0];
      const u = this.localUsers.get(name) ?? {};
      const kw = args[1].toLowerCase();
      if (kw === 'password') {
        u.password = '******';
        this.declarerCompteLocal(name, { secret: args[args.length - 1] });
      } else if (kw === 'privilege') {
        u.privilege = args[args.length - 1];
        const lvl = parseInt(args[args.length - 1], 10);
        if (Number.isFinite(lvl)) this.declarerCompteLocal(name, { privilege: lvl });
      } else if (kw === 'service-type') {
        u.serviceType = args.slice(2).join(',');
        this.declarerCompteLocal(name, {});
      }
      this.localUsers.set(name, u);
      return '';
    });
    t.registerGreedy('undo', 'aaa undo', (args, raw) => {
      if ((args[0] ?? '').toLowerCase() === 'local-user' && args[1]) {
        this.localUsers.delete(args[1]);
        this.magasinComptes()?.remove(args[1]);
        return '';
      }
      const cfg = this.aaaExtraConfig ?? (this.aaaExtraConfig = {
        authenticationSchemes: [], authorizationSchemes: [],
        accountingSchemes: [], domains: [], rawLines: [],
      });
      cfg.rawLines.push(raw ?? `undo ${args.join(' ')}`.trim());
      return '';
    });
    for (const kw of ['authentication-scheme', 'authorization-scheme',
      'accounting-scheme', 'domain']) {
      t.registerGreedy(kw, `aaa ${kw}`, (args, raw) => {
        const cfg = this.aaaExtraConfig ?? (this.aaaExtraConfig = {
          authenticationSchemes: [], authorizationSchemes: [],
          accountingSchemes: [], domains: [], rawLines: [],
        });
        const line = raw ?? `${kw} ${args.join(' ')}`.trim();
        if (kw === 'authentication-scheme' && args[0]) cfg.authenticationSchemes.push(args[0]);
        else if (kw === 'authorization-scheme' && args[0]) cfg.authorizationSchemes.push(args[0]);
        else if (kw === 'accounting-scheme' && args[0]) cfg.accountingSchemes.push(args[0]);
        else if (kw === 'domain' && args[0]) cfg.domains.push(args[0]);
        else cfg.rawLines.push(line);
        return '';
      });
    }
  }

  private userInterfaceExtraConfig: Map<string, {
    authMode?: string;
    idleTimeoutMin?: number;
    screenLength?: number;
    historySize?: number;
    shellEnabled: boolean;
    acl?: string;
    authorizationMode?: string;
    users: string[];
    rawLines: string[];
  }> = new Map();
  getUserInterfaceExtraConfig() { return this.userInterfaceExtraConfig; }

  private aaaExtraConfig: {
    authenticationSchemes: string[];
    authorizationSchemes: string[];
    accountingSchemes: string[];
    domains: string[];
    rawLines: string[];
  } | null = null;
  getAaaExtraConfig() { return this.aaaExtraConfig; }

  /** user-interface sub-view ([host-ui-…]) — auth-mode / protocol / etc. */
  private buildUserInterfaceCommands(): void {
    const t = this.userIfTrie;
    for (const kw of ['authentication-mode', 'user',
      'idle-timeout', 'screen-length', 'history-command', 'shell',
      'acl', 'set', 'authorization-mode']) {
      t.registerGreedy(kw, `user-interface ${kw}`, (args, raw) => {
        const label = this.uiLabel;
        const cfg = this.userInterfaceExtraConfig.get(label) ?? {
          authMode: undefined as string | undefined,
          idleTimeoutMin: undefined as number | undefined,
          screenLength: undefined as number | undefined,
          historySize: undefined as number | undefined,
          shellEnabled: true,
          acl: undefined as string | undefined,
          authorizationMode: undefined as string | undefined,
          users: [] as string[],
          rawLines: [] as string[],
        };
        const line = raw ?? `${kw} ${args.join(' ')}`.trim();
        if (kw === 'authentication-mode' && args[0]) cfg.authMode = args[0];
        else if (kw === 'idle-timeout' && args[0]) cfg.idleTimeoutMin = parseInt(args[0], 10);
        else if (kw === 'screen-length' && args[0]) cfg.screenLength = parseInt(args[0], 10);
        else if (kw === 'history-command' && args[0] === 'max-size' && args[1]) cfg.historySize = parseInt(args[1], 10);
        else if (kw === 'shell') cfg.shellEnabled = true;
        else if (kw === 'acl' && args[0]) cfg.acl = args[0];
        else if (kw === 'authorization-mode' && args[0]) cfg.authorizationMode = args[0];
        else if (kw === 'user' && args[0]) cfg.users.push(args.join(' '));
        else if (kw === 'set') cfg.rawLines.push(line);
        this.userInterfaceExtraConfig.set(label, cfg);
        return '';
      });
    }
    // `protocol inbound {ssh|telnet|all|none}` toggles VTY transports
    // exactly like Cisco's `transport input`. Routes through the device
    // setter so CrossVendorSshHost.evaluate() sees the change.
    t.registerGreedy('protocol', 'user-interface protocol', (args) => {
      if (args[0]?.toLowerCase() !== 'inbound' || !args[1]) return '';
      const dev = this.swRef;
      const proto = args[1].toLowerCase() as 'ssh' | 'telnet' | 'all' | 'none';
      if (dev && ['ssh', 'telnet', 'all', 'none'].includes(proto)) {
        dev._setVtyTransportInput(proto, this.selectedUiRange ?? undefined);
      }
      return '';
    });
    // `undo protocol inbound [ssh|telnet]` — VRP convention: removing the
    // listed transports leaves the others. With no arg it disables both.
    t.registerGreedy('undo', 'user-interface undo', (args) => {
      if (args[0]?.toLowerCase() !== 'protocol' || args[1]?.toLowerCase() !== 'inbound') return '';
      const dev = this.swRef;
      const removed = (args[2] ?? '').toLowerCase();
      if (!dev) return '';
      const plage = this.selectedUiRange ?? undefined;
      if (removed === 'ssh') dev._setVtyTransportInput('telnet', plage);
      else if (removed === 'telnet') dev._setVtyTransportInput('ssh', plage);
      else dev._setVtyTransportInput('none', plage);
      return '';
    });
    t.register('display this', 'Display user-interface configuration', () =>
      `user-interface ${this.uiLabel.replace(/(\D)(\d)/, '$1 $2')}`);
  }

  /**
   * La vue ACL du commutateur.
   *
   * Elle tenait DEUX magasins : un echo verbatim du texte tape
   * de la ligne tapee et les entrees du moteur, alimentes par deux
   * chemins differents. Ils divergeaient de toutes les facons possibles —
   * `undo rule 5` retirait la ligne du TEXTE sans toucher au moteur, donc
   * une regle supprimee de la configuration continuait de filtrer ; le
   * numero ecrit par l'operateur etait jete ; une regle malformee entrait
   * dans le texte et pas dans le moteur ; et `display this` annoncait
   * `rule 5` la ou `display acl` annoncait `rule 0` pour la meme regle.
   *
   * Il n'y en a plus qu'un : le moteur, celui qui filtre pour de bon.
   */
  private buildAclCommands(): void {
    const t = this.aclTrie;
    t.registerGreedy('rule', 'Configure an ACL rule', (args, ligne) => {
      const ref = this.aclRefCourante();
      if (ref === null) return 'Error: Incomplete command.';
      const kind = this.aclTypeCourant() === 'adv' ? 'advanced' : 'basic';
      const a = analyserRegleVrp(args, kind);
      if (a.statut === 'refus') return rendreErreurVrp(a.err, ligne ?? `rule ${args.join(' ')}`);
      if (!this.swRef) return '';
      const engine = this.swRef.getVaclEngine();
      if (typeof ref === 'number') engine.addAccessListEntry(ref, a.action, a.opts);
      else engine.addNamedAccessListEntry(ref, kind === 'advanced' ? 'extended' : 'standard', a.action, a.opts);
      return '';
    });
    t.registerGreedy('description', 'ACL description', (args) => {
      const ref = this.aclRefCourante();
      if (ref === null) return '';
      this.swRef?.getVaclEngine().setDescription(ref, args.join(' '));
      return '';
    });
    t.registerGreedy('step', 'Set ACL rule step', (args, ligne) => {
      const ref = this.aclRefCourante();
      if (ref === null) return '';
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 1) {
        return rendreErreurVrp({ kind: 'wrong', token: args[0] ?? 'step' }, ligne ?? `step ${args.join(' ')}`);
      }
      this.swRef?.getVaclEngine().setStep(ref, n);
      return '';
    });
    t.registerGreedy('undo', 'ACL undo', (args) => {
      const ref = this.aclRefCourante();
      if (ref === null) return '';
      if (!this.swRef) return '';
      const engine = this.swRef.getVaclEngine();
      if (args[0]?.toLowerCase() === 'rule') {
        const seq = parseInt(args[1] ?? '', 10);
        if (isNaN(seq)) return 'Error: Incomplete command.';
        // Supprimer du MOTEUR, seul magasin : le texte disparaissait
        // pendant que la regle continuait de filtrer.
        return engine.removeEntryBySequence(ref, seq) ? '' : `Error: Rule ${seq} does not exist.`;
      }
      if (args[0]?.toLowerCase() === 'description') { engine.setDescription(ref, ''); return ''; }
      if (args[0]?.toLowerCase() === 'step') {
        engine.setStep(ref, engine.getDefaultStep());
        return '';
      }
      return '';
    });
    t.register('display this', 'Display ACL configuration', () =>
      this.renderAcl(this.selectedAcl));
    // `display` s'utilise depuis toute vue sur VRP.
    this.registerAclDisplay(t);
  }

  /** `display acl {all | <numero|nom>}`, lu sur le moteur. */
  private registerAclDisplay(trie: CommandTrie): void {
    trie.registerGreedy('display acl', 'Display ACL configuration', (args) => {
      const engine = this.swRef?.getVaclEngine();
      const listes = engine?.getAccessListsInternal() ?? [];
      if (listes.length === 0) return 'Info: No ACL is configured.';
      const sel = (args[0] ?? 'all').toLowerCase();
      if (sel === 'all') {
        return listes.map((a) => this.renderAclOperational(a.name ?? String(a.id ?? ''))).join('\n');
      }
      return this.renderAclOperational(args[0]);
    });
  }

  /** La liste ouverte, designee comme le moteur la connait. */
  private aclRefCourante(): number | string | null {
    if (!this.selectedAcl) return null;
    const n = parseInt(this.selectedAcl, 10);
    return /^\d+$/.test(this.selectedAcl) && !isNaN(n) ? n : this.selectedAcl;
  }

  /** `basic` ou `adv` — le type de la vue ouverte. */
  private aclTypeCourant(): 'basic' | 'adv' {
    return this.selectedAclType;
  }

  private renderAcl(key: string | null): string {
    if (!key || !this.swRef) return '';
    const engine = this.swRef.getVaclEngine();
    const n = parseInt(key, 10);
    const acl = engine.findRef(/^\d+$/.test(key) && !isNaN(n) ? n : key);
    if (!acl) return `Error: The ACL ${key} does not exist.`;
    return formatHuaweiAclConfig(acl, engine.getDefaultStep()).join('\n');
  }

  /** La vue operationnelle d'une liste — meme formateur que le routeur. */
  private renderAclOperational(key: string | null): string {
    if (!key || !this.swRef) return '';
    const engine = this.swRef.getVaclEngine();
    const n = parseInt(key, 10);
    const acl = engine.findRef(/^\d+$/.test(key) && !isNaN(n) ? n : key);
    if (!acl) return `Error: The ACL ${key} does not exist.`;
    return formatHuaweiAcl(acl, engine.getDefaultStep());
  }

  private parseVrpVlanTokens(args: string[]): number[] {
    const ids: number[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].toLowerCase() === 'to' && ids.length > 0 && i + 1 < args.length) {
        const start = ids[ids.length - 1];
        const end = parseInt(args[i + 1], 10);
        if (!isNaN(end)) { for (let v = start + 1; v <= end; v++) ids.push(v); i++; }
        continue;
      }
      const n = parseInt(args[i], 10);
      if (!isNaN(n)) ids.push(n);
    }
    return ids;
  }

  // ─── Shared Display Commands ──────────────────────────────────────

  private registerDisplayCommands(trie: CommandTrie): void {
    trie.register('display version', 'Display VRP version information', () => {
      if (!this.swRef) return '';
      return this.displayVersion(this.swRef);
    });
    // La forme globale marchait, la forme PAR-INTERFACE était refusée
    // (audit 12, §3.3). Elle filtre la même vue plutôt que d'en rendre
    // une seconde : deux tableaux qui peuvent se contredire seraient
    // pires qu'un seul.
    trie.registerGreedy('display port-security', 'Display port-security status', (args) => {
      const complet = this.displayPortSecurity();
      if (args.length === 0) return complet;
      if (args[0].toLowerCase() !== 'interface') {
        return `Error: Wrong parameter found at '^' position.`;
      }
      if (!args[1]) return `Error: Incomplete command found at '^' position.`;
      const nom = this.resolveInterfaceName(args.slice(1).join(' '));
      if (!nom) return `Error: Wrong parameter found at '^' position.`;
      const lignes = complet.split('\n');
      const entete = lignes[0];
      const ligne = lignes.slice(1).find((l) => l.trim().endsWith(nom));
      if (!ligne) return `Port-security is not enabled on ${nom}.`;
      return [entete, ligne].join('\n');
    });

    // display vlan [summary | <id>]
    trie.registerGreedy('display vlan', 'Display VLAN information', (args) => {
      if (!this.swRef) return '';
      const full = this.displayVlan(this.swRef);
      if (args.length === 0) return full;
      if (args[0].toLowerCase() === 'summary') {
        const ids: number[] = [];
        for (const [id] of this.swRef.getVLANs()) ids.push(id);
        return [
          `The total number of vlans is : ${ids.length}`,
          `--------------------------------`,
          `static vlan:`,
          `Total ${ids.length} static vlan.`,
          ids.sort((a, b) => a - b).join(' '),
        ].join('\n');
      }
      const id = parseInt(args[0], 10);
      if (!isNaN(id)) {
        const lines = full.split('\n');
        const hit = lines.filter(l => new RegExp(`(^|\\s)${id}(\\s|$)`).test(l));
        return [lines[0] ?? '', ...(hit.length ? hit : [`VLAN ${id} not found`])].join('\n');
      }
      return full;
    });

    // `display port` seul répondait « Incomplete command » alors que
    // VRP l'accepte : c'est la vue d'ensemble des ports, dont
    // `display port vlan` n'est qu'une colonne (audit 11, §5).
    trie.register('display debugging', 'Display active debugging flags', () =>
      this.debugService()?.format() ?? 'No debugging is on');
    trie.register('display port', 'Display port summary', () => {
      if (!this.swRef) return '';
      const rows = ['Interface                   Status     Link Type  PVID  Speed  Duplex'];
      for (const nom of this.swRef.getPortNames()) {
        const port = this.swRef.getPort(nom);
        const cfg = this.swRef.getSwitchportConfig(nom);
        const up = !!(port?.getIsUp() && port?.isConnected());
        rows.push(`${nom.padEnd(28)}${(up ? 'up' : 'down').padEnd(11)}`
          + `${(cfg?.mode ?? 'access').padEnd(11)}${String(cfg?.accessVlan ?? 1).padEnd(6)}`
          + `${(up ? '1000' : 'auto').padEnd(7)}${up ? 'full' : 'auto'}`);
      }
      return rows.join('\n');
    });

    // `display dhcp snooping` seul : l'état global et par VLAN existait
    // déjà dans `SwitchSecurityService`, rien ne le lisait sous cette
    // forme — encore un moteur sans porte.
    trie.register('display dhcp snooping', 'Display DHCP snooping status', () => {
      if (!this.swRef) return '';
      const sec = this.swRef.getSecurityService();
      const global = sec.isDhcpSnoopingEnabled();
      const vlans = sec.getDhcpSnoopingVlans();
      // Deux magasins de confiance existent et sont tous deux
      // atteignables : `dhcp snooping trusted` en vue interface écrit
      // dans celui qui APPLIQUE (`_getDHCPSnoopingConfig().trustedPorts`,
      // consulté par le plan de données), la forme système `dhcp snooping
      // trust interface <if>` dans celui de `SwitchSecurityService`.
      // La vue les réunit : une interface de confiance par l'une ou
      // l'autre voie est de confiance, et n'en lire qu'un ferait mentir
      // l'affichage sur la moitié des configurations.
      const trust = [...new Set([
        ...sec.getDhcpSnoopingTrust().filter((t) => t.trusted).map((t) => t.ifName),
        ...this.swRef._getDHCPSnoopingConfig().trustedPorts,
      ])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      const lignes = [
        `DHCP snooping global running information :`,
        ` DHCP snooping                          : ${global ? 'Enable' : 'Disable'}`,
        ` Static user max number                 : 1024`,
        ` Current static user number             : 0`,
        ` Dhcp user max number                   : 4096`,
        ` Current dhcp user number               : 0`,
      ];
      if (vlans.length > 0) {
        lignes.push('', `DHCP snooping running information for VLAN ${[...vlans].sort((a, b) => a - b).join(' ')} :`,
          ` DHCP snooping                          : Enable`);
      }
      if (trust.length > 0) {
        lignes.push('', `DHCP snooping trusted interface(s) :`);
        for (const t of trust) lignes.push(` ${t}`);
      }
      return lignes.join('\n');
    });

    // display port vlan [active | <interface>]
    trie.registerGreedy('display port vlan', 'Display port VLAN assignment', (args) => {
      if (!this.swRef) return '';
      const filterArg = args.filter((a) => a.toLowerCase() !== 'active').join(' ');
      const filterPort = filterArg ? this.resolveInterfaceName(filterArg) : null;
      const rows = ['Port                    Link Type    PVID  Trunk VLAN List'];
      for (const p of this.swRef.getPortNames()) {
        if (filterPort && p !== filterPort) continue;
        const cfg = this.swRef.getSwitchportConfig(p);
        if (!cfg) continue;
        if (cfg.mode === 'hybrid') {
          const pvid = cfg.hybridPvid ?? 1;
          const unt = [...(cfg.hybridUntaggedVlans ?? [])].sort((a, b) => a - b).join(' ');
          const tag = [...(cfg.hybridTaggedVlans ?? [])].sort((a, b) => a - b).join(' ');
          rows.push(`${p.padEnd(24)}${'hybrid'.padEnd(13)}${String(pvid).padEnd(6)}U: ${unt || '-'}  T: ${tag || '-'}`);
          continue;
        }
        const pvid = cfg.mode === 'trunk' ? cfg.trunkNativeVlan : cfg.accessVlan;
        const trunkList = cfg.mode === 'trunk'
          ? [...cfg.trunkAllowedVlans].sort((a, b) => a - b).join(' ')
          : '';
        rows.push(`${p.padEnd(24)}${cfg.mode.padEnd(13)}${String(pvid).padEnd(6)}${trunkList || '-'}`);
      }
      return rows.join('\n');
    });

    trie.registerGreedy('display interface brief', 'Display interface summary', (args) => {
      if (!this.swRef) return '';
      return this.displayInterfaceBrief(this.swRef, args.join(' ').trim() || undefined);
    });

    // `display interface description` n'existait pas ici, alors que le
    // routeur la rend depuis toujours et que la description est bien
    // stockee par le commutateur.
    trie.registerGreedy('display interface description', 'Display interface descriptions', (args) => {
      if (!this.swRef) return '';
      return this.displayInterfaceDescription(this.swRef, args.join(' ').trim() || undefined);
    });

    trie.registerGreedy('display interface', 'Display interface details', (args) => {
      if (!this.swRef) return '';
      if (args.length === 0) return this.displayInterfaceBrief(this.swRef);
      // Une LoopBack se montre depuis les deux portes, `display
      // interface` comme `display ip interface`. Traitée ici plutôt que
      // par une seconde inscription sur un chemin voisin : deux
      // inscriptions dont l'une écrase l'autre est exactement le défaut
      // que la sonde `command-trie-hygiene` traque.
      const trunk = args.join(' ').trim().replace(/\s+/g, '')
        .match(/^eth-trunk(\d+)$/i);
      if (trunk) return this.displayEthTrunkInterface(Number(trunk[1]));
      const l3 = this.resolveL3InterfaceName(args.join(' '));
      if (l3 && l3.startsWith('LoopBack')) return this.renderL3Interface(l3);
      return this.displayInterface(this.swRef, args.join(' '));
    });

    trie.registerGreedy('display qos', 'Display QoS trust state and default priority per interface', (args) => {
      if (!this.swRef) return '';
      return this.displayQos(this.swRef, args.length > 0 ? args.join(' ') : undefined);
    });

    trie.register('display ip routing-table', 'Display IP routing table', () => {
      if (!this.swRef) return '';
      const rows = this.swRef.getL3RoutingTable();
      const header = 'Route Flags: R - relay, D - download to fib\n' +
        '------------------------------------------------------------------------------\n' +
        'Routing Tables: Public\n' +
        `         Destinations : ${destinationsDistinctes(rows)}       Routes : ${rows.length}\n\n` +
        'Destination/Mask    Proto   Pre  Cost      Flags NextHop         Interface\n';
      const lines = rows.map(r => {
        const dest = `${r.network}/${r.mask.toCIDR()}`.padEnd(20);
        const proto = (r.proto === 'connected' ? 'Direct' : 'Static').padEnd(8);
        const pre = String(r.proto === 'connected' ? 0 : r.preference ?? 60).padEnd(5);
        const nh = (r.nextHop ? r.nextHop.toString() : r.network.toString()).padEnd(16);
        return `${dest}${proto}${pre}0         D     ${nh}${r.iface}`;
      });
      return header + lines.join('\n');
    });

    trie.register('display mac-address aging-time', 'Display MAC aging time', () => {
      if (!this.swRef) return '';
      return this.displayMacAgingTime(this.swRef);
    });

    trie.registerGreedy('display mac-address', 'Display MAC address table', (args, ligne) => {
      const sw = this.swRef;
      if (!sw) return '';
      const mots = args.filter(a => a.length > 0);
      let entries = sw.getMACTable();
      let i = 0;
      while (i < mots.length) {
        const mot = mots[i].toLowerCase();
        if (mot === 'static' || mot === 'dynamic' || mot === 'blackhole') {
          entries = entries.filter(e => e.type === mot);
          i += 1;
          continue;
        }
        if (mot === 'vlan') {
          const id = parseInt(mots[i + 1] ?? '', 10);
          if (isNaN(id)) {
            return HUAWEI_ERRORS.WRONG(ligne ?? `display mac-address ${args.join(' ')}`);
          }
          entries = entries.filter(e => e.vlan === id);
          i += 2;
          continue;
        }
        const port = this.resolveInterfaceName(mots.slice(i).join(''));
        if (!port || !sw.getPort(port)) {
          return refuseMotInattenduVrp(
            ligne ?? `display mac-address ${args.join(' ')}`, mots[i]);
        }
        entries = entries.filter(e => e.port === port);
        i = mots.length;
      }
      return this.displayMacAddress(entries);
    });

    trie.registerGreedy('display port-group', 'Display permanent port groups', (args, ligne) => {
      const sw = this.swRef;
      if (!sw) return '';
      const groupes = sw.getPortGroups?.() ?? [];
      const mots = args.filter(a => a.length > 0);
      if (mots.length === 0) return renduDisplayPortGroup(groupes, false);
      if (mots.length > 1) {
        return refuseMotInattenduVrp(ligne ?? `display port-group ${args.join(' ')}`, mots[1]);
      }
      if (mots[0].toLowerCase() === 'all') return renduDisplayPortGroup(groupes, true);
      const membres = sw.getPortGroupMembers?.(mots[0]);
      if (!membres) return `Error: The port-group ${mots[0]} does not exist.`;
      return renduDisplayPortGroup([[mots[0], membres]], true);
    });
    trie.addCompletionKeywords('display port-group', [
      { keyword: 'all', description: 'All permanent port groups and their members' },
    ]);

    trie.register('display current-configuration', 'Display running configuration', () => {
      if (!this.swRef) return '';
      return this.displayCurrentConfig(this.swRef);
    });

    trie.registerGreedy('display current-configuration interface', 'Display interface configuration', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      return this.displayCurrentConfigInterface(this.swRef, args.join(' '));
    });

    // display current-configuration configuration <module>  (vlan, …)
    trie.registerGreedy('display current-configuration configuration', 'Display module configuration', (args) => {
      if (!this.swRef) return '';
      const full = this.displayCurrentConfig(this.swRef);
      const mod = (args[0] ?? '').toLowerCase();
      if (mod === 'vlan') {
        const block = full.split('\n').filter(l => /vlan/i.test(l));
        return block.length ? block.join('\n') : '#';
      }
      return full;
    });

    // L3 switch: every Vlanif with an IP appears here, plus the
    // management Ethernet placeholder. Each row reflects the live
    // admin/protocol state so the operator can see at a glance which
    // SVI is up.
    trie.registerGreedy('display ip interface brief', 'Display IP interface brief', (args) => {
      if (!this.swRef) return '';
      const lignes: LigneIpBrief[] = [];
      for (const svi of this.swRef.getSvis()) {
        const nom = `Vlanif${svi.vlan}`;
        const lineUp = this.swRef.isSviLineUp(svi);
        lignes.push({
          nom,
          adresse: svi.ip && svi.mask ? `${svi.ip}/${svi.mask.toCIDR()}` : 'unassigned',
          physique: svi.adminUp ? (lineUp ? 'up' : 'down') : '*down',
          protocole: lineUp ? 'up' : 'down',
        });
      }
      for (const lb of this.swRef.getLoopbacks()) {
        // Une loopback est up des deux cotes des qu'elle existe — elle
        // ne depend d'aucun cable, c'est tout son interet.
        lignes.push({
          nom: lb.name,
          adresse: lb.ip && lb.mask ? `${lb.ip}/${lb.mask.toCIDR()}` : 'unassigned',
          physique: 'up',
          protocole: protocoleVrp(lb.name, 'up'),
        });
      }
      lignes.push({
        nom: 'MEth0/0/1', adresse: 'unassigned', physique: 'down', protocole: 'down',
      });
      const filtre = args.join(' ').trim();
      if (filtre) {
        const cible = this.resolveInterfaceName(filtre);
        if (!cible) return `Error: Wrong parameter found at '^' position.`;
        return rendreIpInterfaceBrief(lignes.filter((l) => l.nom === cible));
      }
      return rendreIpInterfaceBrief(lignes);
    });

    // `display ip interface <nom>` — la forme longue manquait
    // entièrement (seul `brief` existait), alors que le routeur VRP la
    // rendait déjà. Même bloc, mêmes libellés que sur le routeur.
    trie.registerGreedy('display ip interface', 'Display IP interface detail', (args) => {
      if (!this.swRef) return '';
      // Un port physique etait refuse ici alors que le routeur repondait
      // pour le meme port : `display ip interface` d'un port sans adresse
      // n'est pas une erreur, c'est un port sans adresse.
      const nom = this.resolveInterfaceName(args.join(' '));
      if (!nom) return `Error: Wrong parameter found at '^' position.`;
      return this.renderL3Interface(nom);
    });


    // Lot V15 : un seul rendu pour les deux plateformes. Ce greedy
    // AVALAIT ses propres sous-commandes — `display vrrp statistics` et
    // `display vrrp verbose` rendaient le bloc de `display vrrp` — et
    // ecrivait la MAC virtuelle au format IEEE (regle du lot V14).
    trie.registerGreedy('display vrrp', 'Display VRRP groups on SVIs', (args) => {
      if (!this.swRef) return '';
      const groups = this.swRef.getVrrpAgent().listGroups();
      const mot = (args[0] ?? '').toLowerCase();
      if (mot === 'brief') return rendreDisplayVrrpBrief(groups);
      if (mot === 'statistics') {
        return rendreDisplayVrrpStatistics(groups, this.swRef.getVrrpAgent().getGlobalStats());
      }
      if (mot === 'interface') {
        const demande = args.slice(1).join(' ');
        const nom = this.resolveInterfaceName(demande);
        if (!nom) return HUAWEI_ERRORS.WRONG(`display vrrp interface ${demande}`, 'display vrrp interface '.length);
        const portes = groupesDeLInterface(this.swRef.getVrrpAgent(), nom);
        return portes.length === 0 ? AUCUN_GROUPE : rendreDisplayVrrp(portes);
      }
      if (mot) return refuseMotInattenduVrp(`display vrrp ${args.join(' ')}`, args[0]);
      return rendreDisplayVrrp(groups);
    });

    // display arp [all] — render the switch's shared mgmt ARP cache,
    // populated by every SVI reply / learned ingress. The view IS the
    // L3 switch's neighbour table.
    trie.registerGreedy('display arp', 'Display ARP table', (args) => {
      if (!this.swRef) return '';
      const filter = (args[0] ?? '').toLowerCase();
      const lignes: LigneArp[] = [];
      for (const [ip, e] of this.swRef._getArpTableInternal()) {
        if (filter === 'static' && e.type !== 'static') continue;
        if (filter === 'dynamic' && e.type !== 'dynamic') continue;
        lignes.push({
          ip,
          mac: huaweiMacAddress(e.mac),
          expire: e.type === 'static' ? '-' : '20',
          type: e.type,
          iface: huaweiDisplayInterfaceName(e.iface),
        });
      }
      return rendreArpSwitch(lignes);
    });

    // ── Common VRP display commands (shared with the router, DRY) ──
    trie.register('display clock', 'Display system clock', () => {
      const c = this.swRef?.getManagementService?.().getClock();
      return displayClock(new Date(),
        c ? { timezone: c.timezone, offsetMin: c.offsetMin } : undefined);
    });
    trie.register('display cpu-usage', 'Display CPU usage', () => displayCpuUsage());
    trie.register('display memory-usage', 'Display memory usage', () => displayMemoryUsage());
    trie.register('display users', 'Display user sessions', () => displayUsers(this.swRef));
    trie.register('display device', 'Display device status', () =>
      this.swRef ? displayDevice(this.swRef.getHostname()) : '');
    trie.register('display history-command', 'Display command history', () =>
      displayHistoryCommand(this.history));

    // `display this` — running config of the CURRENT view only.
    trie.register('display this', 'Display active view configuration', () => this.renderDisplayThis());
    // La vue de VLAN n'avait pas la commande du tout : `display this` y
    // repondait `Unrecognized command`, alors que c'est justement une
    // vue ou l'on veut voir ce qu'on vient de poser.
    this.vlanTrie.register('display this', 'Display active view configuration', () => this.renderDisplayThis());


    // `display saved-configuration` — real semantics: render the snapshot
    // captured by `save`, never a mirror of the running configuration.
    trie.register('display saved-configuration', 'Display saved configuration', () => {
      const snapshot = this.swRef?.getStartupConfig();
      return snapshot ?? "Error: The configuration file doesn't exist.";
    });
    trie.register('display startup', 'Display startup configuration', () =>
      this.swRef ? this.displayCurrentConfig(this.swRef) : '');

    // save / reset saved-configuration — REAL persistence into the switch
    // NVRAM. The interactive Y/N dialogue is declared by the interaction
    // plan (huaweiInteractionPlanFor); the inline forms assume yes.
    trie.register('save', 'Save current configuration', () => {
      if (this.swRef) this.swRef._captureStartupConfig(this.displayCurrentConfig(this.swRef));
      return 'The current configuration will be written to the device.\nInfo: Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:vrpcfg.zip\nNow saving the current configuration to the slot.\nSave the configuration successfully.';
    });
    trie.registerGreedy('reset saved-configuration', 'Clear the saved configuration', () => {
      this.swRef?._eraseStartupConfig();
      return 'Warning: The action will delete the saved configuration on the device.';
    });
    // reboot — REAL restart (parity with the VRP router shell). The
    // interactive Y/N dialogue is the interaction plan's job.
    trie.registerGreedy('reboot', 'Reboot device', () => {
      this.swRef?.powerOff();
      this.swRef?.powerOn();
      this.mode = 'user';
      this.selectedInterface = null;
      return 'Info: The system is rebooting ...\nSystem restart completed.';
    });

    // Informational displays (shared with the router, DRY).
    trie.register('display alarm', 'Display alarm records', () => displayAlarm());
    trie.register('display elabel', 'Display electronic label', () =>
      this.swRef ? displayElabel(this.swRef.getHostname()) : '');
    trie.register('display license', 'Display license information', () => displayLicense());
    trie.register('display logbuffer', 'Display log buffer', () => displayLogbuffer());
    trie.register('display trapbuffer', 'Display trap buffer', () => displayTrapbuffer());
    trie.register('display patch-information', 'Display patch information', () =>
      displayPatchInformation());
    trie.register('display diagnostic-information', 'Collect diagnostic information', () =>
      displayDiagnosticInformation());

    // STP display family (switch-only).
    this.registerStpDisplay(trie);
    this.registerMqcDisplay(trie);

    // Shared management `display` commands (DRY).
    registerHuaweiCommonSecurityDisplay(trie, () => this.localUsers,
      () => this.swRef?.getNtpAgent(),
      () => this.swRef?.getSnmpService());

    // Real DHCP snooping binding table — shadows the generic hardcoded
    // `display dhcp ...` catch-all above with the switch's actual bindings.
    trie.register('display dhcp snooping user-bind all', 'Display DHCP snooping binding table', () =>
      this.swRef ? this.displayDhcpSnoopingUserBind(this.swRef) : 'Error: Incomplete command.');

    this.registerAclDisplay(trie);

    // reset acl counter { all | name <name> | <number> }
    trie.registerGreedy('reset acl counter', 'Reset ACL match counters', (args) => {
      if (!this.swRef) return '';
      const engine = this.swRef.getVaclEngine();
      if (!args[0] || args[0].toLowerCase() === 'all') {
        engine.resetAllCounters();
        return '';
      }
      const ref = args[0].toLowerCase() === 'name' ? args[1] : args[0];
      if (!ref) return 'Error: Incomplete command.';
      engine.resetCounters(/^\d+$/.test(ref) ? parseInt(ref, 10) : ref);
      return '';
    });

    // Eth-Trunk + counters.
    trie.registerGreedy('display igmp-snooping', 'Display IGMP snooping state', (args) => {
      const agent = this.swRef?.getIgmpSnoopingAgent?.();
      if (!agent) return '';
      const vlans = agent.listVlans();
      if (args[0] === 'group') {
        const vIdx = args.indexOf('vlan');
        const filter = vIdx >= 0 ? parseInt(args[vIdx + 1] ?? '', 10) : NaN;
        const rows: string[] = [];
        for (const { vlan, group } of agent.listGroups(Number.isNaN(filter) ? undefined : filter)) {
          rows.push(` Group address: ${group.groupAddress}`);
          rows.push(`  VLAN ID: ${vlan}`);
          rows.push(`  Member ports: ${[...group.members.keys()].join(' ') || '(none)'}`);
        }
        return rows.length ? rows.join('\n') : 'Info: No multicast group entry is found.';
      }
      if (vlans.length === 0) return 'Info: IGMP snooping is not enabled on any VLAN.';
      const cfg = agent.getConfig();
      const lines: string[] = [];
      for (const v of vlans) {
        lines.push(`VLAN ID: ${v.vlan}`);
        lines.push(`  IGMP snooping: ${v.enabled ? 'enabled' : 'disabled'}`);
        lines.push(`  Immediate leave: ${cfg.immediateLeave.has(v.vlan) ? 'enabled' : 'disabled'}`);
        lines.push(`  Router ports: ${[...v.routerPorts].join(' ') || '(none)'}`);
        lines.push(`  Static router ports: ${[...v.staticRouterPorts].join(' ') || '(none)'}`);
      }
      return lines.join('\n');
    });
    trie.registerGreedy('display pim-snooping', 'Display PIM snooping state', (args) => {
      const agent = this.pimSnoopingAgentOrNull();
      if (!agent) return '';
      const cfg = agent.getConfig();
      if (args[0] === 'neighbor') {
        const rows: string[] = [];
        for (const v of agent.listVlans()) {
          for (const n of v.neighbors.values()) {
            rows.push(` VLAN ID: ${v.vlan}`);
            rows.push(`  Neighbor: ${n.neighborIp}`);
            rows.push(`  Port: ${n.port}`);
          }
        }
        return rows.length ? rows.join('\n') : 'Info: No PIM neighbor is found.';
      }
      if (args[0] === 'group') {
        const rows: string[] = [];
        for (const { vlan, group } of agent.listGroups()) {
          rows.push(` Group address: ${group.groupAddress}`);
          rows.push(`  VLAN ID: ${vlan}`);
          rows.push(`  Member ports: ${[...group.members.keys()].join(' ') || '(none)'}`);
        }
        return rows.length ? rows.join('\n') : 'Info: No multicast group entry is found.';
      }
      const vlans = agent.listVlans();
      if (!cfg.enabled || vlans.length === 0) return 'Info: PIM snooping is not enabled on any VLAN.';
      const lines: string[] = [];
      for (const v of vlans) {
        lines.push(`VLAN ID: ${v.vlan}`);
        lines.push(`  PIM snooping: ${v.enabled ? 'enabled' : 'disabled'}`);
        lines.push(`  Router ports: ${[...v.routerPorts].join(' ') || '(none)'}`);
        lines.push(`  Neighbors: ${v.neighbors.size}`);
        lines.push(`  Groups: ${v.groups.size}`);
      }
      return lines.join('\n');
    });
    trie.registerGreedy('display trunkmembership', 'Display Eth-Trunk membership', (args) => {
      const mots = args.join(' ').trim().replace(/\s+/g, ' ').split(' ');
      const id = Number(mots[mots.length - 1]);
      if (!Number.isInteger(id)) return HUAWEI_ERRORS.INCOMPLETE('display trunkmembership');
      return this.displayTrunkMembership(id);
    });

    trie.registerGreedy('display eth-trunk', 'Display Eth-Trunk information', (args) => {
      const id = parseInt(args[0] ?? '', 10);
      if (isNaN(id)) {
        if (this.ethTrunks.size === 0) return 'Info: No Eth-Trunk is configured.';
        return [...this.ethTrunks.keys()].map(k => this.displayEthTrunk(k)).join('\n\n');
      }
      return this.displayEthTrunk(id);
    });
    trie.registerGreedy('display lacp statistics', 'Display LACP statistics', (args) => {
      if (!this.swRef) return '';
      const agent = this.swRef?.getLacpAgent?.();
      if (!agent) return 'Info: LACP is not running.';
      const filterArg = args.join(' ');
      const filterPort = filterArg ? this.resolveInterfaceName(filterArg) : null;
      const ports = filterPort
        ? [filterPort]
        : agent.getAllGroups().flatMap(g => g.members.map(m => m.portName));
      if (ports.length === 0) return 'Info: No Eth-Trunk is configured.';
      const blocks = ports.map((p) => {
        const stats = agent.getStatistics(p);
        const marqueur = agent.getMarkerStatistics(p);
        return [
          p,
          '                        LACPDU               Marker',
          '             Sent       Received   Sent       Received',
          `             ${String(stats.sent).padEnd(11)}${String(stats.received).padEnd(11)}`
          + `${String(marqueur.responseSent).padEnd(11)}${marqueur.received}`,
        ].join('\n');
      });
      return blocks.join('\n\n');
    });
    trie.registerGreedy('display counters', 'Display interface counters', (args) => {
      if (!this.swRef) return '';
      const ifName = args.filter(a => /\d\/\d/.test(a)).join(' ');
      const port = ifName ? (this.resolveInterfaceName(ifName) || ifName) : 'all interfaces';
      return [
        `Interface counters (${port}):`,
        '  Input :  0 packets,  0 bytes,  0 errors',
        '  Output:  0 packets,  0 bytes,  0 errors',
      ].join('\n');
    });
    trie.registerGreedy('reset counters', 'Clear interface counters', () =>
      ''); // acknowledged, no output (matches VRP)

    // Sub-keywords parsed inside greedy display handlers, surfaced to
    // Tab/`?` completion. Additive — execution is unchanged.
    trie.addCompletionKeywords('display interface', [
      { keyword: 'brief', description: 'Brief interface summary' },
    ]);
    trie.addCompletionKeywords('display vlan', [
      { keyword: 'summary', description: 'VLAN summary' },
    ]);
    trie.addCompletionKeywords('display mac-address', [
      { keyword: 'vlan', description: 'Entries for a given VLAN' },
    ]);
  }

  /**
   * VRP lifecycle / management commands common to every view + the
   * router shell (save, reboot, reset, commit, screen-length, header).
   * Single source via huawei/HuaweiCommonConfig (DRY).
   */
  private registerCommonMgmt(trie: CommandTrie): void {
    registerHuaweiCommonMgmt(
      trie,
      { service: () => this.debugService(), platform: 'switch' },
      () => { if (this.swRef) this.swRef._captureStartupConfig(this.displayCurrentConfig(this.swRef)); },
      () => { this.swRef?._eraseStartupConfig(); },
    );
  }

  // ─── STP / RSTP / MSTP (switch-only, L2) ──────────────────────────

  /** System-view `stp …` configuration commands. */
  private registerStpSystemCommands(trie: CommandTrie): void {
    trie.describeArgs('stp', [{
      name: 'option', type: 'ENUM', description: 'Spanning tree parameter',
      validator: () => true,
      values: STP_SYSTEM_KEYWORDS.map(k => ({ ...k })),
    }]);
    trie.registerGreedy('stp', 'Spanning Tree Protocol configuration', (args, ligne) => {
      const g = analyserStp(args, STP_SYSTEME);
      if (g.statut === 'refus') return rendreErreurVrp(g.err, ligne ?? `stp ${args.join(' ')}`);
      const a = g.args.map(x => x.toLowerCase());

      switch (g.mot) {
        case 'enable':
        case 'disable': {
          const on = g.mot === 'enable';
          this.applyToStpAgent(ag => ag.setEnabled(on));
          return '';
        }
        case 'mode': {
          const m = a[0] as 'stp' | 'rstp' | 'mstp';
          this.applyToStpAgent(ag => ag.setMode(m));
          return '';
        }
        case 'priority': {
          const p = parseInt(a[0], 10);
          this.applyToStpAgent(ag => { ag.setRootRole(0, null); ag.setCistPriority(p); });
          return '';
        }
        case 'root': {
          this.applyToStpAgent(ag => ag.setRootRole(0, a[0] as 'primary' | 'secondary'));
          return '';
        }
        case 'instance': {
          const instId = parseInt(a[0], 10);
          if (a[1] === 'root') {
            this.applyToStpAgent(ag =>
              ag.setRootRole(instId, a[2] as 'primary' | 'secondary'));
            return '';
          }
          const p = parseInt(a[2], 10);
          this.applyToStpAgent(ag => {
            ag.setRootRole(instId, null);
            if (instId === 0) ag.setCistPriority(p);
            else ag.setMstInstancePriority(instId, p);
          });
          return '';
        }
        case 'bpdu-protection':
          this.applyToStpAgent(ag => ag.setBpduGuardGlobal(true));
          return '';
        case 'edged-port':
          this.applyToStpAgent(ag => ag.setPortfastDefault(true));
          return '';
        case 'pathcost-standard':
          // Le moteur porte deja ce reglage ; la commande l'ecartait.
          this.applyToStpAgent(ag => ag.setPathcostMethod(a[0] === 'dot1t' ? 'long' : 'short'));
          return '';
        case 'timer': {
          // VRP compte ces trois temporisateurs en CENTIEMES de seconde ;
          // le moteur les tient en secondes. La valeur etait jetee alors
          // que les trois accesseurs existaient.
          const borne = borneTimerStp(a[0]);
          if (!borne) return rendreErreurVrp({ kind: 'wrong', token: g.args[0] }, ligne ?? '');
          const cs = parseInt(a[1], 10);
          if (cs < borne[0] || cs > borne[1]) {
            return rendreErreurVrp({ kind: 'wrong', token: g.args[1] }, ligne ?? '');
          }
          const sec = Math.round(cs / 100);
          this.applyToStpAgent(ag => {
            if (a[0] === 'hello') ag.setHelloSec(sec);
            else if (a[0] === 'forward-delay') ag.setForwardDelaySec(sec);
            else ag.setMaxAgeSec(sec);
          });
          return '';
        }
        case 'tc-protection':
        case 'converge':
          // Acceptes et sans effet : aucun modele derriere. Nomme dans le
          // PRD plutot que masque par un refus qui serait faux.
          return '';
        case 'region-configuration':
          this.mode = 'mst-region';
          return '';
        default:
          return '';
      }
    });
    // L'aide vient de la MEME table que l'analyse : `stp converge ?`
    // rendait un `WORD` et un `<cr>` que la commande refuse, alors que
    // la grammaire dit `fast|normal` depuis toujours.
    declarerAideStp(trie, STP_SYSTEME, 'stp', STP_SYSTEM_KEYWORDS);
  }

  private registerMqcDisplay(trie: CommandTrie): void {
    const sw = () => this.swRef;

    trie.register('display traffic classifier user-defined', 'Display user-defined classifiers', () => {
      const device = sw();
      const noms = device?.getMqcClassifierNames?.() ?? [];
      if (noms.length === 0) return 'Info: Total 0 matched.';
      const lignes: string[] = [];
      for (const nom of noms) {
        lignes.push(`  Classifier: ${nom}`);
        lignes.push('   Operator: or');
        for (const match of device?.getMqcClassifier?.(nom) ?? []) {
          lignes.push(`   ${mqcMatchLine(match).replace(/^if-match /, 'Rule(s) : if-match ')}`);
        }
        lignes.push('');
      }
      lignes.push(`Total classifier number is ${noms.length}`);
      return lignes.join('\n');
    });

    trie.register('display traffic behavior user-defined', 'Display user-defined behaviors', () => {
      const device = sw();
      const noms = device?.getMqcBehaviorNames?.() ?? [];
      if (noms.length === 0) return 'Info: Total 0 matched.';
      const lignes: string[] = [];
      for (const nom of noms) {
        lignes.push(`  Behavior: ${nom}`);
        lignes.push(`   ${device?.getMqcBehavior?.(nom) ?? 'permit'}`);
        const marque = device?.getMqcBehaviorRemark?.(nom);
        if (marque) for (const ligne of mqcRemarkLines(marque)) lignes.push(`   ${ligne}`);
        if (device?.mqcBehaviorHasStatistic?.(nom)) lignes.push('   statistic: enable');
        const car = device?.getMqcBehaviorCar?.(nom);
        if (car) {
          lignes.push(`   Committed Access Rate:`);
          lignes.push(`     CIR ${Math.round(car.bitsPerSecond / 1000)} (Kbps), CBS ${car.normalBurstBytes} (Bytes), PBS ${car.maxBurstBytes} (Bytes)`);
        }
        lignes.push('');
      }
      lignes.push(`Total behavior number is ${noms.length}`);
      return lignes.join('\n');
    });

    trie.register('display traffic policy user-defined', 'Display user-defined policies', () => {
      const device = sw();
      const noms = device?.getMqcPolicyNames?.() ?? [];
      if (noms.length === 0) return 'Info: Total 0 matched.';
      const lignes: string[] = [];
      for (const nom of noms) {
        lignes.push(`  Policy: ${nom}`);
        for (const paire of device?.getMqcPolicy?.(nom) ?? []) {
          lignes.push(`   Classifier: ${paire.classifier}`);
          lignes.push(`    Behavior: ${paire.behavior}`);
        }
        lignes.push('');
      }
      lignes.push(`Total policy number is ${noms.length}`);
      return lignes.join('\n');
    });

    trie.registerGreedy('display traffic policy statistics', 'Per-policy counters', (args) => {
      const device = sw();
      if (!device) return '';
      const points: { label: string; point: string }[] = [];
      const cible = (args[0] ?? '').toLowerCase();
      if (cible === 'interface' && args[1]) {
        const nom = this.resolveInterfaceName(args[1]) ?? args[1];
        points.push({ label: nom, point: nom });
      } else if (cible === 'vlan' && args[1]) {
        points.push({ label: `Vlan ${args[1]}`, point: `vlan${args[1]}` });
      } else {
        return 'Error: Incomplete command.';
      }

      const lignes: string[] = [];
      for (const { label, point } of points) {
        const politique = point.startsWith('vlan')
          ? device.getVlanTrafficPolicy?.(Number.parseInt(point.slice(4), 10))
          : device.getPortTrafficPolicy?.(point);
        if (!politique) return 'Info: The traffic policy is not applied.';
        lignes.push(` Interface: ${label}`);
        lignes.push(` Traffic policy inbound: ${politique}`);
        for (const paire of device.getMqcPolicy?.(politique) ?? []) {
          const compteurs = device.getMqcCounters?.(point, paire.classifier, paire.behavior);
          lignes.push(`  Classifier: ${paire.classifier} Behavior: ${paire.behavior}`);
          if (!compteurs) {
            lignes.push('   (statistics not enabled)');
            continue;
          }
          lignes.push(`   Matched      : ${compteurs.matchedPackets} packets, ${compteurs.matchedBytes} bytes`);
          lignes.push(`    Passed      : ${compteurs.passedPackets} packets, ${compteurs.passedBytes} bytes`);
          lignes.push(`    Dropped     : ${compteurs.droppedPackets} packets, ${compteurs.droppedBytes} bytes`);
        }
      }
      return lignes.join('\n');
    });

    trie.register('display traffic-policy applied-record', 'Where policies are applied', () => {
      const device = sw();
      const lignes: string[] = [];
      for (const nom of device?.getMqcPolicyNames?.() ?? []) {
        const points: string[] = [];
        for (const [id] of device?.getVLANs?.() ?? []) {
          if (device?.getVlanTrafficPolicy?.(id) === nom) {
            points.push(`   Vlan ${id}: inbound`);
          }
        }
        for (const port of device?.getPorts?.() ?? []) {
          const portName = port.getName();
          if (device?.getPortTrafficPolicy?.(portName) === nom) {
            points.push(`   ${portName}: inbound`);
          }
        }
        lignes.push(` Policy Name: ${nom}`);
        lignes.push(...(points.length > 0 ? points : ['   (not applied)']));
      }
      if (lignes.length === 0) return 'Info: Total 0 matched.';
      return lignes.join('\n');
    });
  }

  /** Interface-view `stp …` configuration commands. */
  private registerStpInterfaceCommands(trie: CommandTrie): void {
    trie.describeArgs('stp', [{
      name: 'option', type: 'ENUM', description: 'Spanning tree parameter',
      validator: () => true,
      values: STP_INTERFACE_KEYWORDS.map(k => ({ ...k })),
    }]);
    trie.registerGreedy('stp', 'Interface STP configuration', (args, ligne) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const g = analyserStp(args, STP_INTERFACE);
      if (g.statut === 'refus') return rendreErreurVrp(g.err, ligne ?? `stp ${args.join(' ')}`);
      const a = g.args.map(x => x.toLowerCase());
      const port = this.selectedInterface;

      // La ligne n'est conservee pour `display this` qu'une fois la
      // grammaire admise : elle est REJOUEE a l'import, donc y ranger
      // une forme refusee la ferait tomber au rechargement.
      const list = this.ifStp.get(port) ?? [];
      list.push(`stp ${args.join(' ')}`);
      this.ifStp.set(port, list);

      const actif = a[0] === 'enable' || a[a.length - 1] === 'enable';
      switch (g.mot) {
        case 'edged-port':
          this.applyToStpAgent(ag => ag.setPortFast(port, actif));
          return '';
        case 'bpdu-protection':
          this.applyToStpAgent(ag => ag.setPortBpduGuard(port, actif));
          return '';
        case 'bpdu-filter':
          this.applyToStpAgent(ag => ag.setPortBpduFilter(port, actif));
          return '';
        case 'root-protection':
          this.applyToStpAgent(ag => ag.setPortRootGuard(port, true));
          return '';
        case 'loop-protection':
          this.applyToStpAgent(ag => ag.setPortLoopGuard(port, true));
          return '';
        case 'cost': {
          // `stp [instance <n>] cost <m>` — VRP's spelling of the same knob
          // Cisco writes `spanning-tree [vlan <v>] cost <m>`.
          const cost = parseInt(a[0], 10);
          this.applyToStpAgent(ag => ag.setPortCost(port, cost));
          return '';
        }
        case 'instance': {
          const inst = parseInt(a[0], 10);
          const cost = parseInt(a[2], 10);
          this.applyToStpAgent(ag => ag.setPortCost(port, cost, inst));
          return '';
        }
        case 'port': {
          const priority = parseInt(a[1], 10);
          this.applyToStpAgent(ag => ag.setPortPriority(port, priority));
          return '';
        }
        default:
          return '';
      }
    });
    // L'aide vient de la MEME table que l'analyse : `stp converge ?`
    // rendait un `WORD` et un `<cr>` que la commande refuse, alors que
    // la grammaire dit `fast|normal` depuis toujours.
    declarerAideStp(trie, STP_INTERFACE, 'stp', STP_INTERFACE_KEYWORDS);
  }

  /**
   * Interface-view physical / security config commands. Most are
   * "accept, validate loosely, persist for `display this`" — the L2
   * sim does not model PHY rate negotiation, so storing the intent is
   * the faithful behaviour.
   */
  private registerInterfacePhysicalCommands(trie: CommandTrie): void {
    const record = (line: string, key?: string) => this.recordIfCfg(line, key);
    // Simple keyword commands that take the rest of the line verbatim.
    // L2/physical interface keywords only — an L2 switch port must NOT
    // accept L3 (ip/arp) config, so those are deliberately excluded.
    const portSelectionne = () =>
      this.selectedInterface ? this.swRef?.getPort(this.selectedInterface) : undefined;
    trie.registerGreedy('speed', 'Interface speed', (args) => {
      const port = portSelectionne();
      if (!port) return 'Error: Incomplete command.';
      if (args[0]?.toLowerCase() === 'auto') { port.setNegotiationAuto(true); return ''; }
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n)) return HUAWEI_ERRORS.WRONG(`speed ${args.join(' ')}`);
      try { port.setSpeed(n); } catch { return HUAWEI_ERRORS.WRONG(`speed ${args.join(' ')}`); }
      port.setNegotiationAuto(false);
      return '';
    });
    trie.registerGreedy('duplex', 'Interface duplex', (args) => {
      const port = portSelectionne();
      if (!port) return 'Error: Incomplete command.';
      const a = (args[0] ?? '').toLowerCase();
      if (a === 'auto') { port.setNegotiationAuto(true); return ''; }
      if (a !== 'full' && a !== 'half') return HUAWEI_ERRORS.WRONG(`duplex ${args.join(' ')}`);
      port.setDuplex(a);
      port.setNegotiationAuto(false);
      return '';
    });
    trie.registerGreedy('negotiation', 'Auto-negotiation', (args) => {
      const port = portSelectionne();
      if (!port) return 'Error: Incomplete command.';
      port.setNegotiationAuto(args[0]?.toLowerCase() === 'auto');
      return '';
    });
    trie.registerGreedy('mac-address', 'Interface MAC address configuration', (args, ligne) => {
      const port = this.selectedInterface;
      if (!port || !this.swRef) return HUAWEI_ERRORS.INCOMPLETE(ligne ?? 'mac-address');
      const a = analyserApprentissageMac(args);
      const brut = ligne ?? `mac-address ${args.join(' ')}`;
      if (a.statut === 'refus') {
        return a.token === null
          ? HUAWEI_ERRORS.INCOMPLETE(brut)
          : refuseMotInattenduVrp(brut, a.token);
      }
      this.swRef.setPortMacLearning(port, false, a.action);
      return '';
    });
    trie.addCompletionKeywords('mac-address', [
      { keyword: 'learning', description: 'MAC address learning' },
    ]);
    trie.registerGreedy('undo mac-address', 'Re-enable interface MAC learning', (args, ligne) => {
      const port = this.selectedInterface;
      if (!port || !this.swRef) return HUAWEI_ERRORS.INCOMPLETE(ligne ?? 'undo mac-address');
      const a = analyserApprentissageMac(args);
      const brut = ligne ?? `undo mac-address ${args.join(' ')}`;
      if (a.statut === 'refus') {
        return a.token === null
          ? HUAWEI_ERRORS.INCOMPLETE(brut)
          : refuseMotInattenduVrp(brut, a.token);
      }
      this.swRef.setPortMacLearning(port, true);
      return '';
    });

    trie.registerGreedy('traffic-policy', 'Apply a traffic policy to this port', (args) => {
      if (!this.selectedInterface || !this.swRef || !args[0]) return 'Error: Incomplete command.';
      if (args[1]?.toLowerCase() !== 'inbound') return 'Error: Wrong parameter found.';
      const res = this.swRef.applyPortTrafficPolicy(this.selectedInterface, args[0]);
      if (!res.ok) return `Error: ${res.error}.`;
      return record(`traffic-policy ${args.join(' ')}`.trim(), 'traffic-policy');
    });
    trie.registerGreedy('undo traffic-policy', 'Remove the port traffic policy', () => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      this.swRef.removePortTrafficPolicy(this.selectedInterface);
      return this.removeIfCfg('traffic-policy');
    });

    for (const kw of [
      'flow-control',
      'loopback-detect', 'port-security', 'storm-control',
      'port-mirroring',
      'am',
    ]) {
      trie.registerGreedy(kw, `Interface ${kw} configuration`, (args) =>
        record(`${kw} ${args.join(' ')}`.trim()));
    }

    trie.registerGreedy('jumboframe', 'Interface jumboframe configuration', (args) =>
      record(`jumboframe ${args.join(' ')}`.trim(), 'jumboframe'));

    trie.registerGreedy('qos', 'Interface QoS configuration', (args) => {
      const raw = `qos ${args.join(' ')}`.trim();
      if (args[0]?.toLowerCase() !== 'car') return record(raw);
      if (!this.selectedInterface) return 'Error: Incomplete command.';

      const rule = parseVrpCarRule(args.slice(1), raw);
      if (!rule) return 'Error: Wrong parameter found at \'^\' position.';
      this.swRef?.getCarPolicer(this.selectedInterface, true)?.add(rule);
      return record(raw, 'qos car');
    });

    trie.registerGreedy('undo qos', 'Remove interface QoS configuration', (args) => {
      if (args[0]?.toLowerCase() !== 'car') return this.removeIfCfg('qos');
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      this.swRef?.getCarPolicer(this.selectedInterface)?.clear();
      return this.removeIfCfg('qos car');
    });

    for (const kind of SUPPRESSION_KINDS) {
      const kw = `${kind}-suppression`;
      trie.registerGreedy(kw, `Limit ${kind} traffic on this port`, (args) => {
        const port = portSelectionne();
        if (!port || !this.selectedInterface) return 'Error: Incomplete command.';
        const raw = `${kw} ${args.join(' ')}`.trim();
        const rule = parseSuppressionRule(
          kind, args, port.getEffectiveBandwidthKbps(), raw);
        if (!rule) return 'Error: Wrong parameter found at \'^\' position.';

        const policer = this.swRef?.getSuppressionPolicer(this.selectedInterface, kind, true);
        if (!policer) return 'Error: Incomplete command.';
        policer.clear();
        policer.add(rule);
        return record(raw, kw);
      });
      trie.registerGreedy(`undo ${kw}`, `Remove the ${kind} limit`, () => {
        if (!this.selectedInterface) return 'Error: Incomplete command.';
        this.swRef?.clearSuppression(this.selectedInterface, kind);
        return this.removeIfCfg(kw);
      });
    }

    trie.registerGreedy('mac-limit', 'Interface mac-limit configuration', (args) => {
      const line = `mac-limit ${args.join(' ')}`.trim();
      return record(line, macLimitSettingKey(args));
    });

    // `traffic-filter inbound|outbound acl <number>` binds a real numbered
    // ACL to this port; the switch dataplane consults it on ingress/egress.
    trie.registerGreedy('traffic-filter', 'Apply ACL to this port', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      const direction = args[0]?.toLowerCase();
      if (direction !== 'inbound' && direction !== 'outbound') return 'Error: Expected inbound or outbound.';
      if (args[1]?.toLowerCase() !== 'acl' || !args[2]) return 'Error: Expected "acl".';
      const aclNum = parseInt(args[2], 10);
      if (isNaN(aclNum)) return 'Error: Invalid ACL number.';
      const dir = direction === 'inbound' ? 'in' : 'out';
      this.swRef.getVaclEngine().setInterfaceACL(this.selectedInterface, dir, aclNum);
      return record(`traffic-filter ${args.join(' ')}`.trim());
    });
    trie.registerGreedy('undo traffic-filter', 'Remove ACL from this port', (args) => {
      if (!this.selectedInterface || !this.swRef) return 'Error: Incomplete command.';
      const direction = args[0]?.toLowerCase();
      const dir = direction === 'outbound' ? 'out' : 'in';
      this.swRef.getVaclEngine().removeInterfaceACL(this.selectedInterface, dir);
      return '';
    });
  }

  /**
   * MST region sub-view command tree ([host-mst-region]). The region
   * (name/revision/instance→VLAN map) is owned by the shared StpAgent —
   * the same bridge engine the CIST/MSTI election reads from — not by
   * this CLI session, so the mapping actually affects the live topology.
   */
  private buildMstRegionCommands(): void {
    const t = this.mstRegionTrie;
    t.registerGreedy('region-name', 'Set MST region name', (args) => {
      if (args.length < 1) return 'Error: Incomplete command.';
      this.applyToStpAgent(ag => ag.setMstName(args[0]));
      return '';
    });
    t.registerGreedy('instance', 'Map VLANs to an MST instance', (args) => {
      if (args.length < 3 || args[1].toLowerCase() !== 'vlan') {
        return 'Error: Incomplete command.';
      }
      const id = parseInt(args[0], 10);
      if (isNaN(id)) return 'Error: Wrong parameter found at \'^\' position.';
      this.applyToStpAgent(ag => ag.mapMstInstance(id, args.slice(2).join(' ')));
      return '';
    });
    t.registerGreedy('revision-level', 'Set MST revision level', (args) => {
      const n = parseInt(args[0], 10);
      if (!isNaN(n)) this.applyToStpAgent(ag => ag.setMstRevision(n));
      return '';
    });
    t.register('active region-configuration', 'Activate MST region', () =>
      'Info: This operation may take a few seconds. Please wait for a moment...done.');
    t.register('check region-configuration', 'Check MST region', () => {
      const region = this.stpAgent()?.getMstRegion();
      const lines = [
        `Region Name: ${region?.name ?? ''}`,
        `Revision Level: ${region?.revision ?? 0}`,
        `Instance Vlans Mapped`,
      ];
      for (const [instance, vlans] of region?.instances ?? []) {
        lines.push(`${String(instance).padEnd(8)} ${vlans}`);
      }
      return lines.join('\n');
    });
    t.register('display this', 'Display MST region configuration', () => {
      const lines = vrpStpRegionLines(this.stpAgent());
      if (lines.length === 0) lines.push('stp region-configuration');
      lines.push('#');
      return lines.join('\n');
    });
  }

  /** `display stp` family — rendered from shell-tracked config + ports. */
  private registerStpDisplay(trie: CommandTrie): void {
    trie.register('display stp', 'Display STP status', () => this.displayStp());
    trie.register('display stp global', 'Display STP global info', () => this.displayStp());
    trie.register('display stp brief', 'Display STP brief', () => this.displayStpBrief());
    trie.register('display stp mode', 'Display STP working mode', () =>
      `STP mode: ${(this.stpAgent()?.getMode() ?? 'mstp').toUpperCase()}`);
    trie.register('display stp topology-change', 'Display STP topology changes', () => [
      'CIST topology change information',
      '  Number of topology changes        : 0',
      '  Time since last topology change   : 0 days 0h:0m:0s',
      '  Last topology change port         : -',
    ].join('\n'));
    trie.register('display stp region-configuration', 'Display MST region configuration', () => {
      const region = this.stpAgent()?.getMstRegion();
      const lines = [
        'Oper configuration',
        `  Format selector      :0`,
        `  Region name          :${region?.name || (this.swRef?.getHostname() ?? '')}`,
        `  Revision level       :${region?.revision ?? 0}`,
        '',
        '  Instance   VLANs Mapped',
        '  0          1 to 4094',
      ];
      for (const [id, v] of region?.instances ?? []) lines.push(`  ${String(id).padEnd(11)}${v}`);
      return lines.join('\n');
    });
    trie.registerGreedy('display lldp neighbor', 'Display LLDP neighbours', (args) => {
      if (!this.swRef) return '';
      const ag = this.swRef?.getLldpAgent?.();
      if (!ag) return '';
      const ns = ag.getNeighbors();
      const brief = args.some(a => a.toLowerCase() === 'brief');
      if (brief) {
        const lines = ['Local Intf                Neighbor Dev    Neighbor Intf   Exptime(s)'];
        for (const n of ns) {
          const remain = Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000));
          lines.push(`${n.localPort.padEnd(25)} ${n.systemName.padEnd(15)} ${n.portId.padEnd(15)} ${remain}`);
        }
        lines.push(`Total: ${ns.length}`);
        return lines.join('\n');
      }
      const lines: string[] = [];
      for (const n of ns) {
        lines.push(`${n.localPort} has 1 neighbor(s):`);
        lines.push(`  Neighbor index : 1`);
        lines.push(`  Chassis type   : MAC address`);
        lines.push(`  Chassis ID     : ${n.chassisId}`);
        lines.push(`  Port ID type   : Interface name`);
        lines.push(`  Port ID        : ${n.portId}`);
        lines.push(`  Port description: ${n.portDescription}`);
        lines.push(`  System name    : ${n.systemName}`);
        lines.push(`  System description:`);
        lines.push(`  ${n.systemDescription}`);
        const remain = Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000));
        lines.push(`  Expired time   : ${remain} s`);
        lines.push('');
      }
      lines.push(`Total: ${ns.length}`);
      return lines.join('\n');
    });
    trie.register('display lldp local', 'Display LLDP local info', () => {
      if (!this.swRef) return '';
      const ag = this.swRef?.getLldpAgent?.();
      const cfg = ag?.getConfig();
      return [
        'Local LLDP information:',
        `System name      : ${this.swRef.getHostname()}`,
        `LLDP status      : ${cfg?.enabled ? 'enabled' : 'disabled'}`,
        `Message tx interval : ${cfg?.timerSec ?? 30} s`,
        `Message tx hold-multiplier : ${cfg?.holdtimeMultiplier ?? 4}`,
        `Reinit delay : ${cfg?.reinitDelaySec ?? 2} s`,
      ].join('\n');
    });
    trie.registerGreedy('display stp interface', 'Display STP for an interface', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      return this.displayStpBrief(this.resolveInterfaceName(args.join(' ')) || args.join(' '));
    });
    trie.registerGreedy('display stp instance', 'Display STP for an MST instance', (args) => {
      if (!this.swRef || args.length < 1) return 'Error: Incomplete command.';
      const id = parseInt(args[0], 10);
      if (isNaN(id) || id < 0 || id > 4094) return 'Error: Wrong parameter found.';
      if (id !== 0 && !this.stpAgent()?.getMstRegion().instances.has(id)) {
        return `Error: The instance ${id} does not exist.`;
      }
      return this.displayStpBrief(undefined, id);
    });
  }

  private displayStp(): string {
    const ag = this.swRef?.getStpAgent?.();
    const modeName = (ag?.getMode() ?? 'mstp').toUpperCase();
    const root = ag?.getRootBridge();
    const cfg = ag?.getConfig();
    const rootPort = ag?.getRootPort();
    const own = ag?.ownBridgeId();
    const helloSec = cfg?.helloSec ?? 2;
    const maxAgeSec = cfg?.maxAgeSec ?? 20;
    const fwDelaySec = cfg?.forwardDelaySec ?? 15;
    const rootCost = ag?.getRootPathCost() ?? 0;
    // VRP prints the configured priority: unlike Cisco's per-VLAN trees,
    // MSTP has one CIST, so there is no instance number folded into the
    // low bits to show. The engine carries it (802.1t, for the election
    // and the wire); this view takes it back off.
    const extId = ag?.extendedSystemId() ?? 0;
    const localPrio = (own?.priority ?? ag?.getVlanPriority(1) ?? 32768) - (own ? extId : 0);
    const localMacFmt = this.toHuaweiMac(own?.mac);
    const rootMacFmt = root ? this.toHuaweiMac(root.mac) : localMacFmt;
    const rootPrio = root ? root.priority - extId : localPrio;
    const portNames = this.swRef?.getPortNames() ?? [];
    const rootPortIdx = rootPort ? portNames.indexOf(rootPort) : -1;
    const rootPortId = rootPortIdx >= 0 ? `${rootPortIdx + 1}.${rootPortIdx + 1}` : '0.0';
    return [
      `-------[CIST Global Info][Mode ${modeName}]-------`,
      `CIST Bridge         :${localPrio}.${this.swRef?.getHostname() ?? ''}`,
      `Config Times        :Hello ${helloSec}s MaxAge ${maxAgeSec}s FwDly ${fwDelaySec}s MaxHop 20`,
      `Active Times        :Hello ${helloSec}s MaxAge ${maxAgeSec}s FwDly ${fwDelaySec}s MaxHop 20`,
      `CIST Root/ERPC      :${rootPrio}.${rootMacFmt} / ${rootCost}`,
      `CIST RegRoot/IRPC   :${rootPrio}.${rootMacFmt} / 0`,
      `CIST RootPortId     :${rootPortId}`,
      `BPDU-Protection     :${ag?.getGlobalStp().bpduGuardGlobal ? 'Enabled' : 'Disabled'}`,
      `TC or TCN received  :0`,
      `STP Status          :${ag?.isEnabledStp() ? 'Enabled' : 'Disabled'}`,
    ].join('\n');
  }

  private toHuaweiMac(mac?: string): string {
    if (!mac) return '0000-0000-0000';
    const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase().padStart(12, '0').slice(0, 12);
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  }

  /** `igmp-snooping static-router-port interface <port>` (VLAN view). */
  private applyStaticRouterPort(vlan: number, rest: string[], on: boolean): string {
    const idx = rest.findIndex(s => s.toLowerCase() === 'interface');
    const spec = (idx >= 0 ? rest.slice(idx + 1) : rest).join('').replace(/\s+/g, '');
    if (!spec) return 'Error: Incomplete command.';
    const names = this.swRef?.getPortNames() ?? [];
    const port = names.find(n => n.toLowerCase() === spec.toLowerCase());
    if (!port) return 'Error: Wrong parameter found at \'^\' position.';
    const agent = this.swRef?.getIgmpSnoopingAgent?.();
    agent?.setStaticRouterPort(vlan, port, on);
    return '';
  }

  private pimSnoopingAgentOrNull(): import('@/network/pim-snooping/PimSnoopingAgent').PimSnoopingAgent | null {
    return this.swRef?.getPimSnoopingAgent?.() ?? null;
  }

  private huaweiPortId(portName: string): string {
    const names = this.swRef?.getPortNames() ?? [];
    const idx = names.indexOf(portName);
    return `128.${idx >= 0 ? idx + 1 : 0}`;
  }

  private psecPort() {
    if (!this.swRef || !this.selectedInterface) return null;
    return this.swRef.getPort(this.selectedInterface)?.getPortSecurity() ?? null;
  }

  private parsePsecMac(s: string): MACAddress | null {
    const m = s.match(/^([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})$/);
    try {
      if (!m) return new MACAddress(s);
      const octets = (m[1] + m[2] + m[3]).match(/.{2}/g)!.map((h) => parseInt(h, 16));
      return new MACAddress(octets);
    } catch {
      return null;
    }
  }

  private registerDot1x(): void {
    const it = this.interfaceTrie;
    const portModeMap: Record<string, import('@/network/dot1x/types').Dot1xPortMode> = {
      auto: 'auto',
      'authorized-force': 'force-authorized',
      'unauthorized-force': 'force-unauthorized',
    };
    it.register('dot1x enable', 'Enable 802.1X on this interface', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const iface = this.selectedInterface;
      this.applyToDot1xAgent(a => a.setPortMode(iface, 'auto'));
      this.recordIfCfg('dot1x enable');
      return '';
    });
    it.register('undo dot1x enable', 'Disable 802.1X on this interface', () => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const iface = this.selectedInterface;
      this.applyToDot1xAgent(a => a.setPortMode(iface, 'disabled'));
      return '';
    });
    it.registerGreedy('dot1x port-control', '802.1X port control mode', (args) => {
      if (!this.selectedInterface) return 'Error: Incomplete command.';
      const mode = portModeMap[(args[0] ?? '').toLowerCase()];
      if (!mode) return 'Error: Wrong parameter.';
      const iface = this.selectedInterface;
      this.applyToDot1xAgent(a => a.setPortMode(iface, mode));
      this.recordIfCfg(`dot1x port-control ${args[0].toLowerCase()}`);
      return '';
    });
  }

  private registerPortSecurity(): void {
    const it = this.interfaceTrie;
    it.register('port-security enable', 'Enable port security', () => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      sec.enable();
      this.recordIfCfg('port-security enable');
      return '';
    });
    it.register('undo port-security enable', 'Disable port security', () => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      sec.disable();
      return '';
    });
    it.registerGreedy('port-security max-mac-num', 'Max secure MAC count', (args) => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 1) return 'Error: Wrong parameter.';
      sec.setMaxMACAddresses(n);
      this.recordIfCfg(`port-security max-mac-num ${n}`);
      return '';
    });
    it.registerGreedy('port-security protect-action', 'Violation action', (args) => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      const a = (args[0] ?? '').toLowerCase();
      if (a !== 'protect' && a !== 'restrict' && a !== 'shutdown') return 'Error: Wrong parameter.';
      sec.setViolationMode(a as PortViolationMode);
      this.recordIfCfg(`port-security protect-action ${a}`);
      return '';
    });
    it.registerGreedy('port-security mac-address sticky', 'Sticky secure MAC', (args) => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      if (args.length === 0) {
        sec.enableSticky();
        this.recordIfCfg('port-security mac-address sticky');
        return '';
      }
      const mac = this.parsePsecMac(args[0]);
      if (!mac) return 'Error: Wrong parameter.';
      const vlanIdx = args.indexOf('vlan');
      const vlan = vlanIdx >= 0 ? parseInt(args[vlanIdx + 1] ?? '1', 10) : 1;
      sec.addStickyMAC(mac, isNaN(vlan) ? 1 : vlan);
      return '';
    });
    it.register('undo port-security mac-address sticky', 'Disable sticky', () => {
      const sec = this.psecPort();
      if (!sec) return 'Error: Incomplete command.';
      sec.disableSticky();
      return '';
    });
  }

  private displayPortSecurity(): string {
    if (!this.swRef) return '';
    const header = 'Port-security    MaxMac  Action     Sticky  Secure  Violations  Port';
    const rows: string[] = [];
    for (const name of this.swRef.getPortNames()) {
      const sec = this.swRef.getPort(name)?.getPortSecurity();
      if (!sec || !sec.isEnabled()) continue;
      const action = sec.getViolationMode().padEnd(10);
      const sticky = (sec.isStickyEnabled() ? 'Yes' : 'No').padEnd(6);
      const secure = String(sec.getEntries().length).padEnd(7);
      const viol = String(sec.getViolationCount()).padEnd(11);
      rows.push(`Enabled          ${String(sec.getMaxMACAddresses()).padEnd(7)} ${action} ${sticky}  ${secure} ${viol} ${name}`);
    }
    if (rows.length === 0) return 'Port-security is not enabled on any interface.';
    return [header, ...rows].join('\n');
  }

  /**
   * `display stp brief` / `display stp interface <if>` call this with no
   * `mstid`, and keep reading the legacy mode-aware CST alias (`getPortRole`)
   * unchanged. Only `display stp instance <id>` passes a real MSTI id, in
   * which case the role/state are read from that instance specifically —
   * otherwise every instance would echo the same CST-derived state.
   */
  private displayStpBrief(only?: string, mstid?: number): string {
    if (!this.swRef) return '';
    const ag = this.stpAgent();
    const header = ' MSTID  Port                        Role  STP State     Protection';
    const mst = String(mstid ?? 0).padStart(6);
    const rows: string[] = [];
    for (const p of this.swRef.getPortNames()) {
      if (only && p !== only) continue;
      // CIST (0) spans every region port regardless of VLAN mapping;
      // a named MSTI only lists ports actually carrying one of its VLANs.
      if (mstid !== undefined && mstid !== 0 && !(ag?.portCarriesVlan(p, mstid) ?? true)) continue;
      const st = mstid !== undefined
        ? (ag?.getForwardStateForInstance(mstid, p) ?? this.swRef.getSTPState(p))
        : this.swRef.getSTPState(p);
      const state = mstpStateName(st);
      const r = mstid !== undefined
        ? (ag?.getPortRoleForInstance(mstid, p) ?? 'designated')
        : (ag?.getPortRole(p) ?? 'designated');
      const role = r === 'root' ? 'ROOT' : r === 'alternate' ? 'ALTE'
        : r === 'backup' ? 'BACK' : r === 'disabled' ? 'DISA' : 'DESI';
      const guards = ag?.getPortGuards(p);
      const protection = guards?.bpduGuard ? 'BPDU'
        : guards?.portFast ? 'EDGE' : 'NONE';
      rows.push(`${mst}  ${p.padEnd(27)} ${role}  ${state.padEnd(13)} ${protection}`);
    }
    if (only && rows.length === 0) {
      return `Error: The port ${only} does not exist.`;
    }
    return [header, ...rows].join('\n');
  }

  /** `display this` body for an Eth-Trunk interface view. */

  /**
   * La configuration de la vue COURANTE. En vue systeme la vue courante
   * est la machine, donc tout rendre y est juste ; ailleurs il faut le
   * bloc, et la marche s'arrete sur `#` comme sur toute ligne de premier
   * niveau pour ne pas deborder.
   */
  private renderDisplayThis(): string {
    if (!this.swRef) return '';
    if (this.mode === 'interface' && this.selectedInterface) {
      const etm = this.selectedInterface.match(/^Eth-Trunk(\d+)$/);
      if (etm) return this.displayEthTrunkConfig(parseInt(etm[1], 10));
      return this.displayCurrentConfigInterface(this.swRef, this.selectedInterface);
    }
    if (this.mode === 'vlan' && this.selectedVlan !== null) {
      const tete = `vlan ${this.selectedVlan}`;
      const out: string[] = ['#'];
      let dedans = false;
      for (const l of this.displayCurrentConfig(this.swRef).split('\n')) {
        if (!dedans) { if (l === tete) { dedans = true; out.push(l); } continue; }
        if (l === '#' || (l.length > 0 && !/^\s/.test(l))) break;
        out.push(l);
      }
      out.push('#');
      return out.join('\n');
    }
    return this.displayCurrentConfig(this.swRef);
  }

  private displayEthTrunkConfig(id: number): string {
    const t = this.ethTrunks.get(id);
    if (!t) return `Error: The Eth-Trunk ${id} does not exist.`;
    const lines = [`interface Eth-Trunk${id}`, ...t.cfg.map(c => ` ${c}`)];
    lines.push('#');
    return lines.join('\n');
  }

  /** `display eth-trunk <id>` — bundle summary + member list. */
  private displayEthTrunk(id: number): string {
    const t = this.ethTrunks.get(id);
    if (!t) return `Error: The Eth-Trunk ${id} does not exist.`;
    const agent = this.swRef?.getLacpAgent?.();
    const liveMembers = agent ? agent.getGroupMembers(id) : [];
    const liveByPort = new Map(liveMembers.map(m => [m.portName, m] as const));
    const upCount = liveMembers.filter(m => m.bundled).length;
    const operate = upCount > 0 ? 'up' : 'down';
    const hash = hashArithmeticVrp(t.loadBalance || agent?.getLoadBalance() || 'src-dst-ip');
    const entete = `Eth-Trunk${id}'s state information is:`;
    const limites = agent?.getGroupLimits(id)
      ?? { minLinks: 0, maxLinks: 0, preempt: true, preemptDelay: 30 };
    const compte = `Least Active-linknumber: ${limites.minLinks || 1}`
      + `  Max Active-linknumber: ${limites.maxLinks || t.members.length || 8}`;
    const etat = `Operate status: ${operate}  Number Of Up Ports In Trunk: ${upCount}`;
    const tiret = '-'.repeat(80);

    if (!t.mode.startsWith('lacp')) {
      return [
        entete,
        `WorkingMode: ${t.mode.toUpperCase()}  Hash arithmetic: ${hash}`,
        compte,
        etat,
        tiret,
        'PortName                      Status      Weight',
        ...t.members.map(m => {
          const info = liveByPort.get(m);
          const status = info?.selected ? 'Selected' : 'Unselect';
          return `${m.padEnd(30)}${status.padEnd(12)}1`;
        }),
      ].join('\n');
    }

    const cfg = agent?.getConfig();
    const lignes = [
      entete,
      'Local:',
      `LAG ID: ${id}  WorkingMode: ${t.mode.toUpperCase()}`,
      `Preempt Delay: ${limites.preempt ? limites.preemptDelay : 'Disabled'}`
      + `  Hash arithmetic: ${hash}`,
      `System Priority: ${cfg?.systemPriority ?? 32768}`
      + `  System ID: ${vrpMacFormat(cfg?.systemId ?? '00:00:00:00:00:00')}`,
      compte,
      etat,
      tiret,
      'ActorPortName                Status   PortType PortPri PortNo PortKey PortState Weight',
    ];
    for (const m of t.members) {
      const info = liveByPort.get(m);
      const etatActeur = info
        ? buildActorState(info.mode, info, agent?.rateOf(info) ?? false) : 0;
      lignes.push(
        `${m.padEnd(29)}${(info?.selected ? 'Selected' : 'Unselect').padEnd(9)}`
        + `${portTypeVrp(m).padEnd(9)}${String(info?.portPriority ?? 32768).padEnd(8)}`
        + `${String(this.numeroPortVrp(m)).padEnd(7)}${String(id).padEnd(8)}`
        + `${lacpStateBits(etatActeur).padEnd(10)}1`);
    }
    lignes.push('', 'Partner:', tiret,
      'ActorPortName                SysPri   SystemID        PortPri PortNo PortKey PortState');
    for (const m of t.members) {
      const p = liveByPort.get(m)?.partner;
      lignes.push(
        `${m.padEnd(29)}${String(p?.systemPriority ?? 0).padEnd(9)}`
        + `${vrpMacFormat(p?.systemId ?? '00:00:00:00:00:00').padEnd(16)}`
        + `${String(p?.portPriority ?? 0).padEnd(8)}${String(p?.portNumber ?? 0).padEnd(7)}`
        + `${String(p?.key ?? 0).padEnd(8)}${lacpStateBits(p?.state ?? 0)}`);
    }
    return lignes.join('\n');
  }

  /** `display interface Eth-Trunk <id>` — the trunk as an interface. */
  private displayEthTrunkInterface(id: number): string {
    const t = this.ethTrunks.get(id);
    if (!t) return `Error: Wrong parameter found at '^' position.`;
    const sw = this.swRef;
    const agent = sw?.getLacpAgent?.();
    const live = new Map((agent ? agent.getGroupMembers(id) : [])
      .map(m => [m.portName, m] as const));
    const montes = t.members.filter(m => sw?.getPort(m)?.isOperationallyUp());
    const actifs = t.mode.startsWith('lacp')
      ? t.members.filter(m => live.get(m)?.bundled) : montes;
    const up = actifs.length > 0;
    const debit = actifs.reduce(
      (total, m) => total + (sw?.getPort(m)?.getNegotiatedSpeed() ?? 0), 0);
    const hash = hashArithmeticVrp(t.loadBalance || agent?.getLoadBalance() || 'src-dst-ip');
    const tiret = '-'.repeat(80);
    return [
      `Eth-Trunk${id} current state : ${up ? 'UP' : 'DOWN'}`,
      `Line protocol current state : ${up ? 'UP' : 'DOWN'}`,
      `Description:`,
      `Switch Port, Hash arithmetic : ${hash}, Maximal BW: ${vrpBandwidth(debit)}, `
      + `Current BW: ${vrpBandwidth(debit)}, The Maximum Frame Length is 9216`,
      `IP Sending Frames' Format is PKTFMT_ETHNT_2, `
      + `Hardware address is ${vrpMacFormat(String(sw?.getBridgeMac() ?? '00:00:00:00:00:00'))}`,
      tiret,
      'PortName                      Status      Weight',
      tiret,
      ...t.members.map(m => `${m.padEnd(30)}`
        + `${(actifs.includes(m) ? 'UP' : 'DOWN').padEnd(12)}1`),
      tiret,
      `The Number of Ports in Trunk : ${t.members.length}`,
      `The Number of UP Ports in Trunk : ${actifs.length}`,
    ].join('\n');
  }

  private numeroPortVrp(nom: string): number {
    return (this.swRef?.getPortNames() ?? []).indexOf(nom) + 1;
  }

  /**
   * `display trunkmembership eth-trunk <id>` — the membership view,
   * which names each port's own state rather than the bundle's.
   */
  private displayTrunkMembership(id: number): string {
    const t = this.ethTrunks.get(id);
    if (!t) return `Error: The Eth-Trunk ${id} does not exist.`;
    const agent = this.swRef?.getLacpAgent?.();
    const live = new Map((agent ? agent.getGroupMembers(id) : [])
      .map(m => [m.portName, m] as const));
    const lignes = [
      `Trunk ID: ${id}`,
      `Used status: ${t.members.length > 0 ? 'VALID' : 'INVALID'}`,
      `TYPE: ethernet`,
      `Working Mode : ${t.mode.startsWith('lacp') ? 'Static' : 'Normal'}`,
      `Number Of Ports in Trunk = ${t.members.length}`,
      `Number Of Up Ports in Trunk = ${[...live.values()].filter(m => m.bundled).length}`,
      '',
    ];
    for (const m of t.members) {
      const port = this.swRef?.getPort(m);
      lignes.push(`Interface ${m}, valid, `
        + `${port?.isOperationallyUp() ? 'operate up' : 'operate down'}, `
        + `weight = 1`);
    }
    return lignes.join('\n');
  }

  // ─── Undo Command ────────────────────────────────────────────────

  private undoMacAddress(reste: readonly string[], brut: string): string {
    const sw = this.swRef;
    if (!sw) return HUAWEI_ERRORS.INCOMPLETE(brut);
    const sub = (reste[0] ?? '').toLowerCase();
    if (sub === 'aging-time') {
      sw.setMACAgingTime(VRP_MAC_AGING_DEFAUT);
      return '';
    }
    if (sub !== 'static' && sub !== 'blackhole') {
      return reste.length === 0
        ? HUAWEI_ERRORS.INCOMPLETE(brut)
        : refuseMotInattenduVrp(brut, reste[0]);
    }
    if (reste.length === 1) {
      for (const e of sw.getMACTable()) {
        if (e.type !== sub) continue;
        if (sub === 'static') sw.removeStaticMAC(e.mac, e.vlan);
        else sw.removeBlackholeMAC(e.mac, e.vlan);
      }
      return '';
    }
    const a = analyserMacAddress(reste);
    if (a.statut === 'static') {
      return sw.removeStaticMAC(a.mac, a.vlan) ? '' : 'Error: The MAC address entry does not exist.';
    }
    if (a.statut === 'blackhole') {
      return sw.removeBlackholeMAC(a.mac, a.vlan) ? '' : 'Error: The MAC address entry does not exist.';
    }
    const mac = normaliserMacVrp(reste[1] ?? '');
    if (mac) {
      let retire = false;
      for (const e of sw.getMACTable()) {
        if (e.type !== sub || e.mac !== mac) continue;
        retire = (sub === 'static' ? sw.removeStaticMAC(e.mac, e.vlan) : sw.removeBlackholeMAC(e.mac, e.vlan)) || retire;
      }
      return retire ? '' : 'Error: The MAC address entry does not exist.';
    }
    return a.statut === 'refus' && a.token !== null
      ? refuseMotInattenduVrp(brut, a.token)
      : HUAWEI_ERRORS.INCOMPLETE(brut);
  }

  private undoStpSysteme(reste: readonly string[]): string {
    const sub = (reste[0] ?? '').toLowerCase();
    switch (sub) {
      case '':
      case 'enable':
        this.applyToStpAgent(ag => ag.setEnabled(false));
        return '';
      case 'disable':
        this.applyToStpAgent(ag => ag.setEnabled(true));
        return '';
      case 'mode':
        this.applyToStpAgent(ag => ag.setMode('mstp'));
        return '';
      case 'priority':
        this.applyToStpAgent(ag => { ag.setRootRole(0, null); ag.setCistPriority(32768); });
        return '';
      case 'root':
        this.applyToStpAgent(ag => ag.setRootRole(0, null));
        return '';
      case 'instance': {
        const id = parseInt(reste[1] ?? '', 10);
        if (isNaN(id)) return HUAWEI_ERRORS.WRONG(`undo stp ${reste.join(' ')}`);
        const quoi = (reste[2] ?? '').toLowerCase();
        this.applyToStpAgent(ag => {
          ag.setRootRole(id, null);
          if (quoi === 'root') return;
          if (id === 0) ag.setCistPriority(32768);
          else ag.clearMstInstancePriority(id);
        });
        return '';
      }
      case 'bpdu-protection':
        this.applyToStpAgent(ag => ag.setBpduGuardGlobal(false));
        return '';
      case 'edged-port':
        this.applyToStpAgent(ag => ag.setPortfastDefault(false));
        return '';
      case 'pathcost-standard':
        this.applyToStpAgent(ag => ag.setPathcostMethod('long'));
        return '';
      case 'timer': {
        const quoi = (reste[1] ?? '').toLowerCase();
        this.applyToStpAgent(ag => {
          if (quoi === 'hello') ag.setHelloSec(2);
          else if (quoi === 'forward-delay') ag.setForwardDelaySec(15);
          else if (quoi === 'max-age') ag.setMaxAgeSec(20);
        });
        return '';
      }
      case 'region-configuration':
        this.applyToStpAgent(ag => ag.applyMstRegion('', 0, []));
        return '';
      default:
        return refuseMotInattenduVrp(`undo stp ${reste.join(' ')}`, reste[0] ?? 'stp');
    }
  }

  private cmdUndo(args: string[]): string {
    if (args.length < 1 || !this.swRef) return 'Error: Incomplete command.';

    if (args[0].toLowerCase() === 'vlan') {
      if (args.length < 2) return 'Error: Incomplete command.';
      const id = parseInt(args[1], 10);
      if (isNaN(id)) return 'Error: Wrong parameter.';
      if (id === 1) return 'Error: Default VLAN 1 cannot be deleted.';
      return this.swRef.deleteVLAN(id) ? '' : `Error: VLAN ${id} does not exist.`;
    }

    if (args[0].toLowerCase() === 'shutdown') {
      if (this.selectedInterface) {
        const port = this.swRef.getPort(this.selectedInterface);
        if (port) port.setUp(true);
        return '';
      }
      return '';
    }

    if (args[0].toLowerCase() === 'description') {
      if (this.mode === 'interface' && this.selectedInterface) {
        this.swRef.setInterfaceDescription(this.selectedInterface, '');
      } else if (this.mode === 'vlan' && this.selectedVlan !== null) {
        this.vlanDesc.delete(this.selectedVlan);
      }
      return '';
    }

    if (args[0].toLowerCase() === 'stp' && this.mode === 'interface' && this.selectedInterface) {
      const port = this.selectedInterface;
      const sub = (args[1] ?? '').toLowerCase();
      if (sub === 'edged-port') this.applyToStpAgent(ag => ag.setPortFast(port, false));
      else if (sub === 'bpdu-protection') this.applyToStpAgent(ag => ag.setPortBpduGuard(port, false));
      else if (sub === 'bpdu-filter') this.applyToStpAgent(ag => ag.setPortBpduFilter(port, false));
      else if (sub === 'root-protection') this.applyToStpAgent(ag => ag.setPortRootGuard(port, false));
      else if (sub === 'loop-protection') this.applyToStpAgent(ag => ag.setPortLoopGuard(port, false));
      this.ifStp.set(port, (this.ifStp.get(port) ?? [])
        .filter(l => l.split(/\s+/)[1]?.toLowerCase() !== sub));
      return '';
    }

    if (args[0].toLowerCase() === 'stp' && this.mode === 'system') {
      return this.undoStpSysteme(args.slice(1));
    }

    if (args[0].toLowerCase() === 'mac-address' && this.mode === 'system') {
      return this.undoMacAddress(args.slice(1), `undo ${args.join(' ')}`);
    }

    // VRP accepts `undo` of essentially any prior config. The L2 sim
    // doesn't reverse every feature's datapath, but the command must be
    // recognised (returning an error here derails command sequences).
    return '';
  }

  // ─── Display Implementations ──────────────────────────────────────

  private displayVersion(sw: Switch): string {
    return [
      'Huawei Versatile Routing Platform Software',
      'VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)',
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      `BOARD TYPE:          S5720-28X-LI-AC`,
      `CPLD Version:        1.0`,
      `BootROM Version:     1.0`,
      `${sw.getHostname()} uptime is 0 days, 0 hours, 0 minutes`,
    ].join('\n');
  }

  private displayVlan(sw: Switch): string {
    const vlans = sw.getVLANs();
    const configs = sw._getSwitchportConfigs();

    const lines = [
      'VLAN ID  Name                          Status   Ports',
      '-------  ----------------------------  -------  ----------------------------',
    ];

    for (const [id, vlan] of vlans) {
      const name = vlan.name.padEnd(30);
      const portsInVlan: string[] = [];
      for (const [portName, cfg] of configs) {
        if (cfg.mode === 'access' && cfg.accessVlan === id) {
          portsInVlan.push(portName);
        } else if (cfg.mode === 'trunk' && cfg.trunkAllowedVlans.has(id)) {
          portsInVlan.push(portName);
        } else if (cfg.mode === 'hybrid'
          && (cfg.hybridUntaggedVlans?.has(id) || cfg.hybridTaggedVlans?.has(id))) {
          portsInVlan.push(portName);
        }
      }
      const portsStr = portsInVlan.join(', ');
      lines.push(`${String(id).padEnd(9)}${name}active   ${portsStr}`);
    }

    return lines.join('\n');
  }

  private displayInterfaceBrief(sw: Switch, filtre?: string): string {
    const retenues = this.filtrerInterfaces(this.lignesInterface(sw), filtre);
    return typeof retenues === 'string' ? retenues : rendreInterfaceBrief(retenues);
  }

  private displayInterfaceDescription(sw: Switch, filtre?: string): string {
    const retenues = this.filtrerInterfaces(this.lignesInterface(sw), filtre);
    return typeof retenues === 'string' ? retenues : rendreInterfaceDescription(retenues);
  }

  /**
   * Les lignes de la famille « brief ». Le commutateur calculait son
   * etat a la main — une HUITIEME facon —, si bien que `*down` n'y
   * existait pas : un port ferme par l'operateur s'y montrait `down`
   * comme un port sans cable. Ses colonnes `PHY` et `Protocol` etaient
   * de surcroit la MEME expression, donc incapables de differer.
   *
   * Il n'y listait pas non plus ses interfaces virtuelles, alors que sa
   * propre vue `display ip interface brief` les liste.
   */
  private lignesInterface(sw: Switch): LigneInterface[] {
    const ports = sw._getPortsInternal();
    const out: LigneInterface[] = [];
    for (const [nom, port] of ports) {
      const st = iosInterfaceStatus(port, nom, ports);
      out.push({
        nom: huaweiDisplayInterfaceName(nom),
        physique: st.status === 'administratively down' ? '*down' : st.status,
        protocole: st.protocol,
        description: sw.getInterfaceDescription(nom) || '',
      });
    }
    for (const lb of sw.getLoopbacks()) {
      out.push({ nom: lb.name, physique: 'up', protocole: 'up', description: '' });
    }
    return out;
  }

  private filtrerInterfaces(
    lignes: LigneInterface[], filtre?: string,
  ): LigneInterface[] | string {
    if (!filtre) return lignes;
    const cible = this.resolveInterfaceName(filtre);
    if (!cible) return `Error: Wrong parameter found at '^' position.`;
    return lignes.filter((l) => l.nom === huaweiDisplayInterfaceName(cible));
  }


  private displayInterface(sw: Switch, ifName: string): string {
    // Le repli `|| ifName` renvoyait la saisie TELLE QUELLE : d'ou
    // `vlanif10 current state` sur une machine ou toutes les autres vues
    // ecrivent `Vlanif10`, et un refus pour la forme separee.
    const portName = this.resolveInterfaceName(ifName);
    if (!portName) return `Error: Wrong parameter found at '^' position.`;
    const port = sw.getPort(portName);
    const vlanIfMatch = portName.match(/^Vlanif(\d+)$/i);
    const isVlanif = vlanIfMatch !== null;
    const svi = isVlanif ? sw.getSvi(parseInt(vlanIfMatch[1], 10)) : undefined;
    const lineUp = isVlanif
      ? (svi ? sw.isSviLineUp(svi) : false)
      : !!(port?.isConnected());
    const adminUp = isVlanif ? !!svi?.adminUp : !!port?.getIsUp();
    const desc = port ? (sw.getInterfaceDescription(portName) || '') : '';
    const stateLine = `${portName} current state : ${adminUp ? (lineUp ? 'UP' : 'DOWN') : 'Administratively DOWN'}`;
    const protoLine = `Line protocol current state : ${lineUp ? 'UP' : 'DOWN'}`;

    if (!port && !isVlanif) return `Error: Wrong parameter found at '^' position.`;

    const lines = [
      stateLine,
      protoLine,
      `Description: ${desc}`,
      `The Maximum Transmit Unit is 1500`,
    ];
    if (isVlanif && svi?.ip && svi.mask) {
      lines.push(
        `Internet Address is ${svi.ip}/${svi.mask.toCIDR()}`,
        `IP Sending Frames' Format is PKTFMT_ETHNT_2, Hardware address is ${sw.getBridgeMac()}`,
      );
      for (const helper of svi.helperAddresses) {
        lines.push(`DHCP relay server-ip ${helper}`);
      }
    } else {
      lines.push(`Internet protocol processing : disabled`);
    }
    lines.push(
      `Input:  0 packets, 0 bytes`,
      `Output: 0 packets, 0 bytes`,
    );
    for (const natLine of runningConfigNATHuawei(commeRouteur(sw), portName)) lines.push(natLine);
    return lines.join('\n');
  }

  private displayQos(sw: Switch, ifName?: string): string {
    const ports = sw._getPortsInternal();
    const names = ifName ? [this.resolveInterfaceName(ifName) || ifName] : [...ports.keys()];

    const lines: string[] = [];
    for (const portName of names) {
      const cfg = sw.getSwitchportConfig(portName);
      if (!cfg) {
        if (ifName) return `Error: Wrong parameter found at '^' position.`;
        continue;
      }
      const trust = cfg.trustMode ?? 'untrusted';
      const trustLabel = trust === 'cos' ? 'trust dot1p' : trust === 'dscp' ? 'trust dscp' : 'trust none';
      lines.push(`${portName} port priority information:`);
      lines.push(`  ${trustLabel}`);
      lines.push(`  Port priority : ${cfg.defaultCos ?? 0}`);
      if (cfg.priorityExtend?.mode === 'trust') {
        lines.push(`  Trust upstream : enabled`);
      }
    }
    return lines.join('\n');
  }

  private displayMacAddress(entries: readonly import('../Switch').MACTableEntry[]): string {
    const lines = [
      'MAC address table of slot 0:',
      '-------------------------------------------------------------------------------',
      rendreMacAddress([])[0],
      '-------------------------------------------------------------------------------',
    ];

    if (entries.length === 0) {
      lines.push('No entries found.');
    } else {
      for (const e of entries) {
        lines.push(...rendreMacAddress([{
          mac: huaweiMacAddress(e.mac), vlan: String(e.vlan),
          port: e.type === 'blackhole' ? '-' : huaweiDisplayInterfaceName(e.port),
          type: e.type,
        }]).slice(1));
      }
    }

    lines.push('-------------------------------------------------------------------------------');
    lines.push(`Total items displayed = ${entries.length}`);
    return lines.join('\n');
  }

  private displayMacAgingTime(sw: Switch): string {
    return `Aging time: ${sw.getMACAgingTime()} seconds`;
  }

  private displayDhcpSnoopingUserBind(sw: Switch): string {
    const bindings = sw._getSnoopingBindings();
    const lines = [
      ' MAC Address    IP Address       Lease            Type       VLAN  Interface',
      '----------------------------------------------------------------------------',
    ];
    for (const b of bindings) {
      lines.push(
        ` ${b.macAddress.padEnd(15)}${b.ipAddress.padEnd(17)}${String(b.lease).padEnd(17)}${b.type.padEnd(11)}${String(b.vlan).padEnd(6)}${b.port}`,
      );
    }
    lines.push('----------------------------------------------------------------------------');
    lines.push(`Print count: ${bindings.length}`);
    lines.push(`Total count: ${bindings.length}`);
    return lines.join('\n');
  }


  /**
   * Les familles globales que la configuration ne portait pas.
   *
   * Chacune etait acceptee, plusieurs etaient honorees — le snooping
   * repond dans sa vue, le port d'observation dans la sienne, la route
   * statique est dans la table — et aucune ne survivait a un
   * `display current-configuration`, donc a un rechargement de topologie.
   */
  private mqcRunningConfigBlocks(sw: HuaweiSwitchDevice): string[][] {
    const blocs: string[][] = [];
    for (const nom of sw.getMqcClassifierNames?.() ?? []) {
      const corps = (sw.getMqcClassifier?.(nom) ?? []).map(m => ` ${mqcMatchLine(m)}`);
      blocs.push([`traffic classifier ${nom}`, ...corps]);
    }
    for (const nom of sw.getMqcBehaviorNames?.() ?? []) {
      const corps = [` ${sw.getMqcBehavior?.(nom) ?? 'permit'}`];
      const car = sw.getMqcBehaviorCar?.(nom);
      if (car) corps.push(` ${car.raw}`);
      const marque = sw.getMqcBehaviorRemark?.(nom);
      if (marque) for (const ligne of mqcRemarkLines(marque)) corps.push(` ${ligne}`);
      if (sw.mqcBehaviorHasStatistic?.(nom)) corps.push(' statistic enable');
      blocs.push([`traffic behavior ${nom}`, ...corps]);
    }
    for (const nom of sw.getMqcPolicyNames?.() ?? []) {
      const corps = (sw.getMqcPolicy?.(nom) ?? [])
        .map(p => ` classifier ${p.classifier} behavior ${p.behavior}`);
      blocs.push([`traffic policy ${nom}`, ...corps]);
    }
    return blocs;
  }

  private globalRunningConfigBlocks(sw: HuaweiSwitchDevice): string[][] {
    const blocs: string[][] = [...this.mqcRunningConfigBlocks(sw)];
    const sec = sw.getSecurityService();

    const dhcp: string[] = [];
    if (sec.isDhcpEnabled()) dhcp.push('dhcp enable');
    if (sec.isDhcpSnoopingEnabled()) {
      dhcp.push('dhcp snooping enable');
      const vlans = sec.getDhcpSnoopingVlans();
      if (vlans.length > 0) {
        dhcp.push(`dhcp snooping enable vlan ${[...vlans].sort((a, b) => a - b).join(' ')}`);
      }
    }
    for (const trust of sec.getDhcpSnoopingTrust()) {
      if (trust.trusted) dhcp.push(`dhcp snooping trust interface ${trust.ifName}`);
    }
    if (dhcp.length > 0) blocs.push(dhcp);

    const observation = sw.listMirrorSessions()
      .filter(session => session.destination !== null)
      .map(session => `observe-port ${session.id} interface ${session.destination}`);
    if (observation.length > 0) blocs.push(observation);

    const journal = sw.getManagementService?.().getInfoCenter().toRunningConfig() ?? [];
    if (journal.length > 0) blocs.push([...journal]);

    const routes = sw.getStaticRoutes?.() ?? [];
    const lignesRoutes = routes.map(
      route => `ip route-static ${route.network} ${route.mask} ${route.nextHop}`
        + (route.preference === VRP_STATIC_PREFERENCE ? '' : ` preference ${route.preference}`));
    if (lignesRoutes.length > 0) blocs.push(lignesRoutes);

    const vues = new Map<string, string[]>();
    for (const [label, cfg] of this.userInterfaceExtraConfig) {
      const vue = vrpUserInterfaceHeader(label);
      if (!vue) continue;
      const corps: string[] = [];
      if (cfg.authMode) corps.push(` authentication-mode ${cfg.authMode}`);
      if (cfg.idleTimeoutMin !== undefined) corps.push(` idle-timeout ${cfg.idleTimeoutMin} 0`);
      if (cfg.screenLength !== undefined) corps.push(` screen-length ${cfg.screenLength}`);
      if (cfg.historySize !== undefined) corps.push(` history-command max-size ${cfg.historySize}`);
      if (cfg.acl) corps.push(` acl ${cfg.acl} inbound`);
      if (cfg.authorizationMode) corps.push(` authorization-mode ${cfg.authorizationMode}`);
      for (const u of cfg.users) corps.push(` user ${u}`);
      for (const l of cfg.rawLines) corps.push(` ${l}`);
      vues.set(vue, corps);
    }
    for (const bloc of sw._getVtyLineConfig().all()) {
      const rendu = bloc.renderHuawei();
      const corps = vues.get(rendu[0]) ?? [];
      for (const ligne of rendu.slice(1)) if (!corps.includes(ligne)) corps.push(ligne);
      vues.set(rendu[0], corps);
    }
    for (const [vue, corps] of vues) if (corps.length > 0) blocs.push([vue, ...corps]);

    return blocs;
  }

  private displayCurrentConfig(sw: HuaweiSwitchDevice): string {
    const lines = [
      '#',
      `sysname ${sw.getHostname()}`,
      '#',
    ];

    // VLANs
    for (const [id, vlan] of sw.getVLANs()) {
      if (id === 1) continue;
      lines.push(`vlan ${id}`);
      lines.push(` name ${vlan.name}`);
      // Ces lignes etaient rangees et rendues par personne : la
      // configuration d'un VLAN les perdait, et l'import avec.
      for (const extra of lignesDuVlan(vlan)) lines.push(` ${extra}`);
      const politique = sw.getVlanTrafficPolicy?.(id);
      if (politique) lines.push(` traffic-policy ${politique} inbound`);
      const apprentissage = new Map(sw.getMacLearningDisabledVlans()).get(id);
      if (apprentissage) lines.push(` ${ligneApprentissageMac(apprentissage)}`);
      lines.push('#');
    }

    for (const [id, t] of [...this.ethTrunks.entries()].sort((x, y) => x[0] - y[0])) {
      lines.push(`interface Eth-Trunk${id}`);
      for (const extra of t.cfg) lines.push(` ${extra}`);
      lines.push('#');
    }

    const macLignes = macRunningConfigLines(sw.getMACTable(), sw.getMACAgingTime());
    if (macLignes.length > 0) { lines.push(...macLignes); lines.push('#'); }

    const stpLignes = vrpStpGlobalLines(sw.getStpAgent?.());
    if (stpLignes.length > 0) { lines.push(...stpLignes); lines.push('#'); }
    const regionLignes = vrpStpRegionLines(sw.getStpAgent?.());
    if (regionLignes.length > 0) { lines.push(...regionLignes); lines.push('#'); }

    // Interfaces
    const mgmt = sw.getManagementService?.();
    const snmpLignes = lignesConfigSnmpVrp(sw.getSnmpService?.());
    if (snmpLignes.length > 0) { lines.push(...snmpLignes); lines.push('#'); }
    const stelnet = mgmt?.getStelnet();
    if (stelnet?.enabled) { lines.push('stelnet server enable'); lines.push('#'); }
    const telnet = mgmt?.getTelnet();
    if (telnet?.enabled) { lines.push('telnet server enable'); lines.push('#'); }

    const aclLignes = runningConfigAclLines(
      sw.getVaclEngine().getAccessLists(), sw.getVaclEngine().getDefaultStep?.() ?? 5);
    if (aclLignes.length > 0) lines.push(...aclLignes);

    const lldpGlobal = sw.getLldpAgent?.()?.asRunningConfigLinesVrp() ?? [];
    if (lldpGlobal.length > 0) { lines.push(...lldpGlobal); lines.push('#'); }

    for (const bloc of this.globalRunningConfigBlocks(sw)) {
      lines.push(...bloc); lines.push('#');
    }

    const ports = sw._getPortsInternal();
    const configs = sw._getSwitchportConfigs();
    const descs = sw._getInterfaceDescriptions();
    for (const [portName, port] of ports) {
      const cfg = configs.get(portName);
      if (!cfg) continue;

      lines.push(`interface ${portName}`);
      lines.push(...this.renderSwitchPortLines(sw, portName, port, cfg));
      lines.push('#');
    }

    // Vlanif L3 interfaces (SVIs configured via 'interface Vlanif<N>')
    const svis = sw.getSvis();
    if (svis) {
      for (const svi of svis) {
        const name = `Vlanif${svi.vlan}`;
        lines.push(`interface ${name}`);
        if (svi.dhcpClient) lines.push(' ip address dhcp-alloc');
        else if (svi.ip && svi.mask) lines.push(` ip address ${svi.ip} ${svi.mask}`);
        for (const l of this.renderVlanifVrrpLines(sw, name)) lines.push(l);
        for (const natLine of runningConfigNATHuawei(commeRouteur(sw), name)) lines.push(natLine);
        lines.push('#');
      }
    }

    lines.push(...portGroupRunningConfigLines(sw.getPortGroups?.() ?? []));

    // Global NAT block — any NAT entries not bound to a per-interface section above.
    const engine = moteurNat(sw);
    if (engine) {
      for (const e of engine.getStaticEntries()) {
        if (e.protocol) {
          lines.push(`nat server protocol ${e.protocol} global ${e.globalIP} ${e.globalPort} inside ${e.localIP} ${e.localPort}`);
        } else {
          lines.push(`nat static global ${e.globalIP} inside ${e.localIP}`);
        }
      }
      for (const [, p] of engine.getPools()) {
        lines.push(`nat address-group ${p.name} ${p.startIP} ${p.endIP}`);
      }
      if (engine.getStaticEntries().length || engine.getPools().size) lines.push('#');
    }

    lines.push('return');
    return lines.join('\n');
  }

  private renderVlanifVrrpLines(sw: Switch, iface: string): string[] {
    return lignesConfigVrrp(sw.getVrrpAgent().listGroups(), iface);
  }

  private displayCurrentConfigInterface(sw: HuaweiSwitchDevice, ifName: string): string {
    const portName = this.resolveInterfaceName(ifName) || ifName;
    const vlanIfMatch = portName.match(/^Vlanif(\d+)$/i);
    if (vlanIfMatch) {
      const svi = sw.getSvi(parseInt(vlanIfMatch[1], 10));
      const out = [`interface ${portName}`];
      if (svi?.ip && svi.mask) {
        out.push(` ip address ${svi.ip} ${svi.mask}`);
      }
      if (svi && !svi.adminUp) out.push(` shutdown`);
      // Lot V15 : cette vue-ci ne rendait aucune ligne `vrrp` alors que
      // la configuration complete les rendait toutes — l'exact miroir du
      // desaccord mesure cote routeur.
      out.push(...this.renderVlanifVrrpLines(sw, portName));
      out.push('#');
      return out.join('\n');
    }
    const port = sw.getPort(portName);
    const cfg = sw.getSwitchportConfig(portName);
    if (!port || !cfg) return `Error: Wrong parameter found at '^' position.`;

    return [
      `interface ${portName}`,
      ...this.renderSwitchPortLines(sw, portName, port, cfg),
      '#',
    ].join('\n');
  }

  private renderSwitchPortLines(
    sw: HuaweiSwitchDevice, portName: string,
    port: import('../../hardware/Port').Port,
    cfg: import('../Switch').SwitchportConfig,
  ): string[] {
    const lines: string[] = [];
    const desc = sw.getInterfaceDescription(portName);
    if (desc) lines.push(` description ${desc}`);
    const vlanListe = (ids: Set<number> | undefined) =>
      Array.from(ids ?? []).sort((a, b) => a - b).join(' ');

    if (cfg.mode === 'trunk') {
      lines.push(' port link-type trunk');
      if (cfg.trunkNativeVlan !== 1) lines.push(` port trunk pvid vlan ${cfg.trunkNativeVlan}`);
      const allowedArr = Array.from(cfg.trunkAllowedVlans).sort((a, b) => a - b);
      if (allowedArr.length >= 4094) lines.push(' port trunk allow-pass vlan all');
      else if (allowedArr.length === 0) lines.push(' port trunk allow-pass vlan none');
      else lines.push(` port trunk allow-pass vlan ${allowedArr.join(' ')}`);
    } else if (cfg.mode === 'hybrid') {
      lines.push(' port link-type hybrid');
      if ((cfg.hybridPvid ?? 1) !== 1) lines.push(` port hybrid pvid vlan ${cfg.hybridPvid}`);
      const tagged = vlanListe(cfg.hybridTaggedVlans);
      if (tagged) lines.push(` port hybrid tagged vlan ${tagged}`);
      const untagged = vlanListe(cfg.hybridUntaggedVlans);
      if (untagged) lines.push(` port hybrid untagged vlan ${untagged}`);
    } else {
      lines.push(' port link-type access');
      if (cfg.accessVlan !== 1) lines.push(` port default vlan ${cfg.accessVlan}`);
    }

    const apprentissage = new Map(sw.getMacLearningDisabledPorts()).get(portName);
    if (apprentissage) lines.push(` ${ligneApprentissageMac(apprentissage)}`);
    for (const entry of this.ifCfg.get(portName) ?? []) lines.push(` ${entry.line}`);
    for (const l of this.ifStp.get(portName) ?? []) lines.push(` ${l}`);
    for (const l of sw.getLldpAgent?.()?.vrpInterfaceLines(portName) ?? []) lines.push(` ${l}`);
    if (!port.isNegotiationAuto()) {
      lines.push(` speed ${port.getSpeed()}`);
      lines.push(` duplex ${port.getDuplex()}`);
    }
    if (port.getMTU() !== 1500) lines.push(` mtu ${port.getMTU()}`);
    if (!port.getIsUp()) lines.push(' shutdown');
    for (const l of runningConfigNATHuawei(commeRouteur(sw), portName)) lines.push(l);
    return lines;
  }


  // ─── Interface Name Resolution ──────────────────────────────────


  /**
   * Le bloc de `display ip interface <nom>`, mêmes libellés que sur le
   * routeur VRP. Une LoopBack est UP des deux côtés dès qu'elle existe ;
   * un Vlanif suit son état réel.
   */
  private renderL3Interface(nom: string): string {
    if (!this.swRef) return '';
    const loop = this.swRef.getLoopback(nom);
    let etat: string;
    let addr: string | null;
    if (!/^(Vlanif|LoopBack)/i.test(nom)) {
      // Un port physique : meme predicat d'etat que toutes les autres
      // vues, et pas d'adresse a montrer sur un port de commutation.
      const port = this.swRef.getPort(nom);
      const st = port
        ? iosInterfaceStatus(port, nom, this.swRef._getPortsInternal())
        : null;
      etat = st
        ? (st.status === 'administratively down' ? 'Administratively DOWN' : st.status.toUpperCase())
        : 'DOWN';
      const ip = port?.getIPAddress();
      const masque = port?.getSubnetMask();
      addr = ip && masque ? `${ip}/${masque.toCIDR()}` : null;
    } else if (loop) {
      etat = 'UP';
      addr = loop.ip && loop.mask ? `${loop.ip}/${loop.mask.toCIDR()}` : null;
    } else {
      const vlan = parseInt(nom.replace(/\D/g, ''), 10);
      const svi = this.swRef.getSvi(vlan);
      const up = svi ? this.swRef.isSviLineUp(svi) : false;
      etat = svi?.adminUp ? (up ? 'UP' : 'DOWN') : 'Administratively DOWN';
      addr = svi?.ip && svi.mask ? `${svi.ip}/${svi.mask.toCIDR()}` : null;
    }
    const lignes = [
      `${nom} current state : ${etat}`,
      `Line protocol current state : ${etat === 'UP' ? 'UP' : 'DOWN'}`,
      addr ? `Internet Address is ${addr}` : 'Internet protocol processing : disabled',
      `The Maximum Transmit Unit : 1500 bytes`,
      `Input bandwidth utilization  : 0%`,
      `Output bandwidth utilization : 0%`,
      `    Last 300 seconds input rate 0 bits/sec, 0 packets/sec`,
      `    Last 300 seconds output rate 0 bits/sec, 0 packets/sec`,
      `    Input:  0 packets, 0 bytes`,
      `    Output: 0 packets, 0 bytes`,
    ];
    return lignes.join('\n');
  }

  /**
   * Le nom canonique d'une interface, quelle que soit l'ecriture — et
   * pour TOUS les types, physique comme virtuel.
   *
   * Il y en avait deux ici (`resolveInterfaceName`, aveugle aux SVI et
   * aux LoopBack, et `resolveL3InterfaceName`, qui ne connaissait
   * qu'elles et refusait toute abreviation), et une troisieme cote
   * routeur. D'ou trois desaccords mesures sur la meme maquette :
   * `display interface Vlanif 10` refuse alors que `LoopBack 0` passe,
   * `loop0` accepte par le routeur et refuse par le switch, et
   * `display interface vlanif10` rendant `vlanif10`.
   */
  private resolveInterfaceName(rawInput: string): string | null {
    if (!this.swRef) return null;
    return resolveHuaweiInterfaceName(this.nomsInterfaces(), rawInput);
  }

  /** Les ports physiques, plus les interfaces virtuelles qui existent. */
  private nomsInterfaces(): string[] {
    if (!this.swRef) return [];
    const noms = [...this.swRef.getPortNames()];
    for (const svi of this.swRef.getSvis()) noms.push(`Vlanif${svi.vlan}`);
    for (const l of this.swRef.getLoopbacks?.() ?? []) noms.push(l.name);
    return noms;
  }

  private resolveL3InterfaceName(raw: string): string | null {
    const nom = this.resolveInterfaceName(raw);
    return nom && /^(Vlanif|LoopBack)/i.test(nom) ? nom : null;
  }




  private buildPortMirroringCommands(): void {
    this.systemTrie.registerGreedy('observe-port', 'Configure SPAN observe-port', (args) =>
      this.handleObservePort(args, false));
    this.systemTrie.registerGreedy('undo observe-port', 'Remove SPAN observe-port', (args) =>
      this.handleObservePort(args, true));

    this.interfaceTrie.registerGreedy('port-mirroring to observe-port', 'Add interface as SPAN source', (args) =>
      this.handlePortMirroring(args, false));
    this.interfaceTrie.registerGreedy('undo port-mirroring to observe-port', 'Remove interface SPAN source', (args) =>
      this.handlePortMirroring(args, true));
    this.interfaceTrie.register('undo port-mirroring', 'Remove all SPAN sources on this interface', () => {
      if (!this.swRef || !this.selectedInterface) return 'Error: Incomplete command.';
      for (const s of this.swRef.listMirrorSessions()) this.swRef.removeMirrorSource(s.id, this.selectedInterface);
      return '';
    });

    for (const trie of [this.userTrie, this.systemTrie]) {
      trie.registerGreedy('display observe-port', 'Display SPAN observe-ports', (args) =>
        this.displayObservePort(args));
      trie.register('display port-mirroring', 'Display SPAN port-mirroring sources', () =>
        this.displayPortMirroring());
    }
  }

  private handleObservePort(args: string[], negate: boolean): string {
    if (!this.swRef) return 'Error: Operation not supported.';
    let i = 0;
    if ((args[i] ?? '').toLowerCase() === 'interface-index') i++;
    const id = parseInt(args[i] ?? '', 10);
    if (Number.isNaN(id) || id < 1) return 'Error: Wrong parameter found.';
    i++;
    if (negate && i >= args.length) {
      return this.swRef.removeMirrorSession(id) ? '' : `Error: Observe-port ${id} does not exist.`;
    }
    if ((args[i] ?? '').toLowerCase() !== 'interface') return 'Error: Incomplete command.';
    i++;
    const ifaceArg = args.slice(i).join(' ');
    if (!ifaceArg) return 'Error: Incomplete command.';
    const portName = this.resolveInterfaceName(ifaceArg);
    if (!portName) return `Error: Wrong parameter found at '^' position.`;
    if (negate) return this.swRef.removeMirrorDestination(id) ? '' : `Error: Observe-port ${id} destination not configured.`;
    const session = this.swRef.getMirrorSession(id);
    if (session && session.sources.has(portName)) {
      return `Error: ${portName} is already a mirroring source for observe-port ${id}.`;
    }
    this.swRef.configureMirrorDestination(id, portName);
    return '';
  }

  private handlePortMirroring(args: string[], negate: boolean): string {
    if (!this.swRef || !this.selectedInterface) return 'Error: Incomplete command.';
    const id = parseInt(args[0] ?? '', 10);
    if (Number.isNaN(id) || id < 1) return 'Error: Wrong parameter found.';
    const session = this.swRef.getMirrorSession(id);
    if (!session || !session.destination) {
      return `Error: Observe-port ${id} is not configured.`;
    }
    if (session.destination === this.selectedInterface) {
      return `Error: ${this.selectedInterface} is the observe-port destination.`;
    }
    if (negate) {
      return this.swRef.removeMirrorSource(id, this.selectedInterface)
        ? ''
        : `Error: ${this.selectedInterface} is not a source for observe-port ${id}.`;
    }
    const dirTok = (args[1] ?? 'both').toLowerCase();
    const dir =
      dirTok === 'inbound' ? 'rx' :
      dirTok === 'outbound' ? 'tx' :
      dirTok === 'both' ? 'both' : null;
    if (!dir) return 'Error: Wrong direction (inbound | outbound | both).';
    this.swRef.configureMirrorSource(id, this.selectedInterface, dir);
    return '';
  }

  private displayObservePort(args: string[]): string {
    if (!this.swRef) return '';
    const sessions = this.swRef.listMirrorSessions();
    if (sessions.length === 0) return 'Info: There is no observe-port configured.';
    const filter = args.length > 0 ? parseInt(args[0], 10) : null;
    const rows = sessions.filter((s) => (filter === null ? true : s.id === filter));
    if (rows.length === 0) return `Error: Observe-port ${filter} does not exist.`;
    const lines = [' Index    : Interface'];
    for (const s of rows) lines.push(` ${String(s.id).padEnd(8)} : ${s.destination ?? '-'}`);
    return lines.join('\n');
  }

  private displayPortMirroring(): string {
    if (!this.swRef) return '';
    const sessions = this.swRef.listMirrorSessions().filter((s) => s.sources.size > 0);
    if (sessions.length === 0) return 'Info: There is no mirroring source configured.';
    const lines: string[] = [];
    for (const s of sessions) {
      lines.push(`Observe-port ${s.id} : ${s.destination ?? '-'}`);
      for (const [port, dir] of s.sources) {
        const tok = dir.rx && dir.tx ? 'both' : dir.rx ? 'inbound' : 'outbound';
        lines.push(`  ${port} ${tok}`);
      }
    }
    return lines.join('\n');
  }
}
