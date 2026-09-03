/**
 * HuaweiVRPShell - Huawei VRP CLI emulation for Router Management Plane
 *
 * FSM-based CLI with CommandTrie for abbreviation/help support:
 *   - User view: <hostname> — display commands, system-view
 *   - System view: [hostname] — configuration commands
 *   - Interface view: [hostname-GE0/0/X] — interface configuration
 *   - DHCP pool view: [hostname-ip-pool-name] — DHCP pool configuration
 *
 * Features:
 *   - Abbreviation matching (e.g. "dis ip ro" → "display ip routing-table")
 *   - Context-aware ? help listing valid completions
 *   - Tab completion
 *
 * Command implementations are extracted into:
 *   - huawei/HuaweiDisplayCommands.ts  — display implementations
 *   - huawei/HuaweiConfigCommands.ts   — config/interface commands
 *   - huawei/HuaweiDhcpCommands.ts     — DHCP commands
 */

import type { Router } from '../Router';
import { VRP_SSH } from '@/terminal/ssh/sshDialect';
import { VrpSocle } from '@/cli/vendors/vrp/vrpSocle';
import { vrpDhcpClientFamily, type VrpDhcpLeaseView } from '@/cli/vendors/vrp/vrpDhcpClientFamily';
import { vrpMtuFamily, vrpBandwidthFamily } from '@/cli/vendors/vrp/vrpInterfaceParamsFamily';
import { vrpClockFamily, VRP_TIMEZONE_DEFAUT } from '@/cli/vendors/vrp/vrpClockFamily';
import { registerInfoCenterDisplayCommands } from './huawei/HuaweiInfoCenterCommands';
import {
  registerVrpLldpDisplayCommands, applyVrpLldpAdminStatus,
} from './huawei/HuaweiLldpViews';
import type { IRouterShell } from './IRouterShell';
import { LoggingConfig } from '../inspection/config/LoggingConfig';
import { CommandTrie } from './CommandTrie';
import {
  withVrpCommonHelp, withVrpCommonCandidates,
  type VrpViewKind,
} from './huawei/vrpCommonCommands';
import {
  vrpStores, vrpSetInterfaceAttr,
  type VrpTimeRange, type VrpNamedLines, type VrpInterfaceBucket,
} from './huawei/vrpShellStores';
import { EquipmentParamResolver } from './EquipmentParamResolver';
import { runSshClient } from '../linux/network/LinuxSshClient';
import { findHostByAddress, isPathReachable } from '../linux/network/HostLookup';
import { huaweiIrreversibleCipher, huaweiCipher, huaweiDecipher, looksLikeIrreversibleCipher, looksLikeReversibleCipher } from '@/crypto/passwords/huawei';
import { HUAWEI_ERRORS, parsePipeFilter, applyPipeFilter, resolveHuaweiNav, huaweiRipExtras, huaweiDisplayInterfaceName, normaliserErreurVrp, tropDeParametres, rendreErreurVrp } from './cli-utils';
import { analyserVrrp, appliquerVrrp } from './huawei/huaweiVrrpViews';
import { registerHuaweiCommonMgmt } from './huawei/HuaweiCommonConfig';
import type { HuaweiDebugService } from '../router/diag/HuaweiDebugService';
import { NetworkOsAccount, type AccountServiceType, type PasswordHashAlgorithm } from '../router/aaa/NetworkOsAccount';
import {
  registerHuaweiCommonSecurity, registerHuaweiCommonSecurityDisplay,
} from './huawei/HuaweiCommonSecurity';
import { IPAddress, IPv6Address, SubnetMask } from '../../core/types';
import { looksLikeIPv6 } from './cisco/ciscoPing';

// Extracted command modules
import {
  type HuaweiDisplayState,
  registerDisplayCommands, displayCurrentConfig, resolveHuaweiInterfaceName,
} from './huawei/HuaweiDisplayCommands';
import { huaweiInteractionPlanFor } from './huawei/HuaweiInteractionPlans';
import type { CommandInteractionPlan } from '@/shell/interaction/CommandInteraction';
import {
  type HuaweiShellMode, type HuaweiShellContext,
  buildSystemCommands, buildInterfaceCommands,
  cmdIpRouteStatic, cmdRip, cmdUndo,
} from './huawei/HuaweiConfigCommands';
import {
  registerDhcpSystemCommands, buildDhcpPoolCommands,
  registerDhcpDisplayCommands, registerDhcpDebugCommands,
  registerDhcpInterfaceCommands, registerDhcpv6SystemCommands,
} from './huawei/HuaweiDhcpCommands';
import {
  registerOSPFSystemCommands, buildOSPFViewCommands, buildOSPFAreaViewCommands,
  buildOSPFv3ViewCommands, registerOSPFInterfaceCommands,
  registerOSPFDisplayCommands,
} from './huawei/HuaweiOspfCommands';
import {
  registerHuaweiIgmpInterfaceCommands, registerHuaweiIgmpDisplayCommands,
} from './huawei/HuaweiIgmpCommands';
import {
  registerHuaweiPimInterfaceCommands, registerHuaweiPimViewCommands,
  registerHuaweiPimDisplayCommands,
} from './huawei/HuaweiPimCommands';
import {
  type HuaweiIPSecContext,
  registerHuaweiIPSecSystemCommands, registerHuaweiIPSecInterfaceCommands,
  registerHuaweiIPSecDisplayCommands,
  buildHuaweiIKEProposalCommands, buildHuaweiIKEPeerCommands,
  buildHuaweiIPSecProposalCommands, buildHuaweiIPSecPolicyCommands,
  buildHuaweiIKEv2ProposalCommands, buildHuaweiIKEv2PolicyCommands,
  buildHuaweiIKEv2KeyringCommands, buildHuaweiIKEv2KeyringPeerCommands,
  buildHuaweiIKEv2ProfileCommands,
} from './huawei/HuaweiIPSecCommands';
import {
  type HuaweiACLContext, type HuaweiACLMode,
  registerHuaweiACLSystemCommands, registerHuaweiACLInterfaceCommands,
  registerHuaweiACLDisplayCommands,
  buildHuaweiBasicACLCommands, buildHuaweiAdvancedACLCommands,
  runningConfigACL, runningConfigInterfaceACL,
} from './huawei/HuaweiAclCommands';
import {
  registerHuaweiNATInterfaceCommands,
  registerHuaweiNATSystemCommands,
  registerHuaweiNATDisplayCommands,
} from './huawei/HuaweiNATCommands';
import {
  type HuaweiPolicyShellCtx,
  registerHuaweiPolicySystemCommands, registerHuaweiPolicyDisplayCommands,
  buildRoutePolicyView, buildTrafficClassifierView, buildTrafficBehaviorView,
  buildTrafficPolicyView,
} from './huawei/HuaweiPolicyCommands';
import {
  buildHuaweiNqaSystemCommands, buildHuaweiNqaTestView,
  registerHuaweiNqaDisplayCommands, resolveVrpTrack,
} from './huawei/HuaweiNqaCommands';
import { describeHuaweiArguments } from './huawei/huaweiArgumentHelp';
import {
  AR2220_HARDWARE_PROFILE,
  renderHealth, renderTemperature, renderFans, renderPower, renderEnvironment,
} from './huawei/HuaweiHardwareProfile';
import {
  buildHuaweiVxlanInterfaceCommands, registerHuaweiVxlanDisplayCommands,
} from './huawei/HuaweiVxlanCommands';
import { collectListeningSockets } from '../router/management/SocketInventory';
import { getVrrpAgent, getSessionRegistry, getVtyLineConfig } from '../../equipment/RouterServiceCapabilities';
import { registerUserInterfaceCommands } from './huawei/HuaweiUserInterfaceCommands';
import { getSecurityConfig } from './cisco/CiscoSecurityCommands';
import { parseVrpCarRule } from '../../qos/CarPolicer';
import {
  parseTimeOfDay,
  type TimeRangePeriodic,
} from '../router/security/timeRange';
import { estAdresseIPv4 } from './cli-utils';
import { boundedInteger } from '@/cli/ArgumentTypes';
import { BGP_ATTRIBUTE_MAX, BGP_HOLD_TIME_MAX } from '@/network/bgp/attributes';

