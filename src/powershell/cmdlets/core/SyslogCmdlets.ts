import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { resolveFacility, resolveSeverity } from '@/network/syslog/SyslogMessageBuilder';

const DEFAULT_SYSLOG_PORT = 514;

function text(ctx: CmdletContext, name: string): string | undefined {
  const value = ctx.named[name];
  return value === undefined || value === null ? undefined : psValueToString(value);
}

function messagesOf(ctx: CmdletContext): string[] {
  const explicit = ctx.named['message'] ?? ctx.positional[1];
  const source = explicit !== undefined ? explicit : ctx.pipeInput;
  if (source === undefined || source === null) return [];
  return (Array.isArray(source) ? source : [source]).map(psValueToString);
}

export class SendSyslogMessageCmdlet implements ICmdlet {
  readonly name = 'send-syslogmessage';
  readonly displayName = 'Send-SyslogMessage';
  readonly aliases = [] as const;
  readonly parameters = [
    'Server', 'Message', 'Severity', 'Facility', 'Hostname', 'ApplicationName', 'ProcessID', 'MessageID',
    'Timestamp', 'UDPPort', 'Port', 'Transport', 'Rfc3164', 'Framing',
  ] as const;

  execute(ctx: CmdletContext): PSValue {
    const server = text(ctx, 'server') ?? (ctx.positional[0] !== undefined ? psValueToString(ctx.positional[0]) : '');
    if (server === '') {
      ctx.emitError('Send-SyslogMessage : Cannot process command because of one or more missing mandatory parameters: Server.');
      return null;
    }
    const messages = messagesOf(ctx);
    if (messages.length === 0) {
      ctx.emitError('Send-SyslogMessage : Cannot process command because of one or more missing mandatory parameters: Message.');
      return null;
    }
    const network = ctx.providers.network;
    if (network?.sendSyslogMessage === undefined) {
      ctx.emitError('Send-SyslogMessage : not supported on this device.');
      return null;
    }
    const severityName = text(ctx, 'severity') ?? (ctx.positional[2] !== undefined ? psValueToString(ctx.positional[2]) : 'Informational');
    const severity = resolveSeverity(severityName);
    if (severity === null) {
      ctx.emitError(`Send-SyslogMessage : Cannot validate argument on parameter 'Severity'. The argument "${severityName}" does not belong to the set "Emergency,Alert,Critical,Error,Warning,Notice,Informational,Debug".`);
      return null;
    }
    const facilityName = text(ctx, 'facility') ?? (ctx.positional[3] !== undefined ? psValueToString(ctx.positional[3]) : 'User');
    const facility = resolveFacility(facilityName);
    if (facility === null) {
      ctx.emitError(`Send-SyslogMessage : Cannot validate argument on parameter 'Facility'. The argument "${facilityName}" is not a syslog facility.`);
      return null;
    }
    const transportName = (text(ctx, 'transport') ?? 'UDP').toUpperCase();
    if (transportName !== 'UDP' && transportName !== 'TCP') {
      ctx.emitError(`Send-SyslogMessage : Cannot validate argument on parameter 'Transport'. The argument "${transportName}" does not belong to the set "UDP,TCP".`);
      return null;
    }
    const framingName = (text(ctx, 'framing') ?? 'OctetCounting').toLowerCase();
    if (framingName !== 'octetcounting' && framingName !== 'nontransparent') {
      ctx.emitError(`Send-SyslogMessage : Cannot validate argument on parameter 'Framing'. The argument "${framingName}" does not belong to the set "OctetCounting,NonTransparent".`);
      return null;
    }
    const portText = text(ctx, 'udpport') ?? text(ctx, 'port');
    const port = portText === undefined ? DEFAULT_SYSLOG_PORT : Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.emitError(`Send-SyslogMessage : Cannot validate argument on parameter 'Port'. The ${portText} argument is not a valid port.`);
      return null;
    }
    const stamp = ctx.named['timestamp'];
    const timestampMs = stamp === undefined || stamp === null ? undefined : new Date(psValueToString(stamp)).getTime();
    if (timestampMs !== undefined && Number.isNaN(timestampMs)) {
      ctx.emitError(`Send-SyslogMessage : Cannot convert value "${psValueToString(stamp)}" to type "System.DateTime".`);
      return null;
    }
    const format = ctx.named['rfc3164'] === true ? 'rfc3164' : 'rfc5424';
    for (const message of messages) {
      let outcome: { ok: boolean; error?: string };
      try {
        outcome = network.sendSyslogMessage({
          server, port, transport: transportName === 'TCP' ? 'tcp' : 'udp', format,
          framing: framingName === 'nontransparent' ? 'non-transparent' : 'octet-counting',
          facility, severity,
          hostname: text(ctx, 'hostname') ?? '',
          appName: text(ctx, 'applicationname') ?? 'PowerShell',
          procId: text(ctx, 'processid') ?? null,
          msgId: text(ctx, 'messageid') ?? null,
          structuredData: [], message, ...(timestampMs === undefined ? {} : { timestampMs }),
        });
      } catch (error) {
        outcome = { ok: false, error: `Send-SyslogMessage : ${(error as Error).message}` };
      }
      if (!outcome.ok) {
        ctx.emitError(outcome.error ?? 'Send-SyslogMessage : The message could not be sent.');
        return null;
      }
    }
    return null;
  }
}
