/**
 * Core cmdlet barrel — registers all built-in cmdlets that work without
 * any Windows system providers. Called by PSInterpreter and PowerShellExecutor.
 */

import {
  GetNetLbfoTeamCmdlet, NewNetLbfoTeamCmdlet, SetNetLbfoTeamCmdlet, RemoveNetLbfoTeamCmdlet,
  GetNetLbfoTeamMemberCmdlet, AddNetLbfoTeamMemberCmdlet, SetNetLbfoTeamMemberCmdlet,
  RemoveNetLbfoTeamMemberCmdlet,
} from './NetLbfoCmdlets';
import { CmdletRegistry } from '@/powershell/runtime/PSCmdletRegistry';
import {
  WriteOutputCmdlet, WriteHostCmdlet, WriteErrorCmdlet,
  WriteWarningCmdlet, WriteVerboseCmdlet,
  WriteDebugCmdlet, WriteProgressCmdlet, WriteInformationCmdlet,
  OutNullCmdlet, OutStringCmdlet, OutHostCmdlet,
  OutPrinterCmdlet,
} from './OutputCmdlets';
import {
  SetVariableCmdlet, GetVariableCmdlet, ClearVariableCmdlet,
  RemoveVariableCmdlet, NewVariableCmdlet,
} from './VariableCmdlets';
import {
  WhereObjectCmdlet, ForEachObjectCmdlet, SelectObjectCmdlet,
  SortObjectCmdlet, MeasureObjectCmdlet, GroupObjectCmdlet,
  GetUniqueCmdlet, TeeObjectCmdlet, CompareObjectCmdlet,
  SelectStringCmdlet, FormatTableCmdlet, FormatListCmdlet,
  FormatWideCmdlet, FormatCustomCmdlet, GetMemberCmdlet,
} from './CollectionCmdlets';
import {
  ConvertToJsonCmdlet, ConvertFromJsonCmdlet,
  ConvertToCsvCmdlet, ConvertFromCsvCmdlet, ExportCsvCmdlet,
} from './ConversionCmdlets';
import {
  GetDateCmdlet, SetDateCmdlet, NewTimespanCmdlet, StartSleepCmdlet,
  GetTimeZoneCmdlet, SetTimeZoneCmdlet,
  MeasureCommandCmdlet,
} from './DateTimeCmdlets';
import {
  SplitPathCmdlet, JoinPathCmdlet, TestPathCmdlet, ResolvePathCmdlet,
  GetChildItemCmdlet, GetContentCmdlet, SetContentCmdlet, AddContentCmdlet,
  NewItemCmdlet, RemoveItemCmdlet, CopyItemCmdlet, MoveItemCmdlet,
  OutFileCmdlet as OutFilePathCmdlet,
  GetItemPropertyCmdlet, SetItemPropertyCmdlet, NewItemPropertyCmdlet, RemoveItemPropertyCmdlet, ClearItemPropertyCmdlet,
  GetItemCmdlet, SetItemCmdlet, GetAclCmdlet, SetAclCmdlet,
  RenameItemCmdlet, MkdirCmdlet, GetFileHashCmdlet, GetAuthenticodeSignatureCmdlet,
} from './PathCmdlets';
import {
  NewObjectCmdlet, GetRandomCmdlet, InvokeExpressionCmdlet,
  ConvertToSecureStringCmdlet, GetHelpCmdlet, GetCommandCmdlet,
  GetModuleCmdlet, ImportModuleCmdlet, ClearHostCmdlet,
  InvokeCommandCmdlet, StartJobCmdlet, GetJobCmdlet, ReceiveJobCmdlet, WaitJobCmdlet,
  SetLocationCmdlet, GetLocationCmdlet, PushLocationCmdlet, PopLocationCmdlet,
  NewPSDriveCmdlet, GetPSDriveCmdlet,
  GetAliasCmdlet, GetPSProviderCmdlet,
} from './MiscCmdlets';
import { AddMemberCmdlet } from './AddMemberCmdlet';
import {
  GetServiceCmdlet, StartServiceCmdlet, StopServiceCmdlet,
  RestartServiceCmdlet, SuspendServiceCmdlet, ResumeServiceCmdlet,
  SetServiceCmdlet, NewServiceCmdlet, RemoveServiceCmdlet,
  RegisterWmiEventCmdlet,
} from './ServiceCmdlets';
import {
  GetProcessCmdlet, StopProcessCmdlet, StartProcessCmdlet,
} from './ProcessCmdlets';
import {
  GetLocalUserCmdlet, NewLocalUserCmdlet, SetLocalUserCmdlet,
  RemoveLocalUserCmdlet, EnableLocalUserCmdlet, DisableLocalUserCmdlet,
  RenameLocalUserCmdlet,
  GetLocalGroupCmdlet, NewLocalGroupCmdlet, RemoveLocalGroupCmdlet,
  AddLocalGroupMemberCmdlet, RemoveLocalGroupMemberCmdlet,
  GetLocalGroupMemberCmdlet, RenameLocalGroupCmdlet,
} from './UserCmdlets';
import {
  GetNetAdapterCmdlet, GetNetIPAddressCmdlet, GetNetIPInterfaceCmdlet, GetNetNeighborCmdlet,
  NewNetNeighborCmdlet, RemoveNetNeighborCmdlet, SetNetNeighborCmdlet,
  TestConnectionCmdlet, ResolveDnsNameCmdlet, InvokeWebRequestCmdlet,
  GetNetIPConfigurationCmdlet, GetNetRouteCmdlet,
  GetNetTCPConnectionCmdlet, GetNetUDPEndpointCmdlet, HostnameCmdlet, WhoamiCmdlet,
  NewNetIPAddressCmdlet, RemoveNetIPAddressCmdlet,
  NewNetRouteCmdlet, RemoveNetRouteCmdlet,
  EnableNetAdapterCmdlet, DisableNetAdapterCmdlet, RenameNetAdapterCmdlet,
  GetDnsClientServerAddressCmdlet, SetDnsClientServerAddressCmdlet,
  GetDnsClientCacheCmdlet, ClearDnsClientCacheCmdlet,
  GetNetFirewallRuleCmdlet, NewNetFirewallRuleCmdlet,
  SetNetFirewallRuleCmdlet, RemoveNetFirewallRuleCmdlet,
  EnableNetFirewallRuleCmdlet, DisableNetFirewallRuleCmdlet,
  GetNetConnectionProfileCmdlet, SetNetConnectionProfileCmdlet,
  SetNetIPAddressCmdlet, SetNetRouteCmdlet,
  RestartNetAdapterCmdlet, TestNetConnectionCmdlet,
  ClearNetNeighborCacheCmdlet, GetNetAdapterStatisticsCmdlet,
} from './NetworkCmdlets';
import { SendMailMessageCmdlet } from './MailMessageCmdlets';
import {
  AddVpnConnectionCmdlet, GetVpnConnectionCmdlet,
  SetVpnConnectionCmdlet, RemoveVpnConnectionCmdlet,
  AddVpnConnectionRouteCmdlet, ConnectVpnConnectionCmdlet, DisconnectVpnConnectionCmdlet,
} from './VpnCmdlets';
import {
  GetEventLogCmdlet, WriteEventLogCmdlet, ClearEventLogCmdlet,
  NewEventLogCmdlet, LimitEventLogCmdlet, GetWinEventCmdlet,
} from './EventLogCmdlets';
import {
  IpconfigCmdlet, NetshCmdlet, ArpCmdlet, RouteCmdlet,
  GetmacCmdlet, SysteminfoCmdlet, VerCmdlet, NslookupCmdlet,
  NetCmdlet, VolCmdlet, ChcpCmdlet, ScCmdlet, ScExeCmdlet,
} from './NativeShimCmdlets';
import {
  GetScheduledTaskCmdlet, RegisterScheduledTaskCmdlet,
  UnregisterScheduledTaskCmdlet, NewScheduledTaskTriggerCmdlet,
  GetScheduledTaskInfoCmdlet, StartScheduledTaskCmdlet, StopScheduledTaskCmdlet,
  EnableScheduledTaskCmdlet, DisableScheduledTaskCmdlet, SetScheduledTaskCmdlet,
  NewScheduledTaskActionCmdlet, NewScheduledTaskPrincipalCmdlet, GetDiskCmdlet, GetVolumeCmdlet,
  GetCimInstanceCmdlet, GetCounterCmdlet,
} from './SystemMgmtCmdlets';
import {
  EnablePSRemotingCmdlet, TestWSManCmdlet, GetWSManCredSSPCmdlet,
} from './RemotingCmdlets';
import {
  GetWindowsFeatureCmdlet, InstallWindowsFeatureCmdlet, UninstallWindowsFeatureCmdlet,
} from './ServerManagerCmdlets';
import {
  GetSmbShareCmdlet, NewSmbShareCmdlet, RemoveSmbShareCmdlet, GetSmbSessionCmdlet,
} from './SmbCmdlets';
import {
  InstallADDSForestCmdlet, InstallADDSDomainControllerCmdlet, GetADDomainControllerCmdlet, RemoveADDomainControllerCmdlet,
  NewADUserCmdlet, GetADUserCmdlet, SetADUserCmdlet, RemoveADUserCmdlet, SetADAccountPasswordCmdlet,
  DisableADAccountCmdlet, EnableADAccountCmdlet,
  NewADGroupCmdlet, GetADGroupCmdlet, RemoveADGroupCmdlet, AddADGroupMemberCmdlet, RemoveADGroupMemberCmdlet, GetADGroupMemberCmdlet,
  GetADComputerCmdlet, SetADComputerCmdlet, GetADObjectCmdlet, SetADObjectCmdlet, RestoreADObjectCmdlet,
  GetADOptionalFeatureCmdlet, EnableADOptionalFeatureCmdlet, GetADRootDSECmdlet, SearchADAccountCmdlet,
  AddKdsRootKeyCmdlet, GetKdsRootKeyCmdlet, NewADServiceAccountCmdlet, GetADServiceAccountCmdlet,
  SetADServiceAccountCmdlet, AddADComputerServiceAccountCmdlet,
  NewADOrganizationalUnitCmdlet, GetADOrganizationalUnitCmdlet,
  NewADReplicationSiteCmdlet, SetADReplicationSiteCmdlet, GetADReplicationSiteCmdlet,
  NewADReplicationSubnetCmdlet, GetADReplicationSubnetCmdlet,
  NewADReplicationSiteLinkCmdlet, GetADReplicationSiteLinkCmdlet, SetADReplicationSiteLinkCmdlet,
  MoveADDirectoryServerCmdlet, GetADReplicationUpToDatenessVectorTableCmdlet,
  GetADReplicationConnectionCmdlet, GetADReplicationFailureCmdlet,
  GetADDefaultDomainPasswordPolicyCmdlet, SetADDefaultDomainPasswordPolicyCmdlet,
  NewADFineGrainedPasswordPolicyCmdlet, AddADFineGrainedPasswordPolicySubjectCmdlet,
  GetADFineGrainedPasswordPolicyCmdlet, GetADFineGrainedPasswordPolicySubjectCmdlet,
  GetADUserResultantPasswordPolicyCmdlet,
  NewADAttributeCmdlet, NewADObjectClassCmdlet,
  NewADDomainCmdlet, GetADForestCmdlet, GetADDomainCmdlet, MoveADDirectoryServerOperationMasterRoleCmdlet,
  NewADTrustCmdlet, GetADTrustCmdlet,
} from './ActiveDirectoryCmdlets';
import {
  InstallAdcsCertificationAuthorityCmdlet, GetCATemplateCmdlet, AddCATemplateCmdlet, GetCertificateCmdlet,
} from './AdcsCmdlets';
import { AddComputerCmdlet, RemoveComputerCmdlet, RenameComputerCmdlet, TestComputerSecureChannelCmdlet, InstallADServiceAccountCmdlet, TestADServiceAccountCmdlet } from './ComputerCmdlets';
import {
  AddDnsServerPrimaryZoneCmdlet, GetDnsServerZoneCmdlet, SetDnsServerPrimaryZoneCmdlet,
  AddDnsServerTsigKeyCmdlet, GetDnsServerTsigKeyCmdlet, RemoveDnsServerTsigKeyCmdlet,
  AddDnsServerResourceRecordACmdlet, AddDnsServerResourceRecordAAAACmdlet,
  AddDnsServerResourceRecordCNameCmdlet, AddDnsServerResourceRecordMXCmdlet,
  AddDnsServerResourceRecordPtrCmdlet, AddDnsServerResourceRecordCmdlet,
  RemoveDnsServerResourceRecordCmdlet, GetDnsServerResourceRecordCmdlet,
  SetDnsServerForwarderCmdlet, GetDnsServerForwarderCmdlet,
} from './DnsServerCmdlets';
import {
  AddDhcpServerv4ScopeCmdlet, GetDhcpServerv4ScopeCmdlet, GetDhcpServerv4BindingCmdlet,
  GetDhcpServerv4DnsSettingCmdlet, SetDhcpServerv4DnsSettingCmdlet,
  AddDhcpServerv4ExclusionRangeCmdlet, AddDhcpServerv4ReservationCmdlet,
  SetDhcpServerv4OptionValueCmdlet, GetDhcpServerv4LeaseCmdlet,
  AddDhcpServerInDCCmdlet,
  SetDhcpServerv4ScopeCmdlet,
  RemoveDhcpServerv4ScopeCmdlet,
  GetDhcpServerv4ReservationCmdlet,
  RemoveDhcpServerv4ReservationCmdlet,
  GetDhcpServerv4ExclusionRangeCmdlet,
  RemoveDhcpServerv4ExclusionRangeCmdlet,
  GetDhcpServerv4OptionValueCmdlet,
  RemoveDhcpServerv4OptionValueCmdlet,
  RemoveDhcpServerv4LeaseCmdlet,
  GetDhcpServerv4ScopeStatisticsCmdlet,
  GetDhcpServerv4StatisticsCmdlet,
  GetDhcpServerInDCCmdlet,
  RemoveDhcpServerInDCCmdlet,
  GetDhcpServerSettingCmdlet,
  SetDhcpServerSettingCmdlet,
} from './DhcpServerCmdlets';
import {
  NewNpsRadiusClientCmdlet, GetNpsRadiusClientCmdlet, RemoveNpsRadiusClientCmdlet,
  NewNpsNetworkPolicyCmdlet, GetNpsNetworkPolicyCmdlet, RemoveNpsNetworkPolicyCmdlet,
  NewNpsConnectionRequestPolicyCmdlet, GetNpsConnectionRequestPolicyCmdlet, RemoveNpsConnectionRequestPolicyCmdlet,
  SetNpsAccountingConfigurationCmdlet,
} from './NpsCmdlets';
import { NewGPOCmdlet, GetGPOCmdlet, NewGPLinkCmdlet, SetGPLinkCmdlet, SetGPRegistryValueCmdlet, SetGPInheritanceCmdlet, GetGPInheritanceCmdlet } from './GroupPolicyCmdlets';
import {
  NewWebsiteCmdlet, GetWebsiteCmdlet, StartWebsiteCmdlet, StopWebsiteCmdlet, RemoveWebsiteCmdlet,
  NewWebBindingCmdlet,
  NewWebAppPoolCmdlet, GetIISAppPoolCmdlet, RemoveWebAppPoolCmdlet, StartWebAppPoolCmdlet, StopWebAppPoolCmdlet,
  RestartWebAppPoolCmdlet, GetWebGlobalModuleCmdlet,
} from './WebAdminCmdlets';
import { NewSelfSignedCertificateCmdlet } from './PkiCmdlets';
import {
  InstallExchangeServerCmdlet, GetExchangeServerCmdlet,
  EnableMailboxCmdlet, NewMailboxCmdlet, GetMailboxCmdlet, SetMailboxCmdlet,
  GetMailboxStatisticsCmdlet, DisableMailboxCmdlet, RemoveMailboxCmdlet,
  NewDistributionGroupCmdlet, SetDistributionGroupCmdlet, GetDistributionGroupCmdlet,
  AddDistributionGroupMemberCmdlet, GetDistributionGroupMemberCmdlet,
  GetGlobalAddressListCmdlet,
  NewReceiveConnectorCmdlet, GetReceiveConnectorCmdlet, NewSendConnectorCmdlet, GetSendConnectorCmdlet,
  NewTransportRuleCmdlet, GetTransportRuleCmdlet,
  GetQueueCmdlet, RetryQueueCmdlet, SuspendQueueCmdlet, ResumeQueueCmdlet,
  AddMailboxPermissionCmdlet, GetMailboxPermissionCmdlet, AddRecipientPermissionCmdlet, GetRecipientPermissionCmdlet,
  NewJournalRuleCmdlet, GetJournalRuleCmdlet,
  NewDatabaseAvailabilityGroupCmdlet, AddDatabaseAvailabilityGroupServerCmdlet,
  AddMailboxDatabaseCopyCmdlet, UpdateMailboxDatabaseCopyCmdlet, GetMailboxDatabaseCopyStatusCmdlet,
  TestServiceHealthCmdlet, TestMailflowCmdlet,
} from './ExchangeCmdlets';
import {
  NewDfsnRootCmdlet, GetDfsnRootCmdlet, NewDfsnFolderCmdlet, NewDfsnFolderTargetCmdlet,
  GetDfsnFolderCmdlet, GetDfsnFolderTargetCmdlet, SetDfsnFolderTargetCmdlet,
  NewDfsReplicationGroupCmdlet, GetDfsReplicationGroupCmdlet, SyncDfsReplicationGroupCmdlet,
  AddDfsrMemberCmdlet, GetDfsrMemberCmdlet, NewDfsReplicatedFolderCmdlet, AddDfsrConnectionCmdlet,
  SetDfsrMembershipCmdlet, GetDfsrMembershipCmdlet, GetDfsrStateCmdlet,
} from './DfsCmdlets';
import {
  EnableRemoteDesktopCmdlet, DisableRemoteDesktopCmdlet, GetRDUserSessionCmdlet, LogoffRdSessionCmdlet,
} from './RdpCmdlets';
import {
  NewClusterCmdlet, GetClusterNodeCmdlet, GetClusterCmdlet,
  AddClusterFileServerRoleCmdlet, GetClusterGroupCmdlet, MoveClusterGroupCmdlet,
} from './ClusterCmdlets';
import {
  GetWsusUpdateCmdlet, ApproveWsusUpdateCmdlet, SetWUSettingsCmdlet, GetWindowsUpdateCmdlet,
} from './WsusCmdlets';
import { AddPrinterCmdlet, GetPrintJobCmdlet, RemovePrintJobCmdlet } from './PrintCmdlets';