const JOURS_VRP: Record<string, string> = {
  daily: 'daily', 'working-day': 'weekdays', 'off-day': 'weekend',
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

function analyserPeriodeVrp(args: string[]): TimeRangePeriodic | null {
  const debut = parseTimeOfDay(args[0]);
  if (!debut || args[1]?.toLowerCase() !== 'to') return null;
  const fin = parseTimeOfDay(args[2]);
  if (!fin) return null;
  const jours = args.slice(3).map((j) => JOURS_VRP[j.toLowerCase()]).filter(Boolean);
  if (args.length > 3 && jours.length !== args.length - 3) return null;
  return {
    days: jours.length > 0 ? jours.join(' ') : 'daily',
    startHour: debut.hour, startMinute: debut.minute,
    endHour: fin.hour, endMinute: fin.minute,
  };
}

function renderHuaweiTcpStatus(router: Router): string {
  const tcp = collectListeningSockets(router).filter((s) => s.protocol === 'tcp');
  const lines = ['TCPCB       Local Address                Foreign Address           State'];
  if (tcp.length === 0) return [...lines, '(no TCP listeners)'].join('\n');
  for (const s of tcp) {
    const local = `0.0.0.0:${s.port}`.padEnd(28);
    lines.push(`0x00000000  ${local}0.0.0.0:0                 LISTEN  (${s.service})`);
  }
  return lines.join('\n');
}

function renderHuaweiSockets(router: Router): string {
  const all = collectListeningSockets(router);
  if (all.length === 0) return ' Active sockets: 0';
  const lines = [` Active sockets: ${all.length}`, ' Proto  Port   Service'];
  for (const s of all) {
    lines.push(` ${s.protocol.padEnd(6)} ${String(s.port).padEnd(6)} ${s.service}`);
  }
  return lines.join('\n');
}

/**
 * Un fait rendu par la STRUCTURE ne se garde pas aussi en texte brut :
 * `as-number` et `group` sont deja ecrits par le rendu du voisin, donc
 * les y ajouter donnait deux lignes pour un seul voisin — et deux lignes
 * QUI SE CONTREDISENT des que la valeur etait mal formee.
 */
function gardeLigneNonRendue(
  peer: { rawLines: string[] }, ip: string, mots: readonly string[],
): void {
  if (mots.length === 0) return;
  const ligne = `peer ${ip} ${mots.join(' ')}`;
  if (!peer.rawLines.includes(ligne)) peer.rawLines.push(ligne);
}

export class HuaweiVRPShell implements IRouterShell, HuaweiShellContext, HuaweiDisplayState, HuaweiIPSecContext, HuaweiACLContext, HuaweiPolicyShellCtx {
  readonly logging = new LoggingConfig();
  attachLoggingToBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): void {
    this.logging.attachToBus(bus, deviceId);
  }
  getLoggingConfig(): LoggingConfig { return this.logging; }
  private mode: HuaweiShellMode = 'user';
  private bgpAsn: number | null = null;
  private isisProcessId: number | null = null;
  private readonly bgpTrie = new CommandTrie();
  private readonly isisTrie = new CommandTrie();

  getBgpAsn(): number | null { return this.bgpAsn; }
  getIsisProcessId(): number | null { return this.isisProcessId; }

  private readonly cmdHistory: string[] = [];
  private historyMax: number = 10;

  getCmdHistory(): readonly string[] { return [...this.cmdHistory]; }
  setHistoryMax(n: number): void { if (n > 0) this.historyMax = n; this.trimHistory(); }
  private recordHistory(line: string): void {
    if (!line || line.startsWith('?')) return;
    this.cmdHistory.push(line);
    this.trimHistory();
  }
  private trimHistory(): void {
    while (this.cmdHistory.length > this.historyMax) this.cmdHistory.shift();
  }

  private selectedInterface: string | null = null;
  private selectedPool: string | null = null;
  private dhcpEnabled: boolean = false;
  private dhcpSnoopingEnabled: boolean = false;
  /** OSPF area currently being configured */
  private ospfArea: string | null = null;

  // ── IPSec sub-mode selections ──────────────────────────────────
  private selectedIKEProposal: number | null = null;
  private selectedIKEPeer: string | null = null;
  private selectedIPSecProposal: string | null = null;
  private selectedIPSecPolicy: string | null = null;
  private selectedIPSecPolicySeq: number | null = null;

  // ── ACL sub-mode selections ────────────────────────────────────
  private selectedACLNumber: number | null = null;
  private selectedACLMode: HuaweiACLMode | null = null;
  private selectedACLName: string | null = null;

  private selectedPrefixList: string | null = null;
  private selectedRoutePolicy: string | null = null;
  private selectedRoutePolicyNode: number | null = null;
  private selectedClassifier: string | null = null;
  private selectedBehavior: string | null = null;
  private selectedTrafficPolicy: string | null = null;
  private selectedNqa: { admin: string; name: string } | null = null;

  private routePolicyTrie = new CommandTrie();
  private trafficClassifierTrie = new CommandTrie();
  private trafficBehaviorTrie = new CommandTrie();
  private trafficPolicyTrie = new CommandTrie();
  private nqaTestTrie = new CommandTrie();

  setSelectedPrefixList(n: string | null): void { this.selectedPrefixList = n; }
  getSelectedPrefixList(): string | null { return this.selectedPrefixList; }
  setSelectedRoutePolicy(n: string | null): void { this.selectedRoutePolicy = n; }
  getSelectedRoutePolicy(): string | null { return this.selectedRoutePolicy; }
  setSelectedRoutePolicyNode(n: number | null): void { this.selectedRoutePolicyNode = n; }
  getSelectedRoutePolicyNode(): number | null { return this.selectedRoutePolicyNode; }
  setSelectedClassifier(n: string | null): void { this.selectedClassifier = n; }
  getSelectedClassifier(): string | null { return this.selectedClassifier; }
  setSelectedBehavior(n: string | null): void { this.selectedBehavior = n; }
  getSelectedBehavior(): string | null { return this.selectedBehavior; }
  setSelectedTrafficPolicy(n: string | null): void { this.selectedTrafficPolicy = n; }
  getSelectedTrafficPolicy(): string | null { return this.selectedTrafficPolicy; }
  setSelectedNqa(admin: string | null, name: string | null): void {
    this.selectedNqa = admin && name ? { admin, name } : null;
  }
  getSelectedNqa(): { admin: string; name: string } | null { return this.selectedNqa; }

  /** Temporary reference set during execute() */
  private routerRef: Router | null = null;
  /** Pending async operation (e.g. tracert) — set by a command handler, consumed by execute() */
  private _pendingAsync: Promise<string> | null = null;

  /**
   * Per-vty pager / display preferences (Huawei VRP exec preferences,
   * per-session — see terminal_gap.md §5.3). 24 lines × 80 columns are
   * the VRP defaults; `screen-length 0` (or `screen-length disable`)
   * turns the pager off.
   */
  private screenLength: number = 24;
  private screenWidth: number = 80;
  protected terminalDebugging: boolean = false;
  protected terminalMonitor: boolean = false;

  /**
   * VRP splits what IOS merges: `terminal monitor` opens the line to
   * unprompted output at all, and `terminal debugging` is the extra
   * switch debug traces need on top of it.
   */
  receivesAsyncOutput(): { debug: boolean; syslog: boolean } {
    return {
      debug: this.terminalMonitor && this.terminalDebugging,
      syslog: this.terminalMonitor,
    };
  }

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private systemTrie = new CommandTrie();
  private interfaceTrie = new CommandTrie();
  private dhcpPoolTrie = new CommandTrie();
  private ospfTrie = new CommandTrie();
  private pimTrie = new CommandTrie();
  private ospfAreaTrie = new CommandTrie();
  // IPSec sub-mode tries
  private ikeProposalTrie = new CommandTrie();
  private ikePeerTrie = new CommandTrie();
  private ipsecProposalTrie = new CommandTrie();
  private ipsecPolicyTrie = new CommandTrie();
  // OSPFv3 sub-mode trie
  private ospfv3Trie = new CommandTrie();
  private ospfv3AreaTrie = new CommandTrie();
  // user-interface vty sub-mode trie ([host-ui-vty<n>])
  private uiTrie = new CommandTrie();
  private uiLabel: string = '0';
  private selectedUiRange: { first: number; last: number } | null = null;
  // ACL sub-mode tries
  private aclBasicTrie = new CommandTrie();
  private aclAdvancedTrie = new CommandTrie();
  // IKEv2 sub-mode tries
  private ikev2ProposalTrie = new CommandTrie();
  private ikev2PolicyTrie = new CommandTrie();
  private ikev2KeyringTrie = new CommandTrie();
  private ikev2KeyringPeerTrie = new CommandTrie();
  private ikev2ProfileTrie = new CommandTrie();
  // RIP view trie
  private ripTrie = new CommandTrie();
  // AAA submode tries
  private aaaTrie = new CommandTrie();
  private aaaAuthenTrie = new CommandTrie();
  private aaaAuthorTrie = new CommandTrie();
  private aaaAccountingTrie = new CommandTrie();
  private aaaDomainTrie = new CommandTrie();
  private radiusTemplateTrie = new CommandTrie();
  private hwtacacsTemplateTrie = new CommandTrie();
  private selectedAaaScheme: string | null = null;
  private cpuDefendPolicyTrie = new CommandTrie();
  private selectedCpuDefendPolicy: string | null = null;
  private bfdGlobalTrie = new CommandTrie();
  private bfdSessionTrie = new CommandTrie();
  private selectedBfdSession: string | null = null;


  constructor() {
    this.buildUserCommands();
    this.buildSystemViewCommands();
    this.buildInterfaceViewCommands();
    this.buildDhcpPoolViewCommands();
    this.buildOSPFViewCommands();
    this.buildOSPFAreaViewCommands();
    this.buildOSPFv3ViewCommands();
    this.buildIPSecSubViewCommands();
    this.buildIKEv2SubViewCommands();
    this.buildACLSubViewCommands();
    this.buildUserInterfaceCommands();
    this.buildRIPViewCommands();
    this.buildBgpViewCommands();
    this.buildIsisViewCommands();
    buildRoutePolicyView(this.routePolicyTrie, this);
    buildTrafficClassifierView(this.trafficClassifierTrie, this);
    buildTrafficBehaviorView(this.trafficBehaviorTrie, this);
    buildTrafficPolicyView(this.trafficPolicyTrie, this);
    buildHuaweiNqaTestView(this.nqaTestTrie, this);
    buildHuaweiNqaSystemCommands(this.systemTrie, this);
    describeHuaweiArguments({
      system: this.systemTrie,
      iface: this.interfaceTrie,
      ospf: this.ospfTrie,
      vty: this.uiTrie,
      user: this.userTrie,
    });
    for (const t of [
      this.userTrie, this.systemTrie, this.interfaceTrie, this.dhcpPoolTrie,
      this.ospfTrie, this.ospfAreaTrie, this.ospfv3Trie, this.ospfv3AreaTrie, this.ripTrie,
      this.pimTrie,
      this.ikeProposalTrie, this.ikePeerTrie, this.ipsecProposalTrie, this.ipsecPolicyTrie,
      this.uiTrie, this.aclBasicTrie, this.aclAdvancedTrie,
      this.ikev2ProposalTrie, this.ikev2PolicyTrie, this.ikev2KeyringTrie,
      this.ikev2KeyringPeerTrie, this.ikev2ProfileTrie,
      this.routePolicyTrie, this.trafficClassifierTrie, this.trafficBehaviorTrie,
      this.trafficPolicyTrie, this.nqaTestTrie,
      this.bgpTrie, this.isisTrie,
      this.aaaTrie, this.aaaAuthenTrie, this.aaaAuthorTrie, this.aaaAccountingTrie,
      this.aaaDomainTrie, this.radiusTemplateTrie, this.hwtacacsTemplateTrie,
      this.cpuDefendPolicyTrie, this.bfdGlobalTrie, this.bfdSessionTrie,
    ]) {
      this.registerDisplayThis(t);
    }
  }

  getOSType(): string { return 'huawei-vrp'; }

  // ─── HuaweiShellContext Implementation ──────────────────────────────

  r(): Router {
    if (!this.routerRef) throw new Error('Router reference not set (BUG)');
    return this.routerRef;
  }

  /** `display current-configuration` text — source for `save` (Router.getRunningConfig). */
  getRunningConfigText(router: Router): string {
    return displayCurrentConfig(router, this.dhcpEnabled, this.dhcpSnoopingEnabled);
  }

  /** Re-apply saved config text onto live router state (VRP reboot). */
  applyConfigText(router: Router, text: string): void {
    let curIface: string | null = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line === '#') { curIface = null; continue; }
      let g: RegExpMatchArray | null;
      if (!/^\s/.test(raw)) {
        curIface = null;
        if ((g = line.match(/^sysname\s+(\S+)/))) {
          router._setHostnameInternal(g[1]);
        } else if ((g = line.match(/^interface\s+(\S+)/))) {
          curIface = resolveHuaweiInterfaceName(router, g[1]) ?? g[1];
        } else if ((g = line.match(/^ip route-static\s+(\S+)\s+(\S+)\s+(\S+)/))) {
          try {
            const mask = /^\d+$/.test(g[2]) ? SubnetMask.fromCIDR(parseInt(g[2], 10)) : new SubnetMask(g[2]);
            const nextHop = new IPAddress(g[3]);
            if (g[1] === '0.0.0.0' && mask.toString() === '0.0.0.0') router.setDefaultRoute(nextHop);
            else router.addStaticRoute(new IPAddress(g[1]), mask, nextHop);
          } catch { /* malformed saved line — skip like real VRP would reject it */ }
        }
        continue;
      }
      if (!curIface) continue;
      if ((g = line.match(/^description\s+(.+)/))) {
        router.setInterfaceDescription(curIface, g[1]);
      } else if ((g = line.match(/^ip address\s+(\S+)\s+(\S+)/))) {
        try { router.configureInterface(curIface, new IPAddress(g[1]), new SubnetMask(g[2])); } catch { /* malformed */ }
      } else if (line === 'shutdown') {
        router.getPort(curIface)?.setAdminShutdown(true);
      }
    }
  }

  /**
   * Capture the current configuration as the device's startup snapshot —
   * the state `display saved-configuration` renders and
   * `reset saved-configuration` clears.
   */
  private captureSavedConfiguration(): void {
    this.r().writeMemory();
  }

  /** Command-owned interactive flows (IoC) — see HuaweiInteractionPlans. */
  interactionPlanFor(commandLine: string): CommandInteractionPlan | null {
    return huaweiInteractionPlanFor(commandLine);
  }

  /** Power-cycle the router and reset the shell to user view (VRP reboot). */
  private performReboot(): string {
    const r = this.r();
    r.powerOff();
    r.powerOn();
    this.mode = 'user';
    this.selectedInterface = null;
    r._resetConfigurableStateForReload();
    r._restoreStartupConfig();
    return 'Info: The system is rebooting ...\nSystem restart completed.';
  }

  setMode(mode: HuaweiShellMode): void { this.mode = mode; }
  getMode(): string { return this.mode; }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  setSelectedInterface(iface: string | null): void { this.selectedInterface = iface; }

  getSelectedPool(): string | null { return this.selectedPool; }
  setSelectedPool(pool: string | null): void { this.selectedPool = pool; }

  // ─── HuaweiIPSecContext Implementation ──────────────────────────────

  // ─── Per-vty state snapshot / swap (§5.1 of terminal_gap.md) ─────

  /**
   * Capture every mode-related field into a snapshot. Mirrors
   * CiscoIOSShell.snapshotVtyState. Router.executeCommandInVty uses
   * this to swap per-terminal state in for the duration of a command.
   */
  snapshotVtyState(): import('./vty/CliShellSession').VtySnapshot {
    return {
      mode: this.mode,
      selectedInterface: this.selectedInterface,
      selectedInterfaceRange: [],
      selectedVlan: null,
      // VRP n'a pas les CLI Views d'IOS, et son shell ne porte pas
      // d'identite de session : les deux champs du contrat sont donc
      // renseignes pour ce qu'ils sont ici — absents — plutot que
      // laisses indefinis.
      activeParserView: null,
      sessionUser: null,
      selectedArpAcl: null,
      selectedAccessMap: null,
      selectedMqcName: null,
      selectedPortGroup: null,
      selectedRoutingProto: null,                  // VRP: not modelled here
      selectedTrack: null,
      selectedIpSla: null,
      selectedRouteMap: null,
      selectedDHCPPool: this.selectedPool,
      selectedACL: this.selectedACLName,
      selectedACLType: null,
      selectedISAKMPPriority: this.selectedIKEProposal,
      selectedTransformSet: this.selectedIPSecProposal,
      selectedCryptoMap: this.selectedIPSecPolicy,
      selectedCryptoMapSeq: this.selectedIPSecPolicySeq,
      selectedCryptoMapIsDynamic: false,
      selectedIPSecProfile: null,
      selectedIKEv2Proposal: null,
      selectedIKEv2Policy: null,
      selectedIKEv2Keyring: null,
      selectedIKEv2KeyringPeer: null,
      selectedIKEv2Profile: null,
      terminalLength: this.screenLength,
      terminalWidth: this.screenWidth,
      terminalMonitor: this.terminalMonitor,
      terminalDebugging: this.terminalDebugging,
      privilegeLevel: this.mode === 'user' || this.mode === 'user-view' ? 1 : 15,
      historySize: this.historyMax,
      cmdHistory: [...this.cmdHistory],
    };
  }

  /** Apply a session's snapshot onto this shell instance. */
  applyVtyState(s: import('./vty/CliShellSession').VtySnapshot): void {
    this.mode = (s.mode ?? 'user') as HuaweiShellMode;
    this.selectedInterface = s.selectedInterface;
    this.selectedPool = s.selectedDHCPPool;
    this.selectedACLName = s.selectedACL;
    this.selectedIKEProposal = s.selectedISAKMPPriority;
    this.selectedIPSecProposal = s.selectedTransformSet;
    this.selectedIPSecPolicy = s.selectedCryptoMap;
    this.selectedIPSecPolicySeq = s.selectedCryptoMapSeq;
    this.screenLength = s.terminalLength;
    this.screenWidth = s.terminalWidth;
    this.terminalDebugging = s.terminalDebugging;
    this.terminalMonitor = s.terminalMonitor;
  }

  setSelectedIKEProposal(n: number | null): void { this.selectedIKEProposal = n; }
  getSelectedIKEProposal(): number | null { return this.selectedIKEProposal; }
  setSelectedIKEPeer(name: string | null): void { this.selectedIKEPeer = name; }
  getSelectedIKEPeer(): string | null { return this.selectedIKEPeer; }
  setSelectedIPSecProposal(name: string | null): void { this.selectedIPSecProposal = name; }
  getSelectedIPSecProposal(): string | null { return this.selectedIPSecProposal; }
  setSelectedIPSecPolicy(name: string | null): void { this.selectedIPSecPolicy = name; }
  getSelectedIPSecPolicy(): string | null { return this.selectedIPSecPolicy; }
  setSelectedIPSecPolicySeq(seq: number | null): void { this.selectedIPSecPolicySeq = seq; }
  getSelectedIPSecPolicySeq(): number | null { return this.selectedIPSecPolicySeq; }

  // ─── HuaweiACLContext Implementation ────────────────────────────────

  getSelectedACLNumber(): number | null { return this.selectedACLNumber; }
  setSelectedACLNumber(n: number | null): void { this.selectedACLNumber = n; }
  getSelectedACLMode(): HuaweiACLMode | null { return this.selectedACLMode; }
  setSelectedACLMode(m: HuaweiACLMode | null): void { this.selectedACLMode = m; }
  getSelectedACLName(): string | null { return this.selectedACLName; }
  setSelectedACLName(n: string | null): void { this.selectedACLName = n; }

  // ─── HuaweiDisplayState Implementation ─────────────────────────────

  isDhcpEnabled(): boolean { return this.dhcpEnabled; }
  isDhcpSnoopingEnabled(): boolean { return this.dhcpSnoopingEnabled; }
  renderLogbuffer(seuil?: number | null): string {
    const ic = this.r().getManagementService?.().getInfoCenter();
    if (!ic) return this.logging.renderHuawei(undefined, seuil);
    const canal = ic.destinationChannel.logbuffer;
    return this.logging.renderHuawei({
      size: ic.logbufferSize, channel: canal, channelName: ic.channelNames[canal],
    }, seuil);
  }

  // ─── Prompt Generation ─────────────────────────────────────────────

  getPrompt(router: Router): string {
    const host = router._getHostnameInternal();
    switch (this.mode) {
      case 'user':       return `<${host}>`;
      case 'system':     return `[${host}]`;
      case 'interface':  return `[${host}-${huaweiDisplayInterfaceName(this.selectedInterface ?? '')}]`;
      case 'dhcp-pool':  return `[${host}-ip-pool-${this.selectedPool}]`;
      case 'pim':        return `[${host}-pim]`;
      case 'ospf':       return `[${host}-ospf-1]`;
      case 'ospf-area':  return `[${host}-ospf-1-area-${this.ospfArea}]`;
      case 'ospfv3':     return `[${host}-ospfv3-1]`;
      case 'ospfv3-area': return `[${host}-ospfv3-1-area-${this.ospfArea ?? '0.0.0.0'}]`;
      case 'rip':        return `[${host}-rip-1]`;
      case 'ui':         return `[${host}-ui-vty${this.uiLabel}]`;
      case 'ike-proposal':  return `[${host}-ike-proposal-${this.selectedIKEProposal}]`;
      case 'ike-peer':      return `[${host}-ike-peer-${this.selectedIKEPeer}]`;
      case 'ipsec-proposal': return `[${host}-ipsec-proposal-${this.selectedIPSecProposal}]`;
      case 'ipsec-policy':  return `[${host}-ipsec-policy-${this.selectedIPSecPolicy}-${this.selectedIPSecPolicySeq}]`;
      case 'acl-basic':    return `[${host}-acl-basic-${this.selectedACLName || this.selectedACLNumber}]`;
      case 'acl-advanced': return `[${host}-acl-adv-${this.selectedACLName || this.selectedACLNumber}]`;
      case 'ikev2-proposal': return `[${host}-ikev2-proposal-${this.selectedIPSecProposal}]`;
      case 'ikev2-policy':   return `[${host}-ikev2-policy-${this.selectedIPSecPolicy}]`;
      case 'ikev2-keyring':  return `[${host}-ikev2-keyring-${this.selectedIKEPeer}]`;
      case 'ikev2-keyring-peer': return `[${host}-ikev2-keyring-peer-${this.selectedIPSecProposal}]`;
      case 'ikev2-profile':  return `[${host}-ikev2-profile-${this.selectedIPSecProposal}]`;
      case 'route-policy': return `[${host}-route-policy-${this.selectedRoutePolicy}-${this.selectedRoutePolicyNode}]`;
      case 'traffic-classifier': return `[${host}-classifier-${this.selectedClassifier}]`;
      case 'traffic-behavior': return `[${host}-behavior-${this.selectedBehavior}]`;
      case 'traffic-policy': return `[${host}-trafficpolicy-${this.selectedTrafficPolicy}]`;
      case 'nqa-test': return `[${host}-nqa-${this.selectedNqa?.admin}-${this.selectedNqa?.name}]`;
      case 'bgp':        return `[${host}-bgp${this.bgpAsn !== null ? '-' + this.bgpAsn : ''}]`;
      case 'isis':       return `[${host}-isis-${this.isisProcessId ?? '1'}]`;
      case 'aaa':        return `[${host}-aaa]`;
      case 'aaa-authen': return `[${host}-aaa-authen-${this.selectedAaaScheme ?? ''}]`;
      case 'aaa-author': return `[${host}-aaa-author-${this.selectedAaaScheme ?? ''}]`;
      case 'aaa-accounting': return `[${host}-aaa-accounting-${this.selectedAaaScheme ?? ''}]`;
      case 'aaa-domain': return `[${host}-aaa-domain-${this.selectedAaaScheme ?? ''}]`;
      case 'radius-template': return `[${host}-radius-${this.selectedAaaScheme ?? ''}]`;
      case 'hwtacacs-template': return `[${host}-hwtacacs-${this.selectedAaaScheme ?? ''}]`;
      case 'cpu-defend-policy': return `[${host}-cpu-defend-policy-${this.selectedCpuDefendPolicy ?? ''}]`;
      case 'bfd-global':  return `[${host}-bfd]`;
      case 'bfd-session': return `[${host}-bfd-session-${this.selectedBfdSession ?? ''}]`;
      default:           return `<${host}>`;
    }
  }

  // ─── Main Execute ──────────────────────────────────────────────────

  execute(router: Router, rawInput: string): string | Promise<string> {
    // `ip route-static … track nqa <admin> <test>` était analysé, rangé
    // sur la route, et lu par personne : VRP n'appelait jamais
    // `setRouteTrackResolver`, donc `Router.isRouteTrackUp()` répondait
    // `true` sans condition et la route conditionnée était
    // inconditionnelle (docs/PRD-NQA.md §0.1 item 3).
    router.setRouteTrackResolver((track) => resolveVrpTrack(router, track));
    const trimmed = rawInput.trim();
    if (!trimmed) return '';

    // VRP comment/separator lines: `#` (optionally followed by text) is a
    // silent no-op in every view — VRP configuration files use it as the
    // section separator, so pasting a config must not error on each `#`.
    if (trimmed.startsWith('#')) return '';

    if (trimmed.endsWith('?')) {
      const helpInput = trimmed.slice(0, -1);
      return this.getHelp(helpInput);
    }

    this.recordHistory(trimmed);

    // Split off an output pipe filter (| include/exclude/begin …) — shared
    // with the switch shell + Cisco shells via cli-utils (DRY).
    const { cmd, filter } = parsePipeFilter(trimmed);
    const lower = cmd.toLowerCase();

    // Global navigation — accepts unambiguous VRP abbreviations.
    const nav = resolveHuaweiNav(lower);
    if (nav === 'return') {
      this.mode = 'user';
      this.selectedInterface = null;
      this.selectedPool = null;
      this.selectedIKEProposal = null;
      this.selectedIKEPeer = null;
      this.selectedIPSecProposal = null;
      this.selectedIPSecPolicy = null;
      this.selectedIPSecPolicySeq = null;
      this.selectedACLNumber = null;
      this.selectedACLMode = null;
      this.selectedACLName = null;
      this.selectedRoutePolicy = null;
      this.selectedRoutePolicyNode = null;
      this.selectedClassifier = null;
      this.selectedBehavior = null;
      this.selectedTrafficPolicy = null;
      this.selectedNqa = null;
      this.selectedAaaScheme = null;
      return '';
    }
    if (nav === 'quit') return this.cmdQuit();

    // Bind router reference
    this.routerRef = router;

    // Expand `command-alias` shortcuts before any trie match — same
    // behaviour as the SSH dispatcher so the local shell honours
    // installed aliases.
    const aliasTable = router._getCommandAliases?.();
    const effective = aliasTable ? aliasTable.expand(cmd) : cmd;
    const output = this.executeOnTrie(effective);

    // Async escape hatch (e.g. tracert sets _pendingAsync)
    if (this._pendingAsync) {
      const asyncOp = this._pendingAsync;
      this._pendingAsync = null;
      this.routerRef = null;
      return asyncOp;
    }

    this.routerRef = null;
    return filter && !output.startsWith('Error:')
      ? applyPipeFilter(output, filter)
      : output;
  }

  private socleInstance: VrpSocle | null = null;

  private socle(): VrpSocle {
    if (!this.socleInstance) {
      this.socleInstance = new VrpSocle(
        () => this.routerRef?.getHostname() ?? 'Router', this,
                () => [...vrpDhcpClientFamily(), ...vrpMtuFamily(), ...vrpBandwidthFamily(),
          ...vrpClockFamily()]);
    }
    return this.socleInstance;
  }

  vrpSelectedInterface(): string | null { return this.selectedInterface ?? null; }

  vrpSetInterfaceMtu(iface: string, mtu: number): string {
    const port = this.routerRef?.getPort(iface);
    if (!port) return 'Error: No interface selected';
    try { port.setMTU(mtu); } catch (e) { return `Error: ${(e as Error).message}`; }
    return '';
  }

  vrpSetInterfaceBandwidth(iface: string, kbps: number): string {
    this.routerRef?.getPort(iface)?.setBandwidthKbps(kbps);
    return '';
  }

  vrpSetTimezone(nom: string, minutes: number): string {
    const clock = this.routerRef?.getManagementService?.().getClock();
    if (clock) { clock.timezone = nom; clock.offsetMin = minutes; }
    return '';
  }

  vrpClearTimezone(): string {
    const clock = this.routerRef?.getManagementService?.().getClock();
    if (clock) { clock.timezone = VRP_TIMEZONE_DEFAUT; clock.offsetMin = 0; }
    return '';
  }

  vrpDhcpEnabledElsewhere(iface: string): boolean {
    const agent = this.routerRef?.getDhcpClientAgent();
    return !!agent && agent.enabledInterfaces().some(i => i !== iface);
  }

  vrpDhcpEnable(iface: string): void {
    this.routerRef?.getDhcpClientAgent().enable(iface, 'ip address dhcp-alloc');
  }

  vrpDhcpDisable(iface: string): void {
    this.routerRef?.getDhcpClientAgent().disable(iface);
  }

  vrpDhcpLeases(): VrpDhcpLeaseView[] {
    return (this.routerRef?.getDhcpClientAgent().leases() ?? []).map(l => ({
      iface: l.iface,
      displayName: huaweiDisplayInterfaceName(l.iface),
      ipAddress: l.ipAddress,
      subnetMask: l.subnetMask,
      defaultGateway: l.defaultGateway,
      serverIdentifier: l.serverIdentifier,
      leaseDuration: l.leaseDuration,
      renewalTime: l.renewalTime,
      rebindingTime: l.rebindingTime,
    }));
  }

  private executeOnTrie(cmdPart: string): string {
    const migre = this.socle().run(cmdPart, this.mode);
    if (migre !== null) return migre;
    const refus = this.socle().refusalBeforeTrie(cmdPart, this.mode);
    if (refus !== null) return refus;
    const trie = this.getActiveTrie();
    const result = trie.match(cmdPart);

    switch (result.status) {
      case 'ok': {
        const trop = tropDeParametres(result, cmdPart);
        if (trop) return trop;
        if (result.node?.action) {
          return normaliserErreurVrp(
            result.node.action(result.args, cmdPart),
            cmdPart,
            result.matchedKeywords.length,
          );
        }
        return '';
      }

      case 'ambiguous':
        // Never use `result.error` here — CommandTrie's own `.error` is
        // pre-formatted with Cisco's "%" wording (shared trie code, see
        // its doc comment); VRP has its own "Error: ... found at '^'
        // position." convention with a uniform caret line.
        return HUAWEI_ERRORS.AMBIGUOUS(cmdPart, result.errorPos);

      case 'incomplete':
        return HUAWEI_ERRORS.INCOMPLETE(cmdPart, result.errorPos);

      case 'invalid':
        return this.socle().diagnostic(cmdPart, this.mode)
          ?? HUAWEI_ERRORS.UNRECOGNIZED(cmdPart, result.errorPos);

      default:
        return HUAWEI_ERRORS.UNRECOGNIZED(cmdPart);
    }
  }

  /**
   * Parse `stelnet [user@]host [port]` / `ssh [-l user] [-p port] host
   * [cmd]` and dispatch through the shared runSshClient. Source IP is
   * picked from the first up interface that has one.
   */
  private runOutboundSshClient(args: string[]): string {
    let user = 'admin';
    let port: string | null = null;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' && args[i + 1]) { user = args[++i]; continue; }
      if (a === '-p' && args[i + 1]) { port = args[++i]; continue; }
      if (a.startsWith('-')) continue;
      rest.push(a);
    }
    if (rest.length === 0) return 'Error: Incomplete command.';
    let host = rest[0];
    const at = host.indexOf('@');
    if (at !== -1) { user = host.slice(0, at); host = host.slice(at + 1); }
    if (!port && rest[1] && /^\d+$/.test(rest[1])) port = rest[1];
    const cmd = rest.slice(port ? 2 : 1).join(' ');
    const router = this.routerRef as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostnameInternal: () => string;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    if (!router) return 'Error: device not bound';
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;
    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return 'Error: no usable interface IP for outbound SSH';
    const sshStack = (this.routerRef as unknown as {
      getTcpStack?: () => { hasEgressTo(ip: string): boolean };
    } | null)?.getTcpStack?.();
    if (sshStack && IPAddress.tryParse(host) && !sshStack.hasEgressTo(host)) {
      return VRP_SSH.unreachable(host, 22);
    }
    const clientArgs: string[] = [];
    if (port) clientArgs.push('-p', port);
    clientArgs.push('-o', 'StrictHostKeyChecking=accept-new');
    clientArgs.push(`${user}@${host}`);
    if (cmd) clientArgs.push(cmd);
    const result = runSshClient({
      args: clientArgs,
      sourceHostname: router._getHostnameInternal(),
      sourceIp, sourceUser: user,
      localVfs: { readFile: () => null, writeFile: () => undefined },
    });
    return result.output;
  }

  /**
   * Outbound Telnet driven by the real topology — mirrors
   * CiscoShellBase.runOutboundTelnet: resolve the target, pick a source
   * interface, and verify L2/L3 reachability plus the remote VTY's
   * `protocol inbound` transport before reporting success. As on Cisco,
   * this never pushes a nested interactive session (see the Telnet note
   * in CLAUDE.md's Terminal emulation section).
   */
  private runOutboundTelnet(args: string[]): string {
    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length === 0) return 'Error: Incomplete command.';
    const display = positional[0];
    const port = positional[1] ? parseInt(positional[1], 10) : 23;
    const router = this.routerRef as unknown as {
      _getPortsInternal: () => Map<string, { getIPAddress: () => { toString: () => string } | null; getIsUp: () => boolean }>;
      _getHostsTable?: () => { resolve: (n: string) => string | null };
    };
    if (!router) return 'Error: device not bound';
    let host = display;
    const resolved = router._getHostsTable?.().resolve(host);
    if (resolved) host = resolved;

    let sourceIp: string | null = null;
    for (const [, p] of router._getPortsInternal()) {
      const ip = p.getIPAddress();
      if (ip && p.getIsUp()) { sourceIp = ip.toString(); break; }
    }
    if (!sourceIp) return `Trying ${display} ...\nError: Failed to connect to the remote host.`;

    const remote = findHostByAddress(host, undefined, this.routerRef as never);
    if (!remote || remote.poweredOff || remote.interfaceDown) {
      return `Trying ${display} ...\nError: Failed to connect to the remote host.`;
    }
    if (!isPathReachable(sourceIp, remote.ip, this.routerRef as never)) {
      return `Trying ${display} ...\nError: Failed to connect to the remote host.`;
    }
    if (!this.remoteAcceptsTelnet(remote.device, port)) {
      return `Trying ${display} ...\nError: Failed to connect to the remote host.`;
    }
    return `Trying ${display} ...\nPress CTRL+K to abort\nConnected to ${display} ...\n`;
  }

  private remoteAcceptsTelnet(device: unknown, port: number): boolean {
    if (port !== 23) return false;
    const d = device as { getDeviceType?: () => string; constructor: { name: string } };
    const cls = d.constructor?.name ?? '';
    const type = (d.getDeviceType?.() ?? '').toLowerCase();
    const isNetworkCli = /Router|Switch/.test(cls) || /router|switch/.test(type);
    if (!isNetworkCli) return false;
    const transport = (device as { _getVtyTransportInput?: () => string })._getVtyTransportInput?.();
    if (transport === undefined) return true;
    return transport === 'telnet' || transport === 'all';
  }

  private cmdQuit(): string {
    switch (this.mode) {
      case 'interface':
        this.mode = 'system';
        this.selectedInterface = null;
        return '';
      case 'dhcp-pool':
        this.mode = 'system';
        this.selectedPool = null;
        return '';
      case 'ospf-area':
        this.mode = 'ospf';
        this.ospfArea = null;
        return '';
      case 'pim':
        this.mode = 'system';
        return '';
      case 'ospf':
        this.mode = 'system';
        return '';
      case 'bgp':
        this.mode = 'system';
        this.bgpAsn = null;
        return '';
      case 'isis':
        this.mode = 'system';
        this.isisProcessId = null;
        return '';
      case 'ospfv3':
        this.mode = 'system';
        return '';
      case 'ospfv3-area':
        this.mode = 'ospfv3';
        this.ospfArea = null;
        return '';
      case 'rip':
        this.mode = 'system';
        return '';
      case 'ui':
        this.mode = 'system';
        return '';
      case 'ike-proposal':
        this.mode = 'system';
        this.selectedIKEProposal = null;
        return '';
      case 'ike-peer':
        this.mode = 'system';
        this.selectedIKEPeer = null;
        return '';
      case 'ipsec-proposal':
        this.mode = 'system';
        this.selectedIPSecProposal = null;
        return '';
      case 'ipsec-policy':
        this.mode = 'system';
        this.selectedIPSecPolicy = null;
        this.selectedIPSecPolicySeq = null;
        return '';
      case 'acl-basic':
      case 'acl-advanced':
        this.mode = 'system';
        this.selectedACLNumber = null;
        this.selectedACLMode = null;
        this.selectedACLName = null;
        return '';
      case 'ikev2-proposal':
      case 'ikev2-policy':
      case 'ikev2-profile':
        this.mode = 'system';
        this.selectedIPSecProposal = null;
        this.selectedIPSecPolicy = null;
        return '';
      case 'ikev2-keyring':
        this.mode = 'system';
        this.selectedIKEPeer = null;
        return '';
      case 'ikev2-keyring-peer':
        this.mode = 'ikev2-keyring';
        this.selectedIPSecProposal = null;
        return '';
      case 'route-policy':
        this.mode = 'system';
        this.selectedRoutePolicy = null;
        this.selectedRoutePolicyNode = null;
        return '';
      case 'traffic-classifier':
        this.mode = 'system';
        this.selectedClassifier = null;
        return '';
      case 'traffic-behavior':
        this.mode = 'system';
        this.selectedBehavior = null;
        return '';
      case 'traffic-policy':
        this.mode = 'system';
        this.selectedTrafficPolicy = null;
        return '';
      case 'nqa-test':
        this.mode = 'system';
        this.selectedNqa = null;
        return '';
      case 'aaa':
        this.mode = 'system';
        this.selectedAaaScheme = null;
        return '';
      case 'aaa-authen':
      case 'aaa-author':
      case 'aaa-accounting':
      case 'aaa-domain':
        this.mode = 'aaa';
        this.selectedAaaScheme = null;
        return '';
      case 'radius-template':
      case 'hwtacacs-template':
        this.mode = 'system';
        this.selectedAaaScheme = null;
        return '';
      case 'cpu-defend-policy':
        this.mode = 'system';
        this.selectedCpuDefendPolicy = null;
        return '';
      case 'bfd-global':
        this.mode = 'system';
        return '';
      case 'bfd-session':
        this.mode = 'system';
        this.selectedBfdSession = null;
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

  // ─── Help / Completion ─────────────────────────────────────────────

  getHelp(input: string, router?: Router): string {
    const trie = this.getActiveTrie();
    trie.setDynamicResolver(router ? new EquipmentParamResolver(router) : null);
    try {
      const duSocle = this.socle().suggestions(input, this.mode, 'QUESTION_MARK');
      const completions = withVrpCommonHelp(this.vrpView(), input,
        [...trie.getCompletions(input), ...duSocle.filter(s =>
          !trie.getCompletions(input).some(c => c.keyword === s.keyword))]);
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

  tabCandidates(input: string, router: Router): string[] {
    const trie = this.getActiveTrie();
    trie.setDynamicResolver(new EquipmentParamResolver(router));
    try {
      const duTrie = trie.tabCandidates(input);
      const duSocle = this.socle().candidates(input, this.mode)
        .filter(c => !duTrie.includes(c));
      return withVrpCommonCandidates(this.vrpView(), input, [...duTrie, ...duSocle]);
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

  // ─── Active Trie Selection ─────────────────────────────────────────

  private getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user': return this.userTrie;
      case 'system': return this.systemTrie;
      case 'interface': return this.interfaceTrie;
      case 'dhcp-pool': return this.dhcpPoolTrie;
      case 'pim': return this.pimTrie;
      case 'ospf': return this.ospfTrie;
      case 'ospf-area': return this.ospfAreaTrie;
      case 'bgp': return this.bgpTrie;
      case 'isis': return this.isisTrie;
      case 'ospfv3': return this.ospfv3Trie;
      case 'ospfv3-area': return this.ospfv3AreaTrie;
      case 'rip': return this.ripTrie;
      case 'ike-proposal': return this.ikeProposalTrie;
      case 'ike-peer': return this.ikePeerTrie;
      case 'ipsec-proposal': return this.ipsecProposalTrie;
      case 'ipsec-policy': return this.ipsecPolicyTrie;
      case 'ui': return this.uiTrie;
      case 'acl-basic': return this.aclBasicTrie;
      case 'acl-advanced': return this.aclAdvancedTrie;
      case 'ikev2-proposal': return this.ikev2ProposalTrie;
      case 'ikev2-policy': return this.ikev2PolicyTrie;
      case 'ikev2-keyring': return this.ikev2KeyringTrie;
      case 'ikev2-keyring-peer': return this.ikev2KeyringPeerTrie;
      case 'ikev2-profile': return this.ikev2ProfileTrie;
      case 'route-policy': return this.routePolicyTrie;
      case 'traffic-classifier': return this.trafficClassifierTrie;
      case 'traffic-behavior': return this.trafficBehaviorTrie;
      case 'traffic-policy': return this.trafficPolicyTrie;
      case 'nqa-test': return this.nqaTestTrie;
      case 'aaa': return this.aaaTrie;
      case 'aaa-authen': return this.aaaAuthenTrie;
      case 'aaa-author': return this.aaaAuthorTrie;
      case 'aaa-accounting': return this.aaaAccountingTrie;
      case 'aaa-domain': return this.aaaDomainTrie;
      case 'radius-template': return this.radiusTemplateTrie;
      case 'hwtacacs-template': return this.hwtacacsTemplateTrie;
      case 'cpu-defend-policy': return this.cpuDefendPolicyTrie;
      case 'bfd-global': return this.bfdGlobalTrie;
      case 'bfd-session': return this.bfdSessionTrie;
      default: return this.userTrie;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Command Registration (per-mode CommandTrie construction)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Overwrite the `screen-length` / `screen-width` greedy stubs from
   * `registerHuaweiCommonMgmt` with handlers that actually mutate the
   * shell's per-vty preferences. Called from each per-mode trie builder
   * after the common-mgmt registration, so the latest action wins.
   *
   * Syntax (VRP):
   *   screen-length <0-512> [temporary]   — set rows (0 = pager off)
   *   screen-length disable               — alias for `screen-length 0`
   *   undo screen-length                  — restore default (24)
   *   screen-width <80-512>               — set columns
   *   undo screen-width                   — restore default (80)
   */
  private registerScreenSizeCommands(t: CommandTrie): void {
    t.registerGreedy('screen-length', 'Set terminal screen length', (args, rawLine) => {
      if (args.length === 0) return HUAWEI_ERRORS.INCOMPLETE(rawLine);
      const head = args[0].toLowerCase();
      if (head === 'disable') { this.screenLength = 0; return ''; }
      const n = parseInt(head, 10);
      if (!Number.isFinite(n) || n < 0 || n > 512) {
        return HUAWEI_ERRORS.UNRECOGNIZED(rawLine, rawLine.length - args.join(' ').length);
      }
      this.screenLength = n;
      return '';
    });
    t.registerGreedy('screen-width', 'Set terminal screen width', (args, rawLine) => {
      if (args.length === 0) return HUAWEI_ERRORS.INCOMPLETE(rawLine);
      const n = parseInt(args[0], 10);
      if (!Number.isFinite(n) || n < 80 || n > 512) {
        return HUAWEI_ERRORS.UNRECOGNIZED(rawLine, rawLine.length - args.join(' ').length);
      }
      this.screenWidth = n;
      return '';
    });
    t.registerGreedy('undo screen-length', 'Restore default screen length', () => {
      this.screenLength = 24; return '';
    });
    t.registerGreedy('undo screen-width', 'Restore default screen width', () => {
      this.screenWidth = 80; return '';
    });
  }

  /**
   * Un bloc de la configuration, de sa tete a la fin du bloc.
   *
   * Quatre copies de cette marche existaient, une par vue, et chacune
   * s'arretait sur `#` seulement — ce qui laissait tout passer quand un
   * separateur manquait. Elle s'arrete maintenant AUSSI sur toute ligne
   * de premier niveau, donc elle ne peut plus deborder du bloc meme si
   * la structure change.
   */
  private blocDe(lignes: readonly string[], estTete: (l: string) => boolean): string {
    const out: string[] = ['#'];
    let dedans = false;
    for (const l of lignes) {
      if (!dedans) { if (estTete(l)) { dedans = true; out.push(l); } continue; }
      if (l === '#' || (l.length > 0 && !/^\s/.test(l))) break;
      out.push(l);
    }
    out.push('#');
    return out.join('\n');
  }

  private renderDisplayThis(): string {
    const router = this.r();
    const config = displayCurrentConfig(router, this.dhcpEnabled, this.dhcpSnoopingEnabled);
    const lines = config.split('\n');
    const selIface = this.selectedInterface;
    switch (this.mode) {
      case 'interface': {
        if (!selIface) return '#';
        const tete = `interface ${huaweiDisplayInterfaceName(selIface)}`;
        return this.blocDe(lines, (l) => l === tete);
      }
      case 'ospf':
      case 'ospf-area':
        return this.blocDe(lines, (l) => /^ospf \d/.test(l));
      case 'rip':
        return this.blocDe(lines, (l) => /^rip \d/.test(l));
      case 'dhcp-pool': {
        if (!this.selectedPool) return '#';
        const tete = `ip pool ${this.selectedPool}`;
        return this.blocDe(lines, (l) => l === tete);
      }
      // `aaa` et `acl` tombaient dans le `default` et rendaient la
      // configuration ENTIERE : la vue courante n'etait pas filtree du
      // tout, alors que c'est la seule raison d'etre de la commande.
      case 'aaa':
        return this.blocDe(lines, (l) => l === 'aaa');
      case 'acl-basic':
      case 'acl-advanced': {
        const tete = this.selectedACLName !== null
          ? new RegExp(`^acl name ${this.selectedACLName}\\b`)
          : new RegExp(`^acl number ${this.selectedACLNumber}$`);
        return this.blocDe(lines, (l) => tete.test(l));
      }
      // En vue systeme, la vue courante EST la machine : rendre toute la
      // configuration y est juste, et non un defaut.
      default:
        return config;
    }
  }

  private registerDisplayThis(t: CommandTrie): void {
    t.register('display this', 'Display current view configuration', () => this.renderDisplayThis());
  }

  private registerSecurityDisplayCommands(t: CommandTrie): void {
    const aaa = () => this.r().getHuaweiAaaService();
    const fwState = () => {
      const r = vrpStores(this.r());
      return r._huaweiFirewall ?? (r._huaweiFirewall = { enabled: false, defenses: new Set<string>() });
    };
    t.register('display domain', 'Display AAA domains', () => {
      const s = aaa();
      if (s.domains.size === 0) return ' No AAA domain configured.';
      return [...s.domains.keys()].map(d => ` Domain: ${d}`).join('\n');
    });
    t.register('display radius-server configuration', 'Display RADIUS templates', () => {
      const s = aaa();
      if (s.radiusTemplates.size === 0) return ' No RADIUS template configured.';
      return [...s.radiusTemplates.values()].map((t) => {
        const lines = [` RADIUS template: ${t.name}`];
        if (t.authentication) {
          lines.push(`  Authentication IP           : ${t.authentication.ip}`);
          lines.push(`  Authentication port         : ${t.authentication.port ?? 1812}`);
        }
        if (t.accounting) {
          lines.push(`  Accounting IP               : ${t.accounting.ip}`);
          lines.push(`  Accounting port             : ${t.accounting.port ?? 1813}`);
        }
        return lines.join('\n');
      }).join('\n');
    });
    t.register('display hwtacacs-server template', 'Display HWTACACS templates', () => {
      const s = aaa();
      if (s.hwtacacsTemplates.size === 0) return ' No HWTACACS template configured.';
      return [...s.hwtacacsTemplates.keys()].map(n => ` HWTACACS template: ${n}`).join('\n');
    });
    t.register('display ssh server session', 'Display SSH server sessions', () => {
      const ssh = this.r().getManagementService().getSsh();
      if (!ssh.enabled) return 'SSH server is not enabled.';
      const header = 'Conn   Ver  Idle    User       IP';
      const sessions = this.r().getSshSessionRegistry().list();
      if (sessions.length === 0) return `${header}\n(none) ${ssh.version}    --      --         --`;
      const rows = sessions.map((s, i) => {
        const h = Math.floor(s.idleSeconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((s.idleSeconds % 3600) / 60).toString().padStart(2, '0');
        const sec = Math.floor(s.idleSeconds % 60).toString().padStart(2, '0');
        return `${(i + 1).toString().padEnd(6)} ${ssh.version}    ${h}:${m}:${sec}  ${s.user.padEnd(10)} ${s.fromIp}`;
      });
      return [header, ...rows].join('\n');
    });
    t.register('display rsa local-key-pair public', 'Display RSA public key', () => {
      const ks = this.r().getKeypairService();
      const pair = ks.list().find((k) => k.algo === 'rsa');
      if (!pair) return 'Info: No RSA key pair has been generated.';
      return [
        `Time of Key pair created: ${new Date(pair.createdAtMs).toUTCString()}`,
        `Key size : ${pair.modulusBits}`,
        `Fingerprint: ${pair.fingerprint}`,
        `Public key:`,
        pair.publicKeyBlob,
      ].join('\n');
    });
    t.register('display time-range all', 'Display time-ranges', () => {
      const r = vrpStores(this.r());
      const trs = r._huaweiTimeRanges;
      if (!trs || trs.size === 0) return 'No time-range configured.';
      return [...trs.values()].map(tr => ` Name: ${tr.name}, spec: ${tr.spec}`).join('\n');
    });
    t.register('display traffic-filter applied-record', 'Display traffic-filter applications', () => {
      const bindings = this.r()._getInterfaceACLBindingsInternal() as Map<string, { inbound?: number | string | null; outbound?: number | string | null }>;
      const rows: string[] = [];
      for (const [iface, dirs] of bindings) {
        if (dirs.inbound != null) rows.push(` ${iface.padEnd(18)} inbound    ${dirs.inbound}`);
        if (dirs.outbound != null) rows.push(` ${iface.padEnd(18)} outbound   ${dirs.outbound}`);
      }
      if (rows.length === 0) return ' No traffic-filter applied on any interface.';
      return [' Interface          Direction  ACL', ...rows].join('\n');
    });
    t.registerGreedy('display cpu-defend policy', 'Display CPU-defend policies', (_args) => {
      const r = vrpStores(this.r());
      const ps = r._huaweiCpuDefendPolicies;
      if (!ps || ps.size === 0) return 'No CPU-defend policy configured.';
      return [...ps.keys()].map(n => ` Policy: ${n}`).join('\n');
    });
    t.register('display firewall defend flag', 'Display firewall defenses', () => {
      const s = fwState();
      if (s.defenses.size === 0) return 'No firewall defenses enabled.';
      return [...s.defenses].map(d => ` ${d}: enabled`).join('\n');
    });
    t.register('display logbuffer summary', 'Display logbuffer summary', () => 'Log buffer: 0 messages.');
    // Une phrase en dur — « No info-center channels configured » — sur
    // une machine qui en a DIX d'usine. La vue lit maintenant la table.
    registerInfoCenterDisplayCommands(t, {
      config: () => this.r().getManagementService?.().getInfoCenter(),
    });
    t.registerGreedy('reset logbuffer', 'Reset logbuffer', () => '');
    registerVrpLldpDisplayCommands(t, {
      agent: () => this.lldpAgent(),
      hostname: () => this.r().getHostname(),
      portNames: () => this.r().getPorts().map(p => p.getName()),
      displayName: (n) => huaweiDisplayInterfaceName(n),
      resolveInterface: (raw) => resolveHuaweiInterfaceName(this.r(), raw),
    });
  }

  private lldpAgent(): import('@/network/lldp/LldpAgent').LldpAgent | null {
    return (this.routerRef as unknown as {
      getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent
    })?.getLldpAgent?.() ?? null;
  }

  private applyToLldpAgent(
    fn: (a: import('@/network/lldp/LldpAgent').LldpAgent) => void,
  ): void {
    const agent = this.lldpAgent();
    if (agent) fn(agent);
  }

  /** Le magasin unique de l'etat `debugging` de cet equipement. */
  protected debugService(): HuaweiDebugService | null {
    return (this.routerRef as unknown as { getHuaweiDebugService?: () => HuaweiDebugService })
      ?.getHuaweiDebugService?.() ?? null;
  }

  getScreenLength(): number { return this.screenLength; }
  /** Symmetric with getScreenLength — column hint. */
  getScreenWidth(): number { return this.screenWidth; }

  // ─── User View (<hostname>) ──────────────────────────────────────

  private buildUserInterfaceCommands(): void {
    const t = this.uiTrie;
    // No-op keywords accepted at the user-interface view.
    for (const kw of ['user', 'screen-length', 'history-command', 'shell',
      'set', 'authorization-mode']) {
      t.registerGreedy(kw, `user-interface ${kw}`, (args, raw) => {
        const r = this.selectedUiRange;
        if (!r) return '';
        const lc = this.routerRef?._getVtyLineConfig?.();
        if (!lc) return '';
        const update: Record<string, unknown> = { first: r.first, last: r.last };
        if (kw === 'screen-length' && args[0]) {
          update.screenLength = parseInt(args[0], 10);
        } else if (kw === 'history-command' && args[0] === 'max-size' && args[1]) {
          update.historyCommandMaxSize = parseInt(args[1], 10);
        } else if (kw === 'shell') {
          update.shellEnabled = true;
        } else if (kw === 'authorization-mode' && args[0]) {
          update.authorizationMode = args[0];
        } else if (kw === 'user' && args[0] === 'privilege' && args[1] === 'level' && args[2]) {
          update.privilegeLevel = parseInt(args[2], 10);
        } else {
          update.rawLine = raw ?? `${kw} ${args.join(' ')}`.trim();
        }
        lc.upsert(update as unknown as Parameters<typeof lc.upsert>[0]);
        return '';
      });
    }
    t.registerGreedy('idle-timeout', 'Set idle-timeout', (args) => {
      const r = this.selectedUiRange; if (!r) return '';
      this.routerRef?._getVtyLineConfig?.().upsert({
        first: r.first, last: r.last,
        idleTimeoutMinutes: Number.parseInt(args[0] ?? '0', 10),
        idleTimeoutSeconds: Number.parseInt(args[1] ?? '0', 10),
      });
      return '';
    });
    t.registerGreedy('authentication-mode', 'Set authentication mode', (args) => {
      const r = this.selectedUiRange; if (!r) return '';
      const mode = (args[0] ?? '').toLowerCase();
      if (mode === 'aaa' || mode === 'password' || mode === 'none') {
        this.routerRef?._getVtyLineConfig?.().upsert({
          first: r.first, last: r.last, authenticationMode: mode,
        });
      }
      return '';
    });
    /**
     * `set authentication password [cipher|simple] <mdp>` : le mot de
     * passe que reclame `authentication-mode password`. Il etait accepte
     * et JETE, donc le mode s'affichait sans qu'aucun secret existe et la
     * ligne accordait a n'importe qui. Le secret est range en clair et
     * rendu chiffre, comme VRP le fait ; relu, il est dechiffre, sans
     * quoi un aller-retour d'import ferait du chiffre le mot de passe.
     */
    t.registerGreedy('set authentication password', 'Set the line authentication password', (args) => {
      const r = this.selectedUiRange; if (!r) return '';
      const forme = (args[0] ?? '').toLowerCase();
      const brut = (forme === 'cipher' || forme === 'simple') ? args[1] : args[0];
      if (!brut) return 'Error: Incomplete command found at \'^\' position.';
      const clair = looksLikeReversibleCipher(brut) ? huaweiDecipher(brut) : brut;
      this.routerRef?._getVtyLineConfig?.().upsert({
        first: r.first, last: r.last, linePassword: clair,
      });
      return '';
    });
    /**
     * `user privilege level <n>` : le niveau auquel la LIGNE ouvre la
     * session, qui l'emporte sur celui du compte. Accepte et range nulle
     * part, donc une vty ouverte au niveau 1 rendait tout de meme le
     * niveau 15 du compte.
     */
    t.registerGreedy('user privilege', 'Set the privilege level of the user interface', (args) => {
      const r = this.selectedUiRange; if (!r) return '';
      if ((args[0] ?? '').toLowerCase() !== 'level') return 'Error: Unrecognized command found at \'^\' position.';
      const niveau = Number.parseInt(args[1] ?? '', 10);
      if (!Number.isFinite(niveau) || niveau < 0 || niveau > 15) {
        return 'Error: Wrong parameter found at \'^\' position.';
      }
      this.routerRef?._getVtyLineConfig?.().upsert({ first: r.first, last: r.last, privilege: niveau });
      return '';
    });
    t.registerGreedy('acl', 'Apply ACL to VTY', (args) => {
      const r = this.selectedUiRange; if (!r) return '';
      const dir = (args[1] ?? 'inbound').toLowerCase();
      const field = dir === 'outbound' ? 'aclOutbound' : 'aclInbound';
      this.routerRef?._getVtyLineConfig?.().upsert({
        first: r.first, last: r.last, [field]: args[0],
      });
      return '';
    });
    // `protocol inbound {ssh|telnet|all|none}` routes through the device
    // so CrossVendorSshHost sees the change (matches Cisco transport input).
    t.registerGreedy('protocol', 'user-interface protocol inbound', (args) => {
      if (args[0]?.toLowerCase() !== 'inbound' || !args[1]) return '';
      const proto = args[1].toLowerCase() as 'ssh' | 'telnet' | 'all' | 'none';
      if (['ssh', 'telnet', 'all', 'none'].includes(proto)) {
        const dev = this.routerRef as unknown as {
          _setVtyTransportInput?: (t: 'ssh' | 'telnet' | 'all' | 'none', range?: { first: number; last: number }) => void;
        };
        dev?._setVtyTransportInput?.(proto, this.selectedUiRange ?? undefined);
      }
      return '';
    });
    // `undo protocol inbound [ssh|telnet]` — removing one transport leaves
    // the other (matches VRP convention); with no arg, both are removed.
    t.registerGreedy('undo', 'user-interface undo', (args) => {
      if (args[0]?.toLowerCase() !== 'protocol' || args[1]?.toLowerCase() !== 'inbound') return '';
      const removed = (args[2] ?? '').toLowerCase();
      const dev = this.routerRef as unknown as {
        _setVtyTransportInput?: (t: 'ssh' | 'telnet' | 'all' | 'none', range?: { first: number; last: number }) => void;
      };
      if (!dev?._setVtyTransportInput) return '';
      const plage = this.selectedUiRange ?? undefined;
      if (removed === 'ssh') dev._setVtyTransportInput('telnet', plage);
      else if (removed === 'telnet') dev._setVtyTransportInput('ssh', plage);
      else dev._setVtyTransportInput('none', plage);
      return '';
    });
  }

  private buildUserCommands(): void {
    const t = this.userTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    t.register('system-view', 'Enter system view', () => {
      this.mode = 'system';
      return 'Enter system view, return user view with return command.';
    });

    // `stelnet [user@]host [port]` and `ssh [-l user] host` — outbound
    // SSH client, dispatched through the shared runSshClient so every
    // gate (host key TOFU, sshd policy, VTY ACL) applies uniformly.
    for (const verb of ['stelnet', 'ssh']) {
      t.registerGreedy(verb, `${verb} client`, (args) => this.runOutboundSshClient(args));
    }

    // Display commands
    registerDisplayCommands(t, getRouter, getState);

    // VRP lifecycle/management commands (shared with the switch, DRY)
    registerHuaweiCommonMgmt(t, { service: () => this.debugService(), platform: 'router' });
    t.registerGreedy('header', 'Configure login/shell banner', (args) => {
      const router = getRouter() as unknown as { _setSshBanner?: (b: string) => void };
      if (typeof router._setSshBanner === 'function') {
        const rest = args.slice(args[0] === 'login' && args[1] === 'information' ? 2 : 1).join(' ');
        router._setSshBanner(rest.replace(/^["']/, '').replace(/["']$/, ''));
      }
      return '';
    });
    this.registerScreenSizeCommands(t);
    registerHuaweiCommonSecurityDisplay(t, () => new Map(), undefined,
      () => this.r()?.getSnmpService());

    // OSPF display commands
    registerOSPFDisplayCommands(t, getRouter);

    // IGMP display commands
    registerHuaweiIgmpDisplayCommands(t, getRouter);

    // PIM display commands
    registerHuaweiPimDisplayCommands(t, getRouter);

    // IPSec display commands
    registerHuaweiIPSecDisplayCommands(t, getRouter);

    // ACL display commands
    registerHuaweiACLDisplayCommands(t, getRouter);

    // NAT display commands
    registerHuaweiNATDisplayCommands(t, getRouter);

    // VXLAN display commands
    registerHuaweiVxlanDisplayCommands(t, { r: getRouter });

    // Backward-compat aliases in user view
    t.registerGreedy('ip route-static', 'Configure static route', (args, raw) => {
      return cmdIpRouteStatic(getRouter(), args, raw);
    });

    t.registerGreedy('rip', 'Configure RIP routing', (args) => {
      return cmdRip(getRouter(), args);
    });

    t.registerGreedy('bgp', 'Configure BGP routing', (args) => {
      const asn = parseInt(args[0] ?? '', 10);
      if (isNaN(asn)) return 'Error: Invalid AS number';
      getRouter().getHuaweiRoutingExtras().ensureBgp(asn);
      getRouter().getBGPEngine().enable({ asn });
      this.bgpAsn = asn;
      this.mode = 'bgp';
      return '';
    });
    t.registerGreedy('undo bgp', 'Remove BGP', (args) => {
      const asn = parseInt(args[0] ?? '', 10);
      if (!isNaN(asn)) {
        getRouter().getHuaweiRoutingExtras().removeBgp();
        getRouter().getBGPEngine().disable();
        getRouter().convergeDynamicRouting();
      }
      return '';
    });
    t.registerGreedy('isis', 'Configure IS-IS routing', (args) => {
      const pid = args[0] ? parseInt(args[0], 10) : 1;
      const id = isNaN(pid) ? 1 : pid;
      getRouter().getHuaweiRoutingExtras().ensureIsis(id);
      this.isisProcessId = id;
      this.mode = 'isis';
      return '';
    });
    t.registerGreedy('undo isis', 'Remove IS-IS', (args) => {
      const pid = parseInt(args[0] ?? '', 10);
      if (!isNaN(pid)) getRouter().getHuaweiRoutingExtras().removeIsis(pid);
      return '';
    });

    t.registerGreedy('undo', 'Undo configuration', (args) => {
      return cmdUndo(getRouter(), this, args);
    });

    // tracert — route tracing (async)
    t.registerGreedy('tracert', 'Trace route to destination', (args) => {
      return this._handleTracert(args);
    });

    // ping — ICMP echo (async)
    t.registerGreedy('ping', 'Send ICMP echo messages', (args) => {
      return this._handlePing(args);
    });

    // reset arp — clear all ARP entries
    t.register('reset arp', 'Clear all ARP entries', () => {
      getRouter()._clearARPCache();
      return '';
    });

    t.register('reset arp all', 'Clear all ARP entries', () => {
      getRouter()._clearARPCache();
      return '';
    });

    // reset arp dynamic — clear only dynamic ARP entries
    t.register('reset arp dynamic', 'Clear dynamic ARP entries', () => {
      const arpTable = getRouter()._getArpTableInternal();
      for (const [ip, entry] of [...arpTable.entries()]) {
        if (entry.type !== 'static') arpTable.delete(ip);
      }
      return '';
    });

    t.registerGreedy('reset arp interface', 'Clear ARP entries for an interface', (args) => {
      if (!args[0]) return '';
      const arp = getRouter()._getArpTableInternal();
      for (const [ip, entry] of [...arp.entries()]) {
        if (entry.iface === args[0]) arp.delete(ip);
      }
      return '';
    });

    // reset counters — reset IP traffic counters
    t.register('reset counters', 'Reset traffic counters', () => {
      getRouter().resetCounters();
      return '';
    });

    t.registerGreedy('reset counters interface', 'Reset interface counters', (args) => {
      const router = getRouter();
      if (!args[0]) { router.resetCounters(); return ''; }
      const port = router.getPort(args[0]);
      port?.resetCounters();
      return '';
    });

    t.registerGreedy('reset ip routing-table statistics', 'Reset routing-table statistics', (_args) => {
      return '';
    });

    // reset acl counter { all | name <name> | <number> } — zero ACE match counters
    t.registerGreedy('reset acl counter', 'Reset ACL match counters', (args) => {
      const router = getRouter();
      if (!args[0] || args[0].toLowerCase() === 'all') {
        router.resetAllAclCounters();
        return '';
      }
      const ref = args[0].toLowerCase() === 'name' ? args[1] : args[0];
      if (!ref) return 'Error: Incomplete command.';
      const numRef = /^\d+$/.test(ref) ? parseInt(ref, 10) : ref;
      router.resetAclCounters(numRef);
      return '';
    });

    t.registerGreedy('reset dhcp', 'Reset DHCP statistics / bindings', (_args) => {
      return '';
    });

    t.registerGreedy('reset rip', 'Reset RIP counters/process', (_args) => '');
    t.registerGreedy('reset isis', 'Reset IS-IS data', (_args) => '');
    t.registerGreedy('reset bgp', 'Reset BGP data', (_args) => '');

    t.register('terminal debugging', 'Send debug output to this terminal', () => {
      this.terminalDebugging = true;
      return 'Info: Current terminal debugging is on.';
    });
    t.register('undo terminal debugging', 'Stop sending debug output to this terminal', () => {
      this.terminalDebugging = false;
      return 'Info: Current terminal debugging is off.';
    });
    t.register('terminal monitor', 'Send log output to this terminal', () => {
      this.terminalMonitor = true;
      return 'Info: Current terminal monitor is on.';
    });
    t.register('undo terminal monitor', 'Stop sending log output to this terminal', () => {
      this.terminalMonitor = false;
      this.terminalDebugging = false;
      return 'Info: Current terminal monitor is off.';
    });

    registerUserInterfaceCommands(
      t,
      () => getSessionRegistry(this.r()),
      () => getVtyLineConfig(this.r()),
    );

    // save — persist configuration (Huawei equivalent of write memory).
    // Captures a REAL snapshot so `display saved-configuration` shows what
    // was saved, not a mirror of the running config.
    t.register('save', 'Save current configuration', () => {
      this.captureSavedConfiguration();
      return 'The current configuration will be written to the device.\nInfo: Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:vrpcfg.zip\nNow saving the current configuration to the slot.\nSave the configuration successfully.';
    });

    // reset saved-configuration — clear the startup snapshot. The inline
    // (vty) form assumes confirmation; the interactive Y/N dialogue is the
    // interaction plan's job (huaweiInteractionPlanFor).
    t.registerGreedy('reset saved-configuration', 'Clear the saved configuration', () => {
      this.r()._eraseStartupConfig();
      return 'Warning: The action will delete the saved configuration on the device.';
    });

    t.registerGreedy('telnet', 'Open Telnet session', (args) => this.runOutboundTelnet(args));

    t.register('compare configuration', 'Compare running vs saved configuration', () => {
      return 'Info: The current configuration is the same as the saved configuration.';
    });

    t.registerGreedy('startup saved-configuration', 'Set startup configuration file', (_args) => {
      return 'Info: Succeeded in setting the file for booting system.';
    });

    // reboot — REAL restart (parity with Cisco reload): power-cycle the
    // device and drop back to user view. The interactive Y/N dialogue is
    // the interaction plan's job; this inline (vty) form assumes yes.
    t.registerGreedy('reboot', 'Reboot device', (_args) => this.performReboot());

    t.register('display health', 'Display device health', () =>
      renderHealth(this.r().getHostname(), AR2220_HARDWARE_PROFILE));
    t.register('display temperature all', 'Display temperature sensors', () =>
      renderTemperature(AR2220_HARDWARE_PROFILE));
    t.register('display fan', 'Display fan status', () =>
      renderFans(AR2220_HARDWARE_PROFILE));
    t.register('display power', 'Display power supply status', () =>
      renderPower(AR2220_HARDWARE_PROFILE));
    t.register('display environment', 'Display environment status', () =>
      renderEnvironment(AR2220_HARDWARE_PROFILE));
    t.register('display tcp status', 'Display TCP listening sockets', () =>
      renderHuaweiTcpStatus(this.r()));
    t.register('display sockets', 'Display open sockets', () =>
      renderHuaweiSockets(this.r()));
    t.register('display dns server', 'Display DNS servers', () => {
      const servers = this.r()._getDnsConfig().nameServers;
      if (servers.length === 0) return 'No DNS server configured.';
      return [
        ' Type: D:Dynamic  S:Static',
        ' Domain-name-server           Type',
        ...servers.map((s) => ` ${s.padEnd(29)}S`),
      ].join('\n');
    });
    t.register('display dns domain', 'Display DNS domain suffixes', () => {
      const cfg = this.r()._getDnsConfig();
      const suffixes = cfg.suffixesDeRecherche();
      if (suffixes.length === 0) return 'No domain name configured.';
      return [
        ' Type: D:Dynamic  S:Static',
        ' No.   Domain-name                             Type',
        ...suffixes.map((s, i) => ` ${String(i + 1).padEnd(6)}${s.padEnd(40)}S`),
      ].join('\n');
    });
    t.register('display dns dynamic-host', 'Display the dynamic DNS cache', () => {
      const entrees = this.r()._getHostsTable().entries().filter((e) => !e.permanent);
      if (entrees.length === 0) return 'No dynamic host resolved.';
      return [
        ' No.  Host                     TTL         IpAddress',
        ...entrees.map((e, i) =>
          ` ${String(i + 1).padEnd(5)}${e.name.padEnd(25)}${String(86400 - e.ageSeconds).padEnd(12)}${e.ips.join(' ')}`),
      ].join('\n');
    });

    registerDhcpDisplayCommands(t, getRouter);
    registerDhcpDebugCommands(t, getRouter);
    registerHuaweiPolicyDisplayCommands(t, getRouter);
    registerHuaweiNqaDisplayCommands(t, getRouter);
    this.registerSecurityDisplayCommands(t);
  }

  // ─── System View ([hostname]) ────────────────────────────────────

  private buildSystemViewCommands(): void {
    const t = this.systemTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    // Display commands (available in all modes)
    registerDisplayCommands(t, getRouter, getState);

    // VRP lifecycle/management commands (shared with the switch, DRY)
    registerHuaweiCommonMgmt(t, { service: () => this.debugService(), platform: 'router' });

    const applyLldp = (fn: (a: import('@/network/lldp/LldpAgent').LldpAgent) => void): void => {
      const ag = (getRouter() as unknown as { getLldpAgent?: () => import('@/network/lldp/LldpAgent').LldpAgent }).getLldpAgent?.();
      if (ag) fn(ag);
    };
    t.register('lldp enable', 'Enable LLDP globally', () => {
      applyLldp(a => a.setEnabled(true));
      return '';
    });
    t.register('undo lldp enable', 'Disable LLDP globally', () => {
      applyLldp(a => a.setEnabled(false));
      return '';
    });
    t.registerGreedy('lldp message-transmission interval', 'Hello period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 5 || n > 32768) return 'Error: Wrong parameter found.';
      applyLldp(a => a.setTimerSec(n));
      return '';
    });
    t.registerGreedy('lldp message-transmission hold-multiplier', 'Hold multiplier', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 2 || n > 10) return 'Error: Wrong parameter found.';
      applyLldp(a => a.setHoldtimeMultiplier(n));
      return '';
    });

    t.registerGreedy('header', 'Configure login/shell banner', (args) => {
      const router = getRouter() as unknown as { _setSshBanner?: (b: string) => void };
      if (typeof router._setSshBanner === 'function') {
        const rest = args.slice(args[0] === 'login' && args[1] === 'information' ? 2 : 1).join(' ');
        router._setSshBanner(rest.replace(/^["']/, '').replace(/["']$/, ''));
      }
      return '';
    });
    t.registerGreedy('ssh', 'SSH server configuration', (args) => {
      const router = getRouter() as unknown as {
        _configureSshAuthRetries?: (n: number) => void;
      };
      if (args[0] === 'server' && args[1] === 'authentication-retries' && /^\d+$/.test(args[2] ?? '')) {
        router._configureSshAuthRetries?.(Number(args[2]));
      }
      return '';
    });
    // `command-alias enable|disable` + `command-alias alias <h> <expansion>`
    // mirror the VRP CLI alias feature consumed by runSshCommandSync.
    t.registerGreedy('command-alias', 'CLI alias configuration', (args) => {
      const table = getRouter()._getCommandAliases?.();
      if (!table) return '';
      const first = args[0]?.toLowerCase();
      if (first === 'enable')  { table.enable();  return ''; }
      if (first === 'disable') { table.disable(); return ''; }
      if (first === 'alias' && args[1] && args.length >= 3) {
        table.add(args[1], args.slice(2).join(' '));
        return '';
      }
      return '';
    });
    t.registerGreedy('undo command-alias', 'Disable CLI alias', (args) => {
      const table = getRouter()._getCommandAliases?.();
      if (!table) return '';
      if (args[0]?.toLowerCase() === 'alias' && args[1]) { table.remove(args[1]); return ''; }
      table.disable();
      return '';
    });

    t.register('dns resolve', 'Enable dynamic DNS resolution', () => {
      this.r()._getDnsConfig().lookupEnabled = true;
      return '';
    });
    t.register('undo dns resolve', 'Disable dynamic DNS resolution', () => {
      this.r()._getDnsConfig().lookupEnabled = false;
      return '';
    });
    t.registerGreedy('dns server', 'Configure a DNS server', (args) => {
      const err = this.r()._getDnsConfig().setNameServers(args);
      if (!err) return '';
      return err.kind === 'incomplete'
        ? 'Error: Incomplete command found at \'^\' position.'
        : 'Error: Wrong parameter found at \'^\' position.';
    });
    t.registerGreedy('undo dns server', 'Remove a DNS server', (args) => {
      this.r()._getDnsConfig().removeNameServers(args);
      return '';
    });
    t.registerGreedy('dns domain', 'Configure a DNS domain suffix', (args) => {
      const err = this.r()._getDnsConfig().addDomainToList(args[0]);
      return err ? 'Error: Incomplete command found at \'^\' position.' : '';
    });
    t.registerGreedy('undo dns domain', 'Remove a DNS domain suffix', (args) => {
      this.r()._getDnsConfig().removeDomainFromList(args[0]);
      return '';
    });

    t.registerGreedy('ip host', 'Configure a static host entry', (args) => {
      if (args.length < 2) return 'Error: Incomplete command.';
      getRouter()._getHostsTable?.().upsert(args[0], args[1]);
      return '';
    });
    t.registerGreedy('undo ip host', 'Remove a static host entry', (args) => {
      if (args.length < 1) return 'Error: Incomplete command.';
      getRouter()._getHostsTable?.().remove(args[0]);
      return '';
    });
    t.registerGreedy('local-user', 'Configure a local user', (args) => this.handleLocalUserCommand(args));
    t.registerGreedy('undo local-user', 'Remove a local user', (args) => {
      if (args[0]) this.r()._removeLocalUser(args[0]);
      return '';
    });
    this.registerScreenSizeCommands(t);
    registerHuaweiCommonSecurity(t, () => this.r() as unknown as { getManagementService: () => import('../router/management/RouterManagementService').RouterManagementService });
    registerHuaweiCommonSecurityDisplay(t, () => new Map(), undefined,
      () => this.r()?.getSnmpService());
    t.registerGreedy('ssh', 'SSH server configuration', (args) => {
      const router = getRouter() as unknown as {
        _configureSshAuthRetries?: (n: number) => void;
      };
      if (args[0] === 'server' && args[1] === 'authentication-retries' && /^\d+$/.test(args[2] ?? '')) {
        router._configureSshAuthRetries?.(Number(args[2]));
      }
      return '';
    });

    // `user-interface vty <first> [last]` — enter VTY user-interface view
    // so subsequent `protocol inbound {ssh|telnet|all|none}` toggles the
    // device's accepted VTY transports.
    t.describeArgs('user-interface', [{
      name: 'type', type: 'ENUM', description: 'User-interface type',
      validator: () => true,
      values: [
        { keyword: 'aux', description: 'Auxiliary line' },
        { keyword: 'console', description: 'Primary terminal line' },
        { keyword: 'maximum-vty', description: 'Maximum number of VTY lines' },
        { keyword: 'vty', description: 'Virtual terminal line' },
      ],
    }, {
      name: 'first-ui-number', type: 'INT',
      description: 'First user-interface number', optional: true, range: [0, 20],
    }, {
      name: 'last-ui-number', type: 'INT',
      description: 'Last user-interface number', optional: true, range: [0, 20],
    }]);
    t.registerGreedy('user-interface', 'Enter user-interface view', (args) => {
      const head = args[0]?.toLowerCase();
      if (head === 'vty') {
        this.uiLabel = args[1] && args[2] ? `${args[1]} ${args[2]}` : (args[1] ?? '0');
        this.mode = 'ui';
        const first = Number.parseInt(args[1] ?? '0', 10);
        const last  = Number.parseInt(args[2] ?? args[1] ?? '0', 10);
        this.selectedUiRange = { first, last };
        this.routerRef?._getVtyLineConfig?.().upsert({ first, last });
      } else if (head === 'console' || head === 'aux') {
        this.uiLabel = `${head}${args[1] ?? '0'}`;
        this.mode = 'ui';
        this.selectedUiRange = null;
      } else if (head === 'maximum-vty' && args[1]) {
        return '';
      }
      return '';
    });

    // System-mode config commands
    buildSystemCommands(t, this);

    // DHCP system-mode commands
    registerDhcpSystemCommands(t, this, {
      setDhcpEnabled: (v) => { this.dhcpEnabled = v; },
      setDhcpSnoopingEnabled: (v) => { this.dhcpSnoopingEnabled = v; },
    });

    // OSPF system-mode commands
    registerOSPFSystemCommands(t, this, (area) => { this.ospfArea = area; });

    t.registerGreedy('bgp', 'Configure BGP routing', (args) => {
      const asn = parseInt(args[0] ?? '', 10);
      if (isNaN(asn)) return 'Error: Invalid AS number';
      this.r().getHuaweiRoutingExtras().ensureBgp(asn);
      this.r().getBGPEngine().enable({ asn });
      this.bgpAsn = asn;
      this.mode = 'bgp';
      return '';
    });
    t.registerGreedy('undo bgp', 'Remove BGP', (args) => {
      const asn = parseInt(args[0] ?? '', 10);
      if (!isNaN(asn)) {
        this.r().getHuaweiRoutingExtras().removeBgp();
        this.r().getBGPEngine().disable();
        this.r().convergeDynamicRouting();
      }
      return '';
    });
    t.registerGreedy('bfd', 'BFD configuration / session', (args) => {
      const svc = this.r().getHuaweiBfdService();
      if (args.length === 0) {
        svc.enable();
        this.setMode('bfd-global');
        return '';
      }
      const name = args[0];
      const session = svc.ensureSession(name);
      let i = 1;
      while (i < args.length) {
        if (args[i] === 'bind' && args[i + 1] === 'peer-ip' && args[i + 2]) {
          session.peerIp = args[i + 2]; i += 3;
        } else if (args[i] === 'source-ip' && args[i + 1]) {
          session.sourceIp = args[i + 1]; i += 2;
        } else if (args[i] === 'interface' && args[i + 1]) {
          session.outIface = args[i + 1]; i += 2;
        } else if (args[i] === 'auto') { session.auto = true; i++; }
        else { i++; }
      }
      this.selectedBfdSession = name;
      this.setMode('bfd-session');
      return '';
    });
    t.register('undo bfd', 'Disable BFD globally', () => {
      this.r().getHuaweiBfdService().disable();
      return '';
    });
    this.buildBfdSubmodes();

    t.registerGreedy('isis', 'Configure IS-IS routing', (args) => {
      const pid = args[0] ? parseInt(args[0], 10) : 1;
      const id = isNaN(pid) ? 1 : pid;
      this.r().getHuaweiRoutingExtras().ensureIsis(id);
      this.isisProcessId = id;
      this.mode = 'isis';
      return '';
    });
    t.registerGreedy('undo isis', 'Remove IS-IS', (args) => {
      const pid = parseInt(args[0] ?? '', 10);
      if (!isNaN(pid)) this.r().getHuaweiRoutingExtras().removeIsis(pid);
      return '';
    });

    // OSPF display commands
    registerOSPFDisplayCommands(t, () => this.r());

    // IGMP display commands
    registerHuaweiIgmpDisplayCommands(t, () => this.r());

    // PIM display commands + the PIM view entry point
    registerHuaweiPimDisplayCommands(t, () => this.r());
    t.registerGreedy('multicast', 'Multicast configuration', (args) => {
      const sub = (args[0] ?? '').toLowerCase();
      // `multicast` seul reclame sa sous-commande : l'aide de la vue
      // systeme le propose, et repondre « ce mot n'existe pas » a une
      // ligne ou aucun mot n'a ete tape la dementait.
      if (sub === '') return 'Error: Incomplete command found at \'^\' position.';
      return sub === 'routing-enable' ? '' : 'Error: Unrecognized command found at \'^\' position.';
    });
    t.addCompletionKeywords('multicast', [
      { keyword: 'routing-enable', description: 'Enable IP multicast routing' },
    ]);
    t.registerGreedy('undo multicast', 'Disable multicast routing', () => '');
    t.register('pim', 'Enter the PIM view', () => { this.mode = 'pim'; return ''; });
    registerHuaweiPimViewCommands(this.pimTrie, this);
    registerHuaweiPimDisplayCommands(this.pimTrie, () => this.r());

    // IPSec system-mode commands
    registerHuaweiIPSecSystemCommands(t, this);

    // IPSec display commands
    registerHuaweiIPSecDisplayCommands(t, () => this.r());

    // ACL system-mode commands
    registerHuaweiACLSystemCommands(t, this);

    // ACL display commands
    registerHuaweiACLDisplayCommands(t, () => this.r());

    // NAT display + system commands
    registerHuaweiNATDisplayCommands(t, () => this.r());
    registerHuaweiNATSystemCommands(t, this);

    // VXLAN display commands
    registerHuaweiVxlanDisplayCommands(t, { r: () => this.r() });

    // DHCP display + DHCPv6 system commands
    registerDhcpDisplayCommands(t, () => this.r());
    registerDhcpv6SystemCommands(t, this);

    // DHCP debug/clear commands
    registerDhcpDebugCommands(t, () => this.r());

    t.register('save', 'Save current configuration', () => {
      this.captureSavedConfiguration();
      return 'The current configuration will be written to the device.\nInfo: Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:vrpcfg.zip\nNow saving the current configuration to the slot.\nSave the configuration successfully.';
    });
    t.registerGreedy('reset saved-configuration', 'Clear the saved configuration', () => {
      this.r()._eraseStartupConfig();
      return 'Warning: The action will delete the saved configuration on the device.';
    });
    t.registerGreedy('reboot', 'Reboot device', (_args) => this.performReboot());

    registerHuaweiPolicySystemCommands(t, this);
    registerHuaweiPolicyDisplayCommands(t, () => this.r());
    registerHuaweiNqaDisplayCommands(t, () => this.r());

    const aaa = () => this.r().getHuaweiAaaService();
    t.register('aaa', 'Enter AAA view', () => { this.setMode('aaa'); return ''; });
    t.registerGreedy('idle-timeout', 'Set idle timeout (system-level no-op)', (_args) => '');
    t.registerGreedy('set authentication password', 'Set authentication password', (_args) => '');
    t.registerGreedy('protocol inbound', 'Set inbound protocol (system-level no-op)', (_args) => '');
    t.registerGreedy('user privilege', 'Set user privilege', (_args) => '');
    t.registerGreedy('radius-server', 'Configure RADIUS server', (args) => {
      if (args[0]?.toLowerCase() === 'template' && args[1]) {
        aaa().ensureRadiusTemplate(args[1]);
        this.selectedAaaScheme = args[1];
        this.setMode('radius-template');
      }
      return '';
    });
    t.registerGreedy('hwtacacs-server', 'Configure HWTACACS server', (args) => {
      if (args[0]?.toLowerCase() === 'template' && args[1]) {
        aaa().ensureHwtacacsTemplate(args[1]);
        this.selectedAaaScheme = args[1];
        this.setMode('hwtacacs-template');
      }
      return '';
    });

    this.buildAaaSubmodes(aaa);

    t.registerGreedy('time-range', 'Define a time-range', (args) => {
      const nom = args[0];
      if (!nom) return HUAWEI_ERRORS.INCOMPLETE(`time-range ${args.join(' ')}`);
      const periode = analyserPeriodeVrp(args.slice(1));
      if (!periode) return HUAWEI_ERRORS.WRONG(`time-range ${args.join(' ')}`);
      const tr = getSecurityConfig(this.r()).ensureTimeRange(nom);
      tr.periodic.push(periode);
      return '';
    });
    t.registerGreedy('undo time-range', 'Remove a time-range', (args) => {
      if (args[0]) getSecurityConfig(this.r()).timeRanges.delete(args[0]);
      return '';
    });

    t.register('rsa local-key-pair create', 'Generate RSA key pair', () => {
      const name = `${this.r().getHostname()}_Host`;
      const pair = this.r().getKeypairService().generate(name, 'rsa', 2048);
      // Creating the key pair is what actually brings STelnet up on VRP,
      // so the listener has to follow it.
      this.r()._refreshSshAvailability();
      return [
        `Info: The name of the key pair will be: ${pair.name}`,
        `The range of public key size is (512 ~ 2048).`,
        `Input the bits in the modulus[default = 2048]: ${pair.modulusBits}`,
        `Info: Keys are generated. Fingerprint: ${pair.fingerprint}`,
      ].join('\n');
    });
    t.register('rsa local-key-pair destroy', 'Destroy the RSA key pair', () => {
      const ks = this.r().getKeypairService();
      const pairs = ks.list().filter((k) => k.algo === 'rsa');
      if (pairs.length === 0) return 'Error: The RSA host key does not exist.';
      for (const p of pairs) ks.destroy(p.name);
      // Destroying them really takes STelnet down — VRP's own version of
      // `crypto key zeroize rsa`, and the classic way to lock yourself out
      // of a box you are reaching over ssh (docs/PRD-Pannes.md §F7.2).
      this.r()._refreshSshAvailability();
      return [
        '% The name for the keys which will be destroyed is '
          + `${this.r().getHostname()}_Host.`,
        'Info: The key pair has been destroyed.',
      ].join('\n');
    });
    t.register('dsa local-key-pair create', 'Generate DSA key pair', () => {
      const name = `${this.r().getHostname()}_Host`;
      const pair = this.r().getKeypairService().generate(name, 'dsa', 1024);
      return [
        `Info: The name of the key pair will be: ${pair.name}`,
        `Info: Keys are generated. Fingerprint: ${pair.fingerprint}`,
      ].join('\n');
    });

    t.registerGreedy('cpu-defend policy', 'Enter CPU-defend policy', (args, raw) => {
      const r = vrpStores(this.r());
      const ps = r._huaweiCpuDefendPolicies ??= new Map<string, VrpNamedLines>();
      const name = args[0];
      if (!name) return 'Error: Incomplete command.';
      if (!ps.has(name)) ps.set(name, { name, lines: [] });
      r._huaweiCpuDefendCurrent = name;
      r._huaweiCpuDefendLines = r._huaweiCpuDefendLines || [];
      r._huaweiCpuDefendLines.push(raw ?? `cpu-defend policy ${args.join(' ')}`);
      this.selectedCpuDefendPolicy = name;
      this.setMode('cpu-defend-policy');
      return '';
    });
    this.cpuDefendPolicyTrie.registerGreedy('car', 'Configure CAR rate-limit', (args, raw) => {
      const r = vrpStores(this.r());
      const name = this.selectedCpuDefendPolicy;
      const ps = r._huaweiCpuDefendPolicies;
      const entry = name && ps ? ps.get(name) : null;
      if (entry) entry.lines.push(raw ?? `car ${args.join(' ')}`);
      (r._huaweiCpuDefendLines ??= []).push(raw ?? `car ${args.join(' ')}`);
      return '';
    });
    t.registerGreedy('cpu-defend-policy', 'Apply CPU-defend policy globally', (args, raw) => {
      const r = vrpStores(this.r());
      r._huaweiCpuDefendGlobal = args[0];
      (r._huaweiCpuDefendLines ??= []).push(raw ?? `cpu-defend-policy ${args.join(' ')}`);
      return '';
    });

    const fwState = () => {
      const r = vrpStores(this.r());
      return r._huaweiFirewall ?? (r._huaweiFirewall = { enabled: false, defenses: new Set<string>() });
    };
    t.register('firewall enable', 'Enable firewall', () => { fwState().enabled = true; return ''; });
    t.register('undo firewall enable', 'Disable firewall', () => { fwState().enabled = false; return ''; });
    t.registerGreedy('firewall defend', 'Enable firewall defense', (args) => {
      const kind = args[0]?.toLowerCase();
      if (kind && args[1] === 'enable') fwState().defenses.add(kind);
      return '';
    });
    t.registerGreedy('undo firewall defend', 'Disable firewall defense', (args) => {
      const kind = args[0]?.toLowerCase();
      if (kind) fwState().defenses.delete(kind);
      return '';
    });

    this.registerSecurityDisplayCommands(t);

    // `info-center enable` a quitté cette boucle : il appartient à
    // l'arbre `info-center`, et le traiter comme `telnet server enable`
    // était ce qui faisait proposer `enable` — décrit `Toggle:
    // info-center enable` — derrière chacun de ses sous-mots.
    for (const kw of [
      'ntp-service enable', 'telnet server enable', 'http server',
      'icmp ttl-exceeded send', 'icmp host-unreachable send']) {
      t.register(kw, `Toggle: ${kw}`, () => {
        this.r()._setGlobalToggle?.(kw.replace(/\s+enable\s*$/, ''), true);
        return '';
      });
    }
    t.register('ftp server enable', 'Start the FTP server', () => {
      this.r()._setFtpServerEnabled(true);
      return '';
    });
    t.registerGreedy('ip routing-table limit', 'Configure IPv4 routing-table limit', (args) => {
      const r = this.routerRef as unknown as { _setRoutingTableLimit?: (max: number, thresholdPct?: number) => void } | null;
      if (!r) return '';
      const max = parseInt(args[0] ?? '', 10);
      const threshold = parseInt(args[1] ?? '', 10);
      if (!isNaN(max)) r._setRoutingTableLimit?.(max, isNaN(threshold) ? undefined : threshold);
      return '';
    });
    t.registerGreedy('undo ip routing-table limit', 'Remove routing-table limit', () => {
      const r = this.routerRef as unknown as { _setRoutingTableLimit?: (max: number | null) => void } | null;
      r?._setRoutingTableLimit?.(null);
      return '';
    });

    // Ces trois nœuds ne sont créés qu'en CHEMIN — personne ne les
    // enregistre pour eux-mêmes — donc ils naissent sans description et
    // `?` les listait nus. Les décrire APRÈS coup est obligatoire :
    // avant, le nœud n'existe pas encore et l'appel est ignoré en
    // silence, ce qui a été mesuré.
    t.describeNode('display radius-server', 'RADIUS server information');
    t.describeNode('display hwtacacs-server', 'HWTACACS server information');
    t.describeNode('ip routing-table', 'Routing table configuration');
    t.registerGreedy('ftp', 'FTP server config', (args) => {
      if (args[0] === 'server' && (args[1] === 'enable' || !args[1])) {
        this.r()._setFtpServerEnabled(true);
      }
      return '';
    });

    t.register('lldp enable', 'Enable LLDP globally', () => {
      this.applyToLldpAgent(a => a.setEnabled(true));
      return '';
    });
    t.register('undo lldp enable', 'Disable LLDP globally', () => {
      this.applyToLldpAgent(a => a.setEnabled(false));
      return '';
    });
    t.registerGreedy('lldp message-transmission interval', 'Hello period (sec)', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(n) || n < 5 || n > 32768) return "Error: Wrong parameter found at '^' position.";
      this.applyToLldpAgent(a => a.setTimerSec(n));
      return '';
    });
    t.registerGreedy('lldp message-transmission hold-multiplier', 'Hold multiplier', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(n) || n < 2 || n > 10) return "Error: Wrong parameter found at '^' position.";
      this.applyToLldpAgent(a => a.setHoldtimeMultiplier(n));
      return '';
    });

    t.registerGreedy('qos queue-profile', 'Configure queue profile', (args, raw) => {
      const r = vrpStores(this.r());
      const ps = r._huaweiQueueProfiles ??= new Map<string, VrpNamedLines>();
      if (args[0]) {
        if (!ps.has(args[0])) ps.set(args[0], { name: args[0], lines: [] });
        ps.get(args[0]).lines.push(raw ?? `qos queue-profile ${args.join(' ')}`);
      }
      return '';
    });
    t.registerGreedy('schedule', 'Schedule WFQ / queue assignment', () => '');
    t.registerGreedy('display qos queue-profile', 'Display queue profiles', () => {
      const r = vrpStores(this.r());
      const ps = r._huaweiQueueProfiles;
      if (!ps || ps.size === 0) return 'Info: No queue-profile configured.';
      return [...ps.keys()].map(n => ` Queue profile: ${n}`).join('\n');
    });
  }

  // ─── Interface View ([hostname-GE0/0/X]) ─────────────────────────

  private buildInterfaceViewCommands(): void {
    const t = this.interfaceTrie;
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;

    // Display commands
    registerDisplayCommands(t, getRouter, getState);

    // OSPF display commands (available in interface view too)
    registerOSPFDisplayCommands(t, getRouter);

    // Interface-specific commands
    buildInterfaceCommands(t, this);

    // OSPF interface commands
    registerOSPFInterfaceCommands(t, this);

    // IGMP interface + display commands
    registerHuaweiIgmpInterfaceCommands(t, this);
    registerHuaweiIgmpDisplayCommands(t, getRouter);

    // PIM interface + display commands
    registerHuaweiPimInterfaceCommands(t, this);
    registerHuaweiPimDisplayCommands(t, getRouter);

    // IPSec interface commands
    registerHuaweiIPSecInterfaceCommands(t, this);

    // ACL interface commands
    registerHuaweiACLInterfaceCommands(t, this);

    registerHuaweiNATInterfaceCommands(t, this);
    registerDhcpInterfaceCommands(t, this);

    buildHuaweiVxlanInterfaceCommands(t, {
      getSelectedInterface: () => this.getSelectedInterface(),
      r: () => this.r(),
    });

    t.registerGreedy('rip version', 'RIP version on interface', (args) => {
      const ifName = this.selectedInterface;
      if (!ifName) return '';
      const port = this.r().getPort(ifName);
      if (!port) return '';
      const version = args[0];
      if (version !== '1' && version !== '2') {
        return HUAWEI_ERRORS.WRONG(`rip version ${args.join(' ')}`);
      }
      const diffusion = (args[1] ?? '').toLowerCase();
      if (diffusion && diffusion !== 'multicast' && diffusion !== 'broadcast') {
        return HUAWEI_ERRORS.WRONG(`rip version ${args.join(' ')}`);
      }
      port.setRipSendVersion(version);
      port.setRipReceiveVersion(version);
      port.setRipV2Broadcast(diffusion === 'broadcast');
      return '';
    });
    t.registerGreedy('undo rip version', 'Restore the default RIP version', () => {
      const ifName = this.selectedInterface;
      if (!ifName) return '';
      const port = this.r().getPort(ifName);
      port?.setRipSendVersion(null);
      port?.setRipReceiveVersion(null);
      port?.setRipV2Broadcast(false);
      return '';
    });
    t.registerGreedy('rip authentication-mode', 'RIP authentication mode', (args) => {
      const ifName = this.selectedInterface;
      if (!ifName) return '';
      const port = this.r().getPort(ifName);
      if (!port) return '';
      const mode = (args[0] ?? '').toLowerCase();
      if (mode !== 'simple' && mode !== 'md5') {
        return HUAWEI_ERRORS.WRONG(`rip authentication-mode ${args.join(' ')}`);
      }
      const cipherAt = args.findIndex((a) => a.toLowerCase() === 'cipher');
      port.setRipAuthMode(mode);
      port.setRipAuthKeyChain(cipherAt >= 0 ? (args[cipherAt + 1] ?? null) : null);
      return '';
    });
    t.registerGreedy('undo rip authentication-mode', 'Remove RIP authentication', () => {
      const ifName = this.selectedInterface;
      if (!ifName) return '';
      const port = this.r().getPort(ifName);
      port?.setRipAuthMode(null);
      port?.setRipAuthKeyChain(null);
      return '';
    });
    const ripMetricRefuse = (nom: string) => (args: string[]) =>
      `Error: This simulator's RIP engine carries no per-interface metric offset, `
      + `so ${nom} would be stored without effect.\nrip ${nom} ${args.join(' ')}`;
    t.registerGreedy('rip metricin', 'Add incoming RIP metric', ripMetricRefuse('metricin'));
    t.registerGreedy('rip metricout', 'Add outgoing RIP metric', ripMetricRefuse('metricout'));
    // `rip split-horizon` ecrivait dans `_huaweiRipIfExtras`, que rien
    // ne lit : la commande etait acceptee et n'avait aucun effet. Elle
    // passe par le meme reglage que la forme Cisco, le moteur RIP etant
    // le meme des deux cotes.
    const splitHorizonIf = (on: boolean) => () => {
      const ifName = this.selectedInterface;
      if (!ifName) return '';
      (this.r() as unknown as {
        ripSetInterfaceSplitHorizon?: (i: string, v: boolean | null) => void;
      }).ripSetInterfaceSplitHorizon?.(ifName, on);
      return '';
    };
    t.register('rip split-horizon', 'Enable split horizon', splitHorizonIf(true));
    t.register('undo rip split-horizon', 'Disable split horizon', splitHorizonIf(false));
    t.register('rip poison-reverse', 'Enable poison reverse', () =>
      "Error: This simulator's RIP engine carries poisoned reverse device-wide, "
      + 'not per interface, so this command would be stored without effect.\nrip poison-reverse');
    t.registerGreedy('rip summary-address', 'RIP summary address', (args, raw) => {
      const ifName = this.selectedInterface;
      if (!ifName) return '';
      if (args.length < 2) return HUAWEI_ERRORS.INCOMPLETE(`rip summary-address ${args.join(' ')}`);
      this.r().getPort(ifName)?.addRipSummary(raw ?? `rip summary-address ${args.join(' ')}`);
      return '';
    });

    const isisAbsent = (nom: string) => (args: string[]) =>
      "Error: This simulator has no IS-IS engine, so `isis " + nom + '` would be '
      + `stored without effect.\nisis ${nom} ${args.join(' ')}`.trimEnd();
    for (const nom of ['enable', 'circuit-level', 'cost', 'circuit-type',
      'timer hello', 'timer holding-multiplier', 'authentication-mode']) {
      t.registerGreedy(`isis ${nom}`, `IS-IS ${nom} on interface`, isisAbsent(nom));
    }

    t.registerGreedy('traffic-policy', 'Apply traffic policy on interface', (args) => {
      const name = args[0]; const dir = (args[1] || 'inbound').toLowerCase();
      if (!name || !this.selectedInterface) return '';
      const d = dir === 'outbound' ? 'outbound' : 'inbound';
      this.r().getTrafficPolicyStore().apply(this.selectedInterface, name, d);
      return '';
    });
    t.registerGreedy('undo traffic-policy', 'Remove traffic policy from interface', (args) => {
      const dir = (args[0] || 'inbound').toLowerCase();
      if (!this.selectedInterface) return '';
      const d = dir === 'outbound' ? 'outbound' : 'inbound';
      this.r().getTrafficPolicyStore().removeApplication(this.selectedInterface, d);
      return '';
    });

    const ifAttr = (bucket: VrpInterfaceBucket) => (key: string) => (args: string[], raw?: string) => {
      const ifName = this.selectedInterface;
      if (!ifName) return '';
      vrpSetInterfaceAttr(this.r(), bucket, ifName, key, raw ?? args.join(' '));
      return '';
    };
    t.register('lldp enable', 'Enable LLDP on interface', () => {
      const port = this.selectedInterface;
      if (!port) return 'Error: Incomplete command.';
      this.applyToLldpAgent(a => { a.setPortTransmit(port, true); a.setPortReceive(port, true); });
      return '';
    });
    t.register('undo lldp enable', 'Disable LLDP on interface', () => {
      const port = this.selectedInterface;
      if (!port) return 'Error: Incomplete command.';
      this.applyToLldpAgent(a => { a.setPortTransmit(port, false); a.setPortReceive(port, false); });
      return '';
    });
    t.registerGreedy('lldp admin-status', 'Set LLDP admin-status on interface', (args) => {
      const port = this.selectedInterface;
      if (!port) return 'Error: Incomplete command.';
      return applyVrpLldpAdminStatus(this.lldpAgent(), port, args[0] ?? '');
    });

    const sflowIf = ifAttr('_huaweiSflowIf');
    t.registerGreedy('sflow flow-sampling', 'sFlow flow sampling', sflowIf('flowSampling'));
    t.registerGreedy('sflow counter-sampling', 'sFlow counter sampling', sflowIf('counterSampling'));

    t.registerGreedy('qos car', 'CAR on interface', (args, raw) => {
      const ifName = this.selectedInterface;
      if (!ifName) return '';
      const ligne = raw ?? `qos car ${args.join(' ')}`;
      const regle = parseVrpCarRule(args, ligne);
      if (!regle) return HUAWEI_ERRORS.WRONG(ligne);
      this.r().getCarPolicer(ifName, true)!.add(regle);
      return '';
    });
    t.registerGreedy('undo qos car', 'Remove CAR from interface', () => {
      const ifName = this.selectedInterface;
      if (ifName) this.r().getCarPolicer(ifName)?.clear();
      return '';
    });
    const qosSansMoteur = (nom: string) => (args: string[]) =>
      `Error: This simulator carries no ${nom} scheduler, so this command would be `
      + `stored without effect.\nqos ${nom} ${args.join(' ')}`.trimEnd();
    for (const nom of ['lr', 'gts', 'queue', 'wfq', 'wred', 'queue-profile',
      'pq', 'cq', 'wrr', 'priority']) {
      t.registerGreedy(`qos ${nom}`, `QoS ${nom} on interface`, qosSansMoteur(nom));
    }
    t.registerGreedy('trust', 'Trust DSCP / 802.1p', (args) =>
      'Error: This simulator carries no QoS trust boundary, so this command would be '
      + `stored without effect.\ntrust ${args.join(' ')}`.trimEnd());
  }

  // ─── DHCP Pool View ([hostname-ip-pool-name]) ────────────────────

  private buildDhcpPoolViewCommands(): void {
    buildDhcpPoolCommands(this.dhcpPoolTrie, this);
  }

  // ─── OSPF View ([hostname-ospf-1]) ────────────────────────────

  private buildOSPFViewCommands(): void {
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;
    registerDisplayCommands(this.ospfTrie, getRouter, getState);
    registerOSPFDisplayCommands(this.ospfTrie, getRouter);
    buildOSPFViewCommands(this.ospfTrie, this, (area) => { this.ospfArea = area; });
  }

  // ─── OSPFv3 View ([hostname-ospfv3-1]) ─────────────────────────

  private buildOSPFv3ViewCommands(): void {
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;
    registerDisplayCommands(this.ospfv3Trie, getRouter, getState);
    registerOSPFDisplayCommands(this.ospfv3Trie, getRouter);
    buildOSPFv3ViewCommands(this.ospfv3Trie, this);
    registerDisplayCommands(this.ospfv3AreaTrie, getRouter, getState);
    registerOSPFDisplayCommands(this.ospfv3AreaTrie, getRouter);
  }

  // ─── IPSec Sub-Views ─────────────────────────────────────────

  private buildIPSecSubViewCommands(): void {
    buildHuaweiIKEProposalCommands(this.ikeProposalTrie, this);
    buildHuaweiIKEPeerCommands(this.ikePeerTrie, this);
    buildHuaweiIPSecProposalCommands(this.ipsecProposalTrie, this);
    buildHuaweiIPSecPolicyCommands(this.ipsecPolicyTrie, this);
  }

  // ─── IKEv2 Sub-Views ─────────────────────────────────────────

  private buildIKEv2SubViewCommands(): void {
    buildHuaweiIKEv2ProposalCommands(this.ikev2ProposalTrie, this);
    buildHuaweiIKEv2PolicyCommands(this.ikev2PolicyTrie, this);
    buildHuaweiIKEv2KeyringCommands(this.ikev2KeyringTrie, this);
    buildHuaweiIKEv2KeyringPeerCommands(this.ikev2KeyringPeerTrie, this);
    buildHuaweiIKEv2ProfileCommands(this.ikev2ProfileTrie, this);
  }

  // ─── ACL Sub-Views ──────────────────────────────────────────

  private buildACLSubViewCommands(): void {
    buildHuaweiBasicACLCommands(this.aclBasicTrie, this);
    buildHuaweiAdvancedACLCommands(this.aclAdvancedTrie, this);
  }

  private handleLocalUserCommand(args: string[]): string {
    const router = this.r();
    const name = args[0];
    if (!name || args.length < 2) return 'Error: Incomplete command.';
    const store = router.getCredentialStore();
    const existing = store.get(name) ?? NetworkOsAccount.create({ name });
    const kw = args[1].toLowerCase();
    let next = existing;
    if (kw === 'password') {
      const idx = args.indexOf('cipher') >= 0 ? args.indexOf('cipher') : args.indexOf('irreversible-cipher');
      const algo: PasswordHashAlgorithm = idx >= 0
        ? (args[idx] === 'irreversible-cipher' ? 'irreversible-cipher' : 'cipher')
        : 'plain';
      const raw = args[idx >= 0 ? idx + 1 : args.length - 1] ?? existing.secret;
      // Ce que l'on RANGE est toujours ce que la configuration rendra :
      // l'empreinte pour `irreversible-cipher`, le chiffre pour
      // `cipher`. L'operateur tape le clair, un rejeu de configuration
      // repasse la valeur deja transformee — d'ou la reconnaissance de
      // forme, faute de quoi le rejeu prend le condense pour un mot de
      // passe et le compte n'ouvre plus.
      const stored = algo === 'irreversible-cipher'
        ? (looksLikeIrreversibleCipher(raw) ? raw : huaweiIrreversibleCipher(raw))
        : algo === 'cipher'
          ? (looksLikeReversibleCipher(raw) ? raw : huaweiCipher(raw))
          : raw;
      const policy = router.getHuaweiAaaService().passwordPolicy;
      // Length only applies to a cleartext entry — a cipher/irreversible-cipher
      // value is already hashed, exactly like Cisco's `secret 5|8|9` forms.
      if (algo === 'plain' && policy.minLength && raw.length < policy.minLength) {
        return `Error: The password must contain at least ${policy.minLength} characters.`;
      }
      if (existing.wouldReuseSecret(raw, policy.historyMaxRecords ?? 0)) {
        return 'Error: The password has been used before. Please choose a different one.';
      }
      next = existing.withSecretRetainingHistory(stored, algo, policy.historyMaxRecords ?? 0);
      if (policy.expireDays) {
        next = next.withPasswordExpireAt(Date.now() + policy.expireDays * 86_400_000);
      }
    } else if (kw === 'privilege' && args[2] === 'level' && args[3]) {
      next = existing.withPrivilege(Number(args[3]) || existing.privilege);
    } else if (kw === 'service-type') {
      const types = args.slice(2).filter(t => t.length > 0) as AccountServiceType[];
      next = existing.withServiceTypes(types);
    } else if (kw === 'state') {
      next = args[2] === 'active' ? existing.enable() : args[2] === 'block' ? existing.disable() : existing;
    } else if (kw === 'ftp-directory' && args[2]) {
      next = existing.withFtpDirectory(args[2]);
    } else if (kw === 'idle-timeout' && args[2]) {
      next = existing.withIdleTimeout(Number(args[2]) * 60);
    } else if (kw === 'access-limit' && args[2]) {
      next = existing.withMaxSessions(Number(args[2]));
    }
    store.upsert(next);
    return '';
  }

  // ─── BFD Sub-Views ──────────────────────────────────────────

  private buildBfdSubmodes(): void {
    const sess = () => {
      const name = this.selectedBfdSession;
      if (!name) return null;
      return this.r().getHuaweiBfdService().ensureSession(name);
    };
    const g = this.bfdGlobalTrie;
    g.register('commit', 'Commit BFD configuration', () => '');
    g.register('default-ip-address', 'Set default BFD IP address', () => '');
    g.registerGreedy('default-ip-address', 'Set default BFD IP address', () => '');

    const s = this.bfdSessionTrie;
    s.register('commit', 'Commit BFD session', () => '');
    s.registerGreedy('discriminator', 'Set discriminator', (args) => {
      const ss = sess(); if (!ss) return '';
      if (args[0]?.toLowerCase() === 'local' && args[1]) {
        ss.discriminatorLocal = parseInt(args[1], 10);
      } else if (args[0]?.toLowerCase() === 'remote' && args[1]) {
        ss.discriminatorRemote = parseInt(args[1], 10);
      }
      return '';
    });
    s.registerGreedy('min-tx-interval', 'Set min Tx interval (ms)', (args) => {
      const ss = sess(); if (!ss) return '';
      const n = parseInt(args[0] ?? '', 10);
      if (Number.isFinite(n)) ss.minTxIntervalMs = n;
      return '';
    });
    s.registerGreedy('min-rx-interval', 'Set min Rx interval (ms)', (args) => {
      const ss = sess(); if (!ss) return '';
      const n = parseInt(args[0] ?? '', 10);
      if (Number.isFinite(n)) ss.minRxIntervalMs = n;
      return '';
    });
    s.registerGreedy('detect-multiplier', 'Set detect multiplier', (args) => {
      const ss = sess(); if (!ss) return '';
      const n = parseInt(args[0] ?? '', 10);
      if (Number.isFinite(n)) ss.detectMultiplier = n;
      return '';
    });
    s.register('one-arm-echo', 'Enable one-arm echo', () => {
      const ss = sess(); if (!ss) return '';
      ss.oneArmEcho = true;
      return '';
    });
  }

  // ─── AAA Sub-Views ──────────────────────────────────────────

  private buildAaaSubmodes(aaa: () => import('../router/aaa/HuaweiAaaService').HuaweiAaaService): void {
    const parseServerEndpoint = (args: string[]): { ip: string; port?: number; secondary?: boolean } | null => {
      let i = 0;
      let secondary = false;
      if (args[i]?.toLowerCase() === 'secondary') { secondary = true; i++; }
      if (!args[i]) return null;
      const ip = args[i++];
      let port: number | undefined;
      if (args[i] && /^\d+$/.test(args[i])) { port = parseInt(args[i++], 10); }
      if (args[i]?.toLowerCase() === 'secondary') secondary = true;
      return { ip, port, secondary: secondary || undefined };
    };

    {
      const a = this.aaaTrie;
      a.registerGreedy('authentication-scheme', 'Configure authentication scheme', (args) => {
        if (!args[0]) return 'Error: Incomplete command.';
        aaa().ensureAuthenticationScheme(args[0]);
        this.selectedAaaScheme = args[0];
        this.setMode('aaa-authen');
        return '';
      });
      a.registerGreedy('authorization-scheme', 'Configure authorization scheme', (args) => {
        if (!args[0]) return 'Error: Incomplete command.';
        aaa().ensureAuthorizationScheme(args[0]);
        this.selectedAaaScheme = args[0];
        this.setMode('aaa-author');
        return '';
      });
      a.registerGreedy('accounting-scheme', 'Configure accounting scheme', (args) => {
        if (!args[0]) return 'Error: Incomplete command.';
        aaa().ensureAccountingScheme(args[0]);
        this.selectedAaaScheme = args[0];
        this.setMode('aaa-accounting');
        return '';
      });
      a.registerGreedy('domain', 'Configure AAA domain', (args) => {
        if (!args[0]) return 'Error: Incomplete command.';
        aaa().ensureDomain(args[0]);
        this.selectedAaaScheme = args[0];
        this.setMode('aaa-domain');
        return '';
      });
      a.registerGreedy('undo authentication-scheme', 'Remove authentication scheme', (args) => {
        if (args[0]) aaa().authenticationSchemes.delete(args[0]);
        return '';
      });
      a.registerGreedy('undo authorization-scheme', 'Remove authorization scheme', (args) => {
        if (args[0]) aaa().authorizationSchemes.delete(args[0]);
        return '';
      });
      a.registerGreedy('undo accounting-scheme', 'Remove accounting scheme', (args) => {
        if (args[0]) aaa().accountingSchemes.delete(args[0]);
        return '';
      });
      a.registerGreedy('undo domain', 'Remove AAA domain', (args) => {
        if (args[0]) aaa().domains.delete(args[0]);
        return '';
      });
      a.registerGreedy('local-user', 'Configure a local user', (args) => this.handleLocalUserCommand(args));
      a.registerGreedy('undo local-user', 'Remove a local user', (args) => {
        if (args[0]) this.r()._removeLocalUser(args[0]);
        return '';
      });
      a.registerGreedy('password-policy', 'Local-user password policy', (args) => {
        const policy = aaa().passwordPolicy;
        const sub = args[0]?.toLowerCase();
        if (sub === 'level' && (args[1] === 'common' || args[1] === 'high')) {
          policy.level = args[1]; return '';
        }
        if (sub === 'min-length' && args[1]) {
          const n = parseInt(args[1], 10);
          if (!isNaN(n)) policy.minLength = n;
          return '';
        }
        if (sub === 'expire' && args[1]) {
          const n = parseInt(args[1], 10);
          if (!isNaN(n)) policy.expireDays = n;
          return '';
        }
        if (sub === 'alert-before-expire' && args[1]) {
          const n = parseInt(args[1], 10);
          if (!isNaN(n)) policy.alertBeforeExpireDays = n;
          return '';
        }
        if (sub === 'history-record' && args[1] === 'max-record-number' && args[2]) {
          const n = parseInt(args[2], 10);
          if (!isNaN(n)) policy.historyMaxRecords = n;
          return '';
        }
        return '';
      });
    }

    {
      const a = this.aaaAuthenTrie;
      a.registerGreedy('authentication-mode', 'Set authentication mode list', (args) => {
        const name = this.selectedAaaScheme;
        if (!name) return '';
        const s = aaa().ensureAuthenticationScheme(name);
        s.mode = args.map(x => x.toLowerCase());
        return '';
      });
      a.register('undo authentication-mode', 'Reset authentication mode', () => {
        const name = this.selectedAaaScheme;
        if (!name) return '';
        const s = aaa().ensureAuthenticationScheme(name);
        delete s.mode;
        return '';
      });
    }

    {
      const a = this.aaaAuthorTrie;
      a.registerGreedy('authorization-mode', 'Set authorization mode list', (args) => {
        const name = this.selectedAaaScheme;
        if (!name) return '';
        const s = aaa().ensureAuthorizationScheme(name);
        s.mode = args.map(x => x.toLowerCase());
        return '';
      });
      a.register('undo authorization-mode', 'Reset authorization mode', () => {
        const name = this.selectedAaaScheme;
        if (!name) return '';
        const s = aaa().ensureAuthorizationScheme(name);
        delete s.mode;
        return '';
      });
    }

    {
      const a = this.aaaAccountingTrie;
      a.registerGreedy('accounting-mode', 'Set accounting mode', (args) => {
        const name = this.selectedAaaScheme;
        if (!name || !args[0]) return '';
        const s = aaa().ensureAccountingScheme(name);
        s.mode = args[0].toLowerCase();
        return '';
      });
      a.registerGreedy('accounting realtime', 'Set realtime accounting interval', (args) => {
        const name = this.selectedAaaScheme;
        if (!name || !args[0]) return '';
        const n = parseInt(args[0], 10);
        if (!Number.isFinite(n)) return '';
        aaa().ensureAccountingScheme(name).realtime = n;
        return '';
      });
      a.registerGreedy('accounting start-fail', 'Set start-fail policy', (args) => {
        const name = this.selectedAaaScheme;
        if (!name) return '';
        const v = args[0]?.toLowerCase();
        if (v === 'online' || v === 'offline') {
          aaa().ensureAccountingScheme(name).startFail = v;
        }
        return '';
      });
    }

    {
      const a = this.aaaDomainTrie;
      a.registerGreedy('authentication-scheme', 'Bind authentication scheme to domain', (args) => {
        const name = this.selectedAaaScheme;
        if (!name || !args[0]) return '';
        aaa().ensureDomain(name).authenticationScheme = args[0];
        return '';
      });
      a.registerGreedy('authorization-scheme', 'Bind authorization scheme to domain', (args) => {
        const name = this.selectedAaaScheme;
        if (!name || !args[0]) return '';
        aaa().ensureDomain(name).authorizationScheme = args[0];
        return '';
      });
      a.registerGreedy('accounting-scheme', 'Bind accounting scheme to domain', (args) => {
        const name = this.selectedAaaScheme;
        if (!name || !args[0]) return '';
        aaa().ensureDomain(name).accountingScheme = args[0];
        return '';
      });
      a.registerGreedy('radius-server', 'Bind RADIUS server to domain', (args) => {
        const name = this.selectedAaaScheme;
        if (!name) return '';
        if (args[0]?.toLowerCase() === 'group' && args[1]) {
          aaa().ensureDomain(name).radiusServerGroup = args[1];
        } else if (args[0]) {
          aaa().ensureDomain(name).radiusServerGroup = args[0];
        }
        return '';
      });
      a.registerGreedy('hwtacacs-server', 'Bind HWTACACS server to domain', (args) => {
        const name = this.selectedAaaScheme;
        if (!name || !args[0]) return '';
        aaa().ensureDomain(name).hwtacacsServerTemplate = args[0];
        return '';
      });
    }

    {
      const a = this.radiusTemplateTrie;
      a.registerGreedy('radius-server', 'Configure RADIUS server parameters', (args) => {
        const name = this.selectedAaaScheme;
        if (!name) return '';
        const t = aaa().ensureRadiusTemplate(name);
        const sub = args[0]?.toLowerCase();
        const rest = args.slice(1);
        if (sub === 'authentication') {
          const ep = parseServerEndpoint(rest);
          if (ep) t.authentication = ep;
        } else if (sub === 'accounting') {
          const ep = parseServerEndpoint(rest);
          if (ep) t.accounting = ep;
        } else if (sub === 'shared-key') {
          if (rest[0]?.toLowerCase() === 'cipher' || rest[0]?.toLowerCase() === 'simple') {
            t.sharedKeyHidden = rest[0].toLowerCase() as 'cipher' | 'simple';
            t.sharedKey = rest.slice(1).join(' ');
          } else {
            t.sharedKey = rest.join(' ');
          }
        } else if (sub === 'retransmit') {
          const n = parseInt(rest[0] ?? '', 10);
          if (Number.isFinite(n)) t.retransmit = n;
        } else if (sub === 'timeout') {
          const n = parseInt(rest[0] ?? '', 10);
          if (Number.isFinite(n)) t.timeout = n;
        }
        return '';
      });
    }

    {
      const a = this.hwtacacsTemplateTrie;
      a.registerGreedy('hwtacacs-server', 'Configure HWTACACS server parameters', (args) => {
        const name = this.selectedAaaScheme;
        if (!name) return '';
        const t = aaa().ensureHwtacacsTemplate(name);
        const sub = args[0]?.toLowerCase();
        const rest = args.slice(1);
        if (sub === 'authentication') {
          const ep = parseServerEndpoint(rest);
          if (ep) t.authentication = ep;
        } else if (sub === 'authorization') {
          const ep = parseServerEndpoint(rest);
          if (ep) t.authorization = ep;
        } else if (sub === 'accounting') {
          const ep = parseServerEndpoint(rest);
          if (ep) t.accounting = ep;
        } else if (sub === 'shared-key') {
          if (rest[0]?.toLowerCase() === 'cipher' || rest[0]?.toLowerCase() === 'simple') {
            t.sharedKeyHidden = rest[0].toLowerCase() as 'cipher' | 'simple';
            t.sharedKey = rest.slice(1).join(' ');
          } else {
            t.sharedKey = rest.join(' ');
          }
        }
        return '';
      });
    }
  }

  // ─── OSPF Area View ([hostname-ospf-1-area-X]) ────────────────

  private buildOSPFAreaViewCommands(): void {
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;
    registerDisplayCommands(this.ospfAreaTrie, getRouter, getState);
    registerOSPFDisplayCommands(this.ospfAreaTrie, getRouter);
    buildOSPFAreaViewCommands(this.ospfAreaTrie, this, () => this.ospfArea);

    // La grammaire et le magasin sont ceux du commutateur (lot V15) :
    // cette vue-ci acceptait tout — `vrid 999`, `priority 300`, une
    // adresse qui n'en est pas une — et rangeait meme un mot inconnu
    // dans la configuration rendue, donc rejoue a l'import.
    this.interfaceTrie.registerGreedy('vrrp', 'VRRP configuration', (args, raw) => {
      const ifName = this.selectedInterface;
      if (!ifName) return 'Error: No interface selected';
      const agent = getVrrpAgent(this.r());
      if (!agent) return 'Error: VRRP is not available on this device.';
      const a = analyserVrrp(args);
      if (a.statut === 'refus') return rendreErreurVrp(a.err, raw ?? `vrrp ${args.join(' ')}`);
      appliquerVrrp(agent, ifName, a.vrid, a.action,
        (nom) => resolveHuaweiInterfaceName(this.r(), nom) || nom);
      return '';
    });
    this.interfaceTrie.registerGreedy('undo vrrp', 'Remove a VRRP group', (args) => {
      const ifName = this.selectedInterface;
      const agent = getVrrpAgent(this.r());
      if (!ifName || !agent) return '';
      const a = analyserVrrp(args);
      if (a.statut === 'refus') return '';
      if (a.action.quoi === 'groupe') agent.removeGroup(ifName, a.vrid);
      else if (a.action.quoi === 'preempt-mode') agent.setPreempt(ifName, a.vrid, false);
      else if (a.action.quoi === 'track') {
        agent.removeTrack(ifName, a.vrid,
          resolveHuaweiInterfaceName(this.r(), a.action.cible) || a.action.cible);
      }
      return '';
    });
    // VRP a bien cette commande, ce simulateur n'a pas le mVRRP qu'elle
    // declare : aucun groupe membre ne peut s'y lier, et la facade qui
    // rangeait le numero n'etait lue par personne (lot V15). Un refus
    // qui NOMME la brique absente vaut mieux qu'une acceptation sans
    // effet, comme partout ailleurs dans ce depot.
    this.interfaceTrie.registerGreedy('admin-vrrp', 'Admin VRRP', () =>
      'Error: Administrative VRRP (mVRRP) is not implemented in this simulator.');
  }

  // ─── RIP View ([hostname-rip-1]) ────────────────────────────────

  private buildBgpViewCommands(): void {
    const t = this.bgpTrie;
    const ex = () => this.r().getHuaweiRoutingExtras();
    const bgp = () => this.bgpAsn !== null ? ex().ensureBgp(this.bgpAsn) : null;
    // Real engine driven alongside the config facade (asRunningConfigLines
    // reads the facade; peering/routes read the engine — see
    // HuaweiDisplayCommands.ts's `display bgp peer`/`display bgp
    // routing-table`, audit 02).
    const bgpEng = () => this.r().getBGPEngine();
    const converge = () => this.r().convergeDynamicRouting();
    t.registerGreedy('router-id', 'Set BGP router-id', (args) => {
      if (!args[0]) return 'Error: Incomplete command.';
      if (!estAdresseIPv4(args[0])) return 'Error: Wrong parameter.';
      const b = bgp(); if (b) b.routerId = args[0];
      bgpEng().getConfig().routerId = args[0];
      return '';
    });
    t.registerGreedy('network', 'Advertise a network', (args) => {
      const b = bgp(); if (!b || !args[0]) return '';
      const mask = args[1] ?? '255.255.255.0';
      b.networks.push({ ip: args[0], mask });
      bgpEng().getConfig().networks.push({ network: args[0], mask });
      converge();
      return '';
    });
    t.registerGreedy('aggregate', 'Aggregate routes', (args) => {
      const b = bgp(); if (!b || !args[0] || !args[1]) return '';
      b.aggregates.push({ ip: args[0], mask: args[1], flags: args.slice(2) });
      return '';
    });
    t.registerGreedy('group', 'Define a peer group', (args) => {
      const b = bgp(); if (!b || !args[0]) return '';
      const kind = (args[1] === 'internal' || args[1] === 'external') ? args[1] : undefined;
      b.groups.set(args[0], { name: args[0], kind, rawLines: [] });
      return '';
    });
    t.registerGreedy('peer', 'Configure a BGP peer', (args) => {
      if (!args[0]) return 'Error: Incomplete command.';
      if (!estAdresseIPv4(args[0])) return 'Error: Wrong parameter.';
      const asIdx = args.indexOf('as-number');
      if (asIdx >= 0
        && boundedInteger(args[asIdx + 1], 1, BGP_ATTRIBUTE_MAX) === null) {
        return 'Error: Wrong parameter.';
      }
      const b = bgp(); if (!b) return '';
      const peer = b.peers.get(args[0]) ?? { ip: args[0], rawLines: [] };
      // Real engine session config — a VRP peer is active for IPv4
      // unicast as soon as it's configured under [bgp] (no separate
      // "activate" step like Cisco's address-family mode).
      const ec = bgpEng().getConfig();
      let bn = ec.neighbors.get(args[0]);
      if (!bn) { bn = { ip: args[0], activated: true }; ec.neighbors.set(args[0], bn); }
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === 'as-number' && args[i + 1]) { peer.asNumber = parseInt(args[i + 1], 10); bn.remoteAs = peer.asNumber; i++; }
        else if (a === 'description' && args[i + 1]) {
          peer.description = args.slice(i + 1).join(' ');
          gardeLigneNonRendue(peer, args[0], args.slice(i - 1));
          i = args.length;
        }
        else if (a === 'group' && args[i + 1]) { peer.groupName = args[i + 1]; i++; }
        else if (a === 'connect-interface' && args[i + 1]) {
          peer.connectInterface = args[i + 1];
          gardeLigneNonRendue(peer, args[0], [a, args[i + 1]]);
          i++;
        }
        else if (a === 'password' && args[i + 1]) {
          peer.passwordHash = args[i + 1];
          gardeLigneNonRendue(peer, args[0], [a, args[i + 1]]);
          i++;
        }
        else gardeLigneNonRendue(peer, args[0], args.slice(i));
      }
      b.peers.set(args[0], peer);
      converge();
      return '';
    });
    t.registerGreedy('import-route', 'Import routes', (args) => {
      const b = bgp(); if (!b) return '';
      b.rawLines.push(`import-route ${args.join(' ')}`);
      return '';
    });
    t.registerGreedy('default-route', 'Default-route advertise', (args, raw) => {
      const b = bgp(); if (!b) return '';
      b.rawLines.push(raw ?? `default-route ${args.join(' ')}`);
      return '';
    });
    t.registerGreedy('graceful-restart', 'Enable graceful restart', () => {
      const b = bgp(); if (!b) return '';
      b.rawLines.push('graceful-restart');
      return '';
    });
    t.registerGreedy('timer', 'BGP timers (keepalive/hold)', (args, raw) => {
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === 'keepalive' || args[i] === 'hold')
          && boundedInteger(args[i + 1], 0, BGP_HOLD_TIME_MAX) === null) {
          return 'Error: Wrong parameter.';
        }
      }
      const b = bgp(); if (!b) return '';
      for (let i = 0; i < args.length; i++) {
        if (args[i] === 'keepalive' && args[i + 1]) b.keepaliveSec = parseInt(args[++i], 10);
        else if (args[i] === 'hold' && args[i + 1]) b.holdSec = parseInt(args[++i], 10);
      }
      b.rawLines.push(raw ?? `timer ${args.join(' ')}`);
      return '';
    });
    t.registerGreedy('maximum load-balancing', 'BGP ECMP', (args) => {
      const b = bgp(); const n = parseInt(args[0] ?? '', 10);
      if (!b || isNaN(n) || n < 1) return '';
      b.maximumPaths = n;
      // Le plafond va au ROUTEUR : c'est la seule chose que le plan de
      // données consulte. Sans cet appel, la commande qui ACTIVE la
      // répartition BGP — désactivée par défaut chez les deux
      // constructeurs — ne l'activait pas.
      this.r().setMaximumPaths('bgp', n);
      return '';
    });
    t.registerGreedy('ipv4-family', 'Enter IPv4 address family', (_args) => {
      const b = bgp(); if (b) b.ipv4Family = true; return '';
    });
    t.registerGreedy('ipv6-family', 'Enter IPv6 address family', (_args) => {
      const b = bgp(); if (b) b.ipv6Family = true; return '';
    });
    t.registerGreedy('undo ipv4-family', 'Leave IPv4 family', (_args) => '');
    t.registerGreedy('undo ipv6-family', 'Leave IPv6 family', (_args) => '');
  }

  private buildIsisViewCommands(): void {
    const t = this.isisTrie;
    const ex = () => this.r().getHuaweiRoutingExtras();
    const isis = () => this.isisProcessId !== null ? ex().ensureIsis(this.isisProcessId) : null;
    t.registerGreedy('network-entity', 'Set IS-IS NET', (args) => {
      const i = isis(); if (i && args[0]) i.netAddress = args[0];
      return '';
    });
    t.registerGreedy('net', 'Set IS-IS NET (alias)', (args) => {
      const i = isis(); if (i && args[0]) i.netAddress = args[0];
      return '';
    });
    t.registerGreedy('is-level', 'Set IS-IS level', (args) => {
      const i = isis(); if (!i || !args[0]) return '';
      const v = args[0].toLowerCase();
      if (v === 'level-1' || v === 'level-2' || v === 'level-1-2') i.isLevel = v;
      return '';
    });
    t.registerGreedy('cost-style', 'Set IS-IS cost style', (args) => {
      const i = isis(); if (!i || !args[0]) return '';
      if (args[0] === 'narrow' || args[0] === 'wide' || args[0] === 'compatible') i.costStyle = args[0];
      return '';
    });
    t.register('checkzero', 'Enable IS-IS checkzero', () => {
      const i = isis(); if (i) i.checkzero = true;
      return '';
    });
    t.register('undo checkzero', 'Disable IS-IS checkzero', () => {
      const i = isis(); if (i) i.checkzero = false;
      return '';
    });
    t.register('default-route-advertise', 'Advertise default route', () => {
      const i = isis(); if (i) i.defaultRouteAdvertise = true;
      return '';
    });
    t.register('graceful-restart', 'Enable graceful restart', () => {
      const i = isis(); if (i) i.gracefulRestart = true;
      return '';
    });
    t.registerGreedy('import-route', 'Import routes', (args) => {
      const i = isis(); if (i) i.importedRoutes.push(args.join(' '));
      return '';
    });
    t.registerGreedy('is-name', 'Set IS-IS dynamic hostname', (args) => {
      const i = isis(); if (i && args[0]) i.hostname = args[0];
      return '';
    });
    t.registerGreedy('timer lsp-refresh', 'Set LSP refresh interval', (args) => {
      const i = isis(); const n = parseInt(args[0] ?? '', 10);
      if (i && !isNaN(n)) i.lspRefreshSec = n;
      return '';
    });
    t.register('set-overload', 'Set IS-IS overload bit', () => {
      const i = isis(); if (i) i.overload = true; return '';
    });
    t.register('undo set-overload', 'Clear IS-IS overload bit', () => {
      const i = isis(); if (i) i.overload = false; return '';
    });
    t.registerGreedy('maximum load-balancing', 'IS-IS ECMP paths', (args) => {
      const i = isis(); const n = parseInt(args[0] ?? '', 10);
      if (!i || isNaN(n) || n < 1) return '';
      i.maximumPaths = n;
      this.r().setMaximumPaths('isis', n);
      return '';
    });
    t.registerGreedy('preference', 'Set IS-IS preference', (args) => {
      const i = isis(); const n = parseInt(args[0] ?? '', 10);
      if (i && !isNaN(n)) i.preference = n;
      return '';
    });
  }

  private buildRIPViewCommands(): void {
    const getRouter = () => this.r();
    const getState = () => this as HuaweiDisplayState;
    const t = this.ripTrie;

    registerDisplayCommands(t, getRouter, getState);

    t.registerGreedy('network', 'Advertise network in RIP', (args) => {
      if (args.length < 1) return 'Error: Incomplete command.';
      return cmdRip(getRouter(), ['network', ...args]);
    });
    // `network <adresse>` sous RIP ne prend que l'adresse classful : un
    // mot de plus etait lu comme un MASQUE, d'ou un `Invalid subnet
    // mask:` maison la ou VRP compte les parametres.
    t.allowArgs('network', 1);

    // La version etait ignoree : la commande etait acceptee, le champ
    // que le moteur lit restait a 2, et la configuration rendait 2 quoi
    // qu'on ait tape. Le champ existe et sert deja cote Cisco.
    t.registerGreedy('version', 'Set RIP version', (args) => {
      const v = Number(args[0]);
      if (v !== 1 && v !== 2) return HUAWEI_ERRORS.UNRECOGNIZED(`version ${args.join(' ')}`.trim(), 'version '.length);
      getRouter()._setRipVersion(v);
      return '';
    });
    t.allowArgs('version', 1);

    t.registerGreedy('preference', 'Set RIP preference value', (_args) => {
      return '';
    });

    t.registerGreedy('undo network', 'Remove advertised network', (_args) => {
      return '';
    });

    const ripExtras = () => huaweiRipExtras(this.r());
    t.register('summary', 'Enable RIP auto-summary', () => { ripExtras().autoSummary = true; return ''; });
    t.register('undo summary', 'Disable RIP auto-summary', () => { ripExtras().autoSummary = false; return ''; });
    t.registerGreedy('timers rip', 'Set RIP timers (update/timeout/garbage)', (args) => {
      const e = ripExtras();
      e.updateSec = parseInt(args[0] ?? '', 10);
      e.timeoutSec = parseInt(args[1] ?? '', 10);
      e.gcSec = parseInt(args[2] ?? '', 10);
      return '';
    });
    t.register('default-route originate', 'Originate default route via RIP', () => {
      ripExtras().defaultOriginate = true;
      getRouter().ripSetDefaultInformationOriginate(true);
      return '';
    });
    t.register('undo default-route originate', 'Stop default route origination', () => {
      ripExtras().defaultOriginate = false;
      getRouter().ripSetDefaultInformationOriginate(false);
      return '';
    });
    t.registerGreedy('import-route', 'Redistribute routes into RIP', (args) => {
      const e = ripExtras();
      (e.importRoute ??= []).push(args.join(' '));
      const source = ['static', 'connected', 'ospf', 'bgp']
        .find((s) => s === (args[0] ?? '').toLowerCase());
      if (source === 'connected' || source === 'static'
        || source === 'ospf' || source === 'bgp') {
        let metric: number | undefined;
        const cIdx = args.findIndex((tk) => tk.toLowerCase() === 'cost');
        if (cIdx >= 0 && args[cIdx + 1] !== undefined) {
          const m = parseInt(args[cIdx + 1], 10);
          if (!Number.isNaN(m)) metric = m;
        }
        let routePolicy: string | undefined;
        const rpIdx = args.findIndex((tk) => tk.toLowerCase() === 'route-policy');
        if (rpIdx >= 0 && args[rpIdx + 1] !== undefined) routePolicy = args[rpIdx + 1];
        getRouter().ripSetRedistribution(source, metric, routePolicy);
      }
      return '';
    });
    t.registerGreedy('undo import-route', 'Stop redistributing into RIP', (args) => {
      const e = ripExtras();
      const source = (args[0] ?? '').toLowerCase();
      if (Array.isArray(e.importRoute)) {
        e.importRoute = e.importRoute.filter(
          (l: string) => !l.toLowerCase().startsWith(source));
      }
      if (source === 'connected' || source === 'static'
        || source === 'ospf' || source === 'bgp') {
        getRouter().ripRemoveRedistribution(source);
      }
      return '';
    });
    t.registerGreedy('maximum load-balancing', 'Set ECMP for RIP', (args) => {
      const n = parseInt(args[0] ?? '', 10);
      if (isNaN(n) || n < 1) return '';
      ripExtras().maximumPaths = n;
      this.r().setMaximumPaths('rip', n);
      return '';
    });
    // VRP accepts "GigabitEthernet0/0/0" and "GigabitEthernet 0/0/0";
    // the engine keys on the exact port name, so resolve before plumbing.
    const resolveSilentIface = (args: string[]): string => {
      const raw = args.join('');
      for (const name of getRouter()._getPortsInternal().keys()) {
        if (name.toLowerCase() === raw.toLowerCase()) return name;
      }
      return args.join(' ');
    };
    t.registerGreedy('silent-interface', 'Suppress RIP on an interface', (args) => {
      const name = resolveSilentIface(args);
      const e = ripExtras();
      (e.silentInterfaces ??= new Set<string>()).add(name);
      getRouter().ripSetPassiveInterface(name);
      return '';
    });
    t.registerGreedy('undo silent-interface', 'Resume RIP on an interface', (args) => {
      const name = resolveSilentIface(args);
      const set = ripExtras().silentInterfaces as Set<string> | undefined;
      set?.delete(name);
      getRouter().ripRemovePassiveInterface(name);
      return '';
    });
    t.register('checkzero', 'Enable RIP checkzero validation', () => { ripExtras().checkZero = true; return ''; });
    t.register('undo checkzero', 'Disable RIP checkzero validation', () => { ripExtras().checkZero = false; return ''; });
    t.register('verify-source', 'Enable RIP source-validation', () => { ripExtras().verifySource = true; return ''; });
  }

  // ─── Tracert command ──────────────────────────────────────────────

  private _handleTracert(args: string[]): string {
    if (args.length === 0) {
      return 'Error: Please specify a destination IP address.';
    }

    let target = '';
    let maxHops = 30;
    let timeoutMs = 2000;
    let probesPerHop = 3;

    let ipv6 = false;
    if (args[0]?.toLowerCase() === 'ipv6') {
      ipv6 = true;
      args = args.slice(1);
    }

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-h' && args[i + 1]) { maxHops = parseInt(args[i + 1], 10) || 30; i++; }
      else if (a === '-w' && args[i + 1]) { timeoutMs = (parseInt(args[i + 1], 10) || 2) * 1000; i++; }
      else if (a === '-q' && args[i + 1]) { probesPerHop = parseInt(args[i + 1], 10) || 3; i++; }
      else if (!a.startsWith('-')) { target = args[i]; }
    }

    if (!target) return 'Error: Please specify a destination IP address.';

    if (ipv6 || looksLikeIPv6(target)) {
      if (!looksLikeIPv6(target)) return `Error: Unknown host ${target}.`;
      this._pendingAsync = this.r()
        .executeTraceroute6(new IPv6Address(target), maxHops, timeoutMs, probesPerHop)
        .then(hops => this._formatHuaweiTracert(target, maxHops, hops));
      return '';
    }

    const ipMatch = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) return `Error: Unknown host ${target}.`;
    const octets = [+ipMatch[1], +ipMatch[2], +ipMatch[3], +ipMatch[4]];
    if (octets.some(o => o > 255)) return `Error: Invalid IP address ${target}.`;

    const targetIP = new IPAddress(target);
    const router = this.r();

    this._pendingAsync = router.executeTraceroute(targetIP, maxHops, timeoutMs, probesPerHop).then(hops =>
      this._formatHuaweiTracert(target, maxHops, hops),
    );

    return '';
  }

  private _formatHuaweiTracert(
    target: string,
    maxHops: number,
    hops: Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean; unreachable?: boolean; probes?: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean }> }>,
  ): string {
    const lines: string[] = [
      `tracert to ${target}(${target}), max hops: ${maxHops}, packet length: 40, press CTRL_C to break`,
    ];

    if (hops.length === 0) {
      lines.push(' Network is unreachable');
      return lines.join('\n');
    }

    for (const hop of hops) {
      if (hop.timeout && (!hop.probes || hop.probes.every(p => !p.responded))) {
        lines.push(` ${hop.hop}  *  *  *`);
        continue;
      }

      let annotation = '';
      if (hop.unreachable) annotation = ' !N';

      if (hop.probes && hop.probes.length > 0) {
        const parts: string[] = [];
        for (const probe of hop.probes) {
          if (!probe.responded) {
            parts.push('*');
          } else {
            parts.push(`${Math.round(probe.rttMs ?? 0)} ms`);
          }
        }
        lines.push(` ${hop.hop} ${hop.ip}  ${parts.join(' ')}${annotation}`);
      } else {
        const ms = Math.round(hop.rttMs ?? 0);
        lines.push(` ${hop.hop} ${hop.ip}  ${ms} ms${annotation}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Ping command ─────────────────────────────────────────────────

  private _handlePing(args: string[]): string {
    if (args.length === 0) return 'Error: Please specify a destination IP address.';

    let target = '';
    let count = 5;
    let timeoutMs = 2000;
    let sourceIP: string | null = null;
    let ipv6 = false;

    if (args[0].toLowerCase() === 'ipv6') {
      ipv6 = true;
      args = args.slice(1);
      if (args.length === 0) return 'Error: Please specify a destination IP address.';
    }

    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-c' && args[i + 1]) { count = parseInt(args[i + 1], 10) || 5; i++; }
      else if (a === '-t' && args[i + 1]) { timeoutMs = (parseInt(args[i + 1], 10) || 2) * 1000; i++; }
      else if (a === '-a' && args[i + 1]) { sourceIP = args[i + 1]; i++; }
      else if (!a.startsWith('-')) { target = args[i]; }
    }

    if (!target) return 'Error: Please specify a destination IP address.';

    if (ipv6 || looksLikeIPv6(target)) {
      if (!looksLikeIPv6(target)) return `Error: Unknown host ${target}.`;
      return this._handlePing6(target, count, timeoutMs, sourceIP);
    }

    const ipMatch = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipMatch) return `Error: Unknown host ${target}.`;
    const octets = [+ipMatch[1], +ipMatch[2], +ipMatch[3], +ipMatch[4]];
    if (octets.some(o => o > 255)) return `Error: Invalid IP address ${target}.`;

    const targetIP = new IPAddress(target);
    const router = this.r();

    this._pendingAsync = router.executePingSequence(targetIP, count, timeoutMs, sourceIP ?? undefined).then(results => {
      const successes = results.filter(r => r.success).length;
      const lines = [
        `PING ${target}: 56  data bytes, press CTRL_C to break`,
        ...results.map(r =>
          r.success
            ? `Reply from ${r.fromIP}: bytes=56 Sequence=${r.seq} ttl=${r.ttl} time=${r.rttMs.toFixed(0)} ms`
            : `Request timeout`,
        ),
        '',
        `--- ${target} ping statistics ---`,
        `${count} packet(s) transmitted, ${successes} packet(s) received, ${Math.round(((count - successes) / count) * 100)}% packet loss`,
      ];
      return lines.join('\n');
    });

    return '';
  }

  /**
   * VRP renders an IPv6 probe differently from an IPv4 one, and the
   * difference carries information: a reply reports its `hop limit`,
   * which is the field IPv6 actually has, and the statistics block
   * counts transmitted and received on separate lines.
   */
  private _handlePing6(
    target: string, count: number, timeoutMs: number, sourceIP: string | null,
  ): string {
    const router = this.r();
    this._pendingAsync = router
      .executePing6Sequence(new IPv6Address(target), count, timeoutMs, sourceIP ?? undefined)
      .then((results) => {
        const ok = results.filter(r => r.success);
        const rtts = ok.map(r => Math.round(r.rttMs));
        const loss = count === 0 ? 0 : ((count - ok.length) / count) * 100;
        const lines = [
          `  PING ${target} : 56  data bytes, press CTRL_C to break`,
        ];
        for (const r of results) {
          if (!r.success) { lines.push('    Request time out'); continue; }
          lines.push(`    Reply from ${r.fromIP}`);
          lines.push(`    bytes=56 Sequence=${r.seq} hop limit=${r.ttl}  time = ${Math.round(r.rttMs)} ms`);
        }
        lines.push('');
        lines.push(`  --- ${target} ping statistics ---`);
        lines.push(`    ${count} packet(s) transmitted`);
        lines.push(`    ${ok.length} packet(s) received`);
        lines.push(`    ${loss.toFixed(2)}% packet loss`);
        if (rtts.length > 0) {
          const avg = Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length);
          lines.push(`    round-trip min/avg/max = ${Math.min(...rtts)}/${avg}/${Math.max(...rtts)} ms`);
        }
        return lines.join('\n');
      });
    return '';
  }
}
