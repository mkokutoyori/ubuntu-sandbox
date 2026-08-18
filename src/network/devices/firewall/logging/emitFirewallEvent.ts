import type { LoggingConfig } from '../../inspection/config/LoggingConfig';
import type { SyslogAgent } from '../../../syslog/SyslogAgent';
import { syslogSeverityOf } from '../../../syslog/loggingProjection';
import {
  firewallLogText,
  type FirewallLogEvent, type FirewallLogFacts, type FirewallSyslogCatalog,
} from './SyslogCatalog';

export interface FirewallEventSink {
  readonly catalog: FirewallSyslogCatalog | undefined;
  readonly osName: string;
  readonly logging: LoggingConfig;
  readonly syslog: SyslogAgent;
}

export function emitFirewallEvent(
  sink: FirewallEventSink, event: FirewallLogEvent, facts: FirewallLogFacts,
): void {
  const message = sink.catalog?.[event];
  if (!message) return;

  const text = firewallLogText(event, facts);
  sink.logging.append(message.severity, sink.osName, text, false, message.id);
  sink.syslog.sendImmediate(
    syslogSeverityOf(message.severity), sink.osName,
    `%${sink.osName.toUpperCase()}-${message.id}: ${text}`);
}
