import { CliInterpreter, CliPromptBuilder, EndCommand, ModeRegistry, PopModeCommand } from '@/command-kernel/cli';
import type { CliMode, KernelErrorFormatter } from '@/command-kernel/cli';
import { PermissionGuard } from '@/command-kernel/exec/permission-guard';
import { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { Router } from '../../Router';
import { createHuaweiDisplayCommand, HuaweiDisplayClockCommand, HuaweiSaveCommand, HuaweiSystemViewCommand } from '../../vendor-cli';
import { RouterMachineApi } from './RouterMachineApi';
import { HuaweiRouterDisplayVersionCommand } from './commands/huawei/display/Version';
import { HuaweiRouterDisplayIpCommand } from './commands/huawei/display/Ip';
import { HuaweiRouterDisplayCurrentConfigurationCommand } from './commands/huawei/display/CurrentConfiguration';
import { HuaweiRouterDisplayArpCommand } from './commands/huawei/display/Arp';
import { HuaweiRouterSysnameCommand } from './commands/huawei/system-view/Sysname';
import { HuaweiRouterInterfaceCommand } from './commands/huawei/system-view/Interface';
import { HuaweiRouterSysIpCommand } from './commands/huawei/system-view/Ip';
import { HuaweiRouterSysArpCommand } from './commands/huawei/system-view/Arp';
import { HuaweiRouterSysDhcpCommand } from './commands/huawei/system-view/Dhcp';
import { HuaweiRouterHeaderCommand } from './commands/huawei/system-view/Header';
import { HuaweiRouterStartupCommand } from './commands/huawei/user-view/Startup';
import { HuaweiRouterDisplaySavedConfigurationCommand } from './commands/huawei/display/SavedConfiguration';
import { HuaweiRouterIfMtuCommand } from './commands/huawei/interface-view/Mtu';
import { HuaweiRouterIfBandwidthCommand } from './commands/huawei/interface-view/Bandwidth';
import { HuaweiRouterIfSpeedCommand } from './commands/huawei/interface-view/Speed';
import { HuaweiRouterIfDuplexCommand } from './commands/huawei/interface-view/Duplex';
import { HuaweiRouterSysUndoCommand } from './commands/huawei/system-view/Undo';
import { HuaweiRouterIfIpCommand } from './commands/huawei/interface-view/Ip';
import { HuaweiRouterIfShutdownCommand } from './commands/huawei/interface-view/Shutdown';
import { HuaweiRouterIfDescriptionCommand } from './commands/huawei/interface-view/Description';
import { HuaweiRouterIfUndoCommand } from './commands/huawei/interface-view/Undo';
import { HuaweiRouterSysIpPoolCommand } from './commands/huawei/system-view/ip/Pool';
import { HuaweiRouterUndoIpPoolCommand } from './commands/huawei/system-view/undo/ip/Pool';
import { HuaweiRouterDisplayIpPoolCommand } from './commands/huawei/display/ip/Pool';
import { HuaweiRouterPoolNetworkCommand } from './commands/huawei/dhcp-pool-view/Network';
import { HuaweiRouterPoolGatewayListCommand } from './commands/huawei/dhcp-pool-view/GatewayList';
import { HuaweiRouterPoolDnsListCommand } from './commands/huawei/dhcp-pool-view/DnsList';
import { HuaweiRouterPoolDomainNameCommand } from './commands/huawei/dhcp-pool-view/DomainName';
import { HuaweiRouterSysIkeCommand } from './commands/huawei/system-view/Ike';
import { HuaweiRouterIkeEncryptionAlgorithmCommand } from './commands/huawei/ike-proposal-view/EncryptionAlgorithm';
import { HuaweiRouterIkeAuthenticationMethodCommand } from './commands/huawei/ike-proposal-view/AuthenticationMethod';
import { HuaweiRouterIkeAuthenticationAlgorithmCommand } from './commands/huawei/ike-proposal-view/AuthenticationAlgorithm';
import { HuaweiRouterSysIpsecCommand } from './commands/huawei/system-view/Ipsec';
import { HuaweiRouterIpsecTransformCommand } from './commands/huawei/ipsec-proposal-view/Transform';
import { HuaweiRouterSysRouterCommand } from './commands/huawei/system-view/Router';
import { HuaweiRouterClockCommand } from './commands/huawei/user-view/Clock';
import { HuaweiRouterRebootCommand } from './commands/huawei/user-view/Reboot';
import { HuaweiRouterSysSnmpAgentCommand } from './commands/huawei/system-view/SnmpAgent';
import { HuaweiRouterSnmpAgentCommunityCommand } from './commands/huawei/system-view/snmp-agent/Community';
import { HuaweiRouterSnmpAgentSysInfoCommand } from './commands/huawei/system-view/snmp-agent/SysInfo';
import { HuaweiRouterSysNtpServiceCommand } from './commands/huawei/system-view/NtpService';
import { HuaweiRouterSysStelnetCommand } from './commands/huawei/system-view/Stelnet';
import { HuaweiRouterSysAaaCommand } from './commands/huawei/system-view/Aaa';
import { HuaweiRouterAaaLocalUserCommand } from './commands/huawei/aaa-view/LocalUser';
import { HuaweiRouterAaaAuthenticationSchemeCommand } from './commands/huawei/aaa-view/AuthenticationScheme';
import { HuaweiRouterSysInfoCenterCommand } from './commands/huawei/system-view/InfoCenter';
import { HuaweiRouterSysAclCommand } from './commands/huawei/system-view/Acl';
import { HuaweiRouterSysMacAddressCommand } from './commands/huawei/system-view/MacAddress';
import { HuaweiRouterSysOspfCommand } from './commands/huawei/system-view/Ospf';
import { HuaweiRouterOspfRouterCommand } from './commands/huawei/ospf-view/Router';
import { HuaweiRouterOspfAreaCommand } from './commands/huawei/ospf-view/Area';
import { HuaweiRouterOspfAreaNetworkCommand } from './commands/huawei/ospf-area-view/Network';
import { HuaweiRouterSysBgpCommand } from './commands/huawei/system-view/Bgp';
import { HuaweiRouterBgpPeerCommand } from './commands/huawei/bgp-view/Peer';
import { HuaweiRouterBgpRouterCommand } from './commands/huawei/bgp-view/Router';
import { HuaweiRouterSysRipCommand } from './commands/huawei/system-view/Rip';
import { HuaweiRouterRipNetworkCommand } from './commands/huawei/rip-view/Network';
import { HuaweiRouterUserViewBannerCommand } from './commands/huawei/user-view/Banner';

/**
 * =====================================================================
 *  Bootstrap CLI vendeur Huawei VRP pour routeur — modes, registres,
 *  interpréteur
 * =====================================================================
 *
 *  Structure VRP (routeur) :
 *
 *    user-view (racine, prompt `<host>`, exec-level)
 *      └── system-view (prompt `[host]`)
 *            └── interface-view (prompt `[host-<iface>]`)
 *                  └── ospf, bgp, ipsec-policy, dhcp-pool, …
 *                      (à ajouter au fil des migrations)
 *
 *  `system-view`/`quit` viennent de `vendor-cli/huawei/` — IDENTIQUES
 *  sur routeur et switch, jamais dupliquées. Les sous-commandes de
 *  `display` sont routeur-spécifiques.
 */
export function createHuaweiRouterHostShell(
  router: Router,
  errorFormatter?: KernelErrorFormatter,
): {
  interpreter: CliInterpreter;
  machine: RouterMachineApi;
  promptBuilder: CliPromptBuilder;
} {
  const displaySub = new CommandRegistry();
  displaySub.register(() => new HuaweiRouterDisplayVersionCommand());
  displaySub.register(() => new HuaweiRouterDisplayIpCommand());
  displaySub.register(() => new HuaweiDisplayClockCommand());
  displaySub.register(() => new HuaweiRouterDisplayCurrentConfigurationCommand());
  displaySub.register(() => new HuaweiRouterDisplaySavedConfigurationCommand());
  displaySub.register(() => new HuaweiRouterDisplayArpCommand());

  const userViewRegistry = new CommandRegistry();
  const systemViewRegistry = new CommandRegistry();
  const interfaceViewRegistry = new CommandRegistry();
  const dhcpPoolViewRegistry = new CommandRegistry();
  const ikeProposalViewRegistry = new CommandRegistry();
  const ipsecProposalViewRegistry = new CommandRegistry();
  const aaaViewRegistry = new CommandRegistry();
  const ospfViewRegistry = new CommandRegistry();
  const ospfAreaViewRegistry = new CommandRegistry();
  const bgpViewRegistry = new CommandRegistry();
  const ripViewRegistry = new CommandRegistry();

  userViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  userViewRegistry.register(() => new HuaweiSystemViewCommand());
  userViewRegistry.register(() => new HuaweiSaveCommand());
  userViewRegistry.register(() => new HuaweiRouterStartupCommand());
  userViewRegistry.register(() => new HuaweiRouterClockCommand());
  userViewRegistry.register(() => new HuaweiRouterRebootCommand());
  userViewRegistry.register(() => new HuaweiRouterUserViewBannerCommand());
  userViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));

  systemViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  systemViewRegistry.register(() => new HuaweiSaveCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysnameCommand());
  systemViewRegistry.register(() => new HuaweiRouterInterfaceCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysIpCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysArpCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysDhcpCommand());
  systemViewRegistry.register(() => new HuaweiRouterHeaderCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysIkeCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysIpsecCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysRouterCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysSnmpAgentCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysNtpServiceCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysStelnetCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysAaaCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysInfoCenterCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysAclCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysMacAddressCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysOspfCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysBgpCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysRipCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysUndoCommand());
  systemViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  systemViewRegistry.register(() => new EndCommand(['return']));

  interfaceViewRegistry.register(() => new HuaweiRouterIfIpCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfShutdownCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfDescriptionCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfMtuCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfBandwidthCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfSpeedCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfDuplexCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfUndoCommand());
  interfaceViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  interfaceViewRegistry.register(() => new EndCommand(['return']));

  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolNetworkCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolGatewayListCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolDnsListCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolDomainNameCommand());
  dhcpPoolViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  dhcpPoolViewRegistry.register(() => new EndCommand(['return']));

  ikeProposalViewRegistry.register(() => new HuaweiRouterIkeEncryptionAlgorithmCommand());
  ikeProposalViewRegistry.register(() => new HuaweiRouterIkeAuthenticationMethodCommand());
  ikeProposalViewRegistry.register(() => new HuaweiRouterIkeAuthenticationAlgorithmCommand());
  ikeProposalViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ikeProposalViewRegistry.register(() => new EndCommand(['return']));

  ipsecProposalViewRegistry.register(() => new HuaweiRouterIpsecTransformCommand());
  ipsecProposalViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ipsecProposalViewRegistry.register(() => new EndCommand(['return']));

  aaaViewRegistry.register(() => new HuaweiRouterAaaLocalUserCommand());
  aaaViewRegistry.register(() => new HuaweiRouterAaaAuthenticationSchemeCommand());
  aaaViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  aaaViewRegistry.register(() => new EndCommand(['return']));

  ospfViewRegistry.register(() => new HuaweiRouterOspfRouterCommand());
  ospfViewRegistry.register(() => new HuaweiRouterOspfAreaCommand());
  ospfViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ospfViewRegistry.register(() => new EndCommand(['return']));

  ospfAreaViewRegistry.register(() => new HuaweiRouterOspfAreaNetworkCommand());
  ospfAreaViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ospfAreaViewRegistry.register(() => new EndCommand(['return']));

  bgpViewRegistry.register(() => new HuaweiRouterBgpPeerCommand());
  bgpViewRegistry.register(() => new HuaweiRouterBgpRouterCommand());
  bgpViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  bgpViewRegistry.register(() => new EndCommand(['return']));

  ripViewRegistry.register(() => new HuaweiRouterRipNetworkCommand());
  ripViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ripViewRegistry.register(() => new EndCommand(['return']));

  const modes = new ModeRegistry([
    { name: 'user-view',      prompt: (_s, host) => `<${host}>`,                                                            parent: null,           registry: userViewRegistry },
    { name: 'system-view',    prompt: (_s, host) => `[${host}]`,                                                             parent: 'user-view',    registry: systemViewRegistry },
    { name: 'interface-view', prompt: (s, host) => `[${host}-${s.promptFields.get('selectedInterface') ?? ''}]`,             parent: 'system-view',  registry: interfaceViewRegistry, clearOnExit: ['selectedInterface'] },
    { name: 'dhcp-pool-view', prompt: (s, host) => `[${host}-ip-pool-${s.promptFields.get('selectedPool') ?? ''}]`,          parent: 'system-view',  registry: dhcpPoolViewRegistry,      clearOnExit: ['selectedPool'] },
    { name: 'ike-proposal-view',   prompt: (s, host) => `[${host}-ike-proposal-${s.promptFields.get('selectedIkeProposal') ?? ''}]`,     parent: 'system-view',  registry: ikeProposalViewRegistry,   clearOnExit: ['selectedIkeProposal'] },
    { name: 'ipsec-proposal-view', prompt: (s, host) => `[${host}-ipsec-proposal-${s.promptFields.get('selectedIpsecProposal') ?? ''}]`, parent: 'system-view',  registry: ipsecProposalViewRegistry, clearOnExit: ['selectedIpsecProposal'] },
    { name: 'aaa-view',            prompt: (_s, host) => `[${host}-aaa]`,                                                                 parent: 'system-view',  registry: aaaViewRegistry },
    { name: 'ospf-view',           prompt: (s, host) => `[${host}-ospf-${s.promptFields.get('selectedOspfProcess') ?? '1'}]`,             parent: 'system-view',  registry: ospfViewRegistry,      clearOnExit: ['selectedOspfProcess'] },
    { name: 'ospf-area-view',      prompt: (s, host) => `[${host}-ospf-${s.promptFields.get('selectedOspfProcess') ?? '1'}-area-${s.promptFields.get('selectedOspfArea') ?? ''}]`, parent: 'ospf-view', registry: ospfAreaViewRegistry, clearOnExit: ['selectedOspfArea'] },
    { name: 'bgp-view',            prompt: (s, host) => `[${host}-bgp-${s.promptFields.get('selectedBgpAsn') ?? ''}]`,                    parent: 'system-view',  registry: bgpViewRegistry,       clearOnExit: ['selectedBgpAsn'] },
    { name: 'rip-view',            prompt: (s, host) => `[${host}-rip-${s.promptFields.get('selectedRipProcess') ?? '1'}]`,               parent: 'system-view',  registry: ripViewRegistry,       clearOnExit: ['selectedRipProcess'] },
  ] satisfies CliMode[]);

  const machine = new RouterMachineApi({ router, modes });
  const interpreter = new CliInterpreter(modes, machine, new PermissionGuard(), errorFormatter);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
