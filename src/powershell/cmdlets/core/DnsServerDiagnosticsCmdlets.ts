import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { DnsDiagnosticsChanges, DnsDiagnosticsEntry, DnsDiagnosticsValue } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { failed, isSwitchOn, requireDns, stringList } from './DnsServerCmdlets';

const PARAMETER_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ['Answers', 'Answers'],
  ['EventLogLevel', 'EventLogLevel'],
  ['FullPackets', 'FullPackets'],
  ['IPFilterList', 'FilterIPAddressList'],
  ['LogFilePath', 'LogFilePath'],
  ['MaxMBFileSize', 'MaxMBFileSize'],
  ['EnableLoggingForRemoteServerEvent', 'EnableLoggingForRemoteServerEvent'],
  ['EnableLoggingForPluginDllEvent', 'EnableLoggingForPluginDllEvent'],
  ['UseSystemEventLog', 'UseSystemEventLog'],
  ['EnableLogFileRollover', 'EnableLogFileRollover'],
  ['EnableLoggingForZoneLoadingEvent', 'EnableLoggingForZoneLoadingEvent'],
  ['EnableLoggingForLocalLookupEvent', 'EnableLoggingForLocalLookupEvent'],
  ['EnableLoggingToFile', 'EnableLoggingToFile'],
  ['EnableLoggingForZoneDataWriteEvent', 'EnableLoggingForZoneDataWriteEvent'],
  ['EnableLoggingForTombstoneEvent', 'EnableLoggingForTombstoneEvent'],
  ['EnableLoggingForRecursiveLookupEvent', 'EnableLoggingForRecursiveLookupEvent'],
  ['UdpPackets', 'UdpPackets'],
  ['UnmatchedResponse', 'UnmatchedResponse'],
  ['Updates', 'Update'],
  ['WriteThrough', 'WriteThrough'],
  ['SaveLogsToPersistentStorage', 'SaveLogsToPersistentStorage'],
  ['EnableLoggingForServerStartStopEvent', 'EnableLoggingForServerStartStopEvent'],
  ['Notifications', 'Notifications'],
  ['Queries', 'Queries'],
  ['QuestionTransactions', 'QuestionTransactions'],
  ['ReceivePackets', 'ReceivePackets'],
  ['SendPackets', 'SendPackets'],
  ['TcpPackets', 'TcpPackets'],
];

const LEVEL_PARAMETERS: ReadonlyArray<readonly [string, 'LogLevel' | 'OperationsLogLevel' | 'OperationsLogLevel2']> = [
  ['DebugLogging', 'LogLevel'],
  ['OperationLogLevel1', 'OperationsLogLevel'],
  ['OperationLogLevel2', 'OperationsLogLevel2'],
];

const UINT32_MAXIMUM = 0xFFFFFFFF;

function propertyOf(entry: DnsDiagnosticsEntry): PSValue {
  if (!Array.isArray(entry.value)) return entry.value as PSValue;
  return entry.value.length === 0 ? null : [...entry.value];
}

function diagnosticsObject(entries: readonly DnsDiagnosticsEntry[]): Record<string, PSValue> {
  const out: Record<string, PSValue> = {};
  for (const entry of entries) out[entry.property] = propertyOf(entry);
  return out;
}

function unsignedParameter(ctx: CmdletContext, parameter: string, raw: PSValue): number | null {
  const text = psValueToString(raw).trim();
  const number = /^0x[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : Number(text);
  const reason = !Number.isInteger(number) ? 'Input string was not in a correct format.'
    : number < 0 || number > UINT32_MAXIMUM ? 'Value was either too large or too small for a UInt32.' : null;
  if (reason === null) return number;
  ctx.emitError(`Set-DnsServerDiagnostics : Cannot bind parameter '${parameter}'. Cannot convert value "${psValueToString(raw)}" to type "System.UInt32". Error: "${reason}"`);
  return null;
}

function valueOf(ctx: CmdletContext, parameter: string, entry: DnsDiagnosticsEntry, raw: PSValue): DnsDiagnosticsValue | null {
  switch (entry.kind) {
    case 'flag': return isSwitchOn(raw);
    case 'count': return unsignedParameter(ctx, parameter, raw);
    case 'text': return psValueToString(raw);
    case 'addresses': return stringList(raw);
  }
}

function levelChanges(ctx: CmdletContext): DnsDiagnosticsChanges['words'] | null {
  const words: Partial<Record<'LogLevel' | 'OperationsLogLevel' | 'OperationsLogLevel2', number>> = {};
  for (const [parameter, word] of LEVEL_PARAMETERS) {
    const raw = ctx.named[parameter.toLowerCase()];
    if (raw === undefined || raw === null) continue;
    const value = unsignedParameter(ctx, parameter, raw);
    if (value === null) return null;
    words[word] = value;
  }
  return words;
}

export class GetDnsServerDiagnosticsCmdlet implements ICmdlet {
  readonly name = 'get-dnsserverdiagnostics';
  readonly displayName = 'Get-DnsServerDiagnostics';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName', 'CimSession', 'ThrottleLimit', 'AsJob'] as const;

  execute(ctx: CmdletContext): PSValue {
    return diagnosticsObject(requireDns(ctx, 'Get-DnsServerDiagnostics').getDiagnostics());
  }
}

export class SetDnsServerDiagnosticsCmdlet implements ICmdlet {
  readonly name = 'set-dnsserverdiagnostics';
  readonly displayName = 'Set-DnsServerDiagnostics';
  readonly aliases = [] as const;
  readonly parameters = [
    ...PARAMETER_PROPERTIES.map(([parameter]) => parameter), 'DebugLogging', 'OperationLogLevel1', 'OperationLogLevel2',
    'All', 'ComputerName', 'PassThru', 'CimSession', 'ThrottleLimit', 'AsJob', 'WhatIf', 'Confirm',
  ] as const;
  readonly pipelineByPropertyName = true as const;

  execute(ctx: CmdletContext): PSValue {
    const dns = requireDns(ctx, 'Set-DnsServerDiagnostics');
    const given = (parameter: string): PSValue | undefined => {
      const raw = ctx.named[parameter.toLowerCase()];
      return raw === null ? undefined : raw;
    };
    const sets = [
      PARAMETER_PROPERTIES.some(([parameter]) => given(parameter) !== undefined),
      LEVEL_PARAMETERS.some(([parameter]) => given(parameter) !== undefined),
      given('All') !== undefined,
    ].filter(Boolean).length;
    if (sets > 1) {
      ctx.emitError('Set-DnsServerDiagnostics : Parameter set cannot be resolved using the specified named parameters.');
      return null;
    }
    const entries = new Map(dns.getDiagnostics().map(entry => [entry.property.toLowerCase(), entry]));
    const values = new Map<string, DnsDiagnosticsValue>();
    for (const [parameter, property] of PARAMETER_PROPERTIES) {
      const raw = given(parameter);
      const entry = entries.get(property.toLowerCase());
      if (raw === undefined || entry === undefined) continue;
      const value = valueOf(ctx, parameter, entry, raw);
      if (value === null) return null;
      values.set(property, value);
    }
    const words = levelChanges(ctx);
    if (words === null) return null;
    const all = given('All');
    const result = dns.setDiagnostics({ all: all === undefined ? undefined : isSwitchOn(all), words, values });
    if (!result.ok) return failed(ctx, 'Set-DnsServerDiagnostics', result);
    return isSwitchOn(ctx.named['passthru']) ? diagnosticsObject(dns.getDiagnostics()) : null;
  }
}
