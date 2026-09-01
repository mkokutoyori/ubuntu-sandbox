/**
 * CiscoIOSShell - Cisco IOS CLI emulation for Router Management Plane
 *
 * Extends CiscoShellBase<Router> to inherit shared execute loop, FSM,
 * help/tab-complete, and common commands (enable, configure, ARP, hostname).
 *
 * Router-specific additions:
 *   - ping (async ICMP echo)
 *   - traceroute (ICMP-based path trace)
 *   - show ip route, show running-config, show version, etc.
 *   - DHCP, RIP, OSPF, ACL, IPSec sub-modes and commands
 *
 * Modes (FSM States):
 *   user, privileged, config, config-if, config-dhcp, config-router,
 *   config-router-ospf, config-router-ospfv3, config-std-nacl,
 *   config-ext-nacl, config-ipv6-nacl, config-isakmp, config-tfset,
 *   config-crypto-map, config-ipsec-profile, config-ikev2-*
 */

import type { ExecScope } from './cisco/CiscoExecScope';
import type { CommandSpec } from '@/cli/CommandTable';
import type { SocleLegend } from './CiscoShellBase';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { dhcpClientFamily, type DhcpClientLeaseView } from '@/cli/commands/dhcp/dhcpClientFamily';
import type { DebugPair } from '@/cli/commands/debug/debugFamily';
import { ALL_TUNNEL } from '@/cli/commands/tunnel/tunnelFamily';
import {
  OBJECT_GROUP_FAMILY,
  type ObjectGroupStore,
} from '@/cli/commands/objectGroup/objectGroupFamily';
import { CLEAR_CRYPTO_FAMILY } from '@/cli/commands/clear/clearCrypto';
import { SHOW_CRYPTO_FAMILY } from '@/cli/commands/show/showCrypto';
import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';
import { CiscoShellBase } from './CiscoShellBase';
import { CommandTrie, setInvalidInputPromptWidth, formatInvalidInput, formatInvalidInputAt } from './CommandTrie';
import { IPAddress, IPv6Address, SubnetMask } from '../../core/types';
import { isValidIPv4 } from '../../core/ip';
import { parsePingArgs, formatCiscoPing, looksLikeIPv6 } from './cisco/ciscoPing';
import { CliInvalidInput } from './cli/CliDiagnostic';
import { getSecurityConfig } from './cisco/CiscoSecurityCommands';
import type { PromptMap } from './PromptBuilder';
import { CISCO_IOS_PROMPTS } from './PromptBuilder';
import { CLIStateMachine, CISCO_IOS_MODES } from './CLIStateMachine';
import {
  resolveInterfaceName, cmdIpRoute, cmdNoIpRoute,
  refusSousInterfaceSansEncapsulation,
} from './cisco/CiscoConfigCommands';
import type { IpAddressHost } from './cisco/ipAddressInterfaceSpecs';
import {
  registerHsrpShowCommands, hsrpGroupRange,
} from './cisco/CiscoHsrpCommands';
import type { SessionParamRanges } from './EquipmentParamResolver';
import {
  registerVrrpGlbpShowCommands,
} from './cisco/CiscoVrrpGlbpCommands';
import {
  buildBfdInterfaceCommands, registerBfdShowCommands, bfdInterfaceSpecs,
} from './cisco/CiscoBfdCommands';
import {
  buildIgmpInterfaceCommands, registerIgmpShowCommands, igmpShowSpecs,
  igmpInterfaceSpecs,
} from './cisco/CiscoIgmpCommands';
import {
  buildPimInterfaceCommands, buildPimGlobalConfigCommands, registerPimShowCommands,
  pimInterfaceSpecs, pimGlobalSpecs,
  pimShowSpecs,
} from './cisco/CiscoPimCommands';
import {
  buildVxlanInterfaceCommands, registerVxlanShowCommands,
} from './cisco/CiscoVxlanCommands';
import { FhrpRepository } from '../inspection/config/FhrpRepository';
import {
  buildTrackConfigCommands, registerTrackShowCommands, trackSubmodeSpecs,
} from './cisco/CiscoTrackCommands';
import { KeyChainRepository } from '../inspection/config/KeyChainRepository';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import {
  keyChainSubmodeSpecs, keyChainKeySubmodeSpecs,
} from './cisco/CiscoKeyChainCommands';
import {
  buildIpSlaConfigCommands, registerIpSlaTypeSubModes,
  ipSlaSubmodeSpecs, ipSlaTypeSubmodeSpecs, ipSlaHttpRawSpecs, ipSlaGlobalSpecs,
} from './cisco/CiscoIpSlaCommands';
import {
  ipSlaShowSpecs, ipSlaClearSpecs, ipSlaDebugPairs,
} from './cisco/CiscoIpSlaShowCommands';
import { describeCiscoArguments } from './cisco/ciscoArgumentHelp';
import { renderStartupConfig } from './cisco/ciscoConfigSerializer';
import { PolicyRepository } from '../inspection/config/PolicyRepository';
import {
  buildPolicyConfig, registerPolicyShow, policyShowSpecs, routeMapSubmodeSpecs,
} from './cisco/CiscoPolicyCommands';

// Extracted command modules
import * as Show from './cisco/CiscoShowCommands';
import { showProcessesCpu } from './cisco/CiscoCommonShow';
import { showNATTranslations, showNATStatistics } from './cisco/CiscoNATCommands';
import { showIpOspfNeighbor, routerIpRouteView } from './cisco/CiscoOspfCommands';
import {
  type CiscoShellMode, type CiscoShellContext,
  buildConfigCommands, buildConfigIfCommands, configIfSpecs, dhcpGlobalSpecs,
  registerInterfaceEntry, INTERFACE_TYPES, typesInterfaceEnMotsCles,
} from './cisco/CiscoConfigCommands';
import {
  buildConfigDhcpCommands, buildConfigDhcpPoolClassCommands, dhcpPoolSpecs,
  dhcpPoolClassSpecs, dhcpClassSpecs, ipv6DhcpPoolSpecs,
  buildConfigDhcpClassCommands,
  buildConfigIpv6DhcpCommands,
  registerDhcpShowCommands, dhcpIpv6ShowSpecs,
  registerDhcpPrivilegedCommands,
} from './cisco/CiscoDhcpCommands';
import {
  registerKeyChainGlobalCommands,
  buildKeyChainSubmode,
  buildKeyChainKeySubmode,
  registerKeyChainShowCommands,
} from './cisco/CiscoKeyChainCommands';
import {
  buildRoutingProtoConfig, registerRoutingProtoShow, routerKeywordBelongsTo,
  routingProtoShowSpecs, routerSubmodeSpecs,
} from './cisco/CiscoRoutingProtoCommands';
import { RoutingConfigRepository } from '../inspection/config/RoutingConfigRepository';
import {
  type CiscoACLShellContext,
  buildACLConfigCommands,
  buildNamedStdACLCommands, buildNamedExtACLCommands,
  buildIPv6ACLGlobalCommands, buildIPv6ACLModeCommands,
  registerACLShowCommands, registerACLClearCommands, aclShowSpecs,
} from './cisco/CiscoAclCommands';
import {
  registerOSPFConfigCommands, buildConfigRouterOSPFCommands,
  buildConfigRouterOSPFv3Commands,
  registerOSPFInterfaceCommands, registerOSPFShowCommands, ospfShowSpecs, ospfClearSpecs,
  ospfInterfaceSpecs,
  ospfIpv6ShowSpecs, routerOspfSpecs, routerOspfv3Specs,
  setOspfv3InterfaceParams, enableOspfv3OnInterface, disableOspfv3OnInterface,
  setOspfv3InterfaceAuthentication,
} from './cisco/CiscoOspfCommands';
import {
  buildIPSecGlobalCommands, buildISAKMPPolicyCommands, buildISAKMPProfileCommands, buildISAKMPKeyringCommands,
  buildTransformSetCommands, buildCryptoMapEntryCommands,
  buildIPSecProfileCommands, buildIPSecIfCommands, ipsecInterfaceSpecs,
  ipsecGlobalSpecs,
  buildIPSecPrivilegedCommands,
  isakmpPolicySpecs, isakmpProfileSpecs, isakmpKeyringSpecs,
  transformSetSpecs, cryptoMapEntrySpecs, ipsecProfileSpecs,
} from './cisco/CiscoIPSecIKEv1Commands';
import {
  buildIKEv2GlobalCommands, buildIKEv2ProposalCommands, ikev2GlobalSpecs,
  buildIKEv2PolicyCommands, buildIKEv2KeyringCommands,
  buildIKEv2KeyringPeerCommands, buildIKEv2ProfileCommands,
  ikev2ProposalSpecs, ikev2PolicySpecs, ikev2KeyringSpecs,
  ikev2KeyringPeerSpecs, ikev2ProfileSpecs,
} from './cisco/CiscoIPSecIKEv2Commands';
import {
  buildGdoiGlobalCommands, buildGdoiGroupCommands, gdoiGroupSpecs, gdoiGlobalSpecs,
} from './cisco/CiscoGdoiCommands';
import { registerIPSecShowCommands, cryptoShowSpecs } from './cisco/CiscoIPSecShowCommands';
import {
  buildSecurityConfigCommands, buildSecurityInterfaceCommands,
  buildSecuritySubmodeCommands, buildSecurityShowCommands, securityInterfaceSpecs,
  securityShowSpecs,
  classMapSubmodeSpecs, policyMapSubmodeSpecs, policyClassSubmodeSpecs,
  controlPlaneSubmodeSpecs, zoneSubmodeSpecs, zonePairSubmodeSpecs,
  timeRangeSubmodeSpecs, trustpointSubmodeSpecs,
  type CiscoSecurityShellContext,
} from './cisco/CiscoSecurityCommands';
import {
  buildEemNetflowArchiveConfigCommands, buildEemAppletSubmode,
  buildFlowExporterSubmode, buildFlowRecordSubmode, buildFlowMonitorSubmode,
  buildArchiveSubmode, buildArchiveLogSubmode,
  eemAppletSpecs, flowExporterSpecs, flowRecordSpecs, flowMonitorSpecs,
  buildEemNetflowArchiveInterfaceCommands, buildEemNetflowArchiveShowCommands,
  netflowEemShowSpecs,
  netflowInterfaceSpecs,
} from './cisco/CiscoEemNetflowArchiveCommands';
import {
  buildNATConfigCommands, buildNATInterfaceCommands, natInterfaceSpecs,
  natConfigSpecs,
  registerNATPrivilegedCommands, registerNATShowCommands, natShowSpecs, natExecSpecs,
} from './cisco/CiscoNATCommands';
import { iosShortInterfaceName } from '@/network/devices/inspection/InterfaceStatusView';
import {
  SOCLE, ROUTEUR_SEUL, appliquerContinuations, continuationsPourLeSocle,
} from './cisco/ciscoContinuations';
import type { ContinuationTable } from './cisco/ciscoContinuations';

const HORS_PLATEFORME_ISR: ReadonlySet<string> = new Set(['vxlan', 'nve', 'mls']);

import { routerOnlyDebugPairs, type RouterDebugHost } from '@/cli/commands/debug/routerDebugPairs';
import { getGlobalConfig } from '../router/config/CiscoGlobalConfig';


const VRF_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  rd: { name: 'distingueur', type: 'WORD', literal: 'ASN:nn or IP-address:nn',
    description: 'Route distinguisher of this VRF' },
  'route-target': { name: 'cible', type: 'REST',
    description: 'import, export or both, then ASN:nn' },
  description: { name: 'texte', type: 'REST', literal: 'LINE',
    description: 'Description of this VRF' },
};

const PORTES_DE_ROUTAGE: ReadonlySet<string> = new Set([
  'router ospf', 'router rip', 'router eigrp', 'router bgp',
]);

const PORTES_DE_ROUTAGE_PLACES: Readonly<Record<string, ArgumentSpec>> = {
  'router ospf': {
    name: 'process-id', type: 'INT', range: [1, 65535], description: 'Process ID',
  },
  'router eigrp': {
    name: 'as-number', type: 'INT', range: [1, 65535],
    description: 'Autonomous system number',
  },
  'router bgp': {
    name: 'as-number', type: 'INT', range: [1, 4294967295],
    description: 'Autonomous system number',
  },
};

const ROUTER_SHOW_VIEWS: ReadonlySet<string> = new Set([
  'show tech-support', 'show bfd summary', 'show table-map',
  'show ip nbar protocol-discovery', 'show queueing interface',
  'show traffic-shape', 'show ip policy', 'show ip static route',
  'show ip interface brief', 'show ip rip database', 'show counters',
  'show ip rip', 'show vlans',
]);

const ROUTER_SHOW_ARGUMENTS: Readonly<Record<string, string>> = {
  'show interfaces': 'Interface name',
  'show ip interface': 'Interface name',
  'show queueing interface': 'Interface name',
  'show traffic-shape': 'Interface name',
  'show ip rip database': 'Network prefix',
};

