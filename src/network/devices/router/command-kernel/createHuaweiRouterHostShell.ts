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
import { HuaweiRouterSysIpv6RootCommand } from './commands/huawei/system-view/root/Ipv6';
import { HuaweiRouterIfIpv6Command } from './commands/huawei/interface-view/Ipv6';
import { HuaweiRouterAclRuleCommand } from './commands/huawei/acl-view/Rule';
import { HuaweiRouterAclDescriptionCommand } from './commands/huawei/acl-view/Description';
import { HuaweiRouterAclStepCommand } from './commands/huawei/acl-view/Step';
import { HuaweiRouterSysRoutePolicyCommand } from './commands/huawei/system-view/RoutePolicy';
import { HuaweiRouterRoutePolicyIfMatchCommand } from './commands/huawei/route-policy-view/IfMatch';
import { HuaweiRouterRoutePolicyApplyCommand } from './commands/huawei/route-policy-view/Apply';
import { HuaweiRouterPoolLeaseCommand } from './commands/huawei/dhcp-pool-view/Lease';
import { HuaweiRouterPoolExcludedIpAddressCommand } from './commands/huawei/dhcp-pool-view/ExcludedIpAddress';
import { HuaweiRouterPoolStaticBindCommand } from './commands/huawei/dhcp-pool-view/StaticBind';
import { HuaweiRouterPoolVpnInstanceCommand } from './commands/huawei/dhcp-pool-view/VpnInstance';
import { HuaweiRouterIkeProposalPeerCommand } from './commands/huawei/ike-proposal-view/Peer';
import { HuaweiRouterIkeProposalDhCommand } from './commands/huawei/ike-proposal-view/Dh';
import { HuaweiRouterIpsecProposalEspCommand } from './commands/huawei/ipsec-proposal-view/Esp';
import { HuaweiRouterIpsecProposalEncapsulationModeCommand } from './commands/huawei/ipsec-proposal-view/EncapsulationMode';
import { HuaweiRouterInterfaceRangeCommand } from './commands/huawei/system-view/interface/Range';
import { HuaweiRouterIfDhcpCommand } from './commands/huawei/interface-view/Dhcp';
import { HuaweiRouterIfHelperAddressCommand } from './commands/huawei/interface-view/ip/HelperAddress';
import { HuaweiRouterDisplayIpsecCommand } from './commands/huawei/display/Ipsec';
import { HuaweiRouterDisplayIkeCommand } from './commands/huawei/display/Ike';
import { HuaweiRouterDisplayOspfCommand } from './commands/huawei/display/Ospf';
import { HuaweiRouterDisplayUsersCommand } from './commands/huawei/display/User';
import { HuaweiRouterDisplayBgpCommand } from './commands/huawei/display/Bgp';
import { HuaweiRouterIfNatCommand } from './commands/huawei/interface-view/Nat';
import { HuaweiRouterIfTrafficPolicyCommand } from './commands/huawei/interface-view/TrafficPolicy';
import { HuaweiRouterSysNatCommand } from './commands/huawei/system-view/Nat';
import { HuaweiRouterSysTrafficClassifierCommand } from './commands/huawei/system-view/traffic/TrafficClassifier';
import { HuaweiRouterSysTrafficBehaviorCommand } from './commands/huawei/system-view/traffic/TrafficBehavior';
import { HuaweiRouterSysTrafficPolicyCommand } from './commands/huawei/system-view/traffic/TrafficPolicy';
import { HuaweiRouterSysDnsCommand } from './commands/huawei/system-view/Dns';
import { HuaweiRouterSysSshCommand } from './commands/huawei/system-view/Ssh';
import { HuaweiRouterVpnRouteDistinguisherCommand } from './commands/huawei/vpn-instance-view/RouteDistinguisher';
import { HuaweiRouterVpnTargetCommand } from './commands/huawei/vpn-instance-view/VpnTarget';
import { HuaweiRouterTrafficClassifierIfMatchCommand } from './commands/huawei/traffic-classifier-view/IfMatch';
import { HuaweiRouterTrafficBehaviorPermitCommand } from './commands/huawei/traffic-behavior-view/Permit';
import { HuaweiRouterTrafficBehaviorDenyCommand } from './commands/huawei/traffic-behavior-view/Deny';
import { HuaweiRouterTrafficBehaviorCarCommand } from './commands/huawei/traffic-behavior-view/Car';
import { HuaweiRouterTrafficPolicyClassifierCommand } from './commands/huawei/traffic-policy-view/Classifier';
import { HuaweiRouterAaaRadiusServerRootCommand } from './commands/huawei/aaa-view/RadiusServer';
import { HuaweiRouterAaaHwtacacsServerCommand } from './commands/huawei/aaa-view/HwtacacsServer';
import { HuaweiRouterAaaAuthorizationSchemeCommand } from './commands/huawei/aaa-view/AuthorizationScheme';
import { HuaweiRouterAaaAccountingSchemeCommand } from './commands/huawei/aaa-view/AccountingScheme';
import { HuaweiRouterAaaDomainCommand } from './commands/huawei/aaa-view/Domain';
import { HuaweiRouterBgpNetworkCommand } from './commands/huawei/bgp-view/Network';
import { HuaweiRouterBgpImportRouteCommand } from './commands/huawei/bgp-view/ImportRoute';
import { HuaweiRouterOspfImportRouteCommand } from './commands/huawei/ospf-view/ImportRoute';
import { HuaweiRouterOspfDefaultRouteAdvertiseCommand } from './commands/huawei/ospf-view/DefaultRouteAdvertise';
import { HuaweiRouterOspfAreaAuthenticationModeCommand } from './commands/huawei/ospf-area-view/AuthenticationMode';
import { HuaweiRouterOspfAreaStubCommand } from './commands/huawei/ospf-area-view/Stub';
import { HuaweiRouterOspfAreaNssaCommand } from './commands/huawei/ospf-area-view/Nssa';
import { HuaweiRouterBgpRouterIdCommand } from './commands/huawei/bgp-view/RouterId';
import { HuaweiRouterBgpDefaultCommand } from './commands/huawei/bgp-view/Default';
import { HuaweiRouterOspfSilentInterfaceCommand } from './commands/huawei/ospf-view/SilentInterface';
import { HuaweiRouterOspfBandwidthReferenceCommand } from './commands/huawei/ospf-view/BandwidthReference';
import { HuaweiRouterIpsecPolicyProposalCommand } from './commands/huawei/ipsec-policy-view/Proposal';
import { HuaweiRouterIpsecPolicySecurityAclCommand } from './commands/huawei/ipsec-policy-view/Security';
import { HuaweiRouterIpsecPolicyIkePeerCommand } from './commands/huawei/ipsec-policy-view/IkePeer';
import { HuaweiRouterIpsecPolicyLocalAddressCommand } from './commands/huawei/ipsec-policy-view/LocalAddress';
import { HuaweiRouterIfIpsecPolicyApplyCommand } from './commands/huawei/interface-view/Ipsec';
import { HuaweiRouterSysDhcpSnoopingCommand } from './commands/huawei/system-view/dhcp/Snooping';
import { HuaweiRouterIfDhcpSnoopingTrustedCommand } from './commands/huawei/interface-view/dhcp/Trusted';
import { HuaweiRouterSysHttpCommand } from './commands/huawei/system-view/Http';
import { HuaweiRouterTelnetCommand } from './commands/huawei/user-view/Telnet';
import { HuaweiRouterTracertCommand } from './commands/huawei/user-view/Tracert';
import { HuaweiRouterTerminalCommand } from './commands/huawei/user-view/Terminal';
import { HuaweiRouterUserResetCommand } from './commands/huawei/user-view/Reset';
import { HuaweiRouterRoutePolicyApplyCostCommand } from './commands/huawei/route-policy-view/apply/Cost';
import { HuaweiRouterRoutePolicyApplyLocalPrefCommand } from './commands/huawei/route-policy-view/apply/LocalPreference';
import { HuaweiRouterRoutePolicyApplyCommunityCommand } from './commands/huawei/route-policy-view/apply/Community';
import { HuaweiRouterRoutePolicyApplyAsPathCommand } from './commands/huawei/route-policy-view/apply/AsPath';
import { HuaweiRouterIfLoopbackDetectCommand } from './commands/huawei/interface-view/LoopbackDetect';
import { HuaweiRouterSysVoiceVlanCommand } from './commands/huawei/system-view/VoiceVlan';
import { HuaweiRouterSysSftpCommand } from './commands/huawei/system-view/Sftp';
import { HuaweiRouterSysFtpCommand } from './commands/huawei/system-view/Ftp';
import { HuaweiRouterSysUserInterfaceCommand } from './commands/huawei/system-view/UserInterface';
import { HuaweiRouterDisplayCpuUsageCommand } from './commands/huawei/display/CpuUsage';
import { HuaweiRouterDisplayMemoryUsageCommand } from './commands/huawei/display/MemoryUsage';
import { HuaweiRouterDisplayDeviceCommand } from './commands/huawei/display/Device';
import { HuaweiRouterDisplayPowerCommand } from './commands/huawei/display/Power';
import { HuaweiRouterDisplayTemperatureCommand } from './commands/huawei/display/Temperature';
import { HuaweiRouterDisplayFanCommand } from './commands/huawei/display/Fan';
import { HuaweiRouterDisplayBufferCommand } from './commands/huawei/display/Buffer';
import { HuaweiRouterIfTunnelProtocolCommand } from './commands/huawei/interface-view/TunnelProtocol';
import { HuaweiRouterIfSourceCommand } from './commands/huawei/interface-view/Source';
import { HuaweiRouterIfDestinationCommand } from './commands/huawei/interface-view/Destination';
import { HuaweiRouterIfMacAddressCommand } from './commands/huawei/interface-view/MacAddress';
import { HuaweiRouterIfQosCommand } from './commands/huawei/interface-view/Qos';
import { HuaweiRouterIfArpDetectCommand } from './commands/huawei/interface-view/ArpDetect';
import { HuaweiRouterIfArpLimitCommand } from './commands/huawei/interface-view/ArpLimit';
import { HuaweiRouterSysMulticastCommand } from './commands/huawei/system-view/Multicast';
import { HuaweiRouterSysPimCommand } from './commands/huawei/system-view/Pim';
import { HuaweiRouterSysClusterCommand } from './commands/huawei/system-view/Cluster';
import { HuaweiRouterSysStackCommand } from './commands/huawei/system-view/Stack';
import { HuaweiRouterSysBridgeCommand } from './commands/huawei/system-view/Bridge';
import { HuaweiRouterSysPortMirroringCommand } from './commands/huawei/system-view/PortMirroring';
import { HuaweiRouterUserArpPingCommand } from './commands/huawei/user-view/ArpPing';
import { HuaweiRouterUserDeleteCommand } from './commands/huawei/user-view/Delete';
import { HuaweiRouterUserMkdirCommand } from './commands/huawei/user-view/Mkdir';
import { HuaweiRouterUserRmdirCommand } from './commands/huawei/user-view/Rmdir';
import { HuaweiRouterUserCopyCommand } from './commands/huawei/user-view/Copy';
import { HuaweiRouterUserRenameCommand } from './commands/huawei/user-view/Rename';
import { HuaweiRouterUserDirCommand } from './commands/huawei/user-view/Dir';
import { HuaweiRouterUserMoreCommand } from './commands/huawei/user-view/More';
import { HuaweiRouterUserCdCommand } from './commands/huawei/user-view/Cd';
import { HuaweiRouterUserPwdCommand } from './commands/huawei/user-view/Pwd';

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
  displaySub.register(() => new HuaweiRouterDisplayIpsecCommand());
  displaySub.register(() => new HuaweiRouterDisplayIkeCommand());
  displaySub.register(() => new HuaweiRouterDisplayOspfCommand());
  displaySub.register(() => new HuaweiRouterDisplayUsersCommand());
  displaySub.register(() => new HuaweiRouterDisplayBgpCommand());
  displaySub.register(() => new HuaweiRouterDisplayCpuUsageCommand());
  displaySub.register(() => new HuaweiRouterDisplayMemoryUsageCommand());
  displaySub.register(() => new HuaweiRouterDisplayDeviceCommand());
  displaySub.register(() => new HuaweiRouterDisplayPowerCommand());
  displaySub.register(() => new HuaweiRouterDisplayTemperatureCommand());
  displaySub.register(() => new HuaweiRouterDisplayFanCommand());
  displaySub.register(() => new HuaweiRouterDisplayBufferCommand());

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
  const routePolicyViewRegistry = new CommandRegistry();
  const aclViewRegistry = new CommandRegistry();
  const vpnInstanceViewRegistry = new CommandRegistry();
  const trafficClassifierViewRegistry = new CommandRegistry();
  const trafficBehaviorViewRegistry = new CommandRegistry();
  const trafficPolicyViewRegistry = new CommandRegistry();
  const ipsecPolicyViewRegistry = new CommandRegistry();

  userViewRegistry.register(() => createHuaweiDisplayCommand(displaySub));
  userViewRegistry.register(() => new HuaweiSystemViewCommand());
  userViewRegistry.register(() => new HuaweiSaveCommand());
  userViewRegistry.register(() => new HuaweiRouterStartupCommand());
  userViewRegistry.register(() => new HuaweiRouterClockCommand());
  userViewRegistry.register(() => new HuaweiRouterRebootCommand());
  userViewRegistry.register(() => new HuaweiRouterUserViewBannerCommand());
  userViewRegistry.register(() => new HuaweiRouterTelnetCommand());
  userViewRegistry.register(() => new HuaweiRouterTracertCommand());
  userViewRegistry.register(() => new HuaweiRouterTerminalCommand());
  userViewRegistry.register(() => new HuaweiRouterUserResetCommand());
  userViewRegistry.register(() => new HuaweiRouterUserArpPingCommand());
  userViewRegistry.register(() => new HuaweiRouterUserDeleteCommand());
  userViewRegistry.register(() => new HuaweiRouterUserMkdirCommand());
  userViewRegistry.register(() => new HuaweiRouterUserRmdirCommand());
  userViewRegistry.register(() => new HuaweiRouterUserCopyCommand());
  userViewRegistry.register(() => new HuaweiRouterUserRenameCommand());
  userViewRegistry.register(() => new HuaweiRouterUserDirCommand());
  userViewRegistry.register(() => new HuaweiRouterUserMoreCommand());
  userViewRegistry.register(() => new HuaweiRouterUserCdCommand());
  userViewRegistry.register(() => new HuaweiRouterUserPwdCommand());
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
  systemViewRegistry.register(() => new HuaweiRouterSysIpv6RootCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysRoutePolicyCommand());
  systemViewRegistry.register(() => new HuaweiRouterInterfaceRangeCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysNatCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysTrafficClassifierCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysTrafficBehaviorCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysTrafficPolicyCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysDnsCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysSshCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysHttpCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysVoiceVlanCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysSftpCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysFtpCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysUserInterfaceCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysDhcpSnoopingCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysMulticastCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysPimCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysClusterCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysStackCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysBridgeCommand());
  systemViewRegistry.register(() => new HuaweiRouterSysPortMirroringCommand());
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
  interfaceViewRegistry.register(() => new HuaweiRouterIfIpv6Command());
  interfaceViewRegistry.register(() => new HuaweiRouterIfDhcpCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfHelperAddressCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfNatCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfTrafficPolicyCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfIpsecPolicyApplyCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfDhcpSnoopingTrustedCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfLoopbackDetectCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfTunnelProtocolCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfSourceCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfDestinationCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfMacAddressCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfQosCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfArpDetectCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfArpLimitCommand());
  interfaceViewRegistry.register(() => new HuaweiRouterIfUndoCommand());
  interfaceViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  interfaceViewRegistry.register(() => new EndCommand(['return']));

  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolNetworkCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolGatewayListCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolDnsListCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolDomainNameCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolLeaseCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolExcludedIpAddressCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolStaticBindCommand());
  dhcpPoolViewRegistry.register(() => new HuaweiRouterPoolVpnInstanceCommand());
  dhcpPoolViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  dhcpPoolViewRegistry.register(() => new EndCommand(['return']));

  ikeProposalViewRegistry.register(() => new HuaweiRouterIkeEncryptionAlgorithmCommand());
  ikeProposalViewRegistry.register(() => new HuaweiRouterIkeAuthenticationMethodCommand());
  ikeProposalViewRegistry.register(() => new HuaweiRouterIkeAuthenticationAlgorithmCommand());
  ikeProposalViewRegistry.register(() => new HuaweiRouterIkeProposalPeerCommand());
  ikeProposalViewRegistry.register(() => new HuaweiRouterIkeProposalDhCommand());
  ikeProposalViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ikeProposalViewRegistry.register(() => new EndCommand(['return']));

  ipsecProposalViewRegistry.register(() => new HuaweiRouterIpsecTransformCommand());
  ipsecProposalViewRegistry.register(() => new HuaweiRouterIpsecProposalEspCommand());
  ipsecProposalViewRegistry.register(() => new HuaweiRouterIpsecProposalEncapsulationModeCommand());
  ipsecProposalViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ipsecProposalViewRegistry.register(() => new EndCommand(['return']));

  routePolicyViewRegistry.register(() => new HuaweiRouterRoutePolicyIfMatchCommand());
  routePolicyViewRegistry.register(() => new HuaweiRouterRoutePolicyApplyCommand());
  routePolicyViewRegistry.register(() => new HuaweiRouterRoutePolicyApplyCostCommand());
  routePolicyViewRegistry.register(() => new HuaweiRouterRoutePolicyApplyLocalPrefCommand());
  routePolicyViewRegistry.register(() => new HuaweiRouterRoutePolicyApplyCommunityCommand());
  routePolicyViewRegistry.register(() => new HuaweiRouterRoutePolicyApplyAsPathCommand());
  routePolicyViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  routePolicyViewRegistry.register(() => new EndCommand(['return']));

  aclViewRegistry.register(() => new HuaweiRouterAclRuleCommand());
  aclViewRegistry.register(() => new HuaweiRouterAclDescriptionCommand());
  aclViewRegistry.register(() => new HuaweiRouterAclStepCommand());
  aclViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  aclViewRegistry.register(() => new EndCommand(['return']));

  aaaViewRegistry.register(() => new HuaweiRouterAaaLocalUserCommand());
  aaaViewRegistry.register(() => new HuaweiRouterAaaAuthenticationSchemeCommand());
  aaaViewRegistry.register(() => new HuaweiRouterAaaRadiusServerRootCommand());
  aaaViewRegistry.register(() => new HuaweiRouterAaaHwtacacsServerCommand());
  aaaViewRegistry.register(() => new HuaweiRouterAaaAuthorizationSchemeCommand());
  aaaViewRegistry.register(() => new HuaweiRouterAaaAccountingSchemeCommand());
  aaaViewRegistry.register(() => new HuaweiRouterAaaDomainCommand());
  aaaViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  aaaViewRegistry.register(() => new EndCommand(['return']));

  ospfViewRegistry.register(() => new HuaweiRouterOspfRouterCommand());
  ospfViewRegistry.register(() => new HuaweiRouterOspfAreaCommand());
  ospfViewRegistry.register(() => new HuaweiRouterOspfImportRouteCommand());
  ospfViewRegistry.register(() => new HuaweiRouterOspfDefaultRouteAdvertiseCommand());
  ospfViewRegistry.register(() => new HuaweiRouterOspfSilentInterfaceCommand());
  ospfViewRegistry.register(() => new HuaweiRouterOspfBandwidthReferenceCommand());
  ospfViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ospfViewRegistry.register(() => new EndCommand(['return']));

  ospfAreaViewRegistry.register(() => new HuaweiRouterOspfAreaNetworkCommand());
  ospfAreaViewRegistry.register(() => new HuaweiRouterOspfAreaAuthenticationModeCommand());
  ospfAreaViewRegistry.register(() => new HuaweiRouterOspfAreaStubCommand());
  ospfAreaViewRegistry.register(() => new HuaweiRouterOspfAreaNssaCommand());
  ospfAreaViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ospfAreaViewRegistry.register(() => new EndCommand(['return']));

  bgpViewRegistry.register(() => new HuaweiRouterBgpPeerCommand());
  bgpViewRegistry.register(() => new HuaweiRouterBgpRouterCommand());
  bgpViewRegistry.register(() => new HuaweiRouterBgpNetworkCommand());
  bgpViewRegistry.register(() => new HuaweiRouterBgpImportRouteCommand());
  bgpViewRegistry.register(() => new HuaweiRouterBgpRouterIdCommand());
  bgpViewRegistry.register(() => new HuaweiRouterBgpDefaultCommand());
  bgpViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  bgpViewRegistry.register(() => new EndCommand(['return']));

  vpnInstanceViewRegistry.register(() => new HuaweiRouterVpnRouteDistinguisherCommand());
  vpnInstanceViewRegistry.register(() => new HuaweiRouterVpnTargetCommand());
  vpnInstanceViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  vpnInstanceViewRegistry.register(() => new EndCommand(['return']));

  trafficClassifierViewRegistry.register(() => new HuaweiRouterTrafficClassifierIfMatchCommand());
  trafficClassifierViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  trafficClassifierViewRegistry.register(() => new EndCommand(['return']));

  trafficBehaviorViewRegistry.register(() => new HuaweiRouterTrafficBehaviorPermitCommand());
  trafficBehaviorViewRegistry.register(() => new HuaweiRouterTrafficBehaviorDenyCommand());
  trafficBehaviorViewRegistry.register(() => new HuaweiRouterTrafficBehaviorCarCommand());
  trafficBehaviorViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  trafficBehaviorViewRegistry.register(() => new EndCommand(['return']));

  trafficPolicyViewRegistry.register(() => new HuaweiRouterTrafficPolicyClassifierCommand());
  trafficPolicyViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  trafficPolicyViewRegistry.register(() => new EndCommand(['return']));

  ipsecPolicyViewRegistry.register(() => new HuaweiRouterIpsecPolicyProposalCommand());
  ipsecPolicyViewRegistry.register(() => new HuaweiRouterIpsecPolicySecurityAclCommand());
  ipsecPolicyViewRegistry.register(() => new HuaweiRouterIpsecPolicyIkePeerCommand());
  ipsecPolicyViewRegistry.register(() => new HuaweiRouterIpsecPolicyLocalAddressCommand());
  ipsecPolicyViewRegistry.register(() => new PopModeCommand('quit', 'Exit from the current view'));
  ipsecPolicyViewRegistry.register(() => new EndCommand(['return']));

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
    { name: 'route-policy-view',   prompt: (s, host) => `[${host}-route-policy]`,                                                          parent: 'system-view',  registry: routePolicyViewRegistry, clearOnExit: ['selectedRoutePolicy'] },
    { name: 'acl-basic-view',      prompt: (_s, host) => `[${host}-acl-basic]`,                                                            parent: 'system-view',  registry: aclViewRegistry },
    { name: 'acl-adv-view',        prompt: (_s, host) => `[${host}-acl-adv]`,                                                              parent: 'system-view',  registry: aclViewRegistry },
    { name: 'vpn-instance-view',   prompt: (s, host) => `[${host}-vpn-instance-${s.promptFields.get('selectedVpnInstance') ?? ''}]`,       parent: 'system-view',  registry: vpnInstanceViewRegistry,   clearOnExit: ['selectedVpnInstance'] },
    { name: 'traffic-classifier-view', prompt: (s, host) => `[${host}-classifier-${s.promptFields.get('selectedTrafficClassifier') ?? ''}]`, parent: 'system-view', registry: trafficClassifierViewRegistry, clearOnExit: ['selectedTrafficClassifier'] },
    { name: 'traffic-behavior-view',   prompt: (s, host) => `[${host}-behavior-${s.promptFields.get('selectedTrafficBehavior') ?? ''}]`,     parent: 'system-view', registry: trafficBehaviorViewRegistry,   clearOnExit: ['selectedTrafficBehavior'] },
    { name: 'traffic-policy-view',     prompt: (s, host) => `[${host}-trafficpolicy-${s.promptFields.get('selectedTrafficPolicy') ?? ''}]`,  parent: 'system-view', registry: trafficPolicyViewRegistry,     clearOnExit: ['selectedTrafficPolicy'] },
    { name: 'ipsec-policy-view',       prompt: (s, host) => `[${host}-ipsec-policy-${s.promptFields.get('selectedIpsecPolicy') ?? ''}]`,     parent: 'system-view', registry: ipsecPolicyViewRegistry,       clearOnExit: ['selectedIpsecPolicy'] },
  ] satisfies CliMode[]);

  const machine = new RouterMachineApi({ router, modes });
  const interpreter = new CliInterpreter(modes, machine, new PermissionGuard(), errorFormatter);
  const promptBuilder = new CliPromptBuilder(modes, () => machine.hostname);
  return { interpreter, machine, promptBuilder };
}