/**
 * Register all core (provider-independent) cmdlets into the given registry.
 * Safe to call multiple times on the same registry (idempotent due to overwrite).
 */
export function registerCoreCmdlets(registry: CmdletRegistry, opts: { includeServerCmdlets?: boolean } = {}): void {
  // ── Output ────────────────────────────────────────────────────────────────
  registry.register(new WriteOutputCmdlet());
  registry.register(new WriteHostCmdlet());
  registry.register(new WriteErrorCmdlet());
  registry.register(new WriteWarningCmdlet());
  registry.register(new WriteVerboseCmdlet());
  registry.register(WriteDebugCmdlet);
  registry.register(WriteProgressCmdlet);
  registry.register(WriteInformationCmdlet);
  registry.register(new OutNullCmdlet());
  registry.register(new OutStringCmdlet());
  registry.register(new OutHostCmdlet());
  registry.register(new OutFilePathCmdlet());
  registry.register(OutPrinterCmdlet);

  // ── Variables ─────────────────────────────────────────────────────────────
  registry.register(new SetVariableCmdlet());
  registry.register(new GetVariableCmdlet());
  registry.register(new ClearVariableCmdlet());
  registry.register(new RemoveVariableCmdlet());
  registry.register(new NewVariableCmdlet());

  // ── Collection / pipeline ─────────────────────────────────────────────────
  registry.register(new WhereObjectCmdlet());
  registry.register(new ForEachObjectCmdlet());
  registry.register(new SelectObjectCmdlet());
  registry.register(new SortObjectCmdlet());
  registry.register(new MeasureObjectCmdlet());
  registry.register(new GroupObjectCmdlet());
  registry.register(new GetUniqueCmdlet());
  registry.register(new TeeObjectCmdlet());
  registry.register(new CompareObjectCmdlet());
  registry.register(new SelectStringCmdlet());
  registry.register(new FormatTableCmdlet());
  registry.register(new FormatListCmdlet());
  registry.register(new FormatWideCmdlet());
  registry.register(new FormatCustomCmdlet());
  registry.register(new GetMemberCmdlet());

  // ── Conversion ────────────────────────────────────────────────────────────
  registry.register(new ConvertToJsonCmdlet());
  registry.register(new ConvertFromJsonCmdlet());
  registry.register(new ConvertToCsvCmdlet());
  registry.register(new ConvertFromCsvCmdlet());
  registry.register(new ExportCsvCmdlet());

  // ── Date/Time ─────────────────────────────────────────────────────────────
  registry.register(new GetDateCmdlet());
  registry.register(new GetTimeZoneCmdlet());
  registry.register(new SetTimeZoneCmdlet());
  registry.register(new SetDateCmdlet());
  registry.register(new NewTimespanCmdlet());
  registry.register(new StartSleepCmdlet());
  registry.register(new MeasureCommandCmdlet());

  // ── Path & IO ─────────────────────────────────────────────────────────────
  registry.register(new SplitPathCmdlet());
  registry.register(new JoinPathCmdlet());
  registry.register(new TestPathCmdlet());
  registry.register(new ResolvePathCmdlet());
  registry.register(new GetChildItemCmdlet());
  registry.register(new GetContentCmdlet());
  registry.register(new SetContentCmdlet());
  registry.register(new AddContentCmdlet());
  registry.register(new NewItemCmdlet());
  registry.register(new RemoveItemCmdlet());
  registry.register(new CopyItemCmdlet());
  registry.register(new MoveItemCmdlet());
  registry.register(new GetItemPropertyCmdlet());
  registry.register(new SetItemPropertyCmdlet());
  registry.register(new NewItemPropertyCmdlet());
  registry.register(new RemoveItemPropertyCmdlet());
  registry.register(new ClearItemPropertyCmdlet());
  registry.register(new GetItemCmdlet());
  registry.register(new SetItemCmdlet());
  registry.register(new GetAclCmdlet());
  registry.register(new SetAclCmdlet());
  registry.register(new RenameItemCmdlet());
  registry.register(new MkdirCmdlet());
  registry.register(new GetFileHashCmdlet());
  registry.register(new GetAuthenticodeSignatureCmdlet());

  // ── Misc ──────────────────────────────────────────────────────────────────
  registry.register(new NewObjectCmdlet());
  registry.register(new AddMemberCmdlet());
  registry.register(new GetRandomCmdlet());
  registry.register(new InvokeExpressionCmdlet());
  registry.register(new ConvertToSecureStringCmdlet());
  registry.register(new GetHelpCmdlet());
  registry.register(new GetCommandCmdlet());
  registry.register(new GetModuleCmdlet());
  registry.register(new ImportModuleCmdlet());
  registry.register(new InvokeCommandCmdlet());
  registry.register(new StartJobCmdlet());
  registry.register(new GetJobCmdlet());
  registry.register(new ReceiveJobCmdlet());
  registry.register(new WaitJobCmdlet());
  registry.register(new SetLocationCmdlet());
  registry.register(new GetLocationCmdlet());
  registry.register(new PushLocationCmdlet());
  registry.register(new PopLocationCmdlet());
  registry.register(new NewPSDriveCmdlet());
  registry.register(new GetPSDriveCmdlet());
  registry.register(new ClearHostCmdlet());
  registry.register(new GetAliasCmdlet());
  registry.register(new GetPSProviderCmdlet());

  // ── Services (provider-backed) ────────────────────────────────────────────
  registry.register(new GetServiceCmdlet());
  registry.register(new StartServiceCmdlet());
  registry.register(new StopServiceCmdlet());
  registry.register(new RestartServiceCmdlet());
  registry.register(new SuspendServiceCmdlet());
  registry.register(new ResumeServiceCmdlet());
  registry.register(new SetServiceCmdlet());
  registry.register(new NewServiceCmdlet());
  registry.register(new RemoveServiceCmdlet());
  registry.register(new RegisterWmiEventCmdlet());

  // ── Processes (provider-backed) ───────────────────────────────────────────
  registry.register(new GetProcessCmdlet());
  registry.register(new StopProcessCmdlet());
  registry.register(new StartProcessCmdlet());

  // ── Local users / groups (provider-backed) ────────────────────────────────
  registry.register(new GetLocalUserCmdlet());
  registry.register(new NewLocalUserCmdlet());
  registry.register(new SetLocalUserCmdlet());
  registry.register(new RemoveLocalUserCmdlet());
  registry.register(new EnableLocalUserCmdlet());
  registry.register(new DisableLocalUserCmdlet());
  registry.register(new RenameLocalUserCmdlet());
  registry.register(new GetLocalGroupCmdlet());
  registry.register(new NewLocalGroupCmdlet());
  registry.register(new RemoveLocalGroupCmdlet());
  registry.register(new AddLocalGroupMemberCmdlet());
  registry.register(new RemoveLocalGroupMemberCmdlet());
  registry.register(new GetLocalGroupMemberCmdlet());
  registry.register(new RenameLocalGroupCmdlet());

  // ── Network (provider-backed, partial — see INetworkProvider) ─────────────
  registry.register(new GetNetAdapterCmdlet());
  registry.register(new GetNetLbfoTeamCmdlet());
  registry.register(new NewNetLbfoTeamCmdlet());
  registry.register(new SetNetLbfoTeamCmdlet());
  registry.register(new RemoveNetLbfoTeamCmdlet());
  registry.register(new GetNetLbfoTeamMemberCmdlet());
  registry.register(new AddNetLbfoTeamMemberCmdlet());
  registry.register(new SetNetLbfoTeamMemberCmdlet());
  registry.register(new RemoveNetLbfoTeamMemberCmdlet());
  registry.register(new GetNetIPAddressCmdlet());
  registry.register(new GetNetIPInterfaceCmdlet());
  registry.register(new TestConnectionCmdlet());
  registry.register(new ResolveDnsNameCmdlet());
  registry.register(new InvokeWebRequestCmdlet());
  registry.register(new GetNetIPConfigurationCmdlet());
  registry.register(new GetNetRouteCmdlet());
  registry.register(new GetNetTCPConnectionCmdlet());
  registry.register(new GetNetUDPEndpointCmdlet());
  registry.register(new GetNetNeighborCmdlet());
  registry.register(new NewNetNeighborCmdlet());
  registry.register(new RemoveNetNeighborCmdlet());
  registry.register(new ClearNetNeighborCacheCmdlet());
  registry.register(new GetNetAdapterStatisticsCmdlet());
  registry.register(new SetNetNeighborCmdlet());
  registry.register(new HostnameCmdlet());
  registry.register(new WhoamiCmdlet());

  // ── Network mutations & profiles (provider-backed) ────────────────────────
  registry.register(new NewNetIPAddressCmdlet());
  registry.register(new RemoveNetIPAddressCmdlet());
  registry.register(new NewNetRouteCmdlet());
  registry.register(new RemoveNetRouteCmdlet());
  registry.register(new EnableNetAdapterCmdlet());
  registry.register(new DisableNetAdapterCmdlet());
  registry.register(new RenameNetAdapterCmdlet());
  registry.register(new GetDnsClientServerAddressCmdlet());
  registry.register(new SetDnsClientServerAddressCmdlet());
  registry.register(new GetDnsClientCacheCmdlet());
  registry.register(new ClearDnsClientCacheCmdlet());
  registry.register(new GetNetFirewallRuleCmdlet());
  registry.register(new NewNetFirewallRuleCmdlet());
  registry.register(new SetNetFirewallRuleCmdlet());
  registry.register(new RemoveNetFirewallRuleCmdlet());
  registry.register(new EnableNetFirewallRuleCmdlet());
  registry.register(new DisableNetFirewallRuleCmdlet());
  registry.register(new GetNetConnectionProfileCmdlet());
  registry.register(new SetNetConnectionProfileCmdlet());
  registry.register(new SetNetIPAddressCmdlet());
  registry.register(new SetNetRouteCmdlet());
  registry.register(new RestartNetAdapterCmdlet());
  registry.register(new TestNetConnectionCmdlet());
  registry.register(new SendMailMessageCmdlet());

  // ── VPN (provider-backed) ─────────────────────────────────────────────────
  registry.register(new AddVpnConnectionCmdlet());
  registry.register(new GetVpnConnectionCmdlet());
  registry.register(new SetVpnConnectionCmdlet());
  registry.register(new RemoveVpnConnectionCmdlet());
  registry.register(new AddVpnConnectionRouteCmdlet());
  registry.register(new ConnectVpnConnectionCmdlet());
  registry.register(new DisconnectVpnConnectionCmdlet());

  // ── Event log (provider-backed) ───────────────────────────────────────────
  registry.register(new GetEventLogCmdlet());
  registry.register(new WriteEventLogCmdlet());
  registry.register(new ClearEventLogCmdlet());
  registry.register(new NewEventLogCmdlet());
  registry.register(new LimitEventLogCmdlet());
  registry.register(new GetWinEventCmdlet());

  // ── Scheduled tasks / disks / CIM (provider-backed) ───────────────────────
  registry.register(new GetScheduledTaskCmdlet());
  registry.register(new RegisterScheduledTaskCmdlet());
  registry.register(new UnregisterScheduledTaskCmdlet());
  registry.register(new GetScheduledTaskInfoCmdlet());
  registry.register(new StartScheduledTaskCmdlet());
  registry.register(new StopScheduledTaskCmdlet());
  registry.register(new EnableScheduledTaskCmdlet());
  registry.register(new DisableScheduledTaskCmdlet());
  registry.register(new SetScheduledTaskCmdlet());
  registry.register(new NewScheduledTaskTriggerCmdlet());
  registry.register(new NewScheduledTaskActionCmdlet());
  registry.register(new NewScheduledTaskPrincipalCmdlet());
  registry.register(new GetDiskCmdlet());
  registry.register(new GetVolumeCmdlet());
  registry.register(new GetCimInstanceCmdlet());
  registry.register(new GetCounterCmdlet());

  // ── PowerShell Remoting (provider-backed) ─────────────────────────────────
  registry.register(new EnablePSRemotingCmdlet());
  registry.register(new TestWSManCmdlet());
  registry.register(new GetWSManCredSSPCmdlet());

  // ── SMB file sharing (available on client and server editions) ───────────
  registry.register(new GetSmbShareCmdlet());
  registry.register(new NewSmbShareCmdlet());
  registry.register(new RemoveSmbShareCmdlet());
  registry.register(new GetSmbSessionCmdlet());

  // ── Client-side PKI (Get-Certificate enrollment, self-signed certs) ──────
  registry.register(new GetCertificateCmdlet());
  registry.register(new NewSelfSignedCertificateCmdlet());

  // ── Domain join (a workstation joins a domain with Add-Computer) ─────────
  registry.register(new AddComputerCmdlet());
  registry.register(new RemoveComputerCmdlet());
  registry.register(new RenameComputerCmdlet());
  registry.register(new TestComputerSecureChannelCmdlet());
  registry.register(new InstallADServiceAccountCmdlet());
  registry.register(new TestADServiceAccountCmdlet());
  // Real Get-ADDomainController: `-Discover` is a client-side DC-locator
  // dial (works from any domain-joined machine, RSAT-only in real Windows,
  // simplified here to "any domain-joined machine"), while the plain
  // `-Filter`/no-argument form still requires this machine to itself be a
  // DC (gated inside the cmdlet via `requireAd`) — so it's safe to register
  // for every Windows device, not just servers.
  registry.register(new GetADDomainControllerCmdlet());

  // ── Remote Desktop toggle + Windows Update client settings ───────────────
  registry.register(new EnableRemoteDesktopCmdlet());
  registry.register(new DisableRemoteDesktopCmdlet());
  registry.register(new SetWUSettingsCmdlet());
  registry.register(new GetWindowsUpdateCmdlet());

  // ── Printing (client-available) ──────────────────────────────────────────
  registry.register(new AddPrinterCmdlet());
  registry.register(new GetPrintJobCmdlet());
  registry.register(new RemovePrintJobCmdlet());

  // ── Native CLI shims (sync subset) ────────────────────────────────────────
  // ping / tracert stay in the legacy executor — they're async and the
  // PSRuntime tree-walker is sync.
  registry.register(IpconfigCmdlet);
  registry.register(NetshCmdlet);
  registry.register(ArpCmdlet);
  registry.register(RouteCmdlet);
  registry.register(GetmacCmdlet);
  registry.register(SysteminfoCmdlet);
  registry.register(VerCmdlet);
  registry.register(NslookupCmdlet);
  registry.register(NetCmdlet);
  registry.register(VolCmdlet);
  registry.register(ChcpCmdlet);
  registry.register(ScCmdlet);
  registry.register(ScExeCmdlet);

  if (opts.includeServerCmdlets ?? true) registerServerCmdlets(registry);
}