export class CiscoIOSShell extends CiscoShellBase<Router> implements IRouterShell, CiscoShellContext, CiscoACLShellContext {
  versionText(): string {
    return Show.showVersion(this.d(), this.getChassisProfile(),
      this.fs().renderConfigRegisterLine());
  }

  runningConfigText(): string {
    return this.filtrerConfigurationParNiveau(Show.showRunningConfig(this.d()));
  }

  runningConfigInterfaceText(argument: string): string {
    if (argument.trim().length === 0) return '% Incomplete command.';
    const ifName = resolveInterfaceName(this.d(), argument);
    if (!ifName) return '% Invalid interface';
    return Show.showRunningConfigInterface(this.d(), ifName);
  }

  protected override debugPairs(): DebugPair[] {
    return [
      ...super.debugPairs(),
      ...ipSlaDebugPairs(this),
      ...routerOnlyDebugPairs(() => this.r() as unknown as RouterDebugHost),
    ];
  }

  private multicastShowContext(): {
    r: () => Router;
    resolveInterfaceName: (input: string) => string | null;
  } {
    return {
      r: () => this.d(),
      resolveInterfaceName: (input: string) => this.resolveInterfaceName(input),
    };
  }

  private ipv6ExecSpecs(): CommandSpec[] {
    const exec = ['user', 'privileged'];
    const routeur = () => this.d();
    const nomInterface = (brut: string): string | null =>
      this.resolveInterfaceName(brut);

    return [
      {
        id: 'show-ipv6-interface',
        path: ['show', 'ipv6', 'interface', {
          name: 'cible', type: 'WORD', optional: true,
          description: 'Interface name, or brief',
          alternatives: [
            { keyword: 'WORD', description: 'Interface name' },
            { keyword: 'brief', description: 'Brief summary' },
          ],
        }],
        description: 'Display IPv6 interface state',
        modes: exec, minPrivilege: 1,
        run: (_session, args) => {
          const cible = String(args.cible ?? '').trim();
          if (cible === '' || cible.toLowerCase() === 'brief') {
            return Show.showIpv6InterfaceBrief(routeur());
          }
          const nom = nomInterface(cible);
          if (!nom) throw new CliInvalidInput({ token: cible });
          return Show.showIpv6Interface(routeur(), nom);
        },
      },
      {
        id: 'show-ipv6-neighbors',
        path: ['show', 'ipv6', 'neighbors', {
          name: 'interface', type: 'WORD', optional: true,
          description: 'Interface name',
        }],
        description: 'Display IPv6 neighbour cache',
        modes: exec, minPrivilege: 1,
        run: (_session, args) => {
          const cible = String(args.interface ?? '').trim();
          if (cible === '') return Show.showIpv6Neighbors(routeur());
          const nom = nomInterface(cible);
          if (!nom) throw new CliInvalidInput({ token: cible });
          return Show.showIpv6Neighbors(routeur(), nom);
        },
      },
      {
        id: 'show-ipv6-traffic',
        path: ['show', 'ipv6', 'traffic'],
        description: 'Display IPv6 traffic statistics',
        modes: exec, minPrivilege: 1,
        run: () => Show.showIpv6Traffic(routeur()),
      },
      {
        id: 'show-ipv6-static',
        path: ['show', 'ipv6', 'static'],
        description: 'Display IPv6 static routes',
        modes: exec, minPrivilege: 1,
        run: () => Show.showIpv6Static(routeur()),
      },
    ];
  }

  protected override identitySubmodeContext(): CiscoSecurityShellContext {
    return this as unknown as CiscoSecurityShellContext;
  }


