/**
 * Core cmdlet barrel — registers all built-in cmdlets that work without
 * any Windows system providers. Called by PSInterpreter and PowerShellExecutor.
 */

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
  ConvertToCsvCmdlet, ConvertFromCsvCmdlet,
} from './ConversionCmdlets';
import {
  GetDateCmdlet, SetDateCmdlet, NewTimespanCmdlet, StartSleepCmdlet,
} from './DateTimeCmdlets';
import {
  SplitPathCmdlet, JoinPathCmdlet, TestPathCmdlet, ResolvePathCmdlet,
  GetChildItemCmdlet, GetContentCmdlet, SetContentCmdlet, AddContentCmdlet,
  NewItemCmdlet, RemoveItemCmdlet, CopyItemCmdlet, MoveItemCmdlet,
  OutFileCmdlet as OutFilePathCmdlet,
  GetItemPropertyCmdlet, SetItemPropertyCmdlet, RemoveItemPropertyCmdlet, ClearItemPropertyCmdlet,
  GetItemCmdlet, SetItemCmdlet, GetAclCmdlet, SetAclCmdlet,
  RenameItemCmdlet, MkdirCmdlet,
} from './PathCmdlets';
import {
  NewObjectCmdlet, GetRandomCmdlet, InvokeExpressionCmdlet,
  ConvertToSecureStringCmdlet, GetHelpCmdlet, GetCommandCmdlet,
  GetModuleCmdlet, ImportModuleCmdlet, ClearHostCmdlet,
  InvokeCommandCmdlet, StartJobCmdlet, ReceiveJobCmdlet, WaitJobCmdlet,
  SetLocationCmdlet, GetLocationCmdlet, PushLocationCmdlet, PopLocationCmdlet,
  NewPSDriveCmdlet, GetPSDriveCmdlet,
  GetAliasCmdlet, GetPSProviderCmdlet,
} from './MiscCmdlets';
import { AddMemberCmdlet } from './AddMemberCmdlet';
import {
  GetServiceCmdlet, StartServiceCmdlet, StopServiceCmdlet,
  RestartServiceCmdlet, SuspendServiceCmdlet, ResumeServiceCmdlet,
  SetServiceCmdlet, NewServiceCmdlet, RemoveServiceCmdlet,
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
  GetNetAdapterCmdlet, GetNetIPAddressCmdlet,
  TestConnectionCmdlet, ResolveDnsNameCmdlet,
  GetNetIPConfigurationCmdlet, GetNetRouteCmdlet,
  GetNetTCPConnectionCmdlet, HostnameCmdlet, WhoamiCmdlet,
  NewNetIPAddressCmdlet, RemoveNetIPAddressCmdlet,
  NewNetRouteCmdlet, RemoveNetRouteCmdlet,
  EnableNetAdapterCmdlet, DisableNetAdapterCmdlet, RenameNetAdapterCmdlet,
  GetDnsClientServerAddressCmdlet, SetDnsClientServerAddressCmdlet,
  ClearDnsClientCacheCmdlet,
  GetNetFirewallRuleCmdlet, NewNetFirewallRuleCmdlet,
  SetNetFirewallRuleCmdlet, RemoveNetFirewallRuleCmdlet,
  EnableNetFirewallRuleCmdlet, DisableNetFirewallRuleCmdlet,
  GetNetConnectionProfileCmdlet, SetNetConnectionProfileCmdlet,
  SetNetIPAddressCmdlet, SetNetRouteCmdlet,
  RestartNetAdapterCmdlet, TestNetConnectionCmdlet,
} from './NetworkCmdlets';
import {
  AddVpnConnectionCmdlet, GetVpnConnectionCmdlet,
  SetVpnConnectionCmdlet, RemoveVpnConnectionCmdlet,
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
  NewScheduledTaskActionCmdlet, GetDiskCmdlet, GetVolumeCmdlet,
  GetCimInstanceCmdlet,
} from './SystemMgmtCmdlets';

/**
 * Register all core (provider-independent) cmdlets into the given registry.
 * Safe to call multiple times on the same registry (idempotent due to overwrite).
 */
export function registerCoreCmdlets(registry: CmdletRegistry): void {
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

  // ── Date/Time ─────────────────────────────────────────────────────────────
  registry.register(new GetDateCmdlet());
  registry.register(new SetDateCmdlet());
  registry.register(new NewTimespanCmdlet());
  registry.register(new StartSleepCmdlet());

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
  registry.register(new RemoveItemPropertyCmdlet());
  registry.register(new ClearItemPropertyCmdlet());
  registry.register(new GetItemCmdlet());
  registry.register(new SetItemCmdlet());
  registry.register(new GetAclCmdlet());
  registry.register(new SetAclCmdlet());
  registry.register(new RenameItemCmdlet());
  registry.register(new MkdirCmdlet());

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
  registry.register(new GetNetIPAddressCmdlet());
  registry.register(new TestConnectionCmdlet());
  registry.register(new ResolveDnsNameCmdlet());
  registry.register(new GetNetIPConfigurationCmdlet());
  registry.register(new GetNetRouteCmdlet());
  registry.register(new GetNetTCPConnectionCmdlet());
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

  // ── VPN (provider-backed) ─────────────────────────────────────────────────
  registry.register(new AddVpnConnectionCmdlet());
  registry.register(new GetVpnConnectionCmdlet());
  registry.register(new SetVpnConnectionCmdlet());
  registry.register(new RemoveVpnConnectionCmdlet());

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
  registry.register(new NewScheduledTaskTriggerCmdlet());
  registry.register(new NewScheduledTaskActionCmdlet());
  registry.register(new GetDiskCmdlet());
  registry.register(new GetVolumeCmdlet());
  registry.register(new GetCimInstanceCmdlet());

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
}
