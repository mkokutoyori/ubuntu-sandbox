import type { LoggingConfig } from '../../inspection/config/LoggingConfig';
import type { SyslogAgent } from '../../../syslog/SyslogAgent';
import { syslogSeverityOf } from '../../../syslog/loggingProjection';
import type { PacketContext } from '../pipeline/PacketContext';
import type { FirewallSession } from '../session/SessionTable';
import type { SecurityRule } from '../model/SecurityRule';
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

export interface PipelineTrafficLogger {
  onDenied(context: PacketContext): void;
  onSessionOpened(session: FirewallSession, rule?: SecurityRule): void;
}

export function logPipelineOutcome(
  emit: (event: FirewallLogEvent, facts: FirewallLogFacts) => void,
  context: PacketContext,
  facts: FirewallLogFacts,
  accepted: boolean,
  traffic?: PipelineTrafficLogger,
): void {
  if (!accepted) {
    emit('policy-deny', {
      ...facts, ruleId: context.matchedPolicy?.id, reason: context.verdict?.reason,
    });
    traffic?.onDenied(context);
    return;
  }
  if (context.session === undefined || !context.isFirstPacket) return;

  traffic?.onSessionOpened(context.session, context.matchedPolicy);
  emit('session-built', { ...facts, sessionId: context.session.id });
  if (context.session.translation) {
    emit('translation-created', { ...facts, sessionId: context.session.id });
  }
}