  private registerVrfSubmodeOn(trie: CommandTrie): void {
    trie.registerGreedy('rd', 'Route distinguisher', (args) => {
      const rd = args.join(' ').trim();
      const m = /^(\d+):(\d+)$/.exec(rd);
      if (!m) return "% Invalid input detected at '^' marker.";
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a > 4294967295 || b > 4294967295) {
        return "% Invalid input detected at '^' marker.";
      }
      const r = this.d() as unknown as { _vrfs?: Map<string, { name: string; rd?: string }> };
      if (this.selectedVRF != null) {
        const v = r._vrfs?.get(this.selectedVRF);
        if (v) v.rd = rd;
      }
      return '';
    });
    trie.registerGreedy('route-target', 'Route target', () => '');
    trie.registerGreedy('description', 'Description', () => '');
  }

  private vrfSubmodeSpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerVrfSubmodeOn(collector as unknown as CommandTrie),
      {
        modes: ['config-vrf'], minPrivilege: 15,
        argumentFor: (path) => VRF_ARGUMENTS[path],
      },
    );
  }

  protected override socleSpecs(): readonly CommandSpec[] {
    return [
      ...super.socleSpecs(),
      ...dhcpClientFamily(),
      ...this.ipv6ExecSpecs(),
      ...dhcpPoolSpecs(this),
      ...routerOspfSpecs(this),
      ...routerOspfv3Specs(this),
      ...isakmpPolicySpecs(this),
      ...isakmpProfileSpecs(this),
      ...isakmpKeyringSpecs(this),
      ...transformSetSpecs(this),
      ...cryptoMapEntrySpecs(this),
      ...ipsecProfileSpecs(this),
      ...ikev2ProposalSpecs(this),
      ...ikev2PolicySpecs(this),
      ...ikev2KeyringSpecs(this),
      ...ikev2KeyringPeerSpecs(this),
      ...ikev2ProfileSpecs(this),
      ...gdoiGroupSpecs(this),
      ...eemAppletSpecs(this),
      ...flowExporterSpecs(this),
      ...flowRecordSpecs(this),
      ...flowMonitorSpecs(this),
      ...classMapSubmodeSpecs(this),
      ...policyMapSubmodeSpecs(this),
      ...policyClassSubmodeSpecs(this),
      ...controlPlaneSubmodeSpecs(this),
      ...zoneSubmodeSpecs(this),
      ...zonePairSubmodeSpecs(this),
      ...timeRangeSubmodeSpecs(this),
      ...trustpointSubmodeSpecs(this),
      ...ipSlaSubmodeSpecs(this),
      ...ipSlaTypeSubmodeSpecs(this),
      ...ipSlaHttpRawSpecs(this),
      ...this.vrfSubmodeSpecs(),
      ...trackSubmodeSpecs(this),
      ...keyChainSubmodeSpecs(this),
      ...keyChainKeySubmodeSpecs(this),
      ...routeMapSubmodeSpecs(this, this.policy),
      ...routerSubmodeSpecs(this, this.routingCfg),
      ...bfdInterfaceSpecs({
        selectedPorts: () => this.selectedPortsForConfigIf(),
        r: () => this.d(),
      }),
      ...igmpInterfaceSpecs({
        selectedPorts: () => this.selectedPortsForConfigIf(),
        r: () => this.d(),
      }),
      ...pimInterfaceSpecs({
        selectedPorts: () => this.selectedPortsForConfigIf(),
        r: () => this.d(),
      }),
      ...natInterfaceSpecs(this),
      ...ipsecInterfaceSpecs(this),
      ...securityInterfaceSpecs(this),
      ...netflowInterfaceSpecs(this),
      ...ospfInterfaceSpecs(this),
      ...configIfSpecs(this),
      ...natConfigSpecs(this),
      ...natExecSpecs(() => this.d()),
      ...netflowEemShowSpecs(() => this.d()),
      ...securityShowSpecs(() => this.d()),
      ...pimGlobalSpecs({ r: () => this.d() }),
      ...ipsecGlobalSpecs(this),
      ...ikev2GlobalSpecs(this),
      ...gdoiGlobalSpecs(this),
      ...dhcpGlobalSpecs(this),
      ...ipSlaGlobalSpecs(this),
      ...dhcpPoolClassSpecs(this),
      ...dhcpClassSpecs(this),
      ...ipv6DhcpPoolSpecs(this),
      ...ospfIpv6ShowSpecs(() => this.d()),
      ...dhcpIpv6ShowSpecs(() => this.d()),
      ...pimShowSpecs(this.multicastShowContext()),
      ...aclShowSpecs(() => this.d()),
      ...policyShowSpecs(this.policy),
      ...igmpShowSpecs(this.multicastShowContext()),
      ...ipSlaShowSpecs(this),
      ...ospfShowSpecs(() => this.d()),
      ...natShowSpecs(() => this.d()),
      ...cryptoShowSpecs(() => this.d()),
      ...routingProtoShowSpecs(this, this.routingCfg),
      ...ospfClearSpecs(() => this.d()),
      ...ipSlaClearSpecs(this),
      ...ALL_TUNNEL, ...CLEAR_CRYPTO_FAMILY, ...SHOW_CRYPTO_FAMILY,
      ...OBJECT_GROUP_FAMILY,
      ...this.routerShowSpecs(),
      ...this.routingProtocolSpecs(),
      ...this.interfaceEntrySpecs(),
      ...this.ipv6NdSpecs(), ...this.ipv6OspfSpecs(), ...this.ipv6ReglagesSpecs(),
      ...this.clearIpv6Specs(),
      ...this.aclNommeeSpecs(),
      ...this.pkiSpecs(),
    ];
  }

  /**
   * `crypto pki {trustpoint|authenticate|enroll|import} <nom>`.
   *
   * Les quatre prennent le NOM d'un point de confiance, que la place
   * libre de l'adaptateur laissait deviner ; `import` en prend un de
   * plus, le format du certificat.
   */
  private pkiSpecs(): CommandSpec[] {
    const point: ArgumentSpec = {
      name: 'nom', type: 'WORD', description: 'Trustpoint name',
    };
    const places: Readonly<Record<string, readonly ArgumentSpec[]>> = {
      'crypto pki trustpoint': [point],
      'crypto pki authenticate': [point],
      'crypto pki enroll': [point],
      'crypto pki import': [point, {
        name: 'forme', type: 'REST', literal: 'LINE',
        description: 'Certificate format and source',
      }],
    };

    return specsFromTrieRegistrations(
      (collector) =>
        buildSecurityConfigCommands(collector as unknown as CommandTrie, this),
      {
        modes: ['config'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        skip: (path) => places[path.replace(/^no /, '')] === undefined,
        argumentFor: (path) => places[path.replace(/^no /, '')],
      },
    );
  }

  /**
   * `ip access-list {standard|extended|resequence} …`.
   *
   * Les places sont declarees plutot que subies : le NOM d'une liste
   * n'est pas un mot-cle et la renumerotation prend deux entiers, que la
   * place libre de l'adaptateur laissait deviner.
   */
  private aclNommeeSpecs(): CommandSpec[] {
    const nom: ArgumentSpec = {
      name: 'nom', type: 'WORD', description: 'Access list name',
    };
    const places: Readonly<Record<string, readonly ArgumentSpec[]>> = {
      'ip access-list standard': [nom],
      'ip access-list extended': [nom],
      'ip access-list resequence': [
        nom,
        { name: 'debut', type: 'INT', range: [1, 2147483647],
          description: 'First sequence number' },
        { name: 'pas', type: 'INT', range: [1, 2147483647],
          description: 'Step between sequence numbers' },
      ],
    };

    return specsFromTrieRegistrations(
      (collector) => buildACLConfigCommands(collector as unknown as CommandTrie, this),
      {
        modes: ['config'], minPrivilege: 15,
        undoFromNegatedPaths: true,
        skip: (path) => places[path.replace(/^no /, '')] === undefined,
        argumentFor: (path) => places[path.replace(/^no /, '')],
      },
    );
  }

  /*
   * `interface <nom>` s'ecrivait DEUX fois — une en configuration
   * globale, une en configuration d'interface, parce qu'IOS laisse
   * passer d'une interface a l'autre sans repasser par `exit` — et les
   * deux avaient diverge : la copie du sous-mode ignorait
   * `Port-channel`, laissait `config-if` sur une SOUS-interface, rendait
   * le caret la ou l'autre repond « Incomplete », et son aide decrivait
   * une place anonyme au lieu des types. Une seule declaration, portee
   * par les trois modes, ne peut plus se contredire.
   */
  private interfaceEntrySpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => registerInterfaceEntry(collector as unknown as CommandTrie, this),
      {
        modes: ['config', 'config-if', 'config-subif'], minPrivilege: 15,
        argumentFor: () => ({
          name: 'interface', type: 'REST', description: 'Interface to configure',
          literal: 'IFACE', alternatives: INTERFACE_TYPES,
        }),
        keywordsFor: () => typesInterfaceEnMotsCles(INTERFACE_TYPES),
      });
  }

  private routingProtocolSpecs(): CommandSpec[] {
    const garder = (path: string): boolean =>
      PORTES_DE_ROUTAGE.has(path.replace(/^no /, ''));
    const options = {
      modes: ['config'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      skip: (path: string) => !garder(path),
      argumentFor: (path: string) => PORTES_DE_ROUTAGE_PLACES[path],
      /*
       * `router ospf <pid> vrf <nom>` : la VRF vient APRES l'identifiant,
       * et la porte gloutonne du trie l'avalait sans la nommer. Declarer
       * la seule place de l'identifiant la faisait refuser au caret,
       * c'est-a-dire perdre une forme que la machine accepte.
       */
      keywordsFor: (path: string) => path !== 'router ospf' ? undefined : [{
        keyword: 'vrf', description: 'Specify a VPN Routing/Forwarding instance',
        afterArguments: true,
        argument: {
          name: 'nom', type: 'WORD' as const, description: 'VPN Routing/Forwarding instance name',
        },
      }],
    };

    return [
      ...specsFromTrieRegistrations(
        (collector) => registerOSPFConfigCommands(collector as unknown as CommandTrie, this),
        options),
      ...specsFromTrieRegistrations(
        (collector) => buildRoutingProtoConfig(
          collector as unknown as CommandTrie, new CommandTrie(), this, this.routingCfg),
        options),
      ...specsFromTrieRegistrations(
        (collector) => buildConfigCommands(collector as unknown as CommandTrie, this),
        options),
    ];
  }

  private routerShowSpecs(): CommandSpec[] {
    return specsFromTrieRegistrations(
      (collector) => this.registerRouterShowViews(collector as unknown as CommandTrie),
      {
        modes: ['user', 'privileged'], minPrivilege: 1,
        skip: (path) => !ROUTER_SHOW_VIEWS.has(path),
        modesFor: (path) => path === 'show tech-support' ? ['privileged'] : undefined,
        keywordsFor: (path) => continuationsPourLeSocle(path, SOCLE, ROUTEUR_SEUL),
        restDescriptionFor: (path) => ROUTER_SHOW_ARGUMENTS[path],
        restLiteralFor: (path) => ROUTER_SHOW_ARGUMENTS[path] === undefined ? undefined : 'WORD',
      },
    );
  }

  private clearIpv6Specs(): CommandSpec[] {
    const exec = ['user', 'privileged'];
    const vue = (
      keyword: string, description: string, effacer: () => void,
    ): CommandSpec => ({
      id: `clear-ipv6-${keyword}`, path: ['clear', 'ipv6', keyword], description,
      modes: exec, minPrivilege: 15,
      run: () => { effacer(); return ''; },
    });

    return [
      vue('neighbors', 'Clear IPv6 neighbour cache', () => this.d()._clearNeighborCache()),
      vue('traffic', 'Clear IPv6 traffic statistics', () => this.d()._clearIpv6Counters()),
    ];
  }

  private ipv6ReglagesSpecs(): CommandSpec[] {
    const port = () => {
      const iface = this.selectedInterfaceName();
      return iface ? this.d().getPort(iface) : undefined;
    };
    const effacerMtu = (): string => {
      const p = port() as unknown as { ipv6Mtu?: number } | undefined;
      if (p) delete p.ipv6Mtu;
      return '';
    };
    const effacerFiltre = (): string => {
      const iface = this.selectedInterfaceName();
      if (iface) delete getSecurityConfig(this.d()).ifaceFlags(iface).ipv6TrafficFilter;
      return '';
    };

    return [
      {
        id: 'ipv6-mtu-undo',
        path: ['ipv6', 'mtu'],
        description: 'Set IPv6 MTU',
        undoDescription: 'Restore the default IPv6 MTU',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        existsOnlyNegated: true,
        run: effacerMtu, undo: effacerMtu,
      },
      {
        id: 'ipv6-traffic-filter-undo',
        path: ['ipv6', 'traffic-filter'],
        description: 'Apply IPv6 ACL',
        undoDescription: 'Remove the IPv6 ACL from this interface',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        existsOnlyNegated: true,
        run: effacerFiltre, undo: effacerFiltre,
      },
      {
        id: 'ipv6-unicast-routing',
        path: ['ipv6', 'unicast-routing'],
        description: 'Enable IPv6 unicast routing',
        undoDescription: 'Disable IPv6 unicast routing',
        modes: ['config'], minPrivilege: 15,
        run: () => { this.d().enableIPv6Routing(); return ''; },
        undo: () => { this.d().disableIPv6Routing(); return ''; },
      },
      {
        id: 'ipv6-cef',
        path: ['ipv6', 'cef'],
        description: 'Enable IPv6 CEF',
        undoDescription: 'Disable IPv6 CEF',
        modes: ['config'], minPrivilege: 15,
        run: () => { getSecurityConfig(this.d()).ipv6Cef = true; return ''; },
        undo: () => { getSecurityConfig(this.d()).ipv6Cef = false; return ''; },
      },
      {
        id: 'ipv6-enable',
        path: ['ipv6', 'enable'],
        description: 'Enable IPv6 on interface',
        undoDescription: 'Disable IPv6 on interface',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: () => { port()?.enableIPv6(); return ''; },
        undo: () => {
          const p = port();
          if (p && !p.getIPv6Addresses().some(e => e.origin === 'static')) p.disableIPv6();
          return '';
        },
      },
      {
        id: 'ipv6-mtu',
        path: ['ipv6', 'mtu', {
          name: 'octets', type: 'INT', range: [1280, 9216],
          description: 'IPv6 MTU, in bytes',
        }],
        description: 'Set IPv6 MTU',
        undoDescription: 'Restore the default IPv6 MTU',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: (_session, args) => {
          const p = port() as unknown as { ipv6Mtu?: number } | undefined;
          if (p) p.ipv6Mtu = parseInt(args.octets, 10);
          return '';
        },
        undo: effacerMtu,
      },
      {
        id: 'ipv6-traffic-filter',
        path: ['ipv6', 'traffic-filter',
          { name: 'liste', type: 'WORD', description: 'Access-list name' },
          {
            name: 'sens', type: 'ENUM', description: 'Direction the filter applies to',
            values: [
              { keyword: 'in', description: 'Filter incoming packets' },
              { keyword: 'out', description: 'Filter outgoing packets' },
            ],
          }],
        description: 'Apply IPv6 ACL',
        undoDescription: 'Remove the IPv6 ACL from this interface',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: (_session, args) => {
          const iface = this.selectedInterfaceName();
          if (iface) {
            getSecurityConfig(this.d()).ifaceFlags(iface).ipv6TrafficFilter = {
              name: args.liste, direction: args.sens === 'out' ? 'out' : 'in',
            };
          }
          return '';
        },
        undo: effacerFiltre,
      },
    ];
  }

  protected override socleLegends(): SocleLegend[] {
    return [
      ...super.socleLegends(),
      [['no'], 'Negate a command or set its defaults', ['config-router']],
      [['crypto'], 'Encryption module'],
      [['crypto', 'ipsec'], 'Configure IPSec policy'],
      [['crypto', 'ipsec', 'security-association'], 'Security association parameters'],
      [['crypto', 'ipsec', 'security-association', 'lifetime'], 'Security association lifetime'],
      [['crypto', 'ipsec', 'security-association', 'replay'], 'Anti-replay checking'],
      [['set'], 'Set values for encryption/decryption',
        ['config-crypto-map', 'config-ipsec-profile']],
      [['set', 'security-association'], 'Security association parameters'],
      [['set', 'security-association', 'lifetime'], 'Security association lifetime'],
      [['match'], 'Match values',
        ['config-crypto-map', 'config-isakmp-profile', 'config-ikev2-profile']],
      [['match'], 'Field the record matches on', ['config-flow-record']],
      [['match', 'identity'], 'Match peer identity',
        ['config-isakmp-profile', 'config-ikev2-profile']],
      [['event'], 'Event that triggers the applet', ['config-applet']],
      [['notify'], 'Notification sent when the applet runs', ['config-applet']],
      [['transport'], 'Transport the exporter uses', ['config-flow-exporter']],
      [['template'], 'Template resend policy', ['config-flow-exporter']],
      [['template', 'data'], 'Data template', ['config-flow-exporter']],
      [['cache'], 'Flow cache parameters', ['config-flow-monitor']],
      [['cache', 'timeout'], 'When a flow leaves the cache', ['config-flow-monitor']],
      [['logging'], 'Archive log parameters', ['config-archive-log']],
      [['notify'], 'Notification the archive log sends', ['config-archive-log']],
      [['notify', 'syslog'], 'Syslog notification', ['config-applet', 'config-archive-log']],
      [['log'], 'Configuration change logging', ['config-archive']],
      [['match', 'identity', 'remote'], 'Match the remote identity',
        ['config-ikev2-profile']],
      [['authentication'], 'Authentication method', ['config-ikev2-profile']],
      [['identity'], 'Local identity', ['config-ikev2-profile']],
      [['keyring'], 'Associate a keyring with the profile',
        ['config-ikev2-profile']],
      [['identity'], 'Identity of the GDOI group', ['config-gdoi-group']],
      [['address'], 'Local address of the key server', ['config-gdoi-group']],
      [['server'], 'Key server role of this router', ['config-gdoi-group']],
      [['server', 'address'], 'Register with a remote key server',
        ['config-gdoi-group']],
      [['ipv6'], 'IPv6 interface subcommands'],
      [['ipv6', 'nd'], 'IPv6 neighbor discovery'],
      [['ipv6', 'ospf'], 'OSPFv3 interface commands'],
      [['ipv6', 'nd', 'ra'], 'Router advertisement control'],
      [['show', 'crypto'], 'Encryption module'],
      [['show', 'crypto', 'engine'], 'Show crypto engine info'],
      [['show', 'crypto', 'engine', 'connections'], 'Show crypto engine connections'],
      [['show', 'crypto', 'pki'], 'Show PKI information'],
      [['show', 'crypto', 'pki', 'certificates'], 'Show certificates'],
      [['show', 'crypto', 'ikev2'], 'Show IKEv2 information'],
      [['show', 'crypto', 'ipsec'], 'Show IPsec information'],
      [['show', 'crypto', 'isakmp'], 'Show ISAKMP information'],
      [['show', 'crypto', 'key'], 'Show crypto keys'],
      [['show', 'crypto', 'key', 'mypubkey'], 'Show public keys of this router'],
      [['show', 'ip'], 'IP information'],
      [['show', 'ip', 'bgp'], 'BGP information'],
      [['show', 'ipv6', 'dhcp'], 'Dynamic Host Configuration Protocol'],
      [['show', 'ipv6', 'eigrp'], 'Enhanced Interior Gateway Routing Protocol'],
      [['default-information'], 'Control distribution of default information'],
      [['max-metric'], 'Advertise the maximum metric'],
      [['timers'], 'Protocol timers'],
      [['timers', 'lsa'], 'Link State Advertisement'],
      [['timers', 'pacing'], 'Pacing'],
      [['timers', 'throttle'], 'Throttle timers'],
      [['version'], 'Protocol version'],
      [['show', 'ip', 'pim'], 'PIM information'],
      [['show', 'ip', 'pim', 'rp'], 'PIM Rendezvous Point information'],
      [['show', 'ip', 'igmp'], 'IGMP information'],
      [['show', 'ip', 'eigrp'], 'IP-EIGRP information'],
      [['show', 'eigrp'], 'EIGRP information'],
      [['show', 'eigrp', 'address-family'], 'Address family'],
      [['show', 'eigrp', 'address-family', 'ipv4'], 'IPv4 address family'],
      [['show', 'ip', 'nat'], 'Network Address Translation'],
      [['show', 'ip', 'nat', 'nvi'], 'NAT Virtual Interface'],
      [['object-group'], 'Configure object-group'],
    ];
  }

  private ipv6OspfSpecs(): CommandSpec[] {
    const reglage = (
      keyword: string, description: string, argument: ArgumentSpec,
      champ: string,
    ): CommandSpec => ({
      id: `ipv6-ospf-${keyword}`,
      path: ['ipv6', 'ospf', keyword, argument],
      description,
      modes: ['config-if', 'config-subif'], minPrivilege: 15,
      run: (_session, args) => this.appliquerOspfv3({
        [champ]: argument.type === 'INT' ? parseInt(args[argument.name], 10)
          : args[argument.name].toLowerCase(),
      }),
    });

    return [
      reglage('cost', 'Set OSPFv3 cost', {
        name: 'cout', type: 'INT', range: [1, 65535], description: 'Cost',
      }, 'cost'),
      reglage('priority', 'Set OSPFv3 priority', {
        name: 'priorite', type: 'INT', range: [0, 255], description: 'Priority',
      }, 'priority'),
      reglage('hello-interval', 'Set OSPFv3 hello interval', {
        name: 'secondes', type: 'INT', range: [1, 65535], description: 'Seconds',
      }, 'helloInterval'),
      reglage('dead-interval', 'Set OSPFv3 dead interval', {
        name: 'secondes', type: 'INT', range: [1, 65535], description: 'Seconds',
      }, 'deadInterval'),
      reglage('network', 'Set OSPFv3 network type', {
        name: 'type', type: 'ENUM', description: 'Network type',
        values: [
          { keyword: 'broadcast', description: 'Specify OSPFv3 broadcast multi-access network' },
          { keyword: 'non-broadcast', description: 'Specify OSPFv3 NBMA network' },
          { keyword: 'point-to-multipoint', description: 'Specify OSPFv3 point-to-multipoint network' },
          { keyword: 'point-to-point', description: 'Specify OSPFv3 point-to-point network' },
        ],
      }, 'networkType'),
      {
        id: 'ipv6-ospf-authentication-ipsec',
        path: ['ipv6', 'ospf', 'authentication', 'ipsec', 'spi',
          {
            name: 'spi', type: 'INT', range: [256, 4294967295],
            description: 'Security Policy Index',
          },
          {
            name: 'algorithme', type: 'ENUM', description: 'Authentication algorithm',
            values: [
              { keyword: 'md5', description: 'Use MD5 authentication' },
              { keyword: 'sha1', description: 'Use SHA-1 authentication' },
            ],
          },
          {
            name: 'cle', type: 'REST',
            description: 'Key (32 hex digits for MD5, 40 for SHA-1)',
            alternatives: [
              { keyword: '0', description: 'The key is unencrypted' },
              { keyword: '7', description: 'The key is hidden' },
              { keyword: 'WORD', description: 'The key itself' },
            ],
          }],
        description: 'Enable authentication',
        undoDescription: 'Disable authentication',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: () => {
          const iface = this.selectedInterfaceName();
          if (iface) setOspfv3InterfaceAuthentication(this.d(), iface, true);
          return '';
        },
        undo: () => {
          const iface = this.selectedInterfaceName();
          if (iface) setOspfv3InterfaceAuthentication(this.d(), iface, false);
          return '';
        },
      },
      {
        id: 'ipv6-ospf-authentication-null',
        path: ['ipv6', 'ospf', 'authentication', 'null'],
        description: 'Use no authentication',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: () => {
          const iface = this.selectedInterfaceName();
          if (iface) setOspfv3InterfaceAuthentication(this.d(), iface, false);
          return '';
        },
      },
      {
        id: 'ipv6-ospf-area',
        path: ['ipv6', 'ospf',
          {
            name: 'processus', type: 'INT', range: [1, 65535],
            description: 'Process ID',
          },
          'area',
          {
            name: 'aire', type: 'WORD',
            description: 'OSPFv3 area ID as a decimal value or as an IP address',
          }],
        description: 'Enable OSPFv3 on this interface',
        undoDescription: 'Remove this interface from the OSPFv3 process',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: (_session, args) => {
          const iface = this.selectedInterfaceName();
          if (iface) {
            enableOspfv3OnInterface(
              this.d(), iface, parseInt(args.processus, 10), args.aire);
          }
          return '';
        },
        undo: () => {
          const iface = this.selectedInterfaceName();
          if (iface) disableOspfv3OnInterface(this.d(), iface);
          return '';
        },
      },
    ];
  }

  private appliquerOspfv3(patch: Record<string, unknown>): string {
    const iface = this.selectedInterfaceName();
    if (iface) setOspfv3InterfaceParams(this.d(), iface, patch);
    return '';
  }


  /**
   * `ipv6 nd …` — les controles de l'annonce de routeur.
   *
   * Declares ICI et non dans la base : `setRaParams` est une methode du
   * ROUTEUR, et un commutateur de ce depot n'annonce rien. Les declarer
   * dans la base les ferait paraitre sur une machine qui ne peut pas y
   * repondre.
   */
  private ipv6NdSpecs(): CommandSpec[] {
    const drapeau = (
      path: readonly string[], description: string, undoDescription: string,
      poser: (valeur: boolean) => Record<string, unknown>,
    ): CommandSpec => ({
      id: path.join('-'), path: [...path], description,
      modes: ['config-if', 'config-subif'], minPrivilege: 15,
      run: () => this.appliquerRa(poser(true)),
      undo: () => this.appliquerRa(poser(false)),
      undoDescription,
    });

    return [
      drapeau(['ipv6', 'nd', 'managed-config-flag'],
        'Set the M flag in router advertisements', 'Clear the M flag',
        (valeur) => ({ managedFlag: valeur })),
      drapeau(['ipv6', 'nd', 'other-config-flag'],
        'Set the O flag in router advertisements', 'Clear the O flag',
        (valeur) => ({ otherConfigFlag: valeur })),
      {
        id: 'ipv6-nd-ra-suppress',
        // `suppress` tait l'annonce spontanee ; `suppress all` tait aussi
        // la reponse a une sollicitation. La distinction est celle
        // d'IOS, et elle est OBSERVABLE : sous `suppress` seul, un hote
        // qui arrive s'autoconfigure quand meme, parce qu'il sollicite.
        path: ['ipv6', 'nd', 'ra', 'suppress', {
          name: 'portee', type: 'ENUM', optional: true,
          description: 'Extent of the suppression',
          values: [{ keyword: 'all', description: 'Also suppress solicited advertisements' }],
        }],
        description: 'Suppress router advertisements',
        undoDescription: 'Resume router advertisements',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: (_session, args) =>
          this.appliquerRa({ enabled: false, suppressAll: args.portee === 'all' }),
        undo: () => this.appliquerRa({ enabled: true, suppressAll: false }),
      },
      {
        id: 'ipv6-nd-ra-lifetime',
        // Une duree de vie NULLE ne coupe pas l'autoconfiguration
        // (RFC 4861 §4.2) : l'hote garde son adresse et ne pose pas de
        // route par defaut. Zero est donc une valeur, pas une absence.
        path: ['ipv6', 'nd', 'ra', 'lifetime', {
          name: 'secondes', type: 'INT', range: [0, 9000],
          description: 'Router lifetime advertised, in seconds',
        }],
        description: 'Set the router lifetime advertised in RAs',
        modes: ['config-if', 'config-subif'], minPrivilege: 15,
        run: (_session, args) =>
          this.appliquerRa({ routerLifetime: parseInt(args.secondes, 10) }),
      },
    ];
  }

  private appliquerRa(patch: Record<string, unknown>): string {
    const iface = this.selectedInterfaceName();
    if (!iface) return '';
    (this.d() as unknown as {
      setRaParams?: (iface: string, patch: Record<string, unknown>) => void;
    }).setRaParams?.(iface, patch);
    return '';
  }

  selectedInterfaceName(): string | null {
    return this.selectedInterface ?? null;
  }

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
    return this.d().getDhcpClientAgent().leases().map(l => ({
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
    return this.resolveInterfaceNameForDebug(name);
  }

  pendingInterfaceConfig(iface: string): Record<string, unknown> {
    const extra = this.d()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(iface) ?? {};
    extra.pendingIfConfig.set(iface, pending);
    return pending as Record<string, unknown>;
  }

  ipsecShow(method: string): string {
    const engine = this.d()._getIPSecEngineInternal() as unknown as
      Record<string, (() => string) | undefined> | null;
    return engine?.[method]?.() ?? 'IPSec not configured.';
  }

  clearAllSecurityAssociations(): void {
    this.d()._getIPSecEngineInternal()?.clearAllSAs();
  }

  clearSecurityAssociationsForPeer(peer: string): void {
    this.d()._getIPSecEngineInternal()?.clearSAsForPeer(peer);
  }

  setTunnelProtection(iface: string, profile: string, shared: boolean): void {
    this.d()._getIPSecEngineInternal()?.setTunnelProtection(iface, profile, shared);
  }

  removeTunnelProtection(iface: string): void {
    this.d()._getIPSecEngineInternal()?.removeTunnelProtection(iface);
  }

  onTunnelModeSet(iface: string, mode: string): void {
    if (mode.toLowerCase() === 'gre multipoint') {
      this.d().getDmvpnService().registerTunnel({ ifName: iface, role: 'hub', phase: 3 });
    }
  }

  // ─── Router-specific state ───────────────────────────────────────
  private selectedInterface: string | null = null;
  /** Real config-driven HSRP/VRRP/GLBP state (router-only; L2 switches none). */
  private get fhrp(): FhrpRepository { return this.d().getFhrpRepository(); }
  private readonly keyChains = new KeyChainRepository();
  getKeyChains(): KeyChainRepository { return this.keyChains; }
  private readonly policy = new PolicyRepository();
  private readonly routingCfg = new RoutingConfigRepository();
  /** Lu par le sérialiseur de configuration (`showRunningConfig`). */
  getRoutingConfig(): RoutingConfigRepository { return this.routingCfg; }
  getPolicyRepo(): PolicyRepository { return this.policy; }
  private selectedRoutingProto: { proto: 'rip' | 'eigrp' | 'bgp'; asn?: number } | null = null;
  getSelectedRoutingProto(): { proto: 'rip' | 'eigrp' | 'bgp'; asn?: number } | null {
    return this.selectedRoutingProto;
  }
  setSelectedRoutingProto(v: { proto: 'rip' | 'eigrp' | 'bgp'; asn?: number } | null): void {
    this.selectedRoutingProto = v;
  }
  private selectedTrack: number | null = null;
  private selectedIpSla: number | null = null;
  private selectedRouteMap: { name: string; seq: number } | null = null;
  getSelectedRouteMap(): { name: string; seq: number } | null { return this.selectedRouteMap; }
  setSelectedRouteMap(v: { name: string; seq: number } | null): void { this.selectedRouteMap = v; }
  getSelectedTrack(): number | null { return this.selectedTrack; }
  setSelectedTrack(id: number | null): void { this.selectedTrack = id; }
  getSelectedIpSla(): number | null { return this.selectedIpSla; }
  setSelectedIpSla(id: number | null): void { this.selectedIpSla = id; }
  private selectedDHCPPool: string | null = null;
  private selectedACL: string | null = null;
  private selectedACLType: 'standard' | 'extended' | null = null;

  // IPSec selection state
  private selectedISAKMPPriority: number | null = null;
  private selectedISAKMPProfile: string | null = null;
  private selectedISAKMPKeyring: string | null = null;
  private selectedTransformSet: string | null = null;
  private selectedCryptoMap: string | null = null;
  private selectedCryptoMapSeq: number | null = null;
  private selectedCryptoMapIsDynamic: boolean = false;
  private selectedIPSecProfile: string | null = null;
  private selectedIKEv2Proposal: string | null = null;
  private selectedIKEv2Policy: string | null = null;
  private selectedIKEv2Keyring: string | null = null;
  private selectedIKEv2KeyringPeer: string | null = null;
  private selectedIKEv2Profile: string | null = null;
  private selectedGdoiGroup: string | null = null;

  // ─── FSM (router-specific mode hierarchy) ────────────────────────
  protected readonly fsm = new CLIStateMachine<CiscoShellMode>('user', CISCO_IOS_MODES, 'user', 'privileged');

  // ─── Additional tries (beyond base's user/privileged/config/configIf) ─
  private configDhcpTrie = new CommandTrie();
  private configDhcpPoolClassTrie = new CommandTrie();
  private configTrackTrie = new CommandTrie();
  private configVrfTrie = new CommandTrie();
  private selectedVRF: string | null = null;
  private selectedVLAN: number | null = null;
  private configIpSlaTrie = new CommandTrie();
  private configIpSlaHttpRawTrie = new CommandTrie();
  private readonly configIpSlaTypeTries: Record<string, CommandTrie> = {
    'config-ipsla-echo': new CommandTrie(),
    'config-ipsla-icmpjitter': new CommandTrie(),
    'config-ipsla-jitter': new CommandTrie(),
    'config-ipsla-udp': new CommandTrie(),
    'config-ipsla-tcp': new CommandTrie(),
    'config-ipsla-http': new CommandTrie(),
    'config-ipsla-dns': new CommandTrie(),
    'config-ipsla-pathecho': new CommandTrie(),
  };
  private configRouteMapTrie = new CommandTrie();
  private configRouterTrie = new CommandTrie();
  private configRouterOspfTrie = new CommandTrie();
  private configRouterOspfv3Trie = new CommandTrie();
  private configStdNaclTrie = new CommandTrie();
  private configExtNaclTrie = new CommandTrie();
  private configIpv6NaclTrie = new CommandTrie();
  // IPSec sub-mode tries
  private configIsakmpTrie = new CommandTrie();
  private configIsakmpProfileTrie = new CommandTrie();
  private configKeyringTrie = new CommandTrie();
  private configTfsetTrie = new CommandTrie();
  private configCryptoMapTrie = new CommandTrie();
  private configIpsecProfileTrie = new CommandTrie();
  private configIkev2ProposalTrie = new CommandTrie();
  private configIkev2PolicyTrie = new CommandTrie();
  private configIkev2KeyringTrie = new CommandTrie();
  private configIkev2KeyringPeerTrie = new CommandTrie();
  private configIkev2ProfileTrie = new CommandTrie();
  private configGdoiGroupTrie = new CommandTrie();
  private configTimeRangeTrie = new CommandTrie();
  private configCmapTrie = new CommandTrie();
  private configPmapTrie = new CommandTrie();
  private configPmapClassTrie = new CommandTrie();
  private configCpTrie = new CommandTrie();
  private configZoneTrie = new CommandTrie();
  private configZonePairTrie = new CommandTrie();
  private configRadiusServerTrie = new CommandTrie();
  private configTacacsServerTrie = new CommandTrie();
  private configAaaGroupTrie = new CommandTrie();
  private configCaTrustpointTrie = new CommandTrie();
  private configAppletTrie = new CommandTrie();
  private configFlowExporterTrie = new CommandTrie();
  private configFlowRecordTrie = new CommandTrie();
  private configFlowMonitorTrie = new CommandTrie();
  private configArchiveTrie = new CommandTrie();
  private configArchiveLogTrie = new CommandTrie();
  private configDhcpClassTrie = new CommandTrie();
  private configIpv6DhcpTrie = new CommandTrie();
  private configKeychainTrie = new CommandTrie();
  private configKeychainKeyTrie = new CommandTrie();
  private selectedKeyChain: string | null = null;
  private selectedKeyChainKey: number | null = null;
  getSelectedKeyChain(): string | null { return this.selectedKeyChain; }
  setSelectedKeyChain(n: string | null): void { this.selectedKeyChain = n; }
  getSelectedKeyChainKey(): number | null { return this.selectedKeyChainKey; }
  setSelectedKeyChainKey(n: number | null): void { this.selectedKeyChainKey = n; }

  private selectedTimeRange: string | null = null;
  private selectedClassMap: string | null = null;
  private selectedPolicyMap: string | null = null;
  private selectedPolicyClass: string | null = null;
  private controlPlaneActive: boolean = false;
  private selectedZone: string | null = null;
  private selectedZonePair: string | null = null;
  private selectedRadiusServer: string | null = null;
  private selectedTacacsServer: string | null = null;
  private selectedAaaGroup: string | null = null;
  private selectedPkiTrustpoint: string | null = null;
  private selectedApplet: string | null = null;
  private selectedFlowExporter: string | null = null;
  private selectedFlowRecord: string | null = null;
  private selectedFlowMonitor: string | null = null;

  getTimeRange(): string | null { return this.selectedTimeRange; }
  setTimeRange(n: string | null): void { this.selectedTimeRange = n; }
  getClassMap(): string | null { return this.selectedClassMap; }
  setClassMap(n: string | null): void { this.selectedClassMap = n; }
  getPolicyMap(): string | null { return this.selectedPolicyMap; }
  setPolicyMap(n: string | null): void { this.selectedPolicyMap = n; }
  getPolicyClass(): string | null { return this.selectedPolicyClass; }
  setPolicyClass(n: string | null): void { this.selectedPolicyClass = n; }
  getControlPlane(): boolean { return this.controlPlaneActive; }
  setControlPlane(v: boolean): void { this.controlPlaneActive = v; }
  getZone(): string | null { return this.selectedZone; }
  setZone(n: string | null): void { this.selectedZone = n; }
  getZonePair(): string | null { return this.selectedZonePair; }
  setZonePair(n: string | null): void { this.selectedZonePair = n; }
  getRadiusServer(): string | null { return this.selectedRadiusServer; }
  setRadiusServer(n: string | null): void { this.selectedRadiusServer = n; }
  getTacacsServer(): string | null { return this.selectedTacacsServer; }
  setTacacsServer(n: string | null): void { this.selectedTacacsServer = n; }
  getAaaGroup(): string | null { return this.selectedAaaGroup; }
  setAaaGroup(n: string | null): void { this.selectedAaaGroup = n; }
  getPkiTrustpoint(): string | null { return this.selectedPkiTrustpoint; }
  setPkiTrustpoint(n: string | null): void { this.selectedPkiTrustpoint = n; }
  getApplet(): string | null { return this.selectedApplet; }
  setApplet(n: string | null): void { this.selectedApplet = n; }
  getFlowExporter(): string | null { return this.selectedFlowExporter; }
  setFlowExporter(n: string | null): void { this.selectedFlowExporter = n; }
  getFlowRecord(): string | null { return this.selectedFlowRecord; }
  setFlowRecord(n: string | null): void { this.selectedFlowRecord = n; }
  getFlowMonitor(): string | null { return this.selectedFlowMonitor; }
  setFlowMonitor(n: string | null): void { this.selectedFlowMonitor = n; }

  constructor() {
    super();
    this.initializeCommands();
    // `registerShowCommands` est appelé pour plusieurs tries ; le debug
    // est privilégié seulement, donc enregistré ici une seule fois.
    // Les suites d'un noeud glouton sont DECLAREES, plus derivees du
    // texte source de son gestionnaire. Les arbres sont releves sur
    // l'objet lui-meme : les nommer a la main en aurait oublie, et un
    // arbre oublie est un mode entier prive de ses suites.
    appliquerContinuations(this.tousLesArbres(), SOCLE, ROUTEUR_SEUL);
    // Après TOUS les enregistrements : `describeArgs` attache les
    // spécifications à des nœuds existants, il n'en crée pas.
    describeCiscoArguments({
      config: this.configTrie,
      configIf: this.configIfTrie,
      configLine: this.configLineTrie,
      configDhcp: this.configDhcpTrie,
      configRouter: this.configRouterTrie,
      configRouterOspf: this.configRouterOspfTrie,
      configStdNacl: this.configStdNaclTrie,
      configExtNacl: this.configExtNaclTrie,
      privileged: this.privilegedTrie,
      configRouteMap: this.configRouteMapTrie,
      configTimeRange: this.configTimeRangeTrie,
      configTrack: this.configTrackTrie,
      configRouterOnly: this.configTrie,
    });
  }

  // ─── IRouterShell ────────────────────────────────────────────────

  getOSType(): string { return 'cisco-ios'; }

  private ipSlaOwner: Router | null = null;

  execute(router: Router, rawInput: string): string | Promise<string> {
    this.ipSlaOwner = router;
    setInvalidInputPromptWidth(this.buildDevicePrompt(router).length);
    router.setRouteTrackResolver((trackId) =>
      router.getTrackService().isUp(parseInt(trackId, 10)));
    this.attachDebugSource((router as unknown as { getDebugService?: () => { subscribe(l: (line: string) => void): () => void } }).getDebugService?.());
    if (rawInput.trim() === '' && !this.isCollectingBanner()) return this.drainDebugConsole();
    return this.executeOnDevice(router, rawInput);
  }

  getPrompt(router: Router): string {
    return this.buildDevicePrompt(router);
  }

  // ─── CiscoShellContext Implementation ────────────────────────────

  r(): Router { return this.d(); }

  setMode(mode: CiscoShellMode): void { this.mode = mode; }

  override getMode(): CiscoShellMode { return this.mode as CiscoShellMode; }

  getSelectedInterface(): string | null { return this.selectedInterface; }
  setSelectedInterface(iface: string | null): void { this.selectedInterface = iface; }

  getSelectedDHCPPool(): string | null { return this.selectedDHCPPool; }
  setSelectedDHCPPool(pool: string | null): void { this.selectedDHCPPool = pool; }
  protected override selectDhcpPool(nom: string | null): void {
    this.setSelectedDHCPPool(nom);
  }
  setSelectedVRF(name: string | null): void { this.selectedVRF = name; }
  setSelectedVLAN(id: number | null): void { this.selectedVLAN = id; }

  resolveInterfaceName(input: string): string | null {
    return resolveInterfaceName(this.r(), input);
  }

  objectGroupStore(): ObjectGroupStore { return this.r()._getACLEngineInternal(); }

  getSelectedACL(): string | null { return this.selectedACL; }
  setSelectedACL(name: string | null): void { this.selectedACL = name; }
  getSelectedACLType(): 'standard' | 'extended' | null { return this.selectedACLType; }
  setSelectedACLType(type: 'standard' | 'extended' | null): void { this.selectedACLType = type; }

  // IPSec context getters/setters
  getSelectedISAKMPPriority(): number | null { return this.selectedISAKMPPriority; }
  setSelectedISAKMPPriority(p: number | null): void { this.selectedISAKMPPriority = p; }
  getSelectedISAKMPProfile(): string | null { return this.selectedISAKMPProfile; }
  setSelectedISAKMPProfile(p: string | null): void { this.selectedISAKMPProfile = p; }
  getSelectedISAKMPKeyring(): string | null { return this.selectedISAKMPKeyring; }
  setSelectedISAKMPKeyring(k: string | null): void { this.selectedISAKMPKeyring = k; }
  getSelectedTransformSet(): string | null { return this.selectedTransformSet; }
  setSelectedTransformSet(ts: string | null): void { this.selectedTransformSet = ts; }
  getSelectedCryptoMap(): string | null { return this.selectedCryptoMap; }
  setSelectedCryptoMap(m: string | null): void { this.selectedCryptoMap = m; }
  getSelectedCryptoMapSeq(): number | null { return this.selectedCryptoMapSeq; }
  setSelectedCryptoMapSeq(seq: number | null): void { this.selectedCryptoMapSeq = seq; }
  getSelectedCryptoMapIsDynamic(): boolean { return this.selectedCryptoMapIsDynamic; }
  setSelectedCryptoMapIsDynamic(d: boolean): void { this.selectedCryptoMapIsDynamic = d; }
  getSelectedIPSecProfile(): string | null { return this.selectedIPSecProfile; }
  setSelectedIPSecProfile(p: string | null): void { this.selectedIPSecProfile = p; }
  getSelectedIKEv2Proposal(): string | null { return this.selectedIKEv2Proposal; }
  setSelectedIKEv2Proposal(p: string | null): void { this.selectedIKEv2Proposal = p; }
  getSelectedIKEv2Policy(): string | null { return this.selectedIKEv2Policy; }
  setSelectedIKEv2Policy(n: string | null): void { this.selectedIKEv2Policy = n; }
  getSelectedIKEv2Keyring(): string | null { return this.selectedIKEv2Keyring; }
  setSelectedIKEv2Keyring(k: string | null): void { this.selectedIKEv2Keyring = k; }
  getSelectedIKEv2KeyringPeer(): string | null { return this.selectedIKEv2KeyringPeer; }
  setSelectedIKEv2KeyringPeer(p: string | null): void { this.selectedIKEv2KeyringPeer = p; }
  getSelectedIKEv2Profile(): string | null { return this.selectedIKEv2Profile; }
  setSelectedIKEv2Profile(p: string | null): void { this.selectedIKEv2Profile = p; }
  getSelectedGdoiGroup(): string | null { return this.selectedGdoiGroup; }
  setSelectedGdoiGroup(g: string | null): void { this.selectedGdoiGroup = g; }

  // ─── Per-vty state snapshot / swap (§5.1 of terminal_gap.md) ─────

  /**
   * Capture every mode-related field into a snapshot. The shell is
   * single-instance per device — to give each terminal its own vty we
   * snapshot, swap in the per-session state, run synchronously, then
   * restore. Concurrent calls are serialised at the device layer (cf.
   * Router.executeCommandInVty) so the swap window is never observed
   * across terminals.
   *
   * Async commands (ping, traceroute) capture the field values BEFORE
   * the await: by the time the Promise resolves the swap-out has
   * already happened, but the closures hold the right state via
   * `_pendingAsync`. The shell ensures it.
   */
  snapshotVtyState(): import('./vty/CliShellSession').VtySnapshot {
    return {
      mode: this.mode,
      selectedInterface: this.selectedInterface,
      selectedInterfaceRange: [],
      selectedVlan: null,
      selectedArpAcl: null,
      selectedAccessMap: null,
      selectedMqcName: null,
      selectedPortGroup: null,
      selectedRoutingProto: this.selectedRoutingProto,
      selectedTrack: this.selectedTrack,
      selectedIpSla: this.selectedIpSla,
      selectedRouteMap: this.selectedRouteMap,
      selectedDHCPPool: this.selectedDHCPPool,
      selectedACL: this.selectedACL,
      selectedACLType: this.selectedACLType,
      selectedISAKMPPriority: this.selectedISAKMPPriority,
      selectedTransformSet: this.selectedTransformSet,
      selectedCryptoMap: this.selectedCryptoMap,
      selectedCryptoMapSeq: this.selectedCryptoMapSeq,
      selectedCryptoMapIsDynamic: this.selectedCryptoMapIsDynamic,
      selectedIPSecProfile: this.selectedIPSecProfile,
      selectedIKEv2Proposal: this.selectedIKEv2Proposal,
      selectedIKEv2Policy: this.selectedIKEv2Policy,
      selectedIKEv2Keyring: this.selectedIKEv2Keyring,
      selectedIKEv2KeyringPeer: this.selectedIKEv2KeyringPeer,
      selectedIKEv2Profile: this.selectedIKEv2Profile,
      terminalLength: this.terminalLength,
      terminalWidth: this.terminalWidth,
      terminalMonitor: this.terminalMonitor,
      terminalMonitorExplicit: this.terminalMonitorExplicit,
      // Cisco IOS has no separate "terminal debugging" toggle — `terminal
      // monitor` alone gates whether debug/log output reaches this vty
      // (unlike Huawei VRP, which distinguishes the two). Mirror it here
      // purely to satisfy the shared VtySnapshot shape.
      terminalDebugging: this.terminalMonitor,
      privilegeLevel: this.currentPrivilegeLevel,
      activeParserView: this.activeParserView,
      sessionUser: this.utilisateurDeSession(),
      historySize: this.terminalHistorySize,
      cmdHistory: [...this.cmdHistory],
    };
  }

  /** Apply a session's snapshot onto this shell instance. */
  applyVtyState(s: import('./vty/CliShellSession').VtySnapshot): void {
    this.mode = s.mode as CiscoShellMode;
    this.currentPrivilegeLevel = s.privilegeLevel;
    this.activeParserView = s.activeParserView ?? null;
    this.adopterUtilisateurDeSession(s.sessionUser ?? null);
    this.selectedInterface = s.selectedInterface;
    this.selectedRoutingProto = s.selectedRoutingProto as typeof this.selectedRoutingProto;
    this.selectedTrack = s.selectedTrack;
    this.selectedIpSla = s.selectedIpSla;
    this.selectedRouteMap = s.selectedRouteMap as typeof this.selectedRouteMap;
    this.selectedDHCPPool = s.selectedDHCPPool;
    this.selectedACL = s.selectedACL;
    this.selectedACLType = s.selectedACLType;
    this.selectedISAKMPPriority = s.selectedISAKMPPriority;
    this.selectedTransformSet = s.selectedTransformSet;
    this.selectedCryptoMap = s.selectedCryptoMap;
    this.selectedCryptoMapSeq = s.selectedCryptoMapSeq;
    this.selectedCryptoMapIsDynamic = s.selectedCryptoMapIsDynamic;
    this.selectedIPSecProfile = s.selectedIPSecProfile;
    this.selectedIKEv2Proposal = s.selectedIKEv2Proposal;
    this.selectedIKEv2Policy = s.selectedIKEv2Policy;
    this.selectedIKEv2Keyring = s.selectedIKEv2Keyring;
    this.selectedIKEv2KeyringPeer = s.selectedIKEv2KeyringPeer;
    this.selectedIKEv2Profile = s.selectedIKEv2Profile;
    this.terminalLength = s.terminalLength;
    this.terminalWidth = s.terminalWidth;
    this.terminalMonitor = s.terminalMonitor;
    this.terminalMonitorExplicit = s.terminalMonitorExplicit ?? false;
    this.terminalHistorySize = s.historySize;
    this.terminalHistoryEnabled = s.historySize > 0;
    this.cmdHistory = [...s.cmdHistory];
  }

  // ─── Abstract Method Implementations ─────────────────────────────

  protected getPromptMap(): PromptMap { return CISCO_IOS_PROMPTS; }

  protected override getChassisProfile(): import('./cisco/CiscoCommonShow').CiscoChassisProfile {
    return 'router-isr2911';
  }

  private startupAliases: ReturnType<typeof this.aliases.snapshot> | null = null;

  /** `show running-config` text — source for `write memory`/NVRAM (Router.getRunningConfig). */
  getRunningConfigText(router: Router): string {
    return Show.showRunningConfig(router);
  }

  /** Re-apply saved config text onto live router state (`copy start run`, `reload`). */
  applyConfigText(router: Router, text: string): void {
    let curIface: string | null = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line === '!' ||
          line.startsWith('Building config') || line.startsWith('Current configuration')) continue;
      let g: RegExpMatchArray | null;
      if (!/^\s/.test(raw)) {
        curIface = null;
        if ((g = line.match(/^hostname\s+(\S+)/))) {
          router._setHostnameInternal(g[1]);
        } else if ((g = line.match(/^interface\s+(\S+)/))) {
          curIface = g[1];
        } else if ((g = line.match(/^ip route\s+(\S+)\s+(\S+)\s+(\S+)/))) {
          try {
            const mask = new SubnetMask(g[2]);
            const nextHop = new IPAddress(g[3]);
            if (g[1] === '0.0.0.0' && g[2] === '0.0.0.0') router.setDefaultRoute(nextHop);
            else router.addStaticRoute(new IPAddress(g[1]), mask, nextHop);
          } catch { /* malformed saved line — skip like real IOS would reject it */ }
        }
        continue;
      }
      if (!curIface) continue;
      if ((g = line.match(/^description\s+(.+)/))) {
        router.setInterfaceDescription(curIface, g[1]);
      } else if ((g = line.match(/^ip address\s+(\S+)\s+(\S+)(\s+secondary)?/))) {
        try {
          router.configureInterface(curIface, new IPAddress(g[1]), new SubnetMask(g[2]), !!g[3]);
        } catch { /* malformed saved line — skip */ }
      } else if (line === 'shutdown') {
        router.getPort(curIface)?.setAdminShutdown(true);
      } else if (line === 'no shutdown') {
        router.getPort(curIface)?.setAdminShutdown(false);
      }
    }
  }

  protected onSave(): string {
    this.d().writeMemory();
    (this.d() as unknown as { _noteNvramWrite?: (u: string) => void })
      ._noteNvramWrite?.(this.configSessionLabel);
    this.startupAliases = this.aliases.snapshot();
    this.archiveAfterSave();
    return 'Building configuration...\n[OK]';
  }

  protected override onErase(): void {
    super.onErase();
    this.startupAliases = null;
  }

  /**
   * Le démarrage relit `nvram:` — sauf quand le registre le lui interdit.
   * `ignoreStartupConfig()` était écrite, documentée, et appelée par
   * personne : `config-register 0x2142` puis `reload` rechargeait la
   * configuration sauvegardée comme si le bit n'existait pas, donc la
   * moitié du chapitre « mot de passe oublié » ne pouvait pas se faire.
   * La sauvegarde est INTACTE dans `nvram:` — c'est le point de la
   * manœuvre : elle est là, elle n'est simplement pas chargée, et c'est
   * pourquoi on la relit ensuite par `copy startup-config running-config`.
   */
  private reloadFromNvram(device: Router): void {
    device._resetConfigurableStateForReload();
    if (this.bootIgnoresStartupConfig(device)) return;
    device._restoreStartupConfig();
  }

  protected override performImmediateReload(): string {
    const out = super.performImmediateReload();
    this.reloadFromNvram(this.d());
    if (this.startupAliases) this.aliases.restore(this.startupAliases);
    return out;
  }

  protected override performScheduledReload(device: Router): void {
    super.performScheduledReload(device);
    this.reloadFromNvram(device);
    if (this.startupAliases) this.aliases.restore(this.startupAliases);
  }

  // `cmdExit` n'est PAS redefinie ici : la copie qui s'y trouvait ne
  // differait de celle de la base que par une conversion de type, et
  // c'est elle qui a fait diverger les deux plateformes le jour ou la
  // base a appris qu'`exit` depuis le mode privilegie ferme la session.
  // Le switch fermait, le routeur ne faisait rien.

  protected override sessionParamRanges(device?: Router): SessionParamRanges | null {
    return hsrpGroupRange(this, () => (device ?? this.d()).getFhrpRepository());
  }

  protected getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user': return this.userTrie;
      case 'privileged': return this.privilegedTrie;
      case 'config': return this.configTrie;
      case 'config-if': return this.configIfTrie;
      case 'config-subif': return this.configIfTrie;
      case 'config-line': return this.configLineTrie;
      case 'config-view': return this.configViewTrie;
      case 'config-dhcp': return this.configDhcpTrie;
      case 'config-dhcp-pool-class': return this.configDhcpPoolClassTrie;
      case 'config-track': return this.configTrackTrie;
      case 'config-vrf': return this.configVrfTrie;
      case 'config-ipsla': return this.configIpSlaTrie;
      case 'config-ipsla-http-raw': return this.configIpSlaHttpRawTrie;
      case 'config-ipsla-echo':
      case 'config-ipsla-icmpjitter':
      case 'config-ipsla-jitter':
      case 'config-ipsla-udp':
      case 'config-ipsla-tcp':
      case 'config-ipsla-http':
      case 'config-ipsla-dns':
      case 'config-ipsla-pathecho':
        return this.configIpSlaTypeTries[this.mode];
      case 'config-route-map': return this.configRouteMapTrie;
      case 'config-router': return this.configRouterTrie;
      case 'config-router-af': return this.configRouterTrie;
      case 'config-router-ospf': return this.configRouterOspfTrie;
      case 'config-router-ospfv3': return this.configRouterOspfv3Trie;
      case 'config-std-nacl': return this.configStdNaclTrie;
      case 'config-ext-nacl': return this.configExtNaclTrie;
      case 'config-ipv6-nacl': return this.configIpv6NaclTrie;
      case 'config-isakmp': return this.configIsakmpTrie;
      case 'config-isakmp-profile': return this.configIsakmpProfileTrie;
      case 'config-keyring': return this.configKeyringTrie;
      case 'config-tfset': return this.configTfsetTrie;
      case 'config-crypto-map': return this.configCryptoMapTrie;
      case 'config-ipsec-profile': return this.configIpsecProfileTrie;
      case 'config-ikev2-proposal': return this.configIkev2ProposalTrie;
      case 'config-ikev2-policy': return this.configIkev2PolicyTrie;
      case 'config-ikev2-keyring': return this.configIkev2KeyringTrie;
      case 'config-ikev2-keyring-peer': return this.configIkev2KeyringPeerTrie;
      case 'config-ikev2-profile': return this.configIkev2ProfileTrie;
      case 'config-gdoi-group': return this.configGdoiGroupTrie;
      case 'config-time-range': return this.configTimeRangeTrie;
      case 'config-cmap': return this.configCmapTrie;
      case 'config-pmap': return this.configPmapTrie;
      case 'config-pmap-c': return this.configPmapClassTrie;
      case 'config-cp': return this.configCpTrie;
      case 'config-zone': return this.configZoneTrie;
      case 'config-zone-pair': return this.configZonePairTrie;
      case 'config-radius-server': return this.configRadiusServerTrie;
      case 'config-tacacs-server': return this.configTacacsServerTrie;
      case 'config-aaa-group': return this.configAaaGroupTrie;
      case 'config-ca-trustpoint': return this.configCaTrustpointTrie;
      case 'config-applet': return this.configAppletTrie;
      case 'config-flow-exporter': return this.configFlowExporterTrie;
      case 'config-flow-record': return this.configFlowRecordTrie;
      case 'config-flow-monitor': return this.configFlowMonitorTrie;
      case 'config-archive': return this.configArchiveTrie;
      case 'config-archive-log': return this.configArchiveLogTrie;
      case 'config-dhcp-class': return this.configDhcpClassTrie;
      case 'config-ipv6-dhcp': return this.configIpv6DhcpTrie;
      case 'config-keychain': return this.configKeychainTrie;
      case 'config-keychain-key': return this.configKeychainKeyTrie;
      default: return this.userTrie;
    }
  }

  /**
   * Une entrée `ip sla <n>` quittée SANS type d'opération n'existe pas
   * sur IOS : la configuration est abandonnée. La garder produisait une
   * opération « not configured » qui survivait dans `show ip sla
   * summary`, `configuration` et la running-config — et qui, au passage,
   * cassait l'alignement du tableau du résumé.
   */
  private discardUnconfiguredIpSla(): void {
    // `exit` est traité AVANT que `executeOnDevice` ne pose la référence
    // d'équipement, d'où cette référence posée par `execute` : `d()`
    // lèverait ici.
    const router = this.ipSlaOwner;
    if (this.selectedIpSla === null || !router) return;
    const engine = router.getIpSlaEngine();
    const runtime = engine.getOperation(this.selectedIpSla);
    if (runtime && runtime.config.type === 'unknown') engine.removeOperation(this.selectedIpSla);
  }

  protected clearFields(fields: string[]): void {
    for (const f of fields) {
      if (f === 'selectedInterface') this.selectedInterface = null;
      if (f === 'selectedParserView') this.selectedParserView = null;
      if (f === 'selectedDHCPPool') this.selectedDHCPPool = null;
      if (f === 'selectedTrack') this.selectedTrack = null;
      if (f === 'selectedIpSla') { this.discardUnconfiguredIpSla(); this.selectedIpSla = null; }
      if (f === 'selectedRouteMap') this.selectedRouteMap = null;
      if (f === 'selectedRoutingProto') this.selectedRoutingProto = null;
      if (f === 'selectedACL') { this.selectedACL = null; this.selectedACLType = null; }
      if (f === 'selectedACLType') this.selectedACLType = null;
      if (f === 'selectedISAKMPPriority') this.selectedISAKMPPriority = null;
      if (f === 'selectedISAKMPProfile') this.selectedISAKMPProfile = null;
      if (f === 'selectedISAKMPKeyring') this.selectedISAKMPKeyring = null;
      if (f === 'selectedTransformSet') this.selectedTransformSet = null;
      if (f === 'selectedCryptoMap') { this.selectedCryptoMap = null; this.selectedCryptoMapSeq = null; this.selectedCryptoMapIsDynamic = false; }
      if (f === 'selectedCryptoMapSeq') this.selectedCryptoMapSeq = null;
      if (f === 'selectedIPSecProfile') this.selectedIPSecProfile = null;
      if (f === 'selectedIKEv2Proposal') this.selectedIKEv2Proposal = null;
      if (f === 'selectedIKEv2Policy') this.selectedIKEv2Policy = null;
      if (f === 'selectedIKEv2Keyring') this.selectedIKEv2Keyring = null;
      if (f === 'selectedIKEv2KeyringPeer') this.selectedIKEv2KeyringPeer = null;
      if (f === 'selectedIKEv2Profile') this.selectedIKEv2Profile = null;
      if (f === 'selectedGdoiGroup') this.selectedGdoiGroup = null;
      if (f === 'selectedTimeRange') this.selectedTimeRange = null;
      if (f === 'selectedKeyChain') this.selectedKeyChain = null;
      if (f === 'selectedKeyChainKey') this.selectedKeyChainKey = null;
      if (f === 'selectedClassMap') this.selectedClassMap = null;
      if (f === 'selectedPolicyMap') this.selectedPolicyMap = null;
      if (f === 'selectedPolicyClass') this.selectedPolicyClass = null;
      if (f === 'selectedZone') this.selectedZone = null;
      if (f === 'selectedZonePair') this.selectedZonePair = null;
      if (f === 'selectedRadiusServer') this.selectedRadiusServer = null;
      if (f === 'selectedTacacsServer') this.selectedTacacsServer = null;
      if (f === 'selectedAaaGroup') this.selectedAaaGroup = null;
      if (f === 'selectedPkiTrustpoint') this.selectedPkiTrustpoint = null;
      if (f === 'selectedApplet') this.selectedApplet = null;
      if (f === 'selectedFlowExporter') this.selectedFlowExporter = null;
      if (f === 'selectedFlowRecord') this.selectedFlowRecord = null;
      if (f === 'selectedFlowMonitor') this.selectedFlowMonitor = null;
    }
  }

  // ─── Router-Specific Command Registration ─────────────────────────

  protected registerDeviceCommands(): void {
    // ── User mode ──
    this.registerShowCommands(this.userTrie);
    this.userTrie.registerGreedy('ping', 'Send echo messages', (args) => {
      return this._handlePing(args);
    });
    // Le protocole se choisit AVANT la cible, les options viennent
    // APRÈS : `ping ip 1.1.1.1` et `ping 1.1.1.1 repeat 5` existent,
    // `ping 1.1.1.1 ip` non. Et seules les options que `parsePingArgs`
    // accepte vraiment sont annoncées.
    this.userTrie.addCompletionKeywords('ping', [
      { keyword: 'ip', description: 'IP echo', leadingOnly: true },
      { keyword: 'ipv6', description: 'IPv6 echo', leadingOnly: true },
      { keyword: 'repeat', description: 'Repeat count' },
      { keyword: 'size', description: 'Datagram size' },
      { keyword: 'source', description: 'Source address or interface' },
      { keyword: 'timeout', description: 'Timeout in seconds' },
    ]);
    this.userTrie.registerGreedy('traceroute', 'Trace route to destination', (args) => {
      return this._handleTraceroute(args);
    });
    this.userTrie.addCompletionKeywords('traceroute', [
      { keyword: 'ip', description: 'IP Trace', leadingOnly: true },
      { keyword: 'ipv6', description: 'IPv6 Trace', leadingOnly: true },
      { keyword: 'probe', description: 'Probe count' },
      { keyword: 'timeout', description: 'Timeout in seconds' },
      { keyword: 'ttl', description: 'Minimum and maximum time to live' },
    ]);

    // ── Privileged mode ──
    this.registerShowCommands(this.privilegedTrie);
    registerDhcpPrivilegedCommands(this.privilegedTrie, () => this.d());
    buildIPSecPrivilegedCommands(this.privilegedTrie, this);
    registerNATPrivilegedCommands(this.privilegedTrie, () => this.d());
    registerACLClearCommands(this.privilegedTrie, () => this.d());

    // ── Config mode ──
    buildConfigCommands(this.configTrie, this);
    buildConfigIfCommands(this.configIfTrie, this);
    buildBfdInterfaceCommands(this.configIfTrie, {
      selectedPorts: () => this.selectedPortsForConfigIf(),
      r: () => this.d(),
    });
    buildIgmpInterfaceCommands(this.configIfTrie, {
      selectedPorts: () => this.selectedPortsForConfigIf(),
      r: () => this.d(),
    });
    buildPimInterfaceCommands(this.configIfTrie, {
      selectedPorts: () => this.selectedPortsForConfigIf(),
      r: () => this.d(),
    });
    buildPimGlobalConfigCommands(this.configTrie, { r: () => this.d() });
    if (this.hasVxlanHardware()) {
      buildVxlanInterfaceCommands(this.configIfTrie, {
        selectedInterface: () => this.getSelectedInterface(),
        resolveInterfaceName: (s) => this.resolveInterfaceName(s),
        r: () => this.d(),
      });
    }
    buildPolicyConfig(this.configTrie, this.configRouteMapTrie, this, this.policy);
    buildTrackConfigCommands(this.configTrie, this.configTrackTrie, this);
    buildIpSlaConfigCommands(this.configTrie, this.configIpSlaTrie,
      this.configIpSlaHttpRawTrie, this);
    registerIpSlaTypeSubModes(this.configIpSlaTypeTries, this.configIpSlaHttpRawTrie, this);
    buildACLConfigCommands(this.configTrie, this);
    // NAT
    buildNATConfigCommands(this.configTrie, this);
    buildNATInterfaceCommands(this.configIfTrie, this);
    this.configIfTrie.registerGreedy('ip vrf forwarding', 'Bind interface to a VRF', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const vrfName = args[0];
      const ifName = this.getSelectedInterface?.();
      if (!ifName) return '% No interface selected.';
      const router = this.d() as unknown as { _vrfs?: Map<string, { name: string; interfaces: Set<string> }>; _ifaceVrf?: Map<string, string> };
      if (!router._vrfs?.has(vrfName)) return `% VRF ${vrfName} not configured`;
      router._vrfs.get(vrfName)!.interfaces.add(ifName);
      (router._ifaceVrf ??= new Map()).set(ifName, vrfName);
      for (const [name, vrf] of router._vrfs) {
        if (name !== vrfName) vrf.interfaces.delete(ifName);
      }
      return '';
    });
    this.configIfTrie.registerGreedy('no ip vrf forwarding', 'Unbind interface from VRF', (args) => {
      const ifName = this.getSelectedInterface?.();
      if (!ifName) return '% No interface selected.';
      const router = this.d() as unknown as { _vrfs?: Map<string, { name: string; interfaces: Set<string> }>; _ifaceVrf?: Map<string, string> };
      const bound = router._ifaceVrf?.get(ifName);
      if (bound) {
        router._vrfs?.get(bound)?.interfaces.delete(ifName);
        router._ifaceVrf?.delete(ifName);
      }
      void args;
      return '';
    });
    buildConfigDhcpCommands(this.configDhcpTrie, this);
    buildConfigDhcpPoolClassCommands(this.configDhcpPoolClassTrie, this);
    buildConfigDhcpClassCommands(this.configDhcpClassTrie, this);
    buildConfigIpv6DhcpCommands(this.configIpv6DhcpTrie, this);
    registerKeyChainGlobalCommands(this.configTrie, this);
    buildKeyChainSubmode(this.configKeychainTrie, this);
    buildKeyChainKeySubmode(this.configKeychainKeyTrie, this);
    registerKeyChainShowCommands(this.privilegedTrie, this);
    registerKeyChainShowCommands(this.userTrie, this);
    buildRoutingProtoConfig(this.configTrie, this.configRouterTrie, this, this.routingCfg);
    this.configRouterTrie.setCompletionFilter((path, keyword) =>
      routerKeywordBelongsTo(path.length > 0 ? path[0] : keyword,
        this.selectedRoutingProto?.proto ?? 'rip'));
    buildNamedStdACLCommands(this.configStdNaclTrie, this);
    buildNamedExtACLCommands(this.configExtNaclTrie, this);
    buildIPv6ACLGlobalCommands(this.configTrie, this);
    buildIPv6ACLModeCommands(this.configIpv6NaclTrie, this);
    // OSPF
    registerOSPFConfigCommands(this.configTrie, this);
    registerOSPFInterfaceCommands(this.configIfTrie, this);
    buildConfigRouterOSPFCommands(this.configRouterOspfTrie, this);
    buildConfigRouterOSPFv3Commands(this.configRouterOspfv3Trie, this);

    this.registerVrfSubmodeOn(this.configVrfTrie);
    // IPSec
    buildIPSecGlobalCommands(this.configTrie, this);
    buildIPSecIfCommands(this.configIfTrie, this);
    buildISAKMPPolicyCommands(this.configIsakmpTrie, this);
    buildISAKMPProfileCommands(this.configIsakmpProfileTrie, this);
    buildISAKMPKeyringCommands(this.configKeyringTrie, this);
    buildTransformSetCommands(this.configTfsetTrie, this);
    buildCryptoMapEntryCommands(this.configCryptoMapTrie, this);
    buildIPSecProfileCommands(this.configIpsecProfileTrie, this);
    buildIKEv2GlobalCommands(this.configTrie, this);
    buildIKEv2ProposalCommands(this.configIkev2ProposalTrie, this);
    buildIKEv2PolicyCommands(this.configIkev2PolicyTrie, this);
    buildIKEv2KeyringCommands(this.configIkev2KeyringTrie, this);
    buildIKEv2KeyringPeerCommands(this.configIkev2KeyringPeerTrie, this);
    buildIKEv2ProfileCommands(this.configIkev2ProfileTrie, this);
    buildGdoiGlobalCommands(this.configTrie, this);
    buildGdoiGroupCommands(this.configGdoiGroupTrie, this);

    buildSecurityConfigCommands(this.configTrie, this);
    buildSecurityInterfaceCommands(this.configIfTrie, this);
    buildSecuritySubmodeCommands(
      this.configCmapTrie,
      this.configPmapTrie,
      this.configPmapClassTrie,
      this.configCpTrie,
      this.configZoneTrie,
      this.configZonePairTrie,
      this.configTimeRangeTrie,
      this.configRadiusServerTrie,
      this.configTacacsServerTrie,
      this.configAaaGroupTrie,
      this.configCaTrustpointTrie,
      this,
    );
    buildSecurityShowCommands(this.userTrie, () => this.d());
    buildSecurityShowCommands(this.privilegedTrie, () => this.d());

    buildEemNetflowArchiveConfigCommands(this.configTrie, this);
    buildEemAppletSubmode(this.configAppletTrie, this);
    buildFlowExporterSubmode(this.configFlowExporterTrie, this);
    buildFlowRecordSubmode(this.configFlowRecordTrie, this);
    buildFlowMonitorSubmode(this.configFlowMonitorTrie, this);
    buildArchiveSubmode(this.configArchiveTrie, this);
    buildArchiveLogSubmode(this.configArchiveLogTrie, this);
    buildEemNetflowArchiveInterfaceCommands(this.configIfTrie, this);
    buildEemNetflowArchiveShowCommands(this.userTrie, () => this.d());
    buildEemNetflowArchiveShowCommands(this.privilegedTrie, () => this.d());
  }

  // ─── Show Commands (Router-specific) ──────────────────────────────

  private registerShowCommands(trie: CommandTrie): void {
    registerRoutingProtoShow(trie, this, this.routingCfg);
    registerHsrpShowCommands(trie, this, () => this.fhrp);
    registerVrrpGlbpShowCommands(trie, this, () => this.fhrp);
    registerBfdShowCommands(trie, { r: () => this.d() });
    registerIgmpShowCommands(trie, this.multicastShowContext());
    registerPimShowCommands(trie, this.multicastShowContext());
    if (this.hasVxlanHardware()) registerVxlanShowCommands(trie, { r: () => this.d() });
    registerTrackShowCommands(trie, this);
    registerPolicyShow(trie, this.policy);
    this.registerRouterShowViews(trie);
    trie.pruneSubtreeChildren('show', HORS_PLATEFORME_ISR);
  }

  private registerRouterShowViews(trie: CommandTrie): void {
    const getRouter = () => this.d();



    // `show tech-support` — real aggregation of the key show outputs.
    trie.register('show tech-support', 'Aggregate diagnostic output', () => {
      const r = this.d();
      const section = (title: string, body: string) =>
        `------------------ ${title} ------------------\n${body}`;
      return [
        section('show version', Show.showVersion(r, this.getChassisProfile(),
          this.fs().renderConfigRegisterLine())),
        section('show running-config', Show.showRunningConfig(r)),
        section('show ip interface brief', Show.showIpIntBrief(r)),
        section('show ip route', Show.showIpRoute(r)),
        section('show interfaces', Show.showInterfacesAll(r)),
        section('show ip protocols', Show.showIpProtocols(r)),
        section('show processes cpu', showProcessesCpu()),
        section('show ip nat translations', showNATTranslations(getRouter())),
        section('show ip nat statistics', showNATStatistics(getRouter())),
        section('show ip ospf neighbor', showIpOspfNeighbor(getRouter())),
        section('show ip dhcp binding', getRouter()._getDHCPServerInternal().formatBindingsShow()),
        section('show logging', this.logging.render()),
      ].join('\n\n');
    });

    trie.register('show bfd summary', 'Display BFD summary', () => ' No BFD sessions configured.');
    trie.register('show table-map', 'Display table-maps', () => ' No table-maps configured.');
    trie.register('show ip nbar protocol-discovery', 'Display NBAR discovery', () => ' NBAR protocol discovery is not enabled.');
    trie.registerGreedy('show queueing interface', 'Display interface queueing', () => ' Interface uses FIFO queueing.');
    trie.registerGreedy('show traffic-shape', 'Display traffic shaping', (args) => {
      if (args[0]?.toLowerCase() === 'statistics') return ' No traffic shaping statistics.';
      return ' No traffic shaping configured.';
    });
    trie.register('show ip policy', 'Display PBR bindings', () => {
      const r = getRouter() as any;
      const local = getGlobalConfig(r).localPolicyRouteMap;
      const m = new Map<string, string>();
      for (const port of getRouter().getPorts()) {
        const rm = port.getPolicyRouteMap();
        if (rm) m.set(port.getName(), rm);
      }
      // Une colonne alignée sur l'en-tête, et le nom abrégé qu'IOS emploie
      // ici : les lignes commençaient par une espace et débordaient de la
      // colonne annoncée, donc rien ne s'alignait sur l'en-tête.
      const COL = 15;
      const head = `${'Interface'.padEnd(COL)}Route map`;
      const rows: string[] = [];
      if (local) rows.push(`${'Local'.padEnd(COL)}${local}`);
      for (const [iface, rm] of m) {
        rows.push(`${iosShortInterfaceName(iface).padEnd(COL)}${rm}`);
      }
      return [head, ...rows].join('\n');
    });
    trie.register('show ip static route', 'Display static routes', () => Show.showIpRoute(getRouter()));
    trie.register('show ip interface brief', 'Display interface status summary', () => Show.showIpIntBrief(getRouter()));
    trie.register('show ip rip database', 'Display RIP database',
      () => Show.showIpRipDatabase(getRouter(), this.routingCfg.rip.autoSummary));
    // BGP/EIGRP/RIP-extras + show ip protocols come from the
    // RoutingConfigRepository (registerRoutingProtoShow), so they
    // project the real configured process state.
    trie.register('show counters', 'Display traffic counters', () => Show.showCounters(getRouter()));
    trie.register('show ip rip', 'Display RIP information', () => Show.showIpProtocols(getRouter()));

    // DHCP show commands
    registerDhcpShowCommands(trie, getRouter);

    // ACL show commands
    registerACLShowCommands(trie, getRouter);

    // OSPF show commands
    registerOSPFShowCommands(trie, getRouter);

    // IPSec show commands
    registerIPSecShowCommands(trie, getRouter);

    // NAT show commands
    registerNATShowCommands(trie, getRouter);


    trie.register('show vlans', 'Display VLANs (router)', () => Show.showVlansRouter(getRouter()));
  }

  protected override tablesDeContinuations(): readonly ContinuationTable[] {
    return [SOCLE, ROUTEUR_SEUL];
  }

  protected override poserRelaisDhcp(iface: string, cible: string): string {
    this.d()._getDHCPServerInternal().addHelperAddress(iface, cible);
    return '';
  }

  protected override retirerRelaisDhcp(iface: string, cible: string): string {
    const dhcp = this.d()._getDHCPServerInternal() as unknown as {
      removeHelperAddress?: (iface: string, ip: string) => void;
    };
    dhcp.removeHelperAddress?.(iface, cible);
    return '';
  }

  protected override ipAddressHost(): IpAddressHost {
    const iface = (): string | null => this.getSelectedInterface();
    const poser = (adresse: string, masque: string, secondaire: boolean): string => {
      const nom = iface();
      if (!nom) return '% No interface selected';
      const refus = refusSousInterfaceSansEncapsulation(this);
      if (refus) return refus;
      try {
        if (!secondaire) this.d().getDhcpClientAgent().disable(nom);
        this.d().configureInterface(
          nom, new IPAddress(adresse), new SubnetMask(masque), secondaire);
        return '';
      } catch (e) {
        return `% Invalid input: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    return {
      setPrimaryAddress: (a, m) => poser(a, m, false),
      setSecondaryAddress: (a, m) => poser(a, m, true),
      clearAddress: () => {
        const nom = iface();
        if (!nom) return '% No interface selected';
        this.d().getDhcpClientAgent().disable(nom);
        this.d().unconfigureInterface(nom);
        return '';
      },
      clearSecondaryAddress: (a, m) => {
        const nom = iface();
        if (!nom) return '% No interface selected';
        this.d().removeSecondaryAddress(nom, new IPAddress(a), new SubnetMask(m));
        return '';
      },
      setNegotiatedAddress: () => {
        const nom = iface();
        if (!nom) return '% No interface selected';
        this.d().setInterfaceAddressMode?.(nom, 'negotiated');
        return '';
      },
    };
  }

  protected override moteurDeListes() { return this.d()._getACLEngineInternal(); }

  protected override poserRouteStatique(reste: string): string {
    return cmdIpRoute(this.d(), reste.trim().split(/\s+/).filter(Boolean));
  }

  protected override retirerRouteStatique(reste: string): string {
    return cmdNoIpRoute(this.d(), reste.trim().split(/\s+/).filter(Boolean));
  }

  protected override renduInterfaces(cible: string): string {
    const args = cible.trim().split(/\s+/).filter(Boolean);
    const getRouter = () => this.d();
      const sub = (args[0] || '').toLowerCase();
      if (args.length === 0) return Show.showInterfacesAll(getRouter());
      if (sub === 'description') return Show.showInterfacesDescription(getRouter());
      if (sub === 'summary') return Show.showInterfacesSummary(getRouter());
      // Sans interface nommée, IOS rend la vue pour TOUTES : proposer le
      // mot-clé et refuser sa forme nue serait une aide qui ment.
      if (args.length === 1 && (sub === 'stats' || sub === 'accounting' || sub === 'rate-limit')) {
        const vue = sub === 'stats' ? Show.showInterfaceStats
          : sub === 'accounting' ? Show.showInterfaceAccounting
            : Show.showInterfaceRateLimit;
        return [...getRouter()._getPortsInternal().keys()]
          .map((n) => vue(getRouter(), n)).join('\n');
      }
      const last = args[args.length - 1]?.toLowerCase();
      const isViewModifier = last === 'accounting' || last === 'stats' || last === 'rate-limit';
      const ifPart = isViewModifier ? args.slice(0, -1).join(' ') : args.join(' ');
      const ifName = resolveInterfaceName(getRouter(), ifPart);
      if (!ifName) {
        // `ifPart` (the invalid argument) always starts right after the
        // fixed "show interface " prefix, regardless of the view modifier.
        const marker = ' '.repeat('show interface '.length) + '^';
        return formatInvalidInputAt(marker);
      }
      if (last === 'accounting') return Show.showInterfaceAccounting(getRouter(), ifName);
      if (last === 'stats') return Show.showInterfaceStats(getRouter(), ifName);
      if (last === 'rate-limit') return Show.showInterfaceRateLimit(getRouter(), ifName);
      return Show.showInterface(getRouter(), ifName);
  }

  protected override renduIpRoute(cible: string): string {
    return routerIpRouteView(this.d(), cible.trim().split(/\s+/).filter(Boolean));
  }

  protected override renduIpInterface(cible: string): string {
    const args = cible.trim().split(/\s+/).filter(Boolean);
    const getRouter = () => this.d();
    if (args.length === 0) return Show.showIpInterfaceAll(getRouter());
    if (args[0].toLowerCase() === 'brief') return Show.showIpIntBrief(getRouter());
    const ifName = resolveInterfaceName(getRouter(), args.join(' '));
    if (!ifName) return `% Invalid input detected at '^' marker.`;
    return Show.showIpInterfaceOne(getRouter(), ifName);
  }

  // ─── Ping Command ────────────────────────────────────────────────

  private _handlePing(args: string[]): string {
    const parsed = parsePingArgs(args);
    if (parsed.error) return parsed.error;

    const router = this.d();
    let sourceIP = parsed.sourceIP;
    if (sourceIP) {
      const resolved = this._resolveSourceIP(router, sourceIP);
      if (resolved) sourceIP = resolved;
    }

    if (parsed.protocol === 'ipv6') {
      this._pendingAsync = router
        .executePing6Sequence(
          new IPv6Address(parsed.target), parsed.count, parsed.timeoutMs,
          sourceIP ?? undefined, { sizeBytes: parsed.sizeBytes },
        )
        .then(results => formatCiscoPing(
          parsed.target, parsed.count, parsed.timeoutMs, results, parsed.sizeBytes));
      return '';
    }

    this._pendingAsync = this.resoudreCible(router, parsed.target).then((adresse) => {
      if (!adresse) return `% Unrecognized host or address, or protocol not running.`;
      return router
        .executePingSequence(
          new IPAddress(adresse), parsed.count, parsed.timeoutMs, sourceIP ?? undefined)
        .then(results => formatCiscoPing(
          adresse, parsed.count, parsed.timeoutMs, results, parsed.sizeBytes));
    });

    return '';
  }

  protected resoudreCible(appareil: unknown, cible: string): Promise<string | null> {
    if (isValidIPv4(cible)) return Promise.resolve(cible);
    const svc = (appareil as {
      getDnsService?: () => { resolve(n: string): Promise<string | null> };
    }).getDnsService?.();
    if (!svc) return Promise.resolve(null);
    return svc.resolve(cible);
  }

  private _handleTraceroute(args: string[]): string {
    if (args.length === 0) {
      return '% Traceroute requires a target IP address.';
    }

    let target = '';
    let maxHops = 30;
    let timeoutMs = 2000;
    let probesPerHop = 3;

    let i = 0;
    let ipv6 = false;
    const first = args[0]?.trim().toLowerCase();
    if (first === 'ipv6' || first === 'ip') {
      ipv6 = first === 'ipv6';
      i++;
    }
    target = args[i++]?.trim() || '';

    while (i < args.length) {
      const kw = args[i]?.toLowerCase();
      if (kw === 'ttl' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) maxHops = n;
        i += 2;
      } else if (kw === 'timeout' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) timeoutMs = n * 1000;
        i += 2;
      } else if (kw === 'probe' && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (!isNaN(n) && n > 0) probesPerHop = n;
        i += 2;
      } else {
        i++;
      }
    }

    if (!target) return '% Traceroute requires a target IP address.';

    if (ipv6 || looksLikeIPv6(target)) {
      if (!looksLikeIPv6(target)) {
        return `% Unrecognized host or address, or protocol not running.`;
      }
      this._pendingAsync = this.d()
        .executeTraceroute6(new IPv6Address(target), maxHops, timeoutMs, probesPerHop)
        .then(hops => this._formatCiscoTraceroute(target, maxHops, hops));
      return '';
    }

    const router = this.d();
    this._pendingAsync = this.resoudreCible(router, target).then((adresse) => {
      if (!adresse) return `% Unrecognized host or address, or protocol not running.`;
      return router
        .executeTraceroute(new IPAddress(adresse), maxHops, timeoutMs, probesPerHop)
        .then(hops => this._formatCiscoTraceroute(adresse, maxHops, hops));
    });

    return '';
  }

  private _formatCiscoTraceroute(
    target: string,
    maxHops: number,
    hops: Array<{ hop: number; ip?: string; rttMs?: number; timeout: boolean; unreachable?: boolean; probes?: Array<{ responded: boolean; rttMs?: number; ip?: string; unreachable?: boolean }> }>,
  ): string {
    const lines: string[] = [
      'Type escape sequence to abort.',
      `Tracing the route to ${target}`,
      `VRF info: (vrf in name/id, vrf out name/id)`,
      '',
    ];

    if (hops.length === 0) {
      lines.push(`% Network is unreachable`);
      return lines.join('\n');
    }

    for (const hop of hops) {
      if (hop.timeout && (!hop.probes || hop.probes.every(p => !p.responded))) {
        lines.push(`  ${hop.hop}  *  *  *`);
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
            parts.push(`${Math.round(probe.rttMs ?? 0)} msec`);
          }
        }
        lines.push(`  ${hop.hop} ${hop.ip}  ${parts.join(' ')}${annotation}`);
      } else {
        const ms = Math.round(hop.rttMs ?? 0);
        lines.push(`  ${hop.hop} ${hop.ip}  ${ms} msec${annotation}`);
      }
    }

    return lines.join('\n');
  }

  private _resolveSourceIP(router: any, source: string): string | null {
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(source)) return source;
    const ports = router._getPortsInternal?.() as Map<string, any> | undefined;
    if (!ports) return null;
    const port = ports.get(source);
    if (port) {
      const ip = port.getIPAddress?.();
      return ip ? ip.toString() : null;
    }
    const resolved = resolveInterfaceName(router, source);
    if (resolved) {
      const rPort = ports.get(resolved);
      if (rPort) {
        const ip = rPort.getIPAddress?.();
        return ip ? ip.toString() : null;
      }
    }
    return null;
  }
}
