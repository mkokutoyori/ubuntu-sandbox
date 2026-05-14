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
  GetItemPropertyCmdlet, SetItemPropertyCmdlet, RemoveItemPropertyCmdlet,
} from './PathCmdlets';
import {
  NewObjectCmdlet, GetRandomCmdlet, InvokeExpressionCmdlet,
  ConvertToSecureStringCmdlet, GetHelpCmdlet, GetCommandCmdlet,
  GetModuleCmdlet, ImportModuleCmdlet, ClearHostCmdlet,
  InvokeCommandCmdlet, StartJobCmdlet, ReceiveJobCmdlet, WaitJobCmdlet,
  SetLocationCmdlet, NewPSDriveCmdlet, GetPSDriveCmdlet,
} from './MiscCmdlets';
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
  GetLocalGroupMemberCmdlet,
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
} from './NetworkCmdlets';

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

  // ── Misc ──────────────────────────────────────────────────────────────────
  registry.register(new NewObjectCmdlet());
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
  registry.register(new NewPSDriveCmdlet());
  registry.register(new GetPSDriveCmdlet());
  registry.register(new ClearHostCmdlet());

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
}