/**
 * Windows Server-only roles and RSAT tooling. Registered on top of the core
 * set for Server editions; a workstation's Get-Command must not list these.
 */
export function registerServerCmdlets(registry: CmdletRegistry): void {
  // ── Server Manager roles/features ─────────────────────────────────────────
  registry.register(new GetWindowsFeatureCmdlet());
  registry.register(new InstallWindowsFeatureCmdlet());
  registry.register(new UninstallWindowsFeatureCmdlet());

  // ── AD DS (PRD-Windows-Server.md §5 P5) ─────────────────────────────────────
  registry.register(new InstallADDSForestCmdlet());
  registry.register(new InstallADDSDomainControllerCmdlet());
  // Get-ADDomainController is registered in the common section above (its
  // -Discover form must work from a plain domain-joined client).
  registry.register(new RemoveADDomainControllerCmdlet());
  registry.register(new NewADReplicationSiteCmdlet());
  registry.register(new SetADReplicationSiteCmdlet());
  registry.register(new GetADReplicationSiteCmdlet());
  registry.register(new NewADReplicationSubnetCmdlet());
  registry.register(new GetADReplicationSubnetCmdlet());
  registry.register(new NewADReplicationSiteLinkCmdlet());
  registry.register(new GetADReplicationSiteLinkCmdlet());
  registry.register(new SetADReplicationSiteLinkCmdlet());
  registry.register(new MoveADDirectoryServerCmdlet());
  registry.register(new GetADReplicationUpToDatenessVectorTableCmdlet());
  registry.register(new GetADReplicationConnectionCmdlet());
  registry.register(new GetADReplicationFailureCmdlet());
  registry.register(new GetADDefaultDomainPasswordPolicyCmdlet());
  registry.register(new SetADDefaultDomainPasswordPolicyCmdlet());
  registry.register(new NewADFineGrainedPasswordPolicyCmdlet());
  registry.register(new AddADFineGrainedPasswordPolicySubjectCmdlet());
  registry.register(new GetADFineGrainedPasswordPolicyCmdlet());
  registry.register(new GetADFineGrainedPasswordPolicySubjectCmdlet());
  registry.register(new GetADUserResultantPasswordPolicyCmdlet());
  registry.register(new NewADAttributeCmdlet());
  registry.register(new NewADObjectClassCmdlet());
  registry.register(new NewADUserCmdlet());
  registry.register(new GetADUserCmdlet());
  registry.register(new SetADUserCmdlet());
  registry.register(new SetADAccountPasswordCmdlet());
  registry.register(new RemoveADUserCmdlet());
  registry.register(new DisableADAccountCmdlet());
  registry.register(new EnableADAccountCmdlet());
  registry.register(new NewADGroupCmdlet());
  registry.register(new GetADGroupCmdlet());
  registry.register(new RemoveADGroupCmdlet());
  registry.register(new AddADGroupMemberCmdlet());
  registry.register(new RemoveADGroupMemberCmdlet());
  registry.register(new GetADGroupMemberCmdlet());
  registry.register(new GetADComputerCmdlet());
  registry.register(new SetADComputerCmdlet());
  registry.register(new GetADObjectCmdlet());
  registry.register(new SetADObjectCmdlet());
  registry.register(new RestoreADObjectCmdlet());
  registry.register(new GetADOptionalFeatureCmdlet());
  registry.register(new EnableADOptionalFeatureCmdlet());
  registry.register(new GetADRootDSECmdlet());
  registry.register(new AddKdsRootKeyCmdlet());
  registry.register(new GetKdsRootKeyCmdlet());
  registry.register(new NewADServiceAccountCmdlet());
  registry.register(new GetADServiceAccountCmdlet());
  registry.register(new SetADServiceAccountCmdlet());
  registry.register(new AddADComputerServiceAccountCmdlet());
  registry.register(new SearchADAccountCmdlet());
  registry.register(new NewADOrganizationalUnitCmdlet());
  registry.register(new GetADOrganizationalUnitCmdlet());
  registry.register(new NewADDomainCmdlet());
  registry.register(new GetADForestCmdlet());
  registry.register(new GetADDomainCmdlet());
  registry.register(new MoveADDirectoryServerOperationMasterRoleCmdlet());
  registry.register(new NewADTrustCmdlet());
  registry.register(new GetADTrustCmdlet());

  // ── Exchange Server (docs/PRD-Exchange.md §2.1 P1/P2) ───────────────────────
  registry.register(new InstallExchangeServerCmdlet());
  registry.register(new GetExchangeServerCmdlet());
  registry.register(new EnableMailboxCmdlet());
  registry.register(new NewMailboxCmdlet());
  registry.register(new GetMailboxCmdlet());
  registry.register(new SetMailboxCmdlet());
  registry.register(new GetMailboxStatisticsCmdlet());
  registry.register(new DisableMailboxCmdlet());
  registry.register(new RemoveMailboxCmdlet());
  registry.register(new NewDistributionGroupCmdlet());
  registry.register(new SetDistributionGroupCmdlet());
  registry.register(new GetDistributionGroupCmdlet());
  registry.register(new AddDistributionGroupMemberCmdlet());
  registry.register(new GetDistributionGroupMemberCmdlet());
  registry.register(new GetGlobalAddressListCmdlet());
  registry.register(new NewReceiveConnectorCmdlet());
  registry.register(new GetReceiveConnectorCmdlet());
  registry.register(new NewSendConnectorCmdlet());
  registry.register(new GetSendConnectorCmdlet());
  registry.register(new NewTransportRuleCmdlet());
  registry.register(new GetTransportRuleCmdlet());
  registry.register(new GetQueueCmdlet());
  registry.register(new RetryQueueCmdlet());
  registry.register(new SuspendQueueCmdlet());
  registry.register(new ResumeQueueCmdlet());
  registry.register(new AddMailboxPermissionCmdlet());
  registry.register(new GetMailboxPermissionCmdlet());
  registry.register(new AddRecipientPermissionCmdlet());
  registry.register(new GetRecipientPermissionCmdlet());
  registry.register(new NewJournalRuleCmdlet());
  registry.register(new GetJournalRuleCmdlet());
  registry.register(new NewDatabaseAvailabilityGroupCmdlet());
  registry.register(new AddDatabaseAvailabilityGroupServerCmdlet());
  registry.register(new AddMailboxDatabaseCopyCmdlet());
  registry.register(new UpdateMailboxDatabaseCopyCmdlet());
  registry.register(new GetMailboxDatabaseCopyStatusCmdlet());
  registry.register(new TestServiceHealthCmdlet());
  registry.register(new TestMailflowCmdlet());

  // ── AD CS (PRD-Windows-Server-Advanced.md §5 P13) ───────────────────────────
  registry.register(new InstallAdcsCertificationAuthorityCmdlet());
  registry.register(new GetCATemplateCmdlet());
  registry.register(new AddCATemplateCmdlet());

  // ── DNS Server role (PRD-Windows-Server.md §5 P7) ───────────────────────────
  registry.register(new AddDnsServerPrimaryZoneCmdlet());
  registry.register(new SetDnsServerPrimaryZoneCmdlet());
  registry.register(new AddDnsServerTsigKeyCmdlet());
  registry.register(new GetDnsServerTsigKeyCmdlet());
  registry.register(new RemoveDnsServerTsigKeyCmdlet());
  registry.register(new GetDnsServerZoneCmdlet());
  registry.register(new AddDnsServerResourceRecordACmdlet());
  registry.register(new AddDnsServerResourceRecordAAAACmdlet());
  registry.register(new AddDnsServerResourceRecordCNameCmdlet());
  registry.register(new AddDnsServerResourceRecordMXCmdlet());
  registry.register(new AddDnsServerResourceRecordPtrCmdlet());
  registry.register(new AddDnsServerResourceRecordCmdlet());
  registry.register(new RemoveDnsServerResourceRecordCmdlet());
  registry.register(new GetDnsServerResourceRecordCmdlet());
  registry.register(new SetDnsServerForwarderCmdlet());
  registry.register(new GetDnsServerForwarderCmdlet());

  // ── DHCP Server role (PRD-Windows-Server.md §5 P8) ──────────────────────────
  registry.register(new AddDhcpServerv4ScopeCmdlet());
  registry.register(new GetDhcpServerv4ScopeCmdlet());
  registry.register(new GetDhcpServerv4BindingCmdlet());
  registry.register(new GetDhcpServerv4DnsSettingCmdlet());
  registry.register(new SetDhcpServerv4DnsSettingCmdlet());
  registry.register(new AddDhcpServerv4ExclusionRangeCmdlet());
  registry.register(new AddDhcpServerv4ReservationCmdlet());
  registry.register(new SetDhcpServerv4OptionValueCmdlet());
  registry.register(new GetDhcpServerv4LeaseCmdlet());
  registry.register(new AddDhcpServerInDCCmdlet());
  registry.register(new SetDhcpServerv4ScopeCmdlet());
  registry.register(new RemoveDhcpServerv4ScopeCmdlet());
  registry.register(new GetDhcpServerv4ReservationCmdlet());
  registry.register(new RemoveDhcpServerv4ReservationCmdlet());
  registry.register(new GetDhcpServerv4ExclusionRangeCmdlet());
  registry.register(new RemoveDhcpServerv4ExclusionRangeCmdlet());
  registry.register(new GetDhcpServerv4OptionValueCmdlet());
  registry.register(new RemoveDhcpServerv4OptionValueCmdlet());
  registry.register(new RemoveDhcpServerv4LeaseCmdlet());
  registry.register(new GetDhcpServerv4ScopeStatisticsCmdlet());
  registry.register(new GetDhcpServerv4StatisticsCmdlet());
  registry.register(new GetDhcpServerInDCCmdlet());
  registry.register(new RemoveDhcpServerInDCCmdlet());
  registry.register(new GetDhcpServerSettingCmdlet());
  registry.register(new SetDhcpServerSettingCmdlet());

  // ── NPS (RADIUS) role (PRD-Windows-Server.md §5 P9 + Advanced P22) ──────────
  registry.register(new NewNpsRadiusClientCmdlet());
  registry.register(new GetNpsRadiusClientCmdlet());
  registry.register(new RemoveNpsRadiusClientCmdlet());
  registry.register(new NewNpsNetworkPolicyCmdlet());
  registry.register(new GetNpsNetworkPolicyCmdlet());
  registry.register(new RemoveNpsNetworkPolicyCmdlet());
  registry.register(new NewNpsConnectionRequestPolicyCmdlet());
  registry.register(new GetNpsConnectionRequestPolicyCmdlet());
  registry.register(new RemoveNpsConnectionRequestPolicyCmdlet());
  registry.register(new SetNpsAccountingConfigurationCmdlet());

  // ── Group Policy (PRD-Windows-Server.md §5 P10) ─────────────────────────────
  registry.register(new NewGPOCmdlet());
  registry.register(new GetGPOCmdlet());
  registry.register(new NewGPLinkCmdlet());
  registry.register(new SetGPLinkCmdlet());
  registry.register(new SetGPRegistryValueCmdlet());
  registry.register(new SetGPInheritanceCmdlet());
  registry.register(new GetGPInheritanceCmdlet());

  // ── Web Server / IIS role (PRD-Windows-Server.md §5 P11) ────────────────────
  registry.register(new NewWebsiteCmdlet());
  registry.register(new GetWebsiteCmdlet());
  registry.register(new StartWebsiteCmdlet());
  registry.register(new StopWebsiteCmdlet());
  registry.register(new RemoveWebsiteCmdlet());
  registry.register(new NewWebBindingCmdlet());
  registry.register(new NewWebAppPoolCmdlet());
  registry.register(new GetIISAppPoolCmdlet());
  registry.register(new RemoveWebAppPoolCmdlet());
  registry.register(new StartWebAppPoolCmdlet());
  registry.register(new StopWebAppPoolCmdlet());
  registry.register(new RestartWebAppPoolCmdlet());
  registry.register(new GetWebGlobalModuleCmdlet());

  // ── DFS Namespaces + DFSR (PRD-Windows-Server-Advanced.md §5 P16) ──────────
  registry.register(new NewDfsnRootCmdlet());
  registry.register(new GetDfsnRootCmdlet());
  registry.register(new NewDfsnFolderCmdlet());
  registry.register(new NewDfsnFolderTargetCmdlet());
  registry.register(new GetDfsnFolderCmdlet());
  registry.register(new GetDfsnFolderTargetCmdlet());
  registry.register(new SetDfsnFolderTargetCmdlet());
  registry.register(new NewDfsReplicationGroupCmdlet());
  registry.register(new GetDfsReplicationGroupCmdlet());
  registry.register(new SyncDfsReplicationGroupCmdlet());
  registry.register(new AddDfsrMemberCmdlet());
  registry.register(new GetDfsrMemberCmdlet());
  registry.register(new NewDfsReplicatedFolderCmdlet());
  registry.register(new AddDfsrConnectionCmdlet());
  registry.register(new SetDfsrMembershipCmdlet());
  registry.register(new GetDfsrMembershipCmdlet());
  registry.register(new GetDfsrStateCmdlet());

  // ── RDS session management (PRD-Windows-Server-Advanced.md §5 P17) ─────────
  registry.register(new GetRDUserSessionCmdlet());
  registry.register(new LogoffRdSessionCmdlet());

  // ── Failover Clustering / WSFC (PRD-Windows-Server-Advanced.md §5 P18) ─────
  registry.register(new NewClusterCmdlet());
  registry.register(new GetClusterNodeCmdlet());
  registry.register(new GetClusterCmdlet());
  registry.register(new AddClusterFileServerRoleCmdlet());
  registry.register(new GetClusterGroupCmdlet());
  registry.register(new MoveClusterGroupCmdlet());

  // ── WSUS (PRD-Windows-Server-Advanced.md §5 P19) ────────────────────────────
  registry.register(new GetWsusUpdateCmdlet());
  registry.register(new ApproveWsusUpdateCmdlet());
}
